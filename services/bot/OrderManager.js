import demoSimulator from './DemoSimulator.js';
import exchangeConnector from './ExchangeConnector.js';
import ExchangeAccount from '../../models/ExchangeAccount.js';
import Trade from '../../models/bot/Trade.js';
import Position from '../../models/bot/Position.js';
import BotConfig from '../../models/bot/BotConfig.js';

/**
 * OrderManager - routes orders to demo or live execution.
 * Creates Trade records and manages Position lifecycle in DB.
 */
class OrderManager {
  /**
   * Place a buy order and open a new position.
   * @param {Object} bot - BotConfig document
   * @param {{ portionIndex, amount, takeProfitPrice, stopLossPrice, triggerReason }} signal
   * @returns {Promise<{ trade, position }>}
   */
  async openPosition(bot, { portionIndex, amount, takeProfitPrice, stopLossPrice, tp1Price = null, triggerReason = 'entry', reason, side: signalSide }, symbolOverride) {
    const symbol       = symbolOverride || bot.symbol;
    const positionSide = signalSide || 'long';
    // 'short' entry passes 'short' to DemoSimulator (no balance debit); long uses 'buy'
    const execSide     = positionSide === 'short' ? 'short' : 'buy';
    const execution    = await this._executeOrder(bot, execSide, amount, symbol);

    // Create trade record
    const trade = await Trade.create({
      botId: bot._id,
      userId: bot.userId,
      isDemo: bot.isDemo,
      exchange: bot.exchange,
      symbol,
      side: positionSide === 'short' ? 'sell' : 'buy',
      type: 'market',
      price: execution.price,
      amount: execution.amount,
      cost: execution.cost,
      fee: execution.fee,
      status: 'closed',
      orderId: execution.orderId || null,
      portionIndex,
      triggerReason
    });

    // Create position record
    const position = await Position.create({
      botId: bot._id,
      userId: bot.userId,
      isDemo: bot.isDemo,
      exchange: bot.exchange,
      symbol,
      portionIndex,
      side: positionSide,
      entryPrice: execution.price,
      amount: execution.amount,
      cost: execution.cost,
      entryFee: execution.fee?.cost || 0,
      takeProfitPrice:  takeProfitPrice || null,
      stopLossPrice,
      tp1Price:         tp1Price || null,
      remainingAmount:  execution.amount, // ladder tracking starts at full amount
      currentPrice:     execution.price
    });

    // Link trade to position
    await Trade.findByIdAndUpdate(trade._id, { positionId: position._id });

    // Update bot stats
    await BotConfig.findByIdAndUpdate(bot._id, {
      $inc: { 'stats.totalTrades': 1 },
      'stats.lastTradeAt': new Date()
    });

    return { trade, position };
  }

  /**
   * Partially close a position (ladder exit).
   * Closes `portion` (0–1) of the remaining open amount, marks tp1Hit,
   * and moves the stop loss to breakeven. Position stays open.
   *
   * @param {Object} bot
   * @param {Object} position  - Position document
   * @param {{ portion: number, reason: string, moveSlToBreakeven: boolean }} opts
   * @returns {Promise<{ trade, partialPnL }>}
   */
  async partialClosePosition(bot, position, { portion = 0.5, reason = 'take_profit_1', moveSlToBreakeven = true } = {}) {
    const openAmount  = position.remainingAmount ?? position.amount;
    const closeAmount = openAmount * portion;
    const isShort     = position.side === 'short';
    const execSide    = isShort ? 'buy' : 'sell';

    const execution = await this._executeOrder(bot, execSide, closeAmount, position.symbol);

    const fees = position.entryFee * portion + (execution.fee?.cost || 0);
    const partialPnL = isShort
      ? (position.entryPrice - execution.price) * closeAmount - fees
      : (execution.price - position.entryPrice) * closeAmount - fees;

    // Record the partial trade
    const trade = await Trade.create({
      botId:        bot._id,
      userId:       bot.userId,
      positionId:   position._id,
      isDemo:       bot.isDemo,
      exchange:     bot.exchange,
      symbol:       position.symbol,
      side:         'sell',
      type:         'limit',
      price:        execution.price,
      amount:       closeAmount,
      cost:         execution.cost,
      fee:          execution.fee,
      status:       'closed',
      orderId:      execution.orderId || null,
      portionIndex: position.portionIndex,
      pnl:          partialPnL,
      triggerReason: reason
    });

    // Update position: reduce remaining amount, mark TP1 hit, move SL to breakeven
    const newSL = moveSlToBreakeven ? position.entryPrice : position.stopLossPrice;
    await Position.findByIdAndUpdate(position._id, {
      remainingAmount:  openAmount - closeAmount,
      tp1Hit:           true,
      stopLossPrice:    newSL,  // breakeven — now risk-free
      trailingStopActive: true, // activate trailing on remaining half
    });

    // Accumulate partial P&L in bot stats (counted as a trade)
    const isWin = partialPnL > 0;
    const currentBot = await BotConfig.findById(bot._id).select('stats').lean();
    const s = currentBot?.stats || {};
    const newWins        = (s.winningTrades  || 0) + (isWin ? 1 : 0);
    const newLosses      = (s.losingTrades   || 0) + (!isWin ? 1 : 0);
    const closedTrades   = newWins + newLosses;
    const newGrossProfit = (s.grossProfit    || 0) + (isWin  ? partialPnL            : 0);
    const newGrossLoss   = (s.grossLoss      || 0) + (!isWin ? Math.abs(partialPnL)  : 0);
    const profitFactor   = newGrossLoss > 0 ? newGrossProfit / newGrossLoss : (newGrossProfit > 0 ? 999 : 0);
    const winRate        = closedTrades > 0 ? (newWins / closedTrades) * 100 : 0;
    const newConsecutive = isWin ? 0 : (s.consecutiveLosses || 0) + 1;

    await BotConfig.findByIdAndUpdate(bot._id, {
      $inc: { 'stats.totalTrades': 1, 'stats.totalPnL': partialPnL },
      $set: {
        'stats.winningTrades':     newWins,
        'stats.losingTrades':      newLosses,
        'stats.grossProfit':       newGrossProfit,
        'stats.grossLoss':         newGrossLoss,
        'stats.profitFactor':      parseFloat(profitFactor.toFixed(3)),
        'stats.winRate':           parseFloat(winRate.toFixed(1)),
        'stats.consecutiveLosses': newConsecutive,
        'stats.lastTradeAt':       new Date(),
      }
    });

    if (bot.isDemo) {
      await demoSimulator.recordPnL(bot.userId, partialPnL);
    }

    return { trade, partialPnL, consecutiveLosses: newConsecutive };
  }

  /**
   * Close an open position with a sell order.
   * @param {Object} bot - BotConfig document
   * @param {Object} position - Position document
   * @param {string} closeReason
   * @returns {Promise<{ trade, realizedPnL }>}
   */
  async closePosition(bot, position, closeReason) {
    const isShort  = position.side === 'short';
    // Cover short = buy back; close long = sell
    const execSide = isShort ? 'buy' : 'sell';
    const execution = await this._executeOrder(bot, execSide, position.amount, position.symbol);

    const fees = position.entryFee + (execution.fee?.cost || 0);
    const realizedPnL = isShort
      ? (position.entryPrice - execution.price) * position.amount - fees
      : (execution.price - position.entryPrice) * position.amount - fees;

    // Create closing trade record
    const trade = await Trade.create({
      botId: bot._id,
      userId: bot.userId,
      positionId: position._id,
      isDemo: bot.isDemo,
      exchange: bot.exchange,
      symbol: position.symbol,   // use actual traded pair (bot.symbol may be 'MULTI')
      side: 'sell',
      type: 'market',
      price: execution.price,
      amount: execution.amount,
      cost: execution.cost,
      fee: execution.fee,
      status: 'closed',
      orderId: execution.orderId || null,
      portionIndex: position.portionIndex,
      pnl: realizedPnL,
      triggerReason: closeReason
    });

    // Close position record
    await Position.findByIdAndUpdate(position._id, {
      status: 'closed',
      closePrice: execution.price,
      closeReason,
      closedAt: new Date(),
      realizedPnL,
      currentPrice: execution.price
    });

    // Update bot stats atomically
    const isWin = realizedPnL > 0;

    // Fetch current stats to recompute derived metrics
    const currentBot = await BotConfig.findById(bot._id).select('stats').lean();
    const s = currentBot?.stats || {};

    const newWins        = (s.winningTrades  || 0) + (isWin ? 1 : 0);
    const newLosses      = (s.losingTrades   || 0) + (!isWin ? 1 : 0);
    const closedTrades   = newWins + newLosses;
    const newGrossProfit = (s.grossProfit    || 0) + (isWin  ? realizedPnL            : 0);
    const newGrossLoss   = (s.grossLoss      || 0) + (!isWin ? Math.abs(realizedPnL)  : 0);
    const profitFactor   = newGrossLoss > 0 ? newGrossProfit / newGrossLoss : (newGrossProfit > 0 ? 999 : 0);
    const winRate        = closedTrades > 0 ? (newWins / closedTrades) * 100 : 0;
    const newConsecutive = isWin ? 0 : (s.consecutiveLosses || 0) + 1;

    await BotConfig.findByIdAndUpdate(bot._id, {
      $inc: {
        'stats.totalTrades': 1,
        'stats.totalPnL':    realizedPnL,
      },
      $set: {
        'stats.winningTrades':     newWins,
        'stats.losingTrades':      newLosses,
        'stats.grossProfit':       newGrossProfit,
        'stats.grossLoss':         newGrossLoss,
        'stats.profitFactor':      parseFloat(profitFactor.toFixed(3)),
        'stats.winRate':           parseFloat(winRate.toFixed(1)),
        'stats.consecutiveLosses': newConsecutive,
        'stats.lastTradeAt':       new Date(),
      }
    });

    // Record P&L on demo account if applicable
    if (bot.isDemo) {
      await demoSimulator.recordPnL(bot.userId, realizedPnL);
    }

    return { trade, realizedPnL, consecutiveLosses: newConsecutive };
  }

  /**
   * Internal: route order to demo or live exchange.
   */
  async _executeOrder(bot, side, amount, symbolOverride) {
    const symbol = symbolOverride || bot.symbol;

    if (bot.isDemo) {
      return await demoSimulator.executeOrder(bot.userId, {
        exchange:   bot.exchange,
        symbol,
        side,
        amount,
        marketType: bot.marketType || 'spot',
      });
    }

    // Live order via CCXT
    const exchangeAccount = await ExchangeAccount
      .findById(bot.exchangeAccountId)
      .select('+apiKeyEncrypted +apiSecretEncrypted +apiPassphraseEncrypted');

    if (!exchangeAccount) {
      throw new Error('Exchange account not found or no longer valid');
    }

    const exchange = await exchangeConnector.getConnection(exchangeAccount);

    // Set market type for futures — each exchange uses a different CCXT type name
    if (bot.marketType === 'futures') {
      const exchangeId = bot.exchange?.toLowerCase();
      // Bybit uses 'linear' for USDT-margined perpetuals; most others use 'future'
      const futuresType = exchangeId === 'bybit' ? 'linear' : 'future';
      exchange.options = { ...exchange.options, defaultType: futuresType };
    }

    // Resolve CCXT market symbol: after loadMarkets(), markets are keyed as 'BTC/USDT'.
    // SmartSignal stores pairs as 'BTCUSDT' (no slash) — look up the canonical symbol.
    const market = exchange.marketsById?.[symbol] || exchange.markets?.[symbol];
    const ccxtSymbol = market?.symbol || symbol;

    // CCXT only accepts 'buy' or 'sell' — map futures-short entry 'short' → 'sell'
    const ccxtSide = side === 'short' ? 'sell' : side;

    // ── Prefer limit orders at current best price for better execution ──────
    // Limit orders save 0.05-0.15% per trade vs market orders. We place a
    // limit at the current ask (buy) or bid (sell) and wait up to 8 seconds
    // for a fill. If unfilled, we cancel and fall back to a market order.
    let order;
    try {
      const ticker = await exchange.fetchTicker(ccxtSymbol);
      const limitPrice = ccxtSide === 'buy'
        ? ticker.ask || ticker.last        // buy at ask
        : ticker.bid || ticker.last;       // sell at bid

      if (limitPrice) {
        order = await exchange.createLimitOrder(ccxtSymbol, ccxtSide, amount, limitPrice);

        // Wait up to 8 seconds for the limit order to fill
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 1_500));
          order = await exchange.fetchOrder(order.id, ccxtSymbol);
          if (order.status === 'closed' || order.filled >= amount * 0.99) break;
        }

        // If still not filled, cancel and fall through to market order
        if (order.status !== 'closed' && (order.filled || 0) < amount * 0.99) {
          console.warn(`[OrderManager] Limit order ${order.id} not filled after 8s, falling back to market`);
          await exchange.cancelOrder(order.id, ccxtSymbol).catch(() => {});
          order = null; // trigger market fallback below
        }
      }
    } catch (limitErr) {
      console.warn(`[OrderManager] Limit order attempt failed: ${limitErr.message} — using market order`);
      order = null;
    }

    // Fallback: market order (if limit failed or timed out)
    if (!order || order.status !== 'closed') {
      order = await exchange.createMarketOrder(ccxtSymbol, ccxtSide, amount);
    }

    return {
      price: order.average || order.price || order.fills?.[0]?.price,
      amount: order.filled || amount,
      cost: order.cost || ((order.average || order.price) * amount),
      fee: order.fee || { cost: 0, currency: 'USDT', rate: 0 },
      orderId: order.id,
      executedAt: order.timestamp ? new Date(order.timestamp) : new Date()
    };
  }
}

export default new OrderManager();
