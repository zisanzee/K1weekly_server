require('dotenv').config();
const dns = require('dns');
   dns.setServers(['8.8.8.8', '1.1.1.1']);
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const PlaySession = require('./models/PlaySession');

const app = express();
const PORT = process.env.PORT || 4000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

// Add every game slug you ship so bad/typo'd data can't sneak into the DB.
const KNOWN_GAMES = ['game1', 'game2', 'game3'];

// Hit this after deploying to confirm the server + database are both alive.
// dbState: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
app.get('/api/health', (req, res) => {
  res.json({ ok: true, dbState: mongoose.connection.readyState });
});

// Log one completed play session.
app.post('/api/plays', async (req, res) => {
  try {
    const { game, playerName, stars, totalRounds, peakStreak } = req.body;

    if (!KNOWN_GAMES.includes(game)) {
      return res.status(400).json({ error: `game must be one of: ${KNOWN_GAMES.join(', ')}` });
    }

    const safeTotalRounds = Number(totalRounds) || 0;
    const safeStars = Math.max(0, Math.min(Number(stars) || 0, safeTotalRounds || 999));

    const session = await PlaySession.create({
      game,
      playerName: (playerName || 'Guest').toString().slice(0, 40),
      stars: safeStars,
      totalRounds: safeTotalRounds,
      peakStreak: Math.max(0, Number(peakStreak) || 0),
    });

    res.status(201).json({ ok: true, id: session._id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save play session' });
  }
});

// Overall totals plus a per-game breakdown.
app.get('/api/stats', async (req, res) => {
  try {
    const totalPlays = await PlaySession.countDocuments();
    const uniquePlayers = (await PlaySession.distinct('playerName')).length;

    const perGame = await PlaySession.aggregate([
      {
        $group: {
          _id: '$game',
          plays: { $sum: 1 },
          avgStars: { $avg: '$stars' },
          bestStreak: { $max: '$peakStreak' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({ totalPlays, uniquePlayers, perGame });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load stats' });
  }
});

// Top 10 runs for a single game, best score first.
app.get('/api/leaderboard/:game', async (req, res) => {
  try {
    const top = await PlaySession.find({ game: req.params.game })
      .sort({ stars: -1, peakStreak: -1 })
      .limit(10)
      .select('playerName stars peakStreak completedAt -_id');
    res.json(top);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load leaderboard' });
  }
});

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
