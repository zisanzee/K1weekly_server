const mongoose = require('mongoose');

const gameAccessSchema = new mongoose.Schema({
  // Game config is now scoped per class type (k1/k2), not per individual
  // class. Every class of the same type shares the identical arrangement.
  classType: {
    type: String,
    required: true,
    enum: ['k1', 'k2'],
    index: true,
    default: 'k1',
  },
  gameKey: { type: String, required: true },

  // A class type shows only games an admin has added from the game shop.
  added: { type: Boolean, default: false },
  unlocked: { type: Boolean, default: false },

  // Zero-based order in the admin panel and homepage.
  order: { type: Number, default: 0 },

  // Controls the featured/shiny visual on the homepage.
  shiny: { type: Boolean, default: false },

  updatedBy: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
});

// One row per {classType, gameKey} — every class of the same type reads
// from the same set of rows.
gameAccessSchema.index({ classType: 1, gameKey: 1 }, { unique: true });

module.exports = mongoose.model('GameAccess', gameAccessSchema);
