/**
 * AdaptiveGridStrategy - Default strategy (combined best of two descriptions)
 *
 * Logic:
 * - Multi-confirmation trend detection (EMA50/200 + price structure)
 * - Capital split into N portions, grid spacing = ATR-based
 * - Entry: RSI oversold + volume confirmation + not near resistance
 * - Take profit: structure-based (swing high) → ATR fallback → fixed %
 * - Stop loss: 2x ATR below entry
 * - Trailing stop: activates at +2% gain
 */

import {
  calculateEMA,
  calculateRSI,
  calculateATR,
  detectSwingHighs,
  detectSwingLows,
  detectTrend,
  findNearestResistance,
  calcVolumeMA
} from '../bot/IndicatorEngine.js';
import riskEngine from '../bot/RiskEngine.js';

class AdaptiveGridStrategy {
  /**
   * Analyze market and return trading signals.
   * @param {Object} bot - BotConfig document
   * @param {Object[]} candles - OHLCV array, newest last
   * @param {Object[]} openPositions - open Position documents for this bot
   * @returns {Promise<Object[]>} signals: [{ action, portionIndex, amount, takeProfitPrice, stopLossPrice, reason, positionId? }]
   */
  async analyze(bot, candles, openPositions) {
    if (candles.length < 30) return [];

    const params = bot.strategyParams;
    const signals = [];

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);

    const ema50 = calculateEMA(closes, params.emaPeriod1 || 50);
    const rsi = calculateRSI(closes, 14);
    const atr = calculateATR(candles, params.atrPeriod || 14);
    const swingHighs = detectSwingHighs(highs, 5);

    const lastIdx = closes.length - 1;
    const currentPrice = closes[lastIdx];
    const currentATR = atr[lastIdx];
    const currentRSI = rsi[lastIdx];
    const currentEma50 = ema50[lastIdx];
    const trend = detectTrend(candles, params.emaPeriod1 || 50, params.emaPeriod2 || 200);

    if (!currentATR || !currentRSI) return [];

    // === CHECK EXIT CONDITIONS FOR OPEN POSITIONS ===
    for (const position of openPositions) {
      // Update trailing stop first
      riskEngine.updateTrailingStop(position, currentPrice, params);

      const exit = riskEngine.checkExitConditions(position, currentPrice);
      if (exit.shouldClose) {
        signals.push({
          action: 'sell',
          positionId: position._id,
          portionIndex: position.portionIndex,
          reason: exit.reason
        });
      }
    }

    // === CHECK ENTRY CONDITIONS ===
    const openPortionIndexes = new Set(
      openPositions
        .filter(p => !signals.find(s => s.positionId?.toString() === p._id.toString()))
        .map(p => p.portionIndex)
    );

    // Find available portion slots
    const availablePortions = [];
    for (let i = 0; i < (params.portions || 5); i++) {
      if (!openPortionIndexes.has(i)) availablePortions.push(i);
    }

    if (availablePortions.length === 0) return signals;

    // Entry conditions
    const rsiOversold = params.rsiOversold || 30;
    // Strict: RSI below configured oversold level (classic oversold, default 30)
    const rsiStrict = currentRSI !== null && currentRSI < rsiOversold;
    // Loose: RSI below 42 in a bullish trend — catches dip-buys without waiting for RSI < 30
    const rsiLoose  = currentRSI !== null && currentRSI < 42 && trend === 'bullish';
    const rsiConditionMet = rsiStrict || rsiLoose;

    // Volume confirmation: current volume > 1.2x 20-bar average
    const avgVolume = calcVolumeMA(volumes, 20);
    const volumeConditionMet = volumes[lastIdx] > avgVolume * 1.2;

    // No-buy zone: don't enter within 0.5% of nearest resistance
    const nearestResistance = findNearestResistance(currentPrice, swingHighs, 50);
    const resistanceBuffer = nearestResistance
      ? (nearestResistance - currentPrice) / currentPrice
      : 1;
    const notNearResistance = resistanceBuffer > 0.005;

    // Grid spacing check: don't open another position too close to an existing one
    const gridSpacingPercent = (params.gridSpacingMultiplier || 0.5) * (currentATR / currentPrice);
    const existingPrices = openPositions.map(p => p.entryPrice);
    const tooCloseToExisting = existingPrices.some(ep =>
      Math.abs(currentPrice - ep) / ep < gridSpacingPercent * 0.5
    );

    const shouldEnter = rsiConditionMet && volumeConditionMet && notNearResistance && !tooCloseToExisting;

    if (shouldEnter) {
      const portionIdx = availablePortions[0];
      const portionSize = bot.capitalAllocation.totalCapital / (params.portions || 5);
      const amount = portionSize / currentPrice;

      // Calculate stop loss: 2x ATR below entry
      const stopLossMultiplier = params.stopLossAtrMultiplier || 2.0;
      const stopLossPrice = currentPrice - (currentATR * stopLossMultiplier);

      // Calculate take profit (priority order: structure → ATR → fixed)
      let takeProfitPrice = null;
      const tpMode = params.takeProfitMode || 'structure';

      if (tpMode === 'structure' && nearestResistance && nearestResistance > currentPrice * 1.005) {
        // Just below nearest resistance (0.2% buffer)
        takeProfitPrice = nearestResistance * 0.998;
      } else if (tpMode === 'atr' || (tpMode === 'structure' && !takeProfitPrice)) {
        // ATR-based
        takeProfitPrice = currentPrice + currentATR;
      }

      // Fallback: fixed %
      if (!takeProfitPrice || takeProfitPrice < currentPrice * 1.005) {
        const fixedPct = params.fixedTakeProfitPercent || 1.5;
        takeProfitPrice = currentPrice * (1 + fixedPct / 100);
      }

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

export default new AdaptiveGridStrategy();
