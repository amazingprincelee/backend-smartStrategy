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

// ─── GET /api/signals?type=spot|futures ──────────────────────────────────────

export const getSignals = async (req, res) => {
  try {
    const marketType = req.query.type === 'futures' ? 'futures' : 'spot';
    const signals    = await hybridEngine.getSignals(marketType);

    return res.json({
      success: true,
      data:    signals,
      meta: {
        marketType,
        count:      signals.length,
        timeframe:  '1h (primary)',
        aiPowered:  true,
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
