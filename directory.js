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
    classAlias: classInfo?.classAlias || classInfo?.className || null,
    classCode: classInfo?.classCode || null,
    classType: classInfo?.classType || 'k1',
    isPublic: Boolean(classInfo?.isPublic),
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

// NOTE: the old seedDirectoryIfEmpty() was removed on purpose. It hardcoded
// teacher codes and classes in source, which we no longer want. The only
// bootstrapped credential now comes from the ADMIN_CODE env var (see
// migrateAdminRole in server.js); everything else is created through the admin
// panel and lives solely in the database.

module.exports = { lookupTeacher, getClasses, isKnownClass, classTypeForClassId };
