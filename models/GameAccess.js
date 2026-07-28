const mongoose = require('mongoose');

const gameAccessSchema = new mongoose.Schema({
  // Settings belong to a class, not to the whole site. The default keeps
  // records created before class support in the original K1 class.
  classId: { type: String, required: true, default: 'k12026-pny', index: true },
  gameKey: { type: String, required: true },
  unlocked: { type: Boolean, default: false },

  // Zero-based order in the teacher panel and homepage.
  order: { type: Number, default: 0 },

  // Controls the featured/shiny visual on the homepage.
  shiny: { type: Boolean, default: false },

  updatedBy: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
});

gameAccessSchema.index({ classId: 1, gameKey: 1 }, { unique: true });

module.exports = mongoose.model('GameAccess', gameAccessSchema);
