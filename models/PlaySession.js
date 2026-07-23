const mongoose = require('mongoose');

const playSessionSchema = new mongoose.Schema({
  game: { type: String, required: true }, // e.g. "game1", "game2", "game3"
  playerName: { type: String, default: 'Guest' },
  stars: { type: Number, required: true },
  totalRounds: { type: Number, required: true },
  peakStreak: { type: Number, default: 0 },
  // Only populated by time-trial style games (e.g. the bonus Phaser games)
  // that don't naturally fit the round/star scoring the numbered games use.
  elapsedSeconds: { type: Number },
  mistakes: { type: Number, default: 0 },
  completedAt: { type: Date, default: Date.now },
  // Coarse device info captured client-side at the end of a play session —
  // handy for spotting "this game lags on X" patterns in the classroom.
  // Note: the inner classification field is called `kind`, not `type` —
  // Mongoose reads a nested `type` key as a type-declaration shorthand,
  // which would break this subdocument.
  device: {
    kind: { type: String, enum: ['mobile', 'tablet', 'desktop', 'unknown'], default: 'unknown' },
    os: { type: String, default: 'Unknown OS' },
    browser: { type: String, default: 'Unknown browser' },
    userAgent: { type: String },
  },
});

module.exports = mongoose.model('PlaySession', playSessionSchema);