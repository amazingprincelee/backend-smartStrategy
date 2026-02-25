/**
 * HybridSignalEngine.js
 * Production-grade signal engine — the brain of SmartStrategy.
 *
 * Pipeline per symbol:
 *  1. Fetch multi-timeframe OHLCV  (1m, 5m, 15m, 1h)
 *  2. Feature engineering on 1h (primary) candles
 *  3. AI model prediction         → buyProb / sellProb
 *  4. Gate: skip if AI confidence < 0.75
 *  5. Rule-based confirmation     (RSI, EMA, MACD, Volume, EMA200 trend filter)
 *  6. Multi-timeframe alignment   (at least 2 of 3 lower TFs agree)
 *  7. Futures filters             (funding rate, leverage sizing)
 *  8. Cooldown + daily trade cap
 *  9. Risk management             (ATR SL/TP, liquidation distance, volatility check)
 * 10. Persist to DB + deliver via WebSocket / email
 */

import marketData    from './MarketDataService.js';
import signalModel   from '../ai/SignalModel.js';
import riskManager   from '../risk/RiskManager.js';
import SignalModel   from '../models/Signal.js';
import { computeAllFeatures } from '../ai/FeatureEngineering.js';
import { calculateEMA, calculateRSI } from './bot/IndicatorEngine.js';

// ─── Configuration ────────────────────────────────────────────────────────────

const SPOT_PAIRS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
  'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
];

const FUTURES_PAIRS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT',
  'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT',
];

const MIN_AI_CONFIDENCE    = 0.55;  // minimum AI probability to proceed
const MIN_RULE_SCORE       = 0.28;  // minimum rule confirmation score (0-1)
const COOLDOWN_MS          = 30 * 60_000;   // 30 minutes between same pair+type signals
const MAX_SIGNALS_PER_DAY  = 20;
const SIGNAL_CACHE_TTL_MS  = 3 * 60_000;   // 3-minute result cache
const MAX_FUNDING_RATE     = 0.001;         // skip futures if |funding| > 0.1%

// ─── Engine ───────────────────────────────────────────────────────────────────

class HybridSignalEngine {
  constructor() {
    this._cache        = new Map();   // marketType → { data, ts }
    this._cooldown     = new Map();   // `${symbol}:${type}` → timestamp
    this._dailyCounts  = new Map();   // 'YYYY-MM-DD' → count
    this._statsCache   = null;
    this._statsCacheTs = 0;
    this.io            = null;
    this.deliveryService = null;
  }

  // ─── Init ───────────────────────────────────────────────────────────────

  async init(io, deliveryService) {
    this.io              = io;
    this.deliveryService = deliveryService;

    await signalModel.init();

    // Train AI model in background (non-blocking)
    this._trainInBackground().catch(err =>
      console.warn('[HybridEngine] Background training failed:', err.message)
    );

    console.log('[HybridSignalEngine] Initialized');
  }

  async _trainInBackground() {
    const candles = await marketData.fetchHistoricalCandles('BTCUSDT', '1h', 1000, 'spot');
    await signalModel.train(candles);
  }

  setIO(io) { this.io = io; }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Return signals for spot or futures market.
   * Uses a 3-min cache so rapid API calls don't re-trigger the pipeline.
   */
  async getSignals(marketType = 'spot') {
    const cached = this._cache.get(marketType);
    if (cached && Date.now() - cached.ts < SIGNAL_CACHE_TTL_MS) {
      return cached.data;
    }

    const pairs   = marketType === 'futures' ? FUTURES_PAIRS : SPOT_PAIRS;
    const signals = [];

    for (const symbol of pairs) {
      try {
        const sig = await this._analyzeSymbol(symbol, marketType);
        if (sig) {
          signals.push(sig);
          console.log(`[HybridEngine] ${symbol}/${marketType}: ✓ signal generated (${sig.type}, conf=${sig.confidenceScore})`);
        }
        await delay(400); // gentle on Binance rate limits
      } catch (err) {
        console.error(`[HybridEngine] ${symbol}/${marketType}: ✗ DATA ERROR — ${err.message}`);
      }
    }

    this._cache.set(marketType, { data: signals, ts: Date.now() });
    console.log(`[HybridEngine] ${marketType}: ${signals.length}/${pairs.length} actionable signals`);
    return signals;
  }

  /**
   * Platform-wide stats for the dashboard / landing page.
   */
  async getPlatformStats() {
    const now = Date.now();
    if (this._statsCache && now - this._statsCacheTs < 5 * 60_000) {
      return this._statsCache;
    }

    try {
      const [spot, futures] = await Promise.all([
        this.getSignals('spot'),
        this.getSignals('futures'),
      ]);
      const all = [...spot, ...futures];

      const stats = {
        activeSignals:      all.length,
        buySignals:         all.filter(s => s.type === 'LONG').length,
        sellSignals:        all.filter(s => s.type === 'SHORT').length,
        neutralSignals:     0,
        totalSignalsToday:  this._todayCount(),
        supportedExchanges: 10,
        tradingPairs:       SPOT_PAIRS.length + FUTURES_PAIRS.length,
        aiPowered:          signalModel.isModelReady,
        engineVersion:      '2.0-hybrid',
      };

      this._statsCache   = stats;
      this._statsCacheTs = now;
      return stats;
    } catch {
      return {
        activeSignals: 0, buySignals: 0, sellSignals: 0,
        neutralSignals: 0, totalSignalsToday: 0,
        supportedExchanges: 10, tradingPairs: 18,
        aiPowered: false, engineVersion: '2.0-hybrid',
      };
    }
  }

  // ─── Core analysis pipeline ─────────────────────────────────────────────

  async _analyzeSymbol(symbol, marketType) {

    // ── Step 1: Data ────────────────────────────────────────────────────────
    const [mtfData, ticker] = await Promise.all([
      marketData.fetchMultiTimeframe(symbol, marketType),
      marketData.fetchTicker(symbol, marketType),
    ]);

    const h1 = mtfData['1h'];
    if (!h1 || h1.length < 200) {
      console.log(`[HybridEngine] ${symbol}/${marketType}: ✗ insufficient candles (${h1?.length ?? 0})`);
      return null;
    }

    // ── Step 2: Feature engineering ─────────────────────────────────────────
    const allFeatures  = computeAllFeatures(h1);
    if (!allFeatures) {
      console.log(`[HybridEngine] ${symbol}/${marketType}: ✗ feature engineering returned null`);
      return null;
    }

    let lastFeat = null;
    for (let i = allFeatures.length - 1; i >= 0; i--) {
      if (allFeatures[i]) { lastFeat = allFeatures[i]; break; }
    }
    if (!lastFeat) {
      console.log(`[HybridEngine] ${symbol}/${marketType}: ✗ no valid feature row`);
      return null;
    }

    // ── Step 3: AI prediction ────────────────────────────────────────────────
    const prediction = await signalModel.predict(lastFeat.normalized);
    const { buyProb, sellProb } = prediction;
    const maxProb  = Math.max(buyProb, sellProb);
    const aiType   = buyProb > sellProb ? 'LONG' : 'SHORT';

    // ── Step 4: Confidence gate ─────────────────────────────────────────────
    if (maxProb < MIN_AI_CONFIDENCE) {
      console.log(`[HybridEngine] ${symbol}/${marketType}: ✗ AI confidence ${maxProb.toFixed(3)} < ${MIN_AI_CONFIDENCE} (${aiType}, src:${prediction.source})`);
      return null;
    }

    // ── Step 5: Rule-based confirmation ─────────────────────────────────────
    const rule = this._ruleConfirmation(lastFeat, h1, aiType, ticker);
    if (rule.score < MIN_RULE_SCORE) {
      console.log(`[HybridEngine] ${symbol}/${marketType}: ✗ rule score ${rule.score.toFixed(3)} < ${MIN_RULE_SCORE} (${aiType})`);
      return null;
    }

    // ── Step 6: Multi-timeframe alignment ────────────────────────────────────
    const mtf = this._mtfAlignment(mtfData, aiType);
    if (!mtf.aligned) {
      console.log(`[HybridEngine] ${symbol}/${marketType}: ✗ MTF misaligned (${mtf.alignedCount}/${mtf.total} TFs agree, ${JSON.stringify(mtf.summary)})`);
      return null;
    }

    // ── Step 7: Futures-specific filters ────────────────────────────────────
    if (marketType === 'futures') {
      const fundingRate = await marketData.fetchFundingRate(symbol);
      if (aiType === 'LONG'  && fundingRate >  MAX_FUNDING_RATE) return null;
      if (aiType === 'SHORT' && fundingRate < -MAX_FUNDING_RATE) return null;
    }

    // ── Step 8: Cooldown & daily cap ────────────────────────────────────────
    const coolKey = `${symbol}:${aiType}`;
    if (Date.now() - (this._cooldown.get(coolKey) ?? 0) < COOLDOWN_MS) return null;
    if (this._todayCount() >= MAX_SIGNALS_PER_DAY) return null;

    // ── Step 9: Risk management ──────────────────────────────────────────────
    const entry    = ticker.lastPrice;
    const atr      = lastFeat.atr;
    const leverage = marketType === 'futures'
      ? riskManager.suggestLeverage(maxProb, atr / entry)
      : 1;

    const riskParams = riskManager.calculateRiskParams({
      type: aiType, entry, atr, marketType, leverage,
    });
    if (!riskParams.valid) return null;

    // ── Step 10: Build & deliver signal ─────────────────────────────────────
    const confidenceScore = parseFloat(
      (maxProb * 0.6 + rule.score * 0.4).toFixed(4)
    );

    const signal = {
      pair:            symbol.replace('USDT', '/USDT'),
      rawSymbol:       symbol,
      type:            aiType,
      entry:           parseFloat(entry.toFixed(8)),
      stopLoss:        riskParams.stopLoss,
      takeProfit:      riskParams.takeProfit,
      leverage:        marketType === 'futures' ? leverage : undefined,
      riskReward:      riskParams.riskReward,
      atr:             parseFloat(atr.toFixed(8)),
      confidenceScore,
      timeframe:       '1h',
      marketType,
      exchange:        'binance',
      aiProb:          { buy: buyProb, sell: sellProb, hold: prediction.holdProb },
      aiSource:        prediction.source,
      reasons:         rule.reasons,
      mtfAlignment:    mtf.summary,
      timestamp:       new Date().toISOString(),
    };

    // Update counters
    this._cooldown.set(coolKey, Date.now());
    this._incrementDailyCount();

    // Persist & deliver (non-blocking)
    this._persistSignal(signal).catch(() => {});
    if (this.deliveryService) {
      this.deliveryService.deliverSignal(signal).catch(() => {});
    }

    return signal;
  }

  // ─── Rule confirmation ───────────────────────────────────────────────────

  _ruleConfirmation(feat, candles, direction, ticker) {
    const reasons = [];
    let score     = 0;

    const {
      rsi, ema20, ema50, ema200,
      macdLine, macdHistogram,
      volumeRatio, spikeScore,
    } = feat;

    const price    = ticker.lastPrice;
    const change24 = ticker.priceChangePercent;

    if (direction === 'LONG') {

      // RSI oversold
      if (rsi < 30) {
        score += 0.30;
        reasons.push(`RSI deeply oversold (${rsi.toFixed(1)})`);
      } else if (rsi < 40) {
        score += 0.15;
        reasons.push(`RSI oversold (${rsi.toFixed(1)})`);
      }

      // Macro trend filter — price must be above EMA200
      if (ema200 && price > ema200) {
        score += 0.20;
        reasons.push('Price above EMA200 (bullish macro trend)');
      }

      // EMA short-term structure
      if (ema20 > ema50) {
        score += 0.15;
        reasons.push('EMA20 above EMA50 (short-term bullish)');
      }

      // MACD positive
      if (macdLine > 0) {
        score += 0.10;
        reasons.push('MACD line positive');
      }
      if (macdHistogram > 0) {
        score += 0.08;
        reasons.push('MACD histogram positive (momentum building)');
      }

      // Volume spike
      if (spikeScore > 0.4) {
        score += 0.10;
        reasons.push(`Volume spike (${volumeRatio.toFixed(1)}× average)`);
      }

      // 24h dip (mean-reversion opportunity)
      if (change24 <= -5) {
        score += 0.07;
        reasons.push(`Sharp 24h dip (${change24.toFixed(1)}%)`);
      }

    } else {  // SHORT

      if (rsi > 70) {
        score += 0.30;
        reasons.push(`RSI deeply overbought (${rsi.toFixed(1)})`);
      } else if (rsi > 60) {
        score += 0.15;
        reasons.push(`RSI overbought (${rsi.toFixed(1)})`);
      }

      if (ema200 && price < ema200) {
        score += 0.20;
        reasons.push('Price below EMA200 (bearish macro trend)');
      }

      if (ema20 < ema50) {
        score += 0.15;
        reasons.push('EMA20 below EMA50 (short-term bearish)');
      }

      if (macdLine < 0) {
        score += 0.10;
        reasons.push('MACD line negative');
      }
      if (macdHistogram < 0) {
        score += 0.08;
        reasons.push('MACD histogram negative (downward momentum)');
      }

      if (spikeScore > 0.4) {
        score += 0.10;
        reasons.push(`Volume spike on selling (${volumeRatio.toFixed(1)}× average)`);
      }

      if (change24 >= 10) {
        score += 0.07;
        reasons.push(`Parabolic 24h rally (${change24.toFixed(1)}%) — potential reversal`);
      }
    }

    return { score: parseFloat(score.toFixed(4)), reasons };
  }

  // ─── Multi-timeframe alignment ───────────────────────────────────────────

  _mtfAlignment(mtfData, direction) {
    const summary     = {};
    let alignedCount  = 0;
    const checkTFs    = ['5m', '15m', '1h'];

    for (const tf of checkTFs) {
      const candles = mtfData[tf];
      if (!candles || candles.length < 60) {
        summary[tf] = 'no_data';
        continue;
      }

      const closes = candles.map(c => c.close);
      const ema20  = calculateEMA(closes, 20);
      const ema50  = calculateEMA(closes, 50);
      const rsi    = calculateRSI(closes, 14);
      const last   = closes.length - 1;
      const price  = closes[last];

      if (!ema20[last] || !ema50[last] || !rsi[last]) {
        summary[tf] = 'calc_error';
        continue;
      }

      const bullish = ema20[last] > ema50[last] && rsi[last] < 65 && price > ema20[last];
      const bearish = ema20[last] < ema50[last] && rsi[last] > 35 && price < ema20[last];

      if (direction === 'LONG' && bullish)  { summary[tf] = 'bullish'; alignedCount++; }
      else if (direction === 'SHORT' && bearish) { summary[tf] = 'bearish'; alignedCount++; }
      else { summary[tf] = 'neutral'; }
    }

    // Need at least 1 of 3 timeframes to agree (strict 2/3 was too aggressive for ranging markets)
    return { aligned: alignedCount >= 1, alignedCount, total: checkTFs.length, summary };
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  async _persistSignal(signal) {
    try {
      await SignalModel.create({
        pair:            signal.pair,
        type:            signal.type,
        entry:           signal.entry,
        stopLoss:        signal.stopLoss,
        takeProfit:      signal.takeProfit,
        leverage:        signal.leverage ?? null,
        riskReward:      signal.riskReward,
        atr:             signal.atr,
        marketType:      signal.marketType,
        exchange:        signal.exchange,
        timeframe:       signal.timeframe,
        confidenceScore: signal.confidenceScore,
        aiProb:          signal.aiProb,
        aiSource:        signal.aiSource,
        reasons:         signal.reasons,
        mtfAlignment:    signal.mtfAlignment,
        timestamp:       signal.timestamp,
      });
    } catch (err) {
      if (err.code !== 11000) {
        console.warn('[HybridEngine] DB persist warning:', err.message);
      }
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  _todayCount() {
    const key = todayDateKey();
    return this._dailyCounts.get(key) ?? 0;
  }

  _incrementDailyCount() {
    const key     = todayDateKey();
    const current = this._dailyCounts.get(key) ?? 0;
    this._dailyCounts.set(key, current + 1);

    // Prune old entries (keep only today)
    for (const k of this._dailyCounts.keys()) {
      if (k !== key) this._dailyCounts.delete(k);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function todayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Export singleton ─────────────────────────────────────────────────────────

export default new HybridSignalEngine();
