import mongoose from 'mongoose';

const { Schema } = mongoose;

const UserSchema = new Schema(
  {
    kind: { type: String, enum: ['guest', 'registered'], default: 'guest', index: true },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    nickname: { type: String, required: true, maxlength: 32 },
    avatar: { emoji: String, color: String },
    // SELF-DECLARED and unverified. Never present it to other users as verified.
    gender: { type: String, enum: ['male', 'female', 'nonbinary', 'undisclosed'], default: 'undisclosed' },
    lgbtq: { type: Boolean, default: false }, // self-declared, unverified; gates the LGBTQ+ room only
    lang: { type: String, default: '', maxlength: 8 },
    interests: { type: [String], default: [] },

    email: { type: String, lowercase: true, trim: true },
    passwordHash: String,
    googleSub: String,
    phoneHash: String,
    phoneLast4: String,

    // Age: we never store the DOB, only that an adult declaration was made and how strong it is.
    ageDeclaredAt: Date,
    ageLevel: { type: String, enum: ['declared', 'phone', 'google', 'strict'], default: 'declared' },

    blocked: { type: [String], default: [] },
    deviceHashes: { type: [String], default: [] },
    ipHashes: { type: [String], default: [] },
    strikes: { type: Number, default: 0 },
    banCount: { type: Number, default: 0 },

    totpSecret: String,
    totpEnabled: { type: Boolean, default: false },

    lastSeenAt: Date,
    guestSessionStartedAt: Date,
    expiresAt: Date, // guests only (TTL + sweeper)
  },
  { timestamps: true },
);

UserSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
UserSchema.index({ googleSub: 1 }, { unique: true, partialFilterExpression: { googleSub: { $type: 'string' } } });
UserSchema.index({ phoneHash: 1 }, { unique: true, partialFilterExpression: { phoneHash: { $type: 'string' } } });
UserSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { kind: 'guest' } });

UserSchema.methods.toPublicSelf = function toPublicSelf() {
  return {
    id: String(this._id),
    kind: this.kind,
    role: this.role,
    nickname: this.nickname,
    avatar: this.avatar,
    gender: this.gender,
    lgbtq: this.lgbtq,
    lang: this.lang,
    interests: this.interests,
    ageLevel: this.ageLevel,
    hasEmail: !!this.email,
    hasPhone: !!this.phoneHash,
    hasGoogle: !!this.googleSub,
    totpEnabled: this.totpEnabled,
  };
};

export const User = mongoose.models.User || mongoose.model('User', UserSchema);
