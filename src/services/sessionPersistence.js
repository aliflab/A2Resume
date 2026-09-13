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
  tailoredResume: 'object',
  changesLog: 'array',
  tailorCorrections: 'array',
  sources: 'flat',
  settings: 'flat',
};

export const PERSISTED_FIELD_NAMES = Object.keys(PERSISTED_FIELDS);

/** Fields whose presence means a pipeline step actually produced something. */
const ARTEFACT_FIELDS = ['resume', 'parsedJD', 'gapAnalysis', 'atsScore', 'tailoredResume', 'changesLog', 'tailorCorrections'];

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
    set(SESSION_STORAGE_NAME, { version: SESSION_VERSION, savedAt: new Date().toISOString(), state: slice });
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

  const restored = {};
  const dropped = [];
  for (const [field, kind] of Object.entries(PERSISTED_FIELDS)) {
    if (!(field in envelope.state)) continue;
    const accepted = acceptField(kind, envelope.state[field]);
    if (accepted.ok) restored[field] = accepted.value;
    else dropped.push(field);
  }

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
 * browsers count against the quota), total and per field.
 */
export function measureSession(state) {
  const slice = pickSessionSlice(state);
  const perField = {};
  for (const field of PERSISTED_FIELD_NAMES) perField[field] = JSON.stringify(slice[field] ?? null).length;
  const total = JSON.stringify({ version: SESSION_VERSION, savedAt: new Date().toISOString(), state: slice }).length;
  return { total, perField, fractionOfTypicalQuota: total / TYPICAL_QUOTA_CHARS };
}
