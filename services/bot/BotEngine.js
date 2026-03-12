import BotConfig from '../../models/bot/BotConfig.js';
import Position from '../../models/bot/Position.js';
import Notification from '../../models/Notification.js';
import orderManager from './OrderManager.js';
import riskEngine from './RiskEngine.js';
import demoSimulator from './DemoSimulator.js';
import exchangeConnector from './ExchangeConnector.js';
import ExchangeAccount from '../../models/ExchangeAccount.js';
import { calculateRSI, calcVolumeMA, detectTrend } from './IndicatorEngine.js';
import marketDataService from '../MarketDataService.js';

// Strategy map
import smartSignal from '../strategies/SmartSignalStrategy.js';

const STRATEGY_MAP = {
  smart_signal: smartSignal,
  ai_signal:    smartSignal,   // legacy alias — existing bots keep working
};

// Timeframe per strategy (how often the tick loop fires)
const TIMEFRAME_MAP = {
  smart_signal: '5m',
  ai_signal:    '5m',
};

// Tick interval in ms
const TICK_INTERVAL_MS = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000
};

/**
 * BotEngine - singleton orchestrator for all running bots.
 * Manages setInterval-based tick loops per bot.
 */
const MAX_CONSECUTIVE_ERRORS = 5; // stop bot only after this many consecutive failures

class BotEngine {
  constructor() {
    // Map: botId (string) => { intervalId, timeframe }
    this.runningBots = new Map();
    // Map: botId (string) => consecutive error count
    this._errorCounts = new Map();
    this.io = null;
  }

  setIO(io) {
    this.io = io;
  }

  /**
   * Start a bot by ID. Loads config, registers interval, fires first tick.
   */
  async startBot(botId) {
    const id = botId.toString();
    if (this.runningBots.has(id)) {
      throw new Error('Bot is already running');
    }

    const bot = await BotConfig.findById(botId);
    if (!bot) throw new Error('Bot not found');

    const timeframe = TIMEFRAME_MAP[bot.strategyId] || '1h';
    const intervalMs = TICK_INTERVAL_MS[timeframe] || 3_600_000;

    // Update status + initialize capital stats on first start
    const capitalUpdate = {
      status: 'running',
      startedAt: new Date(),
      statusMessage: '',
    };
    if (!bot.stats.startingCapital) {
      // First start — seed stats so drawdown check works correctly from tick 1
      capitalUpdate['stats.startingCapital'] = bot.capitalAllocation.totalCapital;
      capitalUpdate['stats.currentCapital']  = bot.capitalAllocation.totalCapital;
      capitalUpdate['stats.peakCapital']     = bot.capitalAllocation.totalCapital;
    }
    await BotConfig.findByIdAndUpdate(botId, capitalUpdate);

    // Register interval
    const intervalId = setInterval(() => this._tick(id), intervalMs);
    this.runningBots.set(id, { intervalId, timeframe });

    // Fire first tick immediately (don't await - run async in background)
    this._tick(id).catch(err => console.error(`[BotEngine] Initial tick error for ${id}:`, err.message));

    console.log(`[BotEngine] Started bot ${bot.name} (${id}) on ${timeframe} interval`);
  }

  /**
   * Stop a bot by ID.
   */
  async stopBot(botId) {
    const id = botId.toString();
    const entry = this.runningBots.get(id);
    if (entry) {
      clearInterval(entry.intervalId);
      this.runningBots.delete(id);
    }
    this._errorCounts.delete(id);
    await BotConfig.findByIdAndUpdate(botId, {
      status: 'stopped',
      stoppedAt: new Date()
    });
    console.log(`[BotEngine] Stopped bot ${id}`);
  }

  isRunning(botId) {
    return this.runningBots.has(botId.toString());
  }

  /**
   * Main tick function - called on each interval for a running bot.
   */
  async _tick(botId) {
    let bot;
    try {
      bot = await BotConfig.findById(botId);
      if (!bot || bot.status !== 'running') {
        await this.stopBot(botId);
        return;
      }

      // Fetch OHLCV candles
      const timeframe  = TIMEFRAME_MAP[bot.strategyId] || '1h';
      const intervalMs = TICK_INTERVAL_MS[timeframe]   || 3_600_000;
      const isMultiPair = bot.symbol === 'MULTI';

      let candles      = [];
      let currentPrice = null;
      let currentRSI   = null;
      let volumeRatio  = null;
      let trend        = null;

      if (!isMultiPair) {
        // ── Single-pair strategy (DCA) ─────────────────────────────────────
        candles = await this._fetchCandles(bot, timeframe);
        if (!candles || candles.length < 30) {
          console.warn(`[BotEngine] Insufficient candle data for bot ${botId}`);
          return;
        }
        const closes = candles.map(c => c.close);
        const volumes = candles.map(c => c.volume);
        const lastIdx = candles.length - 1;
        currentPrice = closes[lastIdx];

        const rsiValues = calculateRSI(closes, 14);
        currentRSI  = rsiValues[lastIdx] != null ? parseFloat(rsiValues[lastIdx].toFixed(2)) : null;
        const avgVol    = calcVolumeMA(volumes, 20);
        volumeRatio = avgVol > 0 ? parseFloat((volumes[lastIdx] / avgVol).toFixed(2)) : null;
        trend       = detectTrend(candles, 50, 200);
      }

      // Load open positions
      const openPositions = await Position.find({ botId: bot._id, status: 'open' });

      // Update unrealized P&L and trailing stops for all open positions
      for (const position of openPositions) {
        // For multi-pair bots fetch current price per position's own symbol
        if (isMultiPair) {
          try {
            const ticker = await marketDataService.fetchTicker(position.symbol, bot.marketType || 'spot');
            currentPrice = ticker.lastPrice;
          } catch {
            currentPrice = position.currentPrice || position.entryPrice;
          }
        }

        position.currentPrice = currentPrice;
        const isShort   = position.side === 'short';
        const priceDiff = isShort
          ? position.entryPrice - currentPrice
          : currentPrice - position.entryPrice;
        position.unrealizedPnL        = priceDiff * position.amount - position.entryFee;
        position.unrealizedPnLPercent = (priceDiff / position.entryPrice) * 100;
        riskEngine.updateTrailingStop(position, currentPrice, bot.strategyParams);
        await position.save();
      }

      // Update bot capital tracking
      // Use totalCapital as the base if startingCapital was never seeded (old bots)
      const startingCapital = bot.stats.startingCapital || bot.capitalAllocation.totalCapital;
      const unrealizedTotal = openPositions.reduce((sum, p) => sum + (p.unrealizedPnL || 0), 0);
      const currentCapital  = startingCapital + bot.stats.totalPnL + unrealizedTotal;
      const peakCapital     = Math.max(bot.stats.peakCapital || bot.capitalAllocation.totalCapital, currentCapital);

      await BotConfig.findByIdAndUpdate(botId, {
        'stats.currentCapital': currentCapital,
        'stats.peakCapital': peakCapital
      });

      // Re-fetch with updated stats
      bot = await BotConfig.findById(botId);

      // Run strategy
      const strategy = STRATEGY_MAP[bot.strategyId];
      if (!strategy) {
        console.error(`[BotEngine] Unknown strategy: ${bot.strategyId}`);
        return;
      }

      const signals = await strategy.analyze(bot, candles, openPositions);

      // Determine tick action label for the log
      const hasBuy  = signals.some(s => s.action === 'buy');
      const hasSell = signals.some(s => s.action === 'sell');
      const tickAction = hasBuy ? 'entry' : hasSell ? 'exit' : 'waiting';

      // Build and persist lastAnalysis + tickLog
      const now       = new Date();
      const nextTickAt = new Date(Date.now() + intervalMs);
      const tickEntry  = { timestamp: now, currentPrice, rsi: currentRSI, volumeRatio, action: tickAction };

      await BotConfig.findByIdAndUpdate(botId, {
        lastAnalysis: {
          timestamp: now,
          nextTickAt,
          currentPrice,
          rsi: currentRSI,
          volumeRatio,
          trend,
          action: tickAction
        },
        // Push new entry, keep only last 10
        $push: { tickLog: { $each: [tickEntry], $slice: -10 } }
      });

      // Execute signals
      // openedThisTick prevents race condition: risk check accounts for positions
      // queued earlier in this same loop iteration that haven't been saved yet.
      let openedThisTick = 0;
      let hadClose = false;

      for (const signal of signals) {
        if (signal.action === 'buy') {
          const riskCheck = await riskEngine.checkCanOpenPosition(bot, openedThisTick);
          if (riskCheck.allowed) {
            try {
              const tradeSymbol = signal.symbol || bot.symbol;
              const { position } = await orderManager.openPosition(bot, signal, tradeSymbol);
              this._emitTrade(bot, 'buy', position.entryPrice, signal.amount, position._id, null, tradeSymbol);
              openedThisTick++;
            } catch (orderErr) {
              console.error(`[BotEngine] Buy order failed for bot ${botId}:`, orderErr.message);
            }
          }
        } else if (signal.action === 'sell') {
          const position = openPositions.find(p =>
            p._id.toString() === signal.positionId?.toString() ||
            p.portionIndex === signal.portionIndex
          );
          if (position) {
            try {
              const { realizedPnL } = await orderManager.closePosition(bot, position, signal.reason);
              this._emitTrade(bot, 'sell', position.currentPrice, position.amount, position._id, realizedPnL, position.symbol);
              hadClose = true;
            } catch (orderErr) {
              console.error(`[BotEngine] Sell order failed for bot ${botId}:`, orderErr.message);
            }
          }
        } else if (signal.action === 'partial_sell') {
          // Ladder exit: close first half at TP1, move SL to breakeven
          const position = openPositions.find(p =>
            p._id.toString() === signal.positionId?.toString() ||
            p.portionIndex === signal.portionIndex
          );
          if (position) {
            try {
              const { partialPnL } = await orderManager.partialClosePosition(bot, position, {
                portion:           signal.portion || 0.5,
                reason:            signal.reason  || 'take_profit_1',
                moveSlToBreakeven: signal.moveSlToBreakeven ?? true,
              });
              this._emitTrade(bot, 'sell', position.currentPrice, position.amount * (signal.portion || 0.5), position._id, partialPnL, position.symbol);
              hadClose = true;
            } catch (orderErr) {
              console.error(`[BotEngine] Partial sell failed for bot ${botId}:`, orderErr.message);
            }
          }
        }
      }

      // Re-fetch bot after trades so shouldPauseBot sees updated stats (consecutiveLosses etc.)
      if (openedThisTick > 0 || hadClose) {
        bot = await BotConfig.findById(botId);
      }

      // Check if bot should be paused (drawdown + consecutive loss limits)
      const pauseReason = riskEngine.shouldPauseBot(bot);
      if (pauseReason) {
        await BotConfig.findByIdAndUpdate(botId, {
          status: 'paused',
          statusMessage: pauseReason
        });
        const entry = this.runningBots.get(botId);
        if (entry) {
          clearInterval(entry.intervalId);
          this.runningBots.delete(botId);
        }
        console.warn(`[BotEngine] Bot ${botId} paused: ${pauseReason}`);
        await this._notify(bot, 'bot_paused',
          `Bot paused: ${bot.name}`,
          `Risk limit reached — ${pauseReason}. The bot has been paused to protect your capital.`,
          'high'
        );
      }

      // Successful tick — reset the consecutive error counter
      if (this._errorCounts.has(botId)) {
        this._errorCounts.delete(botId);
        // Clear the transient error message from the previous failure
        await BotConfig.findByIdAndUpdate(botId, { statusMessage: '' }).catch(() => {});
      }

      // Emit real-time tick update (includes analysis for BotDetail page)
      if (this.io) {
        const openCount = await Position.countDocuments({ botId: bot._id, status: 'open' });
        this.io.to(`user:${bot.userId.toString()}`).emit('bot:tick', {
          botId,
          currentPrice,
          openPositions: openCount,
          status: bot.status,
          unrealizedPnL: unrealizedTotal,
          lastAnalysis: { timestamp: now, nextTickAt, currentPrice, rsi: currentRSI, volumeRatio, trend, action: tickAction },
          tickEntry
        });
      }

    } catch (err) {
      const errCount = (this._errorCounts.get(botId) ?? 0) + 1;
      this._errorCounts.set(botId, errCount);

      console.error(`[BotEngine] Tick error for bot ${botId} (${errCount}/${MAX_CONSECUTIVE_ERRORS}):`, err.message);

      if (errCount >= MAX_CONSECUTIVE_ERRORS) {
        // Too many consecutive failures — stop the bot
        console.error(`[BotEngine] Bot ${botId} stopped after ${errCount} consecutive errors.`);
        await BotConfig.findByIdAndUpdate(botId, {
          status: 'error',
          statusMessage: `Stopped after ${errCount} consecutive errors: ${err.message.substring(0, 150)}`
        });
        const entry = this.runningBots.get(botId);
        if (entry) {
          clearInterval(entry.intervalId);
          this.runningBots.delete(botId);
        }
        this._errorCounts.delete(botId);
        if (bot) {
          await this._notify(bot, 'bot_error',
            `Bot stopped: ${bot.name}`,
            `Stopped after ${errCount} consecutive errors. Last error: ${err.message.substring(0, 120)}`,
            'urgent'
          );
        }
      } else {
        // Transient error — log it but keep the interval alive
        await BotConfig.findByIdAndUpdate(botId, {
          statusMessage: `Last error (${errCount}/${MAX_CONSECUTIVE_ERRORS}): ${err.message.substring(0, 150)}`
        }).catch(() => {});

        if (this.io && bot) {
          this.io.to(`user:${bot.userId.toString()}`).emit('bot:error', {
            botId,
            botName: bot.name,
            error: `Tick error (${errCount}/${MAX_CONSECUTIVE_ERRORS}): ${err.message}`,
          });
        }
      }
    }
  }

  async _fetchCandles(bot, timeframe) {
    if (bot.isDemo) {
      console.log(`[BotEngine] Demo candles for "${bot.name}" (configured exchange: ${bot.exchange}) via MarketDataService`);
      return await marketDataService.fetchCandles(bot.symbol, timeframe, bot.marketType || 'spot', 250);
    }

    // Binance and Bybit public OHLCV endpoints may be geo-blocked on the server.
    // For these exchanges, always use MarketDataService (Gate.io → KuCoin fallback)
    // for candle data. Order execution still uses the authenticated API directly.
    const GEO_BLOCKED_CANDLES = ['binance', 'bybit'];
    if (GEO_BLOCKED_CANDLES.includes(bot.exchange?.toLowerCase())) {
      console.log(`[BotEngine] ${bot.exchange} candles via MarketDataService (geo-blocked public data)`);
      return await marketDataService.fetchCandles(bot.symbol, timeframe, bot.marketType || 'spot', 250);
    }

    const exchangeAccount = await ExchangeAccount
      .findById(bot.exchangeAccountId)
      .select('+apiKeyEncrypted +apiSecretEncrypted +apiPassphraseEncrypted');

    if (!exchangeAccount) throw new Error('Exchange account not found');

    const exchange = await exchangeConnector.getConnection(exchangeAccount);

    // Try fetching candles from the exchange; fall back to MarketDataService on failure
    try {
      const ohlcv = await exchange.fetchOHLCV(bot.symbol, timeframe, undefined, 250);
      return ohlcv.map(c => ({
        timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5]
      }));
    } catch (candleErr) {
      console.warn(
        `[BotEngine] fetchOHLCV failed for ${bot.exchange} (${candleErr.message}) ` +
        `— falling back to MarketDataService`
      );
      return await marketDataService.fetchCandles(bot.symbol, timeframe, bot.marketType || 'spot', 250);
    }
  }

  _emitTrade(bot, side, price, amount, positionId, pnl = null, symbol = null) {
    if (!this.io) return;
    this.io.to(`user:${bot.userId.toString()}`).emit('bot:trade', {
      botId:     bot._id.toString(),
      botName:   bot.name,
      side,
      symbol:    symbol || bot.symbol,
      price,
      amount,
      positionId: positionId?.toString(),
      pnl,
      timestamp: new Date().toISOString()
    });
  }

  async _notify(bot, type, title, message, priority = 'medium') {
    try {
      const notification = await Notification.create({ userId: bot.userId, type, title, message, priority });
      if (this.io) {
        this.io.to(`user:${bot.userId.toString()}`).emit('notification:new', notification.toObject());
      }
    } catch (err) {
      console.warn(`[BotEngine] Failed to create notification for bot ${bot._id}: ${err.message}`);
    }
  }
}

export default new BotEngine();
