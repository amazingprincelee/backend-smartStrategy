import mongoose from 'mongoose';

const InvestmentWithdrawalSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User',       required: true },
  investmentId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Investment', required: true },
  amount:        { type: Number, required: true },
  type:          { type: String, enum: ['earnings', 'principal', 'all'], required: true },
  walletAddress: { type: String },
  status:        { type: String, enum: ['pending', 'approved', 'paid', 'rejected'], default: 'pending' },
  adminNote:     { type: String },
  requestedAt:   { type: Date, default: Date.now },
  processedAt:   { type: Date },
}, { timestamps: true });

export default mongoose.model('InvestmentWithdrawal', InvestmentWithdrawalSchema);
