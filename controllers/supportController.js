import SupportTicket from '../models/SupportTicket.js';
import { logAdminAction } from '../models/AuditLog.js';
import emailService from '../utils/emailService.js';
import User from '../models/User.js';

// ── USER: Submit new ticket ───────────────────────────────────────────────────
export const createTicket = async (req, res) => {
  try {
    const { subject, message, category = 'other', priority = 'medium' } = req.body;
    if (!subject?.trim() || !message?.trim()) {
      return res.status(400).json({ success: false, message: 'Subject and message are required' });
    }

    const ticket = await SupportTicket.create({
      userId:   req.user.id,
      email:    req.user.email,
      subject:  subject.trim(),
      message:  message.trim(),
      category,
      priority,
    });

    res.status(201).json({ success: true, data: ticket });
  } catch (err) {
    console.error('[Support] createTicket:', err.message);
    res.status(500).json({ success: false, message: 'Failed to submit ticket' });
  }
};

// ── USER: Get own tickets ─────────────────────────────────────────────────────
export const getUserTickets = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    const [tickets, total] = await Promise.all([
      SupportTicket.find({ userId: req.user.id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      SupportTicket.countDocuments({ userId: req.user.id }),
    ]);

    res.json({ success: true, data: tickets, meta: { total, page, limit } });
  } catch (err) {
    console.error('[Support] getUserTickets:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch tickets' });
  }
};

// ── USER: Get one ticket (own only) ──────────────────────────────────────────
export const getTicketById = async (req, res) => {
  try {
    const ticket = await SupportTicket.findOne({ _id: req.params.id, userId: req.user.id }).lean();
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

    // Mark as read by user
    await SupportTicket.updateOne({ _id: ticket._id }, { readByUser: true });
    res.json({ success: true, data: ticket });
  } catch (err) {
    console.error('[Support] getTicketById:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch ticket' });
  }
};

// ── USER: Reply to own ticket ─────────────────────────────────────────────────
export const replyToTicket = async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ success: false, message: 'Message is required' });

    const ticket = await SupportTicket.findOne({ _id: req.params.id, userId: req.user.id });
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
    if (ticket.status === 'closed') return res.status(400).json({ success: false, message: 'Ticket is closed' });

    ticket.replies.push({ authorId: req.user.id, authorRole: 'user', message: message.trim() });
    ticket.lastReplyAt = new Date();
    ticket.readByAdmin = false;
    ticket.status = 'in_progress';
    await ticket.save();

    res.json({ success: true, data: ticket });
  } catch (err) {
    console.error('[Support] replyToTicket:', err.message);
    res.status(500).json({ success: false, message: 'Failed to add reply' });
  }
};

// ── ADMIN: Get all tickets ────────────────────────────────────────────────────
export const adminGetAllTickets = async (req, res) => {
  try {
    const page     = Math.max(1, parseInt(req.query.page)     || 1);
    const limit    = Math.min(100, parseInt(req.query.limit)  || 30);
    const skip     = (page - 1) * limit;
    const { status, category, priority, search } = req.query;

    const filter = {};
    if (status)   filter.status   = status;
    if (category) filter.category = category;
    if (priority) filter.priority = priority;
    if (search)   filter.$or = [
      { subject: { $regex: search, $options: 'i' } },
      { email:   { $regex: search, $options: 'i' } },
    ];

    const [tickets, total, unreadCount] = await Promise.all([
      SupportTicket.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      SupportTicket.countDocuments(filter),
      SupportTicket.countDocuments({ readByAdmin: false, status: { $nin: ['closed', 'resolved'] } }),
    ]);

    res.json({ success: true, data: tickets, meta: { total, page, limit, unreadCount } });
  } catch (err) {
    console.error('[Support] adminGetAllTickets:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch tickets' });
  }
};

// ── ADMIN: Get single ticket ──────────────────────────────────────────────────
export const adminGetTicket = async (req, res) => {
  try {
    const ticket = await SupportTicket.findById(req.params.id).lean();
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

    await SupportTicket.updateOne({ _id: ticket._id }, { readByAdmin: true });
    res.json({ success: true, data: ticket });
  } catch (err) {
    console.error('[Support] adminGetTicket:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch ticket' });
  }
};

// ── ADMIN: Reply to ticket ────────────────────────────────────────────────────
export const adminReplyTicket = async (req, res) => {
  try {
    const { message, status } = req.body;
    if (!message?.trim()) return res.status(400).json({ success: false, message: 'Message is required' });

    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

    ticket.replies.push({ authorId: req.user.id, authorRole: 'admin', message: message.trim() });
    ticket.lastReplyAt = new Date();
    ticket.readByUser  = false;
    ticket.readByAdmin = true;
    if (status) ticket.status = status;
    if (status === 'resolved') ticket.resolvedAt = new Date();
    if (status === 'closed')   ticket.closedAt   = new Date();
    await ticket.save();

    // Email notification to user
    try {
      const user = await User.findById(ticket.userId).select('email fullName preferences');
      if (user?.preferences?.emailNotifications?.platformUpdates !== false) {
        await emailService.sendEmail(
          user.email,
          `Re: [Ticket #${ticket._id.toString().slice(-6).toUpperCase()}] ${ticket.subject}`,
          `<p>Hello ${user.fullName || 'there'},</p>
           <p>Your support ticket has received a new reply:</p>
           <blockquote style="border-left:3px solid #6366f1;padding-left:12px;color:#374151">${message.trim()}</blockquote>
           <p>Status: <strong>${ticket.status.replace('_', ' ').toUpperCase()}</strong></p>
           <p><a href="${process.env.CLIENT_URL}/support/tickets/${ticket._id}">View ticket →</a></p>`,
        );
      }
    } catch (e) { /* email is best-effort */ }

    await logAdminAction({
      adminId: req.user.id, adminEmail: req.user.email,
      action: 'ticket_replied',
      targetUserId: ticket.userId, targetEmail: ticket.email,
      targetModel: 'SupportTicket', targetId: ticket._id.toString(),
      description: `Replied to ticket: ${ticket.subject}`,
      ip: req.ip,
    });

    res.json({ success: true, data: ticket });
  } catch (err) {
    console.error('[Support] adminReplyTicket:', err.message);
    res.status(500).json({ success: false, message: 'Failed to reply to ticket' });
  }
};

// ── ADMIN: Update ticket status ───────────────────────────────────────────────
export const adminUpdateTicketStatus = async (req, res) => {
  try {
    const { status, priority } = req.body;
    const update = {};
    if (status)   { update.status = status; if (status === 'resolved') update.resolvedAt = new Date(); if (status === 'closed') update.closedAt = new Date(); }
    if (priority) update.priority = priority;

    const ticket = await SupportTicket.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

    if (status === 'closed') {
      await logAdminAction({
        adminId: req.user.id, adminEmail: req.user.email,
        action: 'ticket_closed',
        targetModel: 'SupportTicket', targetId: ticket._id.toString(),
        description: `Closed ticket: ${ticket.subject}`,
        ip: req.ip,
      });
    }

    res.json({ success: true, data: ticket });
  } catch (err) {
    console.error('[Support] adminUpdateTicketStatus:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update ticket' });
  }
};
