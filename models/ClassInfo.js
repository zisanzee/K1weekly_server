const mongoose = require('mongoose');

// Basic display info about a class. The list of teachers for a class is
// NOT stored here — it's derived by querying Teacher for a matching
// classId, so it can never go stale if a teacher's class changes.
const classInfoSchema = new mongoose.Schema({
  classId: { type: String, required: true, unique: true },
  className: { type: String, required: true, trim: true },
  // A URL/path to the class photo. Left null until a teacher uploads one;
  // the frontend renders a placeholder whenever this is empty.
  image: { type: String, default: null },
  // Determines which game arrangement this class sees. 'k1' and 'k2' are
  // the current values; add more here if new class types are introduced.
  classType: {
    type: String,
    enum: ['k1', 'k2'],
    default: 'k1',
    required: true,
  },
});

module.exports = mongoose.model('ClassInfo', classInfoSchema);
