import WithdrawalRequest from '../models/WithdrawalRequest.js';
import User from '../models/User.js';
import { logAdminAction } from '../models/AuditLog.js';
import { getSettings } from '../models/AppSettings.js';
import emailService from '../utils/emailService.js';

// ── USER: Request withdrawal ──────────────────────────────────────────────────
export const requestWithdrawal = async (req, res) => {
  try {
    const { amount, walletAddress, network = 'ETH' } = req.body;

    if (!amount || !walletAddress) {
      return res.status(400).json({ success: false, message: 'Amount and wallet address are required' });
    }

    const settings = await getSettings();
    const minAmount = settings.minWithdrawalAmount || 10;

    if (amount < minAmount) {
      return res.status(400).json({ success: false, message: `Minimum withdrawal is $${minAmount}` });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (user.credits < amount) {
      return res.status(400).json({
        success: false,
        message: `Insufficient credits. Available: $${user.credits.toFixed(2)}`,
      });
    }

    // Check for pending request already
    const existing = await WithdrawalRequest.findOne({ userId: req.user.id, status: 'pending' });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'You already have a pending withdrawal request. Please wait for it to be processed.',
      });
    }

    // Deduct credits immediately (holds them while pending)
    user.credits -= amount;
    await user.save();

    const withdrawal = await WithdrawalRequest.create({
      userId:        req.user.id,
      email:         user.email,
      amount,
      walletAddress,
      network,
    });

    res.status(201).json({ success: true, data: withdrawal });
  } catch (err) {
    console.error('[Withdrawal] requestWithdrawal:', err.message);
    res.status(500).json({ success: false, message: 'Failed to submit withdrawal request' });
  }
};

// ── USER: Get own withdrawal requests ────────────────────────────────────────
export const getUserWithdrawals = async (req, res) => {
  try {
    const withdrawals = await WithdrawalRequest.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ success: true, data: withdrawals });
  } catch (err) {
    console.error('[Withdrawal] getUserWithdrawals:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch withdrawals' });
  }
};

// ── ADMIN: Get all withdrawal requests ───────────────────────────────────────
export const adminGetAllWithdrawals = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 30);
    const skip  = (page - 1) * limit;
    const { status } = req.query;

    const filter = {};
    if (status) filter.status = status;

    const [withdrawals, total, pendingCount] = await Promise.all([
      WithdrawalRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      WithdrawalRequest.countDocuments(filter),
      WithdrawalRequest.countDocuments({ status: 'pending' }),
    ]);

    res.json({ success: true, data: withdrawals, meta: { total, page, limit, pendingCount } });
  } catch (err) {
    console.error('[Withdrawal] adminGetAllWithdrawals:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch withdrawal requests' });
  }
};

// ── ADMIN: Approve withdrawal ─────────────────────────────────────────────────
export const adminApproveWithdrawal = async (req, res) => {
  try {
    const { adminNote = '' } = req.body;
    const withdrawal = await WithdrawalRequest.findById(req.params.id);
    if (!withdrawal) return res.status(404).json({ success: false, message: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Cannot approve a ${withdrawal.status} request` });
    }

    withdrawal.status      = 'approved';
    withdrawal.adminNote   = adminNote;
    withdrawal.processedBy = req.user.id;
    withdrawal.processedAt = new Date();
    await withdrawal.save();

    // Notify user
    await _notifyUser(withdrawal, 'approved', `Your withdrawal request of $${withdrawal.amount} has been approved and is being processed.`);

    await logAdminAction({
      adminId: req.user.id, adminEmail: req.user.email,
      action: 'withdrawal_approved',
      targetUserId: withdrawal.userId, targetEmail: withdrawal.email,
      targetModel: 'WithdrawalRequest', targetId: withdrawal._id.toString(),
      description: `Approved withdrawal of $${withdrawal.amount} to ${withdrawal.walletAddress}`,
      ip: req.ip,
    });

    res.json({ success: true, data: withdrawal });
  } catch (err) {
    console.error('[Withdrawal] adminApproveWithdrawal:', err.message);
    res.status(500).json({ success: false, message: 'Failed to approve withdrawal' });
  }
};

// ── ADMIN: Reject withdrawal (refund credits) ─────────────────────────────────
export const adminRejectWithdrawal = async (req, res) => {
  try {
    const { adminNote = '' } = req.body;
    const withdrawal = await WithdrawalRequest.findById(req.params.id);
    if (!withdrawal) return res.status(404).json({ success: false, message: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Cannot reject a ${withdrawal.status} request` });
    }

    withdrawal.status      = 'rejected';
    withdrawal.adminNote   = adminNote;
    withdrawal.processedBy = req.user.id;
    withdrawal.processedAt = new Date();
    await withdrawal.save();

    // Refund credits back to user
    await User.findByIdAndUpdate(withdrawal.userId, { $inc: { credits: withdrawal.amount } });

    await _notifyUser(withdrawal, 'rejected', `Your withdrawal request of $${withdrawal.amount} was rejected. Your credits have been refunded. Reason: ${adminNote || 'No reason provided'}`);

    await logAdminAction({
      adminId: req.user.id, adminEmail: req.user.email,
      action: 'withdrawal_rejected',
      targetUserId: withdrawal.userId, targetEmail: withdrawal.email,
      targetModel: 'WithdrawalRequest', targetId: withdrawal._id.toString(),
      description: `Rejected withdrawal of $${withdrawal.amount}. Note: ${adminNote}`,
      ip: req.ip,
    });

    res.json({ success: true, data: withdrawal });
  } catch (err) {
    console.error('[Withdrawal] adminRejectWithdrawal:', err.message);
    res.status(500).json({ success: false, message: 'Failed to reject withdrawal' });
  }
};

// ── ADMIN: Mark as paid ───────────────────────────────────────────────────────
export const adminMarkPaid = async (req, res) => {
  try {
    const { txHash, adminNote = '' } = req.body;
    if (!txHash?.trim()) return res.status(400).json({ success: false, message: 'Transaction hash is required' });

    const withdrawal = await WithdrawalRequest.findById(req.params.id);
    if (!withdrawal) return res.status(404).json({ success: false, message: 'Withdrawal not found' });
    if (withdrawal.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'Only approved withdrawals can be marked as paid' });
    }

    withdrawal.status      = 'paid';
    withdrawal.txHash      = txHash.trim();
    withdrawal.adminNote   = adminNote;
    withdrawal.processedBy = req.user.id;
    withdrawal.processedAt = new Date();
    await withdrawal.save();

    await _notifyUser(withdrawal, 'paid', `Your withdrawal of $${withdrawal.amount} has been paid! TX: ${txHash}`);

    await logAdminAction({
      adminId: req.user.id, adminEmail: req.user.email,
      action: 'withdrawal_paid',
      targetUserId: withdrawal.userId, targetEmail: withdrawal.email,
      targetModel: 'WithdrawalRequest', targetId: withdrawal._id.toString(),
      description: `Marked withdrawal of $${withdrawal.amount} as paid. TX: ${txHash}`,
      ip: req.ip,
    });

    res.json({ success: true, data: withdrawal });
  } catch (err) {
    console.error('[Withdrawal] adminMarkPaid:', err.message);
    res.status(500).json({ success: false, message: 'Failed to mark as paid' });
  }
};

// ── Helper: send email notification to user ───────────────────────────────────
async function _notifyUser(withdrawal, statusLabel, bodyText) {
  try {
    const user = await User.findById(withdrawal.userId).select('email fullName preferences');
    if (!user) return;
    await emailService.sendEmail(
      user.email,
      `Withdrawal Request ${statusLabel.charAt(0).toUpperCase() + statusLabel.slice(1)} — SmartStrategy`,
      `<p>Hello ${user.fullName || 'there'},</p><p>${bodyText}</p>
       <p>Amount: <strong>$${withdrawal.amount}</strong></p>
       <p>Wallet: <code>${withdrawal.walletAddress}</code></p>
       ${withdrawal.txHash ? `<p>TX Hash: <code>${withdrawal.txHash}</code></p>` : ''}
       <hr/><p style="color:#6b7280;font-size:12px">SmartStrategy Platform</p>`,
    );
  } catch (e) { /* email is best-effort */ }
}
