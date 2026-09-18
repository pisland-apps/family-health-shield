// ========== FHS MERGE ENGINE ==========
// Pure functions implementing the field/array-level merge described in
// MERGE_SYNC_DESIGN.md. No DOM, no I/O, no randomness, no wall-clock reads
// except inside a couple of helpers that are never called during a merge
// itself (kept here only because app.js also uses this file's helpers).
//
// Entry point: mergeMembers(localMembers, remoteMembers) -> { members, conflicts }
//
// Loaded as a plain <script> in the browser (everything below becomes
// global, same as app.js's own functions) AND as a CommonJS module under
// Node for merge-engine.test.js. See the UMD-lite export at the bottom.

// ---------- generic helpers ----------

// Lamport-clock comparison ONLY - never reads updatedAt. See design 1.1.
function mergeEntityMeta(local, remote) {
  const lv = Number.isFinite(local && local.version) ? local.version : 1;
  const rv = Number.isFinite(remote && remote.version) ? remote.version : 1;
  if (lv > rv) return 'local';
  if (rv > lv) return 'remote';
  return 'tie';
}

const SYNC_META_KEYS = ['version', 'updatedAt', 'deletedAt', 'schemaVersion'];

// Picks out just the given keys (or, with no key list, everything except
// the sync-metadata keys) for a content-equality / conflict comparison.
// This is what keeps a change to a NESTED child (e.g. one ledger row) from
// falsely reading as a conflict on its PARENT policy's own scalar fields -
// every entity type with nested syncable children passes its own scalar
// key list here rather than relying on the default "everything but meta".
function projectForCompare(obj, scalarKeys) {
  if (scalarKeys) {
    const out = {};
    scalarKeys.forEach(k => { out[k] = obj ? obj[k] : undefined; });
    return out;
  }
  const out = Object.assign({}, obj);
  SYNC_META_KEYS.forEach(k => { delete out[k]; });
  return out;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------- id-keyed array merge (records, reminders, ledger, riders,
// coverages, sumInsuredHistory, surrenderRecords, claims, historyEntries,
// and policies/members themselves at the top level) ----------
//
// opts:
//   path            - array of ids/keys for this array's location, purely
//                      for conflict-entry provenance/debugging
//   conflicts       - array conflicts get pushed onto (mutated)
//   ancestorTombstoned - true if an ancestor of every item here is already
//                      tombstoned; suppresses conflict reporting (design 1.7)
//                      but merging itself still happens (still need a
//                      correct union so an un-delete or "keep both" stays consistent)
//   scalarKeys      - keys to compare for conflict/equality (design: every
//                      entity type with nested syncable children MUST pass
//                      this, or child-only differences will misfire as a
//                      conflict on the parent's own fields)
//   mergeChildren(winner, localItem, remoteItem, winnerTombstoned) - called
//                      for every id in the union (localItem/remoteItem may
//                      be undefined for a one-sided id) to recursively
//                      merge that item's own nested syncable children into
//                      `winner` (mutate in place). Optional.
function mergeSyncArray(localArr, remoteArr, opts) {
  opts = opts || {};
  const path = opts.path || [];
  const conflicts = opts.conflicts || [];
  const ancestorTombstoned = !!opts.ancestorTombstoned;
  const scalarKeys = opts.scalarKeys || null;
  const mergeChildren = opts.mergeChildren || null;

  const localById = new Map((localArr || []).map(x => [x.id, x]));
  const remoteById = new Map((remoteArr || []).map(x => [x.id, x]));
  const allIds = Array.from(new Set([].concat(
    Array.from(localById.keys()), Array.from(remoteById.keys())
  )));

  return allIds.map(id => {
    const l = localById.get(id);
    const r = remoteById.get(id);
    let winner;

    if (l && !r) {
      winner = Object.assign({}, l);
    } else if (r && !l) {
      winner = Object.assign({}, r);
    } else {
      const outcome = mergeEntityMeta(l, r);
      if (outcome === 'local') {
        winner = Object.assign({}, l);
      } else if (outcome === 'remote') {
        winner = Object.assign({}, r);
      } else {
        // version tie
        const lProj = projectForCompare(l, scalarKeys);
        const rProj = projectForCompare(r, scalarKeys);
        if (deepEqual(lProj, rProj)) {
          winner = Object.assign({}, l);
        } else {
          if (!ancestorTombstoned) {
            conflicts.push({
              entityId: id,
              baseVersion: l.version,
              path: path.concat([id]),
              local: lProj,
              remote: rProj
            });
          }
          // Conflict-output contract (design 1.5): keep local content,
          // remote goes ONLY into the conflict entry above.
          winner = Object.assign({}, l);
        }
      }
    }

    const winnerTombstoned = ancestorTombstoned || !!winner.deletedAt;
    if (mergeChildren) mergeChildren(winner, l, r, winnerTombstoned);
    return winner;
  });
}

// ---------- attachment array merge (id + tombstone only, no version -
// design 1.9/2.2) ----------
function mergeAttachmentArray(localArr, remoteArr) {
  const localById = new Map((localArr || []).map(x => [x.id, x]));
  const remoteById = new Map((remoteArr || []).map(x => [x.id, x]));
  const allIds = Array.from(new Set([].concat(
    Array.from(localById.keys()), Array.from(remoteById.keys())
  )));
  return allIds.map(id => {
    const l = localById.get(id);
    const r = remoteById.get(id);
    if (l && r) {
      // Prefer local's own fields (name/path/type/thumb/size are set once
      // at upload and never edited - see design 1.9 - so which side's copy
      // wins for those doesn't matter); OR the tombstone so either side
      // deleting it sticks.
      return Object.assign({}, l, { deletedAt: l.deletedAt || r.deletedAt || null });
    }
    return Object.assign({}, l || r);
  });
}

// ---------- member scalar fields (per-field version - design 2.1) ----------
const MEMBER_SCALAR_FIELDS = [
  'name', 'nameZh', 'nameZhAvatarIdx', 'gender', 'birth', 'blood',
  'height', 'allergies', 'emergency', 'bloodTypeAttachment'
];

function freshFieldVersions() {
  const fv = {};
  MEMBER_SCALAR_FIELDS.forEach(f => { fv[f] = 1; });
  return fv;
}

// Merges local/remote scalar fields into `winner` (mutated in place).
// Independent of whatever the member's own top-level `version` decided -
// see the note in mergeMemberPair for why these two are deliberately split.
function mergeMemberFields(winner, local, remote, conflicts, path) {
  const lfv = (local && local.fieldVersion) || freshFieldVersions();
  const rfv = (remote && remote.fieldVersion) || freshFieldVersions();
  winner.fieldVersion = Object.assign({}, lfv);
  MEMBER_SCALAR_FIELDS.forEach(f => {
    const lv = lfv[f] || 1;
    const rv = rfv[f] || 1;
    if (lv > rv) {
      winner[f] = local ? local[f] : winner[f];
      winner.fieldVersion[f] = lv;
    } else if (rv > lv) {
      winner[f] = remote ? remote[f] : winner[f];
      winner.fieldVersion[f] = rv;
    } else {
      // tie
      const lVal = local ? local[f] : undefined;
      const rVal = remote ? remote[f] : undefined;
      if (!deepEqual(lVal, rVal)) {
        conflicts.push({
          entityId: winner.id,
          field: f,
          baseVersion: lv,
          path: path.concat([winner.id, f]),
          local: lVal,
          remote: rVal
        });
      }
      // contract: keep local's value on a field-level conflict too
      winner[f] = local ? local[f] : winner[f];
      winner.fieldVersion[f] = lv;
    }
  });
}

// ---------- policy scalar keys (children are ledger/riders/coverages/
// surrenderRecords/attachments, all merged separately - design 1.7) ----------
const POLICY_SCALAR_KEYS = [
  'status', 'provider', 'number', 'premium', 'frequency', 'start', 'expiry',
  'notes', 'payout', 'premiumPaidByBonus', 'premiumPaidByBonusSince'
];
const RECORD_SCALAR_KEYS = ['date', 'type', 'title', 'details', 'tags', 'vitals'];
const REMINDER_SCALAR_KEYS = ['title', 'dueDate', 'repeatMonths', 'notes'];
const LEDGER_SCALAR_KEYS = ['date', 'amount', 'type', 'method', 'notes'];
const COVERAGE_SCALAR_KEYS = ['type', 'sumInsured', 'customLabel', 'lifetimeLimit', 'annualLimit', 'reducing', 'expiry'];
const SURRENDER_SCALAR_KEYS = ['date', 'accumulatedBonus', 'dividend', 'guaranteedCashValue', 'nonGuaranteedValue'];
const CLAIM_SCALAR_KEYS = ['policyId', 'coverageId', 'date', 'status', 'amountClaimed', 'amountPaid', 'details'];
// riders and sumInsuredHistory entries have no nested children of their own,
// so they use the default "everything but meta" comparison (no scalarKeys).

function mergePolicyArray(localPolicies, remotePolicies, conflicts, path) {
  return mergeSyncArray(localPolicies, remotePolicies, {
    path,
    conflicts,
    ancestorTombstoned: false,
    scalarKeys: POLICY_SCALAR_KEYS,
    mergeChildren: (winner, l, r, winnerTombstoned) => {
      const pPath = path.concat([winner.id]);
      winner.ledger = mergeSyncArray(l && l.ledger, r && r.ledger, {
        path: pPath.concat(['ledger']), conflicts, ancestorTombstoned: winnerTombstoned,
        scalarKeys: LEDGER_SCALAR_KEYS,
        mergeChildren: (lw, ll, rr) => { lw.attachments = mergeAttachmentArray(ll && ll.attachments, rr && rr.attachments); }
      });
      winner.riders = mergeSyncArray(l && l.riders, r && r.riders, {
        path: pPath.concat(['riders']), conflicts, ancestorTombstoned: winnerTombstoned
      });
      winner.coverages = mergeSyncArray(l && l.coverages, r && r.coverages, {
        path: pPath.concat(['coverages']), conflicts, ancestorTombstoned: winnerTombstoned,
        scalarKeys: COVERAGE_SCALAR_KEYS,
        mergeChildren: (cw, cl, cr, cwTombstoned) => {
          cw.sumInsuredHistory = mergeSyncArray(cl && cl.sumInsuredHistory, cr && cr.sumInsuredHistory, {
            path: pPath.concat(['coverages', cw.id, 'sumInsuredHistory']), conflicts, ancestorTombstoned: cwTombstoned
          });
        }
      });
      winner.surrenderRecords = mergeSyncArray(l && l.surrenderRecords, r && r.surrenderRecords, {
        path: pPath.concat(['surrenderRecords']), conflicts, ancestorTombstoned: winnerTombstoned,
        scalarKeys: SURRENDER_SCALAR_KEYS,
        mergeChildren: (sw, sl, sr) => { sw.attachments = mergeAttachmentArray(sl && sl.attachments, sr && sr.attachments); }
      });
      winner.attachments = mergeAttachmentArray(l && l.attachments, r && r.attachments);
    }
  });
}

// ---------- one member pair ----------
//
// A member's own `version` conflates two different kinds of event (member
// deletion, AND any scalar-field edit - see saveMember's bumpFieldVersions,
// which bumps the member's version too). That makes it unsuitable as the
// sole signal for "is there a scalar-field conflict" - two people editing
// DIFFERENT fields would show tied-or-differing versions with genuinely no
// conflict, which fieldVersion already resolves per-field. So member merge
// deliberately splits into two independent steps that don't gate each other:
//   1) mergeEntityMeta on the member's own version decides {version,
//      deletedAt, schemaVersion, updatedAt} as one group (governs identity/
//      tombstone status only).
//   2) mergeMemberFields ALWAYS runs, independently, using fieldVersion.
// Nested children (records/customReminders/historyEntries/insurance) are
// merged independently of both, same as a policy's children.
function mergeMemberPair(local, remote, conflicts) {
  const outcome = mergeEntityMeta(local, remote);
  const metaSource = outcome === 'remote' ? remote : local; // tie defaults to local, no conflict entry needed here - see note above
  const winner = {
    id: local.id,
    version: metaSource.version,
    deletedAt: metaSource.deletedAt,
    schemaVersion: metaSource.schemaVersion,
    updatedAt: metaSource.updatedAt
  };

  mergeMemberFields(winner, local, remote, conflicts, []);

  const tombstoned = !!winner.deletedAt;
  winner.records = mergeSyncArray(local.records, remote.records, {
    path: [local.id, 'records'], conflicts, ancestorTombstoned: tombstoned,
    scalarKeys: RECORD_SCALAR_KEYS,
    mergeChildren: (w, l, r) => { w.attachments = mergeAttachmentArray(l && l.attachments, r && r.attachments); }
  });
  winner.customReminders = mergeSyncArray(local.customReminders, remote.customReminders, {
    path: [local.id, 'customReminders'], conflicts, ancestorTombstoned: tombstoned,
    scalarKeys: REMINDER_SCALAR_KEYS
  });
  winner.historyEntries = mergeSyncArray(local.historyEntries, remote.historyEntries, {
    path: [local.id, 'historyEntries'], conflicts, ancestorTombstoned: tombstoned
  });
  // history stays a plain string for now (design 1.10 - v1 UI still reads
  // m.history, historyEntries is a shadow not yet wired as source of
  // truth - see MERGE_SYNC_DESIGN.md 2.1). Until that wiring lands, keep
  // whichever side won the meta/version comparison, since there is no
  // richer signal to merge it by yet.
  winner.history = metaSource.history;

  const localIns = local.insurance || { policies: [], claims: [] };
  const remoteIns = remote.insurance || { policies: [], claims: [] };
  winner.insurance = {
    policies: mergePolicyArray(localIns.policies, remoteIns.policies, conflicts, [local.id, 'insurance', 'policies']),
    claims: mergeSyncArray(localIns.claims, remoteIns.claims, {
      path: [local.id, 'insurance', 'claims'], conflicts, ancestorTombstoned: tombstoned,
      scalarKeys: CLAIM_SCALAR_KEYS
    })
  };

  return winner;
}

// ---------- top-level entry point ----------
// mergeMembers(localMembers, remoteMembers) -> { members, conflicts }
// Pure: no mutation of either input array or its objects (mergeSyncArray/
// mergePolicyArray/mergeMemberPair always copy before mutating a winner).
function mergeMembers(localMembers, remoteMembers) {
  const conflicts = [];
  const localById = new Map((localMembers || []).map(x => [x.id, x]));
  const remoteById = new Map((remoteMembers || []).map(x => [x.id, x]));
  const allIds = Array.from(new Set([].concat(
    Array.from(localById.keys()), Array.from(remoteById.keys())
  )));

  const members = allIds.map(id => {
    const l = localById.get(id);
    const r = remoteById.get(id);
    if (l && !r) return JSON.parse(JSON.stringify(l));
    if (r && !l) return JSON.parse(JSON.stringify(r));
    return mergeMemberPair(l, r, conflicts);
  });

  return { members, conflicts };
}

// ---------- UMD-lite export ----------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    mergeMembers,
    mergeMemberPair,
    mergePolicyArray,
    mergeSyncArray,
    mergeAttachmentArray,
    mergeMemberFields,
    mergeEntityMeta,
    projectForCompare,
    deepEqual,
    MEMBER_SCALAR_FIELDS,
    freshFieldVersions,
    POLICY_SCALAR_KEYS, RECORD_SCALAR_KEYS, REMINDER_SCALAR_KEYS,
    LEDGER_SCALAR_KEYS, COVERAGE_SCALAR_KEYS, SURRENDER_SCALAR_KEYS, CLAIM_SCALAR_KEYS
  };
}
