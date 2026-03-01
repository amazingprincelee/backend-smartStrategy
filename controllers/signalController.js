/**
 * signalController.js
 * Handles all signal-related API requests.
 * Delegates to HybridSignalEngine (AI + rules + multi-TF pipeline).
 */

import hybridEngine      from '../services/HybridSignalEngine.js';
import backtestEngine   from '../backtesting/BacktestEngine.js';
import SignalModel       from '../models/Signal.js';
import BotConfig         from '../models/bot/BotConfig.js';
import { analyzeSymbol } from '../services/TechnicalAnalysisEngine.js';

// ─── Pair list cache (refreshed every 60 min) ────────────────────────────────
let _pairsCache = { spot: [], futures: [], fetchedAt: 0 };
const PAIRS_TTL = 60 * 60 * 1000; // 1 hour

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
    const [signalStats, totalBots, activeBots] = await Promise.all([
      hybridEngine.getPlatformStats(),
      BotConfig.countDocuments().catch(() => 0),
      BotConfig.countDocuments({ status: 'running' }).catch(() => 0),
    ]);

    return res.json({
      success: true,
      data: { ...signalStats, totalBots, activeBots },
    });
  } catch (err) {
    console.error('[SignalController] getStats error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to get platform stats' });
  }
};

// ─── GET /api/signals/history  (auth required) ────────────────────────────────

export const getSignalHistory = async (req, res) => {
  try {
    const {
      marketType,
      type,
      minConfidence = 0,
      limit  = 50,
      skip   = 0,
    } = req.query;

    const filter = {};
    if (marketType) filter.marketType = marketType;
    if (type)       filter.type = type.toUpperCase();
    if (minConfidence > 0) filter.confidenceScore = { $gte: parseFloat(minConfidence) };

    const [signals, total] = await Promise.all([
      SignalModel
        .find(filter)
        .sort({ timestamp: -1 })
        .skip(parseInt(skip))
        .limit(Math.min(parseInt(limit), 200))
        .lean(),
      SignalModel.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data:    signals,
      meta:    { total, limit: parseInt(limit), skip: parseInt(skip) },
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
