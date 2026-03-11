import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [
      /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
      'Please enter a valid email address'
    ]
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters long'],
    select: false // Don't include password in queries by default
  },
  walletAddress: {
    type: String,
    required: false,
    lowercase: true,
    trim: true,
    match: [/^0x[a-fA-F0-9]{40}$/, 'Please enter a valid Ethereum address']
  },

  fullName: {
      type: String,
      trim: true,
      maxlength: [50, 'Full name cannot exceed 50 characters']
    },
   
  preferences: {
    theme: {
      type: String,
      enum: ['dark', 'darkest'],
      default: 'dark'
    },
    emailNotifications: {
      botAlert: { type: Boolean, default: true },
      signalAlert: { type: Boolean, default: true },
      tradeExecuted: { type: Boolean, default: true },
      platformUpdates: { type: Boolean, default: false },
      arbitrageAlert: { type: Boolean, default: false }  // off by default — user must opt in
    },
    inAppNotifications: {
      botAlert: { type: Boolean, default: true },
      signalAlert: { type: Boolean, default: true },
      tradeExecuted: { type: Boolean, default: true },
      platformUpdates: { type: Boolean, default: true },
      arbitrageAlert: { type: Boolean, default: true }
    }
  },
  lastLogin: {
    type: Date,
    default: Date.now
  },
  isActive: {
    type: Boolean,
    default: true
  },
  role: {
    type: String,
    enum: ['user', 'premium', 'admin'],
    default: 'user'
  },

  // ── Subscription ────────────────────────────────────────────────────────────
  subscription: {
    plan:            { type: String, enum: ['free', 'premium'], default: 'free' },
    status:          { type: String, enum: ['active', 'trial', 'expired', 'cancelled', 'pending'], default: 'expired' },
    expiresAt:       { type: Date,   default: null },
    startedAt:       { type: Date,   default: null },
    paymentProvider: { type: String, enum: ['coinbase_commerce', 'nowpayments', 'cryptopay', null], default: null },
    lastChargeId:    { type: String, default: null },
    autoReminderSent7d:  { type: Boolean, default: false },
    autoReminderSent1d:  { type: Boolean, default: false },
  },

  // ── Referral ────────────────────────────────────────────────────────────────
  referral: {
    code:      { type: String, unique: true, sparse: true },  // user's own code
    referredBy: { type: String, default: null },              // code of who referred them
    referrals:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // users they referred
    totalEarned:  { type: Number, default: 0 },  // cumulative $5 credits earned
    pendingCredit: { type: Number, default: 0 },  // credit ready to use
  },

  // ── Credits (from referrals) ─────────────────────────────────────────────────
  credits: { type: Number, default: 0 },  // $USD credit balance

  // ── Google OAuth ─────────────────────────────────────────────────────────────
  googleId: { type: String, default: null, sparse: true },
  authProvider: { type: String, enum: ['local', 'google'], default: 'local' },

}, {
  timestamps: true
});

// Indexes for better query performance
userSchema.index({ createdAt: -1 });
userSchema.index({ 'referral.code': 1 });
userSchema.index({ 'subscription.expiresAt': 1 });

// Virtual: is user currently on premium?
userSchema.virtual('isPremium').get(function () {
  if (this.role === 'admin') return true;
  if (this.role === 'premium') return true;
  if (this.subscription?.plan === 'premium' && this.subscription?.status === 'active') {
    return this.subscription.expiresAt && new Date() < new Date(this.subscription.expiresAt);
  }
  if (this.subscription?.status === 'trial') {
    return this.subscription.expiresAt && new Date() < new Date(this.subscription.expiresAt);
  }
  return false;
});

// Generate a unique referral code before saving
userSchema.pre('save', async function (next) {
  if (!this.referral?.code) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    let exists = true;
    while (exists) {
      code = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      exists = await mongoose.model('User').exists({ 'referral.code': code });
    }
    if (!this.referral) this.referral = {};
    this.referral.code = code;
  }
  next();
});

const User = mongoose.model('User', userSchema);

export default User;