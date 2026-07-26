require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const PlaySession = require('./models/PlaySession');
const GameAccess = require('./models/GameAccess');
const { lookupTeacher } = require('./teacherCodes');

const app = express();

// Canonical list of homepage game keys — must match GAME_KEYS in the
// frontend's gameAccess.js. Add a new game to both places when you ship one.
const GAME_KEYS = ['1', '2', '3', '4', '5', '6', 'b1'];
const PORT = process.env.PORT || 4000;

// Comma-separated list, e.g.:
//   ALLOWED_ORIGINS=https://k1weekly.netlify.app,http://localhost:5173
// Falls back to the old single-origin var name for compatibility, then to '*'.
const rawOrigins = process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || '*';
const allowedOrigins = rawOrigins
  .split(',')
  .map((o) => o.trim().replace(/\/$/, '')) // strip any trailing slash — Origin headers never have one
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header (curl, server-to-server, health checks) — allow it.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin.replace(/\/$/, ''))) {
        return callback(null, true);
      }
      console.warn(`CORS blocked origin: ${origin}`);
      return callback(new Error('Not allowed by CORS'));
    },
  })
);
app.use(express.json());

// Add every game slug you ship so bad/typo'd data can't sneak into the DB.
const KNOWN_GAMES = ['game1', 'game2', 'game3', 'game4',
   'game5', 'game6', 'game7', 'game8', 'game9', 'game10',
    'bonusGame1', 'bonusGame2', 'bonusGame3', 'bonusGame4',
     'bonusGame5', 'bonusGame6', 'bonusGame7', 'bonusGame8',
      'bonusGame9', 'bonusGame10'];

// Hit this after deploying to confirm the server + database are both alive.
// dbState: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
app.get('/api/health', (req, res) => {
  res.json({ ok: true, dbState: mongoose.connection.readyState });
});

// Which games are unlocked for players right now — public, no teacher code
// needed. The homepage and the direct-URL gate both call this on load.
// Any game key that doesn't have a document yet defaults to locked, so a
// brand new game is "coming soon" until a teacher explicitly flips it on.
app.get('/api/game-access', async (req, res) => {
  try {
    const docs = await GameAccess.find({ gameKey: { $in: GAME_KEYS } });
    const byKey = new Map(docs.map((d) => [d.gameKey, d]));

    const rows = GAME_KEYS.map((gameKey) => {
      const doc = byKey.get(gameKey);
      return {
        gameKey,
        unlocked: doc ? doc.unlocked : false,
        updatedBy: doc ? doc.updatedBy : null,
        updatedAt: doc ? doc.updatedAt : null,
      };
    });

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load game access' });
  }
});

// Lock/unlock one game. Requires a valid teacher code in the body — this
// is the actual security boundary, not the frontend's isTeacher flag.
app.put('/api/game-access/:gameKey', async (req, res) => {
  try {
    const { gameKey } = req.params;
    const { unlocked, teacherCode } = req.body;

    const teacherName = lookupTeacher(teacherCode);
    if (!teacherName) {
      return res.status(401).json({ error: 'Invalid or missing teacher code' });
    }

    if (!GAME_KEYS.includes(gameKey)) {
      return res.status(400).json({ error: `gameKey must be one of: ${GAME_KEYS.join(', ')}` });
    }

    if (typeof unlocked !== 'boolean') {
      return res.status(400).json({ error: 'unlocked must be true or false' });
    }

    const doc = await GameAccess.findOneAndUpdate(
      { gameKey },
      { unlocked, updatedBy: teacherName, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ ok: true, gameKey: doc.gameKey, unlocked: doc.unlocked, updatedBy: doc.updatedBy });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update game access' });
  }
});

// Log one completed play session.
app.post('/api/plays', async (req, res) => {
  try {
    const { game, playerName, stars, totalRounds, peakStreak, elapsedSeconds, mistakes, device } = req.body;

    if (!KNOWN_GAMES.includes(game)) {
      return res.status(400).json({ error: `game must be one of: ${KNOWN_GAMES.join(', ')}` });
    }

    const safeTotalRounds = Number(totalRounds) || 0;
    const safeStars = Math.max(0, Math.min(Number(stars) || 0, safeTotalRounds || 999));
    // Only set when the caller actually sent a value — round/star-based
    // games never send this, and there's no sensible zero-default for it.
    const safeElapsedSeconds =
      elapsedSeconds === undefined || elapsedSeconds === null ? undefined : Math.max(0, Number(elapsedSeconds) || 0);
    const safeMistakes = Math.max(0, Number(mistakes) || 0);

    // Trust nothing from the client beyond a coarse, bounded shape — this is
    // for "what device is this lagging on" diagnostics, not anything strict.
    const KNOWN_DEVICE_KINDS = ['mobile', 'tablet', 'desktop', 'unknown'];
    const safeDevice =
      device && typeof device === 'object'
        ? {
            kind: KNOWN_DEVICE_KINDS.includes(device.kind) ? device.kind : 'unknown',
            os: (device.os || 'Unknown OS').toString().slice(0, 40),
            browser: (device.browser || 'Unknown browser').toString().slice(0, 40),
            userAgent: (device.userAgent || '').toString().slice(0, 300),
          }
        : undefined;

    const session = await PlaySession.create({
      game,
      playerName: (playerName || 'Guest').toString().slice(0, 40),
      stars: safeStars,
      totalRounds: safeTotalRounds,
      peakStreak: Math.max(0, Number(peakStreak) || 0),
      elapsedSeconds: safeElapsedSeconds,
      mistakes: safeMistakes,
      device: safeDevice,
    });

    res.status(201).json({ ok: true, id: session._id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save play session' });
  }
});

// Delete every play session for one player in one game.
app.delete('/api/plays', async (req, res) => {
  try {
    const { game, playerName } = req.body;

    if (!KNOWN_GAMES.includes(game)) {
      return res.status(400).json({
        error: `game must be one of: ${KNOWN_GAMES.join(', ')}`
      });
    }

    const result = await PlaySession.deleteMany({
      game,
      playerName,
    });

    res.json({
      ok: true,
      deleted: result.deletedCount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Could not delete play sessions',
    });
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

// One row per player+game — times played, best/last score, best streak.
app.get('/api/summary', async (req, res) => {
  try {
    const summary = await PlaySession.aggregate([
      { $sort: { completedAt: 1 } },
      {
        $group: {
          _id: { playerName: '$playerName', game: '$game' },
          timesPlayed: { $sum: 1 },
          bestStars: { $max: '$stars' },
          lastStars: { $last: '$stars' },
          totalRounds: { $last: '$totalRounds' },
          bestStreak: { $max: '$peakStreak' },
          lastPlayedAt: { $max: '$completedAt' },
        },
      },
      {
        $project: {
          _id: 0,
          playerName: '$_id.playerName',
          game: '$_id.game',
          timesPlayed: 1,
          bestStars: 1,
          lastStars: 1,
          totalRounds: 1,
          bestStreak: 1,
          lastPlayedAt: 1,
        },
      },
      { $sort: { playerName: 1, game: 1 } },
    ]);
    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load summary' });
  }
});

// Every individual play session, uncollapsed — used by the "show all plays"
// view in the teacher dashboard (the summary above already groups repeat
// plays by player+game, so this is the only place to see each play on its
// own row). Most recent first.
app.get('/api/plays', async (req, res) => {
  try {
    const plays = await PlaySession.find({})
      .sort({ completedAt: -1 })
      .select('playerName game stars totalRounds peakStreak elapsedSeconds mistakes completedAt device -_id');
    res.json(plays);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load play sessions' });
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