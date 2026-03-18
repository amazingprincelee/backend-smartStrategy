/**
 * signalController.js
 * Handles all signal-related API requests.
 * Delegates to HybridSignalEngine (AI + rules + multi-TF pipeline).
 */

import hybridEngine      from '../services/HybridSignalEngine.js';
import backtestEngine   from '../backtesting/BacktestEngine.js';
import SignalModel       from '../models/Signal.js';
import AlphaSignal      from '../models/AlphaSignal.js';
import BotConfig         from '../models/bot/BotConfig.js';
import { analyzeSymbol } from '../services/TechnicalAnalysisEngine.js';
import ExchangePairs     from '../models/ExchangePairs.js';

// ─── Free-tier gating helpers ─────────────────────────────────────────────────

function isPremiumUser(req) {
  const u = req.user;
  if (!u) return false;
  if (u.role === 'admin') return true;
  if (u.role === 'premium') {
    const expiry = u.subscription?.expiresAt;
    if (!expiry) return true;                        // manual/lifetime grant
    return new Date() < new Date(expiry);
  }
  return false;
}

function maskSignal(sig) {
  return {
    ...sig,
    entry:      null,
    stopLoss:   null,
    takeProfit: null,
    _gated:     true,
  };
}

// ─── Pair list cache (refreshed every 60 min) ────────────────────────────────
let _pairsCache = { spot: [], futures: [], fetchedAt: 0 };
const PAIRS_TTL = 60 * 60 * 1000; // 1 hour

// ─── Exchange pairs (DB-backed, refreshed monthly) ───────────────────────────

// All exchanges shown in the CreateBot dropdown
const PRELOAD_EXCHANGES = ['okx', 'kucoin', 'bitget', 'phemex', 'gate', 'mexc', 'huobi', 'kraken'];
const PRELOAD_MARKETS   = ['spot', 'futures'];
const STALE_DAYS        = 30; // refresh DB records older than this

// Frontend exchange IDs → CCXT exchange IDs (only entries that differ)
const CCXT_ID = { gate: 'gateio' };

async function fetchGatePairs(market) {
  const url =
    market === 'futures'
      ? 'https://api.gateio.ws/api/v4/futures/usdt/contracts?limit=500'
      : 'https://api.gateio.ws/api/v4/spot/tickers';

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Gate.io ${market} fetch failed: ${res.status}`);
  const data = await res.json();

  if (market === 'futures') {
    // contracts: filter active USDT-settled, return pair symbol in BTCUSDT format
    return data
      .filter(c => !c.in_delisting)
      .map(c => c.name.replace('_USDT', 'USDT'))   // BTC_USDT → BTCUSDT
      .filter(s => s.endsWith('USDT'));
  }

  // spot tickers: filter USDT pairs, sort by quote_volume desc, take top 300
  return data
    .filter(t => t.currency_pair && t.currency_pair.endsWith('_USDT'))
    .sort((a, b) => parseFloat(b.quote_volume || 0) - parseFloat(a.quote_volume || 0))
    .slice(0, 300)
    .map(t => t.currency_pair.replace('_USDT', 'USDT'));  // BTC_USDT → BTCUSDT
}

// ─── GET /api/signals/pairs?market=spot|futures ──────────────────────────────

export const getAvailablePairs = async (req, res) => {
  try {
    const market = req.query.market === 'futures' ? 'futures' : 'spot';
    const now    = Date.now();

    if (now - _pairsCache.fetchedAt > PAIRS_TTL || _pairsCache[market].length === 0) {
      const [spot, futures] = await Promise.allSettled([
        fetchGatePairs('spot'),
        fetchGatePairs('futures'),
      ]);
      _pairsCache.spot    = spot.status    === 'fulfilled' ? spot.value    : _pairsCache.spot;
      _pairsCache.futures = futures.status === 'fulfilled' ? futures.value : _pairsCache.futures;
      _pairsCache.fetchedAt = now;
    }

    return res.json({ success: true, data: _pairsCache[market] });
  } catch (err) {
    console.error('[SignalController] getAvailablePairs error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch pairs' });
  }
};

// ─── GET /api/signals?type=spot|futures ──────────────────────────────────────

export const getSignals = async (req, res) => {
  try {
    const marketType = req.query.type === 'futures' ? 'futures' : 'spot';
    let signals      = await hybridEngine.getSignals(marketType);
    let fromDB       = false;

    if (signals.length > 0) {
      // Persist fresh HybridEngine signals to DB (upsert — keyed on pair+type+hour
      // so the same signal isn't inserted twice within the same hour).
      const hourBucket = new Date();
      hourBucket.setMinutes(0, 0, 0);

      await Promise.all(signals.map(s =>
        SignalModel.updateOne(
          { pair: s.pair, type: s.type, marketType, timestamp: { $gte: hourBucket } },
          {
            $setOnInsert: {
              pair:            s.pair,
              type:            s.type,
              entry:           s.entry,
              stopLoss:        s.stopLoss,
              takeProfit:      s.takeProfit,
              riskReward:      s.riskReward,
              atr:             s.atr,
              marketType,
              exchange:        s.exchange   || 'binance',
              timeframe:       s.timeframe  || '1h',
              confidenceScore: s.confidenceScore,
              aiProb:          s.aiProb     || null,
              aiSource:        s.aiSource   || 'rule-based',
              reasons:         s.reasons    || [],
              mtfAlignment:    s.mtfAlignment ?? null,
              timestamp:       s.timestamp  ? new Date(s.timestamp) : new Date(),
            },
          },
          { upsert: true }
        ).catch(() => {})  // fire-and-forget, never block the response
      ));
    } else {
      // In-memory cache is empty (server restart / between sweeps) →
      // fall back to the most recent DB signals so users always see something.
      signals = await SignalModel
        .find({ marketType })
        .sort({ timestamp: -1 })
        .limit(10)
        .lean();
      fromDB = true;
    }

    // ── Free-tier gating ─────────────────────────────────────────────────────
    const premium = isPremiumUser(req);
    if (!premium) {
      // Keep only signals with confidenceScore < 0.60
      signals = signals.filter(s => (s.confidenceScore ?? 1) < 0.60);
      // Limit to 2 signals
      signals = signals.slice(0, 2);
      // Mask sensitive fields
      signals = signals.map(maskSignal);
    }

    return res.json({
      success: true,
      data:    signals,
      meta: {
        marketType,
        count:      signals.length,
        timeframe:  '1h (primary)',
        aiPowered:  true,
        fromDB,
        updatedAt:  new Date().toISOString(),
        gated:      !premium,
      },
    });
  } catch (err) {
    console.error('[SignalController] getSignals error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to generate signals' });
  }
};

// ─── GET /api/signals/stats ───────────────────────────────────────────────────

export const getStats = async (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [signalStats, totalBots, activeBots, alphaSignals] = await Promise.all([
      hybridEngine.getPlatformStats(),
      BotConfig.countDocuments().catch(() => 0),
      BotConfig.countDocuments({ status: 'running' }).catch(() => 0),
      AlphaSignal.countDocuments({ discoveredAt: { $gte: todayStart } }).catch(() => 0),
    ]);

    return res.json({
      success: true,
      data: { ...signalStats, totalBots, activeBots, alphaSignals },
    });
  } catch (err) {
    console.error('[SignalController] getStats error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to get platform stats' });
  }
};

// ─── GET /api/signals/history  (auth required) ────────────────────────────────

export const getSignalHistory = async (req, res) => {
  try {
    const premium = isPremiumUser(req);

    const {
      marketType,
      type,
      pair,
      minConfidence = 0,
      sort   = 'newest',   // 'newest' | 'confidence'
      limit  = 50,
      skip   = 0,
    } = req.query;

    const filter = {};
    if (marketType) filter.marketType = marketType;
    if (type)       filter.type = type.toUpperCase();
    if (pair)       filter.pair = { $regex: pair.toUpperCase().replace('/', ''), $options: 'i' };
    if (minConfidence > 0) filter.confidenceScore = { $gte: parseFloat(minConfidence) };

    const sortOrder = sort === 'confidence'
      ? { confidenceScore: -1, timestamp: -1 }
      : { timestamp: -1 };

    const effectiveLimit = Math.min(parseInt(limit), 200);

    const [signals, total] = await Promise.all([
      SignalModel
        .find(filter)
        .sort(sortOrder)
        .skip(parseInt(skip))
        .limit(effectiveLimit)
        .lean(),
      SignalModel.countDocuments(filter),
    ]);

    // Free users: first 2 rows visible, the rest blurred (so they see there's more)
    const FREE_PREVIEW = 2;
    const result = premium
      ? signals
      : signals.map((s, i) => i < FREE_PREVIEW ? s : maskSignal(s));

    return res.json({
      success: true,
      data:    result,
      meta:    { total, limit: effectiveLimit, skip: parseInt(skip), gated: !premium, freePreview: premium ? null : FREE_PREVIEW },
    });
  } catch (err) {
    console.error('[SignalController] getSignalHistory error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch signal history' });
  }
};

// ─── POST /api/signals/analyze  (auth required) ───────────────────────────────

export const analyzeSignal = async (req, res) => {
  try {
    const { symbol = 'BTCUSDT', timeframe = '1h', marketType = 'spot' } = req.body;

    // Normalise symbol (accept BTC/USDT, BTCUSDT, btcusdt, etc.)
    const sym = symbol.toUpperCase().replace('/', '').replace('-', '');

    if (!sym.endsWith('USDT')) {
      return res.status(400).json({ success: false, message: 'Only USDT pairs are supported (e.g. BTCUSDT)' });
    }
    if (!['15m', '1h'].includes(timeframe)) {
      return res.status(400).json({ success: false, message: 'Supported timeframes: 15m, 1h' });
    }
    if (!['spot', 'futures'].includes(marketType)) {
      return res.status(400).json({ success: false, message: 'marketType must be "spot" or "futures"' });
    }

    const result = await analyzeSymbol(sym, timeframe, marketType);
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[SignalController] analyzeSignal error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Internal: fetch pairs from CCXT and save to DB ──────────────────────────

async function _fetchAndSavePairs(exchange, market) {
  const ccxtId = CCXT_ID[exchange] ?? exchange;
  const { default: ccxt } = await import('ccxt');
  if (!ccxt[ccxtId]) throw new Error(`Unknown CCXT exchange: ${ccxtId}`);

  const ex      = new ccxt[ccxtId]({ timeout: 20_000 });
  const markets = await ex.loadMarkets();
  const isSwap  = market === 'futures';

  const pairs = Object.values(markets)
    .filter(m => m.active !== false && m.quote === 'USDT' && (isSwap ? (m.swap || m.future) : m.spot))
    .map(m => m.symbol)
    .sort();

  await ExchangePairs.findOneAndUpdate(
    { exchange, market },
    { pairs, updatedAt: new Date() },
    { upsert: true, new: true }
  );
  return pairs;
}

// ─── Exported utility: refresh stale exchanges (called on startup + cron) ────
// Runs entirely in the background — never throws, never blocks the caller.

export async function refreshStaleExchangePairs() {
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);

  for (const exchange of PRELOAD_EXCHANGES) {
    for (const market of PRELOAD_MARKETS) {
      try {
        const existing = await ExchangePairs.findOne({ exchange, market }).select('updatedAt').lean();
        if (existing && existing.updatedAt > cutoff) continue; // still fresh

        const pairs = await _fetchAndSavePairs(exchange, market);
        console.log(`[ExchangePairs] Refreshed ${exchange}/${market}: ${pairs.length} pairs`);
      } catch (err) {
        // Non-fatal — some exchanges may not support futures; log and continue.
        console.warn(`[ExchangePairs] Could not refresh ${exchange}/${market}: ${err.message}`);
      }
    }
  }
}

// ─── GET /api/signals/exchange-pairs  (public) ────────────────────────────────
// ?exchange=okx&market=spot|futures — served from DB (instant after first load)

export const getExchangePairs = async (req, res) => {
  const { exchange, market = 'spot' } = req.query;

  if (!exchange) {
    return res.status(400).json({ success: false, message: 'exchange param is required' });
  }

  try {
    const doc = await ExchangePairs.findOne({ exchange, market }).select('pairs').lean();
    if (doc?.pairs?.length) {
      return res.json({ success: true, data: doc.pairs });
    }

    // DB miss (first run before startup refresh completes) — fetch live and save
    const pairs = await _fetchAndSavePairs(exchange, market);
    return res.json({ success: true, data: pairs });
  } catch (err) {
    console.error(`[SignalController] getExchangePairs ${exchange}:`, err.message);
    return res.status(500).json({ success: false, message: `Failed to load pairs for ${exchange}` });
  }
};

// ─── GET /api/signals/all-exchange-pairs  (public) ────────────────────────────
// Returns all exchanges' pairs in one response so the frontend can preload into
// Redux global state: { okx: { spot: [...], futures: [...] }, kucoin: {...}, … }

export const getAllExchangePairs = async (req, res) => {
  try {
    const docs = await ExchangePairs.find({}).select('exchange market pairs').lean();

    const map = {};
    for (const doc of docs) {
      if (!map[doc.exchange]) map[doc.exchange] = {};
      map[doc.exchange][doc.market] = doc.pairs;
    }

    return res.json({ success: true, data: map });
  } catch (err) {
    console.error('[SignalController] getAllExchangePairs error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load exchange pairs' });
  }
};

// ─── POST /api/signals/backtest  (auth required) ──────────────────────────────

export const runBacktest = async (req, res) => {
  try {
    const {
      symbol         = 'BTCUSDT',
      marketType     = 'spot',
      timeframe      = '1h',
      initialCapital = 10_000,
      riskPerTrade   = 0.02,
    } = req.body;

    // Basic input validation
    if (!['spot', 'futures'].includes(marketType)) {
      return res.status(400).json({ success: false, message: 'Invalid marketType' });
    }
    if (!['1m', '5m', '15m', '1h', '4h'].includes(timeframe)) {
      return res.status(400).json({ success: false, message: 'Invalid timeframe' });
    }
    if (riskPerTrade < 0.001 || riskPerTrade > 0.1) {
      return res.status(400).json({ success: false, message: 'riskPerTrade must be 0.001–0.1' });
    }

    const result = await backtestEngine.runBacktest({
      symbol: symbol.toUpperCase(),
      marketType,
      timeframe,
      initialCapital: parseFloat(initialCapital),
      riskPerTrade:   parseFloat(riskPerTrade),
    });

    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[SignalController] runBacktest error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};
