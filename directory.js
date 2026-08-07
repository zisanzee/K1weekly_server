// Database-backed replacement for the old teacherCodes.js. Keeps the exact
// same exported shape (lookupTeacher / getClasses / isKnownClass) so
// server.js's call sites barely change — the only difference is these are
// now async, since they hit Mongo instead of an in-memory object.
const Teacher = require('./models/Teacher');
const ClassInfo = require('./models/ClassInfo');

// Looks up a code and returns { name, classId, className, classType, role },
// or null. Used by POST /api/teacher-login and the requireTeacher /
// requireAdmin middleware — the frontend receives the full object so its
// zustand store stays in sync (isAdmin, classType, etc.).
async function lookupTeacher(code) {
  const trimmed = (code || '').toString().trim();
  if (!trimmed) return null;

  const teacher = await Teacher.findOne({ code: trimmed }).lean();
  if (!teacher) return null;

  const classInfo = await ClassInfo.findOne({ classId: teacher.classId }).lean();

  return {
    name: teacher.name,
    classId: teacher.classId,
    className: classInfo?.className || teacher.classId,
    classType: classInfo?.classType || 'k1',
    role: teacher.role || 'teacher',
  };
}

// Resolves a classId to its classType ('k1' or 'k2'). Returns null if the
// class doesn't exist. Used by GET /api/game-access to resolve classId→classType
// server-side so the read-path contract stays unchanged.
async function classTypeForClassId(classId) {
  if (!classId) return null;
  const doc = await ClassInfo.findOne({ classId }).select('classType -_id').lean();
  return doc?.classType || null;
}

async function getClasses() {
  const classes = await ClassInfo.find().lean();
  return classes.map((classroom) => ({
    id: classroom.classId,
    name: classroom.className,
    classType: classroom.classType || 'k1',
  }));
}

async function isKnownClass(classId) {
  if (!classId) return false;
  return Boolean(await ClassInfo.exists({ classId }));
}

// One-time seed so existing deployments keep working after switching from
// the hardcoded file to the database. Only inserts when a collection is
// completely empty, so it's safe to leave this call in place permanently —
// it will never overwrite codes/classes added later through the database.
async function seedDirectoryIfEmpty() {
  if ((await Teacher.countDocuments()) === 0) {
    await Teacher.insertMany([
      { code: '12/10/22', name: 'Siti Soleha', classId: 'k12026-pny', role: 'admin' },
      { code: '92702689', name: 'DEVZee', classId: 'test2026-jyx', role: 'admin' },
    ]);
  }

  if ((await ClassInfo.countDocuments()) === 0) {
    await ClassInfo.insertMany([
      { classId: 'k12026-pny', className: 'Kindergarten 1', classType: 'k1' },
      { classId: 'test2026-jyx', className: 'Test class', classType: 'k1' },
    ]);
  }
}

module.exports = { lookupTeacher, getClasses, isKnownClass, seedDirectoryIfEmpty, classTypeForClassId };
