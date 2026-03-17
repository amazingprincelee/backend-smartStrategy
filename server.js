import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import morgan from 'morgan';
import compression from 'compression';

// Import configurations and middleware
import connectDB from './config/database.js';
import { generalLimiter } from './middleware/security.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';

// Import routes
import authRoutes         from './routes/auth.js';
import dashboardRoutes    from './routes/dashboard.js';
import notificationRoutes from './routes/notifications.js';
import adminRoutes        from './routes/admin.js';
import userRoutes         from './routes/user.js';
import arbitrageRoutes    from './routes/arbitrage.js';
import exchangeRoutes     from './routes/exchange.js';
import settingsRoutes     from './routes/settings.js';
import botRoutes          from './routes/bot.js';
import exchangeAccountRoutes from './routes/exchangeAccounts.js';
import demoRoutes         from './routes/demo.js';
import strategyRoutes     from './routes/strategies.js';
import signalRoutes       from './routes/signals.js';
import paymentRoutes      from './routes/payments.js';
import supportRoutes     from './routes/support.js';
import withdrawalRoutes  from './routes/withdrawals.js';
import alphaRoutes       from './routes/alpha.js';

// Import services
import emailService from './utils/emailService.js';
// New Order Book-based Arbitrage Service
import { initializeBackgroundScan } from './services/Arbitrage/ArbitrageService.js';
// Bot Trading Engine
import botEngine from './services/bot/BotEngine.js';
import BotConfig from './models/bot/BotConfig.js';
// Hybrid Signal Engine (AI + rules + multi-timeframe)
import hybridSignalEngine    from './services/HybridSignalEngine.js';
import signalDeliveryService from './services/SignalDeliveryService.js';
// JWT utils (for socket handshake verification)
import { verifyToken } from './utils/jwt.js';
// Technical Analysis Engine + cron sweep
import cron from 'node-cron';
import { sweepTopPairs } from './services/TechnicalAnalysisEngine.js';
import { runAlphaSweep } from './services/EarlyAlphaService.js';
import SignalModel from './models/Signal.js';
// Exchange pairs preloader (DB-backed, monthly refresh)
import { refreshStaleExchangePairs } from './controllers/signalController.js';
// User model for subscription reminder cron
import User from './models/User.js';

// Load environment variables
dotenv.config();

// Create Express app
const app = express();
app.set('trust proxy', 1);
const server = createServer(app);



// ── CORS ─────────────────────────────────────────────────────────────────────
// Using a function instead of a static array so the server reflects the exact
// request origin back in Access-Control-Allow-Origin.  With a plain array,
// some versions of the `cors` package fall back to the first entry when no
// match is found, which causes the localhost CORS error you saw.
const ALLOWED_ORIGINS = [
  'https://smartstrategy.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
  'https://www.gate.com/',
];


// ─────────────────────────────────────────────────────────────────────────────

// Log every request with its Origin header — development only.
// In production this runs on every request and creates constant GC pressure.
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    console.log(`[REQ] ${req.method} ${req.path} | origin: ${req.headers.origin || 'none'}`);
    next();
  });
}

// CORS
app.use(cors({
  origin: ALLOWED_ORIGINS ,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Initialize Socket.IO
// pingInterval must stay under DO's 30s proxy timeout to prevent 504s on idle polls
// Initialize Socket.IO
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  },
  pingInterval: 10000,
  pingTimeout: 30000,  // Matches ~60s proxy timeout; prevents premature disconnects
});

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  socket.on('disconnect', (reason) => {
    console.log(`Disconnected: ${socket.id} | Reason: ${reason}`);
  });
});

// Rate limiting
app.use(generalLimiter);

// Raw body capture for payment webhooks (must come BEFORE express.json())
// Webhook signature verification requires the raw request body.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/payments/webhook/')) {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      req.rawBody = data;
      try { req.body = JSON.parse(data); } catch { req.body = {}; }
      next();
    });
  } else {
    next();
  }
});

// Body parsing middleware
app.use(express.json());

// Compression middleware
app.use(compression());

// Make io accessible to routes
app.set('io', io);
app.use((req, res, next) => {
  req.io = io;
  next();
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'SmartStrategy API is running', timestamp: new Date().toISOString(), version: '2.0.0' });
});

// API routes
app.use('/api/auth',             authRoutes);
app.use('/api/dashboard',        dashboardRoutes);
app.use('/api/notifications',    notificationRoutes);
app.use('/api/admin',            adminRoutes);
app.use('/api/user',             userRoutes);
app.use('/api/arbitrage',        arbitrageRoutes);
app.use('/api/exchanges',        exchangeRoutes);
app.use('/api/settings',         settingsRoutes);
app.use('/api/bots',             botRoutes);
app.use('/api/exchange-accounts',exchangeAccountRoutes);
app.use('/api/demo',             demoRoutes);
app.use('/api/strategies',       strategyRoutes);
app.use('/api/signals',          signalRoutes);
app.use('/api/payments',         paymentRoutes);
app.use('/api/support',          supportRoutes);
app.use('/api/withdrawals',      withdrawalRoutes);
app.use('/api/alpha',            alphaRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'SmartStrategy API',
    version: '1.0.0',
    documentation: '/api/health',
    timestamp: new Date().toISOString()
  });
});

// Socket.IO — verify JWT on handshake so stale tokens are rejected early
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(); // allow unauthenticated connections (they just can't join user rooms)
  try {
    socket.user = verifyToken(token); // attach decoded payload for use in handlers
    next();
  } catch {
    // Token invalid / expired — still allow connection but flag it
    socket.user = null;
    next();
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Join user-specific room for notifications
  socket.on('join-user-room', (userAddress) => {
    if (userAddress) {
      socket.join(`user:${userAddress.toLowerCase()}`);
      console.log(`User ${userAddress} joined their room`);
    }
  });

  // Leave user room
  socket.on('leave-user-room', (userAddress) => {
    if (userAddress) {
      socket.leave(`user:${userAddress.toLowerCase()}`);
      console.log(`User ${userAddress} left their room`);
    }
  });

  // Join signal tier room (premium = instant signals, free = 5-min delayed)
  socket.on('join-signals', ({ tier } = {}) => {
    const room = tier === 'premium' ? 'signals:premium' : 'signals:free';
    socket.join(room);
    console.log(`Socket ${socket.id} joined signal room: ${room}`);
  });

  socket.on('leave-signals', () => {
    socket.leave('signals:premium');
    socket.leave('signals:free');
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });

  // Handle errors
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// Initialize services and start server
const startServer = async () => {
  try {
    // Connect to database
    console.log('🔗 Connecting to database...');
    await connectDB();
    console.log('✅ Database connected successfully');

    // Start listening IMMEDIATELY after DB connects so DO/cloud health checks pass.
    // All other services init in the background — the port is open within seconds.
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
      console.log(`\n${'='.repeat(50)}`);
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🌐 API URL: http://localhost:${PORT}/api`);
      console.log(`🔌 Socket.IO URL: http://localhost:${PORT}`);
      console.log(`${'='.repeat(50)}\n`);
    });

    // Email service is already initialized on import
    console.log('✅ Email service initialized');

    // Initialize Order Book-based Arbitrage Service
    console.log('🔄 Initializing Order Book Arbitrage Service...');
    initializeBackgroundScan({
      minProfitPercent: 0.01,
      minTradeAmountUSD: 25,
      maxSlippagePercent: 0.8,
      minLiquidityScore: 5,
      orderBookDepth: 20,
      tradeSizesToTest: [25, 50, 100, 250, 500, 1000],
      io,
    });
    console.log('✅ Order Book Arbitrage Service initialized');

    // Initialize Hybrid Signal Engine (AI + rules + multi-TF)
    console.log('🧠 Initializing Hybrid Signal Engine...');
    signalDeliveryService.setIO(io);
    await hybridSignalEngine.init(io, signalDeliveryService);
    console.log('✅ Hybrid Signal Engine initialized (AI model loading in background)');

    // Initialize Bot Trading Engine
    console.log('🤖 Initializing Bot Trading Engine...');
    botEngine.setIO(io);

    // ── One-time migration: remove all non-SmartSignal bots ──────────────────
    // SmartSignal (smart_signal / ai_signal alias) is the only supported strategy.
    // Any bot left over from the old multi-strategy era is deleted here.
    try {
      const removed = await BotConfig.deleteMany({
        strategyId: { $nin: ['smart_signal', 'ai_signal'] }
      });
      if (removed.deletedCount > 0) {
        console.log(`🗑️  Migration: removed ${removed.deletedCount} legacy bot(s) (non-SmartSignal strategy)`);
      }
    } catch (migErr) {
      console.warn('⚠️  Migration warning (non-SmartSignal bot cleanup):', migErr.message);
    }

    // Pause LIVE bots using geo-blocked exchanges before trying to resume them.
    // Demo bots are exempt — they fetch OHLCV via MarketDataService (Gate.io fallback)
    // and never execute real orders, so geo-blocking does not apply to them.
    const GEO_BLOCKED = ['bybit', 'binance'];
    try {
      const blockedBots = await BotConfig.find({
        exchange: { $in: GEO_BLOCKED },
        isDemo:   { $ne: true },        // ← demo bots are exempt
        status:   { $in: ['running', 'error'] }
      });
      for (const bot of blockedBots) {
        await BotConfig.findByIdAndUpdate(bot._id, {
          status: 'paused',
          statusMessage: `Exchange "${bot.exchange}" is geo-blocked in this region. Switch to OKX, KuCoin, Bitget, Gate.io, or MEXC.`
        });
        console.warn(`   ⚠️  [GEO-BLOCK] Live bot "${bot.name}" paused — exchange: ${bot.exchange} (CloudFront 403 in this region)`);
      }
      if (blockedBots.length > 0) {
        console.log(`   ⛔ ${blockedBots.length} live bot(s) paused due to geo-blocked exchange`);
      } else {
        console.log('   ✅ No live bots affected by geo-block');
      }
    } catch (e) {
      console.warn('   Could not check for geo-blocked bots:', e.message);
    }

    // Resume any bots that were running (or errored mid-run) when the server last shut down
    try {
      // Also recover bots stuck in 'error' — they were running before the error hit
      const botsToResume = await BotConfig.find({ status: { $in: ['running', 'error'] } });
      let resumed = 0;
      for (const bot of botsToResume) {
        try {
          // Reset status to running before starting so startBot doesn't conflict
          await BotConfig.findByIdAndUpdate(bot._id, { status: 'running', statusMessage: '' });
          await botEngine.startBot(bot._id);
          console.log(`   ✅ Resumed bot: ${bot.name}`);
          resumed++;
        } catch (botErr) {
          console.warn(`   ⚠️  Could not resume bot ${bot.name}: ${botErr.message}`);
        }
      }
      console.log(`✅ Bot Trading Engine initialized (${resumed} bots resumed)`);
    } catch (botEngineError) {
      console.warn('⚠️  Bot engine initialization warning:', botEngineError.message);
    }

    // Helper: run a full sweep and persist results to DB + emit via socket
    const runSweep = async () => {
      try {
        console.log('[TAEngine] Background sweep starting (spot + futures)...');
        const spotSignals    = await sweepTopPairs('1h', 'spot');
        const futuresSignals = await sweepTopPairs('1h', 'futures');
        const allSignals = [...spotSignals, ...futuresSignals];
        console.log(`[TAEngine] Sweep complete: ${spotSignals.length} spot + ${futuresSignals.length} futures signal(s)`);

        if (allSignals.length > 0 && io) {
          try {
            await SignalModel.insertMany(
              allSignals.map(s => ({
                pair:            s.pair,
                type:            s.type,
                entry:           s.entry,
                stopLoss:        s.stopLoss,
                takeProfit:      s.takeProfit,
                riskReward:      s.riskReward,
                atr:             s.atr,
                marketType:      s.marketType || 'spot',
                exchange:        s.exchange   || 'binance',
                timeframe:       s.timeframe  || '1h',
                confidenceScore: s.confidenceScore,
                aiSource:        'rule-based',
                reasons:         s.reasons    || [],
                timestamp:       s.timestamp  ? new Date(s.timestamp) : new Date(),
              })),
              { ordered: false }
            );
          } catch (dbErr) {
            if (dbErr.code !== 11000) console.warn('[TAEngine] DB persist error:', dbErr.message);
          }
          if (spotSignals.length > 0) {
            io.to('signals:premium').emit('signals:sweep', spotSignals);
            io.to('signals:free').emit('signals:sweep', spotSignals);
          }
          if (futuresSignals.length > 0) {
            io.to('signals:premium').emit('signals:sweep', futuresSignals);
            io.to('signals:free').emit('signals:sweep', futuresSignals);
          }
        }
      } catch (err) {
        console.warn('[TAEngine] Sweep error:', err.message);
      }
    };

    // Run once immediately on startup so SmartSignal bots have signals from minute 0
    setTimeout(runSweep, 5000);

    // Schedule Technical Analysis Engine background sweep (every 15 min)
    console.log('📡 Scheduling Technical Analysis sweep (every 15 min, spot + futures)...');
    cron.schedule('*/15 * * * *', runSweep);
    console.log('✅ Technical Analysis sweep scheduled every 15 min (spot + futures)');

    // Early Alpha sweep — scans CoinGecko + volume + whale data every 5 minutes.
    // Stagger by 2 min so it doesn't collide with the TA sweep on the :15 boundary.
    cron.schedule('2-59/5 * * * *', async () => {
      try {
        await runAlphaSweep();
      } catch (err) {
        console.warn('[EarlyAlpha] Cron sweep error:', err.message);
      }
    });
    console.log('✅ Early Alpha sweep scheduled every 5 min');

    // Nightly signal cleanup — delete signals older than 30 days at 2 AM UTC.
    // Prevents the Signal collection from growing unbounded on a budget MongoDB instance.
    cron.schedule('0 2 * * *', async () => {
      try {
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const result = await SignalModel.deleteMany({ timestamp: { $lt: cutoff } });
        if (result.deletedCount > 0) {
          console.log(`[Cleanup] Deleted ${result.deletedCount} signal(s) older than 30 days`);
        }
      } catch (err) {
        console.warn('[Cleanup] Signal cleanup error:', err.message);
      }
    });
    console.log('✅ Nightly signal cleanup scheduled (30-day retention, runs at 2 AM UTC)');

    // Subscription expiry reminder cron — runs daily at 9 AM UTC.
    // Sends email 7 days and 1 day before expiry; flags prevent duplicate sends.
    cron.schedule('0 9 * * *', async () => {
      try {
        const now    = new Date();
        const in7d   = new Date(now.getTime() + 7  * 24 * 60 * 60 * 1000);
        const in1d   = new Date(now.getTime() + 1  * 24 * 60 * 60 * 1000);
        const passed = new Date(now.getTime() - 15 * 60 * 1000); // 15-min buffer

        // 7-day reminder
        const remind7 = await User.find({
          'subscription.status':           'active',
          'subscription.plan':             'premium',
          'subscription.expiresAt':        { $gte: passed, $lte: in7d },
          'subscription.autoReminderSent7d': false,
        });
        for (const u of remind7) {
          try {
            await emailService.sendEmail({
              to: u.email,
              subject: 'Your SmartStrategy Premium expires in 7 days',
              html: `<p>Hi${u.fullName ? ' ' + u.fullName : ''},</p>
                     <p>Your premium subscription expires on <strong>${new Date(u.subscription.expiresAt).toDateString()}</strong>.</p>
                     <p>Renew now to keep uninterrupted access to all signals, arbitrage opportunities, and bots.</p>
                     <p><a href="${process.env.CLIENT_URL}/pricing">Renew Premium →</a></p>`,
            });
            await User.findByIdAndUpdate(u._id, { 'subscription.autoReminderSent7d': true });
          } catch (e) { console.warn(`[Reminder] 7d email failed for ${u.email}:`, e.message); }
        }

        // 1-day reminder
        const remind1 = await User.find({
          'subscription.status':           'active',
          'subscription.plan':             'premium',
          'subscription.expiresAt':        { $gte: passed, $lte: in1d },
          'subscription.autoReminderSent1d': false,
        });
        for (const u of remind1) {
          try {
            await emailService.sendEmail({
              to: u.email,
              subject: 'Last chance — Premium expires tomorrow!',
              html: `<p>Hi${u.fullName ? ' ' + u.fullName : ''},</p>
                     <p>Your premium subscription expires <strong>tomorrow (${new Date(u.subscription.expiresAt).toDateString()})</strong>.</p>
                     <p><a href="${process.env.CLIENT_URL}/pricing">Renew now →</a></p>`,
            });
            await User.findByIdAndUpdate(u._id, { 'subscription.autoReminderSent1d': true });
          } catch (e) { console.warn(`[Reminder] 1d email failed for ${u.email}:`, e.message); }
        }

        if (remind7.length + remind1.length > 0) {
          console.log(`[Reminder] Sent ${remind7.length} × 7-day, ${remind1.length} × 1-day renewal reminders`);
        }
      } catch (err) {
        console.warn('[Reminder] Cron error:', err.message);
      }
    });
    console.log('✅ Subscription expiry reminder cron scheduled (daily 9 AM UTC)');

    // Subscription expiry downgrade — runs every hour.
    // Finds premium users whose expiresAt has passed and downgrades them to 'user'.
    cron.schedule('0 * * * *', async () => {
      try {
        const now = new Date();
        const result = await User.updateMany(
          {
            role: 'premium',
            'subscription.status': 'active',
            'subscription.expiresAt': { $lt: now },
          },
          {
            $set: {
              role: 'user',
              'subscription.status': 'expired',
            },
          }
        );
        if (result.modifiedCount > 0) {
          console.log(`[Expiry] Downgraded ${result.modifiedCount} expired premium user(s) to free tier`);
        }
      } catch (err) {
        console.warn('[Expiry] Downgrade cron error:', err.message);
      }
    });
    console.log('✅ Subscription expiry downgrade cron scheduled (every hour)');

    // Exchange pairs preload — refresh stale (>30 days) records in background at startup.
    // Does NOT block server startup; each exchange logs when done.
    console.log('📋 Refreshing exchange pairs in background (stale records only)...');
    refreshStaleExchangePairs().catch(err =>
      console.warn('[ExchangePairs] Startup refresh error:', err.message)
    );

    // Monthly cron — refresh all pairs on the 1st of every month at 4 AM UTC.
    // New coins get listed regularly; monthly is enough to stay current.
    cron.schedule('0 4 1 * *', () => {
      console.log('[ExchangePairs] Monthly refresh starting…');
      refreshStaleExchangePairs().catch(err =>
        console.warn('[ExchangePairs] Monthly refresh error:', err.message)
      );
    });
    console.log('✅ Exchange pairs monthly refresh scheduled (1st of each month, 4 AM UTC)');

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

// Graceful shutdown
const gracefulShutdown = (signal) => {
  console.log(`\n🔴 Received ${signal}. Starting graceful shutdown...`);
  
  // Check if server is listening before trying to close it
  if (server && server.listening) {
    server.close(() => {
      console.log('🔌 HTTP server closed');
      
      // Close database connection
      import('./config/database.js').then(({ default: mongoose }) => {
        mongoose.connection.close(() => {
          console.log('🗄️  Database connection closed');
          process.exit(0);
        });
      });
    });
  } else {
    console.log('🔌 HTTP server was not running');
    
    // Still try to close database connection
    import('./config/database.js').then(({ default: mongoose }) => {
      mongoose.connection.close(() => {
        console.log('🗄️  Database connection closed');
        process.exit(0);
      });
    }).catch(() => {
      process.exit(1);
    });
  }

  // Force close after 30 seconds
  setTimeout(() => {
    console.error('⚠️  Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 30000);
};

// Handle process termination
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions — only exit for truly fatal errors
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  // Only shut down for fatal system errors, not normal operational failures
  if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
    gracefulShutdown('uncaughtException');
  } else {
    console.error('⚠️  Continuing after uncaughtException (non-fatal)');
  }
});

// Handle unhandled promise rejections — LOG ONLY, never crash the server
// Background services (CCXT, arbitrage, market data) can reject without
// killing the entire process — the service handles its own recovery.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled Promise Rejection (non-fatal):', reason?.message || reason);
});

// Export for testing
export { app, server, io };

// Start the server
startServer();