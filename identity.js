const PlayerMerge = require('./models/PlayerMerge');
const PlaySession = require('./models/PlaySession');
const Student = require('./models/Student');

// ---------------------------------------------------------------------------
// Player-identity resolution + automatic similar-name merging.
//
// The teacher-facing merge feature keeps the primary NAME as the identity key
// and physically retags PlaySession.playerName to it. That works for history,
// but a name that is merely a VARIANT of the primary is not automatically
// folded in — a child who logs in as "Alyssa Tan" on a new device while the
// merge kept "Alyssa" would land in a fresh, separate bucket.
//
// These helpers close that gap:
//   * resolveCanonicalName() rewrites any player-supplied name to the merge
//     primary it belongs to, so new sessions join the combined stats.
//   * autoDetectMerges()/findSimilarNameMerge() detect when a shorter name is a
//     whole-word part of a longer existing name and persist that as a normal
//     PlayerMerge — every member name is retained so it stays unmergeable.
// ---------------------------------------------------------------------------

// Mongo-style canonical text: lowercase, strip punctuation, collapse spaces.
function normName(name) {
  return (name || '')
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// True when `short` is a whole-word substring of `long` under the canonical
// form — e.g. "alyssa" in "alyssa tan", or "ali" in "ali hasan". Word-boundary
// matching (not raw substring) is deliberate: it avoids "ann"/"anna" style
// false positives that a bare includes() would create.
function nameContainsName(longName, shortName) {
  const longNorm = normName(longName);
  const shortNorm = normName(shortName);
  if (!longNorm || !shortNorm) return false;
  if (longNorm === shortNorm) return false;
  if (shortNorm.length < 3) return false;
  return ` ${longNorm} `.includes(` ${shortNorm} `);
}

// --- per-class cache (5 min TTL) -------------------------------------------
// The auto-merge scan runs on hot read paths, so the "is there anything left to
// detect?" answer is cached per class. Every merge/unmerge write invalidates the
// class so the next read re-scans. Skipping work never serves stale truth: the
// cache only decides whether to *look*, never what to return.
const CACHE_TTL_MS = 5 * 60 * 1000;
const autoMergeCache = new Map(); // classId -> last scan timestamp

function invalidateAutoMergeCache(classId) {
  if (classId) autoMergeCache.delete(classId);
  else autoMergeCache.clear();
}

function shouldSkipAutoScan(classId) {
  const last = autoMergeCache.get(classId);
  return typeof last === 'number' && Date.now() - last < CACHE_TTL_MS;
}

function markAutoScanned(classId) {
  autoMergeCache.set(classId, Date.now());
}

// Live identity names for a class: roster names ∪ distinct play-session names.
// Roster students already marked mergedInto are skipped so folded-away names
// don't keep re-triggering the scan.
async function collectClassNames(classId) {
  const [students, played] = await Promise.all([
    Student.find({ classId, deletedAt: null, mergedInto: null })
      .select('nickname fullName -_id')
      .lean(),
    PlaySession.distinct('playerName', { classId, deletedAt: null }),
  ]);

  const names = new Set();
  for (const s of students) {
    const n = (s.nickname || s.fullName || '').toString().trim();
    if (n) names.add(n);
  }
  for (const n of played) {
    const t = (n || '').toString().trim();
    if (t && t !== 'Guest') names.add(t);
  }
  return [...names];
}

// The name that should become the canonical identity: the longest name in the
// group, so the fuller "Alyssa Tan" is kept and "Alyssa" folds into it.
function pickPrimaryName(seed, related) {
  return [seed, ...related].sort(
    (a, b) => normName(b).length - normName(a).length || a.localeCompare(b)
  )[0];
}

// Convenience wrapper: loads context and plans one auto-merge around `seed`.
async function findSimilarNameMerge(classId, seed) {
  const ctx = await loadScanContext(classId);
  return planMergeForSeed(seed, ctx);
}

// Gathers everything the detector needs for a class in one pass: the live name
// set, the set of names already locked by a manual/active merge, and the set of
// names belonging to LIVE, UNMERGED roster students (which must never be
// absorbed into a name-only identity automatically).
async function loadScanContext(classId) {
  const [names, activeMerges, roster] = await Promise.all([
    collectClassNames(classId),
    PlayerMerge.find({ classId, active: true }).lean(),
    Student.find({ classId, deletedAt: null, mergedInto: null })
      .select('nickname fullName -_id')
      .lean(),
  ]);

  const mergedAway = new Set();
  const alreadyGrouped = new Set();
  // Exact name -> primary, for resolveCanonicalName's fast lookup.
  const nameToPrimary = new Map();
  for (const m of activeMerges) {
    alreadyGrouped.add(m.primaryName);
    nameToPrimary.set(m.primaryName, m.primaryName);
    for (const member of m.members || []) {
      alreadyGrouped.add(member);
      mergedAway.add(member);
      nameToPrimary.set(member, m.primaryName);
    }
  }

  const rosterOnly = new Set();
  for (const s of roster) {
    const n = (s.nickname || s.fullName || '').toString().trim();
    if (n && !mergedAway.has(n)) rosterOnly.add(n);
  }

  return { names, alreadyGrouped, rosterOnly, nameToPrimary };
}

// Pure planning step: the single merge group (if any) that should form around
// `seed`, given a loaded scan context. `seed` is the LONGER name; candidates are
// the shorter names wholly contained in it.
//
// `excluded` (optional) is the set of names already claimed by an earlier plan
// in the same scan, so two long names sharing one short variant can't both
// claim it and produce overlapping merges.
function planMergeForSeed(seed, { names, alreadyGrouped, rosterOnly }, excluded = null) {
  const seedName = (seed || '').toString().trim();
  if (!seedName) return null;
  if (alreadyGrouped.has(seedName)) return null;
  if (excluded?.has(seedName)) return null;

  const isTaken = (candidate) =>
    alreadyGrouped.has(candidate) || Boolean(excluded?.has(candidate));

  const related = names.filter(
    (candidate) =>
      candidate !== seedName &&
      !isTaken(candidate) &&
      !rosterOnly.has(candidate) &&
      // The shorter name must be a whole-word part of the seed AND long enough
      // (>= 4 chars) that folding it in is clearly the same child rather than a
      // short, common name like "Ali" or "Ann" sweeping up unrelated longer ones.
      normName(candidate).length >= 4 &&
      nameContainsName(seedName, candidate)
  );
  if (related.length === 0) return null;

  const primaryName = pickPrimaryName(seedName, related);
  // Never auto-fold a LIVE, unmerged roster student as a member: the auto path
  // can't reliably mark that Student row merged when the primary isn't itself a
  // roster record, which would leave the roster entry stuck. Such a merge stays
  // a deliberate, manual choice by the teacher.
  const members = [seedName, ...related].filter(
    (n) => n && n !== primaryName && !rosterOnly.has(n)
  );
  if (members.length === 0) return null;

  return { primaryName, members };
}

// Runs the detection for one class and persists any group it finds as a normal
// PlayerMerge, retagging sessions exactly like the manual merge does so an
// unmerge can restore them. Returns the number of merges created.
async function autoDetectMerges(classId, createdBy = 'auto') {
  if (!classId) return 0;
  if (shouldSkipAutoScan(classId)) return 0;

  const ctx = await loadScanContext(classId);
  const created = [];
  const handled = new Set();

  // Longest-first so a fuller name ("Alyssa Tan") claims its shorter variant
  // before the shorter one is considered as a seed in its own right.
  const ordered = [...ctx.names].sort(
    (a, b) => normName(b).length - normName(a).length || a.localeCompare(b)
  );

  for (const name of ordered) {
    if (handled.has(name)) continue;
    const plan = planMergeForSeed(name, ctx, handled);
    if (!plan) continue;
    created.push(plan);
    handled.add(plan.primaryName);
    for (const m of plan.members) handled.add(m);
  }

  for (const plan of created) {
    await applyNameMerge(classId, plan, createdBy);
  }

  markAutoScanned(classId);
  return created.length;
}

// Orders the given names longest-first, then auto-detects merges for each. Used
// by the stats read paths so "Alyssa Tan" is considered before "Alyssa" and the
// longer name wins as the merge primary. Idempotent + cache-guarded.
async function autoDetectMergesOrdered(classId, names = [], createdBy = 'auto') {
  const ordered = [...new Set(names.filter(Boolean))].sort(
    (a, b) => normName(b).length - normName(a).length || a.localeCompare(b)
  );
  if (ordered.length === 0) return;
  // Two different names in one call can only be related through a shared
  // longer form; loading the context once is enough because the seeds are
  // independent.
  const ctx = await loadScanContext(classId);
  for (const name of ordered) {
    const plan = planMergeForSeed(name, ctx);
    if (plan) await applyNameMerge(classId, plan, createdBy);
  }
  markAutoScanned(classId);
}

// Persists one name-merge group: retags sessions to the primary, folds in any
// matching roster student, and records the PlayerMerge. Shared by the manual
// merge endpoint and the automatic detector so both behave identically.
async function applyNameMerge(classId, { primaryName, members }, createdBy = 'auto') {
  const now = new Date();

  for (const member of members) {
    await PlaySession.updateMany({ classId, playerName: member }, [
      {
        $set: {
          playerName: primaryName,
          // Preserve the original pre-merge name for the first merge only.
          mergedFrom: { $ifNull: ['$mergedFrom', '$playerName'] },
        },
      },
    ]);
  }

  const rosterByName = await Student.find({
    classId,
    $or: [{ nickname: { $in: members } }, { fullName: { $in: members } }],
  }).lean();
  const primaryRoster = await Student.findOne({
    classId,
    $or: [{ nickname: primaryName }, { fullName: primaryName }],
  }).lean();

  if (primaryRoster && rosterByName.length > 0) {
    await Student.updateMany(
      { _id: { $in: rosterByName.map((s) => s._id) } },
      { $set: { mergedInto: primaryRoster._id, mergedAt: now, mergedBy: createdBy } }
    );
    await PlaySession.updateMany(
      { classId, studentId: { $in: rosterByName.map((s) => s.studentId) } },
      { $set: { studentId: primaryRoster.studentId } }
    );
  }

  // Idempotent: two concurrent scans (or an auto scan racing a manual merge)
  // must not create two active rows for the same primary. Fold any new members
  // into the existing group instead.
  const existing = await PlayerMerge.findOne({ classId, active: true, primaryName });
  if (existing) {
    const merged = new Set([...(existing.members || []), ...members]);
    existing.members = [...merged].filter((n) => n && n !== primaryName);
    await existing.save();
  } else {
    await PlayerMerge.create({
      classId,
      primaryName,
      members,
      createdBy,
      createdAt: now,
      active: true,
    });
  }

  invalidateAutoMergeCache(classId);
  return { primaryName, members };
}

// Resolves a player-supplied name to the merge primary it belongs to.
//
// 1. An exact member/primary match in the active merge set wins.
// 2. Failing that, an auto-detected whole-word match is consulted read-only —
//    but ONLY when the *longer* name is the one already present (the "Alyssa"
//    into "Alyssa Tan" direction the teacher described). If the player supplied
//    a variant that no existing identity contains, the raw name is kept so a
//    brand-new player is never silently absorbed into someone else's stats.
//
// Auto-merges are normally persisted by autoDetectMerges() on the read paths;
// steps 2 keeps log-time correct even before that scan has run.
async function resolveCanonicalName(classId, rawName) {
  const name = (rawName || '').toString().trim();
  if (!classId || !name) return name;

  const ctx = await loadScanContext(classId);

  const exact = ctx.nameToPrimary.get(name);
  if (exact) return exact;

  // Only a supplied name long enough to be a real "short form" qualifies, so a
  // brand-new player whose name is a 3-char stub is never absorbed.
  if (normName(name).length < 4) return name;
  if (ctx.rosterOnly.has(name)) return name;

  let longerMatch = null;
  for (const candidate of ctx.names) {
    if (candidate === name) continue;
    if (ctx.rosterOnly.has(candidate)) continue;
    if (nameContainsName(candidate, name)) {
      // An existing, longer identity contains the supplied name — fold in.
      longerMatch = pickPrimaryName(candidate, [name]);
      break;
    }
  }
  return longerMatch || name;
}

module.exports = {
  normName,
  nameContainsName,
  collectClassNames,
  findSimilarNameMerge,
  planMergeForSeed,
  autoDetectMerges,
  autoDetectMergesOrdered,
  applyNameMerge,
  resolveCanonicalName,
  invalidateAutoMergeCache,
};
