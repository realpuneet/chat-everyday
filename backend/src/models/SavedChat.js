import mongoose from 'mongoose';

const { Schema } = mongoose;

// One document per participant (each user owns and may delete their own copy).
const SavedChatSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    chatId: { type: String, required: true },
    peerLabel: { type: String, maxlength: 40 },
    messages: {
      type: [{ ts: Number, from: { type: String, enum: ['me', 'them'] }, iv: String, tag: String, ct: String, _id: false }],
      default: [],
    },
    startedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
SavedChatSchema.index({ ownerId: 1, chatId: 1 }, { unique: true });
SavedChatSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SavedChat = mongoose.models.SavedChat || mongoose.model('SavedChat', SavedChatSchema);
