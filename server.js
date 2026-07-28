require('dotenv').config();

const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const PlaySession = require('./models/PlaySession');
const GameAccess = require('./models/GameAccess');
const { lookupTeacher, getClasses, isKnownClass } = require('./teacherCodes');

const app = express();

const GAME_KEYS = ['1', '2', '3', '4', '5', '6', 'b1'];
const PORT = process.env.PORT || 4000;
const LEGACY_CLASS_ID = 'k12026-pny';

const rawOrigins =
  process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || '*';

const allowedOrigins = rawOrigins
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allows curl, server health checks, and other requests without Origin.
      if (!origin) return callback(null, true);

      const normalizedOrigin = origin.replace(/\/$/, '');

      if (
        allowedOrigins.includes('*') ||
        allowedOrigins.includes(normalizedOrigin)
      ) {
        return callback(null, true);
      }

      console.warn(`CORS blocked origin: ${origin}`);
      return callback(new Error('Not allowed by CORS'));
    },
  })
);

app.use(express.json());

const KNOWN_GAMES = [
  'game1',
  'game2',
  'game3',
  'game4',
  'game5',
  'game6',
  'game7',
  'game8',
  'game9',
  'game10',
  'bonusGame1',
  'bonusGame2',
  'bonusGame3',
  'bonusGame4',
  'bonusGame5',
  'bonusGame6',
  'bonusGame7',
  'bonusGame8',
  'bonusGame9',
  'bonusGame10',
];

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    dbState: mongoose.connection.readyState,
  });
});

app.get('/api/classes', (req, res) => {
  res.json(getClasses());
});

function classIdFromRequest(req) {
  const classId = (req.query.classId || req.body?.classId || '')
    .toString()
    .trim();
  return isKnownClass(classId) ? classId : null;
}

function teacherFromRequest(req) {
  return lookupTeacher(req.query.teacherCode || req.body?.teacherCode);
}

function requireTeacher(req, res) {
  const teacher = teacherFromRequest(req);
  if (!teacher) {
    res.status(401).json({ error: 'Invalid or missing teacher code' });
    return null;
  }
  return teacher;
}

function requireClass(req, res) {
  const classId = classIdFromRequest(req);
  if (!classId) {
    res.status(400).json({ error: 'A valid classId is required' });
    return null;
  }
  return classId;
}

// Produces a complete ordered game list even before every game has a MongoDB
// document. Existing data without `order` or `shiny` safely uses defaults.
async function getGameAccessRows(classId) {
  const docs = await GameAccess.find({
    classId,
    gameKey: { $in: GAME_KEYS },
  });

  const byKey = new Map(docs.map((doc) => [doc.gameKey, doc]));

  return GAME_KEYS.map((gameKey, defaultOrder) => {
    const doc = byKey.get(gameKey);

    return {
      gameKey,
      unlocked: doc ? Boolean(doc.unlocked) : false,
      shiny: doc ? Boolean(doc.shiny) : false,
      order: Number.isInteger(doc?.order) ? doc.order : defaultOrder,
      updatedBy: doc ? doc.updatedBy : null,
      updatedAt: doc ? doc.updatedAt : null,
    };
  }).sort(
    (a, b) =>
      a.order - b.order ||
      GAME_KEYS.indexOf(a.gameKey) - GAME_KEYS.indexOf(b.gameKey)
  );
}

// Public endpoint used by the homepage, game gates, and teacher panel.
app.get('/api/game-access', async (req, res) => {
  try {
    const classId = requireClass(req, res);
    if (!classId) return;
    res.json(await getGameAccessRows(classId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load game access' });
  }
});

// Saves the complete homepage game order after teacher drag-and-drop.
// This must stay above /api/game-access/:gameKey.
app.put('/api/game-access/order', async (req, res) => {
  try {
    const { gameKeys } = req.body;
    const teacher = requireTeacher(req, res);

    if (!teacher) return;

    const validList =
      Array.isArray(gameKeys) &&
      gameKeys.length === GAME_KEYS.length &&
      new Set(gameKeys).size === GAME_KEYS.length &&
      gameKeys.every((key) => GAME_KEYS.includes(key));

    if (!validList) {
      return res.status(400).json({
        error: `gameKeys must contain every game exactly once: ${GAME_KEYS.join(', ')}`,
      });
    }

    const updatedAt = new Date();

    await GameAccess.bulkWrite(
      gameKeys.map((gameKey, order) => ({
        updateOne: {
          filter: { classId: teacher.classId, gameKey },
          update: {
            $set: {
              order,
              updatedBy: teacher.name,
              updatedAt,
            },
            $setOnInsert: {
              classId: teacher.classId,
              unlocked: false,
              shiny: false,
            },
          },
          upsert: true,
        },
      }))
    );

    res.json({
      ok: true,
      rows: await getGameAccessRows(teacher.classId),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save game order' });
  }
});

// Marks one game as featured/shiny on the homepage.
// This must also remain above /api/game-access/:gameKey.
app.put('/api/game-access/:gameKey/shiny', async (req, res) => {
  try {
    const { gameKey } = req.params;
    const { shiny } = req.body;

    const teacher = requireTeacher(req, res);

    if (!teacher) return;

    if (!GAME_KEYS.includes(gameKey)) {
      return res.status(400).json({
        error: `gameKey must be one of: ${GAME_KEYS.join(', ')}`,
      });
    }

    if (typeof shiny !== 'boolean') {
      return res.status(400).json({
        error: 'shiny must be true or false',
      });
    }

    const doc = await GameAccess.findOneAndUpdate(
      { classId: teacher.classId, gameKey },
      {
        $set: {
          shiny,
          updatedBy: teacher.name,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          classId: teacher.classId,
          unlocked: false,
          order: GAME_KEYS.indexOf(gameKey),
        },
      },
      {
        upsert: true,
        new: true,
      }
    );

    res.json({
      ok: true,
      gameKey: doc.gameKey,
      shiny: doc.shiny,
      updatedBy: doc.updatedBy,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Could not update shiny game setting',
    });
  }
});

// Locks or unlocks one game for players.
app.put('/api/game-access/:gameKey', async (req, res) => {
  try {
    const { gameKey } = req.params;
    const { unlocked } = req.body;

    const teacher = requireTeacher(req, res);

    if (!teacher) return;

    if (!GAME_KEYS.includes(gameKey)) {
      return res.status(400).json({
        error: `gameKey must be one of: ${GAME_KEYS.join(', ')}`,
      });
    }

    if (typeof unlocked !== 'boolean') {
      return res.status(400).json({
        error: 'unlocked must be true or false',
      });
    }

    const doc = await GameAccess.findOneAndUpdate(
      { classId: teacher.classId, gameKey },
      {
        $set: {
          unlocked,
          updatedBy: teacher.name,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          classId: teacher.classId,
          order: GAME_KEYS.indexOf(gameKey),
          shiny: false,
        },
      },
      {
        upsert: true,
        new: true,
      }
    );

    res.json({
      ok: true,
      gameKey: doc.gameKey,
      unlocked: doc.unlocked,
      shiny: Boolean(doc.shiny),
      order: doc.order,
      updatedBy: doc.updatedBy,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Could not update game access',
    });
  }
});

// Log one completed play session.
app.post('/api/plays', async (req, res) => {
  try {
    const {
      game,
      playerName,
      classId: requestedClassId,
      stars,
      totalRounds,
      peakStreak,
      elapsedSeconds,
      mistakes,
      device,
    } = req.body;

    if (!KNOWN_GAMES.includes(game)) {
      return res.status(400).json({
        error: `game must be one of: ${KNOWN_GAMES.join(', ')}`,
      });
    }

    const classId = isKnownClass(requestedClassId) ? requestedClassId : null;
    if (!classId) {
      return res.status(400).json({ error: 'A valid classId is required' });
    }

    const safeTotalRounds = Number(totalRounds) || 0;
    const safeStars = Math.max(
      0,
      Math.min(Number(stars) || 0, safeTotalRounds || 999)
    );

    const safeElapsedSeconds =
      elapsedSeconds === undefined || elapsedSeconds === null
        ? undefined
        : Math.max(0, Number(elapsedSeconds) || 0);

    const safeMistakes = Math.max(0, Number(mistakes) || 0);

    const knownDeviceKinds = ['mobile', 'tablet', 'desktop', 'unknown'];

    const safeDevice =
      device && typeof device === 'object'
        ? {
            kind: knownDeviceKinds.includes(device.kind)
              ? device.kind
              : 'unknown',
            os: (device.os || 'Unknown OS').toString().slice(0, 40),
            browser: (device.browser || 'Unknown browser')
              .toString()
              .slice(0, 40),
            userAgent: (device.userAgent || '').toString().slice(0, 300),
          }
        : undefined;

    const session = await PlaySession.create({
      classId,
      game,
      playerName: (playerName || 'Guest').toString().slice(0, 40),
      stars: safeStars,
      totalRounds: safeTotalRounds,
      peakStreak: Math.max(0, Number(peakStreak) || 0),
      elapsedSeconds: safeElapsedSeconds,
      mistakes: safeMistakes,
      device: safeDevice,
    });

    res.status(201).json({
      ok: true,
      id: session._id,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Could not save play session',
    });
  }
});

// Delete every play session for one player in one game.
app.delete('/api/plays', async (req, res) => {
  try {
    const { game, playerName } = req.body;
    const teacher = requireTeacher(req, res);
    if (!teacher) return;

    if (!KNOWN_GAMES.includes(game)) {
      return res.status(400).json({
        error: `game must be one of: ${KNOWN_GAMES.join(', ')}`,
      });
    }

    const result = await PlaySession.deleteMany({
      classId: teacher.classId,
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

// Overall totals and per-game statistics.
app.get('/api/stats', async (req, res) => {
  try {
    const teacher = requireTeacher(req, res);
    if (!teacher) return;
    const match = { classId: teacher.classId };
    const totalPlays = await PlaySession.countDocuments(match);
    const uniquePlayers = (await PlaySession.distinct('playerName', match)).length;

    const perGame = await PlaySession.aggregate([
      { $match: match },
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

    res.json({
      totalPlays,
      uniquePlayers,
      perGame,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Could not load stats',
    });
  }
});

// One row per player and game.
app.get('/api/summary', async (req, res) => {
  try {
    const teacher = teacherFromRequest(req);
    const classId = teacher?.classId || classIdFromRequest(req);
    const playerName = (req.query.playerName || '').toString().trim();

    if (!classId || (!teacher && !playerName)) {
      return res.status(400).json({
        error: 'Use a teacher code, or provide a valid classId and playerName',
      });
    }

    const match = { classId };
    if (!teacher) match.playerName = playerName;

    const summary = await PlaySession.aggregate([
      { $match: match },
      { $sort: { completedAt: 1 } },
      {
        $group: {
          _id: {
            playerName: '$playerName',
            game: '$game',
          },
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
      {
        $sort: {
          playerName: 1,
          game: 1,
        },
      },
    ]);

    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Could not load summary',
    });
  }
});

// Every play session, newest first.
app.get('/api/plays', async (req, res) => {
  try {
    const teacher = requireTeacher(req, res);
    if (!teacher) return;
    const plays = await PlaySession.find({ classId: teacher.classId })
      .sort({ completedAt: -1 })
      .select(
        'playerName game stars totalRounds peakStreak elapsedSeconds mistakes completedAt device -_id'
      );

    res.json(plays);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Could not load play sessions',
    });
  }
});

// Top ten runs for one game.
app.get('/api/leaderboard/:game', async (req, res) => {
  try {
    const classId = requireClass(req, res);
    if (!classId) return;
    const top = await PlaySession.find({
      classId,
      game: req.params.game,
    })
      .sort({
        stars: -1,
        peakStreak: -1,
      })
      .limit(10)
      .select('playerName stars peakStreak completedAt -_id');

    res.json(top);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Could not load leaderboard',
    });
  }
});

async function migrateLegacyClassData() {
  // All existing documents were created for the original K1 class. This is
  // safe to run on every boot and lets old data keep showing up immediately.
  await Promise.all([
    PlaySession.updateMany(
      { classId: { $exists: false } },
      { $set: { classId: LEGACY_CLASS_ID } }
    ),
    GameAccess.updateMany(
      { classId: { $exists: false } },
      { $set: { classId: LEGACY_CLASS_ID } }
    ),
  ]);

  // Old releases created a globally-unique gameKey index. Replace it with
  // the classId + gameKey index declared by the model so every class can
  // maintain its own settings.
  try {
    await GameAccess.collection.dropIndex('gameKey_1');
  } catch (err) {
    if (err.codeName !== 'IndexNotFound' && err.code !== 27) throw err;
  }

  await GameAccess.syncIndexes();
  await PlaySession.syncIndexes();
}

mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    await migrateLegacyClassData();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
