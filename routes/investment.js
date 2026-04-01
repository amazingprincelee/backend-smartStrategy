import express from 'express';
import crypto from 'crypto';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { getDashboard, apply, requestWithdrawal } from '../controllers/investmentController.js';
import { getStats, listInvestors, listWithdrawals, updateWithdrawal } from '../controllers/adminInvestmentController.js';
import Investment from '../models/Investment.js';
import { getPaymentKeys } from '../services/payment/paymentKeys.js';

const router = express.Router();

// ── User routes ───────────────────────────────────────────────────────────────
router.get('/dashboard', authenticate, getDashboard);
router.post('/apply',    authenticate, apply);
router.post('/withdraw', authenticate, requestWithdrawal);

// ── NOWPayments webhook (unauthenticated, raw body captured by server.js) ─────
router.post('/webhook', async (req, res) => {
  try {
    const { nowpaymentsIpnSecret } = await getPaymentKeys();

    // Verify HMAC signature if secret is configured
    if (nowpaymentsIpnSecret) {
      const rawBody = req.rawBody || JSON.stringify(req.body);
      const sig = crypto
        .createHmac('sha512', nowpaymentsIpnSecret)
        .update(rawBody, 'utf8')
        .digest('hex');
      if (sig !== req.headers['x-nowpayments-sig']) {
        return res.status(401).json({ error: 'Invalid IPN signature' });
      }
    }

    const payload = req.body;
    if (payload.payment_status !== 'finished') return res.json({ received: true });

    const orderId = payload.order_id || '';
    if (!orderId.startsWith('invest-')) return res.json({ received: true });

    // order_id format: invest-{userId}-{investmentId}-{ts}
    const parts = orderId.split('-');
    // parts[0]='invest', parts[1]=userId, parts[2]=investmentId, parts[3]=ts
    const investmentId = parts[2];
    if (!investmentId) {
      console.warn('[Trade4Me] Webhook: could not parse investmentId from order_id:', orderId);
      return res.status(400).json({ error: 'Invalid order_id format' });
    }

    const now = new Date();
    const maturityDate = new Date(now);
    maturityDate.setDate(maturityDate.getDate() + 30);

    await Investment.findByIdAndUpdate(investmentId, {
      status: 'active',
      startDate: now,
      maturityDate,
      lastEarningsDate: now,
      chargeId: String(payload.id),
    });

    console.log(`[Trade4Me] Investment ${investmentId} activated via NOWPayments`);
    res.json({ received: true });
  } catch (err) {
    console.error('[Trade4Me] Webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin routes ──────────────────────────────────────────────────────────────
router.get('/admin/stats',            authenticate, requireAdmin, getStats);
router.get('/admin/list',             authenticate, requireAdmin, listInvestors);
router.get('/admin/withdrawals',      authenticate, requireAdmin, listWithdrawals);
router.put('/admin/withdrawal/:id',   authenticate, requireAdmin, updateWithdrawal);

export default router;
