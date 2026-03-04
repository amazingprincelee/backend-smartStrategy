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
      arbitrageAlert: { type: Boolean, default: true }
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
    enum: ['user', 'admin'],
    default: 'user'
  },
}, {
  timestamps: true
});

// Index for better query performance
userSchema.index({ createdAt: -1 });

const User = mongoose.model('User', userSchema);

export default User;