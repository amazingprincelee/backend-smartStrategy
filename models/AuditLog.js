import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema({
  adminId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  adminEmail:   { type: String },   // denormalized for easy display

  action: {
    type: String,
    enum: [
      'user_role_changed',
      'user_deactivated',
      'user_activated',
      'user_deleted',
      'premium_granted',
      'trial_granted',
      'broadcast_email',
      'broadcast_notification',
      'withdrawal_approved',
      'withdrawal_rejected',
      'withdrawal_paid',
      'ticket_replied',
      'ticket_closed',
      'settings_updated',
      'admin_login',
    ],
    required: true,
    index: true,
  },

  targetUserId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  targetEmail:   { type: String, default: null },  // denormalized
  targetModel:   { type: String, default: null },  // 'User', 'SupportTicket', etc.
  targetId:      { type: String, default: null },  // stringified ObjectId of affected doc

  description:   { type: String, default: '' },
  metadata:      { type: mongoose.Schema.Types.Mixed, default: {} },
  ip:            { type: String, default: null },
}, { timestamps: true });

auditLogSchema.index({ createdAt: -1 });

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

/**
 * Helper: log an admin action — fire-and-forget (non-blocking).
 */
export async function logAdminAction({ adminId, adminEmail, action, targetUserId, targetEmail, targetModel, targetId, description, metadata, ip } = {}) {
  try {
    await AuditLog.create({ adminId, adminEmail, action, targetUserId, targetEmail, targetModel, targetId, description: description || '', metadata: metadata || {}, ip: ip || null });
  } catch (err) {
    console.warn('[AuditLog] Failed to log admin action:', err.message);
  }
}

export default AuditLog;
