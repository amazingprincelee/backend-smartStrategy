import mongoose from 'mongoose';

const replySchema = new mongoose.Schema({
  authorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  authorRole: { type: String, enum: ['user', 'admin'], required: true },
  message:    { type: String, required: true, maxlength: 5000 },
  createdAt:  { type: Date, default: Date.now },
});

const supportTicketSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  email:    { type: String },   // denormalized for admin queries

  subject:  { type: String, required: true, maxlength: 200 },
  message:  { type: String, required: true, maxlength: 5000 },

  category: {
    type: String,
    enum: ['billing', 'bot', 'signal', 'arbitrage', 'account', 'withdrawal', 'other'],
    default: 'other',
  },

  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium',
  },

  status: {
    type: String,
    enum: ['open', 'in_progress', 'waiting_user', 'resolved', 'closed'],
    default: 'open',
    index: true,
  },

  replies: [replySchema],

  assignedTo:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  resolvedAt:  { type: Date, default: null },
  closedAt:    { type: Date, default: null },
  lastReplyAt: { type: Date, default: null },
  readByAdmin: { type: Boolean, default: false },
  readByUser:  { type: Boolean, default: true },
}, { timestamps: true });

supportTicketSchema.index({ createdAt: -1 });
supportTicketSchema.index({ status: 1, createdAt: -1 });

const SupportTicket = mongoose.model('SupportTicket', supportTicketSchema);
export default SupportTicket;
