/**
 * ArbitrageOpportunity.js
 * Persists arbitrage opportunities with net profit ≥ 2% for monitoring
 * and historical reference.
 *
 * Status lifecycle:
 *   active  → opportunity is still showing up in scans at ≥ 2% profit
 *   cleared → opportunity dropped below threshold or disappeared from scans
 */

import mongoose from 'mongoose';

const ArbitrageOpportunitySchema = new mongoose.Schema(
  {
    // Stable key: symbol + exchanges (e.g. "ETH/USDT-binance-kraken")
    opportunityId: {
      type:     String,
      required: true,
      unique:   true,
    },

    symbol:       { type: String, required: true },
    buyExchange:  { type: String, required: true },
    sellExchange: { type: String, required: true },

    // Current / latest profit snapshot
    netProfitPercent:   { type: Number, required: true },
    grossSpreadPercent: Number,
    expectedProfitUSD:  Number,
    optimalTradeValueUSD: Number,
    buyPrice:           Number,
    sellPrice:          Number,
    confidenceScore:    Number,
    riskLevel:          String,

    // Peak profit seen across all scans while this opportunity was active
    peakProfitPercent:  { type: Number, default: 0 },

    // Lifecycle
    status: {
      type:    String,
      enum:    ['active', 'cleared'],
      default: 'active',
      index:   true,
    },
    firstDetectedAt: { type: Date, default: Date.now, index: true },
    lastSeenAt:      { type: Date, default: Date.now },
    clearedAt:       Date,

    // Prevent duplicate email blasts for the same opportunity
    emailSent: { type: Boolean, default: false },
    // Timestamp of last email sent — used for 6-hour per-opportunity cooldown
    lastEmailedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

ArbitrageOpportunitySchema.index({ status: 1, firstDetectedAt: -1 });
ArbitrageOpportunitySchema.index({ symbol: 1, status: 1 });

export default mongoose.model('ArbitrageOpportunity', ArbitrageOpportunitySchema);
