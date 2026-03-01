import mongoose from 'mongoose';

const botConfigSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  exchangeAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ExchangeAccount',
    default: null
  },
  isDemo: {
    type: Boolean,
    default: false
  },
  exchange: {
    type: String,
    required: true,
    lowercase: true
  },
  symbol: {
    type: String,
    required: true,
    uppercase: true
  },
  marketType: {
    type: String,
    enum: ['spot', 'futures'],
    default: 'spot'
  },
  strategyId: {
    type: String,
    required: true,
    enum: ['adaptive_grid', 'dca', 'rsi_reversal', 'ema_crossover', 'scalper', 'breakout', 'ai_signal']
  },
  strategyParams: {
    // Adaptive Grid
    portions: { type: Number, default: 5 },
    gridSpacingMultiplier: { type: Number, default: 0.5 },
    rsiOverbought: { type: Number, default: 70 },
    rsiOversold: { type: Number, default: 30 },
    atrPeriod: { type: Number, default: 14 },
    emaPeriod1: { type: Number, default: 50 },
    emaPeriod2: { type: Number, default: 200 },
    takeProfitMode: {
      type: String,
      enum: ['structure', 'atr', 'fixed'],
      default: 'structure'
    },
    fixedTakeProfitPercent: { type: Number, default: 1.5 },
    trailingStopActivationPercent: { type: Number, default: 2.0 },
    trailingStopDistancePercent: { type: Number, default: 0.5 },
    stopLossAtrMultiplier: { type: Number, default: 2.0 },
    // DCA specific
    dcaIntervalHours: { type: Number, default: 24 },
    dcaAmountPerOrder: { type: Number, default: 100 },
    // Breakout specific
    breakoutLookbackDays: { type: Number, default: 20 },
    // Scalper specific
    scalperGridSpacing: { type: Number, default: 0.004 },
    // Futures leverage (used by DCA + AI Signal strategies)
    leverage: { type: Number, default: 1, min: 1, max: 20 },
  },
  capitalAllocation: {
    totalCapital: { type: Number, required: true, min: 10 },
    currency: { type: String, default: 'USDT' },
    maxOpenPositions: { type: Number, default: 5 }
  },
  riskParams: {
    globalDrawdownLimitPercent: { type: Number, default: 15 },
    dailyLossLimitPercent: { type: Number, default: 5 },
    enableNewsFilter: { type: Boolean, default: false }
  },
  status: {
    type: String,
    enum: ['stopped', 'running', 'paused', 'error'],
    default: 'stopped'
  },
  statusMessage: {
    type: String,
    default: ''
  },
  stats: {
    totalTrades: { type: Number, default: 0 },
    winningTrades: { type: Number, default: 0 },
    losingTrades: { type: Number, default: 0 },
    totalPnL: { type: Number, default: 0 },
    totalPnLPercent: { type: Number, default: 0 },
    startingCapital: { type: Number, default: 0 },
    currentCapital: { type: Number, default: 0 },
    peakCapital: { type: Number, default: 0 },
    maxDrawdown: { type: Number, default: 0 },
    lastTradeAt: { type: Date, default: null }
  },
  startedAt: { type: Date, default: null },
  stoppedAt: { type: Date, default: null },

  // Last tick analysis — shown on the bot detail page
  lastAnalysis: {
    timestamp:   { type: Date,   default: null },
    nextTickAt:  { type: Date,   default: null },
    currentPrice:{ type: Number, default: null },
    rsi:         { type: Number, default: null },
    volumeRatio: { type: Number, default: null }, // current vol / 20-bar avg
    trend:       { type: String, default: null }, // 'bullish' | 'bearish' | 'neutral'
    action:      { type: String, default: null }, // 'entry' | 'exit' | 'waiting'
    conditionsMet:    { type: Number, default: 0 },
    totalConditions:  { type: Number, default: 0 }
  },

  // Capped log of last 10 tick summaries
  tickLog: {
    type: [{
      timestamp:    { type: Date },
      currentPrice: { type: Number },
      rsi:          { type: Number },
      volumeRatio:  { type: Number },
      action:       { type: String }  // 'entry' | 'exit' | 'waiting'
    }],
    default: []
  }
}, {
  timestamps: true
});

botConfigSchema.index({ userId: 1, status: 1 });
botConfigSchema.index({ userId: 1, createdAt: -1 });

const BotConfig = mongoose.model('BotConfig', botConfigSchema);
export default BotConfig;
