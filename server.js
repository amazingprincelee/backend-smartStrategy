import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import morgan from 'morgan';
import compression from 'compression';
import cookieParser from 'cookie-parser';

// Import configurations and middleware
import connectDB from './config/database.js';
import { 
  
  helmetConfig, 
  generalLimiter, 
  securityHeaders, 
  sanitizeRequest 
} from './middleware/security.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';

// Import routes
import apiRoutes from './routes/index.js';

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

// Load environment variables
dotenv.config();

// Create Express app
const app = express();
const server = createServer(app);

// Initialize Socket.IO
const io = new Server(server, {
  cors: {
    origin: corsOptions.origin,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  path: '/socket.io/',
  transports: ['websocket', 'polling'],
  allowEIO3: true,
});

app.use(cors({
  origin: "https://smartstrategy.vercel.app"
}));


// Trust proxy (important for rate limiting and IP detection)
app.set('trust proxy', 1);

// CORS must run first — before Helmet — so preflight OPTIONS requests get the
// Access-Control-Allow-Origin header before any other middleware can interfere


// Security middleware
app.use(helmetConfig);
app.use(securityHeaders);
app.use(sanitizeRequest);

// Rate limiting
app.use(generalLimiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Compression middleware
app.use(compression());

// Logging middleware
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// Make io accessible to routes
app.set('io', io);
app.use((req, res, next) => {
  req.io = io;
  next();
});

// API routes
app.use('/api', apiRoutes);

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

// Error handling middleware (must be last)
app.use(notFound);
app.use(errorHandler);

// Initialize services and start server
const startServer = async () => {
  try {
    // Connect to database
    console.log('🔗 Connecting to database...');
    await connectDB();
    console.log('✅ Database connected successfully');

    // Email service is already initialized on import
    console.log('✅ Email service initialized');

    // Initialize Order Book-based Arbitrage Service
    console.log('🔄 Initializing Order Book Arbitrage Service...');
    initializeBackgroundScan({
      minProfitPercent: 0.1,      // Minimum 0.1% net profit
      maxSlippagePercent: 0.5,   // Maximum 0.5% slippage
      minLiquidityScore: 40,     // Minimum liquidity score
      orderBookDepth: 20,        // Analyze top 20 orders
      tradeSizesToTest: [100, 500, 1000, 2500, 5000] // USD amounts to test
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

    // Start server
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
      console.log(`\n${'='.repeat(50)}`);
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🌐 API URL: http://localhost:${PORT}/api`);
      console.log(`🔌 Socket.IO URL: http://localhost:${PORT}`);
      console.log(`🔌 Socket.IO Path: /socket.io/`);
      console.log(`📊 Arbitrage Status: http://localhost:${PORT}/api/arbitrage/status`);
      console.log(`💰 Arbitrage Opportunities: http://localhost:${PORT}/api/arbitrage/fetch-opportunity`);
      console.log(`🤖 Bot API: http://localhost:${PORT}/api/bots`);
      console.log(`🎮 Demo API: http://localhost:${PORT}/api/demo`);
      console.log(`📋 Strategies: http://localhost:${PORT}/api/strategies`);
      console.log(`🧠 Signals (spot):    http://localhost:${PORT}/api/signals?type=spot`);
      console.log(`🧠 Signals (futures): http://localhost:${PORT}/api/signals?type=futures`);
      console.log(`📈 Signal History:    http://localhost:${PORT}/api/signals/history`);
      console.log(`🔬 Backtesting:       POST http://localhost:${PORT}/api/signals/backtest`);
      console.log(`${'='.repeat(50)}\n`);
    });

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

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});

// Export for testing
export { app, server, io };

// Start the server
startServer();