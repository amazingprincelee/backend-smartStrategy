import mongoose from 'mongoose';

export const TIERS = {
  starter: { minAmount: 30,   apy: 15 },
  growth:  { minAmount: 500,  apy: 18 },
  premium: { minAmount: 2000, apy: 20 },
};

const InvestmentSchema = new mongoose.Schema({
  userId:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount:           { type: Number, required: true },
  tier:             { type: String, enum: ['starter', 'growth', 'premium'], required: true },
  apy:              { type: Number, required: true },
  startDate:        { type: Date },
  maturityDate:     { type: Date },   // startDate + 30 days (lock period)
  status:           { type: String, enum: ['pending_payment', 'active', 'withdrawn', 'completed'], default: 'pending_payment' },
  chargeId:         { type: String },
  orderId:          { type: String },
  totalEarnings:    { type: Number, default: 0 },
  lastEarningsDate: { type: Date },
  notes:            { type: String },
}, { timestamps: true });

export default mongoose.model('Investment', InvestmentSchema);
