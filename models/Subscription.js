/**
 * Subscription — full payment history record per transaction.
 * One document per payment attempt.
 */
import mongoose from 'mongoose';

const subscriptionSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  email:    { type: String },                             // denormalized for admin queries

  // Payment info
  provider:   { type: String, enum: ['coinbase_commerce', 'nowpayments', 'cryptopay'], required: true },
  chargeId:   { type: String, index: true },             // provider's charge/invoice ID
  chargeCode: { type: String },                          // Coinbase short code
  paymentUrl: { type: String },                          // redirect URL for user

  amountUSD:    { type: Number, default: 29 },
  currency:     { type: String, default: 'USD' },        // crypto currency paid in
  amountCrypto: { type: Number, default: null },
  txHash:       { type: String, default: null },         // blockchain tx

  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'expired', 'cancelled'],
    default: 'pending',
    index: true,
  },

  // Subscription period granted by this payment
  planStartAt:  { type: Date, default: null },
  planEndAt:    { type: Date, default: null },

  // Credits applied from referral bonus at checkout
  creditsApplied: { type: Number, default: 0 },

  // Referral tracking — did this payment trigger a referral reward?
  referralRewarded: { type: Boolean, default: false },
  referrerId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  webhookPayload: { type: mongoose.Schema.Types.Mixed, default: null }, // raw webhook for audit
  completedAt:   { type: Date, default: null },
}, { timestamps: true });

const Subscription = mongoose.model('Subscription', subscriptionSchema);
export default Subscription;
