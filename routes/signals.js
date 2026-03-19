/**
 * signals.js — API routes for the hybrid signal engine
 *
 * Public:
 *   GET  /api/signals          — current signals (spot or futures)
 *   GET  /api/signals/stats    — platform-level stats
 *
 * Protected (requires auth):
 *   GET  /api/signals/history  — recent persisted signals from DB
 *   POST /api/signals/backtest — run a backtest for a symbol
 *
 * WebSocket rooms (join from client):
 *   socket.emit('join-signals', { tier: 'premium'|'free' })
 *   → server adds socket to 'signals:premium' or 'signals:free' room
 */

import express from 'express';
import { authenticate as protect, optionalAuth, requirePremium } from '../middleware/auth.js';
import {
  getSignals,
  getStats,
  getSignalHistory,
  runBacktest,
  analyzeSignal,
  getAvailablePairs,
  getExchangePairs,
  getAllExchangePairs,
} from '../controllers/signalController.js';

const router = express.Router();

// ── Public endpoints (optional auth for gating) ────────────────────────────────
router.get('/',       optionalAuth, getSignals);   // ?type=spot|futures  — gated for free users
router.get('/stats',  getStats);
router.get('/pairs',              getAvailablePairs);
router.get('/exchange-pairs',     getExchangePairs);
router.get('/all-exchange-pairs', getAllExchangePairs);

// ── Authenticated endpoints ────────────────────────────────────────────────────
router.get('/history',    protect, getSignalHistory);          // gated in controller
router.post('/backtest',  protect, requirePremium, runBacktest);  // premium only
router.post('/analyze',   protect, analyzeSignal); // free: 3 signal results/day (frontend-counted); premium: unlimited

export default router;
