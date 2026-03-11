/**
 * AppSettings — singleton document for admin-configurable platform settings.
 * Only one document exists (key: 'global'). Admin can change these via /api/admin/settings.
 */
import mongoose from 'mongoose';

const appSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'global', unique: true },

  // Active payment provider — admin switches this via dashboard
  activePaymentProvider: {
    type: String,
    enum: ['coinbase_commerce', 'nowpayments', 'cryptopay'],
    default: 'coinbase_commerce',
  },

  // Pricing
  premiumPriceUSD: { type: Number, default: 20 },
  premiumDurationDays: { type: Number, default: 30 },
  referralRewardUSD: { type: Number, default: 5 },

  // Feature limits for free tier
  freeSignalsPerDay:        { type: Number, default: 2 },
  freeSignalMaxConfidence:  { type: Number, default: 0.60 },  // signals BELOW this shown to free
  freeArbitrageLimit:       { type: Number, default: 5 },
  freeArbitrageMaxProfit:   { type: Number, default: 1.0 },   // only <1% profit shown to free

  // Maintenance mode
  maintenanceMode: { type: Boolean, default: false },
  maintenanceMessage: { type: String, default: '' },

  // Site-wide announcement banner
  announcementActive:  { type: Boolean, default: false },
  announcementMessage: { type: String, default: '' },
  announcementType:    { type: String, enum: ['info', 'warning', 'success', 'error'], default: 'info' },
  announcementExpires: { type: Date, default: null },  // auto-hide after this date

  // Free trial settings
  freeTrialDays:       { type: Number, default: 7 },
  minWithdrawalAmount: { type: Number, default: 10 },  // minimum $USD referral withdrawal

  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

const AppSettings = mongoose.model('AppSettings', appSettingsSchema);

// Helper to get (or create) the singleton settings document
export async function getSettings() {
  let settings = await AppSettings.findOne({ key: 'global' });
  if (!settings) {
    settings = await AppSettings.create({ key: 'global' });
  }
  return settings;
}

export default AppSettings;
