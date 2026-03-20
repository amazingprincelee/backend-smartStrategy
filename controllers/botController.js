import BotConfig from '../models/bot/BotConfig.js';
import Trade from '../models/bot/Trade.js';
import Position from '../models/bot/Position.js';
import ExchangeAccount from '../models/ExchangeAccount.js';
import Signal from '../models/Signal.js';
import botEngine from '../services/bot/BotEngine.js';
import demoSimulator from '../services/bot/DemoSimulator.js';
import orderManager from '../services/bot/OrderManager.js';
import marketDataService from '../services/MarketDataService.js';
import scoringEngine from '../services/SignalScoringEngine.js';
import pairConflictGuard from '../services/PairConflictGuard.js';

/**
 * GET /api/bots
 */
export const listBots = async (req, res) => {
  try {
    const bots = await BotConfig.find({ userId: req.user.id })
      .sort({ createdAt: -1 });

    // Enrich with open position counts
    const enriched = await Promise.all(bots.map(async (bot) => {
      const openPositions = await Position.countDocuments({ botId: bot._id, status: 'open' });
      const obj = bot.toObject();
      obj.openPositionsCount = openPositions;
      obj.isRunning = botEngine.isRunning(bot._id);
      return obj;
    }));

    res.json({ success: true, data: { bots: enriched, count: enriched.length } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/bots
 */
export const createBot = async (req, res) => {
  try {
    const {
      name, exchange, symbol, marketType, strategyId,
      strategyParams, capitalAllocation, riskParams,
      exchangeAccountId, isDemo, executionMode, cooldownMinutes
    } = req.body;

    if (!name || !exchange || !symbol || !strategyId || !capitalAllocation?.totalCapital) {
      return res.status(400).json({
        success: false,
        message: 'name, exchange, symbol, strategyId, and capitalAllocation.totalCapital are required'
      });
    }

    const demoMode = !!isDemo;

    // If live mode, validate exchange account belongs to user
    if (!demoMode) {
      if (!exchangeAccountId) {
        return res.status(400).json({ success: false, message: 'exchangeAccountId required for live trading' });
      }
      const account = await ExchangeAccount.findOne({ _id: exchangeAccountId, userId: req.user.id });
      if (!account) {
        return res.status(400).json({ success: false, message: 'Exchange account not found' });
      }
      if (!account.isValid) {
        return res.status(400).json({ success: false, message: 'Exchange account connection is not valid. Please test it first.' });
      }
    }

    const bot = await BotConfig.create({
      userId: req.user.id,
      name: name.trim(),
      exchange: exchange.toLowerCase(),
      symbol: symbol.toUpperCase(),
      marketType: marketType || 'spot',
      strategyId,
      executionMode: executionMode || 'auto',
      cooldownMinutes: cooldownMinutes ?? 30,
      strategyParams: strategyParams || {},
      capitalAllocation,
      riskParams: riskParams || {},
      exchangeAccountId: demoMode ? null : exchangeAccountId,
      isDemo: demoMode,
      'stats.startingCapital': capitalAllocation.totalCapital,
      'stats.currentCapital': capitalAllocation.totalCapital,
      'stats.peakCapital': capitalAllocation.totalCapital
    });

    // Ensure demo account exists
    if (demoMode) {
      await demoSimulator.getOrCreate(req.user.id);
    }

    // Auto-start the bot immediately — user already reviewed & confirmed via the wizard
    try {
      await botEngine.startBot(bot._id);
    } catch (startErr) {
      console.warn(`[createBot] Auto-start failed for bot ${bot._id}: ${startErr.message}`);
      // Bot is still created successfully; client will see 'stopped' status and can start manually
    }

    res.status(201).json({ success: true, data: { bot } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/bots/:id
 */
export const getBotDetail = async (req, res) => {
  try {
    const bot = await BotConfig.findOne({ _id: req.params.id, userId: req.user.id });
    if (!bot) return res.status(404).json({ success: false, message: 'Bot not found' });

    const openPositions = await Position.find({ botId: bot._id, status: 'open' });
    const recentTrades = await Trade.find({ botId: bot._id })
      .sort({ executedAt: -1 })
      .limit(10);

    res.json({
      success: true,
      data: {
        bot: { ...bot.toObject(), isRunning: botEngine.isRunning(bot._id) },
        openPositions,
        recentTrades
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PUT /api/bots/:id
 */
export const updateBot = async (req, res) => {
  try {
    const bot = await BotConfig.findOne({ _id: req.params.id, userId: req.user.id });
    if (!bot) return res.status(404).json({ success: false, message: 'Bot not found' });

    if (bot.status === 'running') {
      return res.status(400).json({ success: false, message: 'Stop the bot before editing' });
    }

    const allowed = ['name', 'strategyParams', 'capitalAllocation', 'riskParams'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) bot[key] = req.body[key];
    }
    await bot.save();

    res.json({ success: true, data: { bot } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * DELETE /api/bots/:id
 */
export const deleteBot = async (req, res) => {
  try {
    const bot = await BotConfig.findOne({ _id: req.params.id, userId: req.user.id });
    if (!bot) return res.status(404).json({ success: false, message: 'Bot not found' });

    if (botEngine.isRunning(bot._id)) {
      await botEngine.stopBot(bot._id);
    }

    await BotConfig.deleteOne({ _id: bot._id });
    res.json({ success: true, message: 'Bot deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/bots/:id/start
 */
export const startBot = async (req, res) => {
  try {
    const bot = await BotConfig.findOne({ _id: req.params.id, userId: req.user.id });
    if (!bot) return res.status(404).json({ success: false, message: 'Bot not found' });

    if (botEngine.isRunning(bot._id)) {
      return res.status(400).json({ success: false, message: 'Bot is already running' });
    }

    await botEngine.startBot(bot._id);
    res.json({ success: true, message: `Bot "${bot.name}" started` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/bots/:id/stop
 */
export const stopBot = async (req, res) => {
  try {
    const bot = await BotConfig.findOne({ _id: req.params.id, userId: req.user.id });
    if (!bot) return res.status(404).json({ success: false, message: 'Bot not found' });

    await botEngine.stopBot(bot._id);
    res.json({ success: true, message: `Bot "${bot.name}" stopped` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/bots/:id/trades
 */
export const getBotTrades = async (req, res) => {
  try {
    const bot = await BotConfig.findOne({ _id: req.params.id, userId: req.user.id });
    if (!bot) return res.status(404).json({ success: false, message: 'Bot not found' });

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [trades, total] = await Promise.all([
      Trade.find({ botId: bot._id }).sort({ executedAt: -1 }).skip(skip).limit(limit),
      Trade.countDocuments({ botId: bot._id })
    ]);

    res.json({
      success: true,
      data: { trades, total, page, totalPages: Math.ceil(total / limit) }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/bots/:id/positions
 */
export const getBotPositions = async (req, res) => {
  try {
    const bot = await BotConfig.findOne({ _id: req.params.id, userId: req.user.id });
    if (!bot) return res.status(404).json({ success: false, message: 'Bot not found' });

    const status = req.query.status || 'open';
    const positions = await Position.find({ botId: bot._id, status })
      .sort({ openedAt: -1 })
      .limit(50);

    res.json({ success: true, data: { positions } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/bots/:id/positions/:positionId/close
 * Manually close an open position and realize P&L.
 */
export const closePosition = async (req, res) => {
  try {
    const bot = await BotConfig.findOne({ _id: req.params.id, userId: req.user.id });
    if (!bot) return res.status(404).json({ success: false, message: 'Bot not found' });

    const position = await Position.findOne({ _id: req.params.positionId, botId: bot._id, status: 'open' });
    if (!position) return res.status(404).json({ success: false, message: 'Position not found or already closed' });

    const closePrice = position.currentPrice || position.entryPrice;
    const realizedPnl = (closePrice - position.entryPrice) * (position.amount || 0) - (position.entryFee || 0);

    // For live trading — place market close order on exchange
    if (!bot.isDemo && bot.exchangeAccountId) {
      try {
        const ExchangeAccount = (await import('../models/ExchangeAccount.js')).default;
        const account = await ExchangeAccount.findById(bot.exchangeAccountId);
        if (account) {
          const { default: ccxt } = await import('ccxt');
          const ExchangeClass = ccxt[account.exchange];
          if (ExchangeClass) {
            const exchange = new ExchangeClass({ apiKey: account.apiKey, secret: account.apiSecret, enableRateLimit: true });
            const side = position.side === 'long' ? 'sell' : 'buy';
            await exchange.createMarketOrder(position.symbol, side, position.amount);
          }
        }
      } catch (exchErr) {
        // Log but don't fail — still close in DB
        console.warn('[closePosition] exchange order failed:', exchErr.message);
      }
    }

    // Mark closed in DB
    position.status      = 'closed';
    position.closePrice  = closePrice;
    position.realizedPnL = realizedPnl;
    position.closedAt    = new Date();
    position.closeReason = 'manual';
    await position.save();

    // Update bot stats
    await BotConfig.findByIdAndUpdate(bot._id, { $inc: { 'stats.totalPnL': realizedPnl } });

    res.json({ success: true, data: { realizedPnl, closePrice } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/bots/:id/pending-signals
 * Returns top 3 scored signals waiting for manual execution.
 */
export const getPendingSignals = async (req, res) => {
  try {
    const bot = await BotConfig.findOne({ _id: req.params.id, userId: req.user.id });
    if (!bot) return res.status(404).json({ success: false, message: 'Bot not found' });

    // Filter out expired pending signals
    const now     = new Date();
    const pending = (bot.pendingSignals || []).filter(s => !s.expiresAt || new Date(s.expiresAt) > now);

    res.json({ success: true, data: { pendingSignals: pending, executionMode: bot.executionMode } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/bots/:id/execute-signal
 * User manually triggers execution of a pending signal.
 * Body: { signalId }
 */
export const executeSignal = async (req, res) => {
  try {
    const bot = await BotConfig.findOne({ _id: req.params.id, userId: req.user.id });
    if (!bot) return res.status(404).json({ success: false, message: 'Bot not found' });
    if (bot.executionMode !== 'manual') return res.status(400).json({ success: false, message: 'Bot is not in manual mode' });

    const { signalId } = req.body;
    const pending = (bot.pendingSignals || []).find(s => s.signalId?.toString() === signalId);
    if (!pending) return res.status(404).json({ success: false, message: 'Signal not found or expired' });

    // Pair conflict check
    const conflict = await pairConflictGuard.checkPairConflict(req.user.id, pending.pair, bot._id);
    if (conflict.hasConflict) {
      return res.json({
        success: false,
        conflict: true,
        message: `${conflict.botName} already has an open ${conflict.positionSide} position on ${pending.pair}. Proceeding will increase your exposure.`,
        conflict_info: conflict,
      });
    }

    // Fetch live price for accurate sizing
    const tradeSymbol = pending.pair.replace('/', '');
    const marketType  = pending.marketType || bot.marketType || 'spot';
    let livePrice = pending.entry;
    try {
      const ticker = await marketDataService.fetchTicker(tradeSymbol, marketType);
      livePrice = ticker.lastPrice;
    } catch {
      console.warn(`[executeSignal] Could not fetch live price for ${tradeSymbol}`);
    }

    // Price drift check
    const drift = Math.abs(livePrice - pending.entry) / pending.entry * 100;
    if (drift > 2.0) {
      return res.status(400).json({
        success: false,
        message: `Price has moved ${drift.toFixed(1)}% from the signal entry. Signal may be stale — please wait for a fresh signal.`,
      });
    }

    // ATR-based position sizing
    const params       = bot.strategyParams || {};
    const riskPct      = params.riskPerTrade || 2;
    const leverage     = marketType === 'futures' ? (params.leverage || 1) : 1;
    const capital      = bot.capitalAllocation?.totalCapital || 100;
    const slDistance   = Math.abs(livePrice - pending.stopLoss);
    const maxLoss      = capital * (riskPct / 100);
    const amount       = slDistance > 0 ? maxLoss / slDistance : (capital * riskPct / 100 * leverage) / livePrice;

    if (!isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Could not calculate valid position size' });
    }

    const isShort  = pending.type === 'SHORT';
    const riskDist = isShort ? pending.stopLoss - pending.entry : pending.entry - pending.stopLoss;
    const tp1Price = riskDist > 0 ? (isShort ? pending.entry - riskDist : pending.entry + riskDist) : null;

    const signal = {
      action:          'buy',
      symbol:          tradeSymbol,
      side:            isShort ? 'short' : 'long',
      portionIndex:    0,
      amount,
      takeProfitPrice: pending.takeProfit,
      stopLossPrice:   pending.stopLoss,
      tp1Price,
      reason:          'manual_execute',
      confidence:      pending.confidenceScore,
      score:           pending.score,
    };

    const { position } = await orderManager.openPosition(bot, signal, tradeSymbol);

    // Set cooldown + clear pending signals
    const cooldownMs = (bot.cooldownMinutes || 30) * 60 * 1000;
    await BotConfig.findByIdAndUpdate(bot._id, {
      pendingSignals: [],
      cooldownUntil:  new Date(Date.now() + cooldownMs),
    });

    res.json({ success: true, message: 'Trade executed', data: { position } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/bots/quick-execute
 * One-off trade execution from Quick Pair Analysis or Analyze a Pair.
 * Creates a single-trade bot in the background or uses an existing bot.
 * Body: { signalData, botId?, exchangeAccountId, accountBalance, riskPreset ('safe'|'moderate'|'aggressive') }
 */
export const quickExecute = async (req, res) => {
  try {
    const { signalData, botId, exchangeAccountId, isDemo, exchange: demoExchange, accountBalance, riskPreset = 'moderate' } = req.body;
    if (!signalData || !signalData.pair || !signalData.entry) {
      return res.status(400).json({ success: false, message: 'Signal data is required' });
    }

    const riskMap = { safe: 1, moderate: 2, aggressive: 5 };
    const riskPct = riskMap[riskPreset] || 2;

    let bot;

    if (botId) {
      // Use existing bot
      bot = await BotConfig.findOne({ _id: botId, userId: req.user.id });
      if (!bot) return res.status(404).json({ success: false, message: 'Bot not found' });
    } else if (isDemo) {
      // Demo mode — no exchange account needed, just exchange name for price data
      if (!demoExchange) {
        return res.status(400).json({ success: false, message: 'Exchange is required for demo mode' });
      }
      bot = await BotConfig.create({
        userId:           req.user.id,
        name:             `Quick Trade — ${signalData.pair}`,
        isDemo:           true,
        exchange:         demoExchange,
        symbol:           signalData.pair.replace('/', ''),
        marketType:       signalData.marketType || 'futures',
        strategyId:       'smart_signal',
        executionMode:    'auto',
        cooldownMinutes:  0,
        capitalAllocation: {
          totalCapital:    accountBalance || 10000,
          maxOpenPositions: 1,
        },
        strategyParams: {
          riskPerTrade:        riskPct,
          maxConcurrentTrades: 1,
          leverage:            signalData.leverage || 1,
        },
        riskParams: { dailyLossLimitPercent: 5 },
        status: 'running',
        startedAt: new Date(),
        'stats.startingCapital': accountBalance || 10000,
        'stats.currentCapital':  accountBalance || 10000,
        'stats.peakCapital':     accountBalance || 10000,
      });
    } else {
      // Live mode — resolve exchange from account
      if (!exchangeAccountId) {
        return res.status(400).json({ success: false, message: 'Exchange account is required for live trading' });
      }
      const account = await ExchangeAccount.findOne({ _id: exchangeAccountId, userId: req.user.id });
      if (!account) return res.status(404).json({ success: false, message: 'Exchange account not found' });

      bot = await BotConfig.create({
        userId:           req.user.id,
        name:             `Quick Trade — ${signalData.pair}`,
        exchangeAccountId,
        exchange:         account.exchange,
        symbol:           signalData.pair.replace('/', ''),
        marketType:       signalData.marketType || 'futures',
        strategyId:       'smart_signal',
        executionMode:    'auto',
        cooldownMinutes:  0,
        capitalAllocation: {
          totalCapital:    accountBalance || 100,
          maxOpenPositions: 1,
        },
        strategyParams: {
          riskPerTrade:        riskPct,
          maxConcurrentTrades: 1,
          leverage:            signalData.leverage || 1,
        },
        riskParams: { dailyLossLimitPercent: 5 },
        status: 'running',
        startedAt: new Date(),
        'stats.startingCapital': accountBalance || 100,
        'stats.currentCapital':  accountBalance || 100,
        'stats.peakCapital':     accountBalance || 100,
      });
    }

    // Pair conflict check
    const conflict = await pairConflictGuard.checkPairConflict(req.user.id, signalData.pair, bot._id);
    if (conflict.hasConflict) {
      return res.json({
        success: false,
        conflict: true,
        message: `${conflict.botName} already has an open ${conflict.positionSide} position on ${signalData.pair}.`,
        conflict_info: conflict,
      });
    }

    // Fetch live price
    const tradeSymbol = signalData.pair.replace('/', '');
    const marketType  = signalData.marketType || 'futures';
    let livePrice = signalData.entry;
    try {
      const ticker = await marketDataService.fetchTicker(tradeSymbol, marketType);
      livePrice = ticker.lastPrice;
    } catch {
      console.warn(`[quickExecute] Could not fetch live price for ${tradeSymbol}`);
    }

    // ATR-based sizing
    const capital    = bot.capitalAllocation?.totalCapital || accountBalance || 100;
    const leverage   = signalData.leverage || bot.strategyParams?.leverage || 1;
    const slDistance = Math.abs(livePrice - signalData.stopLoss);
    const maxLoss    = capital * (riskPct / 100);
    const amount     = slDistance > 0 ? maxLoss / slDistance : (capital * riskPct / 100 * leverage) / livePrice;

    if (!isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Could not calculate valid position size' });
    }

    const isShort  = signalData.type === 'SHORT';
    const riskDist = isShort ? signalData.stopLoss - signalData.entry : signalData.entry - signalData.stopLoss;
    const tp1Price = riskDist > 0 ? (isShort ? signalData.entry - riskDist : signalData.entry + riskDist) : null;

    const signal = {
      action:          'buy',
      symbol:          tradeSymbol,
      side:            isShort ? 'short' : 'long',
      portionIndex:    0,
      amount,
      takeProfitPrice: signalData.takeProfit,
      stopLossPrice:   signalData.stopLoss,
      tp1Price,
      reason:          'quick_execute',
      confidence:      signalData.confidenceScore || 0.7,
    };

    const { position } = await orderManager.openPosition(bot, signal, tradeSymbol);

    res.json({
      success: true,
      message: 'Trade executed successfully',
      data: { position, botId: bot._id, botName: bot.name },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
