const mongoose = require('mongoose');

// Basic display info about a class. The list of teachers for a class is
// NOT stored here — it's derived by querying Teacher for a matching
// classId, so it can never go stale if a teacher's class changes.
const classInfoSchema = new mongoose.Schema({
  classId: { type: String, required: true, unique: true },
  className: { type: String, required: true, trim: true },
  // Free-text school year label (e.g. "2026"). Backfilled to null for legacy
  // classes rather than guessed, so admins can fill in the real value.
  classYear: { type: String, default: null, trim: true },
  // Short human-friendly label. Legacy classes copy className here so nothing
  // renders as blank; admins can rename. Distinct from className (display name).
  classAlias: { type: String, default: null, trim: true },
  // The class's own login code — globally unique across the whole code
  // namespace (teacher/class/student/admin codes must not collide). Sparse so
  // legacy rows without one stay valid until the boot migration backfills.
  classCode: { type: String, unique: true, sparse: true, trim: true },
  // Public classes let students join with name + classCode; private classes
  // require an individual student code. Legacy classes default to private so
  // their existing behaviour is preserved exactly.
  isPublic: { type: Boolean, default: false, required: true },
  // Retired/inactive classes are hidden from normal flows but never deleted.
  active: { type: Boolean, default: true, required: true },
  // A URL/path to the class photo. Left null until a teacher uploads one;
  // the frontend renders a placeholder whenever this is empty.
  image: { type: String, default: null },
  // DEPRECATED: kept only so legacy documents still validate/read. It no
  // longer drives game access or permissions — all live logic keys on classId.
  classType: {
    type: String,
    enum: ['k1', 'k2'],
    default: 'k1',
  },
});

module.exports = mongoose.model('ClassInfo', classInfoSchema);
