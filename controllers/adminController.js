import { User, Notification } from '../models/index.js';
import emailService from '../utils/emailService.js';
import {
  adminUserUpdateSchema,
  paginationSchema
} from '../utils/validation.js';
import Subscription from '../models/Subscription.js';
import BotConfig from '../models/bot/BotConfig.js';
import Signal from '../models/Signal.js';
import AuditLog, { logAdminAction } from '../models/AuditLog.js';
import { getSettings } from '../models/AppSettings.js';
import AppSettings from '../models/AppSettings.js';

// Get platform statistics
export const getPlatformStats = async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Get user statistics
    const userStats = await User.aggregate([
      {
        $group: {
          _id: null,
          totalUsers: { $sum: 1 },
          verifiedUsers: {
            $sum: { $cond: [{ $eq: ['$isEmailVerified', true] }, 1, 0] }
          },
          adminUsers: {
            $sum: { $cond: [{ $eq: ['$role', 'admin'] }, 1, 0] }
          },
          usersWithWallets: {
            $sum: { $cond: [{ $ne: ['$walletAddress', null] }, 1, 0] }
          }
        }
      }
    ]);

    // Get notification statistics
    const notificationStats = await Notification.aggregate([
      {
        $group: {
          _id: null,
          totalNotifications: { $sum: 1 },
          unreadNotifications: {
            $sum: { $cond: [{ $eq: ['$isRead', false] }, 1, 0] }
          },
          highPriorityNotifications: {
            $sum: { $cond: [{ $eq: ['$priority', 'high'] }, 1, 0] }
          }
        }
      }
    ]);

    // Get recent activity
    const recentUsers = await User.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select('email walletAddress createdAt')
      .lean();

    const platformStats = {
      users: userStats[0] || {
        totalUsers: 0,
        verifiedUsers: 0,
        adminUsers: 0,
        usersWithWallets: 0
      },
      notifications: notificationStats[0] || {
        totalNotifications: 0,
        unreadNotifications: 0,
        highPriorityNotifications: 0
      },
      recentActivity: {
        users: recentUsers,
      },
    };

    res.json({
      success: true,
      data: { stats: platformStats }
    });

  } catch (error) {
    console.error('Get platform stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch platform statistics'
    });
  }
};

// Get all users (admin only)
export const getAllUsers = async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Validate pagination parameters
    const validatedQuery = await paginationSchema.validate(req.query, {
      abortEarly: false,
      stripUnknown: true
    });

    const { page, limit, sortBy, sortOrder } = validatedQuery;
    const { search, role, isEmailVerified } = req.query;
    const skip = (page - 1) * limit;

    // Build search query
    const searchQuery = {};

    if (search) {
      searchQuery.$or = [
        { email: { $regex: search, $options: 'i' } },
        { walletAddress: { $regex: search, $options: 'i' } },
        { 'profile.firstName': { $regex: search, $options: 'i' } },
        { 'profile.lastName': { $regex: search, $options: 'i' } }
      ];
    }

    if (role) {
      searchQuery.role = role;
    }

    if (isEmailVerified !== undefined) {
      searchQuery.isEmailVerified = isEmailVerified === 'true';
    }

    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Get users
    const users = await User.find(searchQuery)
      .select('-password -emailVerificationToken -passwordResetToken')
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean();

    // Get total count
    const totalUsers = await User.countDocuments(searchQuery);

    // Calculate pagination info
    const totalPages = Math.ceil(totalUsers / limit);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;

    res.json({
      success: true,
      data: {
        users,
        pagination: {
          currentPage: page,
          totalPages,
          totalUsers,
          hasNextPage,
          hasPrevPage,
          limit
        }
      }
    });

  } catch (error) {
    console.error('Get all users error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch users'
    });
  }
};

// Update user (admin only)
export const updateUser = async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const { userId } = req.params;

    // Validate request data
    const validatedData = await adminUserUpdateSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true
    });

    // Find user
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Prevent admin from demoting themselves
    if (user._id.toString() === req.user.id && validatedData.role && validatedData.role !== 'admin') {
      return res.status(400).json({
        success: false,
        message: 'Cannot change your own admin role'
      });
    }

    // Update user
    Object.assign(user, validatedData);
    await user.save();

    // Remove sensitive fields from response
    const userResponse = user.toObject();
    delete userResponse.password;
    delete userResponse.emailVerificationToken;
    delete userResponse.passwordResetToken;

    res.json({
      success: true,
      message: 'User updated successfully',
      data: { user: userResponse }
    });

  } catch (error) {
    console.error('Update user error:', error);
    
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => ({
        field: err.path,
        message: err.message
      }));
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to update user'
    });
  }
};

// Delete user (admin only)
export const deleteUser = async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const { userId } = req.params;

    // Find user
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Prevent admin from deleting themselves
    if (user._id.toString() === req.user.id) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete your own account'
      });
    }

    // Delete user's notifications
    await Notification.deleteMany({
      $or: [
        { userId: user._id },
        { userAddress: user.walletAddress?.toLowerCase() }
      ]
    });

    // Delete user
    await User.findByIdAndDelete(userId);

    res.json({
      success: true,
      message: 'User deleted successfully'
    });

  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete user'
    });
  }
};

// Send notification to all users (admin only)
export const sendBroadcastNotification = async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const { title, message, type = 'announcement', priority = 'medium' } = req.body;

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        message: 'Title and message are required'
      });
    }

    // Get all users
    const users = await User.find({ isEmailVerified: true }).select('_id email walletAddress');

    // Create notifications for all users
    const notifications = [];
    for (const user of users) {
      const notification = await Notification.createNotification({
        userId: user._id,
        userAddress: user.walletAddress?.toLowerCase(),
        type,
        title,
        message,
        priority
      });
      notifications.push(notification);
    }

    res.json({
      success: true,
      message: `Broadcast notification sent to ${notifications.length} users`,
      data: { 
        notificationCount: notifications.length,
        sampleNotification: notifications[0]
      }
    });

  } catch (error) {
    console.error('Send broadcast notification error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send broadcast notification'
    });
  }
};

// Send email to all users (admin only)
export const sendBroadcastEmail = async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const { subject, htmlContent, textContent } = req.body;

    if (!subject || (!htmlContent && !textContent)) {
      return res.status(400).json({
        success: false,
        message: 'Subject and content are required'
      });
    }

    // Get all verified users
    const users = await User.find({ 
      isEmailVerified: true,
      'notifications.email': true 
    }).select('email profile.firstName profile.lastName');

    let successCount = 0;
    let failureCount = 0;

    // Send emails to all users
    for (const user of users) {
      try {
        await emailService.sendEmail({
          to: user.email,
          subject,
          html: htmlContent,
          text: textContent
        });
        successCount++;
      } catch (emailError) {
        console.error(`Failed to send email to ${user.email}:`, emailError);
        failureCount++;
      }
    }

    res.json({
      success: true,
      message: `Broadcast email sent successfully`,
      data: { 
        totalUsers: users.length,
        successCount,
        failureCount
      }
    });

  } catch (error) {
    console.error('Send broadcast email error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send broadcast email'
    });
  }
};

// Get system health (admin only)
export const getSystemHealth = async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const health = {
      timestamp: new Date(),
      status: 'healthy',
      services: {}
    };

    // Check database connection
    try {
      await User.findOne().limit(1);
      health.services.database = { status: 'healthy', message: 'Connected' };
    } catch (dbError) {
      health.services.database = { status: 'unhealthy', message: dbError.message };
      health.status = 'unhealthy';
    }

    // Check email service
    try {
      await emailService.verifyConnection();
      health.services.email = { status: 'healthy', message: 'Connected' };
    } catch (emailError) {
      health.services.email = { status: 'unhealthy', message: emailError.message };
      health.status = 'degraded';
    }

    // System metrics
    health.metrics = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      nodeVersion: process.version,
      platform: process.platform
    };

    const statusCode = health.status === 'healthy' ? 200 : 
                      health.status === 'degraded' ? 200 : 503;

    res.status(statusCode).json({
      success: health.status !== 'unhealthy',
      data: { health }
    });

  } catch (error) {
    console.error('Get system health error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check system health'
    });
  }
};

// Get audit logs (admin only)
export const getAuditLogs = async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Validate pagination parameters
    const validatedQuery = await paginationSchema.validate(req.query, {
      abortEarly: false,
      stripUnknown: true
    });

    const { page, limit } = validatedQuery;
    const { action, userId, startDate, endDate } = req.query;
    const skip = (page - 1) * limit;

    // Build search query for audit logs
    // Note: This would require implementing an audit log system
    // For now, we'll return recent user activities as a placeholder

    const searchQuery = {};

    if (userId) {
      searchQuery._id = userId;
    }

    if (startDate || endDate) {
      searchQuery.createdAt = {};
      if (startDate) {
        searchQuery.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        searchQuery.createdAt.$lte = new Date(endDate);
      }
    }

    // Get recent user activities as audit logs
    const auditLogs = await User.find(searchQuery)
      .select('email walletAddress lastLogin createdAt updatedAt role')
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Get total count
    const totalLogs = await User.countDocuments(searchQuery);

    // Calculate pagination info
    const totalPages = Math.ceil(totalLogs / limit);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;

    res.json({
      success: true,
      data: {
        auditLogs,
        pagination: {
          currentPage: page,
          totalPages,
          totalLogs,
          hasNextPage,
          hasPrevPage,
          limit
        }
      }
    });

  } catch (error) {
    console.error('Get audit logs error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch audit logs'
    });
  }
};

// ── Grant free trial to a user ────────────────────────────────────────────────
export const grantFreeTrial = async (req, res) => {
  try {
    const { userId, days } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'userId is required' });

    const settings  = await getSettings();
    const trialDays = days || settings.freeTrialDays || 7;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + trialDays * 86400000);

    user.subscription.plan      = 'premium';
    user.subscription.status    = 'trial';
    user.subscription.startedAt = now;
    user.subscription.expiresAt = expiresAt;
    await user.save();

    // Notify user
    try {
      await emailService.sendEmail(
        user.email,
        `🎁 You've been granted a ${trialDays}-day free trial — SmartStrategy`,
        `<p>Hello ${user.fullName || 'there'},</p>
         <p>Great news! You have been granted a <strong>${trialDays}-day free trial</strong> of SmartStrategy Premium.</p>
         <p>Your trial expires on <strong>${expiresAt.toDateString()}</strong>.</p>
         <p>Enjoy full access to all premium features including real-time signals, arbitrage opportunities, and live trading bots.</p>
         <p><a href="${process.env.CLIENT_URL}/dashboard">Go to Dashboard →</a></p>`,
      );
    } catch (e) { /* best-effort */ }

    await logAdminAction({
      adminId: req.user.id, adminEmail: req.user.email,
      action: 'trial_granted',
      targetUserId: userId, targetEmail: user.email,
      description: `Granted ${trialDays}-day free trial. Expires: ${expiresAt.toDateString()}`,
      metadata: { trialDays, expiresAt },
      ip: req.ip,
    });

    res.json({ success: true, message: `${trialDays}-day trial granted to ${user.email}`, data: { expiresAt } });
  } catch (err) {
    console.error('[Admin] grantFreeTrial:', err.message);
    res.status(500).json({ success: false, message: 'Failed to grant trial' });
  }
};

// ── Revenue analytics ─────────────────────────────────────────────────────────
export const getRevenueAnalytics = async (req, res) => {
  try {
    const { period = '30' } = req.query;
    const days   = Math.min(365, parseInt(period) || 30);
    const cutoff = new Date(Date.now() - days * 86400000);

    const [
      totalRevenue,
      revenueByProvider,
      dailyRevenue,
      subscriptionStats,
      trialStats,
      churnStats,
    ] = await Promise.all([
      // Total revenue from completed payments
      Subscription.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amountUSD' }, count: { $sum: 1 } } },
      ]),

      // Revenue by payment provider
      Subscription.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: '$provider', total: { $sum: '$amountUSD' }, count: { $sum: 1 } } },
      ]),

      // Daily revenue for the period
      Subscription.aggregate([
        { $match: { status: 'completed', createdAt: { $gte: cutoff } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            revenue: { $sum: '$amountUSD' },
            count:   { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // Active vs expired subscriptions
      User.aggregate([
        {
          $group: {
            _id: '$subscription.status',
            count: { $sum: 1 },
          },
        },
      ]),

      // Trial users count
      User.countDocuments({ 'subscription.status': 'trial' }),

      // Churned users: subscription expired in the last `days` days
      User.countDocuments({
        'subscription.status': 'expired',
        'subscription.expiresAt': { $gte: cutoff, $lte: new Date() },
      }),
    ]);

    const mrr = (totalRevenue[0]?.total || 0) / Math.max(1, Math.ceil(days / 30));

    res.json({
      success: true,
      data: {
        totalRevenue:    totalRevenue[0]?.total || 0,
        totalPayments:   totalRevenue[0]?.count || 0,
        mrr:             parseFloat(mrr.toFixed(2)),
        byProvider:      revenueByProvider,
        dailyRevenue,
        subscriptionStats,
        trialUsers:      trialStats,
        churnedUsers:    churnStats,
      },
    });
  } catch (err) {
    console.error('[Admin] getRevenueAnalytics:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch revenue analytics' });
  }
};

// ── User engagement analytics ─────────────────────────────────────────────────
export const getUserAnalytics = async (req, res) => {
  try {
    const now = new Date();
    const day1  = new Date(now - 1 * 86400000);
    const day7  = new Date(now - 7 * 86400000);
    const day30 = new Date(now - 30 * 86400000);

    const [
      dauCount,
      wauCount,
      mauCount,
      newUsersToday,
      newUsersWeek,
      newUsersMonth,
      neverSetupBot,
      premiumInactive,
      roleBreakdown,
      signupsTrend,
    ] = await Promise.all([
      User.countDocuments({ lastLogin: { $gte: day1 } }),
      User.countDocuments({ lastLogin: { $gte: day7 } }),
      User.countDocuments({ lastLogin: { $gte: day30 } }),
      User.countDocuments({ createdAt: { $gte: day1 } }),
      User.countDocuments({ createdAt: { $gte: day7 } }),
      User.countDocuments({ createdAt: { $gte: day30 } }),
      // Users who registered but have no bots
      BotConfig.distinct('userId').then(async (usersWithBots) => {
        return User.countDocuments({ _id: { $nin: usersWithBots } });
      }),
      // Premium users inactive for 30+ days
      User.countDocuments({
        $or: [{ role: 'premium' }, { 'subscription.status': { $in: ['active', 'trial'] } }],
        lastLogin: { $lt: day30 },
      }),
      // Role distribution
      User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]),
      // Daily signups last 30 days
      User.aggregate([
        { $match: { createdAt: { $gte: day30 } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    ]);

    res.json({
      success: true,
      data: {
        activeUsers:      { dau: dauCount, wau: wauCount, mau: mauCount },
        newUsers:         { today: newUsersToday, week: newUsersWeek, month: newUsersMonth },
        neverSetupBot,
        premiumInactive,
        roleBreakdown,
        signupsTrend,
      },
    });
  } catch (err) {
    console.error('[Admin] getUserAnalytics:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch user analytics' });
  }
};

// ── Bot & signal platform analytics ──────────────────────────────────────────
export const getPlatformAnalytics = async (req, res) => {
  try {
    const [
      botStats,
      errorBots,
      signalStats,
    ] = await Promise.all([
      BotConfig.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      BotConfig.find({ status: 'error' })
        .populate('userId', 'email fullName')
        .select('name strategyId exchange tradingPair status statusMessage userId')
        .limit(20)
        .lean(),
      Signal.aggregate([
        { $group: { _id: '$type', count: { $sum: 1 }, avgConf: { $avg: '$confidenceScore' } } },
      ]),
    ]);

    res.json({
      success: true,
      data: { botStats, errorBots, signalStats },
    });
  } catch (err) {
    console.error('[Admin] getPlatformAnalytics:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch platform analytics' });
  }
};

// ── Real audit log fetch ──────────────────────────────────────────────────────
export const getRealAuditLogs = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 30);
    const skip  = (page - 1) * limit;
    const { action, adminId, startDate, endDate } = req.query;

    const filter = {};
    if (action)    filter.action  = action;
    if (adminId)   filter.adminId = adminId;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate)   filter.createdAt.$lte = new Date(endDate);
    }

    const [logs, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AuditLog.countDocuments(filter),
    ]);

    res.json({ success: true, data: logs, meta: { total, page, limit } });
  } catch (err) {
    console.error('[Admin] getRealAuditLogs:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch audit logs' });
  }
};

// ── Targeted email campaign ───────────────────────────────────────────────────
export const sendTargetedEmail = async (req, res) => {
  try {
    const { segment, subject, htmlContent } = req.body;
    if (!segment || !subject || !htmlContent) {
      return res.status(400).json({ success: false, message: 'segment, subject, and htmlContent are required' });
    }

    const day30 = new Date(Date.now() - 30 * 86400000);
    const day7  = new Date(Date.now() - 7 * 86400000);

    let filter = {};
    switch (segment) {
      case 'free_users':
        filter = { role: 'user', 'subscription.status': { $nin: ['active', 'trial'] } };
        break;
      case 'premium_users':
        filter = { $or: [{ role: 'premium' }, { 'subscription.status': 'active' }] };
        break;
      case 'trial_users':
        filter = { 'subscription.status': 'trial' };
        break;
      case 'expiring_soon':
        filter = { 'subscription.expiresAt': { $gte: new Date(), $lte: day7 } };
        break;
      case 'inactive_30d':
        filter = { lastLogin: { $lt: day30 } };
        break;
      case 'never_subscribed':
        filter = { 'subscription.plan': 'free', role: 'user', credits: { $gt: 0 } };
        break;
      case 'all':
        filter = {};
        break;
      default:
        return res.status(400).json({ success: false, message: 'Invalid segment' });
    }

    const users = await User.find(filter).select('email fullName').lean();
    let successCount = 0, failureCount = 0;

    for (const user of users) {
      try {
        await emailService.sendEmail(user.email, subject, htmlContent);
        successCount++;
      } catch { failureCount++; }
    }

    await logAdminAction({
      adminId: req.user.id, adminEmail: req.user.email,
      action: 'broadcast_email',
      description: `Targeted email to segment "${segment}": ${subject}`,
      metadata: { segment, subject, total: users.length, successCount, failureCount },
      ip: req.ip,
    });

    res.json({ success: true, data: { total: users.length, successCount, failureCount } });
  } catch (err) {
    console.error('[Admin] sendTargetedEmail:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send targeted email' });
  }
};

// ── Update announcement banner ────────────────────────────────────────────────
export const updateAnnouncement = async (req, res) => {
  try {
    const { announcementActive, announcementMessage, announcementType, announcementExpires } = req.body;
    const update = {};
    if (announcementActive  !== undefined) update.announcementActive  = announcementActive;
    if (announcementMessage !== undefined) update.announcementMessage = announcementMessage;
    if (announcementType    !== undefined) update.announcementType    = announcementType;
    if (announcementExpires !== undefined) update.announcementExpires = announcementExpires ? new Date(announcementExpires) : null;

    const doc = await AppSettings.findOneAndUpdate({ key: 'global' }, { $set: update }, { new: true, upsert: true });
    res.json({ success: true, data: doc });
  } catch (err) {
    console.error('[Admin] updateAnnouncement:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update announcement' });
  }
};

// ── Public: get active announcement ──────────────────────────────────────────
export const getActiveAnnouncement = async (req, res) => {
  try {
    const settings = await getSettings();
    const now = new Date();
    const active =
      settings.announcementActive &&
      settings.announcementMessage &&
      (!settings.announcementExpires || now < new Date(settings.announcementExpires));

    res.json({
      success: true,
      data: active ? {
        message: settings.announcementMessage,
        type:    settings.announcementType,
        expires: settings.announcementExpires,
      } : null,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch announcement' });
  }
};