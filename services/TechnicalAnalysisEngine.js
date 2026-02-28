/**
 * TechnicalAnalysisEngine.js
 *
 * Pure-JS technical analysis engine — no native bindings required.
 * Computes RSI, EMA, MACD, Bollinger Bands, ATR from OHLCV candles
 * and produces a LONG / SHORT signal when ≥3 indicators agree.
 *
 * Entry point:  analyzeSymbol(symbol, timeframe, marketType)
 * Returns:      { signal, pair, type, entry, stopLoss, takeProfit, … } or null signal
 */

import marketDataService from './MarketDataService.js';

// ─── Pure-JS indicator helpers ─────────────────────────────────────────────────

/** Exponential Moving Average (Wilder / standard EMA). */
function calcEMA(values, period) {
  const k = 2 / (period + 1);
  const result = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

/** RSI with Wilder smoothing (period = 14). */
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgG = gains / period;
  let avgL = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(0,  d)) / period;
    avgL = (avgL * (period - 1) + Math.max(0, -d)) / period;
  }

  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

/** MACD(fast, slow, signal). */
function calcMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return null;

  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = calcEMA(macdLine, signalPeriod);

  const last = macdLine.length - 1;
  return {
    macd:      macdLine[last],
    signal:    signalLine[last],
    histogram: macdLine[last] - signalLine[last],
  };
}

/** Bollinger Bands(period = 20, multiplier = 2). */
function calcBB(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const recent = closes.slice(-period);
  const sma = recent.reduce((a, b) => a + b, 0) / period;
  const variance = recent.reduce((s, v) => s + (v - sma) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: sma + mult * std, middle: sma, lower: sma - mult * std };
}

/** ATR(14) — Wilder smoothing over true ranges. */
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const pc = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - pc), Math.abs(low - pc)));
  }
  let atrVal = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atrVal = (atrVal * (period - 1) + trs[i]) / period;
  }
  return atrVal;
}

// ─── Main analysis function ────────────────────────────────────────────────────

/**
 * Analyse a single symbol and return a trading signal or a neutral result.
 *
 * @param {string} symbol     e.g. 'BTCUSDT'
 * @param {string} timeframe  '15m' | '1h'
 * @param {string} marketType 'spot' | 'futures'
 * @returns {Promise<object>} signal result
 */
export async function analyzeSymbol(symbol, timeframe = '1h', marketType = 'spot') {
  const candles = await marketDataService.fetchCandles(symbol, timeframe, marketType);

  if (!candles || candles.length < 50) {
    throw new Error(
      `Insufficient candle data for ${symbol} (got ${candles?.length ?? 0}, need ≥ 50)`
    );
  }

  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const price   = closes[closes.length - 1];

  // ── Compute indicators ─────────────────────────────────────────────────────
  const rsiVal  = calcRSI(closes, 14);
  const ema20   = calcEMA(closes, 20).at(-1);
  const ema50   = calcEMA(closes, 50).at(-1);
  const ema200  = closes.length >= 200 ? calcEMA(closes, 200).at(-1) : null;
  const macdObj = calcMACD(closes, 12, 26, 9);
  const bbObj   = calcBB(closes, 20, 2);
  const atrVal  = calcATR(candles, 14);

  const avgVol   = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio = avgVol > 0 ? volumes.at(-1) / avgVol : 1;

  // 10-candle price momentum
  const mom10 = closes.length >= 10
    ? (price - closes[closes.length - 10]) / closes[closes.length - 10]
    : 0;

  // ── Scoring ────────────────────────────────────────────────────────────────
  let longScore  = 0;
  let shortScore = 0;
  const bullish  = [];
  const bearish  = [];

  // 1 · RSI
  if (rsiVal !== null) {
    if (rsiVal < 35)      { longScore++;  bullish.push(`RSI oversold (${rsiVal.toFixed(1)})`); }
    else if (rsiVal > 65) { shortScore++; bearish.push(`RSI overbought (${rsiVal.toFixed(1)})`); }
  }

  // 2 · EMA20 vs EMA50 (short-term momentum)
  if (ema20 > ema50) { longScore++;  bullish.push('EMA20 above EMA50 (bullish)'); }
  else               { shortScore++; bearish.push('EMA20 below EMA50 (bearish)'); }

  // 3 · EMA200 major trend (only if enough data)
  if (ema200 !== null) {
    if (price > ema200) { longScore++;  bullish.push('Price above EMA200 (uptrend)'); }
    else                { shortScore++; bearish.push('Price below EMA200 (downtrend)'); }
  }

  // 4 · MACD histogram direction
  if (macdObj) {
    if (macdObj.histogram > 0) { longScore++;  bullish.push('MACD histogram positive'); }
    else                       { shortScore++; bearish.push('MACD histogram negative'); }
  }

  // 5 · Bollinger Bands position (0 = at lower band, 1 = at upper band)
  if (bbObj) {
    const bbRange = bbObj.upper - bbObj.lower;
    const bbPos   = bbRange > 0 ? (price - bbObj.lower) / bbRange : 0.5;
    if (bbPos < 0.25)      { longScore++;  bullish.push(`Near lower Bollinger Band (${(bbPos * 100).toFixed(0)}%)`); }
    else if (bbPos > 0.75) { shortScore++; bearish.push(`Near upper Bollinger Band (${(bbPos * 100).toFixed(0)}%)`); }
  }

  // 6 · 10-candle price momentum
  if (mom10 > 0.005)       { longScore++;  bullish.push(`Positive price momentum (+${(mom10 * 100).toFixed(2)}%)`); }
  else if (mom10 < -0.005) { shortScore++; bearish.push(`Negative price momentum (${(mom10 * 100).toFixed(2)}%)`); }

  const maxScore = ema200 !== null ? 6 : 5;
  const MIN_SCORE = 3;

  // ── Decision ───────────────────────────────────────────────────────────────
  let signalType = null;
  let rawConf    = 0;

  if (longScore >= MIN_SCORE && longScore > shortScore) {
    signalType = 'LONG';
    rawConf    = longScore / maxScore;
  } else if (shortScore >= MIN_SCORE && shortScore > longScore) {
    signalType = 'SHORT';
    rawConf    = shortScore / maxScore;
  }

  // High volume adds small confidence boost
  if (volRatio > 1.5) rawConf = Math.min(1, rawConf + 0.05);
  const confidence = Math.round(rawConf * 100) / 100;

  // Indicator summary (always included in response)
  const indicators = {
    rsi:      rsiVal  !== null ? +rsiVal.toFixed(2)  : null,
    ema20:    +ema20.toFixed(4),
    ema50:    +ema50.toFixed(4),
    ema200:   ema200  !== null ? +ema200.toFixed(4)  : null,
    macd:     macdObj ? {
      value:     +macdObj.macd.toFixed(4),
      signal:    +macdObj.signal.toFixed(4),
      histogram: +macdObj.histogram.toFixed(4),
    } : null,
    bb: bbObj ? {
      upper:  +bbObj.upper.toFixed(4),
      middle: +bbObj.middle.toFixed(4),
      lower:  +bbObj.lower.toFixed(4),
    } : null,
    atr:      atrVal !== null ? +atrVal.toFixed(4) : null,
    volRatio: +volRatio.toFixed(2),
  };

  // ── Neutral result (no signal) ─────────────────────────────────────────────
  if (!signalType) {
    return {
      signal:       null,
      pair:         symbol,
      timeframe,
      marketType,
      currentPrice: price,
      longScore,
      shortScore,
      maxScore,
      indicators,
      reasons:      [],
      message:      `Market is neutral — ${longScore} bullish vs ${shortScore} bearish indicators (need ≥ ${MIN_SCORE} to agree)`,
      timestamp:    new Date().toISOString(),
    };
  }

  // ── ATR-based SL / TP (1.5× / 3.0× → always 2:1 R:R) ────────────────────
  const slDist = atrVal ? atrVal * 1.5 : price * 0.015;
  const tpDist = atrVal ? atrVal * 3.0 : price * 0.030;

  const entry      = price;
  const stopLoss   = signalType === 'LONG' ? entry - slDist : entry + slDist;
  const takeProfit = signalType === 'LONG' ? entry + tpDist : entry - tpDist;
  const riskReward = +(tpDist / slDist).toFixed(2);

  return {
    signal:         signalType,
    pair:           symbol,
    type:           signalType,
    timeframe,
    marketType,
    exchange:       'Binance',
    entry,
    stopLoss,
    takeProfit,
    riskReward,
    atr:            atrVal,
    confidenceScore: confidence,
    currentPrice:   price,
    longScore,
    shortScore,
    maxScore,
    indicators,
    reasons:        signalType === 'LONG' ? bullish : bearish,
    timestamp:      new Date().toISOString(),
  };
}

// ─── Background sweep helper ──────────────────────────────────────────────────
// Called by the server.js cron job

const TOP_PAIRS_FOR_SWEEP = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
  'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT',
];

/**
 * Sweep top pairs and return any generated signals.
 * @param {string} timeframe  default '1h'
 * @returns {Promise<Array>}  array of signal objects (only those with signal !== null)
 */
export async function sweepTopPairs(timeframe = '1h') {
  const signals = [];
  for (const pair of TOP_PAIRS_FOR_SWEEP) {
    try {
      const result = await analyzeSymbol(pair, timeframe, 'spot');
      if (result.signal) signals.push(result);
    } catch (err) {
      console.warn(`[TAEngine] sweep skip ${pair}: ${err.message}`);
    }
  }
  return signals;
}

export default { analyzeSymbol, sweepTopPairs };
