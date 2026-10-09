import mongoose from 'mongoose';

const BanSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['account', 'ip', 'device', 'identity'], required: true },
    value: { type: String, required: true }, // account: userId; others: HMAC hash (never raw)
    userId: String,
    reason: { type: String, maxlength: 500 },
    category: { type: String, default: 'other' },
    level: { type: Number, default: 1 }, // escalation level
    expiresAt: { type: Date, default: null }, // null = permanent
    active: { type: Boolean, default: true },
    createdBy: { type: String, default: 'system' },
    liftedBy: String,
    liftedAt: Date,
  },
  { timestamps: true },
);
BanSchema.index({ type: 1, value: 1, active: 1 });
BanSchema.index({ userId: 1 });

export const Ban = mongoose.models.Ban || mongoose.model('Ban', BanSchema);
