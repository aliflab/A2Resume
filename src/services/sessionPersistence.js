/**
 * Keeps the wizard's pipeline state across a reload or a crashed tab.
 *
 * WHAT IS PERSISTED
 * The pipeline slice of AppContext state and nothing else -- see
 * PERSISTED_FIELDS. `ui` is excluded on purpose: a run that was in flight when
 * the tab died is dead, and restoring `status: 'running'` would show a spinner
 * that never stops. API keys are not in AppContext at all (apiKeyService owns
 * them, under their own localStorage entry), so they cannot reach this path.
 *
 * WHERE
 * One entry, written through storageService, which namespaces it as
 * `a2resume:session`. storageService stays logic-free; the envelope version,
 * validation and failure handling live here.
 *
 * FAILURE RULES -- the same degradation contract as every empty-state guard
 * - Missing, corrupt, wrong-version or unreadable storage hydrates to empty
 *   state. Never a throw.
 * - A field of the wrong type is dropped individually and falls back to its
 *   initial value; consumers already guard every read.
 * - A write that fails (quota, blocked storage) REMOVES the stored session
 *   rather than leaving the previous one in place. An older snapshot quietly
 *   standing in for newer work on the next reload is worse than an empty
 *   store, for the same reason jdScraper treats a 200 login wall as failure.
 *
 * THE GAP ANALYSIS IS STORED ONCE
 * calculateATSScore embeds the gap analysis it scored against, and every
 * dispatch site hands it `state.gapAnalysis`, so in memory `atsScore.gapAnalysis`
 * and `gapAnalysis` are one object. JSON has no references, so a plain write
 * stored it twice. It is now written only under `gapAnalysis`, and the envelope
 * flag `atsScoreSharesGapAnalysis` tells loadSession to re-attach it. The
 * restored state has the same shape as before, so no reader changes.
 * - Stripped only when the two are the same object. Anything else is written
 *   as-is: a different embedded copy is data, not a duplicate.
 * - The flag is what licenses re-attaching. A stored score that never had an
 *   embedded copy is not given one.
 * - A session written before this change (two equal copies, no flag) loads
 *   with one shared object, so its next save is already deduplicated. Old and
 *   new envelopes read correctly in both directions, so SESSION_VERSION is
 *   unchanged.
 *
 * THE COVER LETTER RIDES THE SAME ENVELOPE, AND NEEDS NO VERSION BUMP
 * `coverLetter` is one more `'object'` field. Adding a field is backward
 * compatible in both directions, which is why `draftEdits` did not need a bump
 * either: an OLD envelope simply has no `coverLetter` key, `acceptField` never
 * sees it, and the field falls back to its `initialState` value of null -- the
 * same path a session that never generated one takes. A NEW envelope read by an
 * older build has one key it does not know about, and `loadSession` only reads
 * the names in its own PERSISTED_FIELDS, so it is ignored rather than breaking
 * the load. SESSION_VERSION is for shape changes that cannot be read at all;
 * this is not one. A wrong-typed `coverLetter` is dropped on its own like any
 * other field, and the page then renders its empty state.
 *
 * It IS an ARTEFACT_FIELD, unlike `draftEdits`: a letter is real generated work
 * that cost an AI call, so a session holding nothing but a letter is still
 * worth keeping in storage. A pending draft is not, which is why that one is
 * deliberately excluded.
 *
 * THE MATCH BATCH IS THE LARGEST THING STORED HERE, AND BOTH HALVES ARE ARTEFACTS
 * `matchPostings` (the pasted or fetched job descriptions) and `matchResults`
 * (their scores and gap analyses) are two more ordinary fields, and both are
 * ARTEFACT_FIELDS, unlike `draftEdits`:
 * - `matchResults` is one paid AI call per row. Losing it silently would be
 *   losing money, the same argument that put `coverLetter` in the list.
 * - `matchPostings` is durable user input that can legitimately be the ONLY
 *   thing in a session -- there are no route guards, so someone can paste eight
 *   postings on /match before ever running step 1. If it were not an artefact,
 *   `hasSessionContent` would call that session empty and the save would remove
 *   the entry, so a reload would lose all eight. A pending editor draft is the
 *   opposite case: it is always accompanied by other content and is cleared the
 *   moment it is spent, which is why it stays out.
 *
 * Size is the thing to watch here, because this is the first feature that stores
 * SEVERAL postings' worth of data rather than one. Two deliberate trims, both
 * made in `matchRunner` at build time rather than here:
 * - A result row stores a SUMMARY of the parsed JD, not the whole parse.
 * - A result row does NOT store the raw JD text. That lives once, on the
 *   posting, where the user can still edit it. Up to 60k characters each (the
 *   scraper's cap), so ten copies of it would dominate the whole session.
 * - A result row's score drops `recommendations` and its embedded `gapAnalysis`,
 *   the latter being the same deduplication this module performs for the
 *   pipeline's own score -- done at build time because a Match row has no
 *   envelope flag to carry the fact.
 * Measured figures are in `match.manual.js`; re-run `measureBatch()` if the
 * stored shape changes. Adding these fields needs no SESSION_VERSION bump, for
 * the same reason `coverLetter` and `draftEdits` did not: a missing key falls
 * back to its initial value and an unknown key is ignored.
 *
 * PENDING DRAFTS ARE STORED, BUT THEY ARE NOT THE RESUME
 * `draftEdits` is editor content typed and not yet saved. It rides this same
 * envelope rather than a second storage key, and is validated like any other
 * field: a wrong-typed one is dropped on its own and the session still loads.
 * Nothing downstream reads it -- Export prints `tailoredResume` and the scorer
 * scores it, both untouched by a pending draft. It is deliberately NOT an
 * ARTEFACT_FIELD: a draft is never the only thing in a session, so it must not
 * be what keeps an otherwise-empty session alive in storage. It is cleared
 * whenever the content it edits stops existing (a new pass, a discard, a new
 * Input run) and when its block is saved, so it never lingers once spent.
 *
 * THE BASELINE SCORE IS STORED ONCE TOO
 * `originalGapAnalysis` / `originalAtsScore` are the Input run's score, kept as
 * a permanent "before tailoring" baseline while `gapAnalysis` / `atsScore`
 * track the current resume. Until something changes the resume the two pairs
 * are the very same objects (the reducer, via rescoreCurrentResume, reuses the
 * baseline objects whenever a rescore lands back on an identical result), so:
 * - Same objects -> the original pair is omitted and `originalScoreSharesCurrent`
 *   is set; loadSession points the original fields at the restored current ones.
 * - Different objects -> the original pair is written, with its own embedded
 *   gap analysis stripped under `originalAtsScoreSharesGapAnalysis`, by the same
 *   identity rule as the current pair.
 * - An envelope with no `originalScoreSharesCurrent` key at all was written
 *   before baselines existed. Its stored score was computed against the
 *   original resume (it never tracked tailoring), so it is adopted as the
 *   baseline. AppContext's hydrate then rescores the current resume.
 * Old envelopes still read correctly, so SESSION_VERSION is unchanged.
 */

import { get, remove, set } from './storageService.js';

/** Stored as `a2resume:session` -- storageService adds the prefix. */
export const SESSION_STORAGE_NAME = 'session';
/** Bump when the persisted shape changes incompatibly; older sessions are then discarded, not migrated. */
export const SESSION_VERSION = 1;

/**
 * Rough per-origin localStorage budget. Browsers differ and count UTF-16 code
 * units rather than bytes, but ~5 million characters is the common floor
 * (Chromium, Firefox, Safari), shared across every key on the origin.
 */
export const TYPICAL_QUOTA_CHARS = 5_000_000;

/** Field -> kind. 'object' and 'array' also accept null ("not produced yet"). */
const PERSISTED_FIELDS = {
  resumeText: 'string',
  resume: 'object',
  jobDescription: 'string',
  parsedJD: 'object',
  gapAnalysis: 'object',
  atsScore: 'object',
  originalGapAnalysis: 'object',
  originalAtsScore: 'object',
  tailoredResume: 'object',
  changesLog: 'array',
  tailorCorrections: 'array',
  tailorManualEdits: 'array',
  draftEdits: 'array',
  coverLetter: 'object',
  matchPostings: 'array',
  matchResults: 'object',
  sources: 'flat',
  settings: 'flat',
};

export const PERSISTED_FIELD_NAMES = Object.keys(PERSISTED_FIELDS);

/** Fields whose presence means a pipeline step actually produced something. */
const ARTEFACT_FIELDS = [
  'resume',
  'parsedJD',
  'gapAnalysis',
  'atsScore',
  'originalGapAnalysis',
  'originalAtsScore',
  'tailoredResume',
  'changesLog',
  'tailorCorrections',
  'tailorManualEdits',
  'coverLetter',
  'matchPostings',
  'matchResults',
];

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A `sources`/`settings` block: keep only string-or-null values, drop the rest. */
function sanitizeFlat(value) {
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (inner === null || typeof inner === 'string') out[key] = inner;
  }
  return out;
}

function acceptField(kind, value) {
  switch (kind) {
    case 'string':
      return typeof value === 'string' ? { ok: true, value } : { ok: false };
    case 'array':
      return value === null || Array.isArray(value) ? { ok: true, value } : { ok: false };
    case 'object':
      return value === null || isPlainObject(value) ? { ok: true, value } : { ok: false };
    case 'flat':
      return isPlainObject(value) ? { ok: true, value: sanitizeFlat(value) } : { ok: false };
    default:
      return { ok: false };
  }
}

/** The persisted slice of any state-shaped value. */
export function pickSessionSlice(state) {
  const s = isPlainObject(state) ? state : {};
  const slice = {};
  for (const field of PERSISTED_FIELD_NAMES) slice[field] = s[field];
  return slice;
}

/** `state` with `state[scoreKey].gapAnalysis` removed when it is the very object at `state[gapKey]`. */
function stripEmbeddedGap(state, scoreKey, gapKey) {
  const score = state[scoreKey];
  const gap = state[gapKey];
  if (!isPlainObject(score) || !isPlainObject(gap) || score.gapAnalysis !== gap) return { state, stripped: false };
  const stored = { ...score };
  delete stored.gapAnalysis;
  return { state: { ...state, [scoreKey]: stored }, stripped: true };
}

/**
 * The slice as it is written, and the envelope flags that say what was left
 * out. See "THE GAP ANALYSIS IS STORED ONCE" and "THE BASELINE SCORE IS
 * STORED ONCE TOO" above.
 */
function toStoredSlice(slice) {
  let state = slice;
  const originalScoreSharesCurrent =
    isPlainObject(slice.atsScore) &&
    isPlainObject(slice.gapAnalysis) &&
    slice.originalAtsScore === slice.atsScore &&
    slice.originalGapAnalysis === slice.gapAnalysis;
  if (originalScoreSharesCurrent) {
    state = { ...state };
    delete state.originalGapAnalysis;
    delete state.originalAtsScore;
  }

  const current = stripEmbeddedGap(state, 'atsScore', 'gapAnalysis');
  const original = stripEmbeddedGap(current.state, 'originalAtsScore', 'originalGapAnalysis');
  return {
    state: original.state,
    flags: {
      atsScoreSharesGapAnalysis: current.stripped,
      originalScoreSharesCurrent,
      originalAtsScoreSharesGapAnalysis: original.stripped,
    },
  };
}

/**
 * True when there is something worth keeping: input text, or any artefact.
 * A provider choice or a sources block on its own is not a session.
 */
export function hasSessionContent(state) {
  const s = isPlainObject(state) ? state : {};
  const text = (value) => typeof value === 'string' && value.trim() !== '';
  return text(s.resumeText) || text(s.jobDescription) || ARTEFACT_FIELDS.some((field) => s[field] != null);
}

// ---------------------------------------------------------------------------
// Save status -- a tiny external store, read with useSyncExternalStore
// ---------------------------------------------------------------------------

let status = { ok: true, error: null, message: null };
const listeners = new Set();

function report(next) {
  if (next.ok === status.ok && next.error === status.error) return;
  status = next;
  listeners.forEach((listener) => listener());
}

export const subscribePersistence = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getPersistenceStatus = () => status;

function describeWriteFailure(err) {
  const quota = err?.name === 'QuotaExceededError' || err?.code === 22;
  return quota
    ? { ok: false, error: 'quota', message: 'Browser storage is full, so a reload will lose this session.' }
    : { ok: false, error: 'unavailable', message: 'Browser storage is blocked, so a reload will lose this session.' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist the pipeline slice. Removes the entry instead when there is nothing
 * to keep, so a cleared store leaves no stale entry behind.
 *
 * @returns {{ ok: boolean, removed?: boolean, error?: string | null, message?: string | null }}
 */
export function saveSession(state) {
  const slice = pickSessionSlice(state);
  try {
    if (!hasSessionContent(slice)) {
      remove(SESSION_STORAGE_NAME);
      report({ ok: true, error: null, message: null });
      return { ok: true, removed: true };
    }
    const stored = toStoredSlice(slice);
    set(SESSION_STORAGE_NAME, {
      version: SESSION_VERSION,
      savedAt: new Date().toISOString(),
      ...stored.flags,
      state: stored.state,
    });
    report({ ok: true, error: null, message: null });
    return { ok: true, removed: false };
  } catch (err) {
    try {
      remove(SESSION_STORAGE_NAME);
    } catch {
      // Storage is unusable entirely; there is no stale entry we can reach either.
    }
    const failure = describeWriteFailure(err);
    report(failure);
    return failure;
  }
}

/**
 * Read the stored session. Never throws.
 *
 * @returns {{ state: object | null, reason: 'restored' | 'missing' | 'corrupt' | 'incompatible' | 'unavailable', savedAt?: string | null, dropped?: string[] }}
 */
export function loadSession() {
  let envelope;
  try {
    envelope = get(SESSION_STORAGE_NAME);
  } catch (err) {
    return { state: null, reason: err instanceof SyntaxError ? 'corrupt' : 'unavailable' };
  }

  if (envelope === null) return { state: null, reason: 'missing' };
  if (!isPlainObject(envelope) || envelope.version !== SESSION_VERSION || !isPlainObject(envelope.state)) {
    return { state: null, reason: 'incompatible' };
  }

  const values = {};
  const dropped = [];
  for (const [field, kind] of Object.entries(PERSISTED_FIELDS)) {
    if (!(field in envelope.state)) continue;
    const accepted = acceptField(kind, envelope.state[field]);
    if (accepted.ok) values[field] = accepted.value;
    else dropped.push(field);
  }

  // Re-attach the gap analysis to the score it was stripped from. Only when
  // both survived validation; a dropped gapAnalysis leaves the score without
  // one, which readers already tolerate (they fall back to state.gapAnalysis).
  const { atsScore, gapAnalysis } = values;
  if (isPlainObject(atsScore) && isPlainObject(gapAnalysis)) {
    const stripped = envelope.atsScoreSharesGapAnalysis === true;
    // Written before deduplication: two equal copies. Share one object so the
    // next save writes it once. Spreading keeps the key where it was.
    const equalCopy =
      !stripped && isPlainObject(atsScore.gapAnalysis) && JSON.stringify(atsScore.gapAnalysis) === JSON.stringify(gapAnalysis);
    if (stripped || equalCopy) values.atsScore = { ...atsScore, gapAnalysis };
  }

  // The baseline. Shared with the current pair, or written before baselines
  // existed (no flag at all): point it at the restored current objects. A
  // baseline actually present in storage is never overridden.
  const legacyBaseline = !('originalScoreSharesCurrent' in envelope);
  const hasStoredBaseline = 'originalGapAnalysis' in envelope.state || 'originalAtsScore' in envelope.state;
  if ((envelope.originalScoreSharesCurrent === true || legacyBaseline) && !hasStoredBaseline) {
    if ('gapAnalysis' in values) values.originalGapAnalysis = values.gapAnalysis;
    if ('atsScore' in values) values.originalAtsScore = values.atsScore;
  } else if (
    envelope.originalAtsScoreSharesGapAnalysis === true &&
    isPlainObject(values.originalAtsScore) &&
    isPlainObject(values.originalGapAnalysis)
  ) {
    values.originalAtsScore = { ...values.originalAtsScore, gapAnalysis: values.originalGapAnalysis };
  }

  // Rebuilt in field order, so a restored state serialises exactly like the
  // one that was saved, whichever fields were re-attached above.
  const restored = {};
  for (const field of PERSISTED_FIELD_NAMES) if (field in values) restored[field] = values[field];

  return {
    state: restored,
    reason: 'restored',
    savedAt: typeof envelope.savedAt === 'string' ? envelope.savedAt : null,
    dropped,
  };
}

/** Delete the stored session. Never throws. */
export function clearSession() {
  try {
    remove(SESSION_STORAGE_NAME);
  } catch {
    // Nothing reachable to delete.
  }
  report({ ok: true, error: null, message: null });
}

/**
 * Serialized size of a state's persisted slice, in UTF-16 code units (what
 * browsers count against the quota), total and per field. Measures what
 * saveSession actually writes, so `atsScore` excludes the shared gap analysis
 * and a baseline shared with the current score counts as absent (`null`, 4).
 */
export function measureSession(state) {
  const { state: slice, flags } = toStoredSlice(pickSessionSlice(state));
  const perField = {};
  for (const field of PERSISTED_FIELD_NAMES) perField[field] = JSON.stringify(slice[field] ?? null).length;
  const total = JSON.stringify({
    version: SESSION_VERSION,
    savedAt: new Date().toISOString(),
    ...flags,
    state: slice,
  }).length;
  return { total, perField, fractionOfTypicalQuota: total / TYPICAL_QUOTA_CHARS };
}
