const mongoose = require('mongoose');
const { randomUUID } = require('crypto');

const studentSchema = new mongoose.Schema({
  // A stable public id, separate from Mongo's _id, so the frontend never
  // has to deal with ObjectId formatting and this could be swapped to a
  // different id scheme later without touching the API shape.
  studentId: {
    type: String,
    required: true,
    unique: true,
    default: () => randomUUID(),
  },
  classId: { type: String, required: true, index: true },
  fullName: { type: String, required: true, trim: true },
  // Optional — defaults to empty rather than falling back to fullName, so
  // the UI can decide how to display a student with no nickname set.
  nickname: { type: String, default: '', trim: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Student', studentSchema);
