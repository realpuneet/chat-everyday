import mongoose from 'mongoose';

const { Schema } = mongoose;

const EvidenceMessage = new Schema(
  { seq: Number, ts: Number, senderAlias: String, senderRef: String, kind: String, text: String, imageId: String },
  { _id: false },
);

const ReportSchema = new Schema(
  {
    reporterId: { type: String, index: true },
    reportedId: { type: String, index: true }, // server-side only; admins can see, users never
    context: { kind: { type: String, enum: ['random', 'room', 'image', 'takedown'] }, chatId: String, roomId: String },
    category: {
      type: String,
      enum: ['minor', 'csam', 'nonconsensual', 'sextortion', 'doxxing', 'trafficking', 'threat', 'harassment', 'spam', 'underage_signal', 'other'],
      required: true,
    },
    details: { type: String, maxlength: 1000 },
    priority: { type: String, enum: ['critical', 'high', 'normal'], default: 'normal', index: true },
    evidence: {
      messages: { type: [EvidenceMessage], default: [] },
      images: { type: [{ imageId: String, evidenceKey: String, phash: String, _id: false }], default: [] },
    },
    status: { type: String, enum: ['open', 'actioned', 'dismissed'], default: 'open', index: true },
    action: String,
    resolvedBy: String,
    resolvedAt: Date,
    resolutionNote: String,
  },
  { timestamps: true },
);
ReportSchema.index({ status: 1, priority: 1, createdAt: 1 });

export const Report = mongoose.models.Report || mongoose.model('Report', ReportSchema);
