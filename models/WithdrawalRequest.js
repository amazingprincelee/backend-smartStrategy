import mongoose from 'mongoose';

const withdrawalRequestSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  email:         { type: String },  // denormalized for admin queries
  amount:        { type: Number, required: true, min: 1 },
  walletAddress: { type: String, required: true },
  network:       { type: String, default: 'ETH' },  // ETH, BSC, etc.

  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'paid'],
    default: 'pending',
    index: true,
  },

  adminNote:   { type: String, default: '' },
  txHash:      { type: String, default: null },   // blockchain proof of payment
  processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  processedAt: { type: Date, default: null },
}, { timestamps: true });

withdrawalRequestSchema.index({ createdAt: -1 });
withdrawalRequestSchema.index({ status: 1, createdAt: -1 });

const WithdrawalRequest = mongoose.model('WithdrawalRequest', withdrawalRequestSchema);
export default WithdrawalRequest;
