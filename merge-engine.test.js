// Plain-Node property tests for merge-engine.js - no framework, run with:
//   node merge-engine.test.js
// Exits non-zero and prints failures if anything breaks.

const {
  mergeMembers, mergeSyncArray, mergeAttachmentArray, freshFieldVersions
} = require('./merge-engine.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL: ${name}` + (detail ? `\n  ${detail}` : '')); }
}

// ---------- tiny seeded PRNG (mulberry32) for reproducible fuzzing ----------
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- fixture builders ----------
let uidCounter = 0;
function uid(prefix) { return `${prefix}${++uidCounter}`; }

function freshMeta(version) {
  return { version: version || 1, updatedAt: '2026-01-01T00:00:00.000Z', deletedAt: null, schemaVersion: 1 };
}

function makeRecord(id, overrides) {
  return Object.assign({
    id, date: '2026-01-01', type: 'Checkup', title: 'Visit', details: '', tags: [], vitals: {}, attachments: []
  }, freshMeta(), overrides || {});
}

function makeCoverage(id, overrides) {
  return Object.assign({
    id, type: 'Life', sumInsured: '100000', customLabel: '', lifetimeLimit: '', annualLimit: '', reducing: false, expiry: '', sumInsuredHistory: []
  }, freshMeta(), overrides || {});
}

function makePolicy(id, overrides) {
  return Object.assign({
    id, status: 'Active', provider: 'Acme', number: 'P1', premium: '100', frequency: 'Yearly',
    start: '2020-01-01', expiry: '', notes: '', payout: null, premiumPaidByBonus: false, premiumPaidByBonusSince: '',
    ledger: [], riders: [], coverages: [makeCoverage(uid('cov'))], surrenderRecords: [], attachments: []
  }, freshMeta(), overrides || {});
}

function makeMember(id, overrides) {
  return Object.assign({
    id, name: 'Alice', nameZh: '', nameZhAvatarIdx: 0, gender: 'F', birth: '1990-01-01', blood: 'O',
    height: '160', allergies: '', emergency: '', bloodTypeAttachment: null,
    history: '', historyEntries: [],
    records: [makeRecord(uid('rec'))],
    customReminders: [],
    insurance: { policies: [makePolicy(uid('pol'))], claims: [] },
    fieldVersion: freshFieldVersions()
  }, freshMeta(), overrides || {});
}

function clone(x) { return JSON.parse(JSON.stringify(x)); }

// ============================================================
// 1. Idempotence
// ============================================================
(function testIdempotence() {
  const local = [makeMember('m1')];
  const remote = clone(local);
  remote[0].records[0].title = 'Remote edit';
  remote[0].records[0].version = 2;

  const once = mergeMembers(clone(local), clone(remote));
  const twiceStep = mergeMembers(clone(once.members), clone(remote));

  ok('idempotence: members stable', deepJSON(once.members) === deepJSON(twiceStep.members),
    `once=${deepJSON(once.members)}\ntwice=${deepJSON(twiceStep.members)}`);
  ok('idempotence: conflict count stable', once.conflicts.length === twiceStep.conflicts.length);
})();

function deepJSON(x) { return JSON.stringify(x); }

// ============================================================
// 2. Commutativity (conflict queue contents, per design 1.11)
// ============================================================
(function testCommutativity() {
  const a = [makeMember('m1')];
  const b = clone(a);
  // force a genuine tie-version conflict on a scalar field
  b[0].name = 'Bob';
  b[0].fieldVersion.name = a[0].fieldVersion.name; // same version, different value -> conflict

  const ab = mergeMembers(clone(a), clone(b));
  const ba = mergeMembers(clone(b), clone(a));

  const keysOf = res => res.conflicts.map(c => JSON.stringify([c.entityId, c.field || null, c.baseVersion])).sort();
  ok('commutativity: conflict keys match', deepJSON(keysOf(ab)) === deepJSON(keysOf(ba)),
    `ab=${deepJSON(keysOf(ab))}\nba=${deepJSON(keysOf(ba))}`);
})();

// ============================================================
// 3. Associativity (conflict queue contents across 3 devices)
//
// mergeMembers only returns the conflicts discovered IN THAT CALL (by
// design - see 1.4: the caller is responsible for appending each merge's
// conflicts onto its own persisted queue, same as the real app will do on
// every import). So testing associativity correctly means accumulating
// conflicts across BOTH steps of each chain and comparing the unions -
// comparing only the outermost call's conflicts would silently drop
// whatever the intermediate merge already found and resolved.
// ============================================================
(function testAssociativity() {
  const a = [makeMember('m1')];
  const b = clone(a); b[0].allergies = 'Peanuts'; b[0].fieldVersion.allergies = a[0].fieldVersion.allergies;
  const c = clone(a); c[0].emergency = '999';     c[0].fieldVersion.emergency = a[0].fieldVersion.emergency;

  const keyOf = cf => JSON.stringify([cf.entityId, cf.field || null, cf.baseVersion]);

  const step1_ab = mergeMembers(clone(a), clone(b));
  const step2_abThenC = mergeMembers(clone(step1_ab.members), clone(c));
  // Dedupe by key before comparing - see the note above this test: the
  // same underlying disagreement can be re-derived more than once across
  // a chain (once directly, once indirectly through an already-"resolved"
  // intermediate), and design 1.4's (entityId, baseVersion) queue key is
  // exactly what collapses that back down when a real persisted queue
  // appends these. A raw concatenated list can differ in MULTIPLICITY
  // between orderings even when the deduplicated SET is identical - that
  // multiplicity difference is not a bug, so the test (and any real
  // queue-appending code) must dedupe by key, not compare raw counts.
  const abThenCKeys = Array.from(new Set(step1_ab.conflicts.concat(step2_abThenC.conflicts).map(keyOf))).sort();

  const step1_bc = mergeMembers(clone(b), clone(c));
  const step2_aThenBc = mergeMembers(clone(a), clone(step1_bc.members));
  const aThenBcKeys = Array.from(new Set(step1_bc.conflicts.concat(step2_aThenBc.conflicts).map(keyOf))).sort();

  ok('associativity: conflict keys match', deepJSON(abThenCKeys) === deepJSON(aThenBcKeys),
    `(a+b)+c=${deepJSON(abThenCKeys)}\na+(b+c)=${deepJSON(aThenBcKeys)}`);
})();

// ============================================================
// 4. Version monotonicity (corrected per design-doc note above: no
// automatic +1 during merge - see the discrepancy called out to the user)
// ============================================================
(function testVersionMonotonicity() {
  const local = [makeMember('m1', { version: 3 })];
  const remote = clone(local); remote[0].version = 7; remote[0].name = 'Remote Name';
  remote[0].fieldVersion.name = 99; // remote clearly wins this field

  const { members } = mergeMembers(clone(local), clone(remote));
  const m = members[0];
  ok('version monotonicity: member version = max(local,remote)', m.version === 7, `got ${m.version}`);
  ok('version monotonicity: winning field carries its own version', m.fieldVersion.name === 99, `got ${m.fieldVersion.name}`);
  ok('version monotonicity: never below either input', m.version >= 3 && m.version >= 7);
})();

// ============================================================
// 5. Tombstone dominance
// ============================================================
(function testTombstoneDominance() {
  const local = [makeMember('m1')];
  local[0].records[0].deletedAt = '2026-02-01T00:00:00.000Z';
  local[0].records[0].version = 5;

  const remote = clone(local);
  remote[0].records[0].deletedAt = null; // remote never saw the delete
  remote[0].records[0].version = 2;      // and is behind

  const { members } = mergeMembers(clone(local), clone(remote));
  ok('tombstone dominance: stays deleted', !!members[0].records[0].deletedAt);
})();

// ============================================================
// 6. Deterministic conflict derivation
// ============================================================
(function testDeterministicDerivation() {
  const a = [makeMember('m1')];
  const b = clone(a); b[0].name = 'Bob'; b[0].fieldVersion.name = a[0].fieldVersion.name;

  const r1 = mergeMembers(clone(a), clone(b));
  const r2 = mergeMembers(clone(a), clone(b));
  const keysOf = res => res.conflicts.map(c => JSON.stringify([c.entityId, c.field || null, c.baseVersion])).sort();
  ok('deterministic derivation: same inputs -> same conflict keys', deepJSON(keysOf(r1)) === deepJSON(keysOf(r2)));
})();

// ============================================================
// 7. Repeat-import stability (no duplicate queue entries, no content flicker)
// ============================================================
(function testRepeatImportStability() {
  const local = [makeMember('m1')];
  const remote = clone(local); remote[0].name = 'Bob'; remote[0].fieldVersion.name = local[0].fieldVersion.name;

  const first = mergeMembers(clone(local), clone(remote));
  const second = mergeMembers(clone(first.members), clone(remote));
  ok('repeat import: conflict count does not grow', first.conflicts.length === second.conflicts.length,
    `first=${first.conflicts.length} second=${second.conflicts.length}`);
  ok('repeat import: content does not flicker', deepJSON(first.members) === deepJSON(second.members));
})();

// ============================================================
// 8. Queue invalidation on local edit (simulated: bump past baseVersion,
// then re-derive - the actual "drop stale queue entries" step happens in
// the UI layer per design 1.6, not inside mergeMembers itself, so this
// test checks the PRECONDITION mergeMembers gives that layer: a fresh
// local edit's version must exceed the conflict's baseVersion.)
// ============================================================
(function testQueueInvalidationPrecondition() {
  const a = [makeMember('m1')];
  const b = clone(a); b[0].name = 'Bob'; b[0].fieldVersion.name = a[0].fieldVersion.name;
  const { members, conflicts } = mergeMembers(clone(a), clone(b));
  const conflict = conflicts.find(c => c.field === 'name');
  ok('queue invalidation precondition: conflict recorded', !!conflict);

  // simulate the user editing the field locally after the conflict (this
  // is what saveMember's bumpFieldVersions does in the real app)
  const editedMember = clone(members[0]);
  editedMember.name = 'Carol';
  editedMember.fieldVersion.name += 1;

  ok('queue invalidation precondition: new version exceeds baseVersion',
    editedMember.fieldVersion.name > conflict.baseVersion,
    `new=${editedMember.fieldVersion.name} base=${conflict.baseVersion}`);
})();

// ============================================================
// 9. Cascade suppression (conflict under a tombstoned parent never queues)
// ============================================================
(function testCascadeSuppression() {
  const local = [makeMember('m1')];
  const policy = local[0].insurance.policies[0];
  policy.deletedAt = '2026-02-01T00:00:00.000Z';
  policy.version = 5;

  const remote = clone(local);
  // remote also has the policy deleted (so it doesn't just "win" outright
  // and skip the child-merge path), but disagrees on a coverage inside it
  remote[0].insurance.policies[0].coverages[0].sumInsured = '999999';
  // keep both sides' policy version tied so the coverage-level merge path runs
  remote[0].insurance.policies[0].version = 5;
  remote[0].insurance.policies[0].coverages[0].version =
    local[0].insurance.policies[0].coverages[0].version; // tie -> would conflict if not suppressed

  const { conflicts } = mergeMembers(clone(local), clone(remote));
  const coverageConflicts = conflicts.filter(c => c.path.includes('coverages'));
  ok('cascade suppression: no conflict under tombstoned policy', coverageConflicts.length === 0,
    `found: ${JSON.stringify(coverageConflicts)}`);
})();

// ============================================================
// 10. Attachment merge path never consults version, only id-union + tombstone
// ============================================================
(function testAttachmentMergePath() {
  const localAtts = [{ id: 'a1', name: 'x.pdf', deletedAt: null }];
  const remoteAtts = [{ id: 'a1', name: 'x.pdf', deletedAt: '2026-01-01T00:00:00.000Z' }, { id: 'a2', name: 'y.pdf', deletedAt: null }];
  const merged = mergeAttachmentArray(localAtts, remoteAtts);
  const a1 = merged.find(a => a.id === 'a1');
  const a2 = merged.find(a => a.id === 'a2');
  ok('attachment merge: no version field involved', !('version' in a1));
  ok('attachment merge: either-side tombstone wins', !!a1.deletedAt);
  ok('attachment merge: union includes one-sided new attachment', !!a2 && !a2.deletedAt);
})();

// ============================================================
// Extra: randomized fuzz pass for idempotence + commutativity across
// small random member trees (bonus coverage beyond the 10 named tests)
// ============================================================
(function fuzz() {
  const rng = mulberry32(42);
  const pick = arr => arr[Math.floor(rng() * arr.length)];
  for (let i = 0; i < 25; i++) {
    const base = [makeMember('m' + i)];
    const a = clone(base);
    const b = clone(base);
    // randomly mutate a and/or b
    if (rng() > 0.5) { a[0].records[0].title = 'A-' + i; a[0].records[0].version += 1; }
    if (rng() > 0.5) { b[0].records[0].title = 'B-' + i; b[0].records[0].version += 1; }
    if (rng() > 0.7) { const f = pick(['name', 'blood', 'allergies']); a[0][f] = 'A' + i; }
    if (rng() > 0.7) { const f = pick(['name', 'blood', 'allergies']); b[0][f] = 'B' + i; }

    const ab = mergeMembers(clone(a), clone(b));
    const ba = mergeMembers(clone(b), clone(a));
    const abAgain = mergeMembers(clone(ab.members), clone(b));

    ok(`fuzz[${i}]: idempotent`, deepJSON(ab.members) === deepJSON(abAgain.members));
    ok(`fuzz[${i}]: commutative conflict count`, ab.conflicts.length === ba.conflicts.length,
      `ab=${ab.conflicts.length} ba=${ba.conflicts.length}`);
  }
})();

// ============================================================
// 11. Regression: re-importing the exact same export must not manufacture
// a bloodTypeAttachment conflict just because the exported copy carries
// `.data` and the live local copy doesn't (see fieldCompareValue in
// merge-engine.js).
// ============================================================
(function testBloodTypeAttachmentNoFalseConflict() {
  const local = [makeMember('m1', {
    bloodTypeAttachment: { id: 'att1', name: 'report.jpg', type: 'image', thumb: 'data:...thumb', size: 12345 }
  })];
  // Simulate a re-import of this exact member: same attachment, but the
  // exported/incoming copy ALSO carries the raw .data field.
  const remote = clone(local);
  remote[0].bloodTypeAttachment.data = 'data:image/jpeg;base64,AAAA....';

  const { members, conflicts } = mergeMembers(clone(local), clone(remote));
  const bloodConflicts = conflicts.filter(c => c.field === 'bloodTypeAttachment');
  ok('bloodTypeAttachment: no false conflict on same-file re-import', bloodConflicts.length === 0,
    `found: ${JSON.stringify(bloodConflicts)}`);
  ok('bloodTypeAttachment: id preserved', members[0].bloodTypeAttachment.id === 'att1');

  // Sanity: a GENUINE change (different attachment id) must still conflict
  // when versions are tied.
  const remote2 = clone(local);
  remote2[0].bloodTypeAttachment = { id: 'att2', name: 'newer.jpg', type: 'image', thumb: 'data:...thumb2', size: 999 };
  const r2 = mergeMembers(clone(local), clone(remote2));
  ok('bloodTypeAttachment: genuine change still conflicts', r2.conflicts.some(c => c.field === 'bloodTypeAttachment'));
})();

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
