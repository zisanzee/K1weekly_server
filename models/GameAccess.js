const mongoose = require('mongoose');

const gameAccessSchema = new mongoose.Schema({
  gameKey: { type: String, required: true, unique: true },
  unlocked: { type: Boolean, default: false },

  // Zero-based order in the teacher panel and homepage.
  order: { type: Number, default: 0 },

  // Controls the featured/shiny visual on the homepage.
  shiny: { type: Boolean, default: false },

  updatedBy: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('GameAccess', gameAccessSchema);