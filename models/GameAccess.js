const mongoose = require('mongoose');

// One document per game. `unlocked` is what players see — teachers always
// bypass this (checked client-side via isTeacher, and server-side via
// teacherCode on the PUT route below) so this collection only ever
// describes player-facing access.
const gameAccessSchema = new mongoose.Schema({
  gameKey: { type: String, required: true, unique: true },
  unlocked: { type: Boolean, default: false },
  // Light audit trail — who last flipped this, and when.
  updatedBy: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('GameAccess', gameAccessSchema);
