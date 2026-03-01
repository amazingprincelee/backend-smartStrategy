/**
 * EMAStrategy - EMA Crossover Trend Following
 * Buys on golden cross (fast EMA crosses above slow EMA).
 * Closes all positions on death cross.
 * Good for capturing medium-term trends.
 */
import { calculateEMA, calculateATR, isGoldenCross, isDeathCross } from '../bot/IndicatorEngine.js';

class EMAStrategy {
  async analyze(bot, candles, openPositions) {
    if (candles.length < (bot.strategyParams.emaPeriod2 || 200) + 5) return [];

    const signals = [];
    const params = bot.strategyParams;
    const closes = candles.map(c => c.close);
    const atr = calculateATR(candles, params.atrPeriod || 14);

    const lastIdx = closes.length - 1;
    const currentPrice = closes[lastIdx];
    const currentATR = atr[lastIdx];

    if (!currentATR) return [];

    // Check death cross → close all open positions
    const deathCross = isDeathCross(closes, params.emaPeriod1 || 50, params.emaPeriod2 || 200, 3);
    if (deathCross && openPositions.length > 0) {
      for (const position of openPositions) {
        signals.push({ action: 'sell', positionId: position._id, portionIndex: position.portionIndex, reason: 'stop_loss' });
      }
      return signals;
    }

    // For existing positions: check stop loss / take profit
    for (const position of openPositions) {
      if (currentPrice <= position.stopLossPrice) {
        signals.push({ action: 'sell', positionId: position._id, portionIndex: position.portionIndex, reason: 'stop_loss' });
      } else if (position.takeProfitPrice && currentPrice >= position.takeProfitPrice) {
        signals.push({ action: 'sell', positionId: position._id, portionIndex: position.portionIndex, reason: 'take_profit' });
      }
    }

    // Check golden cross → open position (only if no open positions yet)
    const goldenCross = isGoldenCross(closes, params.emaPeriod1 || 50, params.emaPeriod2 || 200, 3);

    // Alternative entry: already in uptrend (EMA50 > EMA200) + short-term RSI pullback
    // This fires when the golden cross happened in the past (common in ongoing bull markets)
    const ema50arr  = calculateEMA(closes, params.emaPeriod1 || 50);
    const ema200arr = closes.length >= (params.emaPeriod2 || 200)
      ? calculateEMA(closes, params.emaPeriod2 || 200)
      : null;
    const inUptrend = ema200arr && ema50arr[lastIdx] > ema200arr[lastIdx];
    // Simple proxy for a dip: price is near or below the 20-bar EMA
    const ema20arr = calculateEMA(closes, 20);
    const nearEma20 = currentPrice <= ema20arr[lastIdx] * 1.002; // within 0.2% of EMA20
    const uptrendDip = inUptrend && nearEma20;

    const shouldBuy = (goldenCross || uptrendDip) && openPositions.length === 0;

    if (shouldBuy) {
      const portionSize = bot.capitalAllocation.totalCapital / (params.portions || 5);
      // EMA strategy uses larger initial position (first 2 portions at once for stronger signal)
      const amount = (portionSize * 2) / currentPrice;
      const stopLossPrice = currentPrice - currentATR * (params.stopLossAtrMultiplier || 2.0);
      const takeProfitPrice = currentPrice + currentATR * 3.0; // Wider TP for trend following

      signals.push({
        action: 'buy',
        portionIndex: 0,
        amount,
        takeProfitPrice,
        stopLossPrice,
        reason: goldenCross ? 'golden_cross' : 'uptrend_dip'
      });
    }

    return signals;
  }
}

export default new EMAStrategy();
