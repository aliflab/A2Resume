/**
 * Manual verification for session persistence. Not imported by the app and not
 * in the build. Run from the browser console with the dev server up:
 *
 *   const s = await import('/src/services/__manual__/session.manual.js');
 *
 *   s.testOffline();   // storage edge cases; restores whatever was stored before
 *   s.report();        // what is stored right now, per field, with sizes
 *
 * The reload test, repeated at each stage (after the Input run, after a
 * skills merge on Analyze, after Tailor):
 *
 *   s.snapshot();                  // fingerprint the LIVE store
 *   // reload the page (F5)
 *   (await import('/src/services/__manual__/session.manual.js')).verifyRehydrated();
 *
 * Then click "Start over" -> "Yes, start over" in the header, and:
 *
 *   (await import('/src/services/__manual__/session.manual.js')).verifyCleared();
 *   // reload once more and run verifyCleared() again: an empty store that
 *   // refills on reload was only a visual reset.
 *
 * snapshot/verify read the store through window.a2resumeDev, which AppProvider
 * sets in dev builds only. Fingerprints are lengths plus a hash of each field's
 * json -- no resume content is printed. API keys are compared by presence
 * booleans only, never by value.
 */

import {
  PERSISTED_FIELD_NAMES,
  SESSION_STORAGE_NAME,
  SESSION_VERSION,
  TYPICAL_QUOTA_CHARS,
  clearSession,
  hasSessionContent,
  loadSession,
  measureSession,
  saveSession,
} from '../sessionPersistence.js';
import { getKeyPresence } from '../apiKeyService.js';

const RAW_KEY = `a2resume:${SESSION_STORAGE_NAME}`;
const SNAPSHOT_KEY = '__a2resume_session_snapshot';

/** FNV-1a, 32-bit. A fingerprint, not a security primitive. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const fingerprint = (value) => {
  const json = JSON.stringify(value ?? null);
  return { chars: json.length, hash: hash(json) };
};

function liveState() {
  const handle = window.a2resumeDev;
  if (!handle || typeof handle.getState !== 'function') {
    throw new Error('window.a2resumeDev is missing. Run this against the dev server (npm run dev), not a production build.');
  }
  return handle.getState();
}

// ---------------------------------------------------------------------------
// Offline edge cases
// ---------------------------------------------------------------------------

const SAMPLE = {
  resumeText: 'Jane Doe\nEngineer',
  resume: { name: 'Jane Doe', experience: [{ company: 'Acme', bullets: ['Built things'] }] },
  jobDescription: 'We want an engineer.',
  parsedJD: { jobTitle: 'Engineer', atsKeywords: { high: ['Go'], medium: [], low: [] } },
  gapAnalysis: { matchRate: 0.5 },
  atsScore: { total: 61 },
  originalGapAnalysis: { matchRate: 0.25 },
  originalAtsScore: { total: 40 },
  tailoredResume: { name: 'Jane Doe' },
  changesLog: [{ section: 'experience', before: 'a', after: 'b' }],
  tailorCorrections: [],
  tailorManualEdits: [{ section: 'summary', index: null, label: 'Summary' }],
  // Every persisted field has to be present, in PERSISTED_FIELD_NAMES order:
  // "only the persisted fields are written" compares the stored keys against
  // that list, and an undefined field is dropped by JSON.stringify rather than
  // stored as null. draftEdits was added to PERSISTED_FIELDS without being
  // added here, so that assertion had been failing since.
  draftEdits: null,
  sources: { resume: 'paste', jobDescription: 'paste', resumeFileName: null, jobDescriptionUrl: null, provider: 'gemini' },
  settings: { provider: 'gemini' },
};

/** @returns {boolean} true when every case passes */
export function testOffline() {
  const backup = localStorage.getItem(RAW_KEY);
  const presenceBefore = JSON.stringify(getKeyPresence());
  const originalSetItem = Storage.prototype.setItem;
  const originalGetItem = Storage.prototype.getItem;
  let failed = 0;

  const check = (label, pass, detail) => {
    if (pass) console.log('PASS', label);
    else {
      failed += 1;
      console.error('FAIL', label, detail ?? '');
    }
  };
  const noThrow = (fn) => {
    try {
      return { value: fn(), threw: null };
    } catch (err) {
      return { value: undefined, threw: err };
    }
  };

  console.group('sessionPersistence - offline assertions');
  try {
    localStorage.removeItem(RAW_KEY);
    let r = noThrow(loadSession);
    check('missing -> empty, no throw', !r.threw && r.value.state === null && r.value.reason === 'missing', r);

    for (const [label, raw, reason] of [
      ['corrupt json', '{not json', 'corrupt'],
      ['json null', 'null', 'missing'],
      ['json number', '42', 'incompatible'],
      ['json array', '[]', 'incompatible'],
      ['wrong version', JSON.stringify({ version: SESSION_VERSION + 1, state: SAMPLE }), 'incompatible'],
      ['state not an object', JSON.stringify({ version: SESSION_VERSION, state: 'x' }), 'incompatible'],
    ]) {
      localStorage.setItem(RAW_KEY, raw);
      r = noThrow(loadSession);
      check(`${label} -> ${reason}, no throw`, !r.threw && r.value.state === null && r.value.reason === reason, r);
    }

    localStorage.setItem(
      RAW_KEY,
      JSON.stringify({
        version: SESSION_VERSION,
        state: { ...SAMPLE, resume: 'not an object', changesLog: {}, resumeText: 5, sources: { resume: 'pdf', jobDescriptionUrl: 42 } },
      })
    );
    r = noThrow(loadSession);
    const s = r.value?.state ?? {};
    check(
      'wrong-typed fields dropped individually, the rest kept',
      !r.threw &&
        !('resume' in s) &&
        !('changesLog' in s) &&
        !('resumeText' in s) &&
        s.parsedJD?.jobTitle === 'Engineer' &&
        s.sources?.resume === 'pdf' &&
        !('jobDescriptionUrl' in s.sources),
      r.value
    );

    localStorage.removeItem(RAW_KEY);
    saveSession({ ...SAMPLE, ui: { status: 'running', stage: 'parseJD', error: null } });
    const stored = JSON.parse(localStorage.getItem(RAW_KEY));
    check('ui is never persisted', stored && !('ui' in stored.state), stored?.state && Object.keys(stored.state));
    check('only the persisted fields are written', JSON.stringify(Object.keys(stored.state)) === JSON.stringify(PERSISTED_FIELD_NAMES));
    check('round trip is exact', JSON.stringify(loadSession().state) === JSON.stringify(SAMPLE));

    saveSession({ ...SAMPLE, resumeText: '', jobDescription: '', resume: null, parsedJD: null, gapAnalysis: null, atsScore: null, originalGapAnalysis: null, originalAtsScore: null, tailoredResume: null, changesLog: null, tailorCorrections: null, tailorManualEdits: null });
    check('empty slice removes the entry rather than storing empties', localStorage.getItem(RAW_KEY) === null);
    check('provider choice alone is not a session', !hasSessionContent({ settings: { provider: 'gemini' }, sources: { provider: 'gemini' } }));

    saveSession(SAMPLE);
    clearSession();
    check('clearSession deletes the entry', localStorage.getItem(RAW_KEY) === null);

    // Quota: the previous snapshot must not survive a failed write.
    saveSession(SAMPLE);
    Storage.prototype.setItem = function () {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    r = noThrow(() => saveSession({ ...SAMPLE, resumeText: 'newer work' }));
    Storage.prototype.setItem = originalSetItem;
    check('quota failure: no throw, reported as quota', !r.threw && r.value.ok === false && r.value.error === 'quota', r);
    check('quota failure: older snapshot removed, not left to resurface', localStorage.getItem(RAW_KEY) === null);
    saveSession(SAMPLE); // resets the reported status to ok

    Storage.prototype.getItem = function () {
      throw new DOMException('denied', 'SecurityError');
    };
    r = noThrow(loadSession);
    Storage.prototype.getItem = originalGetItem;
    check('blocked storage on read -> unavailable, no throw', !r.threw && r.value.state === null && r.value.reason === 'unavailable', r);

    // The gap analysis embedded in atsScore is stored once, not twice.
    const gap = { matched: [{ keyword: 'Go', priority: 'high' }], partial: [], missing: [], matchRate: 100 };
    const shared = { ...SAMPLE, gapAnalysis: gap, atsScore: { total: 61, gapAnalysis: gap } };
    saveSession(shared);
    let env = JSON.parse(localStorage.getItem(RAW_KEY));
    check(
      'dedup: shared gap analysis written once, flag set',
      env.atsScoreSharesGapAnalysis === true && !('gapAnalysis' in env.state.atsScore) && env.state.gapAnalysis.matchRate === 100,
      env
    );
    let loaded = loadSession().state;
    check('dedup: re-attached on load as one shared object', loaded.atsScore.gapAnalysis === loaded.gapAnalysis);
    check('dedup: restored state equals what was saved', JSON.stringify(loaded) === JSON.stringify(shared));
    const measured = measureSession(shared);
    check(
      'dedup: measureSession counts what is written',
      measured.total === localStorage.getItem(RAW_KEY).length && measured.perField.atsScore === JSON.stringify(env.state.atsScore).length,
      { measured: measured.total, stored: localStorage.getItem(RAW_KEY).length }
    );

    saveSession({ ...shared, atsScore: { total: 61, gapAnalysis: { ...gap, matchRate: 5 } } });
    env = JSON.parse(localStorage.getItem(RAW_KEY));
    check(
      'dedup: a different embedded copy is kept, not stripped',
      env.atsScoreSharesGapAnalysis === false && env.state.atsScore.gapAnalysis.matchRate === 5
    );

    saveSession(SAMPLE);
    loaded = loadSession().state;
    check('dedup: a score with no embedded copy is not given one', !('gapAnalysis' in loaded.atsScore));

    // A session written before dedup: two equal copies, no flag.
    localStorage.setItem(RAW_KEY, JSON.stringify({ version: SESSION_VERSION, state: { ...SAMPLE, gapAnalysis: gap, atsScore: { total: 61, gapAnalysis: structuredClone(gap) } } }));
    loaded = loadSession().state;
    check('dedup: pre-dedup session loads with one shared object', loaded.atsScore.gapAnalysis === loaded.gapAnalysis);
    saveSession(loaded);
    env = JSON.parse(localStorage.getItem(RAW_KEY));
    check('dedup: and its next save is deduplicated', env.atsScoreSharesGapAnalysis === true && !('gapAnalysis' in env.state.atsScore));

    localStorage.setItem(RAW_KEY, JSON.stringify({ version: SESSION_VERSION, atsScoreSharesGapAnalysis: true, state: { ...SAMPLE, gapAnalysis: 'corrupt', atsScore: { total: 61 } } }));
    r = noThrow(loadSession);
    check(
      'dedup: flag set but gapAnalysis dropped -> score kept without it, no throw',
      !r.threw && r.value.state.atsScore?.total === 61 && !('gapAnalysis' in r.value.state.atsScore) && r.value.dropped.includes('gapAnalysis'),
      r
    );

    // The baseline score (originalGapAnalysis / originalAtsScore).
    const baseGap = { matched: [], partial: [], missing: [{ keyword: 'Go', priority: 'high' }], matchRate: 0 };
    const baseScore = { total: 40, gapAnalysis: baseGap };
    const untailored = { ...SAMPLE, gapAnalysis: baseGap, atsScore: baseScore, originalGapAnalysis: baseGap, originalAtsScore: baseScore };
    saveSession(untailored);
    env = JSON.parse(localStorage.getItem(RAW_KEY));
    check(
      'baseline: same objects as current -> written once, flag set',
      env.originalScoreSharesCurrent === true && !('originalGapAnalysis' in env.state) && !('originalAtsScore' in env.state) && env.atsScoreSharesGapAnalysis === true,
      env
    );
    loaded = loadSession().state;
    check(
      'baseline: shared pair restored as the very same objects',
      loaded.originalAtsScore === loaded.atsScore && loaded.originalGapAnalysis === loaded.gapAnalysis && loaded.atsScore.gapAnalysis === loaded.gapAnalysis
    );
    check('baseline: shared restore equals what was saved', JSON.stringify(loaded) === JSON.stringify(untailored));
    check('baseline: measureSession counts a shared baseline as absent', measureSession(untailored).perField.originalAtsScore === 4);

    const tailoredPair = { ...untailored, gapAnalysis: gap, atsScore: { total: 61, gapAnalysis: gap } };
    saveSession(tailoredPair);
    env = JSON.parse(localStorage.getItem(RAW_KEY));
    check(
      'baseline: diverged from current -> written, its embedded gap stripped',
      env.originalScoreSharesCurrent === false && env.originalAtsScoreSharesGapAnalysis === true && env.state.originalAtsScore.total === 40 && !('gapAnalysis' in env.state.originalAtsScore),
      env
    );
    loaded = loadSession().state;
    check(
      'baseline: diverged pair restored intact, each score sharing its own gap',
      loaded.originalAtsScore.total === 40 && loaded.atsScore.total === 61 && loaded.originalAtsScore.gapAnalysis === loaded.originalGapAnalysis && loaded.atsScore.gapAnalysis === loaded.gapAnalysis
    );
    check('baseline: diverged restore equals what was saved', JSON.stringify(loaded) === JSON.stringify(tailoredPair));

    // Written before baselines existed: no flag, no original fields. Its score
    // never tracked tailoring, so it is the baseline.
    const legacyState = { ...SAMPLE, gapAnalysis: gap, atsScore: { total: 61 } };
    delete legacyState.originalGapAnalysis;
    delete legacyState.originalAtsScore;
    localStorage.setItem(RAW_KEY, JSON.stringify({ version: SESSION_VERSION, atsScoreSharesGapAnalysis: false, state: legacyState }));
    loaded = loadSession().state;
    check('baseline: pre-baseline session adopts its stored score as the baseline', loaded.originalAtsScore === loaded.atsScore && loaded.originalGapAnalysis === loaded.gapAnalysis && loaded.originalAtsScore.total === 61);

    localStorage.setItem(RAW_KEY, JSON.stringify({ version: SESSION_VERSION, originalScoreSharesCurrent: false, state: { ...SAMPLE, originalAtsScore: 'corrupt' } }));
    r = noThrow(loadSession);
    check(
      'baseline: a corrupt stored baseline is dropped, never replaced by the current score',
      !r.threw && !('originalAtsScore' in r.value.state) && r.value.dropped.includes('originalAtsScore') && r.value.state.atsScore.total === 61,
      r
    );

    check('API key presence unchanged by any of the above', JSON.stringify(getKeyPresence()) === presenceBefore);
  } finally {
    Storage.prototype.setItem = originalSetItem;
    Storage.prototype.getItem = originalGetItem;
    if (backup === null) localStorage.removeItem(RAW_KEY);
    else localStorage.setItem(RAW_KEY, backup);
    console.log(failed ? `${failed} FAILED` : 'all passed');
    console.log('(the stored session was restored to what it was before this ran)');
    console.groupEnd();
  }
  return failed === 0;
}

// ---------------------------------------------------------------------------
// Live checks
// ---------------------------------------------------------------------------

/** What is stored right now: per-field sizes, total, fraction of a typical quota. */
export function report() {
  const loaded = loadSession();
  const raw = localStorage.getItem(RAW_KEY);
  const sizes = loaded.state ? measureSession(loaded.state) : null;
  console.log('reason   :', loaded.reason, loaded.dropped?.length ? `(dropped: ${loaded.dropped.join(', ')})` : '');
  console.log('savedAt  :', loaded.savedAt ?? '-');
  console.log('raw chars:', raw === null ? 'no entry' : raw.length.toLocaleString());
  if (sizes) {
    console.table(sizes.perField);
    console.log(`total ${sizes.total.toLocaleString()} chars = ${(sizes.fractionOfTypicalQuota * 100).toFixed(2)}% of ~${TYPICAL_QUOTA_CHARS.toLocaleString()}`);
  }
  return { reason: loaded.reason, rawChars: raw?.length ?? 0, sizes };
}

/** Fingerprint the live store before a reload. */
export function snapshot() {
  const state = liveState();
  const fields = Object.fromEntries(PERSISTED_FIELD_NAMES.map((field) => [field, fingerprint(state[field])]));
  const populated = PERSISTED_FIELD_NAMES.filter((field) => {
    const v = state[field];
    return v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
  });
  sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ fields, populated, keyPresence: getKeyPresence(), takenAt: Date.now() }));
  console.log('snapshot taken. populated:', populated.join(', ') || '(nothing)');
  console.log('now reload the page and run verifyRehydrated().');
  return { populated };
}

/** After a reload: every persisted field in the live store matches the snapshot, and ui came back idle. */
export function verifyRehydrated() {
  const saved = JSON.parse(sessionStorage.getItem(SNAPSHOT_KEY) || 'null');
  if (!saved) throw new Error('No snapshot. Run snapshot() before reloading.');
  const state = liveState();
  const rows = PERSISTED_FIELD_NAMES.map((field) => {
    const now = fingerprint(state[field]);
    const was = saved.fields[field];
    return { field, match: now.hash === was.hash && now.chars === was.chars, charsBefore: was.chars, charsAfter: now.chars };
  });
  rows.push({ field: 'ui.status is idle', match: state.ui?.status === 'idle', charsBefore: '-', charsAfter: state.ui?.status });
  rows.push({ field: 'API key presence unchanged', match: JSON.stringify(getKeyPresence()) === JSON.stringify(saved.keyPresence), charsBefore: '-', charsAfter: '-' });
  console.table(rows);
  const ok = rows.every((row) => row.match);
  console.log(ok ? `REHYDRATED: every field matches (${saved.populated.join(', ') || 'nothing populated'})` : 'MISMATCH -- see the table');
  return ok;
}

/** After "Start over": nothing in storage, nothing in the live store, API keys untouched. */
export function verifyCleared() {
  const saved = JSON.parse(sessionStorage.getItem(SNAPSHOT_KEY) || 'null');
  const state = liveState();
  const rows = [
    { check: `no "${RAW_KEY}" entry in localStorage`, pass: localStorage.getItem(RAW_KEY) === null },
    { check: 'live store has no session content', pass: !hasSessionContent(state) },
    ...PERSISTED_FIELD_NAMES.filter((f) => !['sources', 'settings'].includes(f)).map((field) => ({
      check: `${field} is empty`,
      pass: state[field] === null || state[field] === '',
    })),
    { check: 'sources all null', pass: Object.values(state.sources ?? {}).every((v) => v === null) },
  ];
  if (saved) {
    rows.push({ check: 'API key presence unchanged since snapshot', pass: JSON.stringify(getKeyPresence()) === JSON.stringify(saved.keyPresence) });
  }
  console.table(rows);
  const ok = rows.every((row) => row.pass);
  console.log(ok ? 'CLEARED: storage and store are both empty' : 'NOT CLEARED -- see the table');
  return ok;
}

export default { testOffline, report, snapshot, verifyRehydrated, verifyCleared };
