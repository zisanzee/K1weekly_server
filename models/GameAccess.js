const mongoose = require('mongoose');

const gameAccessSchema = new mongoose.Schema({
  gameKey: { type: String, required: true, unique: true },
  unlocked: { type: Boolean, default: false },

  // Zero-based position in the homepage and teacher panel.
  order: { type: Number, default: 0 },

  updatedBy: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('GameAccess', gameAccessSchema);