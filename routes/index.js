import express from 'express';
import authRoutes from './auth.js';
import dashboardRoutes from './dashboard.js';
import notificationRoutes from './notifications.js';
import adminRoutes from './admin.js';
import userRoutes from './user.js';
import arbitrageRoutes from './arbitrage.js';
import exchangeRoutes from './exchange.js';
import settingsRoutes from './settings.js';
import botRoutes from './bot.js';
import exchangeAccountRoutes from './exchangeAccounts.js';
import demoRoutes from './demo.js';
import strategyRoutes from './strategies.js';
import signalRoutes from './signals.js';

const router = express.Router();

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'SmartStrategy API is running',
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  });
});

// API routes
router.use('/auth', authRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/notifications', notificationRoutes);
router.use('/admin', adminRoutes);
router.use('/user', userRoutes);
router.use('/arbitrage', arbitrageRoutes);
router.use('/exchanges', exchangeRoutes);
router.use('/settings', settingsRoutes);
router.use('/bots', botRoutes);
router.use('/exchange-accounts', exchangeAccountRoutes);
router.use('/demo', demoRoutes);
router.use('/strategies', strategyRoutes);
router.use('/signals', signalRoutes);



export default router;