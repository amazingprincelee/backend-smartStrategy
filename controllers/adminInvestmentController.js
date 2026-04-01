import Investment from '../models/Investment.js';
import InvestmentWithdrawal from '../models/InvestmentWithdrawal.js';

// GET /api/investment/admin/stats
export const getStats = async (req, res) => {
  try {
    const [agg] = await Investment.aggregate([
      { $match: { status: 'active' } },
      { $group: { _id: null, totalInvested: { $sum: '$amount' }, totalEarnings: { $sum: '$totalEarnings' }, count: { $sum: 1 } } },
    ]);
    const pendingWithdrawals = await InvestmentWithdrawal.countDocuments({ status: 'pending' });
    const tierBreakdown = await Investment.aggregate([
      { $match: { status: 'active' } },
      { $group: { _id: '$tier', count: { $sum: 1 }, total: { $sum: '$amount' } } },
    ]);
    const pendingPayments = await Investment.countDocuments({ status: 'pending_payment' });

    res.json({
      success: true,
      data: {
        totalInvested:     agg?.totalInvested ?? 0,
        totalEarnings:     agg?.totalEarnings ?? 0,
        activeCount:       agg?.count ?? 0,
        pendingWithdrawals,
        pendingPayments,
        tierBreakdown,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/investment/admin/list
export const listInvestors = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;

    const total = await Investment.countDocuments(filter);
    const investments = await Investment.find(filter)
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .populate('userId', 'email fullName');

    res.json({ success: true, data: { investments, total } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/investment/admin/withdrawals
export const listWithdrawals = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;

    const total = await InvestmentWithdrawal.countDocuments(filter);
    const withdrawals = await InvestmentWithdrawal.find(filter)
      .sort({ requestedAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .populate('userId', 'email fullName')
      .populate('investmentId', 'tier amount apy totalEarnings');

    res.json({ success: true, data: { withdrawals, total } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/investment/admin/withdrawal/:id
export const updateWithdrawal = async (req, res) => {
  try {
    const { status, adminNote } = req.body;
    if (!['approved', 'paid', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const withdrawal = await InvestmentWithdrawal.findByIdAndUpdate(
      req.params.id,
      { status, adminNote, processedAt: new Date() },
      { new: true },
    ).populate('userId', 'email fullName').populate('investmentId');

    if (!withdrawal) return res.status(404).json({ success: false, message: 'Withdrawal not found' });

    // If marked as paid, deduct from investment
    if (status === 'paid' && withdrawal.investmentId) {
      const upd = {};
      if (withdrawal.type === 'earnings')   upd.totalEarnings = 0;
      if (withdrawal.type === 'principal')  upd.status = 'withdrawn';
      if (withdrawal.type === 'all')        { upd.status = 'withdrawn'; upd.totalEarnings = 0; }
      if (Object.keys(upd).length) {
        await Investment.findByIdAndUpdate(withdrawal.investmentId._id, upd);
      }
    }

    res.json({ success: true, data: withdrawal });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
