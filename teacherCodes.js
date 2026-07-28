// Server-side mirror of frontend/teacherCodes.js. This is what actually
// guards write access to /api/game-access — the frontend's isTeacher flag
// is just UI state, so anyone with dev tools could fake it. Checking the
// real code again here is what stops a student from unlocking games by
// calling the API directly.
//
// IMPORTANT: keep this in sync with the frontend's TEACHER_CODES by hand.
// If you add/remove a teacher's code on one side, update the other.
const TEACHER_CODES = {
  '12/10/22': {
    name: 'Siti Soleha',
    className: 'Kindergarten 1',
    classId: 'k12026-pny'
  },
  '92702689': {
    name: 'Dev Zee',
    className: 'Test class',
    classId: 'test2026-jyx'
  }
};

// Looks up a code and returns the matching teacher's name, or null.
function lookupTeacher(code) {
  const trimmed = (code || '').toString().trim();
  return TEACHER_CODES[trimmed] || null;
}

function getClasses() {
  return Array.from(
    new Map(
      Object.values(TEACHER_CODES).map((teacher) => [
        teacher.classId,
        { id: teacher.classId, name: teacher.className },
      ])
    ).values()
  );
}

function isKnownClass(classId) {
  return getClasses().some((classroom) => classroom.id === classId);
}

module.exports = { TEACHER_CODES, lookupTeacher, getClasses, isKnownClass };
