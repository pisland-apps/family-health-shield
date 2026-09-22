    // Use a different storage key to avoid conflicts with old versions
    const STORAGE_KEY = 'family_health_tracker_v3';

    // Display-only version label, shown in the bottom-right badge (visible even on the
    // lock screen, before the passcode is entered — see #versionBadge in index.html).
    // This is purely a "what code shipped in this build" label — it is NOT read by the
    // Service Worker and has no effect on caching. It does NOT auto-sync with
    // CACHE_VERSION in service-worker.js since they live in different files — bump both
    // together on every deploy. (Reminder comment also left in service-worker.js.)
    const APP_VERSION = 'v45';
    const APP_VERSION_DATE = '2026-09-22';
    // Populate the badge immediately — app.js is loaded at the end of <body>, so the DOM
    // (including #versionBadge) already exists by the time this line runs. Deliberately
    // done at top level, not inside init()/initAppData(), so it renders before any
    // passcode check and regardless of lock state.
    const versionBadgeEl = document.getElementById('versionBadge');
    if (versionBadgeEl) versionBadgeEl.textContent = `${APP_VERSION} · ${APP_VERSION_DATE}`;

    // pdf.js — as of pdfjs-dist 4.x, the package only ships ES module builds
    // (no more plain-global <script> bundle), so it's loaded here via dynamic
    // import() rather than a separate <script> tag in index.html. This also
    // sidesteps an ordering trap: import()/module scripts are always deferred,
    // but app.js itself is a classic (non-deferred) script placed at the end
    // of <body> - so a `<script type="module">` for pdf.js could easily end up
    // running AFTER this file, leaving window.pdfjsLib unset right when it's
    // needed. Awaiting this promise at the point of use (see openAttachment())
    // avoids that regardless of any future load-order changes.
    // Worker vendored locally at ./lib/pdf.worker.min.mjs - must stay in
    // lockstep with ./lib/pdf.min.mjs's package/version below (mismatched
    // main/worker builds can fail in confusing ways).
    const pdfjsLibPromise = import('./lib/pdf.min.mjs').then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.mjs';
      return mod;
    });

    // Returns YYYY-MM-DD in the browser's LOCAL timezone (not UTC).
    // toISOString() always returns UTC, which is off by a day for anyone
    // east of UTC in the early morning (e.g. 2am in Malaysia/UTC+8 is still
    // 6pm "yesterday" in UTC) - used for filenames and "today" defaults.
    function localDateStr(d = new Date()) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }

    // Demo data - always available as fallback
    const DEMO_DATA = [
      {
        id: 'demo1', name: 'Dad', gender: 'Male', birth: '1970-03-15', blood: 'A',
        height: 175, allergies: 'Penicillin', history: 'Hypertension 3 years, mild fatty liver',
        emergency: 'Mom 13800138000',
        records: [
          { id: 'r1', date: '2026-06-20', type: 'Checkup', title: 'Annual Physical', details: 'Blood pressure slightly high, advised low-salt diet', tags: ['annual','cardio'], 
            vitals: { systolic: 145, diastolic: 92, heartRate: 78, temp: 36.4, glucose: 5.8, weight: 78 },
            attachments: [
              { name: 'Physical_Report.pdf', path: 'attachments/Dad/2026-06-20_Physical_Report.pdf', type: 'pdf' },
              { name: 'ECG.jpg', path: 'attachments/Dad/2026-06-20_ECG.jpg', type: 'image' }
            ]
          },
          { id: 'r2', date: '2026-07-01', type: 'Monitoring', title: 'BP Monitoring', details: 'Morning measurement', tags: ['bp'], vitals: { systolic: 138, diastolic: 88, heartRate: 72 } },
          { id: 'r3', date: '2026-07-10', type: 'Medication', title: 'BP Medication', details: 'Amlodipine 5mg, once daily', tags: ['hypertension'] }
        ]
      },
      {
        id: 'demo2', name: 'Mom', gender: 'Female', birth: '1972-08-20', blood: 'O',
        height: 160, allergies: 'None', history: 'Hypothyroidism',
        emergency: 'Dad 13900139000',
        records: [
          { id: 'r4', date: '2026-05-15', type: 'Checkup', title: 'Annual Physical', details: 'All indicators normal, thyroid function stable', tags: ['annual','thyroid'], 
            vitals: { systolic: 118, diastolic: 76, heartRate: 68, temp: 36.6, glucose: 4.9, weight: 55 },
            attachments: [
              { name: 'Thyroid_Lab.pdf', path: 'attachments/Mom/2026-05-15_Thyroid_Lab.pdf', type: 'pdf' }
            ]
          },
          { id: 'r5', date: '2026-06-01', type: 'Vaccine', title: 'Flu Vaccine', details: 'Quadrivalent influenza vaccine', tags: ['vaccine'] }
        ]
      },
      {
        id: 'demo3', name: 'Child', gender: 'Male', birth: '2010-11-05', blood: 'Unknown',
        height: 155, allergies: 'Peanuts', history: 'None',
        emergency: 'Dad 13800138000',
        records: [
          { id: 'r6', date: '2026-03-10', type: 'Vaccine', title: 'HPV Vaccine Dose 1', details: 'Administered smoothly, no adverse reactions', tags: ['vaccine'] },
          { id: 'r7', date: '2026-07-05', type: 'Illness', title: 'Cold & Fever', details: 'Temp 38.5°C, fever reduced after Motrin', tags: ['cold'], vitals: { temp: 38.5, heartRate: 95 } }
        ]
      }
    ];

    // App state
    let members = [];
    let currentMemberId = null;
    let currentTab = 'overview';
    let viewMode = 'health'; // 'health' | 'insurance' — top-level mode switcher
    let tempAttachments = [];
    let tempBloodAttachment = null; // single attachment for the member's blood type proof
    let editingMemberId = null;   // null = adding a new member, otherwise id of member being edited
    let editingRecordId = null;   // null = adding a new record, otherwise id of record being edited
    let editingReminderId = null; // null = adding a new custom reminder, otherwise id of reminder being edited
    const ATTACHMENTS_FOLDER = 'attachments';

    // ========== SAFETY HELPERS ==========
    // Escapes text before it's placed into innerHTML, so user-entered data
    // (names, notes, tags, etc.) can never be interpreted as HTML/script.
    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // ========== IMPORT SANITIZATION ==========
    // Every .id field in this app (member/record/reminder/policy/coverage/
    // claim/ledger/surrender-record/sum-history-entry) is treated as a
    // trusted, internally-generated token throughout renderMain() and
    // friends - it's interpolated into innerHTML strings (data-id="...",
    // data-ledger-row-id="...", etc.) WITHOUT escapeHtml(), because normal
    // app code only ever creates ids via Date.now()/Math.random()/insUid(),
    // which can't contain HTML metacharacters.
    //
    // Importing a backup file is the one path that can hand this app an id
    // it didn't generate itself. normalizeImportedMembers() previously did
    // `id: raw.id ? String(raw.id) : ...` - a type cast, not a content
    // check - so a crafted backup JSON/ZIP could set id to something like
    // `x"><img src=x onerror=...>` and have it land unescaped in the DOM.
    // sanitizeId() closes that: any id that isn't a plain token gets
    // replaced with a freshly generated one instead of being trusted as-is.
    const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
    function sanitizeId(raw, fallback) {
      const s = (raw === null || raw === undefined) ? '' : String(raw);
      return SAFE_ID_RE.test(s) ? s : fallback;
    }
    function freshId(prefix) {
      return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    // Same problem, different field: vitals entered through the UI always
    // pass through parseFloat() (see the vitals form handler), so
    // r.vitals.systolic etc. are guaranteed numeric everywhere they're
    // rendered - including the 9 in-page print reports (see the
    // "In-app print reports" comment in index.html; as of v41-v44 these no
    // longer run in separate popup windows with a relaxed CSP - they render
    // under this page's own strict script-src 'self'). Imported vitals
    // previously bypassed the numeric guarantee entirely (passed through as
    // whatever the JSON contained), which would let a crafted backup inject
    // arbitrary HTML into a rendered report or record view wherever a
    // vitals value is interpolated without escapeHtml() (non-numeric text
    // masquerading as, say, systolic). sanitizeVitals() re-applies the same
    // parseFloat/isFinite check the UI form uses, so imported vitals are
    // exactly as trustworthy as hand-entered ones - this is defense in
    // depth on top of escapeHtml(), not a substitute for it.
    function sanitizeVitals(v) {
      if (!v || typeof v !== 'object') return undefined;
      const out = {};
      ['systolic', 'diastolic', 'heartRate', 'temp', 'glucose', 'weight'].forEach(k => {
        const n = parseFloat(v[k]);
        if (Number.isFinite(n)) out[k] = n;
      });
      return Object.keys(out).length ? out : undefined;
    }

    // Deep-walks an imported value (objects/arrays only - the insurance
    // blob especially, which has several nested id-bearing levels:
    // policies -> coverages -> sumInsuredHistory, policies -> ledger ->
    // attachments, policies -> riders, claims, surrenderRecords) and
    // replaces any property literally named "id" that isn't a safe token
    // with a freshly generated one. Deliberately generic rather than a
    // field-by-field remap like normalizeImportedMembers() uses for the
    // top-level member/record/reminder shape: the insurance schema has
    // enough nested variants that hand-mapping every one risks silently
    // dropping a field the insurance module still depends on. Walking and
    // fixing only `id` keys leaves every other field untouched.
    function sanitizeIdsDeep(value) {
      if (Array.isArray(value)) {
        value.forEach(sanitizeIdsDeep);
      } else if (value && typeof value === 'object') {
        if ('id' in value) value.id = sanitizeId(value.id, freshId('imp'));
        Object.keys(value).forEach(k => sanitizeIdsDeep(value[k]));
      }
      return value;
    }

    // Deep-clones a value (structuredClone where available, JSON round-trip
    // fallback) and THEN runs sanitizeIdsDeep on the clone. Deliberately
    // separate from sanitizeIdsDeep itself: that function mutates its input
    // in place and returns the same reference, which is fine for its one
    // existing caller (a disposable just-parsed import blob) but wrong for
    // "keep both" merge-conflict resolutions, which need an INDEPENDENT
    // copy with new ids - reusing sanitizeIdsDeep directly there would
    // remap the ORIGINAL entity's ids instead of producing a duplicate.
    function deepCloneAndRemapIds(value) {
      const clone = (typeof structuredClone === 'function')
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
      return sanitizeIdsDeep(clone);
    }

    // ========== SYNC METADATA (field/array-level merge support) ==========
    // See MERGE_SYNC_DESIGN.md for the full semantics. Summary: `version` is
    // a Lamport logical clock (bumped on every local edit, set to
    // max(local,remote)+1 on merge) - NOT a wall-clock timestamp, and never
    // compared across devices' clocks. `updatedAt` is wall-clock but is
    // display-only and must never be read by any merge/conflict logic.
    // `deletedAt` is a tombstone marker (soft delete). `schemaVersion` is
    // for future field-shape migrations of this one entity.
    const SYNC_SCHEMA_VERSION = 1;

    function nowIso() {
      return new Date().toISOString();
    }

    // Attach fresh sync metadata to a brand-new entity (member, record,
    // reminder, policy, ledger row, coverage, rider, sumInsuredHistory
    // entry, claim, surrender record, ...). Call this once at creation time;
    // call bumpVersion() on every subsequent edit.
    function freshSyncMeta() {
      return { version: 1, updatedAt: nowIso(), deletedAt: null, schemaVersion: SYNC_SCHEMA_VERSION };
    }

    // Call on every local edit to an entity that already has sync metadata
    // (i.e. after migration, everything). Mutates in place.
    function bumpVersion(entity) {
      if (!entity || typeof entity !== 'object') return entity;
      entity.version = (Number.isFinite(entity.version) ? entity.version : 1) + 1;
      entity.updatedAt = nowIso();
      return entity;
    }

    // Persistent per-device identity, used only for conflict-queue
    // provenance/debugging (see design doc 1.3) - NEVER as a tie-breaker in
    // merge logic. Stored outside STORAGE_KEY/members on purpose, so it is
    // untouched by export/import and survives independently per browser.
    const DEVICE_ID_KEY = 'family_health_tracker_device_id';
    let _deviceId = null;
    function getDeviceId() {
      if (_deviceId) return _deviceId;
      try {
        let id = localStorage.getItem(DEVICE_ID_KEY);
        if (!id) {
          id = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : freshId('dev');
          localStorage.setItem(DEVICE_ID_KEY, id);
        }
        _deviceId = id;
      } catch (e) {
        // localStorage unavailable (private mode edge cases etc.) - fall
        // back to an in-memory id for this session only. Provenance-only
        // field, so a non-persistent fallback here is not a correctness risk.
        _deviceId = freshId('dev');
      }
      return _deviceId;
    }

    // Scalar member fields tracked individually via member.fieldVersion, so
    // two people editing different fields on the same member (e.g. A changes
    // phone, B changes allergies) never conflict with or clobber each other.
    // NOTE: keep this list in sync with the fields actually collected in
    // saveMember()'s `fields` object - any field added there without being
    // added here silently falls back to whole-member conflict granularity.
    const MEMBER_SCALAR_FIELDS = [
      'name', 'nameZh', 'nameZhAvatarIdx', 'gender', 'birth', 'blood',
      'height', 'allergies', 'emergency', 'bloodTypeAttachment'
    ];
    // history is handled separately (id+version entry array, see design 1.10 / 2.1), not a plain scalar.

    function freshFieldVersions() {
      const fv = {};
      MEMBER_SCALAR_FIELDS.forEach(f => { fv[f] = 1; });
      return fv;
    }

    // Bumps the fieldVersion entry for exactly the scalar fields that
    // actually changed between `before` and `after` (shallow compare via
    // JSON.stringify - fine for these field types: strings/numbers/null and
    // the small bloodTypeAttachment object). Also bumps entity.version once
    // if anything changed, matching bumpVersion()'s semantics.
    function bumpFieldVersions(member, before, after) {
      if (!member.fieldVersion) member.fieldVersion = freshFieldVersions();
      let changed = false;
      MEMBER_SCALAR_FIELDS.forEach(f => {
        if (JSON.stringify(before[f]) !== JSON.stringify(after[f])) {
          member.fieldVersion[f] = (member.fieldVersion[f] || 1) + 1;
          changed = true;
        }
      });
      if (changed) bumpVersion(member);
      return changed;
    }

    // Converts a plain history/notes string into the id+version entry-array
    // shape (design 1.10). v1 UI still edits this as a single block, so in
    // practice this array holds one entry that gets its version bumped on
    // edit - but the shape is future-proof for a later "append a new entry"
    // affordance without a text-migration headache.
    function historyTextToEntries(text) {
      const t = (text || '').trim();
      if (!t) return [];
      return [{ id: freshId('hx'), version: 1, text: t, deletedAt: null }];
    }
    // Reads the current effective history text back out of the entry array
    // (v1: just the latest non-deleted entry's text) for anywhere the app
    // still wants a plain string (rendering, reminders' `.includes(...)` check).
    function historyEntriesToText(entries) {
      if (!Array.isArray(entries)) return '';
      const live = entries.filter(e => !e.deletedAt);
      return live.length ? live[live.length - 1].text : '';
    }

    // For sub-entities that get rebuilt as a whole array on each save (policy
    // coverages/riders, edited via a temp array and committed together) -
    // matches newArr items to priorArr by id, carries forward
    // version/deletedAt/schemaVersion, and bumps version only if the
    // non-metadata content actually changed (mirrors bumpFieldVersions'
    // diff-before-bump discipline, so re-saving a policy with no real
    // changes to a given coverage/rider doesn't manufacture a fake
    // conflict later). Items with no matching prior id are new -> freshSyncMeta().
    // For sub-entities that get rebuilt as a whole array on each save (policy
    // coverages/riders, edited via a temp array and committed together) -
    // matches newArr items to priorArr by id, carries forward
    // version/deletedAt/schemaVersion, and bumps version only if the
    // non-metadata content actually changed (mirrors bumpFieldVersions'
    // diff-before-bump discipline, so re-saving a policy with no real
    // changes to a given coverage/rider doesn't manufacture a fake
    // conflict later). Items with no matching prior id are new -> freshSyncMeta().
    // Returns a NEW array - not just newArr mutated - because an existing
    // item the user removed from the temp editing array (i.e. present in
    // priorArr but missing from newArr) is soft-deleted and put BACK into
    // the result as a tombstone, rather than allowed to physically vanish.
    function syncStampSubEntities(priorArr, newArr) {
      const priorById = new Map((priorArr || []).map(x => [x.id, x]));
      const stripMeta = obj => {
        const c = { ...obj };
        delete c.version; delete c.deletedAt; delete c.schemaVersion; delete c.updatedAt;
        return c;
      };
      const seenIds = new Set();
      const result = (newArr || []).map(item => {
        seenIds.add(item.id);
        const prior = priorById.get(item.id);
        if (prior) {
          item.version = prior.version;
          item.deletedAt = prior.deletedAt;
          item.schemaVersion = prior.schemaVersion || SYNC_SCHEMA_VERSION;
          item.updatedAt = prior.updatedAt || nowIso();
          if (JSON.stringify(stripMeta(prior)) !== JSON.stringify(stripMeta(item))) bumpVersion(item);
        } else {
          Object.assign(item, freshSyncMeta());
        }
        return item;
      });
      (priorArr || []).forEach(prior => {
        if (seenIds.has(prior.id)) return;
        if (prior.deletedAt) { result.push(prior); return; } // already tombstoned - keep, per 1.8 (permanent)
        result.push(tombstone({ ...prior }));
      });
      return result;
    }


    // Attachment-array equivalent of syncStampSubEntities, but simpler:
    // attachments are immutable once uploaded (id + tombstone only, no
    // version - see design 1.9), so this only needs to catch items removed
    // from the temp editing array and turn them into tombstones instead of
    // letting them silently vanish on save.
    function syncStampAttachments(priorArr, newArr) {
      const seenIds = new Set((newArr || []).map(a => a.id));
      const result = [...(newArr || [])];
      (priorArr || []).forEach(prior => {
        if (seenIds.has(prior.id)) return;
        result.push(prior.deletedAt ? prior : { ...prior, deletedAt: nowIso() });
      });
      return result;
    }

    // the app displays/consumes a list rather than editing a specific known
    // entity. Deletion is now soft (writes deletedAt) rather than splicing,
    // per design 1.8/2.5 - every read site that shows a list to the user
    // needs to filter through this or a tombstoned entry will "come back"
    // in that view even though it was deleted.
    function live(arr) {
      return (arr || []).filter(x => !x || !x.deletedAt);
    }

    // Soft-deletes an entity: writes deletedAt + bumps version, instead of
    // splicing it out of its array. See design 1.7/1.8/2.5. Call this from
    // every delete action instead of Array#splice/#filter-out.
    function tombstone(entity) {
      if (!entity) return entity;
      entity.deletedAt = nowIso();
      bumpVersion(entity);
      return entity;
    }

    // existing (pre-merge-sync-feature) member data: called once at load
    // time for both real user data and DEMO_DATA. Idempotent - entities that
    // already have a `version` field are left untouched, so re-running this
    // on already-migrated data (e.g. after a fresh import of an old-format
    // single-member file) is always safe.
    function migrateSyncFields(allMembers) {
      if (!Array.isArray(allMembers)) return allMembers;

      // Generic recursive stamp for any array of id-bearing entities nested
      // under insurance (ledger rows, riders, coverages, sumInsuredHistory,
      // surrender records, claims, ...). Attachments get the reduced
      // id+deletedAt-only shape per design 1.9/2.2, not a full version stamp.
      function stampArray(arr, { attachmentsOnly = false } = {}) {
        if (!Array.isArray(arr)) return;
        arr.forEach(item => {
          if (!item || typeof item !== 'object') return;
          if (attachmentsOnly) {
            if (!('deletedAt' in item)) item.deletedAt = null;
            return;
          }
          if (!Number.isFinite(item.version)) item.version = 1;
          if (!('updatedAt' in item) || !item.updatedAt) item.updatedAt = nowIso();
          if (!('deletedAt' in item)) item.deletedAt = null;
          if (!Number.isFinite(item.schemaVersion)) item.schemaVersion = SYNC_SCHEMA_VERSION;
        });
      }

      function stampPolicy(p) {
        if (!p || typeof p !== 'object') return;
        if (!Number.isFinite(p.version)) p.version = 1;
        if (!('updatedAt' in p) || !p.updatedAt) p.updatedAt = nowIso();
        if (!('deletedAt' in p)) p.deletedAt = null;
        if (!Number.isFinite(p.schemaVersion)) p.schemaVersion = SYNC_SCHEMA_VERSION;
        stampArray(p.ledger);
        stampArray(p.riders);
        stampArray(p.coverages);
        (p.coverages || []).forEach(c => stampArray(c.sumInsuredHistory));
        stampArray(p.surrenderRecords);
        stampArray(p.attachments, { attachmentsOnly: true });
        (p.ledger || []).forEach(l => stampArray(l.attachments, { attachmentsOnly: true }));
        (p.surrenderRecords || []).forEach(s => stampArray(s.attachments, { attachmentsOnly: true }));
      }

      allMembers.forEach(m => {
        if (!m || typeof m !== 'object') return;

        if (!Number.isFinite(m.version)) m.version = 1;
        if (!('updatedAt' in m) || !m.updatedAt) m.updatedAt = nowIso();
        if (!('deletedAt' in m)) m.deletedAt = null;
        if (!Number.isFinite(m.schemaVersion)) m.schemaVersion = SYNC_SCHEMA_VERSION;
        if (!m.fieldVersion) m.fieldVersion = freshFieldVersions();

        // history: add the id+version entry-array shadow alongside the
        // existing m.history string, WITHOUT touching m.history itself yet.
        // Every current render/read site in the app (BP reminder check,
        // print views, the edit form, etc.) still reads m.history as a
        // plain string - rewiring all of those to read through
        // historyEntriesToText()/write through historyTextToEntries() is
        // deliberately left for the merge-wiring step (build order step 4),
        // not bundled into this data-layer pass. Until that wiring lands,
        // historyEntries exists but is not yet the source of truth -
        // m.history remains authoritative.
        if (!Array.isArray(m.historyEntries)) {
          m.historyEntries = historyTextToEntries(m.history);
        }

        stampArray(m.records);
        (m.records || []).forEach(r => stampArray(r.attachments, { attachmentsOnly: true }));
        stampArray(m.customReminders);
        if (m.bloodTypeAttachment && typeof m.bloodTypeAttachment === 'object' && !('deletedAt' in m.bloodTypeAttachment)) {
          m.bloodTypeAttachment.deletedAt = null;
        }

        if (m.insurance && Array.isArray(m.insurance.policies)) {
          m.insurance.policies.forEach(stampPolicy);
        }
        if (m.insurance && Array.isArray(m.insurance.claims)) {
          stampArray(m.insurance.claims);
        }
      });

      return allMembers;
    }

    // Returns a NEW array of records sorted by date descending (newest first).
    // Never mutates m.records, so "latest" values stay consistent no matter
    // which tabs the user has viewed.
    function recordsByDateDesc(m) {
      return live(m.records).sort((a, b) => new Date(b.date) - new Date(a.date));
    }

    // Finds the most recent record (by date) that has vitals, and returns its vitals.
    function getLatestVitals(m) {
      const withVitals = recordsByDateDesc(m).find(r => r.vitals && Object.keys(r.vitals).length);
      return withVitals?.vitals || {};
    }

    // Safe BMI calculation - returns '--' instead of 'NaN' when data is missing.
    function calcBmi(height, weight) {
      if (!height || !weight) return '--';
      const bmi = weight / ((height / 100) ** 2);
      return Number.isFinite(bmi) ? bmi.toFixed(1) : '--';
    }

    // ========== INDEXEDDB (attachment file storage) ==========
    // localStorage caps out around 5-10MB total, which a handful of photos
    // blows through fast. IndexedDB has a far higher ceiling (hundreds of MB+),
    // so the actual file bytes live here; localStorage only keeps a small
    // preview thumbnail + a reference id per attachment.
    const IDB_NAME = 'family_health_tracker_files';
    const IDB_STORE = 'attachments';
    let idbPromise = null;

    function idbOpen() {
      if (idbPromise) return idbPromise;
      idbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('IndexedDB not supported in this browser')); return; }
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(IDB_STORE)) {
            req.result.createObjectStore(IDB_STORE);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return idbPromise;
    }

    async function idbPutRaw(id, value) {
      const db = await idbOpen();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, id);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    }

    async function idbGetRaw(id) {
      const db = await idbOpen();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    async function idbDeleteRaw(id) {
      const db = await idbOpen();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(id);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    }

    // ========== ENCRYPTION (PBKDF2 + AES-GCM via Web Crypto) ==========
    // Encrypts/decrypts the attachment BLOBS stored in IndexedDB, AND (when
    // encryption is enabled) the entire members/policy JSON blob written to
    // localStorage by saveData() - see the ENC_PREFIX branch there. Exported
    // JSON/ZIP backups remain plaintext for portability (see "Encrypt
    // exported backups" toggle, reserved for later).
    const CRYPTO_CONFIG_KEY = 'family_health_tracker_v3_crypto';
    const ENC_PREFIX = 'ENCv1:';
    let cryptoKey = null; // in-memory CryptoKey; never persisted, cleared on lock/reload

    function getCryptoConfig() {
      try { return JSON.parse(localStorage.getItem(CRYPTO_CONFIG_KEY)) || null; } catch { return null; }
    }
    function setCryptoConfig(cfg) { localStorage.setItem(CRYPTO_CONFIG_KEY, JSON.stringify(cfg)); }
    function isEncryptionEnabled() { const cfg = getCryptoConfig(); return !!(cfg && cfg.enabled); }
    function isUnlocked() { return !!cryptoKey; }

    // Independent record of the user's last DELIBERATE encryption choice on
    // this device, separate from CRYPTO_CONFIG_KEY itself. Only ever written
    // in exactly two places: right after cryptoSetup() succeeds ('enabled'),
    // and right after the confirm()-gated "Disable Encryption" Settings
    // action completes ('disabled'). No other code path touches this key -
    // not import, not the PBKDF2 migration, not any error handler.
    //
    // Why this exists: init() decides whether to show the lock screen using
    // ONLY getCryptoConfig().enabled. If that ever comes back empty/false
    // for a reason OTHER than the deliberate disable flow above (a browser
    // storage anomaly, a future bug, anything) - init() would currently fall
    // straight through to initAppData() and render whatever's in
    // localStorage with no passcode prompt at all, since that's exactly what
    // "encryption is off" is supposed to look like. This sentinel lets init()
    // tell the difference between "encryption was intentionally turned off"
    // and "encryption config vanished unexpectedly" and warn loudly in the
    // second case instead of silently proceeding either way.
    const CRYPTO_INTENT_KEY = 'family_health_tracker_v3_crypto_intent';
    function setCryptoIntent(state) { try { localStorage.setItem(CRYPTO_INTENT_KEY, state); } catch {} }
    function getCryptoIntent() { try { return localStorage.getItem(CRYPTO_INTENT_KEY); } catch { return null; } }

    function bufToB64(buf) {
      // Chunked conversion - converting large buffers (e.g. an encrypted photo)
      // one character at a time via string concatenation is catastrophically
      // slow and was freezing the tab. 32KB chunks with String.fromCharCode.apply
      // is the standard safe/fast pattern (also avoids exceeding the engine's
      // max-arguments limit that a single whole-array .apply() call would hit).
      const bytes = new Uint8Array(buf);
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      return btoa(binary);
    }
    function b64ToBuf(b64) {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr.buffer;
    }

    // Bump PBKDF2_ITER_VERSION (and add a new entry to PBKDF2_CONFIGS) any
    // time the target iteration count needs to go up - same versioned-table
    // pattern as HKDF_CONFIGS/HKDF_SALT_VERSION below, so old configs stay
    // decodable (we know exactly which iteration count they were derived
    // with) while new ones get the stronger setting automatically. Version 1
    // is the original, pre-migration count this app shipped with for every
    // device that enabled encryption before this table existed - kept here
    // (not deleted) purely so cryptoUnlock() can still derive the right key
    // for those existing configs; new encryption setups never use it.
    const PBKDF2_ITER_VERSION = 2;
    const PBKDF2_CONFIGS = {
      1: 150000,   // legacy - kept only to unlock configs created before this migration
      2: 600000    // current - OWASP-recommended floor for PBKDF2-HMAC-SHA256 as of 2026
      // 3: <higher count>  // next rotation
    };

    async function deriveKeyFromPasscode(passcode, saltB64, iterations = PBKDF2_CONFIGS[PBKDF2_ITER_VERSION]) {
      const enc = new TextEncoder();
      const salt = b64ToBuf(saltB64);
      const baseKey = await crypto.subtle.importKey('raw', enc.encode(passcode), 'PBKDF2', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    }

    async function encryptText(plainText, key) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const enc = new TextEncoder();
      const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plainText));
      return ENC_PREFIX + bufToB64(iv) + ':' + bufToB64(cipherBuf);
    }
    async function decryptText(payload, key) {
      const parts = payload.slice(ENC_PREFIX.length).split(':');
      const iv = new Uint8Array(b64ToBuf(parts[0]));
      const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64ToBuf(parts[1]));
      return new TextDecoder().decode(plainBuf);
    }

    async function cryptoSetup(passcode) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const saltB64 = bufToB64(salt);
      const key = await deriveKeyFromPasscode(passcode, saltB64); // always uses PBKDF2_CONFIGS[PBKDF2_ITER_VERSION] - a brand-new setup has no legacy config to preserve
      const verifier = await encryptText('verify-ok', key);
      setCryptoConfig({ enabled: true, salt: saltB64, verifier, iterVer: PBKDF2_ITER_VERSION });
      setCryptoIntent('enabled');
      cryptoKey = key;
    }

    async function cryptoUnlock(passcode) {
      const cfg = getCryptoConfig();
      if (!cfg || !cfg.enabled) return false;
      try {
        // Configs written before PBKDF2_ITER_VERSION existed have no iterVer
        // field - treat those as version 1 (the count this app used to
        // hardcode) rather than defaulting to the current/highest count,
        // which would silently fail to unlock every pre-existing vault.
        const iterVer = cfg.iterVer || 1;
        const key = await deriveKeyFromPasscode(passcode, cfg.salt, PBKDF2_CONFIGS[iterVer]);
        const check = await decryptText(cfg.verifier, key);
        if (check !== 'verify-ok') return false;
        cryptoKey = key;
        // Fire-and-forget: bring this vault's iteration count up to the
        // current standard now that we have the plaintext passcode in hand
        // (we never store it, so this is the only time we can do this).
        // Runs after cryptoKey is already set so the just-completed unlock
        // isn't held up waiting on it.
        if (iterVer < PBKDF2_ITER_VERSION) migratePbkdf2Iterations(passcode, iterVer);
        return true;
      } catch { return false; }
    }

    function cryptoLock() { cryptoKey = null; }

    // Re-keys an already-unlocked vault from an older PBKDF2 iteration count
    // up to the current one, using the passcode the user just typed/supplied
    // via biometric unlock. This touches every encrypted attachment in
    // IndexedDB plus the main data blob in localStorage, so it's written to
    // fail SAFE rather than fail FAST: every attachment is decrypted with
    // the old key and re-encrypted with the new key into a staging list
    // first, and nothing is written back to IndexedDB - let alone the new
    // salt/verifier/iterVer committed to localStorage - until every single
    // one of those succeeds. If any attachment can't be decrypted with the
    // old key (shouldn't happen; the vault is unlocked, so the old key is
    // known-good, but corruption is always possible), the whole migration
    // aborts and nothing changes - the vault keeps working exactly as
    // before under the old iteration count, and will simply retry this
    // migration on the next unlock.
    //
    // Known accepted trade-off (same philosophy as saveData()'s async
    // write): if the tab is closed mid-migration, after the IndexedDB
    // writes below have started but before setCryptoConfig() commits the
    // new salt/verifier, the vault is left with a mix of old- and
    // new-key-encrypted attachments while the config still points at the
    // old key. beforeUnloadDuringMigration below warns the user not to
    // close the tab while this is running to make that window as small and
    // as visible as possible; it isn't a fully atomic transaction.
    let pbkdf2MigrationInProgress = false;
    function beforeUnloadDuringMigration(e) {
      e.preventDefault();
      e.returnValue = '';
    }
    async function migratePbkdf2Iterations(passcode, fromIterVer) {
      if (pbkdf2MigrationInProgress) return; // already running (e.g. two unlock paths raced)
      pbkdf2MigrationInProgress = true;
      window.addEventListener('beforeunload', beforeUnloadDuringMigration);
      try {
        const oldKey = cryptoKey;
        const newSaltB64 = bufToB64(crypto.getRandomValues(new Uint8Array(16)));
        const newKey = await deriveKeyFromPasscode(passcode, newSaltB64, PBKDF2_CONFIGS[PBKDF2_ITER_VERSION]);

        // Stage every attachment re-encryption before writing anything.
        const ids = collectAllAttachmentIds();
        const staged = []; // { id, newValue }
        for (const id of ids) {
          let raw;
          try { raw = await idbGetRaw(id); } catch { continue; }
          if (typeof raw !== 'string' || !raw.startsWith(ENC_PREFIX)) continue; // not encrypted - nothing to re-key
          const plain = await decryptText(raw, oldKey); // throws -> caught below, whole migration aborts
          staged.push({ id, newValue: await encryptText(plain, newKey) });
        }

        // If the user added/removed an attachment while we were staging
        // (idbPut() always encrypts under whatever key is current, so a
        // concurrently-added attachment above would still be sitting under
        // oldKey), committing now would orphan it: the config we're about
        // to write only remembers the NEW salt, so oldKey becomes
        // permanently underivable from a later cryptoUnlock() and that
        // attachment could never be decrypted again. Bail out instead -
        // nothing has been written yet, so this is a clean no-op, and the
        // next unlock simply tries the migration again against the vault's
        // current contents.
        const idsNow = collectAllAttachmentIds();
        if (idsNow.length !== ids.length || idsNow.some(id => !ids.includes(id))) {
          throw new Error('vault contents changed during migration staging, retrying next unlock');
        }

        // Nothing above can have modified IndexedDB or localStorage yet -
        // safe to commit now that every attachment re-encrypted cleanly.
        for (const { id, newValue } of staged) {
          await idbPutRaw(id, newValue);
        }
        const newVerifier = await encryptText('verify-ok', newKey);
        cryptoKey = newKey;
        setCryptoConfig({ enabled: true, salt: newSaltB64, verifier: newVerifier, iterVer: PBKDF2_ITER_VERSION });
        saveData(); // re-encrypts the members/insurance blob under the new key
      } catch (err) {
        // Nothing committed - old config/key/attachments are untouched, so
        // there's nothing to roll back. Just log and let the next unlock
        // retry from scratch.
        console.warn('PBKDF2 iteration migration skipped this time:', err);
      } finally {
        pbkdf2MigrationInProgress = false;
        window.removeEventListener('beforeunload', beforeUnloadDuringMigration);
      }
    }

    // ===== Biometric unlock (Face ID / Touch ID / Fingerprint via WebAuthn) =====
    // How this works: WebAuthn platform authenticators can't decrypt arbitrary
    // data by themselves, but browsers supporting the PRF extension let a
    // successful biometric assertion return a stable, high-entropy secret that
    // is unique to (this credential + this authenticator) and is never
    // observable without the user's fingerprint/face. We use that secret to
    // derive an AES-GCM key which wraps (encrypts) the user's real passcode.
    // On biometric unlock we re-derive the same wrapping key, decrypt the
    // passcode, and feed it straight into the normal cryptoUnlock() flow - so
    // the actual data-encryption key is still 100% derived from the passcode,
    // exactly as if the user had typed it.
    const BIO_CONFIG_KEY = 'family_health_tracker_v3_biometric';
    // REMOVED (security fix): this app used to support a "gate mode" fallback
    // for devices without WebAuthn PRF, where biometric verification was only
    // an application-level pass/fail check - the AES key it unlocked was a
    // separately generated, structured-cloned CryptoKey sitting in IndexedDB,
    // retrievable and directly usable (crypto.subtle.decrypt) by ANY script
    // running on the page, with no cryptographic dependency on the WebAuthn
    // assertion actually succeeding. That gave a false sense of security: it
    // looked identical to real biometric-gated encryption in the UI, but any
    // XSS, malicious extension, or someone with devtools access on an already
    // -unlocked device could recover the passcode without touching a sensor.
    // We now only support PRF mode, where the AES key is *derived* from the
    // PRF secret itself and provably cannot exist without a real, successful
    // biometric assertion. This constant is kept only so any device that
    // still has an old gate-mode key sitting in IndexedDB gets it cleaned up.
    const BIO_GATE_KEY_ID = 'family_health_tracker_v3_biometric_gate_key';
    function getBioConfig() {
      try { return JSON.parse(localStorage.getItem(BIO_CONFIG_KEY)) || null; } catch { return null; }
    }
    function setBioConfig(cfg) { localStorage.setItem(BIO_CONFIG_KEY, JSON.stringify(cfg)); }
    async function clearBioConfig() {
      localStorage.removeItem(BIO_CONFIG_KEY);
      try { await idbDeleteRaw(BIO_GATE_KEY_ID); } catch { /* nothing to clean up */ }
    }
    function isBiometricEnrolled() { return !!getBioConfig(); }

    // Separate from BIO_CONFIG_KEY on purpose: this flag tracks whether the
    // user has been told about a security-driven biometric reset, and needs
    // to survive independently of whether the (now-deleted) bio record still
    // exists. Without this, the notice could only ever be shown on the exact
    // render call that performed the deletion - a force-quit, page reload, or
    // literally any other UI event overwriting the same text node before the
    // user reads it would lose the explanation for good, leaving them with a
    // biometric button that silently vanished.
    const BIO_MIGRATION_NOTICE_KEY = 'family_health_tracker_v3_bio_migration_notice';
    function hasPendingMigrationNotice() { return localStorage.getItem(BIO_MIGRATION_NOTICE_KEY) === '1'; }
    function setPendingMigrationNotice() { localStorage.setItem(BIO_MIGRATION_NOTICE_KEY, '1'); }
    function clearPendingMigrationNotice() { localStorage.removeItem(BIO_MIGRATION_NOTICE_KEY); }

    // Bump whenever HKDF_SALT (or anything else feeding key derivation)
    // changes, so we can tell apart PRF records made before/after the change
    // and safely wipe the ones that were derived with different inputs
    // (their wrapped passcode would just fail to decrypt otherwise, which is
    // confusing - "biometric unlock silently stopped working" - rather than
    // a clear "please set it up again").
    const HKDF_SALT_VERSION = 2;

    // Security migration: wipes any biometric record that can no longer be
    // trusted to actually decrypt with the current key-derivation logic,
    // rather than letting it linger and fail confusingly later. Covers two
    // cases: (1) legacy "gate mode" records, where biometric verification was
    // only an application-level pass/fail check with no cryptographic tie to
    // the unlock key (see the removed gate-mode code above for why that
    // wasn't real protection), and (2) older PRF-mode records derived before
    // HKDF_SALT was introduced, which would now decrypt to garbage. Returns
    // true if a record was found and removed, so the caller can tell the
    // user why biometric unlock disappeared and that it's safe to set up
    // again (it will only succeed on devices with genuine WebAuthn PRF).
    async function migrateLegacyBiometric() {
      const bcfg = getBioConfig();
      if (!bcfg) return false;
      const method = bioMethodOf(bcfg);
      const outdatedPrf = method === 'prf' && bcfg.hkdfSaltVer !== HKDF_SALT_VERSION;
      if (method === 'gate' || outdatedPrf) {
        await clearBioConfig();
        setPendingMigrationNotice();
        return true;
      }
      return false;
    }

    // Normalizes a stored biometric record to an explicit mode, so records
    // written before the 'method' field existed still work: presence of
    // `prfSalt` means it was PRF-mode, `wrappingKeyStored` means gate-mode.
    function bioMethodOf(bcfg) {
      if (bcfg.method) return bcfg.method;
      if (bcfg.prfSalt) return 'prf';
      if (bcfg.wrappingKeyStored) return 'gate';
      return null;
    }

    async function isPlatformAuthenticatorAvailable() {
      try {
        return !!(window.PublicKeyCredential &&
          PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable &&
          await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
      } catch { return false; }
    }

    // Derives an AES-256-GCM key from a WebAuthn PRF secret via HKDF.
    // Salt/hash live in a versioned config table rather than being inlined
    // directly into the derivation call, so rotating them later (e.g. if a
    // compliance requirement changes, or this salt turns out to collide with
    // some published test vector) is a one-line addition + version bump here,
    // with no changes needed to the derivation or migration logic - both
    // already key off HKDF_SALT_VERSION. HKDF salts don't need to be secret;
    // these are safe to hardcode and safe to publish.
    const HKDF_CONFIGS = {
      2: {
        hash: 'SHA-256',
        salt: new Uint8Array([
          0x8f, 0x2a, 0x61, 0xe0, 0x3c, 0x9d, 0x74, 0x1b, 0x5e, 0xa8, 0x02, 0xf6,
          0x39, 0xc4, 0x1d, 0x87, 0xb0, 0x4e, 0x92, 0x6a, 0xd5, 0x11, 0x7c, 0x38,
          0xef, 0x60, 0x2b, 0x94, 0x18, 0xa3, 0x55, 0xd9
        ])
      }
      // 3: { hash: 'SHA-256', salt: new Uint8Array([...]) } // next rotation
    };
    async function aesKeyFromPrfSecret(prfBytes, saltVer = HKDF_SALT_VERSION) {
      const config = HKDF_CONFIGS[saltVer];
      if (!config) throw new Error(`Unknown HKDF salt version: ${saltVer}`);
      const base = await crypto.subtle.importKey('raw', prfBytes, 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: config.hash, salt: config.salt, info: new TextEncoder().encode('family-health-shield-bio-wrap-v1') },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    }

    // Registers a platform authenticator credential using the WebAuthn PRF
    // extension. PRF is required, not optional: it's what lets us *derive*
    // the wrapping key from the biometric-gated secret itself, so the key
    // provably cannot exist without a real successful biometric assertion.
    // If this device/browser doesn't expose usable PRF output, we deliberately
    // fail closed (see the removed "gate mode" fallback above) rather than
    // enroll something that looks like biometric protection but isn't. Throws
    // with a human-readable message on any failure (cancelled, unsupported,
    // no PRF available, etc.).
    async function enrollBiometric(passcode) {
      const cfg = getCryptoConfig();
      if (!cfg || !cfg.enabled) throw new Error('Enable encryption first.');
      // Must derive with whatever iteration count this vault's key actually
      // uses right now (cfg.iterVer, defaulting to legacy version 1) - same
      // reasoning as cryptoUnlock() and the import fix above. Defaulting to
      // the current/highest count here would silently produce the wrong key
      // and reject a correct passcode on any vault that hasn't been through
      // migratePbkdf2Iterations() yet.
      const testKey = await deriveKeyFromPasscode(passcode, cfg.salt, PBKDF2_CONFIGS[cfg.iterVer || 1]);
      let check;
      try { check = await decryptText(cfg.verifier, testKey); } catch { check = null; }
      if (check !== 'verify-ok') throw new Error('Incorrect passcode.');

      if (!window.PublicKeyCredential) throw new Error('This browser does not support biometric unlock.');

      const userId = crypto.getRandomValues(new Uint8Array(16));
      const prfSalt = crypto.getRandomValues(new Uint8Array(32));
      const baseCreateOptions = {
        rp: { name: 'Family Health & Shield' },
        user: { id: userId, name: 'family-health-shield', displayName: 'Family Health & Shield' },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
        timeout: 60000
      };

      // Step 1: try registering WITH the PRF extension requested. Some
      // Android devices/Chrome versions throw synchronously the moment PRF
      // is requested, before the user even sees a fingerprint prompt - so if
      // this throws, silently retry without PRF rather than surfacing
      // "device not supported" and giving up.
      let cred;
      let requestedPrf = true;
      try {
        cred = await navigator.credentials.create({
          publicKey: { ...baseCreateOptions, extensions: { prf: {} } }
        });
      } catch {
        requestedPrf = false;
        cred = await navigator.credentials.create({ publicKey: baseCreateOptions });
      }
      if (!cred) throw new Error('Biometric setup was cancelled.');

      // Step 2: figure out whether we actually got usable PRF output. Some
      // browsers return it directly from create(); most only return it on a
      // follow-up get(). If we never requested the extension, or neither
      // attempt yields a result, this device doesn't have usable PRF.
      let prfResult = null;
      if (requestedPrf) {
        const createExt = cred.getClientExtensionResults();
        prfResult = createExt && createExt.prf && createExt.prf.results && createExt.prf.results.first;
        if (!prfResult) {
          try {
            const assertion = await navigator.credentials.get({
              publicKey: {
                challenge: crypto.getRandomValues(new Uint8Array(32)),
                allowCredentials: [{ id: cred.rawId, type: 'public-key' }],
                userVerification: 'required',
                extensions: { prf: { eval: { first: prfSalt } } }
              }
            });
            const getExt = assertion.getClientExtensionResults();
            prfResult = getExt && getExt.prf && getExt.prf.results && getExt.prf.results.first;
          } catch { prfResult = null; }
        }
      }

      if (!prfResult) {
        // Fail closed: this device/browser has a platform authenticator but
        // no usable PRF output, so we cannot cryptographically bind the
        // wrapping key to a real biometric assertion. Note the just-created
        // credential is simply left unused (WebAuthn has no standard API to
        // delete it from JS) - harmless, since we never store a bio config
        // for it, so isBiometricEnrolled() stays false and nothing wraps the
        // passcode with it.
        throw new Error('This browser/device doesn\'t support secure biometric unlock (no WebAuthn PRF support). Please continue using your passcode.');
      }

      // ----- PRF mode: wrapping key is derived from the PRF secret itself -----
      const wrapKey = await aesKeyFromPrfSecret(new Uint8Array(prfResult));
      const wrapped = await encryptText(passcode, wrapKey);
      setBioConfig({ method: 'prf', credentialId: bufToB64(cred.rawId), prfSalt: bufToB64(prfSalt), hkdfSaltVer: HKDF_SALT_VERSION, wrapped });
      // A fresh, valid enrollment means the notice (if any) has served its
      // purpose - the user just proved they saw it by successfully setting
      // biometric unlock back up.
      clearPendingMigrationNotice();
    }

    // Prompts the biometric sensor and returns the recovered passcode string,
    // or null if the user cancelled, the sensor failed, or nothing is enrolled.
    async function tryBiometricUnlockPasscode() {
      const bcfg = getBioConfig();
      if (!bcfg) return null;
      const method = bioMethodOf(bcfg);
      // Legacy gate-mode records are no longer honored (see
      // migrateLegacyBiometric for why) - callers are expected to run
      // that migration at UI-render time so this case shouldn't normally be
      // reached, but we still refuse to use it here as a defense in depth.
      if (method !== 'prf') return null;
      try {
        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            allowCredentials: [{ id: b64ToBuf(bcfg.credentialId), type: 'public-key' }],
            userVerification: 'required',
            extensions: { prf: { eval: { first: b64ToBuf(bcfg.prfSalt) } } }
          }
        });
        const ext = assertion.getClientExtensionResults();
        const prfResult = ext && ext.prf && ext.prf.results && ext.prf.results.first;
        if (!prfResult) return null;
        const wrapKey = await aesKeyFromPrfSecret(new Uint8Array(prfResult), bcfg.hkdfSaltVer);
        return await decryptText(bcfg.wrapped, wrapKey);
      } catch {
        return null;
      }
    }


    // Collects every attachment id referenced anywhere in the app's data
    // (health record attachments, blood type proof, insurance policy
    // attachments, insurance ledger transaction attachments).
    function collectAllAttachmentIds() {
      const ids = [];
      members.forEach(m => {
        if (m.bloodTypeAttachment && m.bloodTypeAttachment.id) ids.push(m.bloodTypeAttachment.id);
        (m.records || []).forEach(r => (r.attachments || []).forEach(a => { if (a.id) ids.push(a.id); }));
        if (m.insurance) {
          (m.insurance.policies || []).forEach(p => {
            (p.attachments || []).forEach(a => { if (a.id) ids.push(a.id); });
            (p.ledger || []).forEach(l => (l.attachments || []).forEach(a => { if (a.id) ids.push(a.id); }));
            (p.surrenderRecords || []).forEach(r => (r.attachments || []).forEach(a => { if (a.id) ids.push(a.id); }));
          });
        }
      });
      return ids;
    }

    // Re-encrypts (or decrypts back to plaintext) every attachment currently in
    // IndexedDB. Requires the vault to be unlocked. Used when first turning
    // encryption on (to protect files added before it was enabled) and when
    // turning it off (so nothing is left inaccessible).
    async function reencryptAllAttachments(toEncrypted) {
      const ids = collectAllAttachmentIds();
      let changed = 0, skipped = 0;
      for (const id of ids) {
        let raw;
        try { raw = await idbGetRaw(id); } catch { skipped++; continue; }
        if (raw == null) { skipped++; continue; }
        const isEnc = typeof raw === 'string' && raw.startsWith(ENC_PREFIX);
        let plain;
        if (isEnc) {
          if (!cryptoKey) { skipped++; continue; }
          try { plain = await decryptText(raw, cryptoKey); } catch { skipped++; continue; }
        } else {
          plain = raw;
        }
        const newValue = (toEncrypted && cryptoKey) ? await encryptText(plain, cryptoKey) : plain;
        await idbPutRaw(id, newValue);
        changed++;
      }
      return { changed, skipped };
    }

    // Smart wrappers used everywhere in the app (persistAttachmentsToIdb, etc.)
    // Transparently encrypts on write / decrypts on read when enabled+unlocked.
    // Values without the ENCv1: prefix are treated as plaintext (backward
    // compatible with attachments saved before encryption was ever enabled).
    async function idbPut(id, dataUrl) {
      const cfg = getCryptoConfig();
      let valueToStore = dataUrl;
      if (cfg && cfg.enabled) {
        if (!cryptoKey) throw new Error('Vault is locked. Please unlock before adding attachments.');
        valueToStore = await encryptText(dataUrl, cryptoKey);
      }
      return idbPutRaw(id, valueToStore);
    }

    async function idbGet(id) {
      const raw = await idbGetRaw(id);
      if (typeof raw === 'string' && raw.startsWith(ENC_PREFIX)) {
        if (!cryptoKey) throw new Error('Vault is locked. Please unlock to view this attachment.');
        return await decryptText(raw, cryptoKey);
      }
      return raw;
    }

    // Shows the unlock prompt and resolves true/false depending on whether the
    // vault ends up unlocked. If encryption isn't enabled, resolves true immediately.
    let unlockResolver = null;
    function ensureUnlocked() {
      if (!isEncryptionEnabled() || isUnlocked()) return Promise.resolve(true);
      return new Promise((resolve) => {
        unlockResolver = resolve;
        document.getElementById('unlockPasscodeInput').value = '';
        document.getElementById('unlockError').textContent = '';
        document.getElementById('unlockModal').classList.add('active');
        if (resetUnlockNumpad) resetUnlockNumpad();
        setTimeout(() => document.getElementById('unlockPasscodeInput').focus(), 50);
        updateUnlockModalBioUI();
      });
    }

    async function updateUnlockModalBioUI() {
      const enrolled = isBiometricEnrolled();
      const supported = enrolled && await isPlatformAuthenticatorAvailable();
      document.getElementById('btnBioUnlock').style.display = supported ? 'block' : 'none';
      document.getElementById('bioUnlockDivider').style.display = supported ? 'block' : 'none';
    }


    async function idbDelete(id) {
      try {
        const db = await idbOpen();
        return new Promise((resolve) => {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).delete(id);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        });
      } catch { return false; }
    }

    async function idbDeleteMany(ids) {
      for (const id of ids) { if (id) await idbDelete(id); }
    }

    async function idbClearAll() {
      try {
        const db = await idbOpen();
        return new Promise((resolve) => {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).clear();
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        });
      } catch { return false; }
    }

    function makeAttId() {
      return 'att_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    // Given an attachment object as stored in `members` (id + thumb, no inline data),
    // resolve its actual file bytes - from IndexedDB for new-format attachments,
    // or from the old inline .data/.thumb fields for anything saved before this migration.
    async function resolveAttachmentData(att) {
      if (!att) return null;
      if (att.data) return att.data; // legacy inline data, or not-yet-persisted temp attachment
      if (att.id) {
        try { return await idbGet(att.id); } catch { return null; }
      }
      return att.thumb || null;
    }

    // Persists any attachments in `list` that still carry inline `.data` into IndexedDB,
    // returning a new array of lightweight {id, name, path, type, thumb, size} refs
    // suitable for storing in localStorage. Attachments that already have an `.id`
    // and no `.data` are passed through untouched (already stored).
    // Generates a small preview thumbnail from an existing data URL (used when
    // migrating imported attachments that carry full data but no thumb yet).
    function makeThumbFromDataUrl(dataUrl, maxDim = 96, quality = 0.5) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            const scale = maxDim / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => resolve(null);
        img.src = dataUrl;
      });
    }

    async function persistAttachmentsToIdb(list) {
      const out = [];
      for (const att of (list || [])) {
        if (att.data) {
          // Any attachment carrying full data needs a FRESH local IndexedDB id -
          // even if it already has an `id`, that id may be from a different
          // browser's export and won't exist in this browser's IndexedDB.
          const id = makeAttId();
          await idbPut(id, att.data);
          let thumb = att.thumb;
          if (!thumb && att.type === 'image') thumb = await makeThumbFromDataUrl(att.data);
          out.push({ id, name: att.name, path: att.path, type: att.type, thumb, size: att.size || att.data.length, deletedAt: null });
        } else {
          out.push(att);
        }
      }
      return out;
    }

    // Estimates current storage usage (localStorage + IndexedDB attachment bytes) for the storage meter.
    async function estimateStorageUsage() {
      let lsBytes = 0;
      try { lsBytes = new Blob([localStorage.getItem(STORAGE_KEY) || '']).size; } catch {}
      let idbBytes = 0;
      let fileCount = 0;
      try {
        const db = await idbOpen();
        const result = await new Promise((resolve) => {
          let total = 0;
          let count = 0;
          const tx = db.transaction(IDB_STORE, 'readonly');
          const req = tx.objectStore(IDB_STORE).openCursor();
          req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) { total += (cursor.value || '').length; count++; cursor.continue(); }
            else resolve({ total, count });
          };
          req.onerror = () => resolve({ total, count });
        });
        idbBytes = result.total;
        fileCount = result.count;
      } catch {}
      return { lsBytes, idbBytes, fileCount, totalBytes: lsBytes + idbBytes };
    }

    // Refreshes the small storage indicator in the sidebar. localStorage caps
    // around 5-10MB (records/text), IndexedDB (attachment files) has far more
    // headroom (typically hundreds of MB+), so they're shown separately.
    async function updateStorageMeter() {
      const el = document.getElementById('storageMeter');
      if (!el) return;
      try {
        const { totalBytes, idbBytes, fileCount } = await estimateStorageUsage();

        let usage = totalBytes, quota = null;
        if (navigator.storage && navigator.storage.estimate) {
          try {
            const est = await navigator.storage.estimate();
            if (est.quota) { usage = est.usage; quota = est.quota; }
          } catch {}
        }

        const pct = quota ? Math.min(100, (usage / quota) * 100) : Math.min(100, (totalBytes / (5 * 1024 * 1024)) * 100);
        const barColor = pct > 80 ? '#dc2626' : pct > 50 ? '#d97706' : '#10b981';

        const appLine = `App data: ~${formatBytes(totalBytes)}` +
          (fileCount ? ` (incl. ${fileCount} file${fileCount === 1 ? '' : 's'}, ~${formatBytes(idbBytes)})` : '');
        const quotaLine = quota
          ? `Browser quota: ~${formatBytes(quota)} total, ~${formatBytes(usage)} used (this site)`
          : `Estimated ~5MB cap for app data (browser quota API unavailable)`;

        el.innerHTML = `
          <div class="s-244a7f30">${appLine}</div>
          <div class="s-2c4ad88d">
            <div class="s-quotafill" data-quota-fill></div>
          </div>
          <div class="s-244a7f30">${quotaLine}</div>
        `;
        // width/color are per-load numeric values, so they're set as individual CSSOM
        // properties here rather than baked into the template's HTML as style="..." --
        // that keeps this CSP-safe under style-src without 'unsafe-inline' (assigning a
        // single .style.<prop> is allowed; a literal style attribute or .style.cssText
        // string is not).
        const fillEl = el.querySelector('[data-quota-fill]');
        if (fillEl) {
          fillEl.style.width = pct + '%';
          fillEl.style.background = barColor;
        }
      } catch {
        el.innerHTML = '';
      }
    }

    // ========== ON-SCREEN NUMPAD (app lock screen + attachment unlock modal) ==========
    // Wires a big touch-friendly numpad to a passcode <input>, for mobile/tablet
    // users who'd otherwise have to fight the OS's cramped default keyboard.
    // The input keeps inputmode="none" (set in the HTML) so tapping it directly
    // does not pop up the on-screen keyboard; numpad buttons only ever write to
    // input.value, never call .focus(), so the keyboard stays down on mobile
    // regardless. Passcodes aren't restricted to digits (see secPasscode
    // validation - just "at least 6 characters"), so a small ⌨️ toggle switches
    // the field back to normal free-text keyboard entry for anyone whose
    // passcode has letters/symbols in it, and back again.
    function wirePasscodeNumpad(inputId, numpadId, toggleId, backspaceId) {
      const input = document.getElementById(inputId);
      const numpad = document.getElementById(numpadId);
      const toggleBtn = document.getElementById(toggleId);
      const backspaceBtn = document.getElementById(backspaceId);
      if (!input || !numpad || !toggleBtn || !backspaceBtn) return;

      let keyboardMode = false;

      function appendChar(ch) {
        input.value += ch;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      function backspace() {
        input.value = input.value.slice(0, -1);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      function setKeyboardMode(on) {
        keyboardMode = on;
        if (on) {
          input.removeAttribute('inputmode');
          numpad.classList.add('s-hidden');
          toggleBtn.textContent = '🔢';
          toggleBtn.title = 'Switch back to number pad';
          input.focus();
        } else {
          input.setAttribute('inputmode', 'none');
          numpad.classList.remove('s-hidden');
          toggleBtn.textContent = '⌨️';
          toggleBtn.title = 'Passcode has letters? Switch to keyboard';
        }
      }

      numpad.querySelectorAll('[data-numpad-digit]').forEach((btn) => {
        btn.addEventListener('click', () => appendChar(btn.getAttribute('data-numpad-digit')));
      });
      backspaceBtn.addEventListener('click', backspace);
      toggleBtn.addEventListener('click', () => setKeyboardMode(!keyboardMode));

      // Reset to numpad mode whenever the screen/modal holding this input is
      // (re)shown, so a previous keyboard-mode choice doesn't leak into the
      // next unlock attempt.
      return () => setKeyboardMode(false);
    }

    const resetAppLockNumpad = wirePasscodeNumpad(
      'appLockPasscodeInput', 'appLockNumpad', 'appLockNumpadToggle', 'appLockNumpadBackspace'
    );
    const resetUnlockNumpad = wirePasscodeNumpad(
      'unlockPasscodeInput', 'unlockNumpad', 'unlockNumpadToggle', 'unlockNumpadBackspace'
    );

    // ========== INIT ==========
    let membersLoaded = false;

    function init() {
      const cfg = getCryptoConfig();
      if (cfg && cfg.enabled) {
        // Backfill for devices that enabled encryption before this sentinel
        // existed - from this point on their intent is correctly tracked too.
        if (getCryptoIntent() !== 'enabled') setCryptoIntent('enabled');
        // Data is encrypted at rest - block the whole app until the passcode is verified.
        document.getElementById('appLockScreen').style.display = 'flex';
        if (resetAppLockNumpad) resetAppLockNumpad();
        setTimeout(() => document.getElementById('appLockPasscodeInput').focus(), 50);
        updateAppLockBioUI();
      } else if (getCryptoIntent() === 'enabled') {
        // Encryption's own config is missing/disabled, but the last
        // DELIBERATE choice recorded on this device was "enabled," and
        // that record is only ever changed by the confirm()-gated Disable
        // Encryption action (which would have set it to 'disabled'). This
        // combination should be impossible through normal use - warn
        // loudly rather than silently rendering whatever's in localStorage
        // (which, with encryption off, is plaintext) with no passcode
        // prompt at all. Still proceed afterward rather than hard-locking
        // the person out with no path forward - see the comment on
        // CRYPTO_INTENT_KEY above for the reasoning.
        alert(
          '⚠️ Encryption settings could not be found on this device, even ' +
          'though encryption was previously turned on here. Your data may ' +
          'now be loading unencrypted.\n\n' +
          'This should not happen during normal use. If you did not ' +
          'deliberately disable encryption in Settings, please check ' +
          'Settings → Security once the app loads, and consider restoring ' +
          'from a recent backup to be safe.'
        );
        initAppData();
      } else {
        initAppData();
      }
    }

    // Shows/hides the "Unlock with Face ID / Fingerprint" option on the
    // full-app lock screen, depending on whether it's enrolled on this device
    // and whether this browser currently supports it.
    async function updateAppLockBioUI() {
      await migrateLegacyBiometric();
      const enrolled = isBiometricEnrolled();
      const supported = enrolled && await isPlatformAuthenticatorAvailable();
      document.getElementById('btnAppLockBio').style.display = supported ? 'block' : 'none';
      document.getElementById('appLockBioDivider').style.display = supported ? 'block' : 'none';
      if (hasPendingMigrationNotice()) {
        document.getElementById('appLockError').textContent =
          'Biometric unlock was reset on this device for security reasons. Enter your passcode below, then you can turn it back on from Security settings.';
      }
    }

    document.getElementById('btnAppLockUnlock').addEventListener('click', attemptAppUnlock);
    document.getElementById('appLockPasscodeInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') attemptAppUnlock();
    });
    async function attemptAppUnlock() {
      const pass = document.getElementById('appLockPasscodeInput').value;
      const ok = await cryptoUnlock(pass);
      if (!ok) {
        document.getElementById('appLockError').textContent = 'Incorrect passcode.';
        return;
      }
      document.getElementById('appLockScreen').style.display = 'none';
      document.getElementById('appLockPasscodeInput').value = '';
      document.getElementById('appLockError').textContent = '';
      if (!membersLoaded) {
        await initAppData();
      }
    }

    document.getElementById('btnAppLockBio').addEventListener('click', async () => {
      document.getElementById('appLockError').textContent = '';
      const pass = await tryBiometricUnlockPasscode();
      if (!pass) {
        document.getElementById('appLockError').textContent = 'Biometric unlock failed or was cancelled. Enter your passcode instead.';
        return;
      }
      const ok = await cryptoUnlock(pass);
      if (!ok) {
        document.getElementById('appLockError').textContent = 'Biometric-stored passcode no longer matches. Please enter it manually.';
        return;
      }
      document.getElementById('appLockScreen').style.display = 'none';
      document.getElementById('appLockPasscodeInput').value = '';
      document.getElementById('appLockError').textContent = '';
      if (!membersLoaded) {
        await initAppData();
      }
    });

    // Re-shows the lock screen (used by "Lock Now") without reloading the page.
    // Members already in memory stay decrypted in memory, but the UI is fully
    // covered and unusable until the passcode is entered again.
    function relockApp() {
      cryptoLock();
      document.getElementById('appLockScreen').style.display = 'flex';
      if (resetAppLockNumpad) resetAppLockNumpad();
      setTimeout(() => document.getElementById('appLockPasscodeInput').focus(), 50);
      updateAppLockBioUI();
    }

    async function initAppData() {
      // Try to load from localStorage
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && saved.startsWith(ENC_PREFIX)) {
        // Encrypted data: only ever reached after a verified passcode unlock.
        // If decryption still fails here, something is genuinely wrong -
        // NEVER fall back to demo data, that would silently destroy the real data.
        try {
          const jsonStr = await decryptText(saved, cryptoKey);
          const parsed = JSON.parse(jsonStr);
          members = (Array.isArray(parsed) && parsed.length > 0) ? parsed : [];
          migrateSyncFields(members);
        } catch (e) {
          alert('⚠️ Your data could not be decrypted even though the passcode was accepted. ' +
                'To avoid data loss, the app will not load or overwrite anything. ' +
                'Please reload the page and try again, or restore from a backup.\n\nError: ' + e.message);
          members = [];
          membersLoaded = true;
          return;
        }
      } else if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) {
            members = parsed;
            migrateSyncFields(members);
          } else {
            members = JSON.parse(JSON.stringify(DEMO_DATA));
            migrateSyncFields(members);
            saveData();
          }
        } catch(e) {
          members = JSON.parse(JSON.stringify(DEMO_DATA));
          migrateSyncFields(members);
          saveData();
        }
      } else {
        // First time - load demo data
        members = JSON.parse(JSON.stringify(DEMO_DATA));
        migrateSyncFields(members);
        saveData();
      }

      membersLoaded = true;
      bindEvents();
      renderMemberList();
      renderMain();
      updateConflictBadge();
    }

    // Encrypts the ENTIRE app data blob (all members: health + insurance) before
    // writing to localStorage when encryption is enabled. Web Crypto's encrypt
    // is inherently async, so this fires the encrypted write in the background
    // rather than blocking every single mutation in the app on await - the
    // window where an edit could theoretically be lost if the tab is closed
    // within a few milliseconds of saving is an accepted, documented trade-off.
    function saveData() {
      const cfg = getCryptoConfig();
      const json = JSON.stringify(members);
      if (cfg && cfg.enabled && cryptoKey) {
        encryptText(json, cryptoKey).then(enc => {
          try { localStorage.setItem(STORAGE_KEY, enc); }
          catch (err) { console.error('Encrypted save failed:', err); }
        }).catch(err => console.error('Encryption failed:', err));
        return true;
      }
      try {
        localStorage.setItem(STORAGE_KEY, json);
        return true;
      } catch (err) {
        alert('⚠️ Could not save your data (storage may be full).\n\n' +
              'Your change is only kept in this browser tab for now. ' +
              'Try removing some photo attachments to free up space, or export a backup immediately.\n\n' +
              'Error: ' + err.message);
        return false;
      }
    }

    function resetData() {
      if (!confirm('Clear all data and reset to demo?')) return;
      localStorage.removeItem(STORAGE_KEY);
      idbClearAll();
      members = JSON.parse(JSON.stringify(DEMO_DATA));
      currentMemberId = null;
      currentTab = 'overview';
      saveData();
      renderMemberList();
      renderMain();
    }

    // Regenerates smaller preview thumbnails for every already-saved photo,
    // using the full-quality copy already safely stored in IndexedDB - so this
    // never touches your original photos, only the small localStorage preview.
    // This is the fix for "storage full" errors caused by thumbnails that were
    // saved back when thumbnails were larger.
    async function compactThumbnails() {
      if (!confirm('Shrink saved photo previews to free up storage space?\n\nThis regenerates smaller thumbnails from your existing full-quality photos (which stay untouched in IndexedDB) - nothing is deleted.')) return;

      let changed = 0;
      for (const m of members) {
        for (const r of (m.records || [])) {
          for (const att of (r.attachments || [])) {
            if (att.type === 'image' && att.id) {
              try {
                const fullData = await idbGet(att.id);
                if (fullData) {
                  const newThumb = await makeThumbFromDataUrl(fullData, 96, 0.5);
                  if (newThumb && newThumb.length < (att.thumb || '').length) { att.thumb = newThumb; changed++; }
                }
              } catch {}
            }
          }
        }
        if (m.bloodTypeAttachment?.type === 'image' && m.bloodTypeAttachment.id) {
          try {
            const fullData = await idbGet(m.bloodTypeAttachment.id);
            if (fullData) {
              const newThumb = await makeThumbFromDataUrl(fullData, 96, 0.5);
              if (newThumb && newThumb.length < (m.bloodTypeAttachment.thumb || '').length) { m.bloodTypeAttachment.thumb = newThumb; changed++; }
            }
          } catch {}
        }
      }

      if (!saveData()) {
        alert(`Regenerated ${changed} thumbnail(s), but storage is still full.\n\nExport a backup now (Export All), then consider removing a few older photo attachments to free up room.`);
        return;
      }
      alert(`Done - shrank ${changed} photo preview(s). Storage space freed up.`);
      renderMemberList();
      renderMain();
    }

    // Human-readable labels for the modal - kept separate from any
    // internal field/container key names so this can be reworded freely.
    const CONFLICT_FIELD_LABELS = {
      name: 'Name', nameZh: 'Chinese name', gender: 'Gender', birth: 'Date of birth',
      blood: 'Blood type', height: 'Height', allergies: 'Allergies', emergency: 'Emergency contact',
      bloodTypeAttachment: 'Blood type document'
    };
    const CONFLICT_CONTAINER_LABELS = {
      records: 'Health record', customReminders: 'Reminder', historyEntries: 'Medical history note',
      policies: 'Policy', ledger: 'Premium payment', riders: 'Rider',
      coverages: 'Coverage', sumInsuredHistory: 'Sum insured entry', surrenderRecords: 'Surrender/statement record',
      claims: 'Claim'
    };
    // A short one-line summary per entity type, for the two "before/after"
    // columns - design 2.7 explicitly wants no inline diffing, just enough
    // to tell the two versions apart at a glance.
    function summarizeConflictSide(containerKey, obj) {
      if (obj === null || obj === undefined) return '(none)';
      if (typeof obj !== 'object') return escapeHtml(String(obj)); // field-level conflicts are plain values
      switch (containerKey) {
        case 'records': return escapeHtml(`${obj.title || obj.type || 'Record'} · ${obj.date || ''}`);
        case 'customReminders': return escapeHtml(`${obj.title || 'Reminder'} · due ${obj.dueDate || ''}`);
        case 'historyEntries': return escapeHtml(obj.text || '');
        case 'policies': return escapeHtml(`${obj.provider || ''} ${obj.number || ''} · ${insFmtMoney(obj.premium)}/${obj.frequency || ''}`);
        case 'ledger': return escapeHtml(`${obj.date || ''} · ${insFmtMoney(obj.amount)} (${obj.method || ''})`);
        case 'riders': return escapeHtml(`${obj.description || ''} · due ${obj.dueDate || ''}`);
        case 'coverages': return escapeHtml(`${obj.customLabel || obj.type || ''} · sum insured ${insFmtMoney(obj.sumInsured)}`);
        case 'sumInsuredHistory': return escapeHtml(`${obj.date || ''} · ${insFmtMoney(obj.amount)}`);
        case 'surrenderRecords': return escapeHtml(`${obj.date || ''} · ${insFmtMoney(insSurrenderRecordTotal(obj))}`);
        case 'claims': return escapeHtml(`${obj.date || ''} · ${obj.status || ''} · claimed ${insFmtMoney(obj.amountClaimed)}`);
        default: return escapeHtml(JSON.stringify(obj).slice(0, 120));
      }
    }

    function renderConflictModal() {
      const active = getActiveConflicts();
      const body = document.getElementById('conflictListBody');
      const btn = document.getElementById('btnConflicts');
      const countEl = document.getElementById('conflictCount');
      countEl.textContent = active.length;
      btn.style.display = active.length ? '' : 'none';

      if (!active.length) {
        body.innerHTML = '<p class="s-51f2817c">No pending conflicts.</p>';
        return;
      }

      body.innerHTML = active.map((c, i) => {
        const label = c.field
          ? (CONFLICT_FIELD_LABELS[c.field] || c.field)
          : (CONFLICT_CONTAINER_LABELS[c.path[c.path.length - 2]] || 'Item');
        const containerKey = c.field ? null : c.path[c.path.length - 2];
        const localSummary = summarizeConflictSide(containerKey, c.local);
        const remoteSummary = summarizeConflictSide(containerKey, c.remote);
        const allowBoth = !c.field; // "keep both" only makes sense for array-item entities, not a single scalar field
        return `
          <div class="s-198fb7f4" data-conflict-idx="${i}">
            <div class="s-ea8a0de7">${escapeHtml(c.memberName)} — ${escapeHtml(label)}</div>
            <div class="s-ebc463b1">Your version: ${localSummary}</div>
            <div class="s-ebc463b1">Their version: ${remoteSummary}</div>
            <div class="s-79744520">
              <button class="btn btn-secondary btn-sm" data-conflict-choice="local" data-conflict-idx="${i}">Keep Mine</button>
              <button class="btn btn-secondary btn-sm" data-conflict-choice="remote" data-conflict-idx="${i}">Keep Theirs</button>
              ${allowBoth ? `<button class="btn btn-secondary btn-sm" data-conflict-choice="both" data-conflict-idx="${i}">Keep Both</button>` : ''}
            </div>
          </div>
        `;
      }).join('');

      body.querySelectorAll('[data-conflict-choice]').forEach(el => {
        el.addEventListener('click', () => {
          const idx = parseInt(el.dataset.conflictIdx);
          const conflict = active[idx];
          resolveConflict(conflict, el.dataset.conflictChoice);
          renderConflictModal();
          renderMain(); // the resolved field/entity may be visible on the current tab
        });
      });
    }

    function openConflictModal() {
      renderConflictModal();
      document.getElementById('conflictModal').classList.add('active');
    }
    function updateConflictBadge() {
      const active = getActiveConflicts();
      document.getElementById('conflictCount').textContent = active.length;
      document.getElementById('btnConflicts').style.display = active.length ? '' : 'none';
    }

    // ========== EVENT BINDING ==========
    function bindEvents() {
      // Header buttons
      document.getElementById('btnConflicts').addEventListener('click', openConflictModal);
      document.getElementById('btnCloseConflicts').addEventListener('click', () => document.getElementById('conflictModal').classList.remove('active'));
      document.getElementById('btnExport').addEventListener('click', () => openExportOptionsModal('all'));
      document.getElementById('btnExportMember').addEventListener('click', () => openExportOptionsModal('member'));
      document.getElementById('btnImport').addEventListener('click', () => document.getElementById('importFile').click());
      document.getElementById('importFile').addEventListener('change', importData);
      document.getElementById('btnZip').addEventListener('click', () => openExportOptionsModal('zip'));
      document.getElementById('btnAddRecord').addEventListener('click', () => {
        if (viewMode === 'insurance') { insOpenPolicyModal(null); } else { openModal('record'); }
      });

      // Sidebar buttons
      document.getElementById('btnAddMember').addEventListener('click', () => openModal('member'));
      document.getElementById('btnSidebarToggle').addEventListener('click', () => toggleSidebar());
      document.getElementById('sidebarBackdrop').addEventListener('click', () => toggleSidebar(false));
      document.getElementById('btnReset').addEventListener('click', resetData);
      document.getElementById('btnCompact').addEventListener('click', compactThumbnails);

      // Modal buttons
      document.getElementById('btnCancelMember').addEventListener('click', () => closeModal('member'));
      document.getElementById('btnSaveMember').addEventListener('click', saveMember);
      document.getElementById('btnCancelRecord').addEventListener('click', () => closeModal('record'));
      document.getElementById('btnSaveRecord').addEventListener('click', saveRecord);
      document.getElementById('btnCancelReport').addEventListener('click', closeReportPreview);
      document.getElementById('btnPrintReport').addEventListener('click', printReportFromPreview);
      document.getElementById('btnCancelReminder').addEventListener('click', closeReminderModal);
      document.getElementById('btnSaveReminder').addEventListener('click', saveCustomReminder);

      // Record type change
      document.getElementById('rType').addEventListener('change', toggleVitals);

      // File input
      document.getElementById('fileDropArea').addEventListener('click', async () => { if (await ensureUnlocked()) document.getElementById('rAttachments').click(); });
      document.getElementById('rAttachments').addEventListener('change', handleAttachments);
      document.getElementById('bloodFileDropArea').addEventListener('click', () => document.getElementById('mBloodAttachment').click());
      document.getElementById('mBloodAttachment').addEventListener('change', handleBloodAttachment);
    }

    // Picks which character of the Chinese name to show as the sidebar
    // avatar letter, per the member's saved nameZhAvatarIdx (1/2/3).
    // Falls back gracefully if the name is shorter than the chosen index,
    // and falls back to the English name's first letter if no Chinese name.
    function getAvatarChar(m) {
      const zh = m.nameZh && m.nameZh.trim();
      if (!zh) return m.name[0];
      const idx = Math.min(Math.max(parseInt(m.nameZhAvatarIdx) || 1, 1), zh.length) - 1;
      return zh[idx];
    }

    // ========== MEMBER LIST ==========
    function renderMemberList() {
      updateStorageMeter();
      const list = document.getElementById('memberList');
      const liveMembers = live(members);
      if (liveMembers.length === 0) {
        list.innerHTML = '<div class="s-3d9b1e10">No members yet<br>Click below to add</div>';
        return;
      }
      list.innerHTML = liveMembers.map(m => {
        const age = m.birth ? Math.floor((new Date() - new Date(m.birth)) / 365.25 / 24 / 60 / 60 / 1000) : '?';
        return `
          <div class="member-item ${m.id === currentMemberId ? 'active' : ''}" data-id="${escapeHtml(m.id)}">
            <div class="member-avatar">${escapeHtml(getAvatarChar(m))}</div>
            <div class="member-info">
              <div class="member-name">${escapeHtml(m.name)}</div>
              ${m.nameZh ? `<div class="s-c16bedce">${escapeHtml(m.nameZh)}</div>` : ''}
              <div class="member-meta">${escapeHtml(m.gender)} &middot; ${age}y &middot; Type ${escapeHtml(m.blood)}</div>
            </div>
            <span class="member-delete" data-id="${escapeHtml(m.id)}" title="Delete member">&times;</span>
          </div>
        `;
      }).join('');

      // Bind click events to member items
      list.querySelectorAll('.member-item').forEach(item => {
        item.addEventListener('click', function(e) {
          if (e.target.classList.contains('member-delete')) return;
          selectMember(this.dataset.id);
        });
      });
      // Bind delete buttons
      list.querySelectorAll('.member-delete').forEach(btn => {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          deleteMember(this.dataset.id);
        });
      });
    }

    function selectMember(id) {
      const wasOverview = currentMemberId === null; // only a real forward step if we're leaving the overview/welcome page - switching between two already-selected members doesn't add another level to unwind
      currentMemberId = id;
      currentTab = 'overview';
      renderMemberList();
      renderMain();
      closeSidebarOnMobile();
      if (wasOverview) pushNavStep(); // so Back returns here to the overview instead of exiting the app
    }

    // ========== SIDEBAR TOGGLE (mobile) ==========
    function toggleSidebar(forceOpen) {
      const sidebar = document.getElementById('sidebarPanel');
      const backdrop = document.getElementById('sidebarBackdrop');
      const open = typeof forceOpen === 'boolean' ? forceOpen : !sidebar.classList.contains('open');
      sidebar.classList.toggle('open', open);
      backdrop.classList.toggle('open', open);
    }

    function closeSidebarOnMobile() {
      if (window.innerWidth <= 768) { toggleSidebar(false); return; }
      // Tablet rail (touch, wider than phone): also collapse back to the
      // avatar-only rail after picking a member. Desktops/laptops (mouse,
      // hover:hover) never match this, so PC behavior is untouched.
      if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) toggleSidebar(false);
    }

    // ========== MAIN CONTENT ==========
    function renderMain() {
      const m = members.find(x => x.id === currentMemberId);
      const main = document.getElementById('mainContent');

      if (!m) {
        main.innerHTML = `
          <div class="empty-state">
            <div class="s-441dff46">👨‍👩‍👧‍👦</div>
            <h2 class="s-dbb46795">Welcome to Family Health & Shield</h2>
            <p class="s-d3277930">Select a family member from the left sidebar to view their health records</p>
          </div>
        `;
        return;
      }

      const age = m.birth ? Math.floor((new Date() - new Date(m.birth)) / 365.25 / 24 / 60 / 60 / 1000) : '?';
      const latestVitals = getLatestVitals(m);
      const bmi = calcBmi(m.height, latestVitals.weight);

      const bpRecords = live(m.records).filter(r => r.vitals?.systolic).sort((a,b) => new Date(a.date) - new Date(b.date));
      const chartHtml = bpRecords.length > 1 ? renderBPChart(bpRecords) : '<p class="s-b9373de3">Record more BP data to see trends</p>';

      const reminders = generateReminders(m);
      insEnsureData(m);

      main.innerHTML = `
        <div class="s-a251dbd6">
          <div class="s-f18fd9a2">${escapeHtml(m.name[0])}</div>
          <div>
            <h2 class="s-738e228b">${escapeHtml(m.name)}${m.nameZh ? ' <span class="s-5ea608c5">' + escapeHtml(m.nameZh) + '</span>' : ''} <span class="s-605d40a3">${escapeHtml(m.gender)} &middot; ${age}y</span></h2>
            <div class="s-da0fa578">
              <span class="tag tag-green s-58aba575" ${m.bloodTypeAttachment ? `id="btnViewBloodAttachment" title="View attached blood type test report"` : ''}>Type ${escapeHtml(m.blood)}${m.bloodTypeAttachment ? ' 📎' : ''}</span>
              ${m.allergies !== 'None' && m.allergies ? `<span class="tag tag-red">⚠️ Allergy: ${escapeHtml(m.allergies)}</span>` : ''}
              ${bmi !== '--' ? `<span class="tag tag-yellow">BMI ${bmi}</span>` : ''}
            </div>
          </div>
          <div class="s-0cc925bc">
            <button class="btn btn-secondary btn-sm" id="btnEditMember">✏️ Edit Info</button>
            <button class="btn btn-danger btn-sm" id="btnEmergency">🚨 Emergency Card</button>
          </div>
        </div>

        <div class="mode-switch">
          <button class="mode-btn ${viewMode === 'health' ? 'active' : ''}" data-mode="health">🏥 Health</button>
          <button class="mode-btn ${viewMode === 'insurance' ? 'active' : ''}" data-mode="insurance">🛡️ Insurance</button>
        </div>

        ${viewMode === 'health' ? `
          <div class="tabs">
            <button class="tab ${currentTab === 'overview' ? 'active' : ''}" data-tab="overview">📊 Overview</button>
            <button class="tab ${currentTab === 'records' ? 'active' : ''}" data-tab="records">📋 Records</button>
            <button class="tab ${currentTab === 'charts' ? 'active' : ''}" data-tab="charts">📈 Trends</button>
            <button class="tab ${currentTab === 'reminders' ? 'active' : ''}" data-tab="reminders">⏰ Reminders</button>
          </div>
          ${currentTab === 'overview' ? renderOverview(m, latestVitals, bmi, reminders) : ''}
          ${currentTab === 'records' ? renderRecords(m) : ''}
          ${currentTab === 'charts' ? renderCharts(bpRecords, m, chartHtml) : ''}
          ${currentTab === 'reminders' ? renderReminders(reminders, m.id) : ''}
        ` : insRenderInsuranceTab(m)}
      `;

      // Bind mode-switch clicks (Health / Insurance)
      main.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', function() {
          viewMode = this.dataset.mode;
          renderMain();
        });
      });

      // Header "+ Add Record" button adapts to the selected mode
      const btnAddRecordLabel = document.getElementById('btnAddRecord');
      if (btnAddRecordLabel) btnAddRecordLabel.textContent = viewMode === 'insurance' ? '+ Add Policy' : '+ Add Record';

      // Bind tab clicks
      main.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', function() {
          switchTab(this.dataset.tab);
        });
      });

      // Bind emergency button
      const btnEmergency = document.getElementById('btnEmergency');
      if (btnEmergency) {
        btnEmergency.addEventListener('click', () => printEmergency(m.id));
      }

      // Bind edit-member button
      const btnEditMember = document.getElementById('btnEditMember');
      if (btnEditMember) {
        btnEditMember.addEventListener('click', () => openModal('member', m.id));
      }

      // Bind blood type test report viewer
      const btnViewBloodAttachment = document.getElementById('btnViewBloodAttachment');
      if (btnViewBloodAttachment) {
        btnViewBloodAttachment.addEventListener('click', () => openAttachment(m.bloodTypeAttachment));
      }
      const btnViewBloodAttachment2 = document.getElementById('btnViewBloodAttachment2');
      if (btnViewBloodAttachment2) {
        btnViewBloodAttachment2.addEventListener('click', () => openAttachment(m.bloodTypeAttachment));
      }

      // Bind per-record edit/delete buttons (present when Records tab is active)
      main.querySelectorAll('[data-edit-record]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openModal('record', null, btn.dataset.editRecord);
        });
      });
      main.querySelectorAll('[data-delete-record]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteRecord(btn.dataset.deleteRecord);
        });
      });

      // Bind custom reminder actions (present when Reminders tab is active)
      main.querySelectorAll('[data-done-reminder]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          markReminderDone(btn.dataset.doneReminder);
        });
      });
      main.querySelectorAll('[data-edit-reminder]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openReminderModal(currentMemberId, btn.dataset.editReminder);
        });
      });
      main.querySelectorAll('[data-delete-reminder]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteCustomReminder(btn.dataset.deleteReminder);
        });
      });

      // Bind attachment click-to-open
      main.querySelectorAll('.attachment-item[data-record-id]').forEach(item => {
        item.addEventListener('click', () => {
          const memberObj = members.find(x => x.id === currentMemberId);
          const record = memberObj?.records.find(x => x.id === item.dataset.recordId);
          const att = record ? live(record.attachments || [])[parseInt(item.dataset.attIdx)] : null;
          openAttachment(att);
        });
      });

      // Bind Insurance module interactions (no-op if Insurance tab isn't active)
      insBindAll();
    }

    function renderOverview(m, latestVitals, bmi, reminders) {
      return `
        <div class="card">
          <div class="card-title">📋 Basic Info</div>
          <div class="info-grid">
            <div class="info-item"><div class="info-label">Height</div><div class="info-value">${m.height || '--'} cm</div></div>
            <div class="info-item"><div class="info-label">Weight</div><div class="info-value">${latestVitals.weight || '--'} kg</div></div>
            <div class="info-item"><div class="info-label">Blood Type</div><div class="info-value">${escapeHtml(m.blood)}${m.bloodTypeAttachment ? ` <span id="btnViewBloodAttachment2" title="View attached blood type test report" class="s-af9923da">📎 view</span>` : ''}</div></div>
            <div class="info-item"><div class="info-label">BMI</div><div class="info-value">${bmi}</div></div>
            <div class="info-item"><div class="info-label">Birth Date</div><div class="info-value">${escapeHtml(m.birth) || '--'}</div></div>
            <div class="info-item"><div class="info-label">Emergency</div><div class="info-value">${escapeHtml(m.emergency) || '--'}</div></div>
          </div>
          <div class="s-72724f51">
            <div class="info-label">Medical History</div>
            <div class="s-828bc405">${escapeHtml(m.history) || 'No records'}</div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">📊 Latest Vitals</div>
          <div class="stats-grid">
            <div class="stat-box">
              <div class="stat-value">${latestVitals.systolic || '--'}/${latestVitals.diastolic || '--'}</div>
              <div class="stat-label">BP mmHg</div>
            </div>
            <div class="stat-box">
              <div class="stat-value">${latestVitals.heartRate || '--'}</div>
              <div class="stat-label">HR bpm</div>
            </div>
            <div class="stat-box">
              <div class="stat-value">${latestVitals.glucose || '--'}</div>
              <div class="stat-label">Glucose mmol/L</div>
            </div>
            <div class="stat-box">
              <div class="stat-value">${latestVitals.temp || '--'}</div>
              <div class="stat-label">Temp °C</div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">⏰ Upcoming Reminders</div>
          <div class="reminder-list">
            ${reminders.slice(0,3).map(r => `
              <div class="reminder-item">
                <div class="reminder-icon ${r.status}">${r.icon}</div>
                <div class="reminder-text">
                  <div class="reminder-title">${r.title}</div>
                  <div class="reminder-date">${r.date}</div>
                </div>
              </div>
            `).join('') || '<p class="s-9155c939">No reminders</p>'}
          </div>
        </div>

        <div class="card">
          <div class="card-title">📄 Reports</div>
          <div class="s-7137c2f6">
            <button class="btn btn-secondary btn-sm" data-report-type="summary" data-report-member="${escapeHtml(m.id)}">📋 Health Summary</button>
            <button class="btn btn-secondary btn-sm" data-report-type="vaccine" data-report-member="${escapeHtml(m.id)}">💉 Vaccine Record</button>
            <button class="btn btn-secondary btn-sm" data-report-type="medication" data-report-member="${escapeHtml(m.id)}">💊 Medication List</button>
            <button class="btn btn-secondary btn-sm" data-report-type="lab" data-report-member="${escapeHtml(m.id)}">🔬 Lab Results</button>
            <button class="btn btn-secondary btn-sm" data-report-type="bp" data-report-member="${escapeHtml(m.id)}">🩺 BP Log</button>
            <button class="btn btn-secondary btn-sm" data-report-type="growth" data-report-member="${escapeHtml(m.id)}">📏 Growth Chart</button>
            <button class="btn btn-secondary btn-sm" data-report-type="annual" data-report-member="${escapeHtml(m.id)}">📅 Annual Report</button>
          </div>
        </div>
      `;
    }

    function renderRecords(m) {
      return `
        <div class="card">
          <div class="card-title">📋 Health Records (${live(m.records).length})</div>
          <div class="timeline">
            ${recordsByDateDesc(m).map(r => {
              const color = r.type === 'Hospitalization' ? 'purple' : r.type === 'Illness' ? 'red' : r.type === 'Vaccine' ? 'green' : r.type === 'Medication' ? 'yellow' : 'primary';
              const icon = { 'Checkup':'🏥','Vaccine':'💉','Illness':'🤒','Hospitalization':'🚑','Medication':'💊','Lab Test':'🔬','Monitoring':'📊' }[r.type] || '📋';
              const liveAtts = live(r.attachments || []);
              const attachmentsHtml = liveAtts.length ? `
                <div class="attachment-list s-d79ce2bc">
                  ${liveAtts.map((att, idx) => renderAttachmentItem(att, r.id, idx)).join('')}
                </div>
              ` : '';
              return `
                <div class="timeline-item">
                  <div class="timeline-dot ${color}"></div>
                  <div class="timeline-content">
                    <div class="s-140c3f9b">
                      <div class="timeline-date">${escapeHtml(r.date)} &middot; ${icon} ${escapeHtml(r.type)}</div>
                      <div class="s-ef34e083">
                        <span class="member-delete s-19e87f8e" data-edit-record="${escapeHtml(r.id)}" title="Edit record">✏️</span>
                        <span class="member-delete s-19e87f8e" data-delete-record="${escapeHtml(r.id)}" title="Delete record">&times;</span>
                      </div>
                    </div>
                    <div class="timeline-title">${escapeHtml(r.title)}</div>
                    ${r.details ? `<div class="timeline-desc">${escapeHtml(r.details)}</div>` : ''}
                    ${r.vitals?.systolic ? `<div class="timeline-desc">🩺 BP ${r.vitals.systolic}/${r.vitals.diastolic} &middot; HR ${r.vitals.heartRate || '--'}</div>` : ''}
                    <div class="timeline-tags">
                      ${(r.tags || []).map(t => `<span class="tag tag-green">${escapeHtml(t)}</span>`).join('')}
                    </div>
                    ${attachmentsHtml}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }

    function renderAttachmentItem(att, recordId, idx) {
      const isImage = att.type === 'image';
      const icon = isImage ? '🖼️' : '📄';
      const thumbSrc = att.thumb || att.data; // .thumb/.data cover both new IDB-backed and legacy inline attachments
      const isEmbedded = !!(att.data || att.id);
      const sizeLabel = isEmbedded ? formatBytes(att.size || 0) : 'Not embedded - path only';
      return `
        <div class="attachment-item" data-record-id="${escapeHtml(recordId)}" data-att-idx="${idx}">
          <div class="attachment-thumb">
            ${isImage && thumbSrc ? `<img src="${thumbSrc}" alt="">` : `<span>${icon}</span>`}
          </div>
          <div class="attachment-info">
            <div class="attachment-name">${escapeHtml(att.name)}</div>
            <div class="attachment-path">${sizeLabel}</div>
          </div>
        </div>
      `;
    }

    function renderCharts(bpRecords, m, chartHtml) {
      return `
        <div class="card">
          <div class="card-title">📈 Blood Pressure Trend</div>
          <div class="chart-container">${chartHtml}</div>
        </div>
        <div class="card">
          <div class="card-title">📈 Weight / BMI Trend</div>
          <div class="chart-container">${renderWeightChart(m)}</div>
        </div>
      `;
    }

    function renderReminders(reminders, memberId) {
      return `
        <div class="card">
          <div class="s-2447f692">
            <div class="card-title s-a2d48c76">⏰ All Reminders</div>
            <button class="btn btn-primary btn-sm" data-open-reminder-modal="${memberId}">+ Add Reminder</button>
          </div>
          <div class="reminder-list s-78f6f2c9">
            ${reminders.map(r => `
              <div class="reminder-item">
                <div class="reminder-icon ${r.status}">${r.icon}</div>
                <div class="reminder-text">
                  <div class="reminder-title">${r.title}</div>
                  <div class="reminder-date">${r.date}</div>
                </div>
                <span class="tag ${r.status === 'overdue' ? 'tag-red' : r.status === 'upcoming' ? 'tag-yellow' : 'tag-green'}">${r.statusText}</span>
                ${r.isCustom ? `
                  <span class="member-delete s-19e87f8e" data-done-reminder="${escapeHtml(r.id)}" title="Mark done">✔️</span>
                  <span class="member-delete s-19e87f8e" data-edit-reminder="${escapeHtml(r.id)}" title="Edit">✏️</span>
                  <span class="member-delete s-19e87f8e" data-delete-reminder="${escapeHtml(r.id)}" title="Delete">&times;</span>
                ` : ''}
              </div>
            `).join('') || '<p class="s-9155c939">No reminders</p>'}
          </div>
        </div>
      `;
    }

    // ========== ATTACHMENTS ==========
    // Resizes an image to a reasonable max dimension and re-encodes as JPEG.
    // This becomes the "full" version stored in IndexedDB (viewable/printable quality).
    function readImageResized(file, maxDim = 1280, quality = 0.78) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = ev => {
          const img = new Image();
          img.onload = () => {
            let { width, height } = img;
            if (width > maxDim || height > maxDim) {
              const scale = maxDim / Math.max(width, height);
              width = Math.round(width * scale);
              height = Math.round(height * scale);
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', quality));
          };
          img.onerror = () => resolve(ev.target.result); // fallback: keep original if it can't be decoded
          img.src = ev.target.result;
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
    }

    // Small, cheap preview thumbnail kept inline in localStorage so lists render
    // instantly without an IndexedDB round-trip for every attachment shown.
    function readImageThumb(file, maxDim = 96, quality = 0.5) {
      return readImageResized(file, maxDim, quality);
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = ev => resolve(ev.target.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
    }

    async function handleAttachments(e) {
      const files = Array.from(e.target.files);
      const memberName = members.find(x => x.id === currentMemberId)?.name || 'Uncategorized';

      for (const file of files) {
        const isImage = file.type.startsWith('image/');
        const isPdf = file.type === 'application/pdf';
        if (!isImage && !isPdf) continue;

        // PDFs can't be shrunk like images - warn before embedding a large one.
        if (isPdf && file.size > 8 * 1024 * 1024) {
          const mb = (file.size / 1024 / 1024).toFixed(1);
          if (!confirm(`"${file.name}" is ${mb}MB. Large PDFs take longer to store. Add it anyway?`)) continue;
        }

        const safeName = file.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const relativePath = `${ATTACHMENTS_FOLDER}/${memberName}/${safeName}`;
        const data = isImage ? await readImageResized(file) : await readFileAsDataUrl(file);
        if (!data) {
          alert(`Couldn't read "${file.name}" - it wasn't added.`);
          continue;
        }
        const thumb = isImage ? await readImageThumb(file) : null;

        tempAttachments.push({
          name: file.name,
          path: relativePath,
          type: isImage ? 'image' : 'pdf',
          data,
          thumb,
          size: data.length
        });
        renderAttachmentPreview();
      }

      e.target.value = '';
    }

    function renderAttachmentPreview() {
      const preview = document.getElementById('attachmentPreview');
      preview.innerHTML = tempAttachments.map((att, idx) => {
        const previewSrc = att.thumb || att.data;
        return `
        <div class="attachment-item">
          <div class="attachment-thumb">
            ${att.type === 'image' && previewSrc ? `<img src="${previewSrc}" alt="">` : `<span>${att.type === 'image' ? '🖼️' : '📄'}</span>`}
          </div>
          <div class="attachment-info">
            <div class="attachment-name">${escapeHtml(att.name)}</div>
            <div class="attachment-path">${att.size ? formatBytes(att.size) : ''}</div>
          </div>
          <span class="attachment-remove" data-idx="${idx}">Remove</span>
        </div>
      `;
      }).join('');

      preview.querySelectorAll('.attachment-remove').forEach(btn => {
        btn.addEventListener('click', function() {
          removeTempAttachment(parseInt(this.dataset.idx));
        });
      });
    }

    function formatBytes(n) {
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    }

    function removeTempAttachment(idx) {
      tempAttachments.splice(idx, 1);
      renderAttachmentPreview();
    }

    // Object URLs created by openAttachment() for the currently-open
    // attachment (the download-button blob, plus any image-preview blob) -
    // revoked in closeOverlay() when the modal closes. Tracked in an array
    // rather than re-queried from the DOM because the PDF branch no longer
    // puts a blob URL on any element (pdf.js renders bytes straight to
    // <canvas>), so there's nothing left in the DOM to query for it.
    let attachmentViewerObjectUrls = [];

    function dataUrlToBlob(dataUrl) {
      const [header, base64] = dataUrl.split(',');
      const mime = (header.match(/:(.*?);/) || [,'application/octet-stream'])[1];
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }

    async function openAttachment(att) {
      if (!att) return;
      if (!(await ensureUnlocked())) return;
      let dataUrl;
      try {
        dataUrl = await resolveAttachmentData(att);
      } catch (err) {
        alert('Could not load this attachment: ' + err.message);
        return;
      }
      if (!dataUrl) {
        alert(`"${att.name}" was saved before file embedding was added, so the app doesn't have its contents stored - only this reference path:\n\n${att.path}\n\nTo fix this, remove and re-add the attachment on this record.`);
        return;
      }
      try {
        const blob = dataUrlToBlob(dataUrl);
        const url = URL.createObjectURL(blob);
        attachmentViewerObjectUrls.push(url); // always revoked on close, whether or not it ends up displayed
        const isPdf = blob.type === 'application/pdf' || /\.pdf$/i.test(att.name || '');
        const body = document.getElementById('attachmentViewerBody');
        body.innerHTML = '';
        if (isPdf) {
          // Deliberately NOT an <iframe src="blob:...">: that hands the PDF to
          // the browser/OS's own PDF plugin, which is inconsistent across
          // platforms (e.g. Chrome on Android can render it blank even though
          // the identical blob opens fine in Chrome's full-screen viewer, while
          // desktop/iOS Safari are usually fine - there's no reliable way to
          // feature-detect which behavior you'll get). Instead, pdf.js decodes
          // the PDF in JS and renders each page onto its own <canvas>, so the
          // result is identical on every platform and doesn't depend on
          // whatever PDF handling the device happens to have. Also means PDF
          // JavaScript/embedded actions are never executed - pdf.js only reads
          // page content, it doesn't run scripts in the file.
          body.innerHTML = '<div class="s-db2a3573">Loading PDF…</div>';
          try {
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const pdfjsLib = await pdfjsLibPromise;
            // isEvalSupported: false - belt-and-suspenders on top of the fact
            // that we only call getPage()/render() here (no AcroForm/embedded
            // JS execution path is ever invoked): explicitly tells pdf.js not
            // to use eval()/new Function() for any internal optimization, so
            // a malicious PDF can't get script execution out of the parser
            // even via a future pdf.js regression of the kind fixed in
            // CVE-2026-16633. Harmless for rendering - eval is only ever used
            // there as a speed optimization, never a required code path.
            const pdf = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
            body.innerHTML = '';
            const containerWidth = body.clientWidth || 700;
            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
              const page = await pdf.getPage(pageNum);
              const unscaledViewport = page.getViewport({ scale: 1 });
              const scale = Math.max(0.1, (containerWidth - 20) / unscaledViewport.width);
              const viewport = page.getViewport({ scale });
              const canvas = document.createElement('canvas');
              canvas.width = viewport.width;
              canvas.height = viewport.height;
              // Individual property assignments here (not .style.cssText, which -- like a
              // literal style="..." attribute -- needs style-src 'unsafe-inline'; setting
              // each CSSOM property one at a time doesn't).
              canvas.style.display = 'block';
              canvas.style.maxWidth = '100%';
              canvas.style.margin = '0 auto 12px';
              canvas.style.boxShadow = '0 1px 4px rgba(0,0,0,0.15)';
              body.appendChild(canvas);
              await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            }
          } catch (pdfErr) {
            body.innerHTML = '<div class="s-61908f99">Could not preview this PDF: ' + escapeHtml(pdfErr.message) + '<br><br>Use "Download" below to save it and open it another way.</div>';
          }
        } else {
          const img = document.createElement('img');
          img.src = url;
          img.style.maxWidth = '100%';
          img.style.maxHeight = '70vh';
          img.style.display = 'block';
          body.appendChild(img);
        }
        document.getElementById('attachmentViewerTitle').textContent = att.name || 'Attachment';
        const dl = document.getElementById('btnDownloadAttachment');
        dl.href = url;
        dl.download = att.name || 'attachment';
        const modal = document.getElementById('attachmentViewerModal');
        modal.classList.add('active');
        // Revoking the blob URL(s) is handled centrally in closeOverlay() so it
        // still happens when closed via the [X] icon or the Esc key, not
        // just this button.
        document.getElementById('btnCloseAttachmentViewer').onclick = () => closeOverlay(modal);
      } catch (err) {
        alert('Could not open this attachment: ' + err.message);
      }
    }

    // Single-file attachment for a member's blood type test report (proof of blood type).
    async function handleBloodAttachment(e) {
      const file = e.target.files[0];
      if (!file) return;
      const isImage = file.type.startsWith('image/');
      const isPdf = file.type === 'application/pdf';
      if (!isImage && !isPdf) {
        alert('Please select an image or PDF file.');
        e.target.value = '';
        return;
      }
      if (isPdf && file.size > 5 * 1024 * 1024) {
        const mb = (file.size / 1024 / 1024).toFixed(1);
        if (!confirm(`"${file.name}" is ${mb}MB. Embedding large files can fill up browser storage quickly. Add it anyway?`)) {
          e.target.value = '';
          return;
        }
      }
      const data = isImage ? await readImageResized(file) : await readFileAsDataUrl(file);
      if (!data) {
        alert(`Couldn't read "${file.name}" - it wasn't attached.`);
        e.target.value = '';
        return;
      }
      const thumb = isImage ? await readImageThumb(file) : null;
      tempBloodAttachment = { name: file.name, type: isImage ? 'image' : 'pdf', data, thumb, size: data.length };
      renderBloodAttachmentPreview();
      e.target.value = '';
    }

    function renderBloodAttachmentPreview() {
      const preview = document.getElementById('bloodAttachmentPreview');
      if (!tempBloodAttachment) { preview.innerHTML = ''; return; }
      const att = tempBloodAttachment;
      const previewSrc = att.thumb || att.data;
      preview.innerHTML = `
        <div class="attachment-item">
          <div class="attachment-thumb">
            ${att.type === 'image' && previewSrc ? `<img src="${previewSrc}" alt="">` : `<span>📄</span>`}
          </div>
          <div class="attachment-info">
            <div class="attachment-name">${escapeHtml(att.name)}</div>
            <div class="attachment-path">${att.size ? formatBytes(att.size) : ''}</div>
          </div>
          <span class="attachment-remove" id="btnRemoveBloodAttachment">Remove</span>
        </div>
      `;
      document.getElementById('btnRemoveBloodAttachment').addEventListener('click', () => {
        tempBloodAttachment = null;
        renderBloodAttachmentPreview();
      });
    }

    // ========== CHARTS ==========
    function renderBPChart(records) {
      const w = 600, h = 200, pad = 40;
      const maxVal = Math.max(...records.map(r => r.vitals.systolic), 160);
      const minVal = Math.min(...records.map(r => r.vitals.diastolic), 60);
      const range = maxVal - minVal + 20;
      const xStep = (w - pad * 2) / Math.max(records.length - 1, 1);

      const sysPoints = records.map((r, i) => {
        const x = pad + i * xStep;
        const y = h - pad - ((r.vitals.systolic - minVal + 10) / range) * (h - pad * 2);
        return `${x},${y}`;
      }).join(' ');

      const diaPoints = records.map((r, i) => {
        const x = pad + i * xStep;
        const y = h - pad - ((r.vitals.diastolic - minVal + 10) / range) * (h - pad * 2);
        return `${x},${y}`;
      }).join(' ');

      const labels = records.map((r, i) => {
        const x = pad + i * xStep;
        return `<text x="${x}" y="${h-10}" text-anchor="middle" font-size="10" fill="#6b7280">${r.date.slice(5)}</text>`;
      }).join('');

      return `<svg class="chart-svg" viewBox="0 0 ${w} ${h}">
        <line x1="${pad}" y1="${h-pad}" x2="${w-pad}" y2="${h-pad}" stroke="#e5e7eb" stroke-width="1"/>
        <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h-pad}" stroke="#e5e7eb" stroke-width="1"/>
        <polyline points="${sysPoints}" fill="none" stroke="#ef4444" stroke-width="2"/>
        <polyline points="${diaPoints}" fill="none" stroke="#0d9488" stroke-width="2"/>
        ${records.map((r, i) => {
          const x = pad + i * xStep;
          const y1 = h - pad - ((r.vitals.systolic - minVal + 10) / range) * (h - pad * 2);
          const y2 = h - pad - ((r.vitals.diastolic - minVal + 10) / range) * (h - pad * 2);
          return `<circle cx="${x}" cy="${y1}" r="4" fill="#ef4444"/><circle cx="${x}" cy="${y2}" r="4" fill="#0d9488"/>`;
        }).join('')}
        ${labels}
        <text x="${w-30}" y="20" font-size="11" fill="#ef4444">● Systolic</text>
        <text x="${w-30}" y="36" font-size="11" fill="#0d9488">● Diastolic</text>
      </svg>`;
    }

    function renderWeightChart(m) {
      const weightRecords = live(m.records).filter(r => r.vitals?.weight).sort((a,b) => new Date(a.date) - new Date(b.date));
      if (weightRecords.length < 2) return '<p class="s-b9373de3">Record more weight data to see trends</p>';

      const w = 600, h = 200, pad = 40;
      const weights = weightRecords.map(r => r.vitals.weight);
      const maxW = Math.max(...weights) + 5;
      const minW = Math.min(...weights) - 5;
      const range = maxW - minW;
      const xStep = (w - pad * 2) / Math.max(weightRecords.length - 1, 1);

      const points = weightRecords.map((r, i) => {
        const x = pad + i * xStep;
        const y = h - pad - ((r.vitals.weight - minW) / range) * (h - pad * 2);
        return `${x},${y}`;
      }).join(' ');

      return `<svg class="chart-svg" viewBox="0 0 ${w} ${h}">
        <line x1="${pad}" y1="${h-pad}" x2="${w-pad}" y2="${h-pad}" stroke="#e5e7eb" stroke-width="1"/>
        <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h-pad}" stroke="#e5e7eb" stroke-width="1"/>
        <polyline points="${points}" fill="none" stroke="#0d9488" stroke-width="2"/>
        ${weightRecords.map((r, i) => {
          const x = pad + i * xStep;
          const y = h - pad - ((r.vitals.weight - minW) / range) * (h - pad * 2);
          return `<circle cx="${x}" cy="${y}" r="4" fill="#0d9488"/><text x="${x}" y="${y-10}" text-anchor="middle" font-size="10" fill="#0d9488">${r.vitals.weight}</text>`;
        }).join('')}
        ${weightRecords.map((r, i) => `<text x="${pad + i * xStep}" y="${h-10}" text-anchor="middle" font-size="10" fill="#6b7280">${r.date.slice(5)}</text>`).join('')}
      </svg>`;
    }

    // ========== REMINDERS ==========
    function generateReminders(m) {
      const reminders = [];
      const today = new Date();

      const lastExam = live(m.records).filter(r => r.type === 'Checkup').sort((a,b) => new Date(b.date) - new Date(a.date))[0];
      if (lastExam) {
        const examDate = new Date(lastExam.date);
        const nextExam = new Date(examDate); nextExam.setFullYear(nextExam.getFullYear() + 1);
        const daysDiff = Math.floor((nextExam - today) / 86400000);
        reminders.push({
          title: 'Annual Physical',
          date: `Recommended by ${localDateStr(nextExam)}`,
          status: daysDiff < 0 ? 'overdue' : daysDiff < 30 ? 'upcoming' : 'ok',
          statusText: daysDiff < 0 ? 'Overdue' : daysDiff < 30 ? 'Due Soon' : 'OK',
          icon: '🏥'
        });
      }

      const lastFlu = live(m.records).filter(r => r.type === 'Vaccine' && r.title.includes('Flu')).sort((a,b) => new Date(b.date) - new Date(a.date))[0];
      if (lastFlu) {
        const fluDate = new Date(lastFlu.date);
        const nextFlu = new Date(fluDate); nextFlu.setFullYear(nextFlu.getFullYear() + 1);
        const daysDiff = Math.floor((nextFlu - today) / 86400000);
        reminders.push({
          title: 'Flu Vaccine',
          date: `Recommended by ${localDateStr(nextFlu)}`,
          status: daysDiff < 0 ? 'overdue' : daysDiff < 60 ? 'upcoming' : 'ok',
          statusText: daysDiff < 0 ? 'Overdue' : daysDiff < 60 ? 'Due Soon' : 'OK',
          icon: '💉'
        });
      }

      if (m.history.includes('Hypertension')) {
        const lastBP = live(m.records).filter(r => r.vitals?.systolic).sort((a,b) => new Date(b.date) - new Date(a.date))[0];
        if (lastBP) {
          const bpDate = new Date(lastBP.date);
          const daysSince = Math.floor((today - bpDate) / 86400000);
          reminders.push({
            title: 'BP Monitoring',
            date: `Last measured ${lastBP.date} (${daysSince} days ago)`,
            status: daysSince > 7 ? 'overdue' : daysSince > 3 ? 'upcoming' : 'ok',
            statusText: daysSince > 7 ? 'Check Now' : daysSince > 3 ? 'Recent' : 'OK',
            icon: '🩺'
          });
        }
      }

      live(m.customReminders || []).forEach(cr => {
        const dueDate = new Date(cr.dueDate);
        const daysDiff = Math.floor((dueDate - today) / 86400000);
        reminders.push({
          id: cr.id,
          isCustom: true,
          title: escapeHtml(cr.title),
          date: `Due ${cr.dueDate}${cr.repeatMonths ? ` &middot; repeats every ${cr.repeatMonths % 12 === 0 ? (cr.repeatMonths / 12) + 'y' : cr.repeatMonths + 'mo'}` : ''}${cr.notes ? ` &middot; ${escapeHtml(cr.notes)}` : ''}`,
          status: daysDiff < 0 ? 'overdue' : daysDiff < 30 ? 'upcoming' : 'ok',
          statusText: daysDiff < 0 ? 'Overdue' : daysDiff < 30 ? 'Due Soon' : 'OK',
          icon: '🔔'
        });
      });

      return reminders.sort((a,b) => {
        const order = { overdue: 0, upcoming: 1, ok: 2 };
        return order[a.status] - order[b.status];
      });
    }

    // ========== CUSTOM REMINDERS ==========
    function openReminderModal(memberId, editId) {
      currentMemberId = memberId;
      editingReminderId = editId || null;
      const m = members.find(x => x.id === memberId);
      const header = document.getElementById('reminderModalTitle');
      const saveBtn = document.getElementById('btnSaveReminder');

      if (editingReminderId) {
        const cr = (m.customReminders || []).find(x => x.id === editingReminderId);
        header.textContent = 'Edit Reminder';
        saveBtn.textContent = 'Save Changes';
        document.getElementById('cReminderTitle').value = cr.title || '';
        document.getElementById('cReminderDate').value = cr.dueDate || '';
        document.getElementById('cReminderRepeat').value = String(cr.repeatMonths || 0);
        document.getElementById('cReminderNotes').value = cr.notes || '';
      } else {
        header.textContent = 'Add Reminder';
        saveBtn.textContent = 'Save';
        document.getElementById('cReminderTitle').value = '';
        document.getElementById('cReminderDate').value = new Date().toISOString().slice(0, 10);
        document.getElementById('cReminderRepeat').value = '0';
        document.getElementById('cReminderNotes').value = '';
      }
      document.getElementById('reminderModal').classList.add('active');
    }

    function closeReminderModal() {
      document.getElementById('reminderModal').classList.remove('active');
      editingReminderId = null;
    }

    function saveCustomReminder() {
      const title = document.getElementById('cReminderTitle').value.trim();
      const dueDate = document.getElementById('cReminderDate').value;
      if (!title) return alert('Please enter a title for the reminder');
      if (!dueDate) return alert('Please pick a due date');

      const reminder = {
        id: editingReminderId || ('cr' + Date.now()),
        title,
        dueDate,
        repeatMonths: parseInt(document.getElementById('cReminderRepeat').value) || 0,
        notes: document.getElementById('cReminderNotes').value.trim()
      };

      const m = members.find(x => x.id === currentMemberId);
      if (!m.customReminders) m.customReminders = [];
      const previousReminders = [...m.customReminders];
      const idx = m.customReminders.findIndex(x => x.id === reminder.id);
      if (idx > -1) {
        const prior = m.customReminders[idx];
        reminder.version = prior.version;
        reminder.deletedAt = prior.deletedAt;
        reminder.schemaVersion = prior.schemaVersion || SYNC_SCHEMA_VERSION;
        bumpVersion(reminder);
        m.customReminders[idx] = reminder;
      } else {
        Object.assign(reminder, freshSyncMeta());
        m.customReminders.push(reminder);
      }

      if (!saveData()) { m.customReminders = previousReminders; return; }
      closeReminderModal();
      renderMain();
    }

    function deleteCustomReminder(id) {
      const m = members.find(x => x.id === currentMemberId);
      if (!m) return;
      if (!confirm('Delete this reminder?')) return;
      const previousReminders = [...(m.customReminders || [])];
      const cr = (m.customReminders || []).find(x => x.id === id);
      const priorMeta = cr ? { deletedAt: cr.deletedAt, version: cr.version, updatedAt: cr.updatedAt } : null;
      if (cr) tombstone(cr);
      if (!saveData()) { m.customReminders = previousReminders; if (cr) Object.assign(cr, priorMeta); return; }
      renderMain();
    }

    // Marks a reminder done: one-time reminders are removed, repeating ones roll forward to their next due date.
    function markReminderDone(id) {
      const m = members.find(x => x.id === currentMemberId);
      if (!m) return;
      const cr = (m.customReminders || []).find(x => x.id === id);
      if (!cr) return;
      const previousReminders = [...m.customReminders];
      const priorMeta = { dueDate: cr.dueDate, deletedAt: cr.deletedAt, version: cr.version, updatedAt: cr.updatedAt };

      if (cr.repeatMonths > 0) {
        const next = new Date();
        next.setMonth(next.getMonth() + cr.repeatMonths);
        cr.dueDate = next.toISOString().slice(0, 10);
        bumpVersion(cr);
      } else {
        tombstone(cr);
      }

      if (!saveData()) { m.customReminders = previousReminders; Object.assign(cr, priorMeta); return; }
      renderMain();
    }

    // ========== TABS ==========
    function switchTab(tab) {
      currentTab = tab;
      renderMain();
    }

    // ========== MODAL ==========
    // type: 'member' | 'record'
    // editMemberId: pass a member id to edit that member (member modal only)
    // editRecordId: pass a record id to edit that record on the current member (record modal only)
    function openModal(type, editMemberId, editRecordId) {
      document.getElementById(type + 'Modal').classList.add('active');
      tempAttachments = [];
      renderAttachmentPreview();

      if (type === 'member') {
        editingMemberId = editMemberId || null;
        const header = document.querySelector('#memberModal .modal-header');
        const saveBtn = document.getElementById('btnSaveMember');
        tempBloodAttachment = null;

        if (editingMemberId) {
          const m = members.find(x => x.id === editingMemberId);
          if (header) header.textContent = 'Edit Family Member';
          if (saveBtn) saveBtn.textContent = 'Save Changes';
          document.getElementById('mName').value = m.name || '';
          document.getElementById('mNameZh').value = m.nameZh || '';
          document.getElementById('mNameZhAvatarIdx').value = m.nameZhAvatarIdx || 1;
          document.getElementById('mGender').value = m.gender || 'Male';
          document.getElementById('mBirth').value = m.birth || '';
          document.getElementById('mBlood').value = m.blood || 'Unknown';
          document.getElementById('mHeight').value = m.height || '';
          document.getElementById('mAllergies').value = (m.allergies && m.allergies !== 'None') ? m.allergies : '';
          document.getElementById('mHistory').value = m.history || '';
          document.getElementById('mEmergency').value = m.emergency || '';
          tempBloodAttachment = m.bloodTypeAttachment ? { ...m.bloodTypeAttachment } : null;
        } else {
          if (header) header.textContent = 'Add Family Member';
          if (saveBtn) saveBtn.textContent = 'Save';
        }
        renderBloodAttachmentPreview();
      }

      if (type === 'record') {
        editingRecordId = editRecordId || null;
        const header = document.querySelector('#recordModal .modal-header');
        const saveBtn = document.getElementById('btnSaveRecord');
        const m = members.find(x => x.id === currentMemberId);
        const record = editingRecordId ? m?.records.find(r => r.id === editingRecordId) : null;

        if (record) {
          if (header) header.textContent = 'Edit Health Record';
          if (saveBtn) saveBtn.textContent = 'Save Changes';
          document.getElementById('rDate').value = record.date || '';
          document.getElementById('rType').value = record.type || 'Checkup';
          document.getElementById('rTitle').value = record.title || '';
          document.getElementById('rDetails').value = record.details || '';
          document.getElementById('rTags').value = (record.tags || []).join(', ');
          document.getElementById('vSystolic').value = record.vitals?.systolic ?? '';
          document.getElementById('vDiastolic').value = record.vitals?.diastolic ?? '';
          document.getElementById('vHeartRate').value = record.vitals?.heartRate ?? '';
          document.getElementById('vTemp').value = record.vitals?.temp ?? '';
          document.getElementById('vGlucose').value = record.vitals?.glucose ?? '';
          document.getElementById('vWeight').value = record.vitals?.weight ?? '';
          tempAttachments = live(record.attachments || []).map(a => ({ ...a }));
          renderAttachmentPreview();
        } else {
          if (header) header.textContent = 'Add Health Record';
          if (saveBtn) saveBtn.textContent = 'Save';
          document.getElementById('rDate').value = localDateStr();
        }
        toggleVitals();
      }
    }

    function closeModal(type) {
      document.getElementById(type + 'Modal').classList.remove('active');
      tempAttachments = [];
      if (type === 'member') {
        editingMemberId = null;
        tempBloodAttachment = null;
        ['mName','mNameZh','mBirth','mHeight','mAllergies','mHistory','mEmergency'].forEach(id => document.getElementById(id).value = '');
        document.getElementById('mGender').value = 'Male';
        document.getElementById('mBlood').value = 'Unknown';
        document.getElementById('mNameZhAvatarIdx').value = '1';
        document.getElementById('bloodAttachmentPreview').innerHTML = '';
      } else {
        editingRecordId = null;
        ['rDate','rTitle','rDetails','rTags','vSystolic','vDiastolic','vHeartRate','vTemp','vGlucose','vWeight'].forEach(id => document.getElementById(id).value = '');
      }
    }

    function toggleVitals() {
      const type = document.getElementById('rType').value;
      const show = ['Checkup','Monitoring','Illness'].includes(type);
      document.getElementById('vitalsSection').style.display = show ? 'block' : 'none';
    }

    // ========== SAVE ==========
    async function saveMember() {
      const name = document.getElementById('mName').value.trim();
      if (!name) return alert('Please enter a name');
      if (tempBloodAttachment && tempBloodAttachment.data && !(await ensureUnlocked())) return;

      const [bloodTypeAttachment] = tempBloodAttachment
        ? await persistAttachmentsToIdb([tempBloodAttachment])
        : [null];

      const fields = {
        name,
        nameZh: document.getElementById('mNameZh').value.trim(),
        nameZhAvatarIdx: parseInt(document.getElementById('mNameZhAvatarIdx').value) || 1,
        gender: document.getElementById('mGender').value,
        birth: document.getElementById('mBirth').value,
        blood: document.getElementById('mBlood').value,
        height: parseFloat(document.getElementById('mHeight').value) || null,
        allergies: document.getElementById('mAllergies').value || 'None',
        history: document.getElementById('mHistory').value || '',
        emergency: document.getElementById('mEmergency').value || '',
        bloodTypeAttachment: bloodTypeAttachment || null
      };

      if (editingMemberId) {
        // Editing an existing member: keep id and records, update the rest.
        const m = members.find(x => x.id === editingMemberId);
        if (!m) return;
        const oldAttId = m.bloodTypeAttachment?.id;
        const before = {}; MEMBER_SCALAR_FIELDS.forEach(f => { before[f] = m[f]; });
        Object.assign(m, fields);
        bumpFieldVersions(m, before, fields); // per-field version bump, see design 2.1
        if (!saveData()) return; // keep modal open so nothing is lost if storage failed
        if (oldAttId && oldAttId !== fields.bloodTypeAttachment?.id) idbDelete(oldAttId);
        renderMemberList();
        closeModal('member');
        renderMain();
      } else {
        const member = { id: Date.now().toString(), ...fields, records: [], ...freshSyncMeta(), fieldVersion: freshFieldVersions(), historyEntries: historyTextToEntries(fields.history) };
        members.push(member);
        if (!saveData()) { members.pop(); return; }
        renderMemberList();
        closeModal('member');
        selectMember(member.id);
      }
    }

    async function saveRecord() {
      if (!currentMemberId) return alert('Please select a member first');
      if (!(await ensureUnlocked())) return;

      const mForAttachments = members.find(x => x.id === currentMemberId);
      const priorRecordForAttachments = editingRecordId ? mForAttachments.records.find(r => r.id === editingRecordId) : null;
      const persistedRecordAtt = await persistAttachmentsToIdb(tempAttachments);
      const record = {
        id: editingRecordId || ('r' + Date.now()),
        date: document.getElementById('rDate').value,
        type: document.getElementById('rType').value,
        title: document.getElementById('rTitle').value.trim() || document.getElementById('rType').value,
        details: document.getElementById('rDetails').value,
        tags: document.getElementById('rTags').value.split(',').map(t => t.trim()).filter(t => t),
        vitals: {},
        attachments: syncStampAttachments(priorRecordForAttachments ? priorRecordForAttachments.attachments : [], persistedRecordAtt)
      };

      const vSystolic = document.getElementById('vSystolic').value;
      if (vSystolic) record.vitals.systolic = parseFloat(vSystolic);
      const vDiastolic = document.getElementById('vDiastolic').value;
      if (vDiastolic) record.vitals.diastolic = parseFloat(vDiastolic);
      const vHeartRate = document.getElementById('vHeartRate').value;
      if (vHeartRate) record.vitals.heartRate = parseFloat(vHeartRate);
      const vTemp = document.getElementById('vTemp').value;
      if (vTemp) record.vitals.temp = parseFloat(vTemp);
      const vGlucose = document.getElementById('vGlucose').value;
      if (vGlucose) record.vitals.glucose = parseFloat(vGlucose);
      const vWeight = document.getElementById('vWeight').value;
      if (vWeight) record.vitals.weight = parseFloat(vWeight);

      if (Object.keys(record.vitals).length === 0) delete record.vitals;
      if (record.attachments.length === 0) delete record.attachments; // fine: syncStampAttachments never returns an empty array if a tombstone exists

      const m = members.find(x => x.id === currentMemberId);
      const existingIdx = editingRecordId ? m.records.findIndex(r => r.id === editingRecordId) : -1;

      // Keep a rollback copy in case saveData() fails, so we never lose the previous state.
      const previousRecords = [...m.records];
      const oldAttachmentIds = existingIdx > -1 ? (m.records[existingIdx].attachments || []).map(a => a.id).filter(Boolean) : [];

      if (existingIdx > -1) {
        // Preserve sync metadata identity across an edit: bump version,
        // don't reset it to 1, and don't touch deletedAt/schemaVersion.
        const prior = m.records[existingIdx];
        record.version = prior.version;
        record.deletedAt = prior.deletedAt;
        record.schemaVersion = prior.schemaVersion || SYNC_SCHEMA_VERSION;
        bumpVersion(record);
        m.records[existingIdx] = record;
      } else {
        Object.assign(record, freshSyncMeta());
        m.records.push(record);
      }

      if (!saveData()) { m.records = previousRecords; return; }

      // Clean up attachment files that were removed (now tombstoned) during this edit.
      const newLiveIds = new Set(live(record.attachments || []).map(a => a.id).filter(Boolean));
      const removedIds = oldAttachmentIds.filter(id => !newLiveIds.has(id));
      if (removedIds.length) idbDeleteMany(removedIds);

      closeModal('record');
      renderMain();
    }

    // ========== DELETE RECORD ==========
    async function deleteRecord(recordId) {
      const m = members.find(x => x.id === currentMemberId);
      if (!m) return;
      const r = m.records.find(x => x.id === recordId);
      if (!r) return;
      if (!confirm(`Delete this record ("${r.title}", ${r.date})? This cannot be undone.`)) return;

      const previousRecords = [...m.records];
      const priorMeta = { deletedAt: r.deletedAt, version: r.version, updatedAt: r.updatedAt };
      tombstone(r);
      if (!saveData()) { m.records = previousRecords; Object.assign(r, priorMeta); return; }
      // The tombstone (id + deletedAt) stays in the record forever so the
      // deletion can propagate to other devices on next sync - but the
      // actual attachment BYTES in IndexedDB are locally purged right away,
      // since nothing needs them once this record is gone from view here.
      const idsToRemove = (r.attachments || []).map(a => a.id).filter(Boolean);
      if (idsToRemove.length) idbDeleteMany(idsToRemove);
      renderMain();
    }

    // ========== DELETE MEMBER ==========
    async function deleteMember(memberId) {
      const m = members.find(x => x.id === memberId);
      if (!m) return;
      if (!confirm(`Delete "${m.name}" and all their records? This cannot be undone.`)) return;

      const previousMembers = members;
      const priorMeta = { deletedAt: m.deletedAt, version: m.version, updatedAt: m.updatedAt };
      tombstone(m);
      if (!saveData()) { members = previousMembers; Object.assign(m, priorMeta); return; }
      const idsToRemove = [];
      (m.records || []).forEach(r => (r.attachments || []).forEach(a => { if (a.id) idsToRemove.push(a.id); }));
      if (m.bloodTypeAttachment?.id) idsToRemove.push(m.bloodTypeAttachment.id);
      if (idsToRemove.length) idbDeleteMany(idsToRemove);
      if (currentMemberId === memberId) {
        currentMemberId = null;
        currentTab = 'overview';
      }
      renderMemberList();
      renderMain();
    }

    // ========== REPORT PREVIEW & ATTACHMENT SELECTION ==========
    // Maps each report button to which records it covers, so the preview
    // modal can list only the attachments that are actually relevant to
    // that specific report.
    const reportMeta = {
      summary:    { label: 'Health Summary', printFn: printHealthSummary,   recordsFor: m => live(m.records) },
      vaccine:    { label: 'Vaccine Record', printFn: printVaccineCard,     recordsFor: m => live(m.records).filter(r => r.type === 'Vaccine') },
      medication: { label: 'Medication List', printFn: printMedicationList, recordsFor: m => live(m.records).filter(r => r.type === 'Medication') },
      lab:        { label: 'Lab Results', printFn: printLabSummary,         recordsFor: m => live(m.records).filter(r => r.type === 'Lab Test' || r.type === 'Checkup') },
      bp:         { label: 'BP Log', printFn: printBPLog,                   recordsFor: m => live(m.records).filter(r => r.vitals?.systolic) },
      growth:     { label: 'Growth Chart', printFn: printGrowthChart,       recordsFor: m => live(m.records).filter(r => r.vitals?.weight) },
      annual:     { label: 'Annual Report', printFn: printAnnualReport,     recordsFor: m => { const y = String(new Date().getFullYear()); return live(m.records).filter(r => r.date && r.date.startsWith(y)); } }
    };

    let reportPreviewState = null; // { reportKey, memberId, attachments: [{key, record, att}] }

    // Flat list of {key, record, att} for every attachment (with embedded data) across the given records.
    // key = "recordId::attachmentIndex", used to identify selections and to look attachments back up when printing.
    function collectAttachments(records) {
      const list = [];
      records.forEach(r => {
        (r.attachments || []).forEach((att, idx) => {
          if (att.data || att.thumb || att.id) list.push({ key: r.id + '::' + idx, record: r, att });
        });
      });
      return list;
    }

    function openReportPreview(reportKey, memberId) {
      const meta = reportMeta[reportKey];
      const m = members.find(x => x.id === memberId);
      if (!meta || !m) return;

      const records = meta.recordsFor(m);
      const attachments = collectAttachments(records);
      reportPreviewState = { reportKey, memberId, attachments };

      document.getElementById('reportModalTitle').textContent = `${meta.label} - ${m.name}`;
      document.getElementById('reportModalSummary').textContent =
        `Covers ${records.length} record${records.length === 1 ? '' : 's'}.` +
        (attachments.length ? ` ${attachments.length} attachment${attachments.length === 1 ? '' : 's'} available to include.` : ' No attachments on these records.');

      const attContainer = document.getElementById('reportModalAttachments');
      if (attachments.length === 0) {
        attContainer.innerHTML = '';
      } else {
        attContainer.innerHTML = `
          <div class="s-33a0a182">
            <div class="s-a043ed1c">Include attachments:</div>
            <div class="s-1952d609">
              <span class="attachment-remove s-cf36fb90" id="btnSelectAllAtt">Select All</span>
              <span class="attachment-remove" id="btnSelectNoneAtt">Select None</span>
            </div>
          </div>
          <div class="attachment-list s-c6889a29">
            ${attachments.map(({ key, record, att }) => `
              <label class="attachment-item s-58aba575">
                <input type="checkbox" class="report-att-checkbox s-ec1740b6" data-key="${escapeHtml(key)}" checked>
                <div class="attachment-thumb">
                  ${att.type === 'image' && (att.data || att.thumb) ? `<img src="${att.data || att.thumb}" alt="">` : `<span>📄</span>`}
                </div>
                <div class="attachment-info">
                  <div class="attachment-name">${escapeHtml(att.name)}</div>
                  <div class="attachment-path">${escapeHtml(record.title)} &middot; ${escapeHtml(record.date)}</div>
                </div>
              </label>
            `).join('')}
          </div>
        `;
        document.getElementById('btnSelectAllAtt').addEventListener('click', () => {
          attContainer.querySelectorAll('.report-att-checkbox').forEach(cb => cb.checked = true);
        });
        document.getElementById('btnSelectNoneAtt').addEventListener('click', () => {
          attContainer.querySelectorAll('.report-att-checkbox').forEach(cb => cb.checked = false);
        });
      }

      document.getElementById('reportModal').classList.add('active');
    }

    function closeReportPreview() {
      document.getElementById('reportModal').classList.remove('active');
      reportPreviewState = null;
    }

    async function printReportFromPreview() {
      if (!reportPreviewState) return;
      const { reportKey, memberId } = reportPreviewState;
      const meta = reportMeta[reportKey];
      const selectedKeys = new Set(
        Array.from(document.querySelectorAll('.report-att-checkbox:checked')).map(cb => cb.dataset.key)
      );
      closeReportPreview();
      await meta.printFn(memberId, selectedKeys);
    }

    // Builds the printable "Attachments" section shared by every report type.
    // selectedKeys: a Set of "recordId::attachmentIndex" strings to include (from the preview modal).
    // Returns { html, pdfJobs } rather than just a string: image attachments
    // are plain img tags (fine under this page's CSP, img-src allows
    // data:), but a PDF attachment can't use an embed tag here (object-src
    // is locked down) - it gets an empty slot div in the html, and the
    // caller renders each pdfJobs entry into its slot (via
    // renderPdfIntoContainer) AFTER the html has been written to the DOM,
    // since that rendering needs real elements to attach canvases to.
    async function buildAttachmentsSectionHtml(records, selectedKeys) {
      if (!selectedKeys || selectedKeys.size === 0) return { html: '', pdfJobs: [] };
      let rows = '';
      const pdfJobs = [];
      for (const r of records) {
        const attachments = r.attachments || [];
        for (let idx = 0; idx < attachments.length; idx++) {
          const att = attachments[idx];
          const key = r.id + '::' + idx;
          if (!selectedKeys.has(key)) continue;
          const src = await resolveAttachmentData(att);
          if (!src) continue;
          const slotId = 'pdfSlot_' + r.id + '_' + idx;
          rows += `
            <div class="pr-att-item">
              <div class="pr-att-item-label"><strong>${escapeHtml(r.title)}</strong> &middot; ${escapeHtml(r.date)} &middot; ${escapeHtml(att.name)}</div>
              ${att.type === 'image'
                ? `<img src="${src}" class="pr-att-img">`
                : `<div id="${slotId}"></div>`}
            </div>`;
          if (att.type !== 'image') pdfJobs.push({ dataUrl: src, slotId });
        }
      }
      if (!rows) return { html: '', pdfJobs: [] };
      return {
        html: `
        <div class="pr-att-block">
          <h2 class="pr-h2">📎 Attachments</h2>
          ${rows}
        </div>`,
        pdfJobs
      };
    }

    // Renders every {dataUrl, slotId} job (from buildAttachmentsSectionHtml
    // or a report's own single attachment) into its slot element - must run
    // AFTER the html containing those slot divs has been written to the DOM.
    async function renderPdfJobs(jobs) {
      for (const job of jobs) {
        const slot = document.getElementById(job.slotId);
        if (slot) await renderPdfIntoContainer(job.dataUrl, slot);
      }
    }

    // Clears and returns the shared print container - call at the start of
    // every in-page print function, so a slow previous cycle's cleanup (see
    // the afterprint listener) can never bleed into a fresh click.
    function startPrint() {
      const printContainer = document.getElementById('printContainer');
      printContainer.innerHTML = '';
      return printContainer;
    }

    // Waits for images to actually finish decoding and for a real paint to
    // have happened, then prints - see the detailed timing note inside
    // printEmergency (the first function converted to this pattern) for why
    // both waits are necessary, not just one or the other.
    async function finishPrint() {
      const printContainer = document.getElementById('printContainer');
      const imgs = Array.from(printContainer.querySelectorAll('img'));
      await Promise.all(imgs.map(img => (img.decode ? img.decode().catch(() => {}) : Promise.resolve())));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.print();
    }
    window.addEventListener('afterprint', () => {
      const pc = document.getElementById('printContainer');
      if (pc) pc.innerHTML = ''; // don't keep decrypted attachment data sitting in the DOM after printing
    });

    // ========== EMERGENCY CARD ==========
    // Renders a PDF (as a data: URL) into `container` as one <canvas> per
    // page - same approach as the attachment viewer (see openAttachment
    // for the full rationale: consistent cross-platform rendering, and
    // avoids needing object-src for <embed>, which this page's CSP doesn't
    // grant). Canvas styling is set via JS property assignment, not
    // style="..." attributes, since style-src here only allows this page's
    // one hash-locked <style> block.
    async function renderPdfIntoContainer(dataUrl, container) {
      try {
        const blob = dataUrlToBlob(dataUrl);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const pdfjsLib = await pdfjsLibPromise;
        const pdf = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
        const containerWidth = container.clientWidth || 360;
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          const page = await pdf.getPage(pageNum);
          const unscaledViewport = page.getViewport({ scale: 1 });
          const scale = Math.max(0.1, (containerWidth - 20) / unscaledViewport.width);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.display = 'block';
          canvas.style.maxWidth = '100%';
          canvas.style.margin = '6px auto';
          container.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        }
      } catch (pdfErr) {
        const msg = document.createElement('div');
        msg.textContent = 'Could not render the attached PDF for printing: ' + pdfErr.message;
        container.appendChild(msg);
      }
    }

    async function printEmergency(memberId) {
      const m = members.find(x => x.id === memberId);
      if (!m) return;
      const latest = getLatestVitals(m);
      const age = m.birth ? Math.floor((new Date() - new Date(m.birth)) / 365.25 / 24 / 60 / 60 / 1000) : '?';
      const bloodAttData = await resolveAttachmentData(m.bloodTypeAttachment);
      const isPdfAtt = bloodAttData && (m.bloodTypeAttachment.type !== 'image');

      const printContainer = startPrint();
      printContainer.innerHTML = `
        <div class="pe-card">
          <h1 class="pe-title">🚨 Emergency Medical Info</h1>
          <div class="pe-grid">
            <div class="pe-item"><div class="pe-label">Name</div><div class="pe-value">${escapeHtml(m.name)}</div></div>
            <div class="pe-item"><div class="pe-label">Age/Gender</div><div class="pe-value">${age}y / ${escapeHtml(m.gender)}</div></div>
            <div class="pe-item"><div class="pe-label">Blood Type</div><div class="pe-value">${escapeHtml(m.blood)}</div></div>
            <div class="pe-item"><div class="pe-label">Emergency Contact</div><div class="pe-value">${escapeHtml(m.emergency) || 'None'}</div></div>
            ${m.allergies !== 'None' ? `<div class="pe-item pe-full pe-alert">⚠️ Allergies: ${escapeHtml(m.allergies)}</div>` : ''}
            <div class="pe-item pe-full"><div class="pe-label">Medical History</div><div class="pe-value pe-history-value">${escapeHtml(m.history) || 'None'}</div></div>
            ${latest.systolic ? `<div class="pe-item"><div class="pe-label">Recent BP</div><div class="pe-value">${latest.systolic}/${latest.diastolic}</div></div>` : ''}
            ${latest.heartRate ? `<div class="pe-item"><div class="pe-label">Recent HR</div><div class="pe-value">${latest.heartRate} bpm</div></div>` : ''}
          </div>
          ${bloodAttData ? `
          <div class="pe-item pe-full pe-att-block">
            <div class="pe-label">Blood Type Test Report</div>
            ${m.bloodTypeAttachment.type === 'image' ? `<img class="pe-att-img" src="${bloodAttData}">` : `<div id="peBloodPdfSlot"></div>`}
          </div>
          ` : ''}
          <p class="pe-footer">Generated: ${new Date().toLocaleString()}</p>
        </div>
      `;
      // Fully class-based (no style="..." attributes anywhere above): this
      // page's CSP hash-locks the <style> BLOCK, but a hash alone (without
      // the separate 'unsafe-hashes' keyword, which this CSP doesn't have)
      // does NOT cover style="..." attributes - those would be silently
      // stripped by the browser regardless of the block's hash matching.
      if (isPdfAtt) {
        await renderPdfIntoContainer(bloodAttData, document.getElementById('peBloodPdfSlot'));
      }

      await finishPrint();
    }

    // ========== 1. HEALTH SUMMARY REPORT ==========
    async function printHealthSummary(memberId, selectedAttachmentKeys = null) {
      const m = members.find(x => x.id === memberId);
      if (!m) return;
      const age = m.birth ? Math.floor((new Date() - new Date(m.birth)) / 365.25 / 24 / 60 / 60 / 1000) : '?';
      const latest = getLatestVitals(m);
      const bmi = calcBmi(m.height, latest.weight);
      const bloodAttData = await resolveAttachmentData(m.bloodTypeAttachment);
      const isPdfAtt = bloodAttData && (m.bloodTypeAttachment.type !== 'image');
      const { html: attachmentsHtml, pdfJobs } = await buildAttachmentsSectionHtml(live(m.records), selectedAttachmentKeys);

      const recordsHtml = recordsByDateDesc(m).map(r => `
        <tr>
          <td>${escapeHtml(r.date)}</td>
          <td>${escapeHtml(r.type)}</td>
          <td>${escapeHtml(r.title)}</td>
          <td class="s-5c9fd965">${escapeHtml(r.details) || '-'}</td>
        </tr>
      `).join('');

      const printContainer = startPrint();
      printContainer.innerHTML = `
        <div class="pr-page pr-teal">
          <h1 class="pr-h1">📋 Health Summary Report</h1>
          <div class="pr-grid3">
            <div class="pr-box"><div class="pr-box-label">Name</div><div class="pr-box-value">${escapeHtml(m.name)}</div></div>
            <div class="pr-box"><div class="pr-box-label">Age / Gender</div><div class="pr-box-value">${age}y / ${escapeHtml(m.gender)}</div></div>
            <div class="pr-box"><div class="pr-box-label">Blood Type</div><div class="pr-box-value">${escapeHtml(m.blood)}</div></div>
            <div class="pr-box"><div class="pr-box-label">Height</div><div class="pr-box-value">${m.height || '--'} cm</div></div>
            <div class="pr-box"><div class="pr-box-label">Weight</div><div class="pr-box-value">${latest.weight || '--'} kg</div></div>
            <div class="pr-box"><div class="pr-box-label">BMI</div><div class="pr-box-value">${bmi}</div></div>
          </div>
          ${m.allergies !== 'None' ? `<div class="pr-alert"><strong>⚠️ Allergies:</strong> ${escapeHtml(m.allergies)}</div>` : ''}
          <p><strong>Emergency Contact:</strong> ${escapeHtml(m.emergency) || 'None'}</p>
          <p><strong>Medical History:</strong> ${escapeHtml(m.history) || 'None'}</p>
          ${m.bloodTypeAttachment && bloodAttData ? `
          <h2 class="pr-h2">Blood Type Test Report</h2>
          ${m.bloodTypeAttachment.type === 'image' ? `<img src="${bloodAttData}" class="pr-att-img">` : `<div id="hsBloodPdfSlot"></div>`}
          ` : ''}

          <h2 class="pr-h2">Latest Vitals</h2>
          <div class="pr-grid3">
            <div class="pr-box"><div class="pr-box-label">Blood Pressure</div><div class="pr-box-value">${latest.systolic || '--'}/${latest.diastolic || '--'}</div></div>
            <div class="pr-box"><div class="pr-box-label">Heart Rate</div><div class="pr-box-value">${latest.heartRate || '--'} bpm</div></div>
            <div class="pr-box"><div class="pr-box-label">Temperature</div><div class="pr-box-value">${latest.temp || '--'} °C</div></div>
            <div class="pr-box"><div class="pr-box-label">Glucose</div><div class="pr-box-value">${latest.glucose || '--'} mmol/L</div></div>
          </div>

          <h2 class="pr-h2">All Records (${live(m.records).length})</h2>
          <table class="pr-table">
            <tr><th>Date</th><th>Type</th><th>Title</th><th>Details</th></tr>
            ${recordsHtml || '<tr><td colspan="4" class="pr-empty">No records</td></tr>'}
          </table>
          <div class="pr-footer">Generated by Family Health & Shield on ${new Date().toLocaleString()}</div>
          ${attachmentsHtml}
        </div>
      `;
      if (isPdfAtt) pdfJobs.push({ dataUrl: bloodAttData, slotId: 'hsBloodPdfSlot' });
      await renderPdfJobs(pdfJobs);
      await finishPrint();
    }

    // ========== 2. VACCINATION RECORD CARD ==========
    async function printVaccineCard(memberId, selectedAttachmentKeys = null) {
      const m = members.find(x => x.id === memberId);
      if (!m) return;
      const age = m.birth ? Math.floor((new Date() - new Date(m.birth)) / 365.25 / 24 / 60 / 60 / 1000) : '?';

      const vaccines = live(m.records).filter(r => r.type === 'Vaccine').sort((a,b) => new Date(a.date) - new Date(b.date));
      const vaccineRows = vaccines.map((v, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(v.title)}</td>
          <td>${escapeHtml(v.date)}</td>
          <td class="s-5c9fd965">${escapeHtml(v.details) || '-'}</td>
          <td>${escapeHtml((v.tags || []).join(', ')) || '-'}</td>
        </tr>
      `).join('');

      const { html: attachmentsHtml, pdfJobs } = await buildAttachmentsSectionHtml(vaccines, selectedAttachmentKeys);
      const printContainer = startPrint();
      printContainer.innerHTML = `
        <div class="pr-page pr-green">
          <h1 class="pr-h1">💉 Immunization Record</h1>
          <div class="pr-info-row">
            <div><strong>Name:</strong> ${escapeHtml(m.name)}</div>
            <div><strong>Date of Birth:</strong> ${escapeHtml(m.birth) || 'Unknown'}</div>
            <div><strong>Age:</strong> ${age} years</div>
            <div><strong>Gender:</strong> ${escapeHtml(m.gender)}</div>
          </div>
          <table class="pr-table">
            <tr><th>#</th><th>Vaccine</th><th>Date</th><th>Details</th><th>Tags</th></tr>
            ${vaccineRows || '<tr><td colspan="5" class="pr-empty">No vaccination records found</td></tr>'}
          </table>
          <div class="pr-footer">Generated by Family Health & Shield on ${new Date().toLocaleString()}</div>
          ${attachmentsHtml}
        </div>
      `;
      await renderPdfJobs(pdfJobs);
      await finishPrint();
    }

    // ========== 3. MEDICATION LIST ==========
    async function printMedicationList(memberId, selectedAttachmentKeys = null) {
      const m = members.find(x => x.id === memberId);
      if (!m) return;

      const meds = live(m.records).filter(r => r.type === 'Medication').sort((a,b) => new Date(b.date) - new Date(a.date));
      const medRows = meds.map(med => `
        <tr>
          <td>${escapeHtml(med.title)}</td>
          <td>${escapeHtml(med.date)}</td>
          <td class="s-5c9fd965">${escapeHtml(med.details) || '-'}</td>
          <td>${escapeHtml((med.tags || []).join(', ')) || '-'}</td>
        </tr>
      `).join('');

      const { html: attachmentsHtml, pdfJobs } = await buildAttachmentsSectionHtml(meds, selectedAttachmentKeys);
      const printContainer = startPrint();
      printContainer.innerHTML = `
        <div class="pr-page pr-amber">
          <h1 class="pr-h1">💊 Current & Past Medications</h1>
          <div class="pr-info-row">
            <div><strong>Patient:</strong> ${escapeHtml(m.name)} | <strong>Allergies:</strong> ${escapeHtml(m.allergies)} | <strong>Emergency:</strong> ${escapeHtml(m.emergency) || 'None'}</div>
          </div>
          ${m.allergies !== 'None' ? `<div class="pr-alert"><strong>⚠️ Drug Allergies:</strong> ${escapeHtml(m.allergies)}</div>` : ''}
          <table class="pr-table">
            <tr><th>Medication</th><th>Date</th><th>Details / Dosage</th><th>Tags</th></tr>
            ${medRows || '<tr><td colspan="4" class="pr-empty">No medication records</td></tr>'}
          </table>
          <div class="pr-footer">Generated by Family Health & Shield on ${new Date().toLocaleString()}</div>
          ${attachmentsHtml}
        </div>
      `;
      await renderPdfJobs(pdfJobs);
      await finishPrint();
    }

    // ========== 4. LAB RESULTS SUMMARY ==========
    async function printLabSummary(memberId, selectedAttachmentKeys = null) {
      const m = members.find(x => x.id === memberId);
      if (!m) return;

      const labs = live(m.records).filter(r => r.type === 'Lab Test' || r.type === 'Checkup').sort((a,b) => new Date(b.date) - new Date(a.date));

      let labRows = '';
      labs.forEach(lab => {
        const v = lab.vitals || {};
        labRows += `
          <tr>
            <td>${escapeHtml(lab.date)}</td>
            <td>${escapeHtml(lab.title)}</td>
            <td>${v.systolic ? v.systolic + '/' + v.diastolic : '-'}</td>
            <td>${v.heartRate || '-'}</td>
            <td>${v.glucose || '-'}</td>
            <td>${v.temp || '-'}</td>
            <td>${v.weight || '-'}</td>
          </tr>
        `;
      });

      const { html: attachmentsHtml, pdfJobs } = await buildAttachmentsSectionHtml(labs, selectedAttachmentKeys);
      const printContainer = startPrint();
      printContainer.innerHTML = `
        <div class="pr-page pr-wide pr-purple">
          <h1 class="pr-h1">🔬 Lab Results Summary</h1>
          <div class="pr-info-row">
            <div><strong>Patient:</strong> ${escapeHtml(m.name)} | <strong>DOB:</strong> ${escapeHtml(m.birth) || 'Unknown'} | <strong>Blood Type:</strong> ${escapeHtml(m.blood)}</div>
          </div>
          <table class="pr-table pr-table-center">
            <tr>
              <th>Date</th><th>Test</th><th>BP (mmHg)</th><th>HR (bpm)</th>
              <th>Glucose</th><th>Temp (°C)</th><th>Weight (kg)</th>
            </tr>
            ${labRows || '<tr><td colspan="7" class="pr-empty">No lab records with vitals</td></tr>'}
          </table>
          <div class="pr-footer">Generated by Family Health & Shield on ${new Date().toLocaleString()}</div>
          ${attachmentsHtml}
        </div>
      `;
      await renderPdfJobs(pdfJobs);
      await finishPrint();
    }

    // ========== 5. BLOOD PRESSURE LOG ==========
    async function printBPLog(memberId, selectedAttachmentKeys = null) {
      const m = members.find(x => x.id === memberId);
      if (!m) return;

      const bpRecords = live(m.records).filter(r => r.vitals?.systolic).sort((a,b) => new Date(a.date) - new Date(b.date));

      let bpRows = '';
      let totalSys = 0, totalDia = 0, count = 0;

      bpRecords.forEach(r => {
        const v = r.vitals;
        const status = v.systolic > 140 || v.diastolic > 90 ? 'High' : v.systolic < 90 || v.diastolic < 60 ? 'Low' : 'Normal';
        const statusClass = status === 'High' ? 'pr-status-high' : status === 'Low' ? 'pr-status-low' : 'pr-status-normal';

        totalSys += v.systolic;
        totalDia += v.diastolic;
        count++;

        bpRows += `
          <tr>
            <td>${escapeHtml(r.date)}</td>
            <td><strong>${v.systolic}/${v.diastolic}</strong></td>
            <td>${v.heartRate || '-'}</td>
            <td>${escapeHtml(r.title)}</td>
            <td class="${statusClass}">${status}</td>
          </tr>
        `;
      });

      const avgSys = count ? Math.round(totalSys / count) : '--';
      const avgDia = count ? Math.round(totalDia / count) : '--';

      const { html: attachmentsHtml, pdfJobs } = await buildAttachmentsSectionHtml(bpRecords, selectedAttachmentKeys);
      const printContainer = startPrint();
      printContainer.innerHTML = `
        <div class="pr-page pr-red">
          <h1 class="pr-h1">🩺 Blood Pressure Log</h1>
          <p><strong>Patient:</strong> ${escapeHtml(m.name)} | <strong>Records:</strong> ${count}</p>
          <div class="pr-grid3">
            <div class="pr-box pr-box-center"><div class="pr-box-label">Average Systolic</div><div class="pr-box-value-lg">${avgSys}</div></div>
            <div class="pr-box pr-box-center"><div class="pr-box-label">Average Diastolic</div><div class="pr-box-value-lg">${avgDia}</div></div>
            <div class="pr-box pr-box-center"><div class="pr-box-label">Total Readings</div><div class="pr-box-value-lg">${count}</div></div>
          </div>
          <div class="pr-legend">
            <span><span class="pr-dot pr-dot-red"></span> High (&gt;140/90)</span>
            <span><span class="pr-dot pr-dot-green"></span> Normal</span>
            <span><span class="pr-dot pr-dot-amber"></span> Low (&lt;90/60)</span>
          </div>
          <table class="pr-table">
            <tr><th>Date</th><th>BP (mmHg)</th><th>HR</th><th>Context</th><th>Status</th></tr>
            ${bpRows || '<tr><td colspan="5" class="pr-empty">No BP records found</td></tr>'}
          </table>
          <div class="pr-footer">Generated by Family Health & Shield on ${new Date().toLocaleString()}</div>
          ${attachmentsHtml}
        </div>
      `;
      await renderPdfJobs(pdfJobs);
      await finishPrint();
    }

    // ========== 6. GROWTH CHART ==========
    async function printGrowthChart(memberId, selectedAttachmentKeys = null) {
      const m = members.find(x => x.id === memberId);
      if (!m) return;
      const age = m.birth ? Math.floor((new Date() - new Date(m.birth)) / 365.25 / 24 / 60 / 60 / 1000) : '?';

      const weightRecords = live(m.records).filter(r => r.vitals?.weight).sort((a,b) => new Date(a.date) - new Date(b.date));

      let growthRows = '';
      weightRecords.forEach(r => {
        const bmi = calcBmi(m.height, r.vitals.weight);
        growthRows += `
          <tr>
            <td>${escapeHtml(r.date)}</td>
            <td>${m.height || '--'} cm</td>
            <td>${r.vitals.weight} kg</td>
            <td>${bmi}</td>
            <td>${escapeHtml(r.title)}</td>
          </tr>
        `;
      });

      const { html: attachmentsHtml, pdfJobs } = await buildAttachmentsSectionHtml(weightRecords, selectedAttachmentKeys);
      const printContainer = startPrint();
      printContainer.innerHTML = `
        <div class="pr-page pr-blue">
          <h1 class="pr-h1">📏 Growth Chart</h1>
          <div class="pr-grid4">
            <div class="pr-box pr-box-center"><div class="pr-box-label">Name</div><div class="pr-box-value">${escapeHtml(m.name)}</div></div>
            <div class="pr-box pr-box-center"><div class="pr-box-label">Age</div><div class="pr-box-value">${age}y</div></div>
            <div class="pr-box pr-box-center"><div class="pr-box-label">Gender</div><div class="pr-box-value">${escapeHtml(m.gender)}</div></div>
            <div class="pr-box pr-box-center"><div class="pr-box-label">Current Height</div><div class="pr-box-value">${m.height || '--'}</div></div>
          </div>
          <table class="pr-table">
            <tr><th>Date</th><th>Height (cm)</th><th>Weight (kg)</th><th>BMI</th><th>Notes</th></tr>
            ${growthRows || '<tr><td colspan="5" class="pr-empty">No growth records with weight</td></tr>'}
          </table>
          <p class="pr-note">* Height reflects the member's current recorded height, not a historical measurement per visit. Update height in "Edit Info" as it changes for more accurate BMI trends.</p>
          <div class="pr-footer">Generated by Family Health & Shield on ${new Date().toLocaleString()}</div>
          ${attachmentsHtml}
        </div>
      `;
      await renderPdfJobs(pdfJobs);
      await finishPrint();
    }

    // ========== 7. ANNUAL HEALTH REPORT ==========
    async function printAnnualReport(memberId, selectedAttachmentKeys = null) {
      const m = members.find(x => x.id === memberId);
      if (!m) return;
      const age = m.birth ? Math.floor((new Date() - new Date(m.birth)) / 365.25 / 24 / 60 / 60 / 1000) : '?';
      const year = new Date().getFullYear();

      const yearRecords = live(m.records).filter(r => r.date.startsWith(year.toString()));
      const checkups = yearRecords.filter(r => r.type === 'Checkup').length;
      const vaccines = yearRecords.filter(r => r.type === 'Vaccine').length;
      const illnesses = yearRecords.filter(r => r.type === 'Illness').length;
      const medications = yearRecords.filter(r => r.type === 'Medication').length;

      const typeBreakdown = {};
      live(m.records).forEach(r => {
        typeBreakdown[r.type] = (typeBreakdown[r.type] || 0) + 1;
      });

      const breakdownRows = Object.entries(typeBreakdown).map(([type, count]) => `
        <tr><td>${escapeHtml(type)}</td><td>${count}</td></tr>
      `).join('');

      const { html: attachmentsHtml, pdfJobs } = await buildAttachmentsSectionHtml(yearRecords, selectedAttachmentKeys);
      const printContainer = startPrint();
      printContainer.innerHTML = `
        <div class="pr-page pr-teal">
          <h1 class="pr-h1">📅 Annual Health Report</h1>
          <span class="pr-badge">${year}</span>
          <p><strong>Patient:</strong> ${escapeHtml(m.name)} | <strong>Age:</strong> ${age}y | <strong>Gender:</strong> ${escapeHtml(m.gender)}</p>

          <h2 class="pr-h2">This Year's Activity</h2>
          <div class="pr-grid4">
            <div class="pr-box pr-box-center pr-accent"><div class="pr-box-value-lg">${checkups}</div><div class="pr-box-label">Checkups</div></div>
            <div class="pr-box pr-box-center pr-accent"><div class="pr-box-value-lg">${vaccines}</div><div class="pr-box-label">Vaccines</div></div>
            <div class="pr-box pr-box-center pr-accent"><div class="pr-box-value-lg">${illnesses}</div><div class="pr-box-label">Illnesses</div></div>
            <div class="pr-box pr-box-center pr-accent"><div class="pr-box-value-lg">${medications}</div><div class="pr-box-label">Medications</div></div>
          </div>

          <h2 class="pr-h2">Lifetime Record Breakdown</h2>
          <table class="pr-table">
            <tr><th>Record Type</th><th>Total Count</th></tr>
            ${breakdownRows}
            <tr class="pr-table-total-row"><td>Total Records</td><td>${live(m.records).length}</td></tr>
          </table>

          <div class="pr-goals">
            <h3 class="pr-h3">🎯 Health Goals for Next Year</h3>
            <ul>
              <li>Schedule annual physical checkup</li>
              <li>Keep up with recommended vaccinations</li>
              <li>Maintain regular health monitoring</li>
              <li>Update emergency contact information</li>
            </ul>
          </div>
          <div class="pr-footer">Generated by Family Health & Shield on ${new Date().toLocaleString()}</div>
          ${attachmentsHtml}
        </div>
      `;
      await renderPdfJobs(pdfJobs);
      await finishPrint();
    }

    // ========== EXPORT / IMPORT ==========
    // Builds a deep copy of the given members with every attachment's full
    // file data inlined (fetched from IndexedDB), so JSON exports remain
    // fully self-contained rather than referencing IDs only this browser has.
    async function inflateMembersForExport(memberList) {
      const out = [];
      for (const m of memberList) {
        const copy = JSON.parse(JSON.stringify(m));
        if (copy.bloodTypeAttachment) {
          copy.bloodTypeAttachment.data = await resolveAttachmentData(m.bloodTypeAttachment);
        }
        for (const r of (copy.records || [])) {
          const origRecord = m.records.find(x => x.id === r.id);
          for (let i = 0; i < (r.attachments || []).length; i++) {
            r.attachments[i].data = await resolveAttachmentData(origRecord.attachments[i]);
          }
        }
        if (copy.insurance && Array.isArray(copy.insurance.policies)) {
          for (const p of copy.insurance.policies) {
            const origPolicy = (m.insurance.policies || []).find(x => x.id === p.id);
            for (let i = 0; i < (p.attachments || []).length; i++) {
              p.attachments[i].data = await resolveAttachmentData(origPolicy.attachments[i]);
            }
            for (const l of (p.ledger || [])) {
              const origLedger = (origPolicy.ledger || []).find(x => x.id === l.id);
              for (let i = 0; i < (l.attachments || []).length; i++) {
                l.attachments[i].data = await resolveAttachmentData(origLedger.attachments[i]);
              }
            }
            for (const s of (p.surrenderRecords || [])) {
              const origSurrender = (origPolicy.surrenderRecords || []).find(x => x.id === s.id);
              for (let i = 0; i < (s.attachments || []).length; i++) {
                s.attachments[i].data = await resolveAttachmentData(origSurrender.attachments[i]);
              }
            }
          }
        }
        out.push(copy);
      }
      return out;
    }

    // ===== Export Options (encrypt-or-not toggle shown before every export) =====
    let pendingExportType = null; // 'all' | 'member' | 'zip'

    function openExportOptionsModal(type) {
      pendingExportType = type;
      const titles = { all: 'Export All (Backup)', member: 'Export Member', zip: 'Pack ZIP (Backup)' };
      document.getElementById('exportOptionsTitle').textContent = titles[type] || 'Export Backup';
      document.getElementById('exportOptionsError').textContent = '';
      document.getElementById('exportPasscode1').value = '';
      document.getElementById('exportPasscode2').value = '';
      const toggle = document.getElementById('exportEncryptToggle');
      toggle.checked = true; // default ON, per request
      toggle.disabled = false;
      updateExportOptionsUI();
      document.getElementById('exportOptionsModal').classList.add('active');
    }

    function updateExportOptionsUI() {
      const encrypt = document.getElementById('exportEncryptToggle').checked;
      const appReady = isEncryptionEnabled() && isUnlocked();
      document.getElementById('exportPlaintextWarning').style.display = encrypt ? 'none' : 'block';
      document.getElementById('exportPasscodeFields').style.display = (encrypt && !appReady) ? 'block' : 'none';
      document.getElementById('exportEncryptOnNote').textContent = (encrypt && appReady)
        ? '🔓 Will be encrypted using your app Security passcode.' : '';
    }
    document.getElementById('exportEncryptToggle').addEventListener('change', updateExportOptionsUI);
    document.getElementById('btnExportOptionsCancel').addEventListener('click', () => document.getElementById('exportOptionsModal').classList.remove('active'));

    document.getElementById('btnExportOptionsConfirm').addEventListener('click', async () => {
      const encrypt = document.getElementById('exportEncryptToggle').checked;
      const errEl = document.getElementById('exportOptionsError');
      errEl.textContent = '';
      const appReady = isEncryptionEnabled() && isUnlocked();

      let exportKey = null;
      let exportSalt = null;
      let exportIterVer = null;
      if (encrypt) {
        if (appReady) {
          exportKey = cryptoKey;
          const cfg = getCryptoConfig();
          exportSalt = cfg.salt;
          // Whatever iteration count actually produced cryptoKey right now -
          // could still be the legacy count if this vault hasn't gone
          // through migratePbkdf2Iterations() yet. Must match exactly, or
          // import will derive the wrong key from this file.
          exportIterVer = cfg.iterVer || 1;
        } else {
          const p1 = document.getElementById('exportPasscode1').value;
          const p2 = document.getElementById('exportPasscode2').value;
          if (p1.length < 6) { errEl.textContent = 'Passcode must be at least 6 characters.'; return; }
          if (p1 !== p2) { errEl.textContent = 'Passcodes do not match.'; return; }
          const saltBytes = crypto.getRandomValues(new Uint8Array(16));
          exportSalt = bufToB64(saltBytes);
          exportIterVer = PBKDF2_ITER_VERSION; // fresh salt each export -> always safe to use the current/strongest count
          exportKey = await deriveKeyFromPasscode(p1, exportSalt, PBKDF2_CONFIGS[exportIterVer]);
        }
      }

      document.getElementById('exportOptionsModal').classList.remove('active');
      try {
        if (pendingExportType === 'all') await exportData(encrypt, exportKey, exportSalt, exportIterVer);
        else if (pendingExportType === 'member') await exportMember(encrypt, exportKey, exportSalt, exportIterVer);
        else if (pendingExportType === 'zip') await packZip(encrypt, exportKey, exportSalt, exportIterVer);
      } catch (err) {
        alert('Export failed: ' + err.message);
      }
    });

    // Wraps JSON text in a self-describing encrypted envelope (carries its own
    // salt, so the file can be decrypted on ANY device given the right
    // passcode - it isn't tied to this device's own Security setup).
    // iterVer records which PBKDF2_CONFIGS entry the key was derived with, so
    // a future import (possibly after PBKDF2_ITER_VERSION has been bumped
    // again) still derives the SAME key this file was actually encrypted
    // with, instead of silently trying the current/default iteration count
    // and failing with what looks like "wrong passcode."
    async function buildExportPayload(jsonString, encrypt, key, salt, iterVer) {
      if (!encrypt) return jsonString;
      const payload = await encryptText(jsonString, key);
      return JSON.stringify({ encryptedBackup: true, version: 1, salt, iterVer, payload });
    }


    // Wraps an inflated member array with a marker saying whether this file is a
    // full-family backup ('all') or a single-member export ('member'). Import
    // uses this to decide whether it's safe to merge just one member's data in
    // (member exports) or whether the whole family must be replaced (backups).
    function buildExportEnvelope(inflatedMembers, exportType) {
      return { fhsExportType: exportType, exportedAt: new Date().toISOString(), members: inflatedMembers };
    }

    async function exportMember(encrypt, key, salt, iterVer) {
      if (!currentMemberId) {
        alert('Please select a member first');
        return;
      }
      const m = members.find(x => x.id === currentMemberId);
      const inflated = await inflateMembersForExport([m]);
      const envelope = buildExportEnvelope(inflated, 'member');
      const data = await buildExportPayload(JSON.stringify(envelope, null, 2), encrypt, key, salt, iterVer);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `FamilyHealthShield_${m.name}_${localDateStr()}${encrypt ? '_encrypted' : ''}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }

    async function exportData(encrypt, key, salt, iterVer) {
      const inflated = await inflateMembersForExport(members);
      const envelope = buildExportEnvelope(inflated, 'all');
      const data = await buildExportPayload(JSON.stringify(envelope, null, 2), encrypt, key, salt, iterVer);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `FamilyHealthShield_Backup_${localDateStr()}${encrypt ? '_encrypted' : ''}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }

    // Unwraps an imported file into { exportType, rawMembers }. New exports carry
    // an explicit fhsExportType ('member' or 'all'); older exports made before
    // this distinction existed are a bare array with no envelope, and are always
    // treated as 'all' so their import behavior is unchanged (full replace) -
    // there's no reliable way to tell an old single-member export from an old
    // full backup of a one-person family, so we don't guess.
    function parseImportEnvelope(parsed) {
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.members)) {
        return { exportType: parsed.fhsExportType === 'member' ? 'member' : 'all', rawMembers: parsed.members };
      }
      if (Array.isArray(parsed)) {
        return { exportType: 'all', rawMembers: parsed };
      }
      throw new Error('Expected a JSON array of family members, or a Family Health Shield export file.');
    }

    // Validates and normalizes imported data so a malformed or foreign JSON
    // file can't crash rendering later (e.g. missing .records/.tags arrays).
    // Returns the normalized array, or throws with a human-readable reason.
    function normalizeImportedMembers(data) {
      if (!Array.isArray(data)) throw new Error('Expected a JSON array of family members.');
      const normalized = data.map((raw, i) => {
        if (!raw || typeof raw !== 'object') throw new Error(`Member #${i + 1} is not a valid object.`);
        if (!raw.name || typeof raw.name !== 'string') throw new Error(`Member #${i + 1} is missing a name.`);
        return {
          id: sanitizeId(raw.id, (Date.now() + i).toString()),
          // Sync metadata (version/updatedAt/deletedAt/schemaVersion) is
          // passed through as-is here rather than defaulted - the
          // migrateSyncFields() call below (same function used for local
          // data on load) backfills anything missing exactly the way
          // design 2.6/2.8 wants: an old export file with no `version`
          // field becomes version 1, not silently dropped and re-created
          // fresh, which would break merge-by-id entirely.
          version: raw.version, updatedAt: raw.updatedAt, deletedAt: raw.deletedAt, schemaVersion: raw.schemaVersion,
          fieldVersion: (raw.fieldVersion && typeof raw.fieldVersion === 'object') ? raw.fieldVersion : undefined,
          historyEntries: Array.isArray(raw.historyEntries) ? raw.historyEntries : undefined,
          name: raw.name,
          nameZh: raw.nameZh || '',
          nameZhAvatarIdx: parseInt(raw.nameZhAvatarIdx) || 1,
          gender: raw.gender || 'Male',
          birth: raw.birth || '',
          blood: raw.blood || 'Unknown',
          height: raw.height ?? null,
          allergies: raw.allergies || 'None',
          history: raw.history || '',
          emergency: raw.emergency || '',
          bloodTypeAttachment: (raw.bloodTypeAttachment && typeof raw.bloodTypeAttachment === 'object') ? raw.bloodTypeAttachment : null,
          customReminders: Array.isArray(raw.customReminders) ? raw.customReminders.map((cr, j) => ({
            id: sanitizeId(cr.id, freshId('cr')),
            version: cr.version, updatedAt: cr.updatedAt, deletedAt: cr.deletedAt, schemaVersion: cr.schemaVersion,
            title: cr.title || 'Reminder',
            dueDate: cr.dueDate || new Date().toISOString().slice(0, 10),
            repeatMonths: parseInt(cr.repeatMonths) || 0,
            notes: cr.notes || ''
          })) : [],
          records: Array.isArray(raw.records) ? raw.records.map(r => ({
            id: sanitizeId(r.id, freshId('r')),
            version: r.version, updatedAt: r.updatedAt, deletedAt: r.deletedAt, schemaVersion: r.schemaVersion,
            date: r.date || new Date().toISOString().slice(0, 10),
            type: r.type || 'Checkup',
            title: r.title || r.type || 'Record',
            details: r.details || '',
            tags: Array.isArray(r.tags) ? r.tags : [],
            vitals: sanitizeVitals(r.vitals),
            attachments: Array.isArray(r.attachments) ? r.attachments : undefined
          })) : [],
          // sanitizeIdsDeep rewrites every nested "id" (policies, coverages,
          // sumInsuredHistory entries, riders, ledger rows, claims,
          // surrenderRecords, attachments) in place - see its comment above
          // for why this is a deep walk rather than a field-by-field remap.
          // It preserves every OTHER field untouched, including sync
          // metadata, so insurance data doesn't need the same manual
          // pass-through as member/record/reminder fields above.
          insurance: (raw.insurance && typeof raw.insurance === 'object') ? {
            policies: sanitizeIdsDeep(Array.isArray(raw.insurance.policies) ? raw.insurance.policies : []),
            claims: sanitizeIdsDeep(Array.isArray(raw.insurance.claims) ? raw.insurance.claims : [])
          } : { policies: [], claims: [] }
        };
      });
      // Backfill anything missing (old export files, or fields normalize
      // above didn't touch) the exact same way local data gets migrated on
      // load - see design 2.6.
      return migrateSyncFields(normalized);
    }

    async function migrateMemberAttachmentsToIdb(memberList) {
      for (const m of memberList) {
        if (m.bloodTypeAttachment) {
          const [migrated] = await persistAttachmentsToIdb([m.bloodTypeAttachment]);
          m.bloodTypeAttachment = migrated;
        }
        for (const r of (m.records || [])) {
          if (r.attachments && r.attachments.length) {
            r.attachments = await persistAttachmentsToIdb(r.attachments);
          }
        }
        if (m.insurance && Array.isArray(m.insurance.policies)) {
          for (const p of m.insurance.policies) {
            if (p.attachments && p.attachments.length) {
              p.attachments = await persistAttachmentsToIdb(p.attachments);
            }
            for (const l of (p.ledger || [])) {
              if (l.attachments && l.attachments.length) {
                l.attachments = await persistAttachmentsToIdb(l.attachments);
              }
            }
            for (const s of (p.surrenderRecords || [])) {
              if (s.attachments && s.attachments.length) {
                s.attachments = await persistAttachmentsToIdb(s.attachments);
              }
            }
          }
        }
      }
      return memberList;
    }

    // Merges a single-member export into the existing family, matched by id -
    // unlike a full backup import, this never replaces the whole `members`
    // array, so every OTHER family member is left completely untouched. A
    // matching id updates that member in place; no match (e.g. re-importing
    // onto a fresh device, or someone renamed/lost their original) offers to
    // add them as a new member instead of silently discarding the file.
    // ========== CONFLICT QUEUE (build order step 5 builds the UI on top
    // of this; step 4 just needs to capture and persist what mergeMembers()
    // finds, per design 1.4 - "the queue is derived state, not a synced
    // entity" - so it lives in its own storage key, separate from
    // `members`/STORAGE_KEY, and is never exported/imported/synced itself) ==========
    const CONFLICT_STORAGE_KEY = 'family_health_tracker_v3_conflicts';

    function loadConflictQueue() {
      try {
        const raw = localStorage.getItem(CONFLICT_STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch (e) { return []; }
    }
    function saveConflictQueue(queue) {
      try { localStorage.setItem(CONFLICT_STORAGE_KEY, JSON.stringify(queue)); return true; }
      catch (e) { return false; }
    }
    // Deterministic key per design 1.3/1.4 - (entityId, baseVersion[, field]).
    // Two independent merges (or two chained ones - see MERGE_SYNC_DESIGN.md
    // 2.4's note on re-derived conflicts) that find "the same" disagreement
    // produce the same key, so appending must dedupe on this rather than
    // push raw, or the same conflict could appear more than once.
    function conflictKey(c) {
      return JSON.stringify([c.entityId, c.field || null, c.baseVersion]);
    }
    // Appends new conflicts (deduped) for one member's merge, tagged with
    // enough context for a future queue UI to render without re-deriving
    // anything. Returns how many were genuinely new (not already queued).
    function appendConflicts(memberId, memberName, newConflicts) {
      if (!newConflicts || !newConflicts.length) return 0;
      const queue = loadConflictQueue();
      const existingKeys = new Set(queue.map(conflictKey));
      let added = 0;
      newConflicts.forEach(c => {
        const key = conflictKey(c);
        if (existingKeys.has(key)) return;
        queue.push(Object.assign({ memberId, memberName, detectedAt: nowIso() }, c));
        existingKeys.add(key);
        added++;
      });
      if (added) saveConflictQueue(queue);
      return added;
    }

    // Locates the CURRENT live entity a queued conflict refers to, by
    // walking conflict.path against the live `members` array. Paths look
    // like [memberId, 'records', recordId] or, for nested insurance data,
    // [memberId, 'insurance', 'policies', policyId, 'coverages', coverageId,
    // 'sumInsuredHistory', historyId] - 'insurance' is a plain nested
    // object (no id of its own), everything else is an array keyed by id,
    // so this walks token-by-token rather than assuming strict key/id
    // pairing the whole way. Returns null if anything in the chain no
    // longer exists (member/entity deleted or never matched - the conflict
    // is stale either way and the caller should drop it).
    function resolveConflictEntity(conflict) {
      const m = members.find(x => x.id === conflict.memberId);
      if (!m) return null;
      if (conflict.field) return { kind: 'field', member: m };

      const path = conflict.path || [];
      let node = m;
      let i = 1;
      while (i < path.length) {
        const key = path[i];
        const val = node[key];
        if (Array.isArray(val)) {
          const id = path[i + 1];
          const foundIdx = val.findIndex(x => x.id === id);
          if (foundIdx === -1) return null;
          if (i + 2 >= path.length) {
            return { kind: 'array', containerKey: key, arr: val, idx: foundIdx, entity: val[foundIdx] };
          }
          node = val[foundIdx];
          i += 2;
        } else if (val && typeof val === 'object') {
          node = val; // plain nested object (e.g. 'insurance') - no id to consume
          i += 1;
        } else {
          return null; // malformed/unrecognized path
        }
      }
      return null;
    }

    // Container types whose entities have nested syncable children that
    // are ALREADY correctly merged into the live entity (attachments,
    // sumInsuredHistory, ledger/coverages/riders/surrenderRecords under a
    // policy) - a "keep remote"/"keep both" resolution must only touch the
    // scalar fields actually in dispute for these, never blindly overwrite
    // the whole object, or it would discard that already-merged child data.
    // Sourced from FHSMerge's own exported key lists so this can't drift
    // from what the merge engine actually used to detect the conflict.
    // Types with no entry here (riders, sumInsuredHistory, historyEntries)
    // have no nested children, so a full-object apply is safe for them.
    const CONTAINER_SCALAR_KEYS = {
      records: FHSMerge.RECORD_SCALAR_KEYS,
      customReminders: FHSMerge.REMINDER_SCALAR_KEYS,
      ledger: FHSMerge.LEDGER_SCALAR_KEYS,
      coverages: FHSMerge.COVERAGE_SCALAR_KEYS,
      surrenderRecords: FHSMerge.SURRENDER_SCALAR_KEYS,
      claims: FHSMerge.CLAIM_SCALAR_KEYS,
      policies: FHSMerge.POLICY_SCALAR_KEYS
    };

    // Applies a resolution choice and removes the conflict from the queue.
    // 'local'  - content already showing (conflict-output contract) - just
    //            bump version so this exact tie won't be re-flagged later.
    // 'remote' - apply remote's disputed fields (only those, for container
    //            types - see CONTAINER_SCALAR_KEYS above), then bump.
    // 'both'   - (array-item conflicts only) duplicate remote's full entity
    //            under a fresh id via deepCloneAndRemapIds, insert next to
    //            the original, and still bump the original to settle it.
    function resolveConflict(conflict, choice) {
      const resolved = resolveConflictEntity(conflict);
      if (!resolved) { removeConflictFromQueue(conflict); return; } // already gone (e.g. deleted since) - just drop it

      if (resolved.kind === 'field') {
        const m = resolved.member;
        if (choice === 'remote') m[conflict.field] = conflict.remote;
        if (!m.fieldVersion) m.fieldVersion = freshFieldVersions();
        m.fieldVersion[conflict.field] = (m.fieldVersion[conflict.field] || 1) + 1;
        bumpVersion(m);
      } else {
        const { entity, arr, idx, containerKey } = resolved;
        if (choice === 'remote') {
          const scalarKeys = CONTAINER_SCALAR_KEYS[containerKey];
          if (scalarKeys) {
            scalarKeys.forEach(k => { entity[k] = conflict.remote[k]; });
          } else {
            const id = entity.id;
            Object.assign(entity, conflict.remote, { id });
          }
          bumpVersion(entity);
        } else if (choice === 'both') {
          const dup = deepCloneAndRemapIds(conflict.remote);
          Object.assign(dup, freshSyncMeta());
          arr.splice(idx + 1, 0, dup);
          bumpVersion(entity); // settles the original's side of the tie too
        } else {
          bumpVersion(entity); // 'local' - content unchanged, just settle
        }
      }

      saveData();
      removeConflictFromQueue(conflict);
    }

    function removeConflictFromQueue(conflict) {
      const queue = loadConflictQueue();
      const key = conflictKey(conflict);
      const next = queue.filter(c => conflictKey(c) !== key);
      saveConflictQueue(next);
    }

    // Prunes the persisted queue per design 1.6/1.7: an entry is dropped
    // (not shown) once the local entity's version has moved past its
    // baseVersion (already resolved - by this device or a synced-in
    // resolution from elsewhere), once the entity/member no longer exists,
    // or once any ancestor in its chain is now tombstoned (cascade
    // suppression - a conflict under a deleted policy is meaningless to
    // show). Persists the pruned result so stale entries don't keep
    // reappearing on every call. Returns the list that should actually render.
    function getActiveConflicts() {
      const queue = loadConflictQueue();
      const active = [];
      let changed = false;
      queue.forEach(c => {
        const resolved = resolveConflictEntity(c);
        if (!resolved) { changed = true; return; } // dropped: gone entirely

        if (resolved.kind === 'field') {
          const currentVersion = (resolved.member.fieldVersion || {})[c.field] || 1;
          if (currentVersion > c.baseVersion) { changed = true; return; } // already resolved elsewhere
          active.push(c);
        } else {
          if (resolved.entity.version > c.baseVersion) { changed = true; return; }
          // cascade suppression: walk the path's intermediate array-items
          // for a tombstone (the member itself is checked separately -
          // a tombstoned member's conflicts are equally meaningless).
          if (resolved.member && resolved.member.deletedAt) { changed = true; return; }
          const path = c.path || [];
          let node = members.find(x => x.id === c.memberId);
          let ancestorDeleted = false;
          let i = 1;
          while (node && i < path.length) {
            const key = path[i];
            const val = node[key];
            if (Array.isArray(val)) {
              const id = path[i + 1];
              const item = val.find(x => x.id === id);
              if (!item) break;
              if (item.id !== c.entityId && item.deletedAt) { ancestorDeleted = true; break; }
              node = item; i += 2;
            } else if (val && typeof val === 'object') {
              node = val; i += 1;
            } else break;
          }
          if (ancestorDeleted) { changed = true; return; }
          active.push(c);
        }
      });
      if (changed) saveConflictQueue(active);
      return active;
    }

    async function mergeImportedMembers(normalized) {
      let totalNewConflicts = 0;
      for (const incoming of normalized) {
        const idx = members.findIndex(x => x.id === incoming.id);
        const isUpdate = idx !== -1;
        const label = isUpdate
          ? `Update "${incoming.name}" using this file?\n\nThis merges that member's records, insurance, etc. field-by-field with the imported version - your own edits since the last sync aren't overwritten. Other family members are not affected.`
          : `"${incoming.name}" doesn't match any current family member.\n\nAdd them as a new member from this file?`;
        if (!confirm(label)) continue;
        const previousMembers = members;

        let finalMember, conflicts = [];
        if (isUpdate) {
          // FHSMerge.mergeMembers (merge-engine.js, loaded as its own
          // namespaced global - see that file's header comment for why)
          // is pure - it doesn't touch `members` or IndexedDB itself, just
          // returns the merged result plus whatever conflicts it found.
          const result = FHSMerge.mergeMembers([members[idx]], [incoming]);
          finalMember = result.members[0];
          conflicts = result.conflicts;
        } else {
          finalMember = incoming; // nothing local to merge against
        }

        const [migrated] = await migrateMemberAttachmentsToIdb([finalMember]);
        const nextMembers = [...members];
        if (isUpdate) nextMembers[idx] = migrated; else nextMembers.push(migrated);
        members = nextMembers;
        if (!saveData()) {
          members = previousMembers;
          alert(`Couldn't save the imported data for "${incoming.name}" - storage may be full.`);
          continue;
        }
        totalNewConflicts += appendConflicts(migrated.id, migrated.name, conflicts);
        currentMemberId = migrated.id;
        currentTab = 'overview';
      }
      renderMemberList();
      renderMain();
      updateConflictBadge();
      if (totalNewConflicts > 0) {
        // Nothing was lost - the other side's version is saved in the
        // queue for review (conflict-output contract, design 1.5). The
        // ⚠️ Conflicts button in the header (now visible) opens the
        // review screen built in build order step 5.
        alert(`Import merged. ${totalNewConflicts} item(s) had edits on both sides for the same thing - your device's version was kept for now. Click "⚠️ Conflicts" in the header to review and resolve them.`);
      }
    }

    async function extractJsonFromZip(file) {
      if (typeof JSZip === 'undefined') {
        throw new Error('ZIP support (JSZip) failed to load - check your connection and try again, or extract the ZIP manually and import the .json file inside.');
      }
      const zip = await JSZip.loadAsync(file);
      // Prefer the standard Pack ZIP path, but fall back to any .json in the archive.
      let entry = zip.file('backup/family_health_backup.json');
      if (!entry) {
        const jsonFiles = Object.keys(zip.files).filter(name => name.toLowerCase().endsWith('.json') && !zip.files[name].dir);
        if (jsonFiles.length) entry = zip.file(jsonFiles[0]);
      }
      if (!entry) throw new Error('No backup JSON file found inside this ZIP.');
      return entry.async('string');
    }

    function importData(e) {
      const file = e.target.files[0];
      if (!file) return;
      const isZip = file.name.toLowerCase().endsWith('.zip');

      const handleJsonText = async (jsonText) => {
        let parsed;
        try {
          parsed = JSON.parse(jsonText);
        } catch(err) {
          alert('Invalid file format: ' + err.message);
          e.target.value = '';
          return;
        }

        if (parsed && parsed.encryptedBackup) {
          const decrypted = await promptImportPasscode(parsed);
          if (decrypted === null) { e.target.value = ''; return; } // user cancelled
          try {
            parsed = JSON.parse(decrypted);
          } catch(err) {
            alert('Decryption succeeded but the contents were not valid backup data: ' + err.message);
            e.target.value = '';
            return;
          }
        }

        let envelope;
        try {
          envelope = parseImportEnvelope(parsed);
        } catch(err) {
          alert('Invalid file format: ' + err.message);
          e.target.value = '';
          return;
        }

        let normalized;
        try {
          normalized = normalizeImportedMembers(envelope.rawMembers);
        } catch(err) {
          alert('Invalid file format: ' + err.message);
          e.target.value = '';
          return;
        }

        if (envelope.exportType === 'member') {
          // Single-member export: merge in by id, touching only that member.
          await mergeImportedMembers(normalized);
        } else if (confirm(`Import will replace current ${members.length} members with ${normalized.length} imported member(s). Continue?`)) {
          const previousMembers = members;
          normalized = await migrateMemberAttachmentsToIdb(normalized);
          members = normalized;
          if (!saveData()) { members = previousMembers; e.target.value = ''; return; }
          currentMemberId = null;
          currentTab = 'overview';
          renderMemberList();
          renderMain();
        }
        e.target.value = '';
      };

      if (isZip) {
        extractJsonFromZip(file)
          .then(handleJsonText)
          .catch(err => { alert('Could not read this ZIP: ' + err.message); e.target.value = ''; });
        return;
      }

      const reader = new FileReader();
      reader.onload = (ev) => handleJsonText(ev.target.result);
      reader.readAsText(file);
    }

    // Prompts for the passcode an encrypted export was created with, derives
    // the key using the SALT EMBEDDED IN THE FILE ITSELF (not this device's
    // own Security config) so an encrypted backup can be restored on any
    // device/browser as long as the same passcode is entered.
    let importPasscodeResolver = null;
    function promptImportPasscode(envelope) {
      return new Promise((resolve) => {
        importPasscodeResolver = { resolve, envelope };
        document.getElementById('importPasscodeInput').value = '';
        document.getElementById('importPasscodeError').textContent = '';
        document.getElementById('importPasscodeModal').classList.add('active');
        setTimeout(() => document.getElementById('importPasscodeInput').focus(), 50);
      });
    }
    document.getElementById('btnImportPasscodeSubmit').addEventListener('click', async () => {
      if (!importPasscodeResolver) return;
      const pass = document.getElementById('importPasscodeInput').value;
      const { envelope, resolve } = importPasscodeResolver;
      try {
        // Files exported before this fix (or by the version of the app that
        // was live before this deploy) have no iterVer field at all - treat
        // those as version 1 (this app's original hardcoded 150,000), same
        // convention as cfg.iterVer for the main vault. Using the WRONG
        // iteration count here derives a completely different key from the
        // correct passcode and decryption fails - indistinguishable from an
        // actually-wrong passcode, which is exactly the bug this fixes.
        const iterVer = envelope.iterVer || 1;
        const key = await deriveKeyFromPasscode(pass, envelope.salt, PBKDF2_CONFIGS[iterVer]);
        const decrypted = await decryptText(envelope.payload, key);
        document.getElementById('importPasscodeModal').classList.remove('active');
        importPasscodeResolver = null;
        resolve(decrypted);
      } catch {
        document.getElementById('importPasscodeError').textContent = 'Incorrect passcode.';
      }
    });
    document.getElementById('importPasscodeInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btnImportPasscodeSubmit').click();
    });
    document.getElementById('btnImportPasscodeCancel').addEventListener('click', () => {
      document.getElementById('importPasscodeModal').classList.remove('active');
      if (importPasscodeResolver) { importPasscodeResolver.resolve(null); importPasscodeResolver = null; }
    });

    // ========== PACK ZIP ==========
    async function packZip(encrypt, key, salt, iterVer) {
      if (typeof JSZip === 'undefined') {
        alert('JSZip library failed to load. Check internet connection.');
        return;
      }

      const zip = new JSZip();

      const htmlContent = document.documentElement.outerHTML;
      zip.file('family_health_and_shield.html', htmlContent);

      const inflated = await inflateMembersForExport(members);
      const envelope = buildExportEnvelope(inflated, 'all');
      const backupJson = await buildExportPayload(JSON.stringify(envelope, null, 2), encrypt, key, salt, iterVer);
      zip.file(`backup/family_health_backup${encrypt ? '_encrypted' : ''}.json`, backupJson);

      zip.folder('attachments');

      // Writes one attachment file into the zip. When encrypt is on, the file's
      // full data URL (including its mime header) is sealed with the same
      // AES-GCM key/passcode used for the backup JSON and stored as opaque
      // ciphertext text under a ".enc" suffix - so it is NOT directly openable
      // outside this app, matching the rest of the encrypted backup. When
      // encrypt is off, the original bytes are written as-is, directly openable.
      async function writeAttachmentIntoZip(att) {
        const dataUrl = await resolveAttachmentData(att);
        if (!dataUrl) return false;
        if (encrypt) {
          const sealed = await encryptText(dataUrl, key);
          zip.file(att.path + '.enc', sealed);
        } else {
          const base64 = dataUrl.split(',')[1];
          zip.file(att.path, base64, { base64: true });
        }
        return true;
      }

      // Write actual attachment files into the zip using their real data (from IndexedDB or legacy inline fields).
      let embeddedCount = 0;
      let missingCount = 0;
      for (const m of members) {
        for (const r of (m.records || [])) {
          for (const att of (r.attachments || [])) {
            if (await writeAttachmentIntoZip(att)) embeddedCount++; else missingCount++;
          }
        }
        for (const p of (m.insurance && m.insurance.policies) || []) {
          for (const att of (p.attachments || [])) {
            if (await writeAttachmentIntoZip(att)) embeddedCount++; else missingCount++;
          }
          for (const l of (p.ledger || [])) {
            for (const att of (l.attachments || [])) {
              if (await writeAttachmentIntoZip(att)) embeddedCount++; else missingCount++;
            }
          }
          for (const s of (p.surrenderRecords || [])) {
            for (const att of (s.attachments || [])) {
              if (await writeAttachmentIntoZip(att)) embeddedCount++; else missingCount++;
            }
          }
        }
      }

      const instructions = `Family Health & Shield - Backup Guide
=====================================

Folder Structure:
├── family_health_and_shield.html ← Main app, double-click to open
├── backup/
│   └── family_health_backup${encrypt ? '_encrypted' : ''}.json ← Data backup${encrypt ? ' (ENCRYPTED - needs the passcode to import)' : ''}
└── attachments/                  ← Your embedded photos/PDFs, already included${encrypt ? ' (ENCRYPTED - each file ends in .enc)' : ''}

How to use:
1. Extract the ZIP to any location
2. Double-click family_health_and_shield.html to open
3. Click "Import" and select backup/family_health_backup${encrypt ? '_encrypted' : ''}.json${encrypt ? ' - you will be asked for the passcode' : ''}
   (Importing the JSON alone fully restores every photo/PDF inside the app - the attachments/ folder is only a manual/browsable copy and is never needed for import.)

Note:
${missingCount > 0
  ? `- ${embeddedCount} attachment(s) were embedded automatically. ${missingCount} older attachment(s) saved before file embedding was added could NOT be included - only their reference paths exist. Re-add those on their records to embed them.`
  : `- All ${embeddedCount} attachment(s) were embedded automatically - no manual copying needed.`}
${encrypt ? `- Full encryption: the backup JSON AND every file inside attachments/ are encrypted with the same passcode. Files in attachments/ are saved as "<original name>.enc" and are opaque ciphertext - they will NOT open directly as photos/PDFs outside this app. To view a photo/PDF, import backup/family_health_backup_encrypted.json into the app and enter the passcode; the app decrypts everything for you there.` : '- No encryption was selected for this backup: the JSON and every file inside attachments/ are plain and directly openable. Store this ZIP somewhere private.'}
`;
      zip.file('README.txt', instructions);

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `FamilyHealthShield_Backup_${localDateStr()}${encrypt ? '_encrypted' : ''}.zip`;
      a.click();
      URL.revokeObjectURL(url);

      alert(`📦 ZIP backup downloaded!\n\n${embeddedCount} attachment file(s) were packed in automatically` +
            (encrypt ? ' and fully encrypted (backup JSON + every attachments/ file).' : ' (plaintext, directly openable).') +
            (missingCount > 0 ? `\n\n${missingCount} older attachment(s) had no embedded data and were skipped - see README.txt.` : ''));
    }

    // ========== START ==========
    window.addEventListener('DOMContentLoaded', init);

    // ================= INSURANCE MODULE =================
    // Data lives under each member as m.insurance = { policies: [...], claims: [...] }
    // Reuses host's `members`, `currentMemberId`, `saveData()`, `escapeHtml()`, `renderMain()`.

    let insCurrentSubTab = 'overview';
    let insEditingPolicyId = null;
    let insEditingClaimId = null;
    let insTempRiders = [];
    let insTempCoverages = [];
    let insTempAttachments = [];
    let insTempLedgerAttachments = [];
    let insTempSurrenderAttachments = [];
    let insCurrentLedgerPolicyId = null;
    let insCurrentSurrenderPolicyId = null;
    let insCurrentSumHistoryPolicyId = null;
    let insCurrentSumHistoryCoverageId = null;
    let insCurrentReportMemberId = null;
    let insCurrentPolicyMemberBirth = null;

    const INS_COVERAGE_TYPES = [
      { value: 'Life', label: '🧬 Life (Whole Life)' },
      { value: 'Term Life', label: '⏳ Term Life' },
      { value: 'Health/Medical', label: '🏥 Health / Medical' },
      { value: 'Critical Illness', label: '⚕️ Critical Illness' },
      { value: 'Accident', label: '🩹 Personal Accident' },
      { value: 'Car', label: '🚗 Car' },
      { value: 'Home', label: '🏠 Home / Fire' },
      { value: 'Travel', label: '✈️ Travel' },
      { value: 'Other', label: '📄 Other' }
    ];
    function insCoverageTypeOptionsHtml(selected) {
      return INS_COVERAGE_TYPES.map(t => `<option value="${t.value}" ${t.value === selected ? 'selected' : ''}>${t.label}</option>`).join('');
    }

    function insEnsureData(m) {
      if (!m.insurance) {
        m.insurance = { policies: [], claims: [] };
      }
      if (!m.insurance.policies) m.insurance.policies = [];
      if (!m.insurance.claims) m.insurance.claims = [];
    }

    function insFmtMoney(n) {
      if (n === undefined || n === null || n === '') return '--';
      return 'RM ' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function insDaysUntil(dateStr) {
      if (!dateStr) return null;
      const d = new Date(dateStr); const now = new Date();
      d.setHours(0,0,0,0); now.setHours(0,0,0,0);
      return Math.round((d - now) / 86400000);
    }
    function insUid() { return 'ins' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

    // Age of the member on a given target date (e.g. policy expiry/start), using their DOB from the Health Tracker record
    function insAgeAtDate(birthStr, targetDateStr) {
      if (!birthStr || !targetDateStr) return null;
      const birth = new Date(birthStr);
      const target = new Date(targetDateStr);
      if (isNaN(birth) || isNaN(target)) return null;
      let age = target.getFullYear() - birth.getFullYear();
      const hasHadBirthdayYet = (target.getMonth() > birth.getMonth()) ||
        (target.getMonth() === birth.getMonth() && target.getDate() >= birth.getDate());
      if (!hasHadBirthdayYet) age--;
      return age >= 0 ? age : null;
    }
    function insUpdateDateAgeHint(inputId, hintId) {
      const val = document.getElementById(inputId).value;
      const hintEl = document.getElementById(hintId);
      const age = insAgeAtDate(insCurrentPolicyMemberBirth, val);
      hintEl.textContent = age !== null ? `Member will be age ${age} on this date` : '';
    }

    function insAnnualPremium(m) {
      const mult = { Monthly: 12, Quarterly: 4, Yearly: 1, Single: 0 };
      return live(m.insurance.policies).filter(p => p.status !== 'Discontinued').reduce((sum, p) => sum + (Number(p.premium)||0) * (mult[p.frequency] ?? 1), 0);
    }

    const INS_TYPE_DISPLAY_OVERRIDES = { 'Home': 'Home/Fire', 'Accident': 'Personal Accident' };
    function insCoverageLabel(c) {
      if (c.type === 'Other' && c.customLabel) return c.customLabel;
      return INS_TYPE_DISPLAY_OVERRIDES[c.type] || c.type;
    }
    function insPolicyTypeSummary(p) {
      const types = (p.coverages || []).map(c => insCoverageLabel(c));
      return types.length ? types.join(' + ') : 'Policy';
    }

    function insEffectiveSumInsured(c) {
      const liveHistory = live(c.sumInsuredHistory || []);
      if (c.reducing && liveHistory.length) {
        const latest = [...liveHistory].sort((a,b) => new Date(b.date) - new Date(a.date))[0];
        return Number(latest.amount) || 0;
      }
      return Number(c.sumInsured) || 0;
    }

    function insNextAnniversaryOnOrAfterToday(startDateStr, minYear) {
      if (!startDateStr) return null;
      const start = new Date(startDateStr);
      if (isNaN(start)) return null;
      const today = new Date(); today.setHours(0,0,0,0);
      let year = Math.max(minYear, 1);
      while (true) {
        const d = new Date(start);
        d.setFullYear(start.getFullYear() + year);
        if (d >= today) return localDateStr(d);
        year++;
        if (year > minYear + 200) return null;
      }
    }
    function insNextPayoutInfo(p) {
      if (!p.payout || !p.payout.startYear) return null;
      const date = insNextAnniversaryOnOrAfterToday(p.start, Number(p.payout.startYear));
      if (!date) return null;
      const amount = (Number(p.payout.baseAmount) || 0) * (Number(p.payout.percent) || 0) / 100;
      return { date, amount };
    }

    function insGenerateReminders(m) {
      const reminders = [];
      m.insurance.policies.filter(p => p.status !== 'Discontinued' && !p.deletedAt).forEach(p => {
        const d = insDaysUntil(p.expiry);
        if (d !== null) {
          reminders.push({
            title: `${insPolicyTypeSummary(p)} — ${p.provider || 'Policy'} due`,
            date: p.expiry,
            days: d,
            status: d < 0 ? 'overdue' : d <= 30 ? 'upcoming' : 'ok'
          });
        }
        (p.riders || []).forEach(r => {
          const rd = insDaysUntil(r.dueDate);
          if (rd === null) return;
          reminders.push({
            title: `Rider — ${r.description || 'Rider'} (${p.provider || insPolicyTypeSummary(p)})`,
            date: r.dueDate,
            days: rd,
            status: rd < 0 ? 'overdue' : rd <= 30 ? 'upcoming' : 'ok'
          });
        });
        (p.coverages || []).forEach(c => {
          if (!c.expiry) return; // no coverage-specific expiry set - covered by the policy-level reminder above
          const cd = insDaysUntil(c.expiry);
          if (cd === null) return;
          reminders.push({
            title: `${insCoverageLabel(c)} — ${p.provider || insPolicyTypeSummary(p)} due`,
            date: c.expiry,
            days: cd,
            status: cd < 0 ? 'overdue' : cd <= 30 ? 'upcoming' : 'ok'
          });
        });
        const payout = insNextPayoutInfo(p);
        if (payout) {
          const pd = insDaysUntil(payout.date);
          reminders.push({
            title: `Payout — ${p.provider || insPolicyTypeSummary(p)} (~${insFmtMoney(payout.amount)})`,
            date: payout.date,
            days: pd,
            status: pd < 0 ? 'overdue' : pd <= 30 ? 'upcoming' : 'ok'
          });
        }
      });
      return reminders.filter(r => r.days >= -60 && r.days <= 60).sort((a,b) => a.days - b.days);
    }

    function insCoverageClaimedTotal(m, policyId, coverageId) {
      return m.insurance.claims.filter(c => c.policyId === policyId && c.coverageId === coverageId).reduce((s,c) => s + (Number(c.amountPaid)||0), 0);
    }
    function insLatestSurrenderTotal(p) {
      const recs = live(p.surrenderRecords || []);
      if (!recs.length) return null;
      const latest = [...recs].sort((a,b) => new Date(b.date) - new Date(a.date))[0];
      return insSurrenderRecordTotal(latest);
    }
    function insSurrenderRecordTotal(r) {
      return (Number(r.accumulatedBonus)||0) + (Number(r.dividend)||0) + (Number(r.guaranteedCashValue)||0) + (Number(r.nonGuaranteedValue)||0);
    }
    function insStatusTagClass(status) {
      return { Filed: 'tag-gray', Processing: 'tag-yellow', Approved: 'tag-green', Rejected: 'tag-red', Paid: 'tag-green' }[status] || 'tag-gray';
    }
    function insRenderReminderListHtml(reminders) {
      return `<div class="reminder-list">${reminders.map(r => `
        <div class="reminder-item">
          <div class="reminder-icon ${r.status}">${r.status === 'overdue' ? '🔴' : r.status === 'upcoming' ? '🟡' : '🟢'}</div>
          <div class="reminder-text">
            <div class="reminder-title">${escapeHtml(r.title)}</div>
            <div class="reminder-date">${escapeHtml(r.date)} · ${r.days < 0 ? 'Overdue ' + Math.abs(r.days) + ' days' : r.days === 0 ? 'Due today' : 'In ' + r.days + ' days'}</div>
          </div>
        </div>`).join('')}</div>`;
    }

    // ===== Top-level entry point: called from host's renderMain() when currentTab === 'insurance' =====
    function insRenderInsuranceTab(m) {
      insEnsureData(m);
      const reminders = insGenerateReminders(m);
      return `
        <div class="s-10cf5d38">
          <button class="btn btn-secondary btn-sm" id="insBtnAddClaim">+ Add Claim</button>
        </div>
        <div class="tabs">
          <button class="tab ${insCurrentSubTab === 'overview' ? 'active' : ''}" data-instab="overview">📊 Overview</button>
          <button class="tab ${insCurrentSubTab === 'policies' ? 'active' : ''}" data-instab="policies">📄 Policies</button>
          <button class="tab ${insCurrentSubTab === 'claims' ? 'active' : ''}" data-instab="claims">🧾 Claims</button>
          <button class="tab ${insCurrentSubTab === 'reminders' ? 'active' : ''}" data-instab="reminders">⏰ Reminders</button>
          <button class="tab ${insCurrentSubTab === 'discontinued' ? 'active' : ''}" data-instab="discontinued">🚫 Discontinued</button>
        </div>
        ${insCurrentSubTab === 'overview' ? insRenderOverview(m, reminders) : ''}
        ${insCurrentSubTab === 'policies' ? insRenderPolicies(m) : ''}
        ${insCurrentSubTab === 'claims' ? insRenderClaims(m) : ''}
        ${insCurrentSubTab === 'reminders' ? insRenderRemindersTab(reminders) : ''}
        ${insCurrentSubTab === 'discontinued' ? insRenderDiscontinued(m) : ''}
      `;
    }

    function insRenderOverview(m, reminders) {
      const upcoming = reminders.filter(r => r.status !== 'ok').length;
      const totalClaims = live(m.insurance.claims).length;
      const activePolicies = live(m.insurance.policies).filter(p => p.status !== 'Discontinued');

      const insuredByType = {};
      const assetByType = {};
      const ASSET_TYPES = ['Home', 'Car'];
      let totalMedicalAnnualLimit = 0;
      let totalMedicalLifetimeRemaining = 0;
      activePolicies.forEach(p => (p.coverages||[]).forEach(c => {
        if (c.type === 'Health/Medical') {
          if (c.annualLimit) totalMedicalAnnualLimit += Number(c.annualLimit) || 0;
          if (c.lifetimeLimit) {
            const remaining = Number(c.lifetimeLimit) - insCoverageClaimedTotal(m, p.id, c.id);
            totalMedicalLifetimeRemaining += remaining;
          }
          return; // Health/Medical is limit-based, not sum-insured-based - excluded from the sum insured breakdown below
        }
        const amt = insEffectiveSumInsured(c);
        if (!amt) return;
        if (ASSET_TYPES.includes(c.type)) {
          assetByType[insCoverageLabel(c)] = (assetByType[insCoverageLabel(c)] || 0) + amt;
        } else {
          insuredByType[insCoverageLabel(c)] = (insuredByType[insCoverageLabel(c)] || 0) + amt;
        }
      }));
      const totalInsured = Object.values(insuredByType).reduce((s,v) => s+v, 0);
      const totalAssetInsured = Object.values(assetByType).reduce((s,v) => s+v, 0);
      const totalSurrender = activePolicies.reduce((s,p) => s + (insLatestSurrenderTotal(p) || 0), 0);
      const hasMedical = totalMedicalAnnualLimit > 0 || totalMedicalLifetimeRemaining > 0;
      const hasAssets = Object.keys(assetByType).length > 0;

      return `
        <div class="card s-81f3194f">
          <div class="s-d12fd7e2">Generate a printable summary of this family member's insurance records.</div>
          <button class="btn btn-primary btn-sm" id="insBtnOpenReport">🖨️ View / Print Report</button>
        </div>
        <div class="card">
          <div class="card-title">📊 Summary</div>
          <div class="stats-grid">
            <div class="stat-box"><div class="stat-value">${activePolicies.length}</div><div class="stat-label">Active Policies</div></div>
            <div class="stat-box"><div class="stat-value">${insFmtMoney(insAnnualPremium(m))}</div><div class="stat-label">Premium / Year</div></div>
            <div class="stat-box"><div class="stat-value">${insFmtMoney(totalSurrender)}</div><div class="stat-label">Total Surrender Value</div></div>
            <div class="stat-box"><div class="stat-value">${upcoming}</div><div class="stat-label">Due Soon / Overdue</div></div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">🛡️ Total Insured — ${insFmtMoney(totalInsured)}</div>
          ${Object.keys(insuredByType).length ? Object.entries(insuredByType).map(([type, amt]) => `
            <div class="s-5911b194">
              <span>${escapeHtml(type)}</span><span class="s-a5d2baa1">${insFmtMoney(amt)}</span>
            </div>`).join('') : '<p class="s-51f2817c">No sum insured recorded on active policies yet.</p>'}
        </div>
        ${hasAssets ? `
        <div class="card">
          <div class="card-title">🏠 Property & Asset Insured — ${insFmtMoney(totalAssetInsured)}</div>
          ${Object.entries(assetByType).map(([type, amt]) => `
            <div class="s-5911b194">
              <span>${escapeHtml(type)}</span><span class="s-a5d2baa1">${insFmtMoney(amt)}</span>
            </div>`).join('')}
        </div>` : ''}
        ${hasMedical ? `
        <div class="card">
          <div class="card-title">🏥 Health/Medical Limits</div>
          <div class="stats-grid">
            <div class="stat-box"><div class="stat-value s-e2151554">${insFmtMoney(totalMedicalAnnualLimit)}</div><div class="stat-label">Total Annual Limit</div></div>
            <div class="stat-box"><div class="stat-value s-e2151554">${insFmtMoney(totalMedicalLifetimeRemaining)}</div><div class="stat-label">Total Lifetime Limit Remaining</div></div>
          </div>
        </div>` : ''}
        <div class="card">
          <div class="card-title">⏰ Upcoming Reminders</div>
          ${reminders.slice(0,4).length ? insRenderReminderListHtml(reminders.slice(0,4)) : '<p class="s-51f2817c">Nothing due within the next 60 days.</p>'}
        </div>
        <div class="card">
          <div class="card-title">🧾 Recent Claims</div>
          ${totalClaims ? m.insurance.claims.slice(0,3).map(c => insRenderClaimSummaryLine(m,c)).join('') : '<p class="s-51f2817c">No claims filed yet.</p>'}
        </div>
      `;
    }

    function insRenderClaimSummaryLine(m, c) {
      const p = m.insurance.policies.find(x => x.id === c.policyId);
      const cov = p ? (p.coverages||[]).find(x => x.id === c.coverageId) : null;
      return `<div class="s-b7fd2bd9">
        <span>${escapeHtml(cov ? insCoverageLabel(cov) : (p ? insPolicyTypeSummary(p) : 'Unknown policy'))} ${p && p.provider ? '— ' + escapeHtml(p.provider) : ''}</span>
        <span>${escapeHtml(c.date||'')} · ${escapeHtml(c.status)}</span>
      </div>`;
    }

    function insRenderPolicies(m) {
      const active = live(m.insurance.policies).filter(p => p.status !== 'Discontinued');
      return `
        <div class="card">
          <div class="card-title">📄 Policies</div>
          ${active.length ? active.map(p => insRenderPolicyCard(m, p, false)).join('') : '<p class="s-51f2817c">No active policies yet. Click "+ Add Policy" above.</p>'}
        </div>
      `;
    }

    function insRenderDiscontinued(m) {
      const discontinued = live(m.insurance.policies).filter(p => p.status === 'Discontinued');
      return `
        <div class="card">
          <div class="card-title">🚫 Discontinued / Terminated Policies</div>
          <div class="s-06d0d891">Kept separately for record-keeping — excluded from premium, insured, and reminder totals.</div>
          ${discontinued.length ? discontinued.map(p => insRenderPolicyCard(m, p, true)).join('') : '<p class="s-51f2817c">No discontinued or terminated policies.</p>'}
        </div>
      `;
    }

    function insRenderPolicyCard(m, p, inDiscontinuedTab) {
      const d = insDaysUntil(p.expiry);
      const tagClass = d === null ? 'tag-gray' : d < 0 ? 'tag-red' : d <= 30 ? 'tag-yellow' : 'tag-green';
      const tagText = d === null ? 'No expiry set' : d < 0 ? `Overdue ${Math.abs(d)}d` : d === 0 ? 'Due today' : `Due in ${d}d`;
      const surrenderTotal = insLatestSurrenderTotal(p);
      const coverages = live(p.coverages || []);
      const payout = p.payout && p.payout.startYear ? insNextPayoutInfo(p) : null;
      return `
        <div class="policy-card">
          <div class="policy-top">
            <div>
              <div class="policy-title">${p.provider ? escapeHtml(p.provider) : 'Policy'}</div>
              <div class="policy-sub">${escapeHtml(p.number || 'No policy number')} <span class="s-6a87be61">· ${escapeHtml(insPolicyTypeSummary(p))}</span></div>
            </div>
            <div class="s-4ca7474c">
              ${inDiscontinuedTab ? '<span class="tag tag-gray">🚫 Discontinued</span>' : `<span class="tag ${tagClass}">${tagText}</span>`}
              <div class="policy-actions">
                ${inDiscontinuedTab ? `<span data-ins-reactivate-policy="${escapeHtml(p.id)}" title="Reactivate">🔄</span>` : ''}
                <span data-ins-edit-policy="${escapeHtml(p.id)}">✏️</span>
                <span data-ins-delete-policy="${escapeHtml(p.id)}">🗑️</span>
              </div>
            </div>
          </div>
          <div class="policy-grid">
            <div><div class="policy-field-label">Premium</div><div class="policy-field-value">${insFmtMoney(p.premium)} / ${escapeHtml(p.frequency)}</div></div>
            <div><div class="policy-field-label">Start</div><div class="policy-field-value">${escapeHtml(p.start || '--')}${p.start && insAgeAtDate(m.birth, p.start) !== null ? ` <span class="s-fb01568b">(age ${insAgeAtDate(m.birth, p.start)})</span>` : ''}</div></div>
            <div><div class="policy-field-label">Expiry</div><div class="policy-field-value">${escapeHtml(p.expiry || '--')}${p.expiry && insAgeAtDate(m.birth, p.expiry) !== null ? ` <span class="s-fb01568b">(age ${insAgeAtDate(m.birth, p.expiry)})</span>` : ''}</div></div>
          </div>
          ${coverages.length ? `<div class="s-097e6af4">${coverages.map(c => insRenderCoverageSummary(m, p, c)).join('')}</div>` : '<p class="s-e1b40251">No coverage details added yet — click ✏️ to add.</p>'}
          ${payout ? `<div class="s-406b76fd">🎉 Cashback benefit: ${p.payout.percent}% of ${insFmtMoney(p.payout.baseAmount)} · next payout ~${insFmtMoney(payout.amount)} on ${escapeHtml(payout.date)}</div>` : ''}
          ${p.premiumPaidByBonus ? `<div class="s-e6bec453">💰 Premium currently paid via Accumulated Cash Bonus${p.premiumPaidByBonusSince ? ' · since ' + escapeHtml(p.premiumPaidByBonusSince) : ''}</div>` : ''}
          ${(() => { const liveAtts = live(p.attachments || []); return liveAtts.length ? `<div class="s-eae4831c">${liveAtts.map((att, idx) => `<span class="tag tag-gray s-58aba575" data-ins-open-attachment="${escapeHtml(p.id)}" data-ins-att-idx="${idx}">${att.type === 'image' ? '🖼️' : '📄'} ${escapeHtml(att.name)}</span>`).join('')}</div>` : ''; })()}
          ${p.notes ? `<div class="s-ca2edd98">${escapeHtml(p.notes)}</div>` : ''}
          ${(() => { const liveRiders = live(p.riders || []); return liveRiders.length ? `<div class="s-eae4831c">${liveRiders.map(r => {
            const rd = insDaysUntil(r.dueDate);
            const isExpired = rd !== null && rd < 0;
            const rc = rd === null ? 'tag-gray' : isExpired ? 'tag-red' : rd <= 30 ? 'tag-yellow' : 'tag-green';
            const icon = isExpired ? '🚫' : '🎗';
            const label = isExpired
              ? `${escapeHtml(r.description)} · Expired ${escapeHtml(r.dueDate||'')}`
              : `${escapeHtml(r.description)}${r.dueDate ? ' · ' + escapeHtml(r.dueDate) : ''}`;
            return `<span class="tag ${rc}" title="${isExpired ? 'Expired on' : 'Due'} ${escapeHtml(r.dueDate||'--')}">${icon} ${label}</span>`;
          }).join('')}</div>` : ''; })()}
          <div class="s-79744520">
            <button class="btn btn-secondary btn-sm" data-ins-open-ledger="${escapeHtml(p.id)}">📒 Ledger (${live(p.ledger||[]).length})</button>
            ${surrenderTotal ? `<button class="btn btn-secondary btn-sm" data-ins-open-surrender="${escapeHtml(p.id)}">💰 Surrender Value: ${insFmtMoney(surrenderTotal)}</button>` : `<span data-ins-open-surrender="${escapeHtml(p.id)}" class="s-41b07b38">+ Track Surrender Value</span>`}
            <button class="btn btn-secondary btn-sm" data-ins-open-report="${escapeHtml(p.id)}">🖨️ View / Print</button>
          </div>
        </div>
      `;
    }

    function insRenderCoverageSummary(m, p, c) {
      const isMedical = c.type === 'Health/Medical';
      const claimedTotal = isMedical ? insCoverageClaimedTotal(m, p.id, c.id) : 0;
      const remainingLifetime = (isMedical && c.lifetimeLimit) ? (Number(c.lifetimeLimit) - claimedTotal) : null;
      const currentSum = insEffectiveSumInsured(c);
      const covD = c.expiry ? insDaysUntil(c.expiry) : null;
      const covTagClass = covD === null ? '' : covD < 0 ? 'tag-red' : covD <= 30 ? 'tag-yellow' : 'tag-green';
      return `
        <div class="s-30ddb801">
          <div class="s-afb018e5">
            <span class="tag tag-gray">${escapeHtml(insCoverageLabel(c))}${c.reducing ? ' 📉 Reducing' : ''}</span>
            ${currentSum ? `<span class="s-c0ec2360">${insFmtMoney(currentSum)}</span>` : ''}
          </div>
          ${c.expiry ? `<div class="s-ff6eee77"><span class="tag ${covTagClass}" title="This coverage's own expiry differs from the policy's overall expiry">🗓️ Expires ${escapeHtml(c.expiry)}</span></div>` : ''}
          ${isMedical && (c.lifetimeLimit || c.annualLimit) ? `
          <div class="policy-grid s-d79ce2bc">
            ${c.annualLimit ? `<div><div class="policy-field-label">Annual Limit</div><div class="policy-field-value">${insFmtMoney(c.annualLimit)}</div></div>` : ''}
            ${c.lifetimeLimit ? `<div><div class="policy-field-label">Lifetime Limit Remaining</div><div class="policy-field-value">${insFmtMoney(remainingLifetime)} <span class="s-5594ca44">/ ${insFmtMoney(c.lifetimeLimit)}</span></div></div>` : ''}
          </div>` : ''}
          ${c.reducing ? `<div class="s-d79ce2bc"><span data-ins-open-sumhistory="${escapeHtml(p.id)}" data-ins-cov-id="${escapeHtml(c.id)}" class="s-c0623ab3">📉 View / Update Sum Insured History (${live(c.sumInsuredHistory||[]).length})</span></div>` : ''}
        </div>
      `;
    }

    function insRenderClaims(m) {
      return `
        <div class="card">
          <div class="card-title">🧾 Claims</div>
          ${live(m.insurance.claims).length ? live(m.insurance.claims).map(c => insRenderClaimCard(m, c)).join('') : '<p class="s-51f2817c">No claims filed yet.</p>'}
        </div>
      `;
    }

    function insRenderClaimCard(m, c) {
      const p = m.insurance.policies.find(x => x.id === c.policyId);
      const cov = p ? (p.coverages||[]).find(x => x.id === c.coverageId) : null;
      const label = cov ? insCoverageLabel(cov) : (p ? insPolicyTypeSummary(p) : 'Unknown policy');
      return `
        <div class="policy-card">
          <div class="policy-top">
            <div>
              <div class="policy-title">${escapeHtml(label)}${p && p.provider ? ' — ' + escapeHtml(p.provider) : ''}</div>
              <div class="policy-sub">Filed ${escapeHtml(c.date || '--')}${p ? ' · ' + escapeHtml(p.number || '') : ''}</div>
            </div>
            <div class="s-4ca7474c">
              <span class="tag ${insStatusTagClass(c.status)}">${escapeHtml(c.status)}</span>
              <div class="policy-actions">
                <span data-ins-edit-claim="${escapeHtml(c.id)}">✏️</span>
                <span data-ins-delete-claim="${escapeHtml(c.id)}">🗑️</span>
              </div>
            </div>
          </div>
          <div class="policy-grid">
            <div><div class="policy-field-label">Claimed</div><div class="policy-field-value">${insFmtMoney(c.amountClaimed)}</div></div>
            <div><div class="policy-field-label">Paid Out</div><div class="policy-field-value">${insFmtMoney(c.amountPaid)}</div></div>
          </div>
          ${c.details ? `<div class="s-ca2edd98">${escapeHtml(c.details)}</div>` : ''}
        </div>
      `;
    }

    function insRenderRemindersTab(reminders) {
      return `<div class="card"><div class="card-title">⏰ All Reminders</div><div class="s-afed93ca">Showing items due within 60 days (including overdue).</div>${reminders.length ? insRenderReminderListHtml(reminders) : '<p class="s-51f2817c">Nothing due within the next 60 days.</p>'}</div>`;
    }

    // ===== Bind all insurance interactive elements — called at the end of host's renderMain() =====
    function insBindAll() {
      const m = members.find(x => x.id === currentMemberId);
      if (!m) return;

      document.querySelectorAll('[data-instab]').forEach(el => el.addEventListener('click', () => { insCurrentSubTab = el.dataset.instab; renderMain(); }));

      const btnAddClaim = document.getElementById('insBtnAddClaim');
      if (btnAddClaim) btnAddClaim.addEventListener('click', () => insOpenClaimModal(null));
      const btnOpenReport = document.getElementById('insBtnOpenReport');
      if (btnOpenReport) btnOpenReport.addEventListener('click', () => insOpenReportModal(m.id));

      document.querySelectorAll('[data-ins-edit-policy]').forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); insOpenPolicyModal(el.dataset.insEditPolicy); }));
      document.querySelectorAll('[data-ins-delete-policy]').forEach(el => el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm('Delete this policy?')) return;
        const mm = members.find(x => x.id === currentMemberId);
        const p = mm.insurance.policies.find(x => x.id === el.dataset.insDeletePolicy);
        if (p) tombstone(p);
        // Claims aren't nested under their policy in the data model (linked
        // via policyId, not containment), so tombstone dominance can't be
        // derived from an ancestor chain here - explicitly tombstone each
        // affected claim too, mirroring the cascade the old physical-delete
        // code did.
        (mm.insurance.claims || []).filter(c => c.policyId === el.dataset.insDeletePolicy).forEach(tombstone);
        saveData(); renderMain();
      }));
      document.querySelectorAll('[data-ins-reactivate-policy]').forEach(el => el.addEventListener('click', (e) => {
        e.stopPropagation();
        const mm = members.find(x => x.id === currentMemberId);
        const p = mm.insurance.policies.find(x => x.id === el.dataset.insReactivatePolicy);
        p.status = 'Active';
        bumpVersion(p);
        saveData(); renderMain();
      }));
      document.querySelectorAll('[data-ins-open-ledger]').forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); insOpenLedgerModal(el.dataset.insOpenLedger); }));
      document.querySelectorAll('[data-ins-open-surrender]').forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); insOpenSurrenderModal(el.dataset.insOpenSurrender); }));
      document.querySelectorAll('[data-ins-open-report]').forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); insOpenReportModal(m.id, el.dataset.insOpenReport); }));
      document.querySelectorAll('[data-ins-open-attachment]').forEach(el => el.addEventListener('click', (e) => {
        e.stopPropagation();
        const p = m.insurance.policies.find(x => x.id === el.dataset.insOpenAttachment);
        const att = p ? live(p.attachments || [])[parseInt(el.dataset.insAttIdx)] : null;
        openAttachment(att);
      }));
      document.querySelectorAll('[data-ins-open-sumhistory]').forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); insOpenSumHistoryModal(el.dataset.insOpenSumhistory, el.dataset.insCovId); }));
      document.querySelectorAll('[data-ins-edit-claim]').forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); insOpenClaimModal(el.dataset.insEditClaim); }));
      document.querySelectorAll('[data-ins-delete-claim]').forEach(el => el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm('Delete this claim?')) return;
        const mm = members.find(x => x.id === currentMemberId);
        const c = mm.insurance.claims.find(x => x.id === el.dataset.insDeleteClaim);
        if (c) tombstone(c);
        saveData(); renderMain();
      }));
    }

    // ===== Policy modal =====
    function insOpenPolicyModal(id) {
      insEditingPolicyId = id || null;
      const m = members.find(x => x.id === currentMemberId);
      if (!m) { alert('Select or add a family member first'); return; }
      insEnsureData(m);
      const p = id ? m.insurance.policies.find(x => x.id === id) : null;
      document.getElementById('insPolicyModalTitle').textContent = id ? 'Edit Policy' : 'Add Policy';
      document.getElementById('insPStatus').value = p && p.status ? p.status : 'Active';
      document.getElementById('insPProvider').value = p ? p.provider : '';
      document.getElementById('insPNumber').value = p ? p.number : '';
      document.getElementById('insPPremium').value = p ? p.premium : '';
      document.getElementById('insPFrequency').value = p ? p.frequency : 'Yearly';
      document.getElementById('insPStart').value = p ? p.start : '';
      document.getElementById('insPExpiry').value = p ? p.expiry : '';
      insCurrentPolicyMemberBirth = m.birth || null;
      insUpdateDateAgeHint('insPStart', 'insPStartAgeHint');
      insUpdateDateAgeHint('insPExpiry', 'insPExpiryAgeHint');
      document.getElementById('insPNotes').value = p ? p.notes : '';
      const payoutEnabled = !!(p && p.payout && p.payout.startYear);
      document.getElementById('insPPayoutEnabled').checked = payoutEnabled;
      document.getElementById('insPayoutFields').style.display = payoutEnabled ? 'block' : 'none';
      document.getElementById('insPPayoutStartYear').value = payoutEnabled ? p.payout.startYear : '';
      document.getElementById('insPPayoutPercent').value = payoutEnabled ? p.payout.percent : '';
      document.getElementById('insPPayoutBase').value = payoutEnabled ? p.payout.baseAmount : '';
      const bonusPaidEnabled = !!(p && p.premiumPaidByBonus);
      document.getElementById('insPBonusPaidEnabled').checked = bonusPaidEnabled;
      document.getElementById('insBonusPaidFields').style.display = bonusPaidEnabled ? 'block' : 'none';
      document.getElementById('insPBonusPaidSince').value = bonusPaidEnabled ? (p.premiumPaidByBonusSince || '') : '';
      insTempRiders = p && p.riders ? JSON.parse(JSON.stringify(live(p.riders))) : [];
      insTempCoverages = p && p.coverages && live(p.coverages).length ? JSON.parse(JSON.stringify(live(p.coverages))) : [{ id: insUid(), type: 'Life', sumInsured: '', lifetimeLimit: '', annualLimit: '', reducing: false, expiry: '' }];
      insTempAttachments = p && p.attachments ? live(p.attachments).map(a => ({ ...a })) : [];
      insRenderRidersRows();
      insRenderCoverageRows();
      insRenderAttachmentPreview();
      document.getElementById('insPolicyModal').classList.add('active');
    }
    document.getElementById('insPStart').addEventListener('input', () => insUpdateDateAgeHint('insPStart', 'insPStartAgeHint'));
    document.getElementById('insPExpiry').addEventListener('input', () => insUpdateDateAgeHint('insPExpiry', 'insPExpiryAgeHint'));
    document.getElementById('insPPayoutEnabled').addEventListener('change', (e) => {
      document.getElementById('insPayoutFields').style.display = e.target.checked ? 'block' : 'none';
    });
    document.getElementById('insPBonusPaidEnabled').addEventListener('change', (e) => {
      document.getElementById('insBonusPaidFields').style.display = e.target.checked ? 'block' : 'none';
    });

    function insRenderCoverageRows() {
      const container = document.getElementById('insCoveragesList');
      container.innerHTML = insTempCoverages.map((c, idx) => `
        <div data-ins-coverage-row="${idx}" class="s-a4bf86ef">
          <div class="form-row">
            <select class="form-select" data-ins-cov-type="${idx}">${insCoverageTypeOptionsHtml(c.type)}</select>
            <input class="form-input" type="number" placeholder="Sum Insured" value="${escapeHtml(c.sumInsured ?? '')}" data-ins-cov-sum="${idx}">
          </div>
          <div data-ins-cov-customlabel-row="${idx}" class="s-d79ce2bc ${c.type === 'Other' ? '' : 's-hidden'}">
            <input class="form-input" placeholder="Name this coverage (e.g. Pet, Home Contents)" value="${escapeHtml(c.customLabel ?? '')}" data-ins-cov-customlabel="${idx}">
          </div>
          <div class="form-row s-d79ce2bc ${c.type === 'Health/Medical' ? '' : 's-hidden'}" data-ins-cov-limit-row="${idx}">
            <input class="form-input" type="number" placeholder="Lifetime Limit" value="${escapeHtml(c.lifetimeLimit ?? '')}" data-ins-cov-lifetime="${idx}">
            <input class="form-input" type="number" placeholder="Annual Limit" value="${escapeHtml(c.annualLimit ?? '')}" data-ins-cov-annual="${idx}">
          </div>
          <div class="s-d79ce2bc">
            <label class="s-e14e9e2a">Coverage Expiry (only if different from the policy's overall expiry above)</label>
            <input class="form-input" type="date" value="${escapeHtml(c.expiry ?? '')}" data-ins-cov-expiry="${idx}">
          </div>
          <label class="s-7148c525">
            <input type="checkbox" data-ins-cov-reducing="${idx}" ${c.reducing ? 'checked' : ''} class="s-d3b60f07"> Reducing Term (sum insured decreases each policy year — record actual amounts via History after saving)
          </label>
          ${insTempCoverages.length > 1 ? `<div class="s-b6396cf3"><span data-ins-cov-remove="${idx}" class="s-03228cf2">🗑️ Remove Coverage</span></div>` : ''}
        </div>
      `).join('');
      container.querySelectorAll('[data-ins-cov-type]').forEach(el => el.addEventListener('change', () => {
        const idx = el.dataset.insCovType;
        insTempCoverages[idx].type = el.value;
        const limitRow = container.querySelector(`[data-ins-cov-limit-row="${idx}"]`);
        limitRow.style.display = el.value === 'Health/Medical' ? 'grid' : 'none';
        const customLabelRow = container.querySelector(`[data-ins-cov-customlabel-row="${idx}"]`);
        customLabelRow.style.display = el.value === 'Other' ? 'block' : 'none';
      }));
      container.querySelectorAll('[data-ins-cov-sum]').forEach(el => el.addEventListener('input', () => { insTempCoverages[el.dataset.insCovSum].sumInsured = el.value; }));
      container.querySelectorAll('[data-ins-cov-customlabel]').forEach(el => el.addEventListener('input', () => { insTempCoverages[el.dataset.insCovCustomlabel].customLabel = el.value; }));
      container.querySelectorAll('[data-ins-cov-lifetime]').forEach(el => el.addEventListener('input', () => { insTempCoverages[el.dataset.insCovLifetime].lifetimeLimit = el.value; }));
      container.querySelectorAll('[data-ins-cov-annual]').forEach(el => el.addEventListener('input', () => { insTempCoverages[el.dataset.insCovAnnual].annualLimit = el.value; }));
      container.querySelectorAll('[data-ins-cov-expiry]').forEach(el => el.addEventListener('input', () => { insTempCoverages[el.dataset.insCovExpiry].expiry = el.value; }));
      container.querySelectorAll('[data-ins-cov-reducing]').forEach(el => el.addEventListener('change', () => { insTempCoverages[el.dataset.insCovReducing].reducing = el.checked; }));
      container.querySelectorAll('[data-ins-cov-remove]').forEach(el => el.addEventListener('click', () => {
        insTempCoverages.splice(Number(el.dataset.insCovRemove), 1);
        insRenderCoverageRows();
      }));
    }
    document.getElementById('insBtnAddCoverageRow').addEventListener('click', () => {
      insTempCoverages.push({ id: insUid(), type: 'Life', sumInsured: '', lifetimeLimit: '', annualLimit: '', reducing: false, expiry: '' });
      insRenderCoverageRows();
    });

    function insRenderRidersRows() {
      const container = document.getElementById('insRidersList');
      if (!insTempRiders.length) {
        container.innerHTML = '<div class="s-c16bedce">No riders added. Some policies have more than one rider, each with its own due date — click "+ Add Rider" below.</div>';
        return;
      }
      container.innerHTML = insTempRiders.map((r, idx) => `
        <div data-ins-rider-row="${idx}" class="s-63e98485">
          <input class="form-input s-ba5c496b" placeholder="Rider description" value="${escapeHtml(r.description||'')}" data-ins-rider-desc="${idx}">
          <input class="form-input s-d5e8c5f3" type="date" value="${escapeHtml(r.dueDate||'')}" data-ins-rider-date="${idx}">
          <span data-ins-rider-remove="${idx}" class="s-af1f4270">🗑️</span>
        </div>
      `).join('');
      container.querySelectorAll('[data-ins-rider-desc]').forEach(el => el.addEventListener('input', () => { insTempRiders[el.dataset.insRiderDesc].description = el.value; }));
      container.querySelectorAll('[data-ins-rider-date]').forEach(el => el.addEventListener('input', () => { insTempRiders[el.dataset.insRiderDate].dueDate = el.value; }));
      container.querySelectorAll('[data-ins-rider-remove]').forEach(el => el.addEventListener('click', () => {
        insTempRiders.splice(Number(el.dataset.insRiderRemove), 1);
        insRenderRidersRows();
      }));
    }
    document.getElementById('insBtnAddRiderRow').addEventListener('click', () => {
      insTempRiders.push({ id: insUid(), description: '', dueDate: '' });
      insRenderRidersRows();
    });
    // ===== Policy attachments (reuses the same IndexedDB storage as health record attachments) =====
    document.getElementById('insFileDropArea').addEventListener('click', async () => { if (await ensureUnlocked()) document.getElementById('insPAttachments').click(); });
    document.getElementById('insPAttachments').addEventListener('change', insHandleAttachments);

    async function insHandleAttachments(e) {
      const files = Array.from(e.target.files);
      const memberName = members.find(x => x.id === currentMemberId)?.name || 'Uncategorized';

      for (const file of files) {
        const isImage = file.type.startsWith('image/');
        const isPdf = file.type === 'application/pdf';
        if (!isImage && !isPdf) continue;

        if (isPdf && file.size > 8 * 1024 * 1024) {
          const mb = (file.size / 1024 / 1024).toFixed(1);
          if (!confirm(`"${file.name}" is ${mb}MB. Large PDFs take longer to store. Add it anyway?`)) continue;
        }

        const safeName = file.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const relativePath = `${ATTACHMENTS_FOLDER}/${memberName}/insurance/${safeName}`;
        const data = isImage ? await readImageResized(file) : await readFileAsDataUrl(file);
        if (!data) {
          alert(`Couldn't read "${file.name}" - it wasn't added.`);
          continue;
        }
        const thumb = isImage ? await readImageThumb(file) : null;

        insTempAttachments.push({
          name: file.name,
          path: relativePath,
          type: isImage ? 'image' : 'pdf',
          data,
          thumb,
          size: data.length
        });
        insRenderAttachmentPreview();
      }
      e.target.value = '';
    }

    function insRenderAttachmentPreview() {
      const preview = document.getElementById('insAttachmentPreview');
      preview.innerHTML = insTempAttachments.map((att, idx) => {
        const previewSrc = att.thumb || att.data;
        return `
        <div class="attachment-item">
          <div class="attachment-thumb">
            ${att.type === 'image' && previewSrc ? `<img src="${previewSrc}" alt="">` : `<span>${att.type === 'image' ? '🖼️' : '📄'}</span>`}
          </div>
          <div class="attachment-info">
            <div class="attachment-name">${escapeHtml(att.name)}</div>
            <div class="attachment-path">${att.size ? formatBytes(att.size) : ''}</div>
          </div>
          <span class="attachment-remove" data-idx="${idx}">Remove</span>
        </div>
      `;
      }).join('');

      preview.querySelectorAll('.attachment-remove').forEach(btn => {
        btn.addEventListener('click', function() {
          insTempAttachments.splice(parseInt(this.dataset.idx), 1);
          insRenderAttachmentPreview();
        });
      });
    }

    document.getElementById('insBtnCancelPolicy').addEventListener('click', () => document.getElementById('insPolicyModal').classList.remove('active'));
    document.getElementById('insBtnSavePolicy').addEventListener('click', async () => {
      const m = members.find(x => x.id === currentMemberId);
      if (!m) return;
      if (!(await ensureUnlocked())) return;
      insEnsureData(m);
      const cleanCoverages = insTempCoverages
        .filter(c => c.type && (c.sumInsured !== '' || c.lifetimeLimit || c.annualLimit))
        .map(c => ({
          id: c.id || insUid(), type: c.type, sumInsured: c.sumInsured,
          customLabel: c.type === 'Other' ? (c.customLabel || '') : '',
          lifetimeLimit: c.type === 'Health/Medical' ? c.lifetimeLimit : '',
          annualLimit: c.type === 'Health/Medical' ? c.annualLimit : '',
          reducing: !!c.reducing,
          expiry: c.expiry || '',
          sumInsuredHistory: c.sumInsuredHistory || []
        }));
      if (!cleanCoverages.length) { alert('Add at least one coverage with a sum insured (or limits for medical cover)'); return; }
      const existingPolicy = insEditingPolicyId ? m.insurance.policies.find(x => x.id === insEditingPolicyId) : null;
      const newRiders = insTempRiders.filter(r => r.description || r.dueDate);
      // Coverages/riders are edited via a temp array and the whole array is
      // rebuilt on every save (not saved field-by-field like member scalars),
      // so version/deletedAt carry-forward + diff-before-bump (and turning a
      // removed-from-the-form item into a tombstone instead of letting it
      // vanish) has to happen here rather than at individual field-edit time.
      // See syncStampSubEntities - note it returns a NEW array (it may be
      // longer than what was passed in, since removed-but-not-yet-tombstoned
      // items get added back as tombstones), so the results replace
      // cleanCoverages/newRiders rather than being used in place.
      const finalCoverages = syncStampSubEntities(existingPolicy ? existingPolicy.coverages : [], cleanCoverages);
      const finalRiders = syncStampSubEntities(existingPolicy ? existingPolicy.riders : [], newRiders);
      const payoutEnabled = document.getElementById('insPPayoutEnabled').checked;
      const bonusPaidEnabled = document.getElementById('insPBonusPaidEnabled').checked;
      const savedAttachments = syncStampAttachments(existingPolicy ? existingPolicy.attachments : [], await persistAttachmentsToIdb(insTempAttachments));
      const data = {
        status: document.getElementById('insPStatus').value,
        provider: document.getElementById('insPProvider').value.trim(),
        number: document.getElementById('insPNumber').value.trim(),
        premium: document.getElementById('insPPremium').value,
        frequency: document.getElementById('insPFrequency').value,
        start: document.getElementById('insPStart').value,
        expiry: document.getElementById('insPExpiry').value,
        notes: document.getElementById('insPNotes').value.trim(),
        coverages: finalCoverages,
        riders: finalRiders,
        attachments: savedAttachments,
        payout: payoutEnabled ? {
          startYear: document.getElementById('insPPayoutStartYear').value,
          percent: document.getElementById('insPPayoutPercent').value,
          baseAmount: document.getElementById('insPPayoutBase').value
        } : null,
        premiumPaidByBonus: bonusPaidEnabled,
        premiumPaidByBonusSince: bonusPaidEnabled ? document.getElementById('insPBonusPaidSince').value : ''
      };
      if (existingPolicy) {
        Object.assign(existingPolicy, data);
        bumpVersion(existingPolicy);
      } else {
        m.insurance.policies.push(Object.assign({ id: insUid(), ledger: [], surrenderRecords: [] }, data, freshSyncMeta()));
      }
      saveData();
      document.getElementById('insPolicyModal').classList.remove('active');
      renderMain();
    });

    // ===== Ledger modal =====
    let insEditingLedgerId = null;
    function insOpenLedgerModal(policyId) {
      const m = members.find(x => x.id === currentMemberId);
      const p = m.insurance.policies.find(x => x.id === policyId);
      if (!p) return;
      if (!p.ledger) p.ledger = [];
      insCurrentLedgerPolicyId = policyId;
      insEditingLedgerId = null;
      document.getElementById('insLedgerModalTitle').textContent = `Premium Ledger — ${insPolicyTypeSummary(p)}${p.provider ? ' / ' + p.provider : ''}`;
      insResetLedgerForm();
      insRenderLedgerList(p);
      document.getElementById('insLedgerModal').classList.add('active');
      // Reopening should always start at the top, not wherever the scroll
      // position happened to be left when the modal was last closed. The
      // ".modal" box itself is the scrollable element (overflow-y: auto),
      // not the inner list, so that's what needs resetting.
      const modalBox = document.querySelector('#insLedgerModal .modal');
      if (modalBox) modalBox.scrollTop = 0;
    }
    function insResetLedgerForm() {
      insEditingLedgerId = null;
      document.getElementById('insLedgerFormTitle').textContent = 'Add Transaction';
      document.getElementById('insLType').value = 'premium';
      document.getElementById('insLMethod').value = 'Bank Transfer';
      document.getElementById('insLDate').value = '';
      document.getElementById('insLAmount').value = '';
      document.getElementById('insLNotes').value = '';
      document.getElementById('insBtnAddLedgerEntry').textContent = '+ Add Transaction (backdated OK)';
      document.getElementById('insBtnCancelLedgerEdit').style.display = 'none';
      insTempLedgerAttachments = [];
      insRenderLedgerAttachmentPreview();
    }
    function insRenderLedgerList(p) {
      const container = document.getElementById('insLedgerList');
      const summaryEl = document.getElementById('insLedgerSummary');
      const totalPremium = (p.ledger||[]).filter(l => l.type !== 'payout').reduce((s,l) => s + (Number(l.amount)||0), 0);
      const totalPayout = (p.ledger||[]).filter(l => l.type === 'payout').reduce((s,l) => s + (Number(l.amount)||0), 0);
      summaryEl.innerHTML = `
        <div class="stats-grid">
          <div class="stat-box"><div class="stat-value s-e2151554">${insFmtMoney(totalPremium)}</div><div class="stat-label">Total Premium Paid</div></div>
          <div class="stat-box"><div class="stat-value s-e2151554">${insFmtMoney(totalPayout)}</div><div class="stat-label">Total Payout Received</div></div>
        </div>`;
      const entries = live(p.ledger).sort((a,b) => new Date(b.date) - new Date(a.date));
      if (!entries.length) {
        container.innerHTML = '<p class="s-51f2817c">No payment transactions recorded yet.</p>';
        return;
      }
      container.innerHTML = entries.map(l => {
        const liveAtts = live(l.attachments || []);
        return `
        <div class="s-952fb81a s-ledger-row" data-ledger-row-id="${escapeHtml(l.id)}">
          <div>
            <div class="s-ea8a0de7">${l.type === 'payout' ? '💰' : '💸'} ${escapeHtml(l.date||'--')} <span class="s-5ea608c5">· ${escapeHtml(l.method||'--')}</span></div>
            ${l.notes ? `<div class="s-c16bedce">${escapeHtml(l.notes)}</div>` : ''}
            ${liveAtts.length ? `<div class="s-bb680ec5">${liveAtts.map((att, idx) => `<span data-ins-open-ledger-att="${escapeHtml(l.id)}" data-ins-att-idx="${idx}" class="s-cd942964">${att.type === 'image' ? '🖼️' : '📄'} ${escapeHtml(att.name)}</span>`).join('')}</div>` : ''}
          </div>
          <div class="s-3b6fff87">
            <div class="${l.type === 'payout' ? 's-ledger-payout' : 's-ledger-expense'}">${l.type === 'payout' ? '+' : ''}${insFmtMoney(l.amount)}</div>
            <span data-ins-edit-ledger="${escapeHtml(l.id)}" class="s-080a81ee">✏️</span>
            <span data-ins-remove-ledger="${escapeHtml(l.id)}" class="s-abe8a067">🗑️</span>
          </div>
        </div>
      `;
      }).join('');
      container.querySelectorAll('[data-ins-open-ledger-att]').forEach(el => el.addEventListener('click', () => {
        const l = p.ledger.find(x => x.id === el.dataset.insOpenLedgerAtt);
        const att = l ? live(l.attachments || [])[parseInt(el.dataset.insAttIdx)] : null;
        openAttachment(att);
      }));
      container.querySelectorAll('[data-ins-edit-ledger]').forEach(el => el.addEventListener('click', () => {
        const l = p.ledger.find(x => x.id === el.dataset.insEditLedger);
        if (!l) return;
        insEditingLedgerId = l.id;
        document.getElementById('insLedgerFormTitle').textContent = 'Edit Transaction';
        document.getElementById('insLType').value = l.type || 'premium';
        document.getElementById('insLMethod').value = l.method || 'Bank Transfer';
        document.getElementById('insLDate').value = l.date || '';
        document.getElementById('insLAmount').value = l.amount ?? '';
        document.getElementById('insLNotes').value = l.notes || '';
        document.getElementById('insBtnAddLedgerEntry').textContent = 'Update Transaction';
        document.getElementById('insBtnCancelLedgerEdit').style.display = 'inline-block';
        insTempLedgerAttachments = l.attachments ? live(l.attachments).map(a => ({ ...a })) : [];
        insRenderLedgerAttachmentPreview();
        // The edit form lives above the ledger list, so without this the user has to
        // manually scroll up to find it -- especially painful with a long transaction list.
        document.getElementById('insLedgerFormTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }));
      container.querySelectorAll('[data-ins-remove-ledger]').forEach(el => el.addEventListener('click', () => {
        if (!confirm('Delete this transaction? This cannot be undone.')) return;
        const m = members.find(x => x.id === currentMemberId);
        const p = m.insurance.policies.find(x => x.id === insCurrentLedgerPolicyId);
        const l = p.ledger.find(x => x.id === el.dataset.insRemoveLedger);
        if (l) tombstone(l);
        saveData();
        if (insEditingLedgerId === el.dataset.insRemoveLedger) insResetLedgerForm();
        insRenderLedgerList(p); renderMain();
      }));
    }
    document.getElementById('insBtnAddLedgerEntry').addEventListener('click', async () => {
      const date = document.getElementById('insLDate').value;
      const amount = document.getElementById('insLAmount').value;
      if (!date || !amount) { alert('Please enter both date and amount'); return; }
      if (!(await ensureUnlocked())) return;
      const m = members.find(x => x.id === currentMemberId);
      const p = m.insurance.policies.find(x => x.id === insCurrentLedgerPolicyId);
      if (!p.ledger) p.ledger = [];
      const priorLedgerEntry = insEditingLedgerId ? p.ledger.find(x => x.id === insEditingLedgerId) : null;
      const persistedLedgerAtt = await persistAttachmentsToIdb(insTempLedgerAttachments);
      const data = {
        date, amount,
        type: document.getElementById('insLType').value,
        method: document.getElementById('insLMethod').value,
        notes: document.getElementById('insLNotes').value.trim(),
        attachments: syncStampAttachments(priorLedgerEntry ? priorLedgerEntry.attachments : [], persistedLedgerAtt)
      };
      let savedLedgerId;
      if (insEditingLedgerId) {
        const l = p.ledger.find(x => x.id === insEditingLedgerId);
        Object.assign(l, data);
        bumpVersion(l);
        savedLedgerId = l.id;
      } else {
        const newEntry = Object.assign({ id: insUid() }, data, freshSyncMeta());
        p.ledger.push(newEntry);
        savedLedgerId = newEntry.id;
      }
      saveData();
      insResetLedgerForm();
      insRenderLedgerList(p); renderMain();
      // Same problem in reverse: after saving, jump back down to the row that was just
      // added/edited and flash it, instead of leaving the user to scroll and hunt for it
      // to confirm the save actually took.
      const savedRow = document.querySelector(`[data-ledger-row-id="${savedLedgerId}"]`);
      if (savedRow) {
        savedRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
        savedRow.classList.add('s-ledger-flash');
        setTimeout(() => savedRow.classList.remove('s-ledger-flash'), 1500);
      }
    });
    document.getElementById('insBtnCancelLedgerEdit').addEventListener('click', insResetLedgerForm);
    document.getElementById('insBtnCloseLedger').addEventListener('click', () => document.getElementById('insLedgerModal').classList.remove('active'));

    // Ledger transaction attachments (receipts / proof of payment)
    document.getElementById('insLFileDropArea').addEventListener('click', async () => { if (await ensureUnlocked()) document.getElementById('insLAttachments').click(); });
    document.getElementById('insLAttachments').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files);
      for (const file of files) {
        const isImage = file.type.startsWith('image/');
        const isPdf = file.type === 'application/pdf';
        if (!isImage && !isPdf) continue;
        const data = isImage ? await readImageResized(file) : await readFileAsDataUrl(file);
        if (!data) { alert(`Couldn't read "${file.name}" - it wasn't added.`); continue; }
        const thumb = isImage ? await readImageThumb(file) : null;
        insTempLedgerAttachments.push({ name: file.name, path: `${ATTACHMENTS_FOLDER}/ledger/${file.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`, type: isImage ? 'image' : 'pdf', data, thumb, size: data.length });
        insRenderLedgerAttachmentPreview();
      }
      e.target.value = '';
    });
    function insRenderLedgerAttachmentPreview() {
      const preview = document.getElementById('insLAttachmentPreview');
      preview.innerHTML = insTempLedgerAttachments.map((att, idx) => {
        const previewSrc = att.thumb || att.data;
        return `
        <div class="attachment-item">
          <div class="attachment-thumb">
            ${att.type === 'image' && previewSrc ? `<img src="${previewSrc}" alt="">` : `<span>${att.type === 'image' ? '🖼️' : '📄'}</span>`}
          </div>
          <div class="attachment-info">
            <div class="attachment-name">${escapeHtml(att.name)}</div>
            <div class="attachment-path">${att.size ? formatBytes(att.size) : ''}</div>
          </div>
          <span class="attachment-remove" data-idx="${idx}">Remove</span>
        </div>
      `;
      }).join('');
      preview.querySelectorAll('.attachment-remove').forEach(btn => {
        btn.addEventListener('click', function() {
          insTempLedgerAttachments.splice(parseInt(this.dataset.idx), 1);
          insRenderLedgerAttachmentPreview();
        });
      });
    }

    // ===== Surrender value modal =====
    let insEditingSurrenderId = null;
    function insOpenSurrenderModal(policyId) {
      const m = members.find(x => x.id === currentMemberId);
      const p = m.insurance.policies.find(x => x.id === policyId);
      if (!p) return;
      if (!p.surrenderRecords) p.surrenderRecords = [];
      insCurrentSurrenderPolicyId = policyId;
      document.getElementById('insSurrenderModalTitle').textContent = `Surrender Value — ${insPolicyTypeSummary(p)}${p.provider ? ' / ' + p.provider : ''}`;
      insResetSurrenderForm();
      insRenderSurrenderList(p);
      document.getElementById('insSurrenderModal').classList.add('active');
    }
    function insResetSurrenderForm() {
      insEditingSurrenderId = null;
      document.getElementById('insSurrenderFormTitle').textContent = 'Add statement record (from Statement of Account)';
      document.getElementById('insSDate').value = '';
      document.getElementById('insSBonus').value = '';
      document.getElementById('insSDividend').value = '';
      document.getElementById('insSGuaranteed').value = '';
      document.getElementById('insSNonGuaranteed').value = '';
      document.getElementById('insBtnAddSurrenderEntry').textContent = '+ Add Statement Record';
      document.getElementById('insBtnCancelSurrenderEdit').style.display = 'none';
      insTempSurrenderAttachments = [];
      insRenderSurrenderAttachmentPreview();
    }
    function insRenderSurrenderList(p) {
      const currentEl = document.getElementById('insSurrenderCurrent');
      const total = insLatestSurrenderTotal(p);
      currentEl.innerHTML = `<div class="stat-box s-244a7f30"><div class="stat-label">Current Total Surrender Value</div><div class="stat-value s-bffeb9ae">${total === null ? '--' : insFmtMoney(total)}</div></div>`;

      const container = document.getElementById('insSurrenderList');
      const entries = live(p.surrenderRecords).sort((a,b) => new Date(b.date) - new Date(a.date));
      if (!entries.length) {
        container.innerHTML = '<p class="s-51f2817c">No statement records yet. Add one below using figures from your latest Statement of Account.</p>';
        return;
      }
      container.innerHTML = entries.map(r => {
        const liveAtts = live(r.attachments || []);
        return `
        <div class="s-198fb7f4">
          <div class="s-2447f692">
            <div class="s-ea8a0de7">${escapeHtml(r.date||'--')}</div>
            <div class="s-3b6fff87">
              <div class="s-cc568fe7">${insFmtMoney(insSurrenderRecordTotal(r))}</div>
              <span data-ins-edit-surrender="${escapeHtml(r.id)}" class="s-080a81ee">✏️</span>
              <span data-ins-remove-surrender="${escapeHtml(r.id)}" class="s-abe8a067">🗑️</span>
            </div>
          </div>
          <div class="s-ebc463b1">
            Bonus ${insFmtMoney(r.accumulatedBonus)} · Investment Fund Value ${insFmtMoney(r.dividend)} · Guaranteed ${insFmtMoney(r.guaranteedCashValue)} · Non-Guaranteed ${insFmtMoney(r.nonGuaranteedValue)}
          </div>
          ${liveAtts.length ? `<div class="s-bb680ec5">${liveAtts.map((att, idx) => `<span data-ins-open-surrender-att="${escapeHtml(r.id)}" data-ins-att-idx="${idx}" class="s-cd942964">${att.type === 'image' ? '🖼️' : '📄'} ${escapeHtml(att.name)}</span>`).join('')}</div>` : ''}
        </div>
      `;
      }).join('');
      container.querySelectorAll('[data-ins-open-surrender-att]').forEach(el => el.addEventListener('click', () => {
        const r = p.surrenderRecords.find(x => x.id === el.dataset.insOpenSurrenderAtt);
        const att = r ? live(r.attachments || [])[parseInt(el.dataset.insAttIdx)] : null;
        openAttachment(att);
      }));
      container.querySelectorAll('[data-ins-edit-surrender]').forEach(el => el.addEventListener('click', () => {
        const r = p.surrenderRecords.find(x => x.id === el.dataset.insEditSurrender);
        if (!r) return;
        insEditingSurrenderId = r.id;
        document.getElementById('insSurrenderFormTitle').textContent = 'Edit statement record';
        document.getElementById('insSDate').value = r.date || '';
        document.getElementById('insSBonus').value = r.accumulatedBonus ?? '';
        document.getElementById('insSDividend').value = r.dividend ?? '';
        document.getElementById('insSGuaranteed').value = r.guaranteedCashValue ?? '';
        document.getElementById('insSNonGuaranteed').value = r.nonGuaranteedValue ?? '';
        document.getElementById('insBtnAddSurrenderEntry').textContent = 'Update Statement Record';
        document.getElementById('insBtnCancelSurrenderEdit').style.display = 'inline-block';
        insTempSurrenderAttachments = r.attachments ? live(r.attachments).map(a => ({ ...a })) : [];
        insRenderSurrenderAttachmentPreview();
        document.getElementById('insSurrenderFormTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }));
      container.querySelectorAll('[data-ins-remove-surrender]').forEach(el => el.addEventListener('click', () => {
        if (!confirm('Delete this statement record? This cannot be undone.')) return;
        const m = members.find(x => x.id === currentMemberId);
        const p = m.insurance.policies.find(x => x.id === insCurrentSurrenderPolicyId);
        const s = p.surrenderRecords.find(x => x.id === el.dataset.insRemoveSurrender);
        if (s) tombstone(s);
        saveData();
        if (insEditingSurrenderId === el.dataset.insRemoveSurrender) insResetSurrenderForm();
        insRenderSurrenderList(p); renderMain();
      }));
    }
    document.getElementById('insBtnAddSurrenderEntry').addEventListener('click', async () => {
      const date = document.getElementById('insSDate').value;
      if (!date) { alert('Please enter the statement date'); return; }
      if (!(await ensureUnlocked())) return;
      const m = members.find(x => x.id === currentMemberId);
      const p = m.insurance.policies.find(x => x.id === insCurrentSurrenderPolicyId);
      if (!p.surrenderRecords) p.surrenderRecords = [];
      const priorSurrenderEntry = insEditingSurrenderId ? p.surrenderRecords.find(x => x.id === insEditingSurrenderId) : null;
      const persistedSurrenderAtt = await persistAttachmentsToIdb(insTempSurrenderAttachments);
      const data = {
        date,
        accumulatedBonus: document.getElementById('insSBonus').value,
        dividend: document.getElementById('insSDividend').value,
        guaranteedCashValue: document.getElementById('insSGuaranteed').value,
        nonGuaranteedValue: document.getElementById('insSNonGuaranteed').value,
        attachments: syncStampAttachments(priorSurrenderEntry ? priorSurrenderEntry.attachments : [], persistedSurrenderAtt)
      };
      if (insEditingSurrenderId) {
        const r = p.surrenderRecords.find(x => x.id === insEditingSurrenderId);
        Object.assign(r, data);
        bumpVersion(r);
      } else {
        p.surrenderRecords.push(Object.assign({ id: insUid() }, data, freshSyncMeta()));
      }
      saveData();
      insResetSurrenderForm();
      insRenderSurrenderList(p); renderMain();
    });
    document.getElementById('insBtnCancelSurrenderEdit').addEventListener('click', insResetSurrenderForm);
    document.getElementById('insBtnCloseSurrender').addEventListener('click', () => document.getElementById('insSurrenderModal').classList.remove('active'));

    // Statement record attachments (statement / proof documents)
    document.getElementById('insSFileDropArea').addEventListener('click', async () => { if (await ensureUnlocked()) document.getElementById('insSAttachments').click(); });
    document.getElementById('insSAttachments').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files);
      for (const file of files) {
        const isImage = file.type.startsWith('image/');
        const isPdf = file.type === 'application/pdf';
        if (!isImage && !isPdf) continue;
        const data = isImage ? await readImageResized(file) : await readFileAsDataUrl(file);
        if (!data) { alert(`Couldn't read "${file.name}" - it wasn't added.`); continue; }
        const thumb = isImage ? await readImageThumb(file) : null;
        insTempSurrenderAttachments.push({ name: file.name, path: `${ATTACHMENTS_FOLDER}/surrender/${file.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`, type: isImage ? 'image' : 'pdf', data, thumb, size: data.length });
        insRenderSurrenderAttachmentPreview();
      }
      e.target.value = '';
    });
    function insRenderSurrenderAttachmentPreview() {
      const preview = document.getElementById('insSAttachmentPreview');
      preview.innerHTML = insTempSurrenderAttachments.map((att, idx) => {
        const previewSrc = att.thumb || att.data;
        return `
        <div class="attachment-item">
          <div class="attachment-thumb">
            ${att.type === 'image' && previewSrc ? `<img src="${previewSrc}" alt="">` : `<span>${att.type === 'image' ? '🖼️' : '📄'}</span>`}
          </div>
          <div class="attachment-info">
            <div class="attachment-name">${escapeHtml(att.name)}</div>
            <div class="attachment-path">${att.size ? formatBytes(att.size) : ''}</div>
          </div>
          <span class="attachment-remove" data-idx="${idx}">Remove</span>
        </div>
      `;
      }).join('');
      preview.querySelectorAll('.attachment-remove').forEach(btn => {
        btn.addEventListener('click', function() {
          insTempSurrenderAttachments.splice(parseInt(this.dataset.idx), 1);
          insRenderSurrenderAttachmentPreview();
        });
      });
    }

    // ===== Sum Insured History modal (Reducing Term) =====
    let insEditingSumHistoryId = null;
    function insOpenSumHistoryModal(policyId, coverageId) {
      const m = members.find(x => x.id === currentMemberId);
      const p = m.insurance.policies.find(x => x.id === policyId);
      if (!p) return;
      const c = (p.coverages||[]).find(x => x.id === coverageId);
      if (!c) return;
      if (!c.sumInsuredHistory) c.sumInsuredHistory = [];
      insCurrentSumHistoryPolicyId = policyId;
      insCurrentSumHistoryCoverageId = coverageId;
      document.getElementById('insSumHistoryModalTitle').textContent = `Sum Insured History — ${insCoverageLabel(c)}${p.provider ? ' / ' + p.provider : ''}`;
      insResetSumHistoryForm();
      insRenderSumHistoryList(c);
      document.getElementById('insSumHistoryModal').classList.add('active');
    }
    function insResetSumHistoryForm() {
      insEditingSumHistoryId = null;
      document.getElementById('insSumHistoryFormTitle').textContent = 'Record the reduced sum insured for a given policy year (from your annual statement)';
      document.getElementById('insHDate').value = '';
      document.getElementById('insHAmount').value = '';
      document.getElementById('insBtnAddSumHistoryEntry').textContent = '+ Add Record';
      document.getElementById('insBtnCancelSumHistoryEdit').style.display = 'none';
    }
    function insRenderSumHistoryList(c) {
      const currentEl = document.getElementById('insSumHistoryCurrent');
      currentEl.innerHTML = `<div class="stat-box s-244a7f30"><div class="stat-label">Current Sum Insured</div><div class="stat-value s-bffeb9ae">${insFmtMoney(insEffectiveSumInsured(c))}</div></div>`;

      const container = document.getElementById('insSumHistoryList');
      const entries = live(c.sumInsuredHistory).sort((a,b) => new Date(b.date) - new Date(a.date));
      if (!entries.length) {
        container.innerHTML = '<p class="s-51f2817c">No history yet. Add the initial amount and each year\'s reduced amount below.</p>';
        return;
      }
      container.innerHTML = entries.map(h => `
        <div class="s-952fb81a">
          <div class="s-ea8a0de7">${escapeHtml(h.date||'--')}</div>
          <div class="s-3b6fff87">
            <div class="s-cc568fe7">${insFmtMoney(h.amount)}</div>
            <span data-ins-edit-sumhistory="${escapeHtml(h.id)}" class="s-080a81ee">✏️</span>
            <span data-ins-remove-sumhistory="${escapeHtml(h.id)}" class="s-abe8a067">🗑️</span>
          </div>
        </div>
      `).join('');
      container.querySelectorAll('[data-ins-edit-sumhistory]').forEach(el => el.addEventListener('click', () => {
        const h = c.sumInsuredHistory.find(x => x.id === el.dataset.insEditSumhistory);
        if (!h) return;
        insEditingSumHistoryId = h.id;
        document.getElementById('insSumHistoryFormTitle').textContent = 'Edit record';
        document.getElementById('insHDate').value = h.date || '';
        document.getElementById('insHAmount').value = h.amount ?? '';
        document.getElementById('insBtnAddSumHistoryEntry').textContent = 'Update Record';
        document.getElementById('insBtnCancelSumHistoryEdit').style.display = 'inline-block';
      }));
      container.querySelectorAll('[data-ins-remove-sumhistory]').forEach(el => el.addEventListener('click', () => {
        if (!confirm('Delete this history record? This cannot be undone.')) return;
        const m = members.find(x => x.id === currentMemberId);
        const p = m.insurance.policies.find(x => x.id === insCurrentSumHistoryPolicyId);
        const c = (p.coverages||[]).find(x => x.id === insCurrentSumHistoryCoverageId);
        const h = c.sumInsuredHistory.find(x => x.id === el.dataset.insRemoveSumhistory);
        if (h) tombstone(h);
        saveData();
        if (insEditingSumHistoryId === el.dataset.insRemoveSumhistory) insResetSumHistoryForm();
        insRenderSumHistoryList(c); renderMain();
      }));
    }
    document.getElementById('insBtnAddSumHistoryEntry').addEventListener('click', () => {
      const date = document.getElementById('insHDate').value;
      const amount = document.getElementById('insHAmount').value;
      if (!date || amount === '') { alert('Please enter both date and sum insured'); return; }
      const m = members.find(x => x.id === currentMemberId);
      const p = m.insurance.policies.find(x => x.id === insCurrentSumHistoryPolicyId);
      const c = (p.coverages||[]).find(x => x.id === insCurrentSumHistoryCoverageId);
      if (!c.sumInsuredHistory) c.sumInsuredHistory = [];
      if (insEditingSumHistoryId) {
        const h = c.sumInsuredHistory.find(x => x.id === insEditingSumHistoryId);
        Object.assign(h, { date, amount });
        bumpVersion(h);
      } else {
        c.sumInsuredHistory.push(Object.assign({ id: insUid(), date, amount }, freshSyncMeta()));
      }
      saveData();
      insResetSumHistoryForm();
      insRenderSumHistoryList(c); renderMain();
    });
    document.getElementById('insBtnCancelSumHistoryEdit').addEventListener('click', insResetSumHistoryForm);
    document.getElementById('insBtnCloseSumHistory').addEventListener('click', () => document.getElementById('insSumHistoryModal').classList.remove('active'));

    // ===== Claim modal =====
    function insOpenClaimModal(id) {
      insEditingClaimId = id || null;
      const m = members.find(x => x.id === currentMemberId);
      if (!m) { alert('Select or add a family member first'); return; }
      insEnsureData(m);
      if (!live(m.insurance.policies).length) { alert('Add a policy for this member first'); return; }
      const sel = document.getElementById('insCPolicyId');
      sel.innerHTML = live(m.insurance.policies).map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(insPolicyTypeSummary(p))}${p.provider ? ' — ' + escapeHtml(p.provider) : ''}</option>`).join('');
      const c = id ? m.insurance.claims.find(x => x.id === id) : null;
      document.getElementById('insClaimModalTitle').textContent = id ? 'Edit Claim' : 'Add Claim';
      if (c) sel.value = c.policyId;
      insPopulateCoverageSelect(m, sel.value, c ? c.coverageId : null);
      sel.onchange = () => insPopulateCoverageSelect(m, sel.value, null);
      document.getElementById('insCDate').value = c ? c.date : '';
      document.getElementById('insCStatus').value = c ? c.status : 'Filed';
      document.getElementById('insCAmountClaimed').value = c ? c.amountClaimed : '';
      document.getElementById('insCAmountPaid').value = c ? c.amountPaid : '';
      document.getElementById('insCDetails').value = c ? c.details : '';
      document.getElementById('insClaimModal').classList.add('active');
    }
    function insPopulateCoverageSelect(m, policyId, selectedCoverageId) {
      const p = m.insurance.policies.find(x => x.id === policyId);
      const covSel = document.getElementById('insCCoverageId');
      const coverages = p ? live(p.coverages || []) : [];
      if (!coverages.length) {
        covSel.innerHTML = '<option value="">(no coverage details on this policy)</option>';
        return;
      }
      covSel.innerHTML = coverages.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(insCoverageLabel(c))}${c.sumInsured ? ' — ' + insFmtMoney(c.sumInsured) : ''}</option>`).join('');
      if (selectedCoverageId) covSel.value = selectedCoverageId;
    }
    document.getElementById('insBtnCancelClaim').addEventListener('click', () => document.getElementById('insClaimModal').classList.remove('active'));
    document.getElementById('insBtnSaveClaim').addEventListener('click', () => {
      const m = members.find(x => x.id === currentMemberId);
      if (!m) return;
      const data = {
        policyId: document.getElementById('insCPolicyId').value,
        coverageId: document.getElementById('insCCoverageId').value,
        date: document.getElementById('insCDate').value,
        status: document.getElementById('insCStatus').value,
        amountClaimed: document.getElementById('insCAmountClaimed').value,
        amountPaid: document.getElementById('insCAmountPaid').value,
        details: document.getElementById('insCDetails').value.trim()
      };
      if (insEditingClaimId) {
        const c = m.insurance.claims.find(x => x.id === insEditingClaimId);
        Object.assign(c, data);
        bumpVersion(c);
      } else {
        m.insurance.claims.push(Object.assign({ id: insUid() }, data, freshSyncMeta()));
      }
      saveData();
      document.getElementById('insClaimModal').classList.remove('active');
      renderMain();
    });

    // ===== Report =====
    function insOpenReportModal(memberId, preselectPolicyId) {
      insCurrentReportMemberId = memberId;
      const m = members.find(x => x.id === memberId);
      const sel = document.getElementById('insRPolicyId');
      sel.innerHTML = '<option value="all">📋 All Policies (full summary)</option>' +
        live(m.insurance.policies).map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(insPolicyTypeSummary(p))}${p.provider ? ' — ' + escapeHtml(p.provider) : ''}${p.status === 'Discontinued' ? ' (Discontinued)' : ''}</option>`).join('');
      sel.value = preselectPolicyId || 'all';
      document.getElementById('insRIncludeDiscontinued').checked = false;
      document.getElementById('insReportModal').classList.add('active');
    }
    document.getElementById('insBtnCancelReport').addEventListener('click', () => document.getElementById('insReportModal').classList.remove('active'));

    function insBuildPolicyReportBlock(m, p) {
      const coverages = p.coverages || [];
      const coverageRows = coverages.map(c => {
        const isMedical = c.type === 'Health/Medical';
        const remaining = (isMedical && c.lifetimeLimit) ? (Number(c.lifetimeLimit) - insCoverageClaimedTotal(m, p.id, c.id)) : null;
        return `<tr>
          <td>${escapeHtml(insCoverageLabel(c))}${c.reducing ? ' (Reducing Term)' : ''}</td>
          <td>${insFmtMoney(insEffectiveSumInsured(c))}</td>
          <td>${c.annualLimit ? insFmtMoney(c.annualLimit) : '--'}</td>
          <td>${c.lifetimeLimit ? insFmtMoney(remaining) + ' / ' + insFmtMoney(c.lifetimeLimit) : '--'}</td>
        </tr>`;
      }).join('');

      const riderRows = (p.riders||[]).map(r => `<tr><td>${escapeHtml(r.description)}</td><td>${escapeHtml(r.dueDate||'--')}</td></tr>`).join('');

      const ledgerRows = [...(p.ledger||[])].sort((a,b) => new Date(a.date) - new Date(b.date)).map(l => `<tr>
        <td>${escapeHtml(l.date||'--')}</td><td>${l.type === 'payout' ? 'Payout Received' : 'Premium Payment'}</td>
        <td>${escapeHtml(l.method||'--')}</td><td>${l.type === 'payout' ? '+' : ''}${insFmtMoney(l.amount)}</td><td>${escapeHtml(l.notes||'')}</td>
      </tr>`).join('');
      const totalPremiumPaid = (p.ledger||[]).filter(l => l.type !== 'payout').reduce((s,l) => s + (Number(l.amount)||0), 0);
      const totalPayoutReceived = (p.ledger||[]).filter(l => l.type === 'payout').reduce((s,l) => s + (Number(l.amount)||0), 0);
      const ledgerTotalRow = `<tr class="s-3940c9c2">
        <td colspan="3" class="s-08a0ed40">Total</td><td>${insFmtMoney(totalPremiumPaid)} paid${totalPayoutReceived ? ' · ' + insFmtMoney(totalPayoutReceived) + ' received' : ''}</td><td></td>
      </tr>`;

      const surrenderRows = [...(p.surrenderRecords||[])].sort((a,b) => new Date(a.date) - new Date(b.date)).map(r => `<tr>
        <td>${escapeHtml(r.date||'--')}</td><td>${insFmtMoney(r.accumulatedBonus)}</td><td>${insFmtMoney(r.dividend)}</td>
        <td>${insFmtMoney(r.guaranteedCashValue)}</td><td>${insFmtMoney(r.nonGuaranteedValue)}</td><td><b>${insFmtMoney(insSurrenderRecordTotal(r))}</b></td>
      </tr>`).join('');

      const relatedClaims = m.insurance.claims.filter(c => c.policyId === p.id);
      const claimRows = relatedClaims.map(c => {
        const cov = coverages.find(x => x.id === c.coverageId);
        return `<tr>
          <td>${escapeHtml(c.date||'--')}</td><td>${escapeHtml(cov ? insCoverageLabel(cov) : '--')}</td><td>${escapeHtml(c.status)}</td>
          <td>${insFmtMoney(c.amountClaimed)}</td><td>${insFmtMoney(c.amountPaid)}</td><td>${escapeHtml(c.details||'')}</td>
        </tr>`;
      }).join('');

      const payout = p.payout && p.payout.startYear ? insNextPayoutInfo(p) : null;

      return `
        <div class="rpt-policy">
          <h3>${p.provider ? escapeHtml(p.provider) : 'Policy'} ${p.status === 'Discontinued' ? '<span class="rpt-badge">DISCONTINUED</span>' : ''}<div class="rpt-policy-subtitle">${escapeHtml(insPolicyTypeSummary(p))}</div></h3>
          <table class="rpt-kv">
            <tr><td>Policy Number</td><td>${escapeHtml(p.number||'--')}</td><td>Premium</td><td>${insFmtMoney(p.premium)} / ${escapeHtml(p.frequency||'--')}</td></tr>
            <tr><td>Start Date</td><td>${escapeHtml(p.start||'--')}${insAgeAtDate(m.birth, p.start) !== null ? ' (age ' + insAgeAtDate(m.birth, p.start) + ')' : ''}</td><td>Expiry / Next Due</td><td>${escapeHtml(p.expiry||'--')}${insAgeAtDate(m.birth, p.expiry) !== null ? ' (age ' + insAgeAtDate(m.birth, p.expiry) + ')' : ''}</td></tr>
          </table>
          ${coverages.length ? `<table class="rpt-table"><thead><tr><th>Coverage</th><th>Sum Insured</th><th>Annual Limit</th><th>Lifetime Limit (Remaining/Total)</th></tr></thead><tbody>${coverageRows}</tbody></table>` : ''}
          ${payout ? `<p class="rpt-note">🎉 Payout benefit: ${p.payout.percent}% of ${insFmtMoney(p.payout.baseAmount)} annually from year ${p.payout.startYear} — next due ~${insFmtMoney(payout.amount)} on ${escapeHtml(payout.date)}</p>` : ''}
          ${p.premiumPaidByBonus ? `<p class="rpt-note">💰 Premium currently paid via Accumulated Cash Bonus${p.premiumPaidByBonusSince ? ' · since ' + escapeHtml(p.premiumPaidByBonusSince) : ''}</p>` : ''}
          ${p.notes ? `<p class="rpt-note">${escapeHtml(p.notes)}</p>` : ''}
          ${riderRows ? `<h4>Riders</h4><table class="rpt-table"><thead><tr><th>Description</th><th>Due Date</th></tr></thead><tbody>${riderRows}</tbody></table>` : ''}
          ${ledgerRows ? `<h4>Premium / Payout Ledger</h4><table class="rpt-table"><thead><tr><th>Date</th><th>Type</th><th>Method</th><th>Amount</th><th>Notes</th></tr></thead><tbody>${ledgerRows}${ledgerTotalRow}</tbody></table>` : '<p class="rpt-note">No ledger transactions recorded.</p>'}
          ${surrenderRows ? `<h4>Surrender Value History</h4><table class="rpt-table"><thead><tr><th>Date</th><th>Bonus</th><th>Investment Fund Value</th><th>Guaranteed</th><th>Non-Guaranteed</th><th>Total</th></tr></thead><tbody>${surrenderRows}</tbody></table>` : ''}
          ${claimRows ? `<h4>Claims</h4><table class="rpt-table"><thead><tr><th>Date</th><th>Coverage</th><th>Status</th><th>Claimed</th><th>Paid</th><th>Details</th></tr></thead><tbody>${claimRows}</tbody></table>` : ''}
        </div>
      `;
    }

    document.getElementById('insBtnGenerateReport').addEventListener('click', () => {
      const m = members.find(x => x.id === insCurrentReportMemberId);
      if (!m) return;
      const selectedId = document.getElementById('insRPolicyId').value;
      const includeDiscontinued = document.getElementById('insRIncludeDiscontinued').checked;

      let policiesToShow;
      let reportTitle;
      if (selectedId === 'all') {
        policiesToShow = live(m.insurance.policies).filter(p => includeDiscontinued || p.status !== 'Discontinued');
        reportTitle = `Insurance Report — ${m.name}`;
      } else {
        policiesToShow = live(m.insurance.policies).filter(p => p.id === selectedId);
        reportTitle = `Policy Report — ${m.name}`;
      }

      let summaryHtml = '';
      if (selectedId === 'all') {
        const activePolicies = live(m.insurance.policies).filter(p => p.status !== 'Discontinued');
        const insuredByType = {};
        const assetByType = {};
        const ASSET_TYPES = ['Home', 'Car'];
        let totalMedicalAnnualLimit = 0, totalMedicalLifetimeRemaining = 0;
        activePolicies.forEach(p => (p.coverages||[]).forEach(c => {
          if (c.type === 'Health/Medical') {
            if (c.annualLimit) totalMedicalAnnualLimit += Number(c.annualLimit) || 0;
            if (c.lifetimeLimit) totalMedicalLifetimeRemaining += Number(c.lifetimeLimit) - insCoverageClaimedTotal(m, p.id, c.id);
            return;
          }
          const amt = insEffectiveSumInsured(c);
          if (!amt) return;
          if (ASSET_TYPES.includes(c.type)) {
            assetByType[insCoverageLabel(c)] = (assetByType[insCoverageLabel(c)] || 0) + amt;
          } else {
            insuredByType[insCoverageLabel(c)] = (insuredByType[insCoverageLabel(c)] || 0) + amt;
          }
        }));
        const totalSurrender = activePolicies.reduce((s,p) => s + (insLatestSurrenderTotal(p) || 0), 0);
        const medicalTable = (totalMedicalAnnualLimit || totalMedicalLifetimeRemaining) ?
          `<h4>Health/Medical Limits</h4>
           <table class="rpt-table"><thead><tr><th>Total Annual Limit</th><th>Total Lifetime Limit Remaining</th></tr></thead><tbody>
           <tr><td>${insFmtMoney(totalMedicalAnnualLimit)}</td><td>${insFmtMoney(totalMedicalLifetimeRemaining)}</td></tr>
           </tbody></table>` : '';
        const assetTable = Object.keys(assetByType).length ?
          `<h4>Property & Asset Insured</h4>
           <table class="rpt-table"><thead><tr><th>Type</th><th>Total Insured</th></tr></thead><tbody>
           ${Object.entries(assetByType).map(([t,a]) => `<tr><td>${escapeHtml(t)}</td><td>${insFmtMoney(a)}</td></tr>`).join('')}
           </tbody></table>` : '';
        summaryHtml = `
          <table class="rpt-kv">
            <tr><td>Active Policies</td><td>${activePolicies.length}</td><td>Premium / Year</td><td>${insFmtMoney(insAnnualPremium(m))}</td></tr>
            <tr><td>Total Surrender Value</td><td>${insFmtMoney(totalSurrender)}</td><td>Total Claims Filed</td><td>${m.insurance.claims.length}</td></tr>
          </table>
          <h4>Total Sum Insured by Coverage Type</h4>
          <table class="rpt-table"><thead><tr><th>Coverage Type</th><th>Total Sum Insured</th></tr></thead><tbody>
          ${Object.entries(insuredByType).map(([t,a]) => `<tr><td>${escapeHtml(t)}</td><td>${insFmtMoney(a)}</td></tr>`).join('') || '<tr><td colspan="2">No sum insured on record</td></tr>'}
          </tbody></table>
          ${assetTable}
          ${medicalTable}`;
      }

      const bodyHtml = `
        <h1>${escapeHtml(reportTitle)}</h1>
        <p class="rpt-meta">Generated ${new Date().toLocaleDateString()} · Family Health & Shield</p>
        ${summaryHtml}
        ${policiesToShow.length ? policiesToShow.map(p => insBuildPolicyReportBlock(m, p)).join('') : '<p>No policies to show.</p>'}
      `;
      insOpenPrintWindow(reportTitle, bodyHtml);
      document.getElementById('insReportModal').classList.remove('active');
    });

    async function insOpenPrintWindow(title, bodyHtml) {
      const printContainer = startPrint();
      printContainer.innerHTML = `<div class="pir-page">${bodyHtml}</div>`;
      await finishPrint();
    }
    // ================= END INSURANCE MODULE =================

    // ===== Security modal (setup / manage encryption) =====
    async function renderSecurityModalState() {
      const cfg = getCryptoConfig();
      const enabled = !!(cfg && cfg.enabled);
      document.getElementById('securitySetupSection').style.display = enabled ? 'none' : 'block';
      document.getElementById('securityManageSection').style.display = enabled ? 'block' : 'none';
      if (enabled) {
        document.getElementById('secLockStatus').textContent = isUnlocked() ? '🔓 Currently unlocked' : '🔒 Currently locked';
        await migrateLegacyBiometric();
        const supported = await isPlatformAuthenticatorAvailable();
        const enrolled = isBiometricEnrolled();
        document.getElementById('bioNotSupported').style.display = supported ? 'none' : 'block';
        document.getElementById('bioEnrollBox').style.display = (supported && !enrolled) ? 'block' : 'none';
        document.getElementById('bioEnabledBox').style.display = (supported && enrolled) ? 'flex' : 'none';
        document.getElementById('bioConfirmPasscode').value = '';
        document.getElementById('bioSetupError').textContent = hasPendingMigrationNotice()
          ? 'Biometric unlock was reset on this device for security reasons (either it used an older, less secure fallback method, or its underlying key needs to be regenerated). Set it up again below - it will only succeed on devices with full biometric (PRF) support.'
          : '';
      }
      document.getElementById('secPasscode1').value = '';
      document.getElementById('secPasscode2').value = '';
      document.getElementById('secSetupError').textContent = '';
    }
    document.getElementById('btnSecurity').addEventListener('click', async () => {
      if (isEncryptionEnabled() && !(await ensureUnlocked())) return;
      await renderSecurityModalState();
      document.getElementById('securityModal').classList.add('active');
    });
    document.getElementById('btnCloseSecurity').addEventListener('click', () => document.getElementById('securityModal').classList.remove('active'));
    document.getElementById('btnEnableEncryption').addEventListener('click', async () => {
      const p1 = document.getElementById('secPasscode1').value;
      const p2 = document.getElementById('secPasscode2').value;
      const errEl = document.getElementById('secSetupError');
      if (p1.length < 6) { errEl.textContent = 'Passcode must be at least 6 characters.'; return; }
      if (p1 !== p2) { errEl.textContent = 'Passcodes do not match.'; return; }
      await cryptoSetup(p1);
      const { changed } = await reencryptAllAttachments(true);
      saveData(); // re-writes the main health + insurance data blob encrypted too
      alert(`Encryption enabled. Your data and ${changed} existing attachment(s) are now encrypted on this device.`);
      await renderSecurityModalState();
    });
    document.getElementById('btnLockNow').addEventListener('click', () => {
      document.getElementById('securityModal').classList.remove('active');
      relockApp();
    });
    document.getElementById('btnReencryptAll').addEventListener('click', async () => {
      if (!(await ensureUnlocked())) return;
      const { changed, skipped } = await reencryptAllAttachments(true);
      alert(`Re-encrypted ${changed} attachment(s).${skipped ? ' ' + skipped + ' could not be processed.' : ''}`);
    });
    document.getElementById('btnDisableEncryption').addEventListener('click', async () => {
      if (!confirm('Disable encryption? All your data and attachments will be decrypted and stored as plaintext on this device.')) return;
      if (!(await ensureUnlocked())) return;
      await reencryptAllAttachments(false);
      localStorage.removeItem(CRYPTO_CONFIG_KEY);
      setCryptoIntent('disabled');
      await clearBioConfig(); // biometric unlock is meaningless without a passcode-derived key behind it
      cryptoLock();
      saveData(); // re-writes the main health + insurance data blob as plaintext
      alert('Encryption disabled — your data and attachments are now stored as plaintext.');
      await renderSecurityModalState();
    });

    // ===== Biometric unlock enroll / remove (Security modal) =====
    document.getElementById('btnEnableBiometric').addEventListener('click', async () => {
      const errEl = document.getElementById('bioSetupError');
      errEl.textContent = '';
      const passcode = document.getElementById('bioConfirmPasscode').value;
      if (!passcode) { errEl.textContent = 'Enter your current passcode first.'; return; }
      try {
        await enrollBiometric(passcode);
        await renderSecurityModalState();
        alert('🫆 Biometric unlock enabled on this device.');
      } catch (err) {
        errEl.textContent = err.message || 'Could not enable biometric unlock.';
      }
    });
    document.getElementById('btnRemoveBiometric').addEventListener('click', async () => {
      if (!confirm('Remove biometric unlock from this device? You will need to enter your passcode manually from now on.')) return;
      await clearBioConfig();
      await renderSecurityModalState();
    });

    // ===== Unlock modal (lazy prompt) =====
    document.getElementById('btnUnlockSubmit').addEventListener('click', async () => {
      const pass = document.getElementById('unlockPasscodeInput').value;
      const ok = await cryptoUnlock(pass);
      if (ok) {
        document.getElementById('unlockModal').classList.remove('active');
        if (unlockResolver) { unlockResolver(true); unlockResolver = null; }
      } else {
        document.getElementById('unlockError').textContent = 'Incorrect passcode.';
      }
    });
    document.getElementById('btnBioUnlock').addEventListener('click', async () => {
      document.getElementById('unlockError').textContent = '';
      const pass = await tryBiometricUnlockPasscode();
      if (!pass) {
        document.getElementById('unlockError').textContent = 'Biometric unlock failed or was cancelled. Enter your passcode instead.';
        return;
      }
      const ok = await cryptoUnlock(pass);
      if (ok) {
        document.getElementById('unlockModal').classList.remove('active');
        if (unlockResolver) { unlockResolver(true); unlockResolver = null; }
      } else {
        document.getElementById('unlockError').textContent = 'Biometric-stored passcode no longer matches. Please enter it manually.';
      }
    });
    document.getElementById('unlockPasscodeInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btnUnlockSubmit').click();
    });
    document.getElementById('btnUnlockCancel').addEventListener('click', () => {
      document.getElementById('unlockModal').classList.remove('active');
      if (unlockResolver) { unlockResolver(false); unlockResolver = null; }
    });

    // ===== Universal modal close: [X] button (stays visible while scrolling) + ESC key =====
    function closeOverlay(overlay) {
      overlay.classList.remove('active');
      if (overlay.id === 'unlockModal' && unlockResolver) { unlockResolver(false); unlockResolver = null; }
      if (overlay.id === 'importPasscodeModal' && importPasscodeResolver) { importPasscodeResolver.resolve(null); importPasscodeResolver = null; }
      if (overlay.id === 'attachmentViewerModal') {
        const body = document.getElementById('attachmentViewerBody');
        attachmentViewerObjectUrls.forEach(u => URL.revokeObjectURL(u));
        attachmentViewerObjectUrls = [];
        body.innerHTML = '';
      }
    }
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      const modalBox = overlay.querySelector('.modal');
      if (!modalBox) return;
      const closeBtn = document.createElement('span');
      closeBtn.className = 'modal-close-x';
      closeBtn.textContent = '✕';
      closeBtn.title = 'Close';
      closeBtn.addEventListener('click', () => closeOverlay(overlay));
      modalBox.appendChild(closeBtn);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay.active').forEach(overlay => closeOverlay(overlay));
      }
    });

    // ===== Mobile/tablet hardware & gesture "Back" button =====
    // This app is a single index.html with no routing, so there's normally
    // nothing in browser history for the OS back button/gesture to step
    // through - it falls straight through to closing the app. This block
    // gives every "in-app step" (opening a modal - including the
    // image/PDF attachment viewer - or drilling into a member's profile) a
    // matching history entry, so Back instead undoes ONE such step at a
    // time: close viewer/modal -> back to overview -> then, only once
    // there's nothing left to unwind at the app level, an actual exit.
    //
    // navDepth counts how many of THESE entries are currently pushed and
    // not yet consumed. It's what stops popNavStep() from ever calling
    // history.back() with nothing of ours left to consume, which would
    // otherwise navigate off the app entirely (e.g. to whatever page was
    // open in this tab before, or closing an installed PWA one level too
    // far).
    let navDepth = 0;
    let suppressNavPop = false;   // true only while handleBackNavigation() itself is closing something in response to a genuine Back press, so the observer below doesn't ALSO call history.back() for a step the browser is already consuming
    let expectingEchoPopstate = false; // true only for the brief window between popNavStep() calling history.back() itself (e.g. because the [X] button or a Cancel button closed something) and the resulting popstate firing - without this, that echoed popstate would look identical to a genuine Back press and re-run handleBackNavigation(), incorrectly closing a second thing (e.g. also kicking back to the overview) for what was only one user action

    function pushNavStep() {
      navDepth++;
      history.pushState({ familyHealthNavStep: navDepth }, '', location.href);
    }

    function popNavStep() {
      if (navDepth > 0 && !suppressNavPop) {
        navDepth--;
        expectingEchoPopstate = true;
        history.back();
      }
    }

    function handleBackNavigation() {
      const activeOverlay = document.querySelector('.modal-overlay.active');
      if (activeOverlay) { closeOverlay(activeOverlay); return; }
      if (currentMemberId !== null) { currentMemberId = null; currentTab = 'overview'; renderMemberList(); renderMain(); return; }
      // Nothing left to unwind at the app level - do nothing further here;
      // with navDepth already back at 0, the browser handles any
      // subsequent Back press itself (normal exit/minimize behavior).
    }

    window.addEventListener('popstate', () => {
      if (expectingEchoPopstate) {
        // This popstate is just the async echo of our own popNavStep() ->
        // history.back() call above - the thing it was closing is already
        // closed and navDepth was already decremented there, so there's
        // nothing further to do.
        expectingEchoPopstate = false;
        return;
      }
      // A genuine Back press (hardware button / edge swipe) - undo exactly
      // one step ourselves.
      if (navDepth > 0) navDepth--;
      suppressNavPop = true;
      handleBackNavigation();
      // Let the synchronous DOM changes just made (which the
      // MutationObserver below also reacts to) settle before re-arming,
      // so that observer doesn't itself call history.back() for a step
      // this popstate event already consumed.
      setTimeout(() => { suppressNavPop = false; }, 0);
    });


    // Any `.modal-overlay` (including ones added after this point) is
    // opened/closed purely by toggling its 'active' class - via
    // closeOverlay() above, the auto-added [X] button, Escape, or each
    // modal's own Cancel/Save buttons which toggle it directly. Observing
    // that one class, rather than hooking every individual open/close call
    // site, catches all of them (present and future) uniformly.
    const navStepObserver = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        const el = mut.target;
        const isActive = el.classList.contains('active');
        const wasActive = (mut.oldValue || '').split(' ').includes('active');
        if (isActive && !wasActive) pushNavStep();
        else if (!isActive && wasActive) popNavStep();
      }
    });
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      navStepObserver.observe(overlay, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    });

    // ===== PWA: Service Worker registration (offline support) =====
    // Registers relative to this page's own path so it also works when the
    // app is deployed under a GitHub Pages project subpath (e.g.
    // https://user.github.io/repo-name/) rather than the domain root.
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js')
          .catch(err => console.warn('Service worker registration failed:', err));
      });
    }

    // ===== Delegated click handler for buttons rendered via innerHTML =====
    // (kept as data-attributes + delegation, rather than inline onclick="", so the
    // page's CSP can drop 'unsafe-inline' from script-src)
    document.addEventListener('click', function(e) {
      const reportBtn = e.target.closest('[data-report-type]');
      if (reportBtn) {
        openReportPreview(reportBtn.dataset.reportType, reportBtn.dataset.reportMember);
        return;
      }
      const reminderBtn = e.target.closest('[data-open-reminder-modal]');
      if (reminderBtn) {
        openReminderModal(reminderBtn.dataset.openReminderModal);
        return;
      }
    });

    // ===== PWA: simple offline indicator =====
    function updateOnlineStatusBanner() {
      const el = document.getElementById('offlineBanner');
      if (!el) return;
      el.style.display = navigator.onLine ? 'none' : 'block';
    }
    window.addEventListener('online', updateOnlineStatusBanner);
    window.addEventListener('offline', updateOnlineStatusBanner);
    window.addEventListener('DOMContentLoaded', updateOnlineStatusBanner);

