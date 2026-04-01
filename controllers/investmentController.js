import Investment, { TIERS } from '../models/Investment.js';
import InvestmentWithdrawal from '../models/InvestmentWithdrawal.js';
import User from '../models/User.js';
import { getPaymentKeys } from '../services/payment/paymentKeys.js';

// GET /api/investment/dashboard
export const getDashboard = async (req, res) => {
  try {
    const investments = await Investment.find({ userId: req.user.id }).sort({ createdAt: -1 });
    const withdrawals = await InvestmentWithdrawal.find({ userId: req.user.id })
      .sort({ requestedAt: -1 })
      .limit(20)
      .populate('investmentId', 'tier amount apy');

    res.json({ success: true, data: { investments, withdrawals, tiers: TIERS } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/investment/apply
export const apply = async (req, res) => {
  try {
    const { tier, amount } = req.body;

    if (!TIERS[tier]) {
      return res.status(400).json({ success: false, message: 'Invalid tier' });
    }
    const numAmount = Number(amount);
    if (!numAmount || numAmount < TIERS[tier].minAmount) {
      return res.status(400).json({
        success: false,
        message: `Minimum investment for ${tier} tier is $${TIERS[tier].minAmount}`,
      });
    }

    const user = await User.findById(req.user.id).select('email');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Create investment record first to get the _id for the order_id
    const investment = await Investment.create({
      userId: req.user.id,
      amount: numAmount,
      tier,
      apy: TIERS[tier].apy,
      status: 'pending_payment',
    });

    // Build NOWPayments invoice
    const { nowpaymentsApiKey } = await getPaymentKeys();
    const orderId = `invest-${req.user.id}-${investment._id}-${Date.now()}`;

    const npRes = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': nowpaymentsApiKey,
      },
      body: JSON.stringify({
        price_amount:      numAmount,
        price_currency:    'usd',
        order_id:          orderId,
        order_description: `Trade4Me Investment — ${tier} tier — ${TIERS[tier].apy}% APY`,
        ipn_callback_url:  `${process.env.SERVER_URL || 'http://localhost:5000'}/api/investment/webhook`,
        success_url:       `${process.env.CLIENT_URL}/trade4me?success=1`,
        cancel_url:        `${process.env.CLIENT_URL}/trade4me`,
        is_fixed_rate:     true,
        is_fee_paid_by_user: false,
        customer_email:    user.email,
      }),
    });

    const invoice = await npRes.json();
    if (!npRes.ok) {
      // Clean up orphaned investment record
      await Investment.findByIdAndDelete(investment._id);
      throw new Error(invoice?.message || `NOWPayments error ${npRes.status}`);
    }

    await Investment.findByIdAndUpdate(investment._id, {
      chargeId: String(invoice.id),
      orderId,
    });

    res.json({
      success: true,
      data: { paymentUrl: invoice.invoice_url, investmentId: investment._id },
    });
  } catch (err) {
    console.error('[Trade4Me] apply error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/investment/withdraw
export const requestWithdrawal = async (req, res) => {
  try {
    const { investmentId, type, walletAddress } = req.body;

    if (!['earnings', 'principal', 'all'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid withdrawal type' });
    }

    const investment = await Investment.findOne({ _id: investmentId, userId: req.user.id });
    if (!investment) return res.status(404).json({ success: false, message: 'Investment not found' });
    if (investment.status !== 'active') {
      return res.status(400).json({ success: false, message: 'Investment is not active' });
    }

    // Enforce 30-day lock for principal/all withdrawals
    if (type !== 'earnings') {
      const lockExpiry = new Date(investment.startDate);
      lockExpiry.setDate(lockExpiry.getDate() + 30);
      if (new Date() < lockExpiry) {
        return res.status(400).json({
          success: false,
          message: `Principal is locked until ${lockExpiry.toDateString()}. You may only withdraw earnings before then.`,
        });
      }
    }

    const amount =
      type === 'earnings'   ? investment.totalEarnings :
      type === 'principal'  ? investment.amount :
      investment.amount + investment.totalEarnings;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'No balance available to withdraw' });
    }

    // Block duplicate pending requests
    const existing = await InvestmentWithdrawal.findOne({
      investmentId, userId: req.user.id, status: 'pending',
    });
    if (existing) {
      return res.status(400).json({ success: false, message: 'You already have a pending withdrawal request' });
    }

    const withdrawal = await InvestmentWithdrawal.create({
      userId: req.user.id,
      investmentId,
      amount,
      type,
      walletAddress: walletAddress || '',
      status: 'pending',
    });

    res.json({ success: true, data: withdrawal });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
