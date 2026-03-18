/**
 * paymentController.js
 * Unified payment controller — routes to whichever provider is active in AppSettings.
 */

import User from '../models/User.js';
import Subscription from '../models/Subscription.js';
import { getSettings } from '../models/AppSettings.js';
import coinbase  from '../services/payment/CoinbaseCommerceService.js';
import nowpay   from '../services/payment/NOWPaymentsService.js';
import cryptopay from '../services/payment/CryptoPayService.js';
import emailService from '../utils/emailService.js';

const PROVIDERS = { coinbase_commerce: coinbase, nowpayments: nowpay, cryptopay };

// ─── POST /api/payments/checkout ─────────────────────────────────────────────
// Creates a payment charge and returns the redirect URL.
export const createCheckout = async (req, res) => {
  try {
    const settings = await getSettings();
    const provider = PROVIDERS[settings.activePaymentProvider];
    if (!provider) return res.status(503).json({ success: false, message: 'Payment system not configured.' });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Check if already active premium
    if (user.role === 'admin') {
      return res.status(400).json({ success: false, message: 'Admin accounts do not need a subscription.' });
    }
    const isActive = user.subscription?.status === 'active' &&
      user.subscription?.expiresAt && new Date() < new Date(user.subscription.expiresAt);

    const planPrice     = settings.premiumPriceUSD;
    const creditsToApply = Math.min(user.credits || 0, planPrice);
    const amountUSD     = Math.max(0, planPrice - creditsToApply);

    // If credits cover the full price, activate directly without payment
    if (amountUSD === 0) {
      await User.findByIdAndUpdate(user._id, { $inc: { credits: -creditsToApply } });
      const { newExpiry } = await activatePremiumInternal(user._id, `credits-${Date.now()}`, 'credits', null, settings, creditsToApply);
      return res.json({ success: true, data: { activated: true, creditsApplied: creditsToApply, expiresAt: newExpiry } });
    }

    // Deduct credits now — they are consumed at checkout
    if (creditsToApply > 0) {
      await User.findByIdAndUpdate(user._id, { $inc: { credits: -creditsToApply } });
    }

    const charge = await provider.createCharge({
      userId:     user._id,
      userEmail:  user.email,
      amountUSD,
      description: creditsToApply > 0
        ? `SmartStrategy Premium — $${planPrice}/month ($${creditsToApply} credit applied)`
        : `SmartStrategy Premium — $${planPrice}/month`,
      metadata: { referralCode: user.referral?.referredBy || null },
    });

    // Record pending subscription
    await Subscription.create({
      userId:    user._id,
      email:     user.email,
      provider:  settings.activePaymentProvider,
      chargeId:  charge.chargeId,
      chargeCode: charge.chargeCode || null,
      paymentUrl: charge.paymentUrl,
      amountUSD,
      creditsApplied: creditsToApply,
      status:    'pending',
    });

    res.json({ success: true, data: { paymentUrl: charge.paymentUrl, provider: settings.activePaymentProvider } });
  } catch (err) {
    console.error('[Payment] createCheckout error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── Shared: activate premium after confirmed payment ─────────────────────────
async function activatePremium(userId, chargeId, provider, webhookPayload = null) {
  const settings = await getSettings();
  return activatePremiumInternal(userId, chargeId, provider, webhookPayload, settings, 0);
}

async function activatePremiumInternal(userId, chargeId, provider, webhookPayload, settings, creditsApplied = 0) {
  const daysToAdd = settings.premiumDurationDays || 30;

  const user = await User.findById(userId);
  if (!user) throw new Error(`User ${userId} not found`);

  // Calculate new expiry — extend if already active
  const now = new Date();
  const currentExpiry = user.subscription?.expiresAt && new Date(user.subscription.expiresAt) > now
    ? new Date(user.subscription.expiresAt)
    : now;
  const newExpiry = new Date(currentExpiry.getTime() + daysToAdd * 86_400_000);

  // Update user
  await User.findByIdAndUpdate(userId, {
    role: 'premium',
    'subscription.plan':            'premium',
    'subscription.status':          'active',
    'subscription.startedAt':       now,
    'subscription.expiresAt':       newExpiry,
    'subscription.paymentProvider': provider,
    'subscription.lastChargeId':    chargeId,
    'subscription.autoReminderSent7d': false,
    'subscription.autoReminderSent1d': false,
  });

  // Update subscription record
  const sub = await Subscription.findOneAndUpdate(
    { chargeId },
    { status: 'completed', planStartAt: now, planEndAt: newExpiry, completedAt: now, webhookPayload },
    { new: true }
  );

  // ── Referral reward ────────────────────────────────────────────────────────
  if (sub && !sub.referralRewarded && user.referral?.referredBy) {
    const referrer = await User.findOne({ 'referral.code': user.referral.referredBy });
    if (referrer) {
      const percent = settings.referralRewardPercent ?? 25;
      const reward  = Math.round((settings.premiumPriceUSD * percent / 100) * 100) / 100;
      await User.findByIdAndUpdate(referrer._id, {
        $inc: {
          credits:                reward,
          'referral.totalEarned': reward,
        },
      });
      await Subscription.findByIdAndUpdate(sub._id, {
        referralRewarded: true,
        referrerId: referrer._id,
      });
      // Notify referrer
      try {
        await emailService.sendEmail(
          referrer.email,
          `🎉 You earned a $${reward} referral reward!`,
          `<p>Hi ${referrer.fullName || 'there'},</p>
           <p>Someone you referred just subscribed to SmartStrategy Premium! You've earned a <strong>$${reward} credit</strong>.</p>
           <p>Your new credit balance: <strong>$${(referrer.credits || 0) + reward}</strong></p>`,
          `You earned a $${reward} referral credit. Your balance: $${(referrer.credits || 0) + reward}`
        );
      } catch (_) { /* non-critical */ }
    }
  }

  // ── Welcome email ──────────────────────────────────────────────────────────
  try {
    await emailService.sendEmail(
      user.email,
      '🚀 Welcome to SmartStrategy Premium!',
      `<p>Hi ${user.fullName || 'there'},</p>
       <p>Your Premium subscription is now active until <strong>${newExpiry.toDateString()}</strong>.</p>
       <p>You now have access to:</p>
       <ul>
         <li>✅ Instant signals — no delay, full entry/SL/TP data</li>
         <li>✅ Live SmartSignal Bot — trade automatically with real funds</li>
         <li>✅ Full arbitrage scanner with real-time alerts</li>
         <li>✅ Backtesting &amp; on-demand analysis</li>
       </ul>
       <p><a href="${process.env.CLIENT_URL}/bots">Start your bot →</a></p>`,
      `Your Premium is active until ${newExpiry.toDateString()}.`
    );
  } catch (_) { /* non-critical */ }

  console.log(`[Payment] Activated premium for user ${userId} until ${newExpiry.toDateString()}`);
  return { user: await User.findById(userId), newExpiry };
}

// ─── POST /api/payments/webhook/coinbase ──────────────────────────────────────
export const coinbaseWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-cc-webhook-signature'];
    const event = coinbase.verifyWebhook(req.rawBody, signature);

    // Only act on 'charge:confirmed' or 'charge:resolved'
    if (!['charge:confirmed', 'charge:resolved'].includes(event.event)) {
      return res.json({ received: true });
    }
    if (!event.userId) return res.status(400).json({ error: 'Missing userId in charge metadata' });

    await activatePremium(event.userId, event.chargeId, 'coinbase_commerce', JSON.parse(req.rawBody));
    res.json({ received: true });
  } catch (err) {
    console.error('[Payment] Coinbase webhook error:', err.message);
    res.status(400).json({ error: err.message });
  }
};

// ─── POST /api/payments/webhook/nowpayments ───────────────────────────────────
export const nowpaymentsWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-nowpayments-sig'];
    const event = nowpay.verifyWebhook(req.rawBody, signature);

    if (event.status !== 'finished') return res.json({ received: true });
    if (!event.userId) return res.status(400).json({ error: 'Missing userId' });

    await activatePremium(event.userId, event.chargeId, 'nowpayments', JSON.parse(req.rawBody));
    res.json({ received: true });
  } catch (err) {
    console.error('[Payment] NOWPayments webhook error:', err.message);
    res.status(400).json({ error: err.message });
  }
};

// ─── POST /api/payments/webhook/cryptopay ────────────────────────────────────
export const cryptopayWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-cryptopay-signature'];
    const event = cryptopay.verifyWebhook(req.rawBody, signature);

    if (event.status !== 'completed') return res.json({ received: true });
    if (!event.userId) return res.status(400).json({ error: 'Missing userId' });

    await activatePremium(event.userId, event.chargeId, 'cryptopay', JSON.parse(req.rawBody));
    res.json({ received: true });
  } catch (err) {
    console.error('[Payment] CryptoPay webhook error:', err.message);
    res.status(400).json({ error: err.message });
  }
};

// ─── GET /api/payments/status ─────────────────────────────────────────────────
export const getSubscriptionStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('role subscription referral credits');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const settings = await getSettings();
    const isPremium = user.role === 'admin' ||
      (user.subscription?.status === 'active' && new Date() < new Date(user.subscription?.expiresAt));

    // Payment history
    const history = await Subscription
      .find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('provider status amountUSD planStartAt planEndAt createdAt completedAt');

    res.json({
      success: true,
      data: {
        isPremium,
        role:         user.role,
        subscription: user.subscription,
        credits:      user.credits || 0,
        referral:     user.referral,
        priceUSD:     settings.premiumPriceUSD,
        activeProvider: settings.activePaymentProvider,
        paymentHistory: history,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── POST /api/payments/admin/activate ───────────────────────────────────────
// Admin-only: manually activate premium for a user (e.g. for testing or support)
export const adminActivatePremium = async (req, res) => {
  try {
    const { userId, days = 30 } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'userId required' });

    const now = new Date();
    const newExpiry = new Date(now.getTime() + days * 86_400_000);

    await User.findByIdAndUpdate(userId, {
      role: 'premium',
      'subscription.plan':    'premium',
      'subscription.status':  'active',
      'subscription.startedAt': now,
      'subscription.expiresAt': newExpiry,
      'subscription.paymentProvider': 'manual',
      'subscription.autoReminderSent7d': false,
      'subscription.autoReminderSent1d': false,
    });

    res.json({ success: true, message: `Premium activated for ${days} days until ${newExpiry.toDateString()}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
