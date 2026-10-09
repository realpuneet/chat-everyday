import mongoose from 'mongoose';

const TakedownSchema = new mongoose.Schema(
  {
    requesterName: { type: String, maxlength: 100 },
    requesterContact: { type: String, maxlength: 200 }, // email or phone; PII, restricted to admins
    category: { type: String, enum: ['nonconsensual', 'csam', 'impersonation', 'privacy', 'copyright', 'other'], default: 'other' },
    reference: { type: String, maxlength: 500 }, // image id / room id / description
    description: { type: String, maxlength: 2000 },
    status: { type: String, enum: ['open', 'actioned', 'rejected'], default: 'open', index: true },
    dueAt: Date, // statutory timeline tracking (see docs/legal.md)
    resolvedBy: String,
    resolvedAt: Date,
    note: String,
  },
  { timestamps: true },
);

export const Takedown = mongoose.models.Takedown || mongoose.model('Takedown', TakedownSchema);
