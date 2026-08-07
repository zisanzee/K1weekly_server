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
const {
  lookupTeacher,
  getClasses,
  isKnownClass,
  seedDirectoryIfEmpty,
  classTypeForClassId,
} = require('./directory');

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

// Prevent browsers from caching any API response. Without this, a stale
// cached 5xx or empty response can lock users on the loading spinner even
// after the server recovers — the only fix would be manually clearing
// their cache. Applies to every route; individual routes can override if
// needed (none do for now).
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  next();
});

// Hard request timeout — if any route handler (including slow DB queries)
// takes longer than 15 s, the connection is terminated with a 504 so the
// client gets a clear signal instead of an indefinite hang.
app.use((_req, res, next) => {
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'Request timed out — please try again.' });
    }
  }, 15_000);

  res.on('finish', () => clearTimeout(timer));
  res.on('close', () => clearTimeout(timer));

  next();
});

// Accept any slug that starts with a letter followed by alphanumeric chars
// (e.g. "game1", "game7", "bonusGame1") — no need to re-deploy the server
// when adding new games to the frontend.
const GAME_SLUG_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;

app.get('/api/health', async (req, res) => {
  try {
    // A real round-trip to MongoDB — this keeps the connection pool warm
    // for the cron job (Render spin-down prevention) and prevents MongoDB
    // Atlas free-tier clusters from pausing after inactivity. The ping is
    // sub-millisecond when the connection is already established.
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db.admin().ping();
    }
    res.json({ ok: true, dbState: mongoose.connection.readyState });
  } catch {
    res.status(503).json({ ok: false, dbState: mongoose.connection.readyState });
  }
});

// Validates a teacher code against the DB and returns everything the
// frontend needs to populate the zustand player store. This replaces the
// old hardcoded TEACHER_CODES mirror — the server is the single source of
// truth for teacher auth.
app.post('/api/teacher-login', async (req, res) => {
  try {
    const { code } = req.body;
    const teacher = await lookupTeacher(code);
    if (!teacher) {
      return res.status(401).json({ error: 'Invalid teacher code' });
    }
    res.json(teacher);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not validate teacher code' });
  }
});

app.get('/api/classes', async (req, res) => {
  try {
    res.json(await getClasses());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load classes' });
  }
});

// Class name/image/classType plus the teachers assigned to it (derived from
// Teacher, not stored on the class, so it can't go stale).
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
      classType: classInfo?.classType || 'k1',
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
      .select('studentId fullName nickname group code -_id');

    res.json(students);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load students' });
  }
});

// Adds a student to the requesting teacher's own class. The frontend
// generates a 6-char login code — the server stores it as-is and
// enforces uniqueness via the model's unique index.
app.post('/api/students', async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const nickname = (req.body.nickname || '').toString().trim().slice(0, 40);
    const fullName = (req.body.fullName || nickname || '').toString().trim().slice(0, 80);
    const group = (req.body.group || '').toString().trim().slice(0, 40);
    const code = (req.body.code || '').toString().trim().toUpperCase();

    if (!nickname) {
      return res.status(400).json({ error: 'nickname is required' });
    }

    if (!code || code.length !== 6) {
      return res.status(400).json({ error: 'A 6-character student code is required' });
    }

    // Check for duplicate code before attempting insert — gives a cleaner
    // error message than letting Mongo's unique constraint fail.
    const existing = await Student.findOne({ code });
    if (existing) {
      return res.status(409).json({ error: 'This code is already in use. Please try again.' });
    }

    const student = await Student.create({
      classId: teacher.classId,
      fullName,
      nickname,
      group,
      code,
    });

    res.status(201).json({
      studentId: student.studentId,
      fullName: student.fullName,
      nickname: student.nickname,
      group: student.group,
      code: student.code,
    });
  } catch (err) {
    console.error(err);
    // If the unique constraint fires despite the pre-check (race condition),
    // return a friendly message instead of the raw Mongo error.
    if (err.code === 11000) {
      return res.status(409).json({ error: 'This code is already in use. Please try again.' });
    }
    res.status(500).json({ error: 'Could not add student' });
  }
});

// Update a student's nickname and/or group. The code cannot be edited.
// Teacher-only, scoped to their own class.
app.put('/api/students/:studentId', async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const { studentId } = req.params;
    const nickname = (req.body.nickname || '').toString().trim().slice(0, 40);
    const group = (req.body.group || '').toString().trim().slice(0, 40);

    if (!nickname) {
      return res.status(400).json({ error: 'nickname is required' });
    }

    const student = await Student.findOneAndUpdate(
      { studentId, classId: teacher.classId },
      { $set: { nickname, group } },
      { new: true }
    ).select('studentId fullName nickname group code -_id');

    if (!student) {
      return res.status(404).json({ error: 'Student not found in your class' });
    }

    res.json(student);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update student' });
  }
});

// Remove a student from the roster. Teacher-only, scoped to their own class.
app.delete('/api/students/:studentId', async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const { studentId } = req.params;

    const result = await Student.deleteOne({
      studentId,
      classId: teacher.classId,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Student not found in your class' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete student' });
  }
});

// Public — validates a student login code and returns the student's info
// plus their class details so the frontend can auto-log them in.
app.get('/api/student-login/:code', async (req, res) => {
  try {
    const code = (req.params.code || '').toString().trim().toUpperCase();

    if (!code || code.length !== 6) {
      return res.status(400).json({ error: 'Invalid student code' });
    }

    const student = await Student.findOne({ code })
      .select('studentId fullName nickname group code classId -_id')
      .lean();

    if (!student) {
      return res.status(404).json({ error: 'Student code not found' });
    }

    const classInfo = await ClassInfo.findOne({ classId: student.classId })
      .select('classId className classType -_id')
      .lean();

    if (!classInfo) {
      return res.status(500).json({ error: 'Class not found for this student' });
    }

    res.json({ student, classInfo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not validate student code' });
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

// Stricter than requireTeacher — additionally checks that the teacher's
// role is 'admin'. Used to gate all GameAccess write routes (order, lock/
// unlock, shiny, shop add/remove). Only admins can mutate game config.
async function requireAdmin(req, res) {
  const teacher = await requireTeacher(req, res);
  if (!teacher) return null;
  if (teacher.role !== 'admin') {
    res.status(403).json({ error: 'Admins only' });
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

// Validates that a classType string is one of the known enum values.
function isValidClassType(value) {
  return value === 'k1' || value === 'k2';
}

// Returns the game arrangement for a given classType. Uses .lean() for
// performance — plain objects, no Mongoose document overhead.
async function getGameAccessRows(classType) {
  const docs = await GameAccess.find({
    classType,
    gameKey: { $in: GAME_KEYS },
    added: true,
  }).lean();
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

// Read endpoint — used by the homepage, game gates, and teacher panel.
// Accepts ?classId= (resolves to classType server-side — contract unchanged)
// OR ?classType= + teacherCode for admin panel reads. The response shape is
// identical either way.
app.get('/api/game-access', async (req, res) => {
  try {
    // Admin panel path: reads directly by classType.
    if (req.query.classType) {
      const teacher = await requireAdmin(req, res);
      if (!teacher) return;
      const classType = req.query.classType.toString().trim();
      if (!isValidClassType(classType)) {
        return res.status(400).json({ error: `Unknown classType: "${classType}"` });
      }
      return res.json(await getGameAccessRows(classType));
    }

    // Public/player path: resolves classId → classType server-side.
    const classId = await requireClass(req, res);
    if (!classId) return;
    const classType = await classTypeForClassId(classId);
    if (!classType) {
      return res.status(400).json({ error: 'Class not found' });
    }
    res.json(await getGameAccessRows(classType));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load game access' });
  }
});

// Admin-only: saves the complete game order for a classType.
// Must stay above /api/game-access/:gameKey.
app.put('/api/game-access/order', async (req, res) => {
  try {
    const { gameKeys, classType } = req.body;
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    if (!isValidClassType(classType)) {
      return res.status(400).json({ error: `Unknown classType: "${classType}"` });
    }

    const addedKeys = await GameAccess.distinct('gameKey', {
      classType,
      added: true,
    });

    const validList =
      Array.isArray(gameKeys) &&
      gameKeys.length === addedKeys.length &&
      new Set(gameKeys).size === addedKeys.length &&
      gameKeys.every((key) => addedKeys.includes(key));

    if (!validList) {
      return res.status(400).json({
        error: 'gameKeys must contain every game currently added to this class type exactly once',
      });
    }

    const updatedAt = new Date();

    await GameAccess.bulkWrite(
      gameKeys.map((gameKey, order) => ({
        updateOne: {
          filter: { classType, gameKey, added: true },
          update: {
            $set: {
              order,
              updatedBy: admin.name,
              updatedAt,
            },
          },
          upsert: false,
        },
      }))
    );

    res.json({
      ok: true,
      rows: await getGameAccessRows(classType),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save game order' });
  }
});

// Admin-only: adds a game from the shop for a classType. Re-adding a removed
// game places it at the end and starts it locked.
app.post('/api/game-access/:gameKey', async (req, res) => {
  try {
    const { gameKey } = req.params;
    const { classType } = req.body;
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    if (!GAME_KEY_RE.test(gameKey)) {
      return res.status(400).json({ error: `Invalid gameKey: "${gameKey}"` });
    }
    if (!isValidClassType(classType)) {
      return res.status(400).json({ error: `Unknown classType: "${classType}"` });
    }

    const lastAddedGame = await GameAccess.findOne({
      classType,
      added: true,
    })
      .sort({ order: -1 })
      .select('order')
      .lean();

    const order = Number.isFinite(lastAddedGame?.order)
      ? lastAddedGame.order + 1
      : 0;

    await GameAccess.findOneAndUpdate(
      { classType, gameKey },
      {
        $set: {
          added: true,
          unlocked: false,
          shiny: false,
          order,
          updatedBy: admin.name,
          updatedAt: new Date(),
        },
        $setOnInsert: { classType },
      },
      { upsert: true, new: true }
    );

    res.status(201).json({ ok: true, rows: await getGameAccessRows(classType) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not add game to class type' });
  }
});

// Admin-only: removes a game from a classType (soft-delete — sets added:false).
app.delete('/api/game-access/:gameKey', async (req, res) => {
  try {
    const { gameKey } = req.params;
    const { classType } = req.body;
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    if (!GAME_KEY_RE.test(gameKey)) {
      return res.status(400).json({ error: `Invalid gameKey: "${gameKey}"` });
    }
    if (!isValidClassType(classType)) {
      return res.status(400).json({ error: `Unknown classType: "${classType}"` });
    }

    const doc = await GameAccess.findOneAndUpdate(
      { classType, gameKey, added: true },
      {
        $set: {
          added: false,
          unlocked: false,
          shiny: false,
          updatedBy: admin.name,
          updatedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!doc) return res.status(404).json({ error: 'This game is not in the class type' });
    res.json({ ok: true, rows: await getGameAccessRows(classType) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not remove game from class type' });
  }
});

// Admin-only: marks one game as featured/shiny for a classType.
// Must stay above /api/game-access/:gameKey.
app.put('/api/game-access/:gameKey/shiny', async (req, res) => {
  try {
    const { gameKey } = req.params;
    const { shiny, classType } = req.body;
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    if (!GAME_KEY_RE.test(gameKey)) {
      return res.status(400).json({ error: `Invalid gameKey: "${gameKey}"` });
    }
    if (typeof shiny !== 'boolean') {
      return res.status(400).json({ error: 'shiny must be true or false' });
    }
    if (!isValidClassType(classType)) {
      return res.status(400).json({ error: `Unknown classType: "${classType}"` });
    }

    const doc = await GameAccess.findOneAndUpdate(
      { classType, gameKey, added: true },
      {
        $set: {
          shiny,
          updatedBy: admin.name,
          updatedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!doc) return res.status(404).json({ error: 'Add this game to the class type first' });

    res.json({
      ok: true,
      gameKey: doc.gameKey,
      shiny: doc.shiny,
      updatedBy: doc.updatedBy,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update shiny game setting' });
  }
});

// Admin-only: locks or unlocks one game for a classType.
app.put('/api/game-access/:gameKey', async (req, res) => {
  try {
    const { gameKey } = req.params;
    const { unlocked, classType } = req.body;
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    if (!GAME_KEY_RE.test(gameKey)) {
      return res.status(400).json({ error: `Invalid gameKey: "${gameKey}"` });
    }
    if (typeof unlocked !== 'boolean') {
      return res.status(400).json({ error: 'unlocked must be true or false' });
    }
    if (!isValidClassType(classType)) {
      return res.status(400).json({ error: `Unknown classType: "${classType}"` });
    }

    const doc = await GameAccess.findOneAndUpdate(
      { classType, gameKey, added: true },
      {
        $set: {
          unlocked,
          updatedBy: admin.name,
          updatedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!doc) return res.status(404).json({ error: 'Add this game to the class type first' });

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
    res.status(500).json({ error: 'Could not update game access' });
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

// ---------------------------------------------------------------------------
// One-time boot migration: GameAccess classId → classType
// ---------------------------------------------------------------------------
// Runs on every deploy but is idempotent — guards check for the presence of
// the old `classId` field before acting, so re-deploys skip it harmlessly.
// Once all existing data has been migrated, this is a no-op.

async function migrateClassTypeAndGameAccess() {
  // Step 0 — Ensure legacy PlaySession docs have a classId.
  await PlaySession.updateMany(
    { classId: { $exists: false } },
    { $set: { classId: LEGACY_CLASS_ID } }
  );

  // Step 1 — Give every existing teacher a role if they don't have one.
  const teacherRoleResult = await Teacher.updateMany(
    { role: { $exists: false } },
    { $set: { role: 'admin' } }
  );
  if (teacherRoleResult.modifiedCount > 0) {
    console.log(`Set role='admin' for ${teacherRoleResult.modifiedCount} teachers`);
  }

  // Step 2 — Ensure every ClassInfo has a classType (already done by the
  // existing migrateClassTypes, but keep the guard here for clarity).
  const classTypeResult = await ClassInfo.updateMany(
    { classType: { $exists: false } },
    { $set: { classType: 'k1' } }
  );
  if (classTypeResult.modifiedCount > 0) {
    console.log(`Set classType='k1' for ${classTypeResult.modifiedCount} classes`);
  }

  // Step 3 — Migrate GameAccess from classId to classType.
  // Only proceed if any GameAccess doc still has the old `classId` field.
  const oldDocCount = await GameAccess.countDocuments({ classId: { $exists: true } });
  if (oldDocCount === 0) {
    // Already migrated — skip to index cleanup only.
    await cleanupGameAccessIndexes();
    return;
  }

  console.log(`Migrating ${oldDocCount} GameAccess docs from classId → classType…`);

  // For each gameKey, prefer the row from the legacy K1 class as the source
  // of truth for classType 'k1'. Both existing classes are K1 anyway.
  const oldDocs = await GameAccess.find({ classId: { $exists: true } }).lean();

  // Group by gameKey, prefer k12026-pny when there are duplicates.
  const byGameKey = new Map();
  for (const doc of oldDocs) {
    const existing = byGameKey.get(doc.gameKey);
    if (!existing || doc.classId === LEGACY_CLASS_ID) {
      byGameKey.set(doc.gameKey, doc);
    }
  }

  // Upsert one classType='k1' row per gameKey carrying over settings.
  const upsertOps = [];
  for (const [gameKey, doc] of byGameKey) {
    upsertOps.push({
      updateOne: {
        filter: { classType: 'k1', gameKey },
        update: {
          $set: {
            added: doc.added ?? true,
            unlocked: doc.unlocked ?? false,
            shiny: doc.shiny ?? false,
            order: doc.order ?? GAME_KEYS.indexOf(gameKey),
            updatedBy: doc.updatedBy || null,
            updatedAt: doc.updatedAt || new Date(),
          },
          $setOnInsert: { classType: 'k1' },
        },
        upsert: true,
      },
    });
  }

  if (upsertOps.length > 0) {
    await GameAccess.bulkWrite(upsertOps);
  }

  // Remove old classId-keyed documents.
  const deleteResult = await GameAccess.deleteMany({ classId: { $exists: true } });
  console.log(`Deleted ${deleteResult.deletedCount} old classId-keyed GameAccess docs`);

  await cleanupGameAccessIndexes();
  console.log('GameAccess classId → classType migration complete');
}

// Drops the old {classId, gameKey} unique index if it still exists, then
// syncs indexes so the new {classType, gameKey} index from the model takes
// effect. Also drops any legacy gameKey-only index.
async function cleanupGameAccessIndexes() {
  const existingIndexes = await GameAccess.collection.indexes();
  const indexNames = existingIndexes.map((idx) => idx.name);

  for (const name of indexNames) {
    if (name === 'classId_1_gameKey_1' || name === 'gameKey_1') {
      try {
        await GameAccess.collection.dropIndex(name);
        console.log(`Dropped legacy index: ${name}`);
      } catch (err) {
        if (err.codeName !== 'IndexNotFound' && err.code !== 27) throw err;
      }
    }
  }

  await GameAccess.syncIndexes();
}

// Assigns random 6-character codes to existing students that don't have one
// (added during the student-code feature rollout). Uses the same character
// set as the frontend's generateStudentCode().
async function migrateStudentCodes() {
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function makeCode() {
    let code = '';
    for (let i = 0; i < 6; i++) code += CHARS[Math.floor(Math.random() * CHARS.length)];
    return code;
  }

  const studentsWithoutCode = await Student.find({ code: { $exists: false } }).select('_id');
  if (studentsWithoutCode.length === 0) return;

  const existingCodes = new Set(
    (await Student.find({ code: { $exists: true } }).select('code -_id').lean())
      .map((s) => s.code)
  );

  const bulkOps = [];
  for (const student of studentsWithoutCode) {
    let code;
    do { code = makeCode(); } while (existingCodes.has(code));
    existingCodes.add(code);
    bulkOps.push({
      updateOne: {
        filter: { _id: student._id },
        update: { $set: { code, group: '' } },
      },
    });
  }

  if (bulkOps.length > 0) {
    await Student.bulkWrite(bulkOps);
    console.log(`Assigned codes to ${bulkOps.length} existing students`);
  }
}

// Prevent Mongoose from buffering operations while disconnected — if the
// connection drops, queries fail immediately with a clear error instead of
// queuing up silently and appearing to hang.
mongoose.set('bufferCommands', false);

mongoose
  .connect(process.env.MONGODB_URI, {
    // Close idle connections after 10 s so the network layer (Render's
    // load-balancer, MongoDB Atlas) never silently drops them first.
    maxIdleTimeMS: 10_000,
    // Fail fast (5 s) instead of the default 30 s if the server can't
    // reach MongoDB at all — avoids a 30-second hang on cold-start.
    serverSelectionTimeoutMS: 5_000,
  })
  .then(async () => {
    await seedDirectoryIfEmpty();
    await migrateClassTypeAndGameAccess();
    await migrateStudentCodes();
    await Student.syncIndexes();
    await PlaySession.syncIndexes();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });