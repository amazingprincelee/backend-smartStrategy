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
import SignalModel from './models/Signal.js';

// Load environment variables
dotenv.config();

// Create Express app
const app = express();
const server = createServer(app);

const clientCors = {
  origin: 'https://smartstrategy.vercel.app',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// CORS
app.use(cors(clientCors));

// Initialize Socket.IO
const io = new Server(server, {
  cors: clientCors,
});




// Rate limiting
app.use(generalLimiter);

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
      minProfitPercent: 0.05,
      minTradeAmountUSD: 25,
      maxSlippagePercent: 0.8,
      minLiquidityScore: 10,
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

    // Pause any bots using geo-blocked exchanges before trying to resume them
    const GEO_BLOCKED = ['bybit', 'binance'];
    try {
      const blockedBots = await BotConfig.find({
        exchange: { $in: GEO_BLOCKED },
        status: { $in: ['running', 'error'] }
      });
      for (const bot of blockedBots) {
        await BotConfig.findByIdAndUpdate(bot._id, {
          status: 'paused',
          statusMessage: `Exchange "${bot.exchange}" is geo-blocked in this region. Switch to OKX, KuCoin, Bitget, Gate.io, or MEXC.`
        });
        console.warn(`   ⚠️  Bot "${bot.name}" paused — ${bot.exchange} is geo-blocked`);
      }
      if (blockedBots.length > 0) {
        console.log(`   ⛔ ${blockedBots.length} bot(s) paused due to geo-blocked exchange`);
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

    // Schedule Technical Analysis Engine background sweep (every 5 min)
    // Runs spot + futures in parallel so both signal tabs stay populated.
    console.log('📡 Scheduling Technical Analysis sweep (every 5 min, spot + futures)...');
    cron.schedule('*/5 * * * *', async () => {
      try {
        console.log('[TAEngine] Background sweep starting (spot + futures)...');
        const [spotSignals, futuresSignals] = await Promise.all([
          sweepTopPairs('1h', 'spot'),
          sweepTopPairs('1h', 'futures'),
        ]);
        const allSignals = [...spotSignals, ...futuresSignals];
        console.log(
          `[TAEngine] Sweep complete: ${spotSignals.length} spot + ${futuresSignals.length} futures signal(s)`
        );

        if (allSignals.length > 0 && io) {
          // Persist all sweep signals to DB
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

          // Emit each market's signals — frontend routes by signal.marketType
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
    });
    console.log('✅ Technical Analysis sweep scheduled (spot + futures)');

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