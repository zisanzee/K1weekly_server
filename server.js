require('dotenv').config();

const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { Resend } = require('resend');

const PlaySession = require('./models/PlaySession');
const GameAccess = require('./models/GameAccess');
const Teacher = require('./models/Teacher');
const ClassInfo = require('./models/ClassInfo');
const Student = require('./models/Student');
const SystemConfig = require('./models/SystemConfig');
const PlayerMerge = require('./models/PlayerMerge');
const { lookupTeacher, getClasses, isKnownClass } = require('./directory');

const app = express();

// Accept any non-empty alphanumeric game key — adding new games to the
// frontend catalog requires no server-side edit at all. The GameAccess
// collection is the source of truth for which games have been added.
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
    // Admin (when a credential is present) sees every class enriched with
    // summary info; the public/player path keeps the original lightweight list
    // (id/name/classType) so existing callers are unaffected.
    if (req.query.teacherCode || req.body?.teacherCode) {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      const classes = await ClassInfo.find().lean();

      // Count DISTINCT identities per class, not just roster records. A class's
      // real students include public-class "light" players who only ever gave a
      // name (no Student record), so we union non-merged roster names with the
      // distinct playerNames seen in play sessions. Batched into one roster read
      // plus one aggregation so the count is stable no matter how many classes.
      const [roster, playRows] = await Promise.all([
        Student.find({ mergedInto: null })
          .select('classId nickname fullName -_id')
          .lean(),
        PlaySession.aggregate([
          { $match: { playerName: { $nin: [null, '', 'Guest'] } } },
          { $group: { _id: '$classId', names: { $addToSet: '$playerName' } } },
        ]),
      ]);

      const identityNames = new Map(); // classId -> Set(display name)
      const addName = (classId, name) => {
        if (!classId) return;
        const trimmed = (name || '').toString().trim();
        if (!trimmed || trimmed === 'Guest') return;
        let set = identityNames.get(classId);
        if (!set) {
          set = new Set();
          identityNames.set(classId, set);
        }
        set.add(trimmed);
      };
      for (const s of roster) {
        addName(s.classId, s.nickname);
        addName(s.classId, s.fullName);
      }
      for (const row of playRows) {
        for (const name of row.names || []) addName(row._id, name);
      }

      const rows = await Promise.all(
        classes.map(async (classroom) => {
          const teacherCount = await Teacher.countDocuments({
            classId: classroom.classId,
            active: { $ne: false },
          });
          return {
            id: classroom.classId,
            classId: classroom.classId,
            name: classroom.className,
            className: classroom.className,
            classAlias: classroom.classAlias || classroom.className,
            classYear: classroom.classYear || null,
            classCode: classroom.classCode || null,
            classType: classroom.classType || 'k1',
            isPublic: Boolean(classroom.isPublic),
            active: classroom.active !== false,
            teacherCount,
            studentCount: identityNames.get(classroom.classId)?.size || 0,
          };
        })
      );
      return res.json(rows);
    }

    res.json(await getClasses());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load classes' });
  }
});

// Class detail. Admin: any class. Teacher: only their own. The teacher list is
// derived from Teacher (not stored on the class) so it can't go stale.
app.get('/api/classes/:classId', async (req, res) => {
  try {
    const { classId } = req.params;
    if (!(await isKnownClass(classId))) {
      return res.status(404).json({ error: 'Class not found' });
    }

    if (req.query.teacherCode || req.body?.teacherCode) {
      const actor = await requireClassAccess(req, res, classId);
      if (!actor) return;
    }

    const [classInfo, teachers] = await Promise.all([
      ClassInfo.findOne({ classId }).lean(),
      Teacher.find({ classId }).select('name code role active -_id').lean(),
    ]);

    res.json({
      classId,
      className: classInfo?.className || classId,
      classAlias: classInfo?.classAlias || classInfo?.className || classId,
      classYear: classInfo?.classYear || null,
      classCode: classInfo?.classCode || null,
      classType: classInfo?.classType || 'k1',
      isPublic: Boolean(classInfo?.isPublic),
      active: classInfo?.active !== false,
      image: classInfo?.image || null,
      teachers: teachers.map((teacher) => teacher.name),
      teacherList: teachers.map((teacher) => ({
        name: teacher.name,
        code: teacher.code,
        role: teacher.role || 'teacher',
        active: teacher.active !== false,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load class information' });
  }
});

// Admin-only: create a class plus its initial teacher list. New classes default
// to Private unless the admin opts into Public at creation time.
app.post('/api/classes', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const className = (req.body.className || '').toString().trim().slice(0, 80);
    const classYear = (req.body.classYear || '').toString().trim().slice(0, 20) || null;
    const classAlias =
      (req.body.classAlias || '').toString().trim().slice(0, 80) || className;
    const classCode = (req.body.classCode || '').toString().trim();
    const isPublic = req.body.isPublic === true;
    const classId =
      (req.body.classId || '').toString().trim() || `cls${Date.now().toString(36)}`;

    if (!className) return res.status(400).json({ error: 'className is required' });
    if (!classCode) return res.status(400).json({ error: 'classCode is required' });
    if (await ClassInfo.exists({ classId })) {
      return res.status(409).json({ error: 'That class id already exists' });
    }

    const conflict = await findCodeOwner(classCode);
    if (conflict) {
      return res
        .status(409)
        .json({ error: 'That class code is already taken', reason: conflict });
    }

    // Validate the whole teacher list up-front so a create can't half-succeed.
    const teacherInput = Array.isArray(req.body.teachers) ? req.body.teachers : [];
    const normalizedTeachers = [];
    for (const t of teacherInput) {
      const name = (t.name || '').toString().trim().slice(0, 80);
      const code = (t.teacherCode || t.code || '').toString().trim();
      if (!name || !code) {
        return res.status(400).json({ error: 'Each teacher needs a name and a code' });
      }
      const teacherConflict = await findCodeOwner(code);
      if (teacherConflict) {
        return res
          .status(409)
          .json({ error: `Teacher code "${code}" is already taken`, reason: teacherConflict });
      }
      normalizedTeachers.push({ name, code });
    }
    const codeSet = new Set(normalizedTeachers.map((t) => t.code));
    if (codeSet.size !== normalizedTeachers.length) {
      return res.status(409).json({ error: 'Duplicate teacher codes in the request' });
    }

    await ClassInfo.create({
      classId,
      className,
      classAlias,
      classYear,
      classCode,
      isPublic,
      active: true,
    });

    if (normalizedTeachers.length > 0) {
      await Teacher.insertMany(
        normalizedTeachers.map((t) => ({
          code: t.code,
          name: t.name,
          classId,
          role: 'teacher',
        }))
      );
    }

    res.status(201).json({ ok: true, classId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create class' });
  }
});

// Admin-only: update any class field, including its full teacher list. Teachers
// dropped from the list are soft-deactivated (never deleted) so historical
// stats rows that reference them keep resolving.
app.put('/api/classes/:classId', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const { classId } = req.params;
    const classInfo = await ClassInfo.findOne({ classId });
    if (!classInfo) return res.status(404).json({ error: 'Class not found' });

    if ('classAlias' in req.body) {
      classInfo.classAlias =
        (req.body.classAlias || '').toString().trim().slice(0, 80) ||
        classInfo.classAlias ||
        classInfo.className;
    }
    if ('classYear' in req.body) {
      classInfo.classYear =
        (req.body.classYear || '').toString().trim().slice(0, 20) || null;
    }
    if ('isPublic' in req.body) classInfo.isPublic = req.body.isPublic === true;
    if ('active' in req.body) classInfo.active = req.body.active !== false;
    if ('image' in req.body) classInfo.image = req.body.image || null;

    if ('classCode' in req.body) {
      const classCode = (req.body.classCode || '').toString().trim();
      if (!classCode) return res.status(400).json({ error: 'classCode cannot be empty' });
      const conflict = await findCodeOwner(classCode, { classId });
      if (conflict) {
        return res
          .status(409)
          .json({ error: 'That class code is already taken', reason: conflict });
      }
      classInfo.classCode = classCode;
    }
    if ('className' in req.body) {
      classInfo.className = (req.body.className || '').toString().trim().slice(0, 80);
    }

    await classInfo.save();

    // Optional full teacher-list replacement. Each entry: { name, code }.
    if (Array.isArray(req.body.teachers)) {
      const existing = await Teacher.find({ classId });
      const byCode = new Map(existing.map((t) => [t.code, t]));
      const keepCodes = new Set();

      for (const t of req.body.teachers) {
        const name = (t.name || '').toString().trim().slice(0, 80);
        const code = (t.teacherCode || t.code || '').toString().trim();
        if (!name || !code) {
          return res.status(400).json({ error: 'Each teacher needs a name and a code' });
        }
        const existingTeacher = byCode.get(code);
        const conflict = await findCodeOwner(code, {
          teacherId: existingTeacher?._id,
        });
        if (conflict) {
          return res
            .status(409)
            .json({ error: `Teacher code "${code}" is already taken`, reason: conflict });
        }
        keepCodes.add(code);
        if (existingTeacher) {
          existingTeacher.name = name;
          existingTeacher.active = true;
          await existingTeacher.save();
        } else {
          await Teacher.create({ code, name, classId, role: 'teacher' });
        }
      }

      await Teacher.updateMany(
        { classId, code: { $nin: [...keepCodes] } },
        { $set: { active: false } }
      );
    }

    res.json({ ok: true, classInfo: classInfoPayload(classInfo) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update class' });
  }
});

// Admin OR own-class teacher: flip just the public/private flag.
app.patch('/api/classes/:classId/public', async (req, res) => {
  try {
    const { classId } = req.params;
    const actor = await requireClassAccess(req, res, classId);
    if (!actor) return;

    if (typeof req.body.isPublic !== 'boolean') {
      return res.status(400).json({ error: 'isPublic must be true or false' });
    }

    const classInfo = await ClassInfo.findOneAndUpdate(
      { classId },
      { $set: { isPublic: req.body.isPublic } },
      { new: true }
    ).lean();
    if (!classInfo) return res.status(404).json({ error: 'Class not found' });

    res.json({ ok: true, classInfo: classInfoPayload(classInfo) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update class privacy' });
  }
});

// Teacher (own class) OR admin: rename the class code, but only to a code that
// is free in the whole namespace (Q5: teacher-editable, subject to uniqueness).
app.patch('/api/classes/:classId/code', async (req, res) => {
  try {
    const { classId } = req.params;
    const actor = await requireClassAccess(req, res, classId);
    if (!actor) return;

    const classCode = (req.body.classCode || '').toString().trim();
    if (!classCode) return res.status(400).json({ error: 'classCode is required' });

    const conflict = await findCodeOwner(classCode, { classId });
    if (conflict) {
      return res
        .status(409)
        .json({ error: 'That class code is already taken', reason: conflict });
    }

    const classInfo = await ClassInfo.findOneAndUpdate(
      { classId },
      { $set: { classCode } },
      { new: true }
    ).lean();
    if (!classInfo) return res.status(404).json({ error: 'Class not found' });

    res.json({ ok: true, classInfo: classInfoPayload(classInfo) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update class code' });
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

    const student = await Student.findOne({
      studentId,
      classId: teacher.classId,
    }).lean();

    if (!student) {
      return res.status(404).json({ error: 'Student not found in your class' });
    }

    await Student.deleteOne({ _id: student._id });
    await removeStudentPlaySessions(teacher.classId, student);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete student' });
  }
});

// ---------------------------------------------------------------------------
// Class-scoped students + player-identity merge. Admin may target any class;
// a teacher only their own. The legacy /api/students routes above stay intact
// for backward compatibility, but the redesigned panel uses these.
// ---------------------------------------------------------------------------

// The merge UI's source list: roster students UNION the distinct playerNames
// seen in play sessions, so name-only "light" kids (no Student record) can be
// merged too. Merged-away roster students are excluded from the primary list.
app.get('/api/classes/:classId/identities', async (req, res) => {
  try {
    const { classId } = req.params;
    const actor = await requireClassAccess(req, res, classId);
    if (!actor) return;

    const [students, names] = await Promise.all([
      Student.find({ classId, mergedInto: null })
        .select('studentId nickname fullName code -_id')
        .lean(),
      PlaySession.distinct('playerName', { classId }),
    ]);

    const byName = new Map();
    for (const s of students) {
      const name = s.nickname || s.fullName;
      byName.set(name, {
        name,
        studentId: s.studentId,
        code: s.code || null,
        rostered: true,
      });
    }
    for (const name of names) {
      if (!name || byName.has(name)) continue;
      byName.set(name, { name, studentId: null, code: null, rostered: false });
    }

    const merges = await PlayerMerge.find({ classId, active: true }).lean();
    res.json({ identities: [...byName.values()], merges });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load player identities' });
  }
});

app.get('/api/classes/:classId/students', async (req, res) => {
  try {
    const { classId } = req.params;
    const actor = await requireClassAccess(req, res, classId);
    if (!actor) return;

    const students = await Student.find({ classId })
      .sort({ createdAt: 1 })
      .select('studentId fullName nickname group code mergedInto mergedAt -_id')
      .lean();

    res.json(
      students.map((s) => ({
        ...s,
        mergedInto: s.mergedInto ? String(s.mergedInto) : null,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load students' });
  }
});

app.post('/api/classes/:classId/students', async (req, res) => {
  try {
    const { classId } = req.params;
    const actor = await requireClassAccess(req, res, classId);
    if (!actor) return;

    const nickname = (req.body.nickname || '').toString().trim().slice(0, 40);
    const fullName =
      (req.body.fullName || nickname || '').toString().trim().slice(0, 80);
    const group = (req.body.group || '').toString().trim().slice(0, 40);
    const code = (req.body.code || '').toString().trim().toUpperCase();

    if (!nickname) return res.status(400).json({ error: 'nickname is required' });
    if (!code || code.length !== 6) {
      return res.status(400).json({ error: 'A 6-character student code is required' });
    }

    const conflict = await findCodeOwner(code);
    if (conflict) {
      return res
        .status(409)
        .json({ error: 'This code is already in use. Please try again.', reason: conflict });
    }

    const student = await Student.create({ classId, fullName, nickname, group, code });

    res.status(201).json({
      studentId: student.studentId,
      fullName: student.fullName,
      nickname: student.nickname,
      group: student.group,
      code: student.code,
      mergedInto: null,
      mergedAt: null,
    });
  } catch (err) {
    console.error(err);
    if (err.code === 11000) {
      return res.status(409).json({ error: 'This code is already in use. Please try again.' });
    }
    res.status(500).json({ error: 'Could not add student' });
  }
});

app.put('/api/classes/:classId/students/:studentId', async (req, res) => {
  try {
    const { classId, studentId } = req.params;
    const actor = await requireClassAccess(req, res, classId);
    if (!actor) return;

    const set = {};
    if ('nickname' in req.body) {
      const nickname = (req.body.nickname || '').toString().trim().slice(0, 40);
      if (!nickname) return res.status(400).json({ error: 'nickname is required' });
      set.nickname = nickname;
    }
    if ('fullName' in req.body) {
      set.fullName = (req.body.fullName || '').toString().trim().slice(0, 80);
    }
    if ('group' in req.body) {
      set.group = (req.body.group || '').toString().trim().slice(0, 40);
    }
    if ('code' in req.body) {
      const code = (req.body.code || '').toString().trim().toUpperCase();
      if (!code || code.length !== 6) {
        return res.status(400).json({ error: 'A 6-character student code is required' });
      }
      const conflict = await findCodeOwner(code, { studentId });
      if (conflict) {
        return res
          .status(409)
          .json({ error: 'This code is already in use. Please try again.', reason: conflict });
      }
      set.code = code;
    }

    const student = await Student.findOneAndUpdate(
      { studentId, classId },
      { $set: set },
      { new: true }
    ).lean();
    if (!student) return res.status(404).json({ error: 'Student not found in this class' });

    res.json({
      studentId: student.studentId,
      fullName: student.fullName,
      nickname: student.nickname,
      group: student.group,
      code: student.code,
      mergedInto: student.mergedInto ? String(student.mergedInto) : null,
      mergedAt: student.mergedAt || null,
    });
  } catch (err) {
    console.error(err);
    if (err.code === 11000) {
      return res.status(409).json({ error: 'This code is already in use. Please try again.' });
    }
    res.status(500).json({ error: 'Could not update student' });
  }
});

app.delete('/api/classes/:classId/students/:studentId', async (req, res) => {
  try {
    const { classId, studentId } = req.params;
    const actor = await requireClassAccess(req, res, classId);
    if (!actor) return;

    const student = await Student.findOne({ studentId, classId }).lean();
    if (!student) {
      return res.status(404).json({ error: 'Student not found in this class' });
    }

    await Student.deleteOne({ _id: student._id });
    await removeStudentPlaySessions(classId, student);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete student' });
  }
});

// Merge 2+ name-identities within one class into a primary. Light public-class
// kids only ever gave a name, so merges are name-based (roster students fold in
// when their name matches). Sessions are physically retagged to the primary
// name while remembering their pre-merge name in `mergedFrom`, so unmerge can
// restore them exactly.
app.post('/api/classes/:classId/students/merge', async (req, res) => {
  try {
    const { classId } = req.params;
    const actor = await requireClassAccess(req, res, classId);
    if (!actor) return;

    let primaryName = (req.body.primaryName || '').toString().trim();
    let memberNames = Array.isArray(req.body.memberNames)
      ? req.body.memberNames.map((n) => n.toString().trim()).filter(Boolean)
      : [];

    // Also accept roster-id selections from the Students tab and map them to
    // names, since the merge itself is name-based.
    const mergedIds = Array.isArray(req.body.mergedStudentIds)
      ? req.body.mergedStudentIds
      : [];
    const idList = [req.body.primaryStudentId, ...mergedIds]
      .filter(Boolean)
      .map(String);
    if (idList.length > 0) {
      const docs = await Student.find({ classId, studentId: { $in: idList } }).lean();
      const byId = new Map(docs.map((d) => [d.studentId, d]));
      if (req.body.primaryStudentId) {
        const p = byId.get(String(req.body.primaryStudentId));
        if (p) primaryName = p.nickname || p.fullName;
      }
      for (const id of mergedIds) {
        const m = byId.get(String(id));
        if (m) memberNames.push(m.nickname || m.fullName);
      }
    }

    primaryName = primaryName.trim();
    memberNames = [...new Set(memberNames.filter((n) => n && n !== primaryName))];

    if (!primaryName) {
      return res.status(400).json({ error: 'A primary name is required' });
    }
    if (memberNames.length === 0) {
      return res.status(400).json({ error: 'Select at least one other identity to merge' });
    }

    // Enforce LIFO chains: a member that is itself the primary of an active
    // merge must be unmerged first, so restoring stays unambiguous.
    const blocking = await PlayerMerge.findOne({
      classId,
      active: true,
      primaryName: { $in: memberNames },
    }).lean();
    if (blocking) {
      return res.status(409).json({
        error: `"${blocking.primaryName}" is itself a merge target — unmerge it first`,
      });
    }

    const now = new Date();

    // Retag every session carrying a member name. Sessions already tagged by an
    // earlier merge keep their original mergedFrom value.
    for (const member of memberNames) {
      await PlaySession.updateMany({ classId, playerName: member }, [
        {
          $set: {
            playerName: primaryName,
            mergedFrom: { $ifNull: ['$mergedFrom', '$playerName'] },
          },
        },
      ]);
    }

    // Fold matching roster students into the primary roster record when one
    // exists, so student-code logins also resolve to the primary.
    const rosterByName = await Student.find({
      classId,
      $or: [{ nickname: { $in: memberNames } }, { fullName: { $in: memberNames } }],
    }).lean();
    const primaryRoster = await Student.findOne({
      classId,
      $or: [{ nickname: primaryName }, { fullName: primaryName }],
    }).lean();

    if (primaryRoster && rosterByName.length > 0) {
      await Student.updateMany(
        { _id: { $in: rosterByName.map((s) => s._id) } },
        { $set: { mergedInto: primaryRoster._id, mergedAt: now, mergedBy: actor.name } }
      );
      await PlaySession.updateMany(
        { classId, studentId: { $in: rosterByName.map((s) => s.studentId) } },
        { $set: { studentId: primaryRoster.studentId } }
      );
    }

    await PlayerMerge.create({
      classId,
      primaryName,
      members: memberNames,
      createdBy: actor.name,
      createdAt: now,
      active: true,
    });

    res.json({ ok: true, primaryName, merged: memberNames });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not merge students' });
  }
});

// Undo a single merge link. Accepts either a real studentId (roster student) or
// the literal "name" with body.memberName for a light, record-less identity.
app.post('/api/classes/:classId/students/:studentId/unmerge', async (req, res) => {
  try {
    const { classId, studentId } = req.params;
    const actor = await requireClassAccess(req, res, classId);
    if (!actor) return;

    let memberName = (req.body.memberName || '').toString().trim();
    let rosterStudent = null;
    if (studentId && studentId !== 'name') {
      rosterStudent = await Student.findOne({ classId, studentId }).lean();
      if (rosterStudent) memberName = rosterStudent.nickname || rosterStudent.fullName;
    }
    // The panel identifies record-less "light" names by name alone, but a merge
    // may also have folded in a roster student of that name. Resolve it so
    // unmerge clears its Student.mergedInto link too, not just the retagged
    // sessions — otherwise the roster record stays stuck as merged.
    if (!rosterStudent && memberName) {
      rosterStudent = await Student.findOne({
        classId,
        $or: [{ nickname: memberName }, { fullName: memberName }],
      }).lean();
    }
    if (!memberName) {
      return res.status(400).json({ error: 'A member name is required to unmerge' });
    }

    const merge = await PlayerMerge.findOne({ classId, active: true, members: memberName });
    if (!merge) {
      return res.status(404).json({ error: 'No active merge found for that identity' });
    }
    const primaryName = merge.primaryName;

    // Guard against LIFO violations: this member must not itself be a primary.
    const nested = await PlayerMerge.findOne({ classId, active: true, primaryName: memberName }).lean();
    if (nested) {
      return res.status(409).json({
        error: `Unmerge "${nested.primaryName}"'s own members before undoing this one`,
      });
    }

    // Restore the retagged sessions to their exact pre-merge name.
    await PlaySession.updateMany(
      { classId, playerName: primaryName, mergedFrom: memberName },
      [{ $set: { playerName: '$mergedFrom', mergedFrom: null } }]
    );

    // Restore the roster record and its session tags, if it was folded in.
    const primaryRoster = await Student.findOne({
      classId,
      $or: [{ nickname: primaryName }, { fullName: primaryName }],
    }).lean();
    if (rosterStudent && primaryRoster) {
      await PlaySession.updateMany(
        { classId, studentId: primaryRoster.studentId, playerName: memberName },
        { $set: { studentId: rosterStudent.studentId } }
      );
      await Student.updateOne(
        { _id: rosterStudent._id },
        { $set: { mergedInto: null, mergedAt: null, mergedBy: null } }
      );
    }

    merge.members = merge.members.filter((m) => m !== memberName);
    if (merge.members.length === 0) merge.active = false;
    await merge.save();

    res.json({ ok: true, memberName, primaryName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not unmerge student' });
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

// Returns the game arrangement for a given classId. Uses .lean() for
// performance — plain objects, no Mongoose document overhead.
async function getGameAccessRows(classId) {
  // No hardcoded game-key allowlist — the frontend GAME_CATALOG already
  // filters to known games, and the DB is the source of truth for what has
  // been added to a class. New games work with zero server edits.
  const docs = await GameAccess.find({ classId, added: true }).lean();
  return docs
    .map((doc) => ({
      gameKey: doc.gameKey,
      unlocked: Boolean(doc.unlocked),
      shiny: Boolean(doc.shiny),
      order: Number.isInteger(doc.order) ? doc.order : 0,
      updatedBy: doc.updatedBy,
      updatedAt: doc.updatedAt,
    }))
    .sort(
      (a, b) =>
        a.order - b.order ||
        a.gameKey.localeCompare(b.gameKey, undefined, { numeric: true })
    );
}

// Admins may act on any class; a teacher only on their own. Used by the
// class-scoped game-access, student, and merge write endpoints.
async function requireClassAccess(req, res, classId) {
  const actor = await requireTeacher(req, res);
  if (!actor) return null;
  if (actor.role === 'admin') return actor;
  if (actor.classId !== classId) {
    res.status(403).json({ error: 'You can only manage your own class' });
    return null;
  }
  return actor;
}

// ---------------------------------------------------------------------------
// Global code namespace
// ---------------------------------------------------------------------------
// Teacher, class, student and admin codes all share ONE namespace: a code in
// any bucket must never equal a code in another bucket, and duplicates within
// a bucket are rejected by each collection's own unique index. MongoDB cannot
// enforce uniqueness across collections, so every create/update that changes a
// code must call findCodeOwner() and reject when it returns a reason.
// The single admin credential is supplied by the environment so no secret is
// committed to the repo. Set ADMIN_CODE (and optionally ADMIN_NAME) in the
// deploy/host env. When unset, the admin bootstrap is skipped and the app is
// still fully runnable — an existing admin row in the DB keeps working.
const ADMIN_CODE = (process.env.ADMIN_CODE || '').toString().trim();
const ADMIN_NAME = (process.env.ADMIN_NAME || 'Admin').toString().trim();

// Returns a conflict reason string when `code` is already taken, or null when
// it's free. `exclude` lets an edit re-save its own code without tripping a
// false self-conflict.
async function findCodeOwner(code, exclude = {}) {
  const normalized = (code || '').toString().trim();
  if (!normalized) return null;

  const [teacher, classroom, student] = await Promise.all([
    Teacher.findOne({
      code: normalized,
      ...(exclude.teacherId ? { _id: { $ne: exclude.teacherId } } : {}),
    })
      .select('_id')
      .lean(),
    ClassInfo.findOne({
      classCode: normalized,
      ...(exclude.classId ? { classId: { $ne: exclude.classId } } : {}),
    })
      .select('_id')
      .lean(),
    Student.findOne({
      code: normalized.toUpperCase(),
      ...(exclude.studentId ? { studentId: { $ne: exclude.studentId } } : {}),
    })
      .select('_id')
      .lean(),
  ]);

  // The admin code is itself a Teacher document, so it's checked first to give
  // callers a distinct 'conflicts-with-admin' reason rather than 'duplicate-teacher'.
  if (ADMIN_CODE && normalized === ADMIN_CODE) {
    const isSelf =
      exclude.teacherId &&
      teacher &&
      String(teacher._id) === String(exclude.teacherId);
    return isSelf ? null : 'conflicts-with-admin';
  }
  if (teacher) return 'duplicate-teacher';
  if (classroom) return 'duplicate-class';
  if (student) return 'duplicate-student';
  return null;
}

// Generates a short uppercase class code that doesn't collide with anything in
// the namespace. Used only to backfill legacy classes that lack a classCode.
async function generateClassCode() {
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = 'C';
    for (let i = 0; i < 5; i++) {
      code += CHARS[Math.floor(Math.random() * CHARS.length)];
    }
    if (!(await findCodeOwner(code))) return code;
  }
  // Extremely unlikely — fall back to a timestamp-suffixed code.
  return `C${Date.now().toString(36).toUpperCase()}`;
}

// Read endpoint — used by the homepage, game gates, and the teacher/admin
// panel. Reads by classId. Players omit teacherCode; the panel supplies it and
// we then require admin-or-owner so a teacher can only read their own class.
app.get('/api/game-access', async (req, res) => {
  try {
    const classId = (req.query.classId || '').toString().trim();
    if (!classId) {
      return res.status(400).json({ error: 'A valid classId is required' });
    }
    if (!(await isKnownClass(classId))) {
      return res.status(400).json({ error: 'Class not found' });
    }

    // Only enforce ownership when a credential is actually presented, so the
    // public player read path stays credential-free.
    if (req.query.teacherCode || req.body?.teacherCode) {
      const actor = await requireClassAccess(req, res, classId);
      if (!actor) return;
    }

    res.json(await getGameAccessRows(classId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load game access' });
  }
});

// Admin OR own-class teacher: saves the complete game order for a classId.
// Must stay above /api/game-access/:gameKey.
app.put('/api/game-access/order', async (req, res) => {
  try {
    const { gameKeys } = req.body;
    const classId = (req.body.classId || '').toString().trim();
    if (!classId) {
      return res.status(400).json({ error: 'A valid classId is required' });
    }
    const actor = await requireClassAccess(req, res, classId);
    if (!actor) return;

    const addedKeys = await GameAccess.distinct('gameKey', {
      classId,
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
          filter: { classId, gameKey, added: true },
          update: {
            $set: {
              order,
              updatedBy: actor.name,
              updatedAt,
            },
          },
          upsert: false,
        },
      }))
    );

    res.json({
      ok: true,
      rows: await getGameAccessRows(classId),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save game order' });
  }
});

// Admin OR own-class teacher: adds a game from the shop for a class. Re-adding
// a removed game places it at the end and starts it locked.
app.post('/api/game-access/:gameKey', async (req, res) => {
  try {
    const { gameKey } = req.params;
    const classId = (req.body.classId || '').toString().trim();
    if (!classId) {
      return res.status(400).json({ error: 'A valid classId is required' });
    }
    const actor = await requireClassAccess(req, res, classId);
    if (!actor) return;

    if (!GAME_KEY_RE.test(gameKey)) {
      return res.status(400).json({ error: `Invalid gameKey: "${gameKey}"` });
    }

    const lastAddedGame = await GameAccess.findOne({
      classId,
      added: true,
    })
      .sort({ order: -1 })
      .select('order')
      .lean();

    const order = Number.isFinite(lastAddedGame?.order)
      ? lastAddedGame.order + 1
      : 0;

    await GameAccess.findOneAndUpdate(
      { classId, gameKey },
      {
        $set: {
          added: true,
          unlocked: false,
          shiny: false,
          order,
          updatedBy: actor.name,
          updatedAt: new Date(),
        },
        $setOnInsert: { classId },
      },
      { upsert: true, new: true }
    );

    res.status(201).json({ ok: true, rows: await getGameAccessRows(classId) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not add game to class' });
  }
});

// Admin OR own-class teacher: removes a game from a class (soft-delete —
// sets added:false).
app.delete('/api/game-access/:gameKey', async (req, res) => {
  try {
    const { gameKey } = req.params;
    const classId = (req.body.classId || '').toString().trim();
    if (!classId) {
      return res.status(400).json({ error: 'A valid classId is required' });
    }
    const actor = await requireClassAccess(req, res, classId);
    if (!actor) return;

    if (!GAME_KEY_RE.test(gameKey)) {
      return res.status(400).json({ error: `Invalid gameKey: "${gameKey}"` });
    }

    const doc = await GameAccess.findOneAndUpdate(
      { classId, gameKey, added: true },
      {
        $set: {
          added: false,
          unlocked: false,
          shiny: false,
          updatedBy: actor.name,
          updatedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!doc) return res.status(404).json({ error: 'This game is not in the class' });
    res.json({ ok: true, rows: await getGameAccessRows(classId) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not remove game from class' });
  }
});

// Admin OR own-class teacher: marks one game as featured/shiny.
// Must stay above /api/game-access/:gameKey.
app.put('/api/game-access/:gameKey/shiny', async (req, res) => {
  try {
    const { gameKey } = req.params;
    const { shiny } = req.body;
    const classId = (req.body.classId || '').toString().trim();
    if (!classId) {
      return res.status(400).json({ error: 'A valid classId is required' });
    }
    const actor = await requireClassAccess(req, res, classId);
    if (!actor) return;

    if (!GAME_KEY_RE.test(gameKey)) {
      return res.status(400).json({ error: `Invalid gameKey: "${gameKey}"` });
    }
    if (typeof shiny !== 'boolean') {
      return res.status(400).json({ error: 'shiny must be true or false' });
    }

    const doc = await GameAccess.findOneAndUpdate(
      { classId, gameKey, added: true },
      {
        $set: {
          shiny,
          updatedBy: actor.name,
          updatedAt: new Date(),
        },
      },
      { new: true }
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
    res.status(500).json({ error: 'Could not update shiny game setting' });
  }
});

// Admin OR own-class teacher: locks or unlocks one game for a class.
app.put('/api/game-access/:gameKey', async (req, res) => {
  try {
    const { gameKey } = req.params;
    const { unlocked } = req.body;
    const classId = (req.body.classId || '').toString().trim();
    if (!classId) {
      return res.status(400).json({ error: 'A valid classId is required' });
    }
    const actor = await requireClassAccess(req, res, classId);
    if (!actor) return;

    if (!GAME_KEY_RE.test(gameKey)) {
      return res.status(400).json({ error: `Invalid gameKey: "${gameKey}"` });
    }
    if (typeof unlocked !== 'boolean') {
      return res.status(400).json({ error: 'unlocked must be true or false' });
    }

    const doc = await GameAccess.findOneAndUpdate(
      { classId, gameKey, added: true },
      {
        $set: {
          unlocked,
          updatedBy: actor.name,
          updatedAt: new Date(),
        },
      },
      { new: true }
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
    res.status(500).json({ error: 'Could not update game access' });
  }
});

// ---------------------------------------------------------------------------
// Shared identity helpers
// ---------------------------------------------------------------------------

// Walks Student.mergedInto links to the ultimate primary so callers never see a
// merge chain. Falls back to the record itself if a link is broken/missing.
async function resolvePrimaryStudent(student, depth = 0) {
  if (!student || !student.mergedInto || depth > 10) return student;
  const parent = await Student.findById(student.mergedInto).lean();
  if (!parent) return student;
  return resolvePrimaryStudent(parent, depth + 1);
}

// A deleted student's own play history is removed too, so the identity doesn't
// linger as a name-only "light" entry in the roster — names are the identity
// key, and leaving the sessions behind is why the row used to reappear.
async function removeStudentPlaySessions(classId, student) {
  const names = [student?.nickname, student?.fullName]
    .map((n) => (n || '').toString().trim())
    .filter(Boolean);
  if (names.length === 0) return;
  await PlaySession.deleteMany({ classId, playerName: { $in: names } });
}

// The class-identity payload shared by every login mode.
function classInfoPayload(classroom) {
  return {
    classId: classroom.classId,
    className: classroom.className,
    classAlias: classroom.classAlias || classroom.className,
    classCode: classroom.classCode || null,
    classType: classroom.classType || 'k1',
    isPublic: Boolean(classroom.isPublic),
    image: classroom.image || null,
  };
}

// ---------------------------------------------------------------------------
// System config (maintenance mode). Reads are public so the frontend gate can
// poll them; writes are admin-only.
// ---------------------------------------------------------------------------
app.get('/api/system/config', async (_req, res) => {
  try {
    const doc = await SystemConfig.findById('system').lean();
    res.json({
      maintenanceMode: Boolean(doc?.maintenanceMode),
      maintenanceMessage: doc?.maintenanceMessage || '',
      maintenanceEndsAt: doc?.maintenanceEndsAt || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load system config' });
  }
});

app.patch('/api/system/config', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const update = { updatedAt: new Date(), updatedBy: admin.name };
    if (typeof req.body.maintenanceMode === 'boolean') {
      update.maintenanceMode = req.body.maintenanceMode;
    }
    if (typeof req.body.maintenanceMessage === 'string') {
      update.maintenanceMessage = req.body.maintenanceMessage.slice(0, 300);
    }
    if ('maintenanceEndsAt' in req.body) {
      update.maintenanceEndsAt = req.body.maintenanceEndsAt
        ? new Date(req.body.maintenanceEndsAt)
        : null;
    }

    const doc = await SystemConfig.findByIdAndUpdate(
      'system',
      { $set: update, $setOnInsert: { _id: 'system' } },
      { upsert: true, new: true }
    ).lean();

    res.json({
      maintenanceMode: Boolean(doc.maintenanceMode),
      maintenanceMessage: doc.maintenanceMessage || '',
      maintenanceEndsAt: doc.maintenanceEndsAt || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update system config' });
  }
});

// ---------------------------------------------------------------------------
// Feedback — emailed to the team via Resend.
//
// Deliberately unauthenticated, like /api/plays: feedback has to keep working
// when a session is half-broken, which is exactly when someone is most likely
// to write in. Abuse is handled with a honeypot plus a per-IP rate limit
// instead of an auth check.
// ---------------------------------------------------------------------------

const FEEDBACK_WINDOW_MS = 10 * 60 * 1000;
const FEEDBACK_MAX_PER_WINDOW = 5;
const FEEDBACK_MESSAGE_MAX = 1200;

// ip -> { count, resetAt }. In-memory on purpose: losing the buckets on a
// restart is a non-event for feedback, and this avoids a store round-trip or an
// extra dependency for a single low-traffic endpoint.
const feedbackHits = new Map();

// Sweep expired buckets so a long-lived process can't leak one entry per
// visitor IP. Unref'd so this timer never keeps the process alive on its own.
const feedbackSweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of feedbackHits) {
    if (entry.resetAt <= now) feedbackHits.delete(ip);
  }
}, FEEDBACK_WINDOW_MS);
if (typeof feedbackSweep.unref === 'function') feedbackSweep.unref();

function feedbackRateLimited(ip) {
  const now = Date.now();
  const entry = feedbackHits.get(ip);

  if (!entry || entry.resetAt <= now) {
    feedbackHits.set(ip, { count: 1, resetAt: now + FEEDBACK_WINDOW_MS });
    return false;
  }

  entry.count += 1;
  return entry.count > FEEDBACK_MAX_PER_WINDOW;
}

// Behind Render's proxy the client address is the first hop in
// x-forwarded-for; req.ip is the fallback for direct and local calls.
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || 'unknown';
}

function escapeHtml(value) {
  // The entities below are written as \u0026-escaped literals deliberately.
  // Spelling them out as plain "&"-style text risks an editor or tooling
  // decoding them back to bare "&", which silently turns this into a no-op —
  // exactly the failure this function exists to prevent.
  return String(value ?? '')
    .replace(/&/g, '\u0026amp;')
    .replace(/</g, '\u0026lt;')
    .replace(/>/g, '\u0026gt;')
    .replace(/"/g, '\u0026quot;')
    .replace(/'/g, '\u0026#39;');
}

// Collapses newlines so nothing a user typed can inject extra mail headers
// (a subject line is a header, and a stray \n there is header injection).
function oneLine(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

// Built lazily so a missing key surfaces as a clear 500 on the request that
// needs it, rather than crashing the process at boot.
let resendClient = null;
function getResendClient() {
  if (!resendClient) {
    const key = process.env.RESEND_API_KEY;
    if (!key) return null;
    resendClient = new Resend(key);
  }
  return resendClient;
}

// Comma-separated so adding or removing a recipient is an environment change on
// the host rather than a code change and a redeploy.
const FEEDBACK_TO = (
  process.env.FEEDBACK_TO_EMAIL || 'zisankhanchowdhury@gmail.com'
)
  .split(',')
  .map((address) => address.trim())
  .filter(Boolean);
const FEEDBACK_FROM =
  process.env.FEEDBACK_FROM_EMAIL || 'EZ Wonders <onboarding@resend.dev>';

// Announced once at boot, not only when someone submits. A missing key is a
// deployment mistake, and the deploy log is where it should be noticed — not in
// a user-facing 500 days later.
if (!process.env.RESEND_API_KEY) {
  console.warn(
    'Feedback: RESEND_API_KEY is not set. POST /api/feedback will answer 500 ' +
      'until it is configured in this environment.'
  );
}

app.post('/api/feedback', async (req, res) => {
  try {
    const body = req.body || {};

    // Honeypot. Answers 200 so a bot gets no signal that it was dropped — a
    // 4xx would only teach it to retry differently.
    if ((body.botField || '').toString().trim()) {
      return res.json({ ok: true });
    }

    const message = (body.message || '').toString().trim();
    if (!message) {
      return res.status(400).json({ error: 'A message is required' });
    }
    if (message.length > FEEDBACK_MESSAGE_MAX) {
      return res.status(400).json({ error: 'That message is too long' });
    }

    const ip = clientIp(req);
    if (feedbackRateLimited(ip)) {
      return res
        .status(429)
        .json({ error: 'Too many messages sent. Please try again a bit later.' });
    }

    const resend = getResendClient();
    if (!resend) {
      console.error('Feedback: RESEND_API_KEY is not set');
      return res.status(500).json({ error: 'Feedback email is not configured' });
    }

    const trunc = (value, max) => (value || '').toString().slice(0, max);

    const name = trunc(body.name, 80) || '(not signed in)';
    const className = trunc(body.className, 80) || '(no class)';
    const classId = trunc(body.classId, 80);
    const classType = trunc(body.classType, 20);
    const role = trunc(body.role, 20) || 'unknown';
    const page = trunc(body.page, 300);
    const device = trunc(body.device, 300);
    const userAgent = trunc(body.userAgent, 400);
    const clientReportedIp = trunc(body.ip, 60);
    const submittedAt = new Date();

    // Ordered for triage: the human-readable identity first, then the machine
    // context. `—` (not empty) so a thin row still reads as "deliberately blank"
    // rather than looking like a rendering bug.
    const rows = [
      ['Name', name],
      ['Class', className],
      ['Class ID', classId || '—'],
      ['Class type', classType || '—'],
      ['Role', role],
      ['Submitted', submittedAt.toUTCString()],
      ['IP', ip],
      ['Client-reported IP', clientReportedIp || '—'],
      ['Device', device || '—'],
      ['Page', page || '—'],
      ['User agent', userAgent || '—'],
    ];

    // Every value is escaped before it reaches the HTML. This body is built
    // from free text a child typed, so an unescaped "<" would let a message
    // rewrite the email — or inject a link — inside the team's inbox.
    const html = `
      <div style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; color: #1e293b; max-width: 640px;">
        <h2 style="margin: 0 0 4px; color: #4338ca;">New EZ Wonders feedback</h2>
        <p style="margin: 0 0 16px; color: #64748b; font-size: 13px;">
          Sent from the feedback button on the games home page.
        </p>
        <div style="padding: 16px; border-radius: 12px; background: #f1f5f9; border-left: 4px solid #6d28d9;">
          <p style="margin: 0; white-space: pre-wrap; font-size: 15px; line-height: 1.6;">${escapeHtml(message)}</p>
        </div>
        <table style="margin-top: 20px; border-collapse: collapse; width: 100%; font-size: 13px;">
          ${rows
            .map(
              ([label, value]) => `<tr>
            <td style="padding: 6px 12px 6px 0; color: #64748b; white-space: nowrap; vertical-align: top;">${escapeHtml(label)}</td>
            <td style="padding: 6px 0; color: #0f172a; word-break: break-word;">${escapeHtml(value)}</td>
          </tr>`
            )
            .join('')}
        </table>
      </div>
    `;

    const subject = oneLine(
      `EZ Wonders feedback — ${name}${className ? ` (${className})` : ''}`
    );

    const textBody = `${message}\n\n---\n${rows
      .map(([label, value]) => `${label}: ${value || ''}`)
      .join('\n')}`;

    // One email per recipient, rather than handing Resend the whole array at
    // once. Resend's shared `onboarding@resend.dev` sender only permits
    // delivery to the account owner's own address, so a single disallowed
    // recipient would otherwise fail the entire submission and break the form
    // for everybody — including the addresses that would have worked. This way
    // a partial failure still reaches whoever is reachable, and the bad address
    // shows up in the logs instead of taking the feature down.
    const results = await Promise.all(
      FEEDBACK_TO.map(async (address) => {
        const { error } = await resend.emails.send({
          from: FEEDBACK_FROM,
          to: address,
          subject,
          html,
          // Plain-text twin: readable where HTML is blocked, and it is what
          // inbox previews fall back to when they only read text/plain.
          text: textBody,
        });

        // The SDK reports failures in the payload rather than throwing, so this
        // has to be checked explicitly — otherwise a rejected send looks like
        // a success.
        if (error) {
          console.error(
            `Feedback: Resend rejected the send to ${address}:`,
            error
          );
          return false;
        }
        return true;
      })
    );

    const delivered = results.filter(Boolean).length;

    // Only a total failure is an error for the sender. Anything less means at
    // least one inbox has it, and the console has the details of the rest.
    if (delivered === 0) {
      return res.status(502).json({ error: 'Could not send feedback email' });
    }

    // The counts go back to the client on purpose. A 200 here only means "at
    // least one inbox accepted it", so without this a rejected recipient fails
    // completely silently — and a sender address that isn't verified (Resend
    // refuses every recipient except the account owner's until then) is exactly
    // the mistake this needs to be visible for.
    res.json({ ok: true, delivered, recipients: FEEDBACK_TO.length });
  } catch (err) {
    console.error('Feedback route failed:', err);
    res.status(500).json({ error: 'Could not send feedback' });
  }
});

// ---------------------------------------------------------------------------
// Code namespace check + polymorphic lookup (v2)
// ---------------------------------------------------------------------------

// Encapsulates findCodeOwner() for the UI's live "code available" indicators.
// The create/update endpoints still hard-reject duplicates regardless.
app.post('/api/codes/check', async (req, res) => {
  try {
    const code = (req.body.code || '').toString().trim();
    if (!code) return res.status(400).json({ error: 'code is required' });
    const reason = await findCodeOwner(code, {
      teacherId: req.body.excludeTeacherId,
      classId: req.body.excludeClassId,
      studentId: req.body.excludeStudentId,
    });
    res.json(reason ? { available: false, reason } : { available: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not check code' });
  }
});

// Classifies a code into exactly one identity kind so the login flow can branch.
app.post('/api/code-lookup', async (req, res) => {
  try {
    const code = (req.body.code || '').toString().trim();
    if (!code) return res.status(400).json({ error: 'code is required' });

    // 1. The single global admin code (only when configured via env).
    if (ADMIN_CODE && code === ADMIN_CODE) {
      return res.json({ kind: 'adminCode', name: ADMIN_NAME, role: 'admin' });
    }

    // 2. Teacher code.
    const teacher = await Teacher.findOne({ code }).lean();
    if (teacher) {
      const classInfo = teacher.classId
        ? await ClassInfo.findOne({ classId: teacher.classId }).lean()
        : null;
      return res.json({
        kind: 'teacherCode',
        name: teacher.name,
        classId: teacher.classId,
        className: classInfo?.className || teacher.classId || null,
        classAlias: classInfo?.classAlias || classInfo?.className || null,
        classCode: classInfo?.classCode || null,
        role: teacher.role || 'teacher',
      });
    }

    // 3. Class code. isPublic decides whether step 2 asks for a name (public)
    //    or a student code (private).
    const classroom = await ClassInfo.findOne({ classCode: code }).lean();
    if (classroom) {
      return res.json({
        kind: 'classCode',
        classId: classroom.classId,
        className: classroom.className,
        classAlias: classroom.classAlias || classroom.className,
        classCode: classroom.classCode,
        isPublic: Boolean(classroom.isPublic),
      });
    }

    // 4. Student code. Resolve any merge chain to the primary identity.
    const student = await Student.findOne({ code: code.toUpperCase() }).lean();
    if (student) {
      const primary = await resolvePrimaryStudent(student);
      const classInfo = await ClassInfo.findOne({ classId: primary.classId }).lean();
      return res.json({
        kind: 'studentCode',
        studentId: primary.studentId,
        studentName: primary.nickname || primary.fullName,
        classId: primary.classId,
        className: classInfo?.className || primary.classId,
        classAlias: classInfo?.classAlias || classInfo?.className || null,
        classCode: classInfo?.classCode || null,
        mergedInto: student.mergedInto ? String(student.mergedInto) : null,
      });
    }

    return res.status(404).json({ kind: 'invalid', error: 'Code not recognized' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not look up code' });
  }
});

// POST /api/student-login v2 — supports both login modes:
//   mode A: { studentCode }        → rostered/private login
//   mode B: { name, classCode }    → public "light" login
app.post('/api/student-login', async (req, res) => {
  try {
    const { studentCode, name: rawName, classCode } = req.body;

    if (studentCode) {
      const student = await Student.findOne({
        code: studentCode.toString().trim().toUpperCase(),
      }).lean();
      if (!student) {
        return res.status(404).json({ error: 'Student code not found' });
      }
      const primary = await resolvePrimaryStudent(student);
      const classInfo = await ClassInfo.findOne({ classId: primary.classId }).lean();
      if (!classInfo) {
        return res.status(500).json({ error: 'Class not found for this student' });
      }
      return res.json({
        identityKind: 'student-rostered',
        student: {
          studentId: primary.studentId,
          name: primary.nickname || primary.fullName,
          code: student.code,
        },
        classInfo: classInfoPayload(classInfo),
      });
    }

    // mode B — public-class light login.
    const name = (rawName || '').toString().trim().slice(0, 40);
    if (!name) {
      return res.status(400).json({ error: 'A name is required' });
    }
    const classroom = await ClassInfo.findOne({
      classCode: (classCode || '').toString().trim(),
    }).lean();
    if (!classroom) {
      return res.status(404).json({ error: 'Class code not found' });
    }
    if (!classroom.isPublic) {
      return res.status(403).json({
        error: 'This class requires an individual student code',
      });
    }

    // If a roster student already has this exact name, bind the light session
    // to that record so its history groups under one identity (no backfill).
    const existing = await Student.findOne({
      classId: classroom.classId,
      $or: [{ nickname: name }, { fullName: name }],
    }).lean();

    return res.json({
      identityKind: existing ? 'student-rostered' : 'student-light',
      student: existing
        ? {
            studentId: existing.studentId,
            name: existing.nickname || existing.fullName,
            code: existing.code,
          }
        : { studentId: null, name, code: null },
      classInfo: classInfoPayload(classroom),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not log in' });
  }
});

// Log one completed play session.
app.post('/api/plays', async (req, res) => {
  try {
    const {
      game,
      playerName,
      classId: requestedClassId,
      studentId: requestedStudentId,
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

    // When the caller identifies the student, chase any merge to the primary so
    // the session is stamped with a durable identity and the canonical name.
    let sessionStudentId = null;
    let sessionPlayerName = (playerName || 'Guest').toString().slice(0, 40);
    const requestedStudentIdClean = (requestedStudentId || '').toString().trim();
    if (requestedStudentIdClean) {
      const student = await Student.findOne({
        studentId: requestedStudentIdClean,
        classId,
      }).lean();
      if (student) {
        const primary = await resolvePrimaryStudent(student);
        sessionStudentId = primary.studentId;
        sessionPlayerName = (
          primary.nickname ||
          primary.fullName ||
          sessionPlayerName
        ).toString().slice(0, 40);
      }
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
      playerName: sessionPlayerName,
      studentId: sessionStudentId,
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

// ---------------------------------------------------------------------------
// Shared list helpers for the paginated stats endpoints (/api/summary and
// /api/plays). The teacher panel streams these as the user scrolls, so the
// server owns filtering (game + name search), sorting, and paging instead of
// shipping thousands of rows for the client to re-derive on every render.
// ---------------------------------------------------------------------------

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

// Read-only whitelists of the sort columns each list may be ordered by — any
// other value falls back to that list's default so a bad query can't inject
// an arbitrary sort expression.
const SUMMARY_SORT_KEYS = new Set(['playerName', 'game', 'bestStreak', 'lastPlayedAt']);
const PLAYS_SORT_KEYS = new Set([
  'playerName',
  'game',
  'stars',
  'peakStreak',
  'completedAt',
  'deviceKind',
]);

// Escapes regex metacharacters so a teacher's free-text search is matched
// literally, not interpreted as a pattern.
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Parses + clamps the pagination/filter/sort query params shared by the two
// list endpoints. Always returns a well-formed object the caller can trust.
function parseListParams(req) {
  const limitRaw = Number.parseInt(req.query.limit, 10);
  const limit =
    Number.isInteger(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, LIST_LIMIT_MAX)
      : LIST_LIMIT_DEFAULT;

  const pageRaw = Number.parseInt(req.query.page, 10);
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  const sortDirRaw = (req.query.sortDir || '').toString().toLowerCase();
  const sortDir = sortDirRaw === 'asc' ? 'asc' : 'desc';

  const sortKey = (req.query.sortKey || '').toString().trim();
  const game = (req.query.game || '').toString().trim();
  const q = (req.query.q || '').toString().trim().slice(0, 60);

  return { limit, page, sortDir, sortKey, game, q };
}

// Overall totals plus per-game statistics. Unlike the two list endpoints
// this is intentionally small and loaded once: it feeds the header cards,
// the per-game cards, and the game-filter dropdown, all of which need
// full-class aggregates that can't be derived from a single page of rows.
app.get('/api/stats', async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;
    const match = { classId: teacher.classId };

    // One round-trip: facet splits the matched set into the handful of
    // aggregates the panel needs without separate scans.
    const agg = await PlaySession.aggregate([
      { $match: match },
      {
        $facet: {
          plays: [{ $count: 'n' }],
          players: [{ $group: { _id: '$playerName' } }, { $count: 'n' }],
          basic: [
            {
              $group: {
                _id: '$game',
                plays: { $sum: 1 },
                avgStars: { $avg: '$stars' },
                bestStreak: { $max: '$peakStreak' },
                // elapsedSeconds only exists on bonus/time-trial plays and
                // $avg ignores docs missing it, so this is the per-play
                // average completion time for a game that has any.
                avgElapsedSeconds: { $avg: '$elapsedSeconds' },
              },
            },
          ],
          // Distinct player count per game (the per-game "Players" card).
          playersPerGame: [
            { $group: { _id: { game: '$game', playerName: '$playerName' } } },
            { $group: { _id: '$_id.game', players: { $sum: 1 } } },
          ],
          // Average of each player's *best* streak for a game (not the
          // per-play average) — matches the old "per player" card label.
          bestStreakPerPlayer: [
            {
              $group: {
                _id: { game: '$game', playerName: '$playerName' },
                best: { $max: '$peakStreak' },
              },
            },
            { $group: { _id: '$_id.game', avgBestStreak: { $avg: '$best' } } },
          ],
        },
      },
    ]);

    const totalPlays = agg[0]?.plays?.[0]?.n ?? 0;
    const uniquePlayers = agg[0]?.players?.[0]?.n ?? 0;

    const byGame = new Map((agg[0]?.basic ?? []).map((g) => [g._id, g]));
    for (const g of agg[0]?.playersPerGame ?? []) {
      if (byGame.has(g._id)) byGame.get(g._id).players = g.players;
    }
    for (const g of agg[0]?.bestStreakPerPlayer ?? []) {
      if (byGame.has(g._id)) byGame.get(g._id).avgBestStreak = g.avgBestStreak;
    }

    const perGame = [...byGame.values()].sort((a, b) =>
      String(a._id).localeCompare(String(b._id))
    );

    res.json({ totalPlays, uniquePlayers, perGame });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Could not load stats',
    });
  }
});

// One row per player and game. Two response shapes depending on who asks:
//  - teacher code → class-wide, server-filtered/sorted/paginated object
//    { rows, total, page, limit, hasMore } for the streaming teacher panel.
//  - classId + playerName (single player, e.g. Home/student progress) → plain
//    array, unchanged — one player has only a handful of game rows, so it
//    never needs paging and Home/BetaHome keep working as-is.
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

    // Shared grouping — sorted by completedAt first so $last picks the most
    // recent play's score/rounds rather than an arbitrary one.
    const group = [
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
    ];

    // Single-player path: plain array, no paging.
    if (!teacher) {
      const rows = await PlaySession.aggregate([
        { $match: match },
        ...group,
        { $sort: { game: 1 } },
      ]);
      return res.json(rows);
    }

    const { limit, page, sortDir, sortKey, game, q } = parseListParams(req);
    if (game) match.game = game;
    if (q) match.playerName = { $regex: escapeRegex(q), $options: 'i' };

    const dir = sortDir === 'asc' ? 1 : -1;
    const sortField = SUMMARY_SORT_KEYS.has(sortKey) ? sortKey : 'lastPlayedAt';

    // $facet counts the total distinct player+game rows while slicing just
    // the requested page — one scan, two results.
    const result = await PlaySession.aggregate([
      { $match: match },
      ...group,
      {
        $facet: {
          meta: [{ $count: 'total' }],
          data: [
            { $sort: { [sortField]: dir, playerName: 1, game: 1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
          ],
        },
      },
    ]);

    const total = result[0]?.meta?.[0]?.total ?? 0;
    const rows = result[0]?.data ?? [];
    res.json({ rows, total, page, limit, hasMore: page * limit < total });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Could not load summary',
    });
  }
});

// Paginated, server-filtered/sorted feed of every individual play session,
// newest first by default. The panel streams pages as the teacher scrolls
// instead of the old behavior of returning every session in one payload.
app.get('/api/plays', async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const { limit, page, sortDir, sortKey, game, q } = parseListParams(req);

    const match = { classId: teacher.classId };
    if (game) match.game = game;
    if (q) match.playerName = { $regex: escapeRegex(q), $options: 'i' };

    const dir = sortDir === 'asc' ? 1 : -1;
    const sortField = PLAYS_SORT_KEYS.has(sortKey) ? sortKey : 'completedAt';

    // device.kind is nested and absent on pre-device-tracking plays. Project
    // it to a top-level sortable field with a sentinel so missing values pin
    // to the bottom in both directions (mirrors the old client comparator,
    // which always placed unknowns last).
    const missingDeviceSort = sortDir === 'asc' ? '\uffff' : '\u0000';

    const result = await PlaySession.aggregate([
      { $match: match },
      {
        $facet: {
          meta: [{ $count: 'total' }],
          data: [
            {
              $addFields: {
                deviceKind: { $ifNull: ['$device.kind', missingDeviceSort] },
              },
            },
            { $sort: { [sortField]: dir, _id: dir } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $project: {
                _id: 0,
                playerName: 1,
                game: 1,
                stars: 1,
                totalRounds: 1,
                peakStreak: 1,
                elapsedSeconds: 1,
                mistakes: 1,
                completedAt: 1,
                device: 1,
              },
            },
          ],
        },
      },
    ]);

    const total = result[0]?.meta?.[0]?.total ?? 0;
    // Strip the transient deviceKind sort helper before returning.
    const rows = (result[0]?.data ?? []).map(({ deviceKind, ...doc }) => doc);
    res.json({ rows, total, page, limit, hasMore: page * limit < total });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Could not load play sessions',
    });
  }
});

// Most recent Friday noon, i.e. the start of the current weekly cycle.
// Matches the frontend's NextGameTimer: a new "week" begins every Friday
// at 12:00. If the caller passes ?since= (ISO timestamp), that wins, so the
// client can align the boundary to the player's local timezone.
function weekStartFridayNoon(now = new Date()) {
  const d = new Date(now);
  const daysSinceFriday = (d.getDay() + 2) % 7; // Fri→0, Sat→1 … Thu→6
  d.setDate(d.getDate() - daysSinceFriday);
  d.setHours(12, 0, 0, 0);
  // Before Friday noon today: the current week started last Friday.
  if (d.getTime() > now.getTime()) {
    d.setDate(d.getDate() - 7);
  }
  return d;
}

// Public weekly leaderboard — one trophy per completed play this week,
// grouped by player. Uses the same Friday→Friday window as the frontend
// timer. No teacher code required: this is a shared, class-level display.
app.get('/api/leaderboard', async (req, res) => {
  try {
    const classId = await requireClass(req, res);
    if (!classId) return;

    let since;
    const sinceParam = (req.query.since || '').toString().trim();
    if (sinceParam) {
      const parsed = new Date(sinceParam);
      if (!Number.isNaN(parsed.getTime())) since = parsed;
    }
    if (!since) since = weekStartFridayNoon(new Date());

    const rows = await PlaySession.aggregate([
      { $match: { classId, completedAt: { $gte: since } } },
      {
        $group: {
          _id: '$playerName',
          trophies: { $sum: 1 },
        },
      },
      { $sort: { trophies: -1, _id: 1 } },
      {
        $project: {
          _id: 0,
          playerName: '$_id',
          trophies: 1,
        },
      },
    ]);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Could not load leaderboard',
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
// Weekly mission + player summary
// ---------------------------------------------------------------------------
// All of this is derived from PlaySession inside the current Friday→Friday
// window — there is no stored "weekly state" to reset, so the boundary rolls
// over on its own exactly like the weekly champion leaderboard. The mission is
// "play 4 different games this week"; one session = one trophy (mirrors the
// weekly champions count), and "days learning" is derived client-side from the
// returned play timestamps so the day boundary matches the player's timezone.
const WEEKLY_MISSION_TARGET = 4;

// ?since= (ISO) lets the client pin the boundary to its own local Friday noon;
// when absent we fall back to the server's Friday-noon computation.
function parseWeekSince(req) {
  const raw = (req.query.since || '').toString().trim();
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// A single player's activity since the last Friday, for their own home strip.
// A child's weekly plays are small, so we ship the play list and let the
// client derive trophies (= plays), distinct games (mission) and distinct
// learning days from the same rows — every badge then stays in lockstep.
app.get('/api/player/weekly', async (req, res) => {
  try {
    const classId = await requireClass(req, res);
    if (!classId) return;

    const playerName = (req.query.playerName || '').toString().trim();
    if (!playerName) {
      return res.status(400).json({ error: 'playerName is required' });
    }

    const since = parseWeekSince(req) || weekStartFridayNoon(new Date());

    const plays = await PlaySession.find({
      classId,
      playerName,
      completedAt: { $gte: since },
    })
      .select('game completedAt -_id')
      .sort({ completedAt: 1 })
      .lean();

    res.json({
      since: since.toISOString(),
      target: WEEKLY_MISSION_TARGET,
      plays,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load weekly progress' });
  }
});

// Teacher-only: everyone in their own class who has completed this week's
// mission (played at least 4 different games), so the stats panel can put a
// spotlight on them. Aggregated server-side because a whole class could be
// many sessions.
app.get('/api/weekly-mission', async (req, res) => {
  try {
    const teacher = await requireTeacher(req, res);
    if (!teacher) return;

    const since = parseWeekSince(req) || weekStartFridayNoon(new Date());

    const rows = await PlaySession.aggregate([
      { $match: { classId: teacher.classId, completedAt: { $gte: since } } },
      {
        $group: {
          _id: '$playerName',
          games: { $addToSet: '$game' },
          trophies: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          playerName: '$_id',
          games: 1,
          trophies: 1,
          distinctGames: { $size: '$games' },
        },
      },
      { $match: { distinctGames: { $gte: WEEKLY_MISSION_TARGET } } },
      { $sort: { distinctGames: -1, trophies: -1, playerName: 1 } },
    ]);

    res.json({
      since: since.toISOString(),
      target: WEEKLY_MISSION_TARGET,
      completers: rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load weekly mission' });
  }
});

// ---------------------------------------------------------------------------
// Admin stats (merge-aware). Merges physically retag playerName to the primary,
// so counting distinct playerName already collapses a merged group to one.
// ---------------------------------------------------------------------------
async function computeClassStats(classId) {
  const agg = await PlaySession.aggregate([
    { $match: { classId } },
    {
      $facet: {
        plays: [{ $count: 'n' }],
        players: [{ $group: { _id: '$playerName' } }, { $count: 'n' }],
        basic: [
          {
            $group: {
              _id: '$game',
              plays: { $sum: 1 },
              avgStars: { $avg: '$stars' },
              bestStreak: { $max: '$peakStreak' },
              avgElapsedSeconds: { $avg: '$elapsedSeconds' },
            },
          },
        ],
        playersPerGame: [
          { $group: { _id: { game: '$game', playerName: '$playerName' } } },
          { $group: { _id: '$_id.game', players: { $sum: 1 } } },
        ],
      },
    },
  ]);

  const totalPlays = agg[0]?.plays?.[0]?.n ?? 0;
  const uniquePlayers = agg[0]?.players?.[0]?.n ?? 0;

  const byGame = new Map((agg[0]?.basic ?? []).map((g) => [g._id, g]));
  for (const g of agg[0]?.playersPerGame ?? []) {
    if (byGame.has(g._id)) byGame.get(g._id).players = g.players;
  }
  const perGame = [...byGame.values()].sort((a, b) =>
    String(a._id).localeCompare(String(b._id))
  );
  return { totalPlays, uniquePlayers, perGame };
}

// One summary row per class for the admin stats grid.
app.get('/api/admin/stats/classes', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const classes = await ClassInfo.find().lean();
    const rows = await Promise.all(
      classes.map(async (classroom) => {
        const stats = await computeClassStats(classroom.classId);
        return {
          classId: classroom.classId,
          className: classroom.className,
          classAlias: classroom.classAlias || classroom.className,
          classCode: classroom.classCode || null,
          isPublic: Boolean(classroom.isPublic),
          active: classroom.active !== false,
          totalPlays: stats.totalPlays,
          totalPlayers: stats.uniquePlayers,
        };
      })
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load admin class stats' });
  }
});

// Drill-down: same shape as the teacher /api/stats but for any classId.
app.get('/api/admin/stats/classes/:classId', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const { classId } = req.params;
    if (!(await isKnownClass(classId))) {
      return res.status(404).json({ error: 'Class not found' });
    }
    res.json(await computeClassStats(classId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load class stats' });
  }
});

// ---------------------------------------------------------------------------
// Boot migrations (idempotent, non-destructive, legacy-preserving)
// ---------------------------------------------------------------------------
// Each runs on every deploy but no-ops once its work is done, so redeploys are
// safe. They never delete existing classes, students, codes, or play history.
// The old classType-keyed GameAccess rows are deliberately retained as a
// rollback backup rather than deleted in this pass.

// Ensures the SystemConfig singleton exists with maintenanceMode off.
async function ensureSystemConfig() {
  const existing = await SystemConfig.findById('system').lean();
  if (existing) return;
  await SystemConfig.create({ _id: 'system', maintenanceMode: false });
  console.log('Created SystemConfig singleton (maintenanceMode=false)');
}

// Creates the env-configured admin (if any) and downgrades every other
// role=admin record to teacher, so only the ADMIN_CODE account is admin.
async function migrateAdminRole() {
  if (!ADMIN_CODE) {
    console.warn(
      'ADMIN_CODE is not set — skipping admin bootstrap. Set ADMIN_CODE in the environment to create/keep an admin.'
    );
    // Still give field-less records safe defaults so nothing breaks.
    await Teacher.updateMany({ role: { $exists: false } }, { $set: { role: 'teacher' } });
    await Teacher.updateMany({ active: { $exists: false } }, { $set: { active: true } });
    return;
  }

  const adminExists = await Teacher.findOne({ code: ADMIN_CODE }).lean();
  if (!adminExists) {
    await Teacher.create({
      code: ADMIN_CODE,
      name: ADMIN_NAME,
      classId: null,
      role: 'admin',
      active: true,
    });
    // Deliberately not logging the code itself.
    console.log('Created the admin account from ADMIN_CODE.');
  }

  // Downgrade every other admin so only the env-provided code is admin.
  const downgrade = await Teacher.updateMany(
    { code: { $ne: ADMIN_CODE }, role: 'admin' },
    { $set: { role: 'teacher' } }
  );
  if (downgrade.modifiedCount > 0) {
    console.log(`Downgraded ${downgrade.modifiedCount} admin(s) to teacher`);
  }

  await Teacher.updateMany({ role: { $exists: false } }, { $set: { role: 'teacher' } });
  await Teacher.updateMany({ active: { $exists: false } }, { $set: { active: true } });
}

// Backfills the new ClassInfo fields with safe defaults. Never rewrites the
// classId, className, or image; classType is left untouched (now storage-only).
const autoCodedClasses = [];

async function migrateClassFields() {
  const classes = await ClassInfo.find({
    $or: [
      { isPublic: { $exists: false } },
      { active: { $exists: false } },
      { classCode: { $exists: false } },
      { classAlias: { $exists: false } },
      { classAlias: null },
    ],
  });

  for (const classroom of classes) {
    let changed = false;

    if (classroom.isPublic === undefined) {
      classroom.isPublic = false; // legacy classes stay private (current behavior)
      changed = true;
    }
    if (classroom.active === undefined) {
      classroom.active = true;
      changed = true;
    }
    if (!classroom.classAlias) {
      classroom.classAlias = classroom.className; // safe, preserves meaning
      changed = true;
    }
    if (!classroom.classCode) {
      classroom.classCode = await generateClassCode();
      autoCodedClasses.push({
        classId: classroom.classId,
        classCode: classroom.classCode,
      });
      changed = true;
    }

    if (changed) await classroom.save();
  }

  if (autoCodedClasses.length > 0) {
    console.log(
      'Auto-generated class codes (admin should review):',
      autoCodedClasses.map((c) => `${c.classId}=${c.classCode}`).join(', ')
    );
  }
}

// Clones classType-keyed GameAccess rows into per-class classId rows. The old
// classType rows are intentionally NOT deleted (kept as a rollback backup).
async function migrateGameAccessToClassId() {
  // CRITICAL ORDER: the legacy {classType, gameKey} unique index must be
  // dropped BEFORE any inserts. The cloned rows carry no classType, so Mongo
  // indexes them as classType:null — a second class's clones would then collide
  // on {classType:null, gameKey} and abort the deploy. syncIndexes runs after
  // the inserts to build the new partial {classId, gameKey} index instead.
  await dropLegacyGameAccessIndexes();

  const classes = await ClassInfo.find().lean();

  for (const classroom of classes) {
    // Idempotent guard: skip classes that already have their own rows.
    const already = await GameAccess.countDocuments({ classId: classroom.classId });
    if (already > 0) continue;

    const classType = classroom.classType || 'k1';
    const sourceRows = await GameAccess.find({
      classType,
      classId: { $exists: false },
    }).lean();
    if (sourceRows.length === 0) continue;

    await GameAccess.insertMany(
      sourceRows.map((row) => ({
        classId: classroom.classId,
        gameKey: row.gameKey,
        added: row.added ?? false,
        unlocked: row.unlocked ?? false,
        order: row.order ?? 0,
        shiny: row.shiny ?? false,
        updatedBy: row.updatedBy || null,
        updatedAt: row.updatedAt || new Date(),
      })),
      { ordered: false }
    );
    console.log(`Cloned ${sourceRows.length} GameAccess rows → class ${classroom.classId}`);
  }

  await GameAccess.syncIndexes();
}

// Drops the legacy classType-keyed unique index (and any legacy gameKey-only
// index) so the new partial {classId, gameKey} index from the model can take
// effect. Idempotent — a missing index is not an error.
async function dropLegacyGameAccessIndexes() {
  const existingIndexes = await GameAccess.collection.indexes();
  for (const idx of existingIndexes) {
    if (idx.name === 'classType_1_gameKey_1' || idx.name === 'gameKey_1') {
      try {
        await GameAccess.collection.dropIndex(idx.name);
        console.log(`Dropped legacy index: ${idx.name}`);
      } catch (err) {
        if (err.codeName !== 'IndexNotFound' && err.code !== 27) throw err;
      }
    }
  }
}

// One-time audit: reports duplicate or cross-conflicting codes WITHOUT renaming
// anything, since changing a code would break printed badges/shared links.
async function auditCodeConflicts() {
  const [teachers, classes, students] = await Promise.all([
    Teacher.find({ active: { $ne: false } }).select('code -_id').lean(),
    ClassInfo.find().select('classCode -_id').lean(),
    Student.find({ code: { $exists: true } }).select('code -_id').lean(),
  ]);

  const seen = new Map();
  const conflicts = [];
  const add = (code, bucket) => {
    if (!code) return;
    const key = code.toString().trim();
    if (!key) return;
    if (seen.has(key)) {
      conflicts.push({ code: key, buckets: [seen.get(key), bucket] });
    } else {
      seen.set(key, bucket);
    }
  };
  teachers.forEach((t) => add(t.code, 'teacher'));
  classes.forEach((c) => add(c.classCode, 'class'));
  students.forEach((s) => add(s.code, 'student'));

  if (conflicts.length > 0) {
    console.warn(
      `Code namespace conflicts found (${conflicts.length}) — admin should resolve:`,
      JSON.stringify(conflicts)
    );
  } else {
    console.log('Code namespace audit: no conflicts');
  }
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
    // Close idle connections after 12 min — comfortably above the 10-min
    // cron interval, so the health-check ping always refreshes connections
    // before they expire. Prevents Render's load-balancer or MongoDB Atlas
    // from silently dropping them while still recycling truly dead ones.
    maxIdleTimeMS: 720_000,
    // Fail fast (5 s) instead of the default 30 s if the server can't
    // reach MongoDB at all — avoids a 30-second hang on cold-start.
    serverSelectionTimeoutMS: 5_000,
  })
  .then(async () => {
    await ensureSystemConfig();
    await migrateAdminRole();
    await migrateClassFields();
    await migrateGameAccessToClassId();
    await migrateStudentCodes();
    await auditCodeConflicts();
    await ClassInfo.syncIndexes();
    await Teacher.syncIndexes();
    await Student.syncIndexes();
    await PlaySession.syncIndexes();
    await PlayerMerge.syncIndexes();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });