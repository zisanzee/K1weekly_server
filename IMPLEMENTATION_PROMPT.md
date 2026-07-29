# Task: Class-type game config + admin role overhaul

## Goal
Today, game unlock/order/shiny/shop-membership ("GameAccess") is scoped per
individual class (`classId`), and any teacher can edit it for their own
class. Change this so:

1. Game config is scoped per **class type** (`k1` or `k2` for now, more
   later), not per individual class. All classes of the same type see the
   identical arrangement.
2. Only **admins** can edit game config (order, lock/unlock, shop add/
   remove, shiny/featured). Regular teachers can only view it.
3. Each class still has its own students and its own play-session data
   (`classId`-scoped) — that part does NOT change. A class simply gains a
   `classType` field that determines which GameAccess set it reads from.
4. For now: every class (including the legacy `k12026-pny` class and the
   `test2026-jyx` test class) is `classType: 'k1'`. The two existing
   teacher codes become admins.

## Key design decision — read this before changing anything
Keep every **read** of game access keyed by `classId`, exactly like today
(`GET /api/game-access?classId=`, `useGameAccessStore.fetchGameAccess`,
`GameAccessGate`, `useIsGameUnlocked`, the homepage cards). The server
resolves `classId → classType` internally and returns that type's rows.
**Do not change the signature or call sites of the existing read path.**
Only the admin **write/edit** path (teacher panel) needs to work in terms
of `classType` directly, since an admin edits a class type regardless of
their own homeroom class.

## Known bug to fix as part of this (don't skip)
`NameGate.jsx`'s teacher-code submit currently calls a local `lookupTeacher`
against a hardcoded frontend file (`teacherCodes.js`) and never contacts
the server — it builds the whole "teacher" object client-side. Since roles
now need to come from the database, this must become a real API call (see
Phase 4/5). Delete the frontend `teacherCodes.js` mirror once this is done
— keep the backend one (used server-side for real validation).

## Assumptions (correct me if wrong, otherwise proceed with these)
- Admins keep a home `classId` (their own homeroom), they're not classless.
- `classType` is a plain enum string for now (`'k1' | 'k2'`), not a full
  Mongo collection — same pattern as the hardcoded `GAME_CATALOG`. Easy to
  add a third value later.
- Assigning a class's `classType` is an admin action but the UI for it can
  be minimal/deferred — the backend endpoint should exist, a full settings
  UI for it is optional polish (Phase 6, last).
- Students/PlaySession stay `classId`-scoped — no change to those models.
- Student records remain pure roster data with no functional wiring
  elsewhere (not tied to game unlocking, PlaySession matching, stats,
  etc.). Don't invent any linkage for them as part of this task — adding
  a student is a standalone, side-effect-free action, both before and
  after this overhaul.
- Non-admin teachers get exactly three things in the panel: view their
  class info, add students to their own roster, and view (read-only)
  their own class type's game arrangement. Nothing else should be
  reachable by them — no edit controls of any kind, on any tab.

---

## Phase 1 — Data model changes

**`models/Teacher.js`**
- Add `role: { type: String, enum: ['teacher', 'admin'], default: 'teacher' }`.

**`models/ClassInfo.js`**
- Add `classType: { type: String, enum: ['k1', 'k2'], default: 'k1', index: true }`.

**`models/GameAccess.js`**
- Replace `classId` with `classType: { type: String, required: true, enum: ['k1', 'k2'], index: true }`.
- Replace the compound unique index `{classId, gameKey}` with `{classType, gameKey}`.
- ⚠️ Mongoose schema changes do **not** auto-migrate existing indexes in
  MongoDB. The old `{classId:1, gameKey:1}` unique index must be explicitly
  dropped, or documents lacking `classId` will collide against it. Handle
  this in the Phase 2 migration, then call `GameAccess.syncIndexes()` (or
  drop the named index directly) so Mongo builds the new one.

No changes to `models/Student.js` or `models/PlaySession.js`.

## Phase 2 — One-time migration (runs at boot, must be idempotent)

Add to (or extend the existing migration pattern next to) `migrateLegacyClassData()`
in `server.js`, e.g. `migrateClassTypeAndGameAccess()`:

1. **Teachers → admins**: for the two seeded/legacy teacher codes
   (`12/10/22` and `92702689`), set `role: 'admin'` if not already set.
   Guard: only touch docs where `role` is missing/undefined, so re-running
   this doesn't clobber roles an admin manually changed later.
2. **Classes → classType**: for every `ClassInfo` doc missing a `classType`,
   set `classType: 'k1'`. (Both `k12026-pny` and `test2026-jyx` end up k1.)
3. **GameAccess → classType**: for each existing `classId`-scoped
   `GameAccess` row:
   - Group by `gameKey`.
   - Prefer the row from the "real" legacy class (`k12026-pny`) as the
     source of truth for `classType: 'k1'`, when both classes have a row
     for the same `gameKey` and they differ.
   - Insert one new document per `gameKey` under `classType: 'k1'`
     (keep `unlocked`, `added`, `order`, `shiny`).
   - After inserting, drop the old `classId`-keyed documents and the old
     unique index; run `GameAccess.syncIndexes()`.
   - Guard this whole step behind a check like "any GameAccess doc still
     has a `classId` field" so it only runs once.
4. Log a one-line summary of what the migration did (counts), so it's
   visible in the Render deploy log for a sanity check.

Call this migration in the same `mongoose.connect().then(...)` chain,
after `seedDirectoryIfEmpty()` and before `app.listen(...)`, same as the
existing `migrateLegacyClassData()` call.

## Phase 3 — `directory.js` helpers

- `lookupTeacher(code)`: also return `role` and the teacher's `classType`
  (resolved from their `classId` via `ClassInfo`). Response shape becomes
  `{ name, classId, className, classType, role }`.
- Add `classTypeForClassId(classId)`: looks up `ClassInfo`, returns its
  `classType` (or null if the class doesn't exist).
- Add `requireAdmin(req, res)` in `server.js` (or export a checker from
  `directory.js` and wrap it in `server.js` like the existing
  `requireTeacher`/`requireClass` pattern): same shape as `requireTeacher`
  but additionally checks `teacher.role === 'admin'`, else
  `403 { error: 'Admins only' }`.

## Phase 4 — Backend endpoints (`server.js`)

**Read path (keep the contract, change the internals):**
- `GET /api/game-access?classId=`: resolve `classId → classType` via
  `classTypeForClassId`, 400 if unknown, then query `GameAccess` by that
  `classType` instead of `classId`. Response shape to the frontend is
  unchanged.

**New login endpoint (fixes the bug above):**
- `POST /api/teacher-login` — body `{ code }`. Calls `lookupTeacher`,
  returns `401 { error }` if not found, else
  `200 { name, classId, className, classType, role }`.

**Write path — now classType-scoped and admin-only:**
- `PUT /api/game-access/:gameKey` (unlocked), `PUT /api/game-access/:gameKey/shiny`,
  `PUT /api/game-access/order`, `POST /api/game-access/:gameKey` (shop add),
  `DELETE /api/game-access/:gameKey` (shop remove):
  - Swap `requireTeacher` → `requireAdmin`.
  - Read `classType` from `req.body.classType` (validate it's `'k1'` or
    `'k2'`), not from `teacher.classId` anymore.
  - Everywhere these currently do `GameAccess.findOneAndUpdate({classId, gameKey}, ...)`,
    change to `{classType, gameKey}`.

**Class info:**
- `GET /api/classes/:classId`: include `classType` in the response.
- Optional/stretch: `PUT /api/classes/:classId` (admin-only) to set
  `className`/`image`/`classType`. Only build this if time allows — not
  required for the core goal.

## Phase 5 — Frontend session/auth

**`playerStore.js`**
- Add `isAdmin: false` and `classType: null` to initial state and to
  `resetPlayer()`.
- `setTeacher(teacher, code)`: also set `isAdmin: teacher.role === 'admin'`
  and `classType: teacher.classType`.

**`NameGate.jsx`**
- `handleCodeSubmit` becomes async: call `POST /api/teacher-login` with
  `{ code: codeDraft.trim() }` instead of the local `lookupTeacher` import.
  On success call `setTeacher(data, codeDraft.trim())`; on failure show the
  existing `codeError` UI. Add a small loading/disabled state on the
  submit button while the request is in flight (mirror the pattern already
  used for `classesStatus` in the old multi-class version of this file).
- Remove the `import { lookupTeacher } from './teacherCodes'` line.

**Delete the frontend `teacherCodes.js`** once nothing imports it. Keep
the backend one (real validation lives server-side already).

## Phase 6 — Frontend game-access admin editing

**Do not touch** the existing `useGameAccessStore` / `fetchGameAccess(classId)`
/ `useIsGameUnlocked` / `isGameUnlockedNow` — the homepage and
`GameAccessGate` keep using these exactly as-is.

**Add new classType-scoped admin functions** in `gameAccess.js` (or a new
adjacent file `gameAccessAdmin.js` if that reads cleaner) mirroring the
existing mutators but keyed by `classType` instead of relying on the
teacher's own `classId`:
- `fetchGameAccessForType(classType)` — `GET`-equivalent for the admin
  panel (you'll need a small new read endpoint, or extend `GET
  /api/game-access` to also accept `?classType=` directly for admin use —
  either is fine, pick whichever is less invasive to the existing route).
- `setGameUnlockedForType(gameKey, unlocked, classType, teacherCode)`
- `setGameShinyForType(gameKey, shiny, classType, teacherCode)`
- `setGameOrderForType(gameKeys, classType, teacherCode)`
- `addGameToType(gameKey, classType, teacherCode)`
- `removeGameFromType(gameKey, classType, teacherCode)`

All of these send `classType` in the body/query alongside `teacherCode`,
matching the new admin-only endpoints from Phase 4.

**`GameAccessPanel.jsx`**
- Read `isAdmin` and `classType` from `usePlayerStore`.
- Restructure the tab bar for admins into: **"K1 Games"**, **"K2 Games"**,
  "Students", "Settings" — i.e. the single "access" tab splits into two
  top-level tabs, one per class type, not a toggle inside one tab. Default
  the initially-active tab to the admin's own `classType`. Each tab
  independently calls `fetchGameAccessForType('k1')` /
  `fetchGameAccessForType('k2')` (lazily, only when first opened, same
  pattern the Students/Settings tabs already use) and all edits made while
  a tab is active (drag-reorder, lock/unlock, shiny, shop add/remove) send
  that tab's `classType`.
- **Both tabs must be fully functional immediately**, not just K1 with a
  K2 stub — an admin can add games to K2's shop, reorder them, lock/unlock
  them, etc. even though no real class is assigned `classType: 'k2'` yet.
  An empty/default K2 state (no games added) is expected and fine, but the
  controls themselves must work.
- For non-admin teachers, collapse this back to a single **"Games"** tab
  (no K1/K2 split — they only need their own class's type) rendered
  read-only: no drag handles, no lock/shiny toggle buttons, just the
  current state as static badges (locked/unlocked, shiny or not, in
  current order) for the caller's own `classType`. Across the whole
  panel, a non-admin teacher's total capability is: view class info
  (Settings tab), add students (Students tab), view game arrangement
  (Games tab). Nothing else should be clickable/editable anywhere for them.
- The Students tab and its "Add new student" flow are unaffected — that
  stays `classId`-scoped and available to any teacher for their own class.

## Phase 7 — Verification checklist (do these before calling it done)
- [ ] Fresh boot against a copy of the real data: migration runs once,
      logs a sane summary, and running the server a second time does
      nothing (no duplicate GameAccess rows, no re-flipping of manually
      changed teacher roles).
- [ ] Existing legacy teacher code logs in → `isAdmin: true`,
      `classType: 'k1'`, "K1 Games" tab is active by default, can
      reorder/lock/unlock/add-from-shop there, and the "K2 Games" tab
      works identically (empty/default game list is fine, but every
      control — add, reorder, lock/unlock, shiny — functions on K2 too).
- [ ] A plain (non-admin) teacher account (create a test one with
      `role: 'teacher'` directly in the DB) logs in → sees the panel in
      read-only mode, gets `403` if they hit the write endpoints directly.
- [ ] That same non-admin account, clicked through every tab: Settings
      shows class info with no edit controls, Games shows their class
      type's arrangement with no edit controls, Students shows the roster
      *and* the "Add new student" form still works (this one write action
      is intentionally allowed). No other button/control on any tab
      results in a successful mutation.
- [ ] A player (name-only login, no code) still sees the homepage's
      unlocked games correctly, unaffected by any of this.
- [ ] Direct URL to a locked game (`/Game3`) still shows the "not out yet"
      screen for players, still lets teachers/admins through.
- [ ] `POST /api/plays` still logs sessions correctly (classId-scoped,
      untouched by this change).
- [ ] Old `GameAccess` unique index on `{classId, gameKey}` is confirmed
      gone (check indexes on the collection) so it can't silently reject
      future writes.

## Phase 8 — Rollback safety
Before running Phase 2 against production data, back up the `GameAccess`
and `Teacher`/`ClassInfo` collections (a `mongodump` of just those three,
or an export). The GameAccess migration is destructive (old classId-keyed
docs get removed) — make sure you have a copy before it runs the first
time.
