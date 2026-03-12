import mongoose from 'mongoose';

const alphaSignalSchema = new mongoose.Schema({
  symbol: { type: String, required: true, uppercase: true },   // e.g. "PEPEUSDT"
  name:   { type: String, default: '' },                       // e.g. "Pepe"
  exchange: { type: String, default: 'binance' },

  // Overall opportunity score 0–100
  score: { type: Number, required: true, min: 0, max: 100 },

  // Category driving the alert
  category: {
    type: String,
    enum: ['new_listing', 'volume_spike', 'trending', 'whale_accumulation', 'social_spike'],
    required: true
  },

  // Array of human-readable reasons that boosted the score
  reasons: [{ type: String }],

  // Market data snapshot at discovery time
  price:        { type: Number, default: null },
  marketCap:    { type: Number, default: null },
  volume24h:    { type: Number, default: null },
  volumeChange: { type: Number, default: null }, // % change vs prior 24 h
  priceChange:  { type: Number, default: null }, // % 24 h price change
  priceChange1h:{ type: Number, default: null },
  rank:         { type: Number, default: null },  // CoinGecko market cap rank

  // Exchanges where this coin is actively traded (top 3 by volume)
  exchanges: [{ type: String }],

  // Whether this signal is still considered actionable
  isActive: { type: Boolean, default: true, index: true },

  // ISO timestamp when we first spotted this
  discoveredAt: { type: Date, default: Date.now, index: true },

  // Prevent duplicate alerts for the same symbol on the same day
  dateKey: { type: String, index: true }, // "YYYY-MM-DD-symbol"
}, {
  timestamps: true
});

alphaSignalSchema.index({ category: 1, discoveredAt: -1 });
alphaSignalSchema.index({ score: -1, discoveredAt: -1 });

const AlphaSignal = mongoose.model('AlphaSignal', alphaSignalSchema);
export default AlphaSignal;
