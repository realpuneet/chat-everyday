import mongoose from 'mongoose';

const RoomSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true },
    name: { type: String, required: true, maxlength: 48 },
    description: { type: String, default: '', maxlength: 200 },
    type: { type: String, enum: ['identity', 'interest', 'custom'], required: true },
    // Self-declared identity gate. Not verified; UI must say so.
    identity: { type: String, enum: ['men', 'women', 'lgbtq', 'everyone'], default: 'everyone' },
    visibility: { type: String, enum: ['public', 'private'], default: 'public' },
    inviteCode: { type: String, index: true, sparse: true },
    adult: { type: Boolean, default: false },
    system: { type: Boolean, default: false },
    ownerId: String,
    moderators: { type: [String], default: [] },
    bannedUsers: { type: [String], default: [] },
    rules: { type: String, default: '', maxlength: 600 },
    slowModeSec: { type: Number, default: 0, min: 0, max: 300 },
    maxMembers: { type: Number, default: 200 },
    filters: {
      blockLinks: { type: Boolean, default: true },
      blockPii: { type: Boolean, default: true },
      badWords: { type: [String], default: [] },
    },
    hidden: { type: Boolean, default: false }, // auto-hidden after reports / admin takedown
    reportCount: { type: Number, default: 0 },
    lastActiveAt: Date,
  },
  { timestamps: true },
);

export const Room = mongoose.models.Room || mongoose.model('Room', RoomSchema);
