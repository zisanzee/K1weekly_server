const mongoose = require('mongoose');

// A single global config document (fixed _id so it's trivial to find and
// there can only ever be one). Holds app-wide flags that aren't tied to any
// class, currently just maintenance mode.
const systemConfigSchema = new mongoose.Schema({
  _id: { type: String, default: 'system' },
  // When true, students see a full-screen maintenance overlay on every route.
  // Teachers/admins are never blocked. Enforced primarily client-side; the
  // flag itself lives here so a toggle takes effect without a redeploy.
  maintenanceMode: { type: Boolean, default: false },
  // Optional admin-authored message shown on the maintenance screen instead of
  // the default copy. Empty string means "use the default text".
  maintenanceMessage: { type: String, default: '', trim: true },
  // Optional scheduled end time. When set in the future the overlay shows a
  // countdown; once it passes the admin UI surfaces that maintenance should be
  // switched off (we never auto-toggle, so nothing surprises the admin).
  maintenanceEndsAt: { type: Date, default: null },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: String, default: null },
});

module.exports = mongoose.model('SystemConfig', systemConfigSchema);
