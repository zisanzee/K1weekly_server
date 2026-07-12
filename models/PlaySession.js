const mongoose = require('mongoose');

const playSessionSchema = new mongoose.Schema({
  game: { type: String, required: true }, // e.g. "game1", "game2", "game3"
  playerName: { type: String, default: 'Guest' },
  stars: { type: Number, required: true },
  totalRounds: { type: Number, required: true },
  peakStreak: { type: Number, default: 0 },
  completedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('PlaySession', playSessionSchema);
