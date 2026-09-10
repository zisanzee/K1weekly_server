const mongoose = require('mongoose');

// Records a name-identity merge within one class. The brief's Student.mergedInto
// covers roster students, but per the user's clarification merges mostly target
// "light" kids who only ever gave name + class code and therefore have no
// Student record. So the authoritative merge record is name-based and lives
// here; Student.mergedInto is still written when a merged name maps to a roster
// student, so student-code logins resolve to the primary too.
//
// One row per merge action. `members` are the names folded into `primaryName`.
// A member that is itself the primary of another active row forms a chain; the
// unmerge endpoint only allows undoing the most recent link (LIFO) so chains
// stay consistent.
const playerMergeSchema = new mongoose.Schema({
  classId: { type: String, required: true, index: true },
  // The canonical display name sessions were retagged to.
  primaryName: { type: String, required: true, trim: true },
  // Names merged into primaryName (excludes primaryName itself).
  members: { type: [String], default: [] },
  // Teacher/admin code that performed the merge — audit only.
  createdBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  // Soft-revoked on unmerge so an audit trail survives without cluttering the
  // active merge set.
  active: { type: Boolean, default: true, index: true },
});

module.exports = mongoose.model('PlayerMerge', playerMergeSchema);
