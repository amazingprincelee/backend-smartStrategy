import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  getPlatformStats,
  getAllUsers,
  updateUser,
  deleteUser,
  sendBroadcastNotification,
  sendBroadcastEmail,
  getSystemHealth,
  grantFreeTrial,
  getRevenueAnalytics,
  getUserAnalytics,
  getPlatformAnalytics,
  getRealAuditLogs,
  sendTargetedEmail,
  updateAnnouncement,
  getActiveAnnouncement,
} from '../controllers/adminController.js';
import { adminActivatePremium } from '../controllers/paymentController.js';
import Subscription from '../models/Subscription.js';
import AppSettings, { getSettings } from '../models/AppSettings.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { invalidatePaymentKeyCache } from '../services/payment/paymentKeys.js';

const router = express.Router();

const adminLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: { success: false, message: 'Too many admin requests, please try again later' },
  standardHeaders: true, legacyHeaders: false
});

const adminActionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many admin actions, please try again later' },
  standardHeaders: true, legacyHeaders: false
});

const broadcastLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many broadcast attempts, please try again later' },
  standardHeaders: true, legacyHeaders: false
});

// ── Public routes (BEFORE auth middleware) ───────────────────────────────────
router.get('/announcement/active', getActiveAnnouncement);

// Public plan info — returns only safe, non-sensitive fields
router.get('/public-settings', async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({
      success: true,
      data: {
        premiumPriceUSD:    settings.premiumPriceUSD,
        premiumDurationDays: settings.premiumDurationDays,
        referralRewardUSD:  settings.referralRewardUSD,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── All routes below require admin auth ───────────────────────────────────────
router.use(authenticate);
router.use(requireAdmin);

// Stats
router.get('/stats',          adminLimiter,       getPlatformStats);

// Users — no validateQuery middleware; controller handles params directly
router.get('/users',          adminLimiter,       getAllUsers);
router.put('/users/:userId',  adminActionLimiter, updateUser);
router.delete('/users/:userId', adminActionLimiter, deleteUser);

// Broadcast
router.post('/broadcast/notification',    broadcastLimiter, sendBroadcastNotification);
router.post('/broadcast/email',           broadcastLimiter, sendBroadcastEmail);
router.post('/broadcast/targeted-email',  broadcastLimiter, sendTargetedEmail);

// Health
router.get('/health', adminLimiter, getSystemHealth);

// Audit log (new real one)
router.get('/audit', adminLimiter, getRealAuditLogs);

// Settings
router.get('/settings', adminLimiter, async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ success: true, data: settings });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.put('/settings', adminActionLimiter, async (req, res) => {
  try {
    const allowed = [
      'activePaymentProvider', 'premiumPriceUSD', 'premiumDurationDays',
      'referralRewardUSD', 'freeSignalsPerDay', 'freeSignalMaxConfidence',
      'freeArbitrageLimit', 'freeArbitrageMaxProfit', 'maintenanceMode',
      'freeTrialDays', 'minWithdrawalAmount',
    ];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    const doc = await AppSettings.findOneAndUpdate(
      { key: 'global' },
      { $set: { ...update, updatedBy: req.user._id } },
      { new: true, upsert: true }
    );
    res.json({ success: true, data: doc });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Subscriptions
router.get('/subscriptions', adminLimiter, async (req, res) => {
  try {
    const limit    = Math.min(parseInt(req.query.limit) || 50, 200);
    const skip     = parseInt(req.query.skip) || 0;
    const filter   = {};
    if (req.query.status)   filter.status   = req.query.status;
    if (req.query.provider) filter.provider = req.query.provider;

    const [subs, total] = await Promise.all([
      Subscription.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Subscription.countDocuments(filter),
    ]);
    res.json({ success: true, data: subs, meta: { total, limit, skip } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Premium activation / free trial
router.post('/activate-premium', adminActionLimiter, adminActivatePremium);
router.post('/grant-trial',      adminActionLimiter, grantFreeTrial);

// Analytics
router.get('/analytics/revenue',  adminLimiter, getRevenueAnalytics);
router.get('/analytics/users',    adminLimiter, getUserAnalytics);
router.get('/analytics/platform', adminLimiter, getPlatformAnalytics);

// Payment API Keys — write-only (never returned in plain text in GET /settings)
router.get('/payment-keys/status', adminLimiter, async (req, res) => {
  try {
    const s = await getSettings();
    // Return only whether each key is configured, not the actual values
    res.json({
      success: true,
      data: {
        nowpayments:  { apiKey: !!s.nowpaymentsApiKey, ipnSecret: !!s.nowpaymentsIpnSecret },
        coinbase:     { apiKey: !!s.coinbaseApiKey, webhookSecret: !!s.coinbaseWebhookSecret },
        cryptopay:    { apiKey: !!s.cryptopayApiKey, apiSecret: !!s.cryptopayApiSecret, callbackSecret: !!s.cryptopayCallbackSecret },
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.put('/payment-keys', adminActionLimiter, async (req, res) => {
  try {
    const allowed = [
      'nowpaymentsApiKey', 'nowpaymentsIpnSecret',
      'coinbaseApiKey', 'coinbaseWebhookSecret',
      'cryptopayApiKey', 'cryptopayApiSecret', 'cryptopayCallbackSecret',
    ];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined && req.body[key] !== '') {
        update[key] = req.body[key];
      }
    }
    await AppSettings.findOneAndUpdate(
      { key: 'global' },
      { $set: { ...update, updatedBy: req.user._id } },
      { new: true, upsert: true }
    );
    invalidatePaymentKeyCache();
    res.json({ success: true, message: 'Payment keys updated successfully' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Announcement
router.put('/announcement', adminActionLimiter, updateAnnouncement);

export default router;
