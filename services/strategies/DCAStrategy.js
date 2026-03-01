/**
 * DCAStrategy - Dollar-Cost Averaging
 * Buys a fixed dollar amount at regular time intervals regardless of price.
 * Simple and effective for long-term accumulation.
 */
import Trade from '../../models/bot/Trade.js';
import riskEngine from '../bot/RiskEngine.js';

class DCAStrategy {
  async analyze(bot, candles, openPositions) {
    if (candles.length < 2) return [];

    const signals = [];
    const params = bot.strategyParams;
    const currentPrice = candles[candles.length - 1].close;
    const currentATR = candles[candles.length - 1].close * 0.02; // ~2% fallback ATR

    // Leverage factor — only meaningful for futures bots
    const leverage = bot.marketType === 'futures' ? (params.leverage || 1) : 1;

    // Check exit conditions for open positions
    for (const position of openPositions) {
      const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      if (pnlPercent >= (params.fixedTakeProfitPercent || 2.0)) {
        signals.push({ action: 'sell', positionId: position._id, portionIndex: position.portionIndex, reason: 'take_profit' });
      } else if (pnlPercent <= -(params.stopLossAtrMultiplier || 3.0)) {
        signals.push({ action: 'sell', positionId: position._id, portionIndex: position.portionIndex, reason: 'stop_loss' });
      }
    }

    // Check if it's time for the next DCA buy
    const intervalMs = (params.dcaIntervalHours || 24) * 60 * 60 * 1000;
    const lastBuy = await Trade.findOne({ botId: bot._id, side: 'buy' }).sort({ executedAt: -1 });
    const lastBuyTime = lastBuy?.executedAt?.getTime() || 0;
    const timeSinceLastBuy = Date.now() - lastBuyTime;

    if (timeSinceLastBuy >= intervalMs) {
      const dcaAmount = params.dcaAmountPerOrder || 100;
      // For futures: dcaAmountPerOrder is the margin; leverage determines notional exposure
      const amount = (dcaAmount * leverage) / currentPrice;
      const stopLossPrice = currentPrice * (1 - (params.stopLossAtrMultiplier || 3.0) / 100);
      const takeProfitPrice = currentPrice * (1 + (params.fixedTakeProfitPercent || 2.0) / 100);

      // Find available portion slot
      const openPortionIndexes = new Set(openPositions.map(p => p.portionIndex));
      let portionIdx = -1;
      for (let i = 0; i < (params.portions || 5); i++) {
        if (!openPortionIndexes.has(i)) { portionIdx = i; break; }
      }

      if (portionIdx >= 0) {
        signals.push({
          action: 'buy',
          portionIndex: portionIdx,
          amount,
          takeProfitPrice,
          stopLossPrice,
          reason: 'dca'
        });
      }
    }

    return signals;
  }
}

export default new DCAStrategy();
