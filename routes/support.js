import express from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import {
  createTicket,
  getUserTickets,
  getTicketById,
  replyToTicket,
  adminGetAllTickets,
  adminGetTicket,
  adminReplyTicket,
  adminUpdateTicketStatus,
} from '../controllers/supportController.js';

const router = express.Router();

// ── User routes (auth required) ───────────────────────────────────────────────
router.post('/',           authenticate, createTicket);
router.get('/',            authenticate, getUserTickets);
router.get('/:id',         authenticate, getTicketById);
router.post('/:id/reply',  authenticate, replyToTicket);

// ── Admin routes ──────────────────────────────────────────────────────────────
router.get('/admin/all',              authenticate, requireAdmin, adminGetAllTickets);
router.get('/admin/:id',              authenticate, requireAdmin, adminGetTicket);
router.post('/admin/:id/reply',       authenticate, requireAdmin, adminReplyTicket);
router.patch('/admin/:id/status',     authenticate, requireAdmin, adminUpdateTicketStatus);

export default router;
