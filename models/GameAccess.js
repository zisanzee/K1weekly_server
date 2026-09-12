const mongoose = require('mongoose');

const gameAccessSchema = new mongoose.Schema({
  // Game config is now scoped per individual class. Two classes of the same
  // legacy classType no longer share an arrangement — each class owns its own
  // rows and admins/teachers edit them by classId.
  classId: { type: String, required: true, index: true },
  gameKey: { type: String, required: true },

  // A class shows only games added from the game shop.
  added: { type: Boolean, default: false },
  unlocked: { type: Boolean, default: false },

  // When set, this game is due to auto-unlock at this instant. A scheduled row
  // is always locked in the meantime, so this only ever coexists with
  // unlocked:false. The unlock is applied lazily on read (see
  // resolveDueUnlocks in server.js) rather than by a cron, so it still fires
  // correctly after the server has slept through the exact minute.
  unlockAt: { type: Date, default: null },

  // Zero-based order in the admin panel and homepage.
  order: { type: Number, default: 0 },

  // Controls the featured/shiny visual on the homepage.
  shiny: { type: Boolean, default: false },

  updatedBy: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },

  // DEPRECATED backup: pre-migration rows keyed by classType are intentionally
  // retained (not deleted) so a bad migration can be rolled back. They carry no
  // classId and are therefore excluded from the unique index below, which is
  // why the index is partial rather than a plain compound unique index.
  // No default — new per-class rows must OMIT this field entirely rather than
  // store classType:null (which would have collided under the old index).
  classType: { type: String },
});

// One row per {classId, gameKey} for live (classId-keyed) rows. The partial
// filter keeps the legacy classType-only backup rows out of the index so they
// can't collide with the new per-class rows during the transition.
gameAccessSchema.index(
  { classId: 1, gameKey: 1 },
  {
    unique: true,
    partialFilterExpression: { classId: { $exists: true } },
    name: 'classId_1_gameKey_1',
  }
);

module.exports = mongoose.model('GameAccess', gameAccessSchema);
