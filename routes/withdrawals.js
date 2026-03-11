import express from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import {
  requestWithdrawal,
  getUserWithdrawals,
  adminGetAllWithdrawals,
  adminApproveWithdrawal,
  adminRejectWithdrawal,
  adminMarkPaid,
} from '../controllers/withdrawalController.js';

const router = express.Router();

// ── User routes ───────────────────────────────────────────────────────────────
router.post('/',   authenticate, requestWithdrawal);
router.get('/',    authenticate, getUserWithdrawals);

// ── Admin routes ──────────────────────────────────────────────────────────────
router.get('/admin/all',             authenticate, requireAdmin, adminGetAllWithdrawals);
router.post('/admin/:id/approve',    authenticate, requireAdmin, adminApproveWithdrawal);
router.post('/admin/:id/reject',     authenticate, requireAdmin, adminRejectWithdrawal);
router.post('/admin/:id/mark-paid',  authenticate, requireAdmin, adminMarkPaid);

export default router;
