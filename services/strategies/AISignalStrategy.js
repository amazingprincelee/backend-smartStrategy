/**
 * AISignalStrategy - AI-Powered Signal Bot Strategy
 *
 * Uses TechnicalAnalysisEngine to generate LONG signals based on multi-indicator
 * consensus (RSI, EMA20/50/200, MACD, Bollinger Bands, momentum).
 *
 * Entry:  ≥3 of 6 indicators agree on LONG direction
 * Exit:   ATR-based SL (1.5×) and TP (3.0×) → guaranteed 2:1 R:R
 * Size:   Capital / maxOpenPositions (× leverage for futures bots)
 * Tick:   1h — matches the TAEngine analysis timeframe
 */
import { analyzeSymbol } from '../TechnicalAnalysisEngine.js';

class AISignalStrategy {
  async analyze(bot, candles, openPositions) {
    if (candles.length < 2) return [];

    const signals = [];
    const params = bot.strategyParams;
    const currentPrice = candles[candles.length - 1].close;

    // ── 1. Check SL/TP exits for open positions ──────────────────────────────
    for (const position of openPositions) {
      const { stopLossPrice, takeProfitPrice } = position;

      if (stopLossPrice && currentPrice <= stopLossPrice) {
        signals.push({
          action: 'sell',
          positionId: position._id,
          portionIndex: position.portionIndex,
          reason: 'stop_loss'
        });
      } else if (takeProfitPrice && currentPrice >= takeProfitPrice) {
        signals.push({
          action: 'sell',
          positionId: position._id,
          portionIndex: position.portionIndex,
          reason: 'take_profit'
        });
      }
    }

    // If closing positions this tick, let them close first before re-entering
    if (signals.length > 0) return signals;

    // Already holding — wait for SL/TP conditions
    if (openPositions.length > 0) return signals;

    // ── 2. Get AI signal from TechnicalAnalysisEngine ────────────────────────
    // bot.symbol may be 'BTCUSDT' or 'BTC/USDT' — normalize to 'BTCUSDT'
    const symbol = bot.symbol.replace('/', '');
    const marketType = bot.marketType || 'spot';

    let taResult;
    try {
      taResult = await analyzeSymbol(symbol, '1h', marketType);
    } catch (err) {
      console.warn(`[AISignalStrategy] analyzeSymbol failed for ${symbol}: ${err.message}`);
      return signals;
    }

    // Only enter on LONG signals
    if (taResult.signal !== 'LONG') return signals;

    console.log(
      `[AISignalStrategy] LONG signal on ${symbol} — confidence ${Math.round((taResult.confidenceScore || 0) * 100)}%`,
      `reasons: ${(taResult.reasons || []).join(', ')}`
    );

    // ── 3. Position sizing ───────────────────────────────────────────────────
    const maxPositions = bot.capitalAllocation.maxOpenPositions || 5;
    const capitalPerTrade = bot.capitalAllocation.totalCapital / maxPositions;
    // For futures bots, leverage amplifies the position size (margin stays fixed)
    const leverage = bot.marketType === 'futures' ? (params.leverage || 1) : 1;
    const amount = (capitalPerTrade * leverage) / currentPrice;

    // ── 4. Find available portion slot ──────────────────────────────────────
    const openPortionIndexes = new Set(openPositions.map(p => p.portionIndex));
    let portionIdx = -1;
    for (let i = 0; i < maxPositions; i++) {
      if (!openPortionIndexes.has(i)) { portionIdx = i; break; }
    }
    if (portionIdx < 0) return signals;

    signals.push({
      action: 'buy',
      portionIndex: portionIdx,
      amount,
      stopLossPrice:   taResult.stopLoss,
      takeProfitPrice: taResult.takeProfit,
      reason: `ai_long_conf${Math.round((taResult.confidenceScore || 0) * 100)}`
    });

    return signals;
  }
}

export default new AISignalStrategy();
