const mongoose = require('mongoose');

// One document per teacher access code. This replaces the old hardcoded
// TEACHER_CODES object in teacherCodes.js — codes can now be added, changed,
// or removed without a redeploy. `classId` links a teacher to a class
// document in ClassInfo (a class can have more than one teacher).
const teacherSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, trim: true },
  name: { type: String, required: true, trim: true },
  // Null for the global admin, who is not bound to any single class.
  classId: { type: String, default: null, index: true },
  // 'admin' can edit any class's config; 'teacher' can only view and manage
  // their own class. Only one admin code exists after the migration.
  role: { type: String, enum: ['teacher', 'admin'], default: 'teacher' },
  // Soft-deactivate rather than delete a teacher, so historical stats rows
  // that reference them keep resolving to a real record.
  active: { type: Boolean, default: true, required: true },
});

module.exports = mongoose.model('Teacher', teacherSchema);
