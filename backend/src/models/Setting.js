import mongoose from 'mongoose';

const SettingSchema = new mongoose.Schema(
  { key: { type: String, unique: true, required: true }, value: mongoose.Schema.Types.Mixed, updatedBy: String },
  { timestamps: true },
);

export const Setting = mongoose.models.Setting || mongoose.model('Setting', SettingSchema);
