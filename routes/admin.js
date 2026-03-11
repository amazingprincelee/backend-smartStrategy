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
  getAuditLogs,
  // New exports
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
import {
  authenticate,
  requireAdmin
} from '../middleware/auth.js';
import {
  validateQuery,
  validateParams,
  validateRequest,
  paginationSchema,
  adminUserUpdateSchema
} from '../utils/validation.js';

const router = express.Router();

// Rate limiting for admin endpoints
const adminLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // limit each IP to 30 requests per minute
  message: {
    success: false,
    message: 'Too many admin requests, please try again later'
  },
  standardHeaders: true,
  legacyHeaders: false
});

const adminActionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // limit each IP to 10 actions per 5 minutes
  message: {
    success: false,
    message: 'Too many admin actions, please try again later'
  },
  standardHeaders: true,
  legacyHeaders: false
});

const broadcastLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // limit each IP to 5 broadcasts per hour
  message: {
    success: false,
    message: 'Too many broadcast attempts, please try again later'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// ── Public routes (must come BEFORE the admin auth middleware) ────────────────
// Active announcement — readable by any logged-in user for the banner
router.get('/announcement/active', getActiveAnnouncement);

// All other admin routes require authentication and admin role
router.use(authenticate);
router.use(requireAdmin);

/**
 * @route   GET /api/admin/stats
 * @desc    Get platform statistics
 * @access  Private (Admin only)
 */
router.get('/stats', 
  adminLimiter,
  getPlatformStats
);

/**
 * @route   GET /api/admin/users
 * @desc    Get all users with pagination and search
 * @access  Private (Admin only)
 */
router.get('/users', 
  adminLimiter,
  validateQuery({
    ...paginationSchema.fields,
    search: {
      type: 'string',
      required: false,
      min: 1,
      max: 100
    },
    role: {
      type: 'string',
      required: false,
      oneOf: ['user', 'admin']
    },
    isEmailVerified: {
      type: 'string',
      required: false,
      oneOf: ['true', 'false']
    }
  }),
  getAllUsers
);

/**
 * @route   PUT /api/admin/users/:userId
 * @desc    Update user
 * @access  Private (Admin only)
 */
router.put('/users/:userId', 
  adminActionLimiter,
  validateParams({
    userId: {
      type: 'string',
      required: true,
      matches: /^[0-9a-fA-F]{24}$/,
      message: 'Invalid user ID'
    }
  }),
  validateRequest(adminUserUpdateSchema),
  updateUser
);

/**
 * @route   DELETE /api/admin/users/:userId
 * @desc    Delete user
 * @access  Private (Admin only)
 */
router.delete('/users/:userId', 
  adminActionLimiter,
  validateParams({
    userId: {
      type: 'string',
      required: true,
      matches: /^[0-9a-fA-F]{24}$/,
      message: 'Invalid user ID'
    }
  }),
  deleteUser
);

/**
 * @route   POST /api/admin/broadcast/notification
 * @desc    Send broadcast notification to all users
 * @access  Private (Admin only)
 */
router.post('/broadcast/notification', 
  broadcastLimiter,
  validateRequest({
    title: {
      type: 'string',
      required: true,
      min: 1,
      max: 200
    },
    message: {
      type: 'string',
      required: true,
      min: 1,
      max: 1000
    },
    type: {
      type: 'string',
      required: false,
      oneOf: [
        'vault_created',
        'deposit_confirmed',
        'withdrawal_confirmed',
        'vault_matured',
        'vault_unlocked',
        'platform_fee_updated',
        'system_maintenance',
        'security_alert',
        'announcement'
      ],
      default: 'announcement'
    },
    priority: {
      type: 'string',
      required: false,
      oneOf: ['low', 'medium', 'high'],
      default: 'medium'
    }
  }),
  sendBroadcastNotification
);

/**
 * @route   POST /api/admin/broadcast/email
 * @desc    Send broadcast email to all users
 * @access  Private (Admin only)
 */
router.post('/broadcast/email', 
  broadcastLimiter,
  validateRequest({
    subject: {
      type: 'string',
      required: true,
      min: 1,
      max: 200
    },
    htmlContent: {
      type: 'string',
      required: false,
      min: 1,
      max: 10000
    },
    textContent: {
      type: 'string',
      required: false,
      min: 1,
      max: 10000
    }
  }),
  sendBroadcastEmail
);

/**
 * @route   GET /api/admin/health
 * @desc    Get system health status
 * @access  Private (Admin only)
 */
router.get('/health', 
  adminLimiter,
  getSystemHealth
);

/**
 * @route   GET /api/admin/audit-logs
 * @desc    Get audit logs
 * @access  Private (Admin only)
 */
router.get('/audit-logs', 
  adminLimiter,
  validateQuery({
    ...paginationSchema.fields,
    action: {
      type: 'string',
      required: false,
      min: 1,
      max: 50
    },
    userId: {
      type: 'string',
      required: false,
      matches: /^[0-9a-fA-F]{24}$/,
      message: 'Invalid user ID'
    },
    startDate: {
      type: 'string',
      required: false,
      matches: /^\d{4}-\d{2}-\d{2}$/,
      message: 'Invalid date format (YYYY-MM-DD)'
    },
    endDate: {
      type: 'string',
      required: false,
      matches: /^\d{4}-\d{2}-\d{2}$/,
      message: 'Invalid date format (YYYY-MM-DD)'
    }
  }),
  getAuditLogs
);

// ── Payment provider + AppSettings ───────────────────────────────────────────

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
    ];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    const doc = await AppSettings.findOneAndUpdate(
      { key: 'global' },
      { $set: update },
      { new: true, upsert: true }
    );
    res.json({ success: true, data: doc });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Subscription history ──────────────────────────────────────────────────────

router.get('/subscriptions', adminLimiter, async (req, res) => {
  try {
    const { limit = 50, skip = 0, status, provider } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (provider) filter.provider = provider;

    const [subs, total] = await Promise.all([
      Subscription.find(filter)
        .sort({ createdAt: -1 })
        .skip(parseInt(skip))
        .limit(Math.min(parseInt(limit), 200))
        .lean(),
      Subscription.countDocuments(filter),
    ]);
    res.json({ success: true, data: subs, meta: { total, limit: parseInt(limit), skip: parseInt(skip) } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Manual premium activation ────────────────────────────────────────────────
router.post('/activate-premium', adminActionLimiter, adminActivatePremium);

// ── Free trial grant ──────────────────────────────────────────────────────────
router.post('/grant-trial', adminActionLimiter, grantFreeTrial);

// ── Analytics ─────────────────────────────────────────────────────────────────
router.get('/analytics/revenue',  adminLimiter, getRevenueAnalytics);
router.get('/analytics/users',    adminLimiter, getUserAnalytics);
router.get('/analytics/platform', adminLimiter, getPlatformAnalytics);

// ── Real audit log ─────────────────────────────────────────────────────────────
router.get('/audit', adminLimiter, getRealAuditLogs);

// ── Targeted email campaign ────────────────────────────────────────────────────
router.post('/broadcast/targeted-email', broadcastLimiter, sendTargetedEmail);

// ── Announcement banner ────────────────────────────────────────────────────────
router.put('/announcement', adminActionLimiter, updateAnnouncement);

export default router;