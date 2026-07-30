require('dotenv').config();

const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const PlaySession = require('./models/PlaySession');
const GameAccess = require('./models/GameAccess');
const Teacher = require('./models/Teacher');
const ClassInfo = require('./models/ClassInfo');
const Student = require('./models/Student');
const { lookupTeacher, getClasses, isKnownClass, seedDirectoryIfEmpty } = require('./directory');

const app = express();

const GAME_KEYS = ['1', '2', '3', '4', '5', '6', '7', 'b1'];
// Accept any non-empty alphanumeric game key — adding new games to the
// frontend catalog no longer requires a server-side edit beyond adding
// the key to GAME_KEYS above.
const GAME_KEY_RE = /^[a-zA-Z0-9_]+$/;
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

// Accept any slug that starts with a letter followed by alphanumeric chars
// (e.g. "game1", "game7", "bonusGame1") — no need to re-deploy the server
// when adding new games to the frontend.
const GAME_SLUG_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    dbState: mongoose.connection.readyState,
  });
});

app.get('/api/classes', async (req, res) => {
  try {
    res.json(await getClasses());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load classes' });
  }
});

// Class name/image plus the teachers assigned to it (derived from Teacher,
// not stored on the class, so it can't go stale).
app.get('/api/classes/:classId', async (req, res) => {
  try {
    const { classId } = req.params;
    if (!(await isKnownClass(classId))) {
      return res.status(404).json({ error: 'Class not found' });
    }

    const [classInfo, teachers] = await Promise.all([
      ClassInfo.findOne({ classId }).lean(),
      Teacher.find({ classId }).select('name -_id').lean(),
    ]);

    res.json({
      classId,
      className: classInfo?.className || classId,
      image: classInfo?.image || null,
      teachers: teachers.map((teacher) => teacher.name),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load class information' });
  }
});

// Roster for a class — teacher-only, same gating style as /api/stats.
app.get('/api/students', async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const students = await Student.find({ classId: teacher.classId })
      .sort({ createdAt: 1 })
      .select('studentId fullName nickname -_id');

    res.json(students);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load students' });
  }
});

// Adds a student to the requesting teacher's own class.
app.post('/api/students', async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const fullName = (req.body.fullName || '').toString().trim().slice(0, 80);
    const nickname = (req.body.nickname || '').toString().trim().slice(0, 40);

    if (!fullName) {
      return res.status(400).json({ error: 'fullName is required' });
    }

    const student = await Student.create({
      classId: teacher.classId,
      fullName,
      nickname,
    });

    res.status(201).json({
      studentId: student.studentId,
      fullName: student.fullName,
      nickname: student.nickname,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not add student' });
  }
});

async function classIdFromRequest(req) {
  const classId = (req.query.classId || req.body?.classId || '')
    .toString()
    .trim();
  return (await isKnownClass(classId)) ? classId : null;
}

async function teacherFromRequest(req) {
  return lookupTeacher(req.query.teacherCode || req.body?.teacherCode);
}

async function requireTeacher(req, res) {
  const teacher = await teacherFromRequest(req);
  if (!teacher) {
    res.status(401).json({ error: 'Invalid or missing teacher code' });
    return null;
  }
  return teacher;
}

async function requireClass(req, res) {
  const classId = await classIdFromRequest(req);
  if (!classId) {
    res.status(400).json({ error: 'A valid classId is required' });
    return null;
  }
  return classId;
}

// Returns only games that the class teacher has added from the shop.
async function getGameAccessRows(classId) {
  const docs = await GameAccess.find({
    classId,
    gameKey: { $in: GAME_KEYS },
    added: true,
  });
  return docs.map((doc) => ({
    gameKey: doc.gameKey,
    unlocked: Boolean(doc.unlocked),
    shiny: Boolean(doc.shiny),
    order: Number.isInteger(doc.order) ? doc.order : GAME_KEYS.indexOf(doc.gameKey),
    updatedBy: doc.updatedBy,
    updatedAt: doc.updatedAt,
  })).sort(
    (a, b) =>
      a.order - b.order ||
      GAME_KEYS.indexOf(a.gameKey) - GAME_KEYS.indexOf(b.gameKey)
  );
}

// Public endpoint used by the homepage, game gates, and teacher panel.
app.get('/api/game-access', async (req, res) => {
  try {
    const classId = await requireClass(req, res);
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
    const teacher = await requireTeacher(req, res);

    if (!teacher) return;

    const addedKeys = await GameAccess.distinct('gameKey', {
      classId: teacher.classId,
      added: true,
    });

    const validList =
      Array.isArray(gameKeys) &&
      gameKeys.length === addedKeys.length &&
      new Set(gameKeys).size === addedKeys.length &&
      gameKeys.every((key) => addedKeys.includes(key));

    if (!validList) {
      return res.status(400).json({
        error: 'gameKeys must contain every game currently added to this class exactly once',
      });
    }

    const updatedAt = new Date();

    await GameAccess.bulkWrite(
      gameKeys.map((gameKey, order) => ({
        updateOne: {
          filter: { classId: teacher.classId, gameKey, added: true },
          update: {
            $set: {
              order,
              updatedBy: teacher.name,
              updatedAt,
            },
          },
          upsert: false,
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

// Adds a game from the teacher's shop. Re-adding a removed game places it at
// the end of the class list and starts it locked.
app.post('/api/game-access/:gameKey', async (req, res) => {
  try {
    const { gameKey } = req.params;
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;
    if (!GAME_KEY_RE.test(gameKey)) {
      return res.status(400).json({ error: `Invalid gameKey: "${gameKey}"` });
    }

    const lastAddedGame = await GameAccess.findOne({
      classId: teacher.classId,
      added: true,
    })
      .sort({ order: -1 })
      .select('order')
      .lean();

    const order = Number.isFinite(lastAddedGame?.order)
      ? lastAddedGame.order + 1
      : 0;

    await GameAccess.findOneAndUpdate(
      // Match a previously removed record as well. Filtering on `added: true`
      // here would upsert a duplicate classId + gameKey document instead.
      { classId: teacher.classId, gameKey },
      {
        $set: {
          added: true,
          unlocked: false,
          shiny: false,
          order,
          updatedBy: teacher.name,
          updatedAt: new Date(),
        },
        $setOnInsert: { classId: teacher.classId },
      },
      { upsert: true, new: true }
    );

    res.status(201).json({ ok: true, rows: await getGameAccessRows(teacher.classId) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not add game to class' });
  }
});

// Keeps a disabled record instead of deleting it, so the legacy class's
// one-time migration never brings a teacher-removed game back.
app.delete('/api/game-access/:gameKey', async (req, res) => {
  try {
    const { gameKey } = req.params;
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;
    if (!GAME_KEY_RE.test(gameKey)) {
      return res.status(400).json({ error: `Invalid gameKey: "${gameKey}"` });
    }

    const doc = await GameAccess.findOneAndUpdate(
      { classId: teacher.classId, gameKey, added: true },
      {
        $set: {
          added: false,
          unlocked: false,
          shiny: false,
          updatedBy: teacher.name,
          updatedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!doc) return res.status(404).json({ error: 'This game is not in the class' });
    res.json({ ok: true, rows: await getGameAccessRows(teacher.classId) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not remove game from class' });
  }
});

// Marks one game as featured/shiny on the homepage.
// This must also remain above /api/game-access/:gameKey.
app.put('/api/game-access/:gameKey/shiny', async (req, res) => {
  try {
    const { gameKey } = req.params;
    const { shiny } = req.body;

    const teacher = await requireTeacher(req, res);

    if (!teacher) return;

    if (!GAME_KEY_RE.test(gameKey)) {
      return res.status(400).json({ error: `Invalid gameKey: "${gameKey}"` });
    }

    if (typeof shiny !== 'boolean') {
      return res.status(400).json({
        error: 'shiny must be true or false',
      });
    }

    const doc = await GameAccess.findOneAndUpdate(
      { classId: teacher.classId, gameKey, added: true },
      {
        $set: {
          shiny,
          updatedBy: teacher.name,
          updatedAt: new Date(),
        },
      },
      {
        new: true,
      }
    );

    if (!doc) return res.status(404).json({ error: 'Add this game to the class first' });

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

    const teacher = await requireTeacher(req, res);

    if (!teacher) return;

    if (!GAME_KEY_RE.test(gameKey)) {
      return res.status(400).json({ error: `Invalid gameKey: "${gameKey}"` });
    }

    if (typeof unlocked !== 'boolean') {
      return res.status(400).json({
        error: 'unlocked must be true or false',
      });
    }

    const doc = await GameAccess.findOneAndUpdate(
      { classId: teacher.classId, gameKey, added: true },
      {
        $set: {
          unlocked,
          updatedBy: teacher.name,
          updatedAt: new Date(),
        },
      },
      {
        new: true,
      }
    );

    if (!doc) return res.status(404).json({ error: 'Add this game to the class first' });

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

    if (!GAME_SLUG_RE.test(game)) {
      return res.status(400).json({ error: `Invalid game slug: "${game}"` });
    }

    const classId = (await isKnownClass(requestedClassId)) ? requestedClassId : null;
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
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    if (!GAME_SLUG_RE.test(game)) {
      return res.status(400).json({ error: `Invalid game slug: "${game}"` });
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
    const teacher = await requireTeacher(req, res);
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
    const teacher = await teacherFromRequest(req);
    const classId = teacher?.classId || (await classIdFromRequest(req));
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
    const teacher = await requireTeacher(req, res);
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
    const classId = await requireClass(req, res);
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

  // The original K1 class had every game available before the shop existed.
  // Mark old settings as added and create a persistent record for every
  // legacy game once. Removed games retain an `added: false` record.
  await GameAccess.updateMany(
    { classId: LEGACY_CLASS_ID, added: { $exists: false } },
    { $set: { added: true } }
  );
  await GameAccess.bulkWrite(
    GAME_KEYS.map((gameKey, order) => ({
      updateOne: {
        filter: { classId: LEGACY_CLASS_ID, gameKey },
        update: {
          $setOnInsert: {
            classId: LEGACY_CLASS_ID,
            gameKey,
            added: true,
            unlocked: false,
            shiny: false,
            order,
          },
        },
        upsert: true,
      },
    }))
  );

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
    await seedDirectoryIfEmpty();
    await migrateLegacyClassData();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });