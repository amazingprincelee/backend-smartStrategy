/**
 * RSIReversalStrategy - Mean reversion using RSI.
 * Buys when RSI crosses below oversold threshold (default 30).
 * Sells when RSI crosses above overbought threshold (default 70).
 * Best for ranging/sideways markets.
 */
import { calculateRSI, calculateATR } from '../bot/IndicatorEngine.js';
import riskEngine from '../bot/RiskEngine.js';

class RSIReversalStrategy {
  async analyze(bot, candles, openPositions) {
    if (candles.length < 20) return [];

    const signals = [];
    const params = bot.strategyParams;
    const closes = candles.map(c => c.close);
    const rsi = calculateRSI(closes, 14);
    const atr = calculateATR(candles, params.atrPeriod || 14);

    const lastIdx = closes.length - 1;
    const currentPrice = closes[lastIdx];
    const currentRSI = rsi[lastIdx];
    const prevRSI = rsi[lastIdx - 1];
    const currentATR = atr[lastIdx];

    if (!currentRSI || !prevRSI || !currentATR) return [];

    const rsiOversold = params.rsiOversold || 30;
    const rsiOverbought = params.rsiOverbought || 70;

    // Check exit: sell when RSI crosses above overbought
    for (const position of openPositions) {
      // Check standard exits
      const pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      if (currentRSI >= rsiOverbought) {
        signals.push({ action: 'sell', positionId: position._id, portionIndex: position.portionIndex, reason: 'take_profit' });
      } else if (currentPrice <= position.stopLossPrice) {
        signals.push({ action: 'sell', positionId: position._id, portionIndex: position.portionIndex, reason: 'stop_loss' });
      }
    }

    // Check entry: buy on RSI cross below oversold, or when RSI is broadly oversold
    const rsiBuySignal    = prevRSI >= rsiOversold && currentRSI < rsiOversold;
    const rsiDeeplyOversold = currentRSI < 25;
    // Broader condition: RSI below 38 gives a chance to enter in strong-but-overbought markets
    const rsiBroadOversold  = currentRSI < 38;

    const openPortionIndexes = new Set(openPositions.map(p => p.portionIndex));
    let portionIdx = -1;
    for (let i = 0; i < (params.portions || 5); i++) {
      if (!openPortionIndexes.has(i)) { portionIdx = i; break; }
    }

    if ((rsiBuySignal || rsiDeeplyOversold || rsiBroadOversold) && portionIdx >= 0 && openPortionIndexes.size === 0) {
      const portionSize = bot.capitalAllocation.totalCapital / (params.portions || 5);
      const amount = portionSize / currentPrice;
      const stopLossPrice = currentPrice - currentATR * (params.stopLossAtrMultiplier || 2.0);
      const takeProfitPrice = currentPrice + currentATR * 1.5;

      signals.push({
        action: 'buy',
        portionIndex: portionIdx,
        amount,
        takeProfitPrice,
        stopLossPrice,
        reason: 'entry'
      });
    }

    return signals;
  }
}

export default new RSIReversalStrategy();
