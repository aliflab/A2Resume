/**
 * "The current resume": the one resume every later step should be looking at.
 *
 * That is the tailored resume when a tailoring pass exists -- hand edits and
 * approved inferred skills are already merged into it by
 * UPDATE_TAILORED_SECTION and MERGE_INFERRED_SKILLS -- and the original parse
 * otherwise. Export prints it, and the ATS score and gap analysis describe it.
 *
 * THE BUG THIS EXISTS TO PREVENT
 * The score used to be computed once, in the Input pipeline, against the
 * original parse, and never again. Tailor, the hand editor and skill approvals
 * all changed the resume, but Analyze kept showing the pre-tailoring number, so
 * a user improving their resume saw no evidence it had worked. Every piece was
 * correct in isolation; the wiring between stages was the failure. The pipeline
 * scenario in __manual__/pipeline.manual.js is the test for exactly that.
 *
 * WHY SELECTION IS SHARED WITH EXPORT BUT NORMALISATION IS NOT
 * `selectExportSource` is this module's `selectCurrentResume` under its old
 * name, so Export and the score cannot disagree about which resume is current.
 * `normalizeResumeForExport` is deliberately NOT applied before scoring: it
 * reshapes the resume for printing (contact links renamed, dates collapsed
 * into one display string, `isCurrentlyWorking` dropped), and the scorer reads
 * the parsed shape. Scoring the export shape would quietly zero criteria.
 *
 * Pure, synchronous and network-free, like the analysers it wraps.
 */

import { analyzeCompetencyGaps, asArray, asObject } from './gapAnalyzer.js';
import { calculateATSScore } from './atsScorer.js';

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * The tailored resume when a tailoring pass exists, otherwise the original
 * parse. Never assume Tailor was run.
 *
 * @param {unknown} state The AppContext state.
 * @returns {{ raw: object | null, source: 'tailored' | 'original' | null }}
 */
export function selectCurrentResume(state) {
  const s = asObject(state);
  if (isPlainObject(s.tailoredResume)) return { raw: s.tailoredResume, source: 'tailored' };
  if (isPlainObject(s.resume)) return { raw: s.resume, source: 'original' };
  return { raw: null, source: null };
}

const json = (value) => JSON.stringify(value ?? null);

/**
 * `state` with `gapAnalysis` / `atsScore` recomputed against the current
 * resume and `state.parsedJD`. Returns `state` itself when there is nothing to
 * score (no resume, no parsed JD) or when the result is unchanged.
 *
 * `originalGapAnalysis` / `originalAtsScore` are never written here. They are
 * the baseline from the Input run.
 *
 * IDENTITY IS KEPT WHEN THE RESULT IS UNCHANGED
 * A result equal to the stored current pair keeps those objects. A result equal
 * to the baseline reuses the baseline objects: discarding a tailoring pass, or
 * a reload with no tailoring, lands back on `current === original`. That is
 * what lets sessionPersistence store the two pairs once when they are the same.
 * It also lets an edit that does not move the score leave `atsScore` untouched.
 * The scorer has no clock and no randomness, so equal JSON means equal output.
 *
 * STALENESS
 * The JD read here is `state.parsedJD`, and nothing replaces that except a new
 * Input run, which goes through CLEAR_ANALYSIS first and so also clears the
 * tailored resume. A tailoring pass that finishes after a new run started is
 * refused by SET_TAILORED_RESUME (see AppContext), so a tailored resume is never
 * scored against a JD it was not tailored for.
 *
 * @template T
 * @param {T} state
 * @returns {T}
 */
export function rescoreCurrentResume(state) {
  const s = asObject(state);
  const { raw } = selectCurrentResume(s);
  if (!raw || !isPlainObject(s.parsedJD)) return state;

  const gapAnalysis = analyzeCompetencyGaps(raw, s.parsedJD);
  const atsScore = calculateATSScore(raw, s.parsedJD, gapAnalysis);

  // atsScore embeds gapAnalysis, so its JSON covers both.
  const freshJson = json(atsScore);
  const gapJson = json(gapAnalysis);
  const equalTo = (gap, score) => isPlainObject(gap) && isPlainObject(score) && json(score) === freshJson && json(gap) === gapJson;

  let next = { gapAnalysis, atsScore };
  if (equalTo(s.gapAnalysis, s.atsScore)) next = { gapAnalysis: s.gapAnalysis, atsScore: s.atsScore };
  else if (equalTo(s.originalGapAnalysis, s.originalAtsScore)) {
    next = { gapAnalysis: s.originalGapAnalysis, atsScore: s.originalAtsScore };
  }

  if (next.gapAnalysis === s.gapAnalysis && next.atsScore === s.atsScore) return state;
  return { ...s, ...next };
}

// ---------------------------------------------------------------------------
// Before / after
// ---------------------------------------------------------------------------

const BUCKETS = ['missing', 'partial', 'matched'];
const RANK = { missing: 0, partial: 1, matched: 2 };
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * "up 22.3 points", "down 4 percentage points", "no change". Shared by Analyze
 * and Tailor so the two pages describe one change in one way.
 *
 * @param {ReturnType<typeof compareScores>} comparison
 */
export function describeScoreChange(comparison) {
  if (!comparison || comparison.direction === 'same') return 'no change';
  const n = Math.abs(comparison.delta);
  const unit = comparison.sameScale ? (n === 1 ? 'point' : 'points') : 'percentage points';
  return `${comparison.direction} ${n} ${unit}`;
}

/** keyword (case-folded) -> { keyword, priority, bucket } */
function bucketIndex(gap) {
  const g = asObject(gap);
  const index = new Map();
  for (const bucket of BUCKETS) {
    for (const item of asArray(g[bucket])) {
      const keyword = typeof item?.keyword === 'string' ? item.keyword.trim() : '';
      if (!keyword) continue;
      index.set(keyword.toLowerCase(), { keyword, priority: item.priority, bucket });
    }
  }
  return index;
}

/**
 * How the score and keyword coverage moved between the baseline and the
 * current score. Null when either score is unusable.
 *
 * Totals are compared as points only when both are out of the same maximum.
 * A baseline scored as a fallback (criteria unmeasurable) has a smaller
 * `scoreableMax`, and "58 of 90 -> 61 of 100" is not "up 3 points" -- so in
 * that case the comparison is by percentage and says so.
 *
 * Keyword movement is by keyword string. Both analyses come from the same
 * parsed JD, so the keyword list is the same; a keyword present in only one
 * of them (a baseline stored by an older build) is left out rather than
 * guessed at.
 *
 * @param {unknown} originalScore `originalAtsScore`
 * @param {unknown} currentScore `atsScore`
 * @param {unknown} [originalGap] defaults to the score's embedded analysis
 * @param {unknown} [currentGap]
 */
export function compareScores(originalScore, currentScore, originalGap, currentGap) {
  const before = asObject(originalScore);
  const after = asObject(currentScore);
  if (typeof before.total !== 'number' || typeof after.total !== 'number') return null;

  const sameScale = before.scoreableMax === after.scoreableMax;
  const unit = sameScale ? 'points' : 'percent';
  const delta = sameScale ? round1(after.total - before.total) : round1((after.percentage ?? 0) - (before.percentage ?? 0));

  const was = bucketIndex(originalGap ?? before.gapAnalysis);
  const now = bucketIndex(currentGap ?? after.gapAnalysis);
  const improved = [];
  const regressed = [];
  for (const [key, entry] of now) {
    const prior = was.get(key);
    if (!prior || prior.bucket === entry.bucket) continue;
    const move = { keyword: entry.keyword, priority: entry.priority, from: prior.bucket, to: entry.bucket };
    (RANK[entry.bucket] > RANK[prior.bucket] ? improved : regressed).push(move);
  }
  const byPriority = (a, b) => (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3);
  improved.sort(byPriority);
  regressed.sort(byPriority);

  return {
    before: { total: before.total, scoreableMax: before.scoreableMax, percentage: before.percentage, grade: before.grade },
    after: { total: after.total, scoreableMax: after.scoreableMax, percentage: after.percentage, grade: after.grade },
    sameScale,
    unit,
    delta,
    direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'same',
    keywords: { improved, regressed },
  };
}
