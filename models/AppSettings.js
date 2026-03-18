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
    default: 'nowpayments',
  },

  // Pricing
  premiumPriceUSD: { type: Number, default: 29 },
  premiumDurationDays: { type: Number, default: 30 },
  referralRewardPercent: { type: Number, default: 25 }, // % of plan price; 25% of $29 = $7.25

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

  // Payment provider API keys (stored in DB so admin can update without server restart)
  nowpaymentsApiKey:        { type: String, default: '' },
  nowpaymentsIpnSecret:     { type: String, default: '' },
  coinbaseApiKey:           { type: String, default: '' },
  coinbaseWebhookSecret:    { type: String, default: '' },
  cryptopayApiKey:          { type: String, default: '' },
  cryptopayApiSecret:       { type: String, default: '' },
  cryptopayCallbackSecret:  { type: String, default: '' },

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
