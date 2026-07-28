const mongoose = require('mongoose');

// One document per teacher access code. This replaces the old hardcoded
// TEACHER_CODES object in teacherCodes.js — codes can now be added, changed,
// or removed without a redeploy. `classId` links a teacher to a class
// document in ClassInfo (a class can have more than one teacher).
const teacherSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, trim: true },
  name: { type: String, required: true, trim: true },
  classId: { type: String, required: true, index: true },
});

module.exports = mongoose.model('Teacher', teacherSchema);
