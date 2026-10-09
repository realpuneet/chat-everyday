import mongoose from 'mongoose';

const AuditLogSchema = new mongoose.Schema(
  {
    actorId: String,
    actorType: { type: String, enum: ['admin', 'system', 'user'], default: 'system' },
    action: { type: String, required: true, index: true },
    targetType: String,
    targetId: String,
    severity: { type: String, enum: ['info', 'warn', 'critical'], default: 'info' },
    meta: mongoose.Schema.Types.Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
AuditLogSchema.index({ createdAt: -1 });

export const AuditLog = mongoose.models.AuditLog || mongoose.model('AuditLog', AuditLogSchema);
