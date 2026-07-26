// Server-side mirror of frontend/teacherCodes.js. This is what actually
// guards write access to /api/game-access — the frontend's isTeacher flag
// is just UI state, so anyone with dev tools could fake it. Checking the
// real code again here is what stops a student from unlocking games by
// calling the API directly.
//
// IMPORTANT: keep this in sync with the frontend's TEACHER_CODES by hand.
// If you add/remove a teacher's code on one side, update the other.
const TEACHER_CODES = {
  '12/10/22': 'Siti Soleha',
  '92702689': 'DEVZee',
};

// Looks up a code and returns the matching teacher's name, or null.
function lookupTeacher(code) {
  const trimmed = (code || '').toString().trim();
  return TEACHER_CODES[trimmed] || null;
}

module.exports = { TEACHER_CODES, lookupTeacher };
