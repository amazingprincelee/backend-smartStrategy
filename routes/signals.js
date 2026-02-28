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
import { authenticate as protect } from '../middleware/auth.js';
import {
  getSignals,
  getStats,
  getSignalHistory,
  runBacktest,
  analyzeSignal,
} from '../controllers/signalController.js';

const router = express.Router();

// ── Public endpoints ───────────────────────────────────────────────────────────
router.get('/',       getSignals);   // ?type=spot|futures
router.get('/stats',  getStats);

// ── Authenticated endpoints ────────────────────────────────────────────────────
router.get('/history',    protect, getSignalHistory);
router.post('/backtest',  protect, runBacktest);
router.post('/analyze',   protect, analyzeSignal);

export default router;
