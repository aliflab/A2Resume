/**
 * One resume against several job postings, ranked.
 *
 * NO NEW AI CAPABILITY. This is `jdParser` -> `analyzeCompetencyGaps` ->
 * `calculateATSScore`, the exact chain `analysisPipeline.js` already runs for
 * one posting, looped. Nothing here has its own prompt, its own schema or its
 * own model. If a scoring rule needs changing it changes in `atsScorer.js` and
 * this follows automatically -- which is the whole reason Match is a loop over
 * existing services rather than a service of its own.
 *
 * React-free, like every other service here: it reports through `onProgress`
 * and the page decides what that means for the store. That is what lets the
 * batch be driven from a console.
 *
 * N POSTINGS IS N PAID AI CALLS, AND THAT SHAPES THE WHOLE DESIGN
 * --------------------------------------------------------------
 * Only the JD parse is an AI call; the gap analysis and the score are pure and
 * free. So a batch of 8 postings is 8 provider calls on the user's own key, not
 * one. Three consequences, all deliberate:
 *
 *   1. `MAX_POSTINGS` caps a batch. The ceiling is about money and wall time,
 *      not about anything technical.
 *   2. The calls are SEQUENTIAL. Running them in parallel would be faster and
 *      is the wrong trade: a bad key produces one auth failure on posting 1
 *      instead of eight simultaneous ones, and `runWithFallback`'s 429 backoff
 *      is per-call, so eight concurrent calls on a rate-limited key would
 *      mostly retry each other. Same reasoning as `analysisPipeline` running
 *      its two parses in sequence.
 *   3. ONE POSTING'S FAILURE MUST NOT DISCARD THE OTHERS' RESULTS. A posting
 *      that fails to parse is recorded with its error and the loop continues.
 *      Throwing out of the batch would mean the user paid for five successful
 *      parses and got nothing, which is the most expensive possible failure
 *      mode here. `stopOnAuthError` is the one exception -- see below.
 *
 * `onProgress` fires per posting, before and after, so the page can show real
 * per-item progress rather than one opaque spinner over several minutes.
 *
 * Changes what a stored session would contain for the same input? Bump
 * ARTEFACT_VERSION in sessionPersistence.js, so restored results are flagged.
 */

import { parseJobDescriptionWithAI } from './jdParser.js';
import { analyzeCompetencyGaps, asArray, asObject, asString } from './gapAnalyzer.js';
import { calculateATSScore } from './atsScorer.js';
import { fingerprint, isStaleAgainst } from '../utils/artefactFingerprint.js';

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * How many postings one batch may hold.
 *
 * Ten is a judgment call about cost, not a technical limit. At ten the user is
 * authorising ten provider calls in one click; the JD parse runs on the shared
 * 20s `DEFAULT_TIMEOUT_MS`, so a batch that hits fallbacks can take minutes of
 * wall time, and there is no way to show a meaningful total estimate because
 * per-call latency varies by an order of magnitude across providers. The UI
 * states the count and the cost before the run rather than hiding it behind a
 * number nobody reads.
 */
export const MAX_POSTINGS = 10;

/** Statuses a posting moves through. `pending` -> `running` -> `done` | `failed`. */
export const POSTING_STATUSES = ['pending', 'running', 'done', 'failed'];

let seq = 0;

/**
 * A new posting for the batch.
 *
 * `id` is generated here rather than derived from the text or the URL, because
 * a user legitimately adds the same posting twice (two teams, one description)
 * and a content-derived id would silently merge them. It is also what React
 * keys on, and what `removeMatchResult` addresses -- an index would drift the
 * moment one is removed, which is the bug `reindexRowsAfterRemoval` exists for
 * on the Tailor page. Addressing by id means there is no index to drift.
 *
 * @param {{ text?: string, url?: string, label?: string, source?: 'paste' | 'url' }} input
 */
export function createPosting(input) {
  // `asObject`, not a destructuring default: a default only covers `undefined`,
  // so `createPosting(null)` threw on the first version of this. Same
  // degradation contract as every other service here -- junk in, a valid shape
  // out, never a throw.
  const { text, url, label, source } = asObject(input);
  seq += 1;
  return {
    id: `p${Date.now().toString(36)}-${seq.toString(36)}`,
    label: asString(label).trim(),
    text: asString(text),
    url: asString(url).trim(),
    source: source === 'url' ? 'url' : 'paste',
    status: 'pending',
    error: null,
  };
}

/** True when this posting has text worth spending a call on. */
export const isRunnablePosting = (posting) => asString(asObject(posting).text).trim().length > 0;

/**
 * What to call a posting on screen.
 *
 * The user's nickname wins when they gave one -- they typed it for a reason,
 * and after a run it is the only thing distinguishing two postings for the same
 * job title. Otherwise the parsed title and company, then the URL's path, then
 * a numbered fallback so a row is never blank.
 *
 * @param {unknown} posting
 * @param {unknown} [parsedJD]
 * @param {number} [index]
 */
export function describePosting(posting, parsedJD, index = 0) {
  const p = asObject(posting);
  const nickname = asString(p.label).trim();
  if (nickname) return nickname;

  const jd = asObject(parsedJD);
  const title = asString(jd.jobTitle).trim();
  const company = asString(jd.company).trim();
  if (title && company) return `${title} — ${company}`;
  if (title) return title;
  if (company) return company;

  const url = asString(p.url).trim();
  if (url) {
    try {
      const parsed = new URL(url);
      const tail = parsed.pathname.split('/').filter(Boolean).slice(-2).join('/');
      return tail ? `${parsed.hostname}/${tail}` : parsed.hostname;
    } catch {
      return url.slice(0, 60);
    }
  }
  return `Posting ${index + 1}`;
}

// ---------------------------------------------------------------------------
// What gets stored
// ---------------------------------------------------------------------------

/**
 * The JD fields a Match row needs, and no more.
 *
 * A full parsed JD is 2-3k of json and Match never renders most of it -- the
 * responsibilities, the full requirement clauses and the raw keyword lists are
 * all reachable through the gap analysis, which is stored beside this. Ten full
 * parses would be ~25k of storage nobody reads. This is the first feature that
 * can store several postings' worth of data at once, so the trimming is
 * deliberate and measured in `match.manual.js`.
 *
 * `atsKeywords` is kept because it is the authority `collectJDKeywords` reads
 * and the one part a re-score would need.
 */
export function summariseJD(parsedJD) {
  const jd = asObject(parsedJD);
  const keywords = asObject(jd.atsKeywords);
  const list = (value) => asArray(value).map(asString).map((s) => s.trim()).filter(Boolean);
  return {
    jobTitle: asString(jd.jobTitle).trim(),
    company: asString(jd.company).trim(),
    location: asString(jd.location).trim(),
    employmentType: asString(jd.employmentType).trim(),
    seniority: asString(jd.seniority).trim(),
    atsKeywords: { high: list(keywords.high), medium: list(keywords.medium), low: list(keywords.low) },
  };
}

/**
 * The score fields a Match row needs.
 *
 * `recommendations` and the embedded `gapAnalysis` are BOTH dropped.
 * Recommendations are prose regenerated from the breakdown, Match does not
 * render them, and they are the largest part of a stored score. The embedded gap
 * analysis is dropped because the row stores the same object once under `gap` --
 * exactly the deduplication `sessionPersistence` performs for the pipeline's own
 * score, done here at build time instead, since a Match row has no envelope flag
 * to carry.
 *
 * `breakdown` is kept: it is the per-criterion detail, it is what makes a score
 * explicable rather than a number, and it is small.
 */
export function summariseScore(atsScore) {
  const score = asObject(atsScore);
  return {
    total: score.total,
    maxScore: score.maxScore,
    scoreableMax: score.scoreableMax,
    percentage: score.percentage,
    grade: score.grade,
    isFallback: score.isFallback === true,
    fallbackReasons: asArray(score.fallbackReasons),
    breakdown: asArray(score.breakdown),
  };
}

/**
 * One finished row: what the posting was, what it scored, and the gap analysis
 * behind it.
 *
 * The raw JD text is deliberately NOT stored on the result. It is up to 60k
 * characters (the scraper's cap) and ten of them would blow past a realistic
 * share of the quota on their own. It stays on the posting in `matchPostings`,
 * where the user can still see and edit it, and where one batch of it is the
 * most that ever exists. Measured in `match.manual.js`.
 */
export function buildMatchResult({ posting, parsedJD, gap, score, index = 0 }) {
  const p = asObject(posting);
  return {
    id: p.id,
    label: describePosting(p, parsedJD, index),
    nickname: asString(p.label).trim(),
    url: asString(p.url).trim(),
    source: p.source === 'url' ? 'url' : 'paste',
    jd: summariseJD(parsedJD),
    score: summariseScore(score),
    gap,
    error: null,
  };
}

/** A row for a posting that could not be parsed. Keeps its place in the batch. */
export function buildFailedResult({ posting, error, index = 0 }) {
  const p = asObject(posting);
  return {
    id: p.id,
    label: describePosting(p, null, index),
    nickname: asString(p.label).trim(),
    url: asString(p.url).trim(),
    source: p.source === 'url' ? 'url' : 'paste',
    jd: null,
    score: null,
    gap: null,
    error: isPlainObject(error) ? error : { message: asString(error) || 'This posting could not be read.' },
  };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/** Priority order, highest first. Matches what `gapAnalyzer` assigns. */
const PRIORITIES = ['high', 'medium', 'low'];

/**
 * The highest-priority keywords a resume is missing, for a Match row's one-line
 * summary.
 *
 * Lives here, not next to the component that renders it, for two reasons: it is
 * pure ranking logic with no JSX in it, and a `.jsx` module cannot be loaded by
 * Node -- putting it there would have cost `match.manual.js` its "also runs
 * under Node" property, which is how the offline assertions run without a
 * browser.
 *
 * A keyword with an unrecognised priority is still missing, so it goes last
 * rather than disappearing from the summary.
 *
 * @param {unknown} gap
 * @param {number} [limit]
 * @returns {{ keyword: string, priority: string }[]}
 */
export function topMissingKeywords(gap, limit = 3) {
  const missing = asArray(asObject(gap).missing).filter((k) => isPlainObject(k) && typeof k.keyword === 'string');
  const ranked = PRIORITIES.flatMap((priority) => missing.filter((k) => k.priority === priority));
  const rest = missing.filter((k) => !PRIORITIES.includes(k.priority));
  return [...ranked, ...rest].slice(0, limit);
}

/**
 * Highest score first.
 *
 * RANKED BY `percentage`, NOT `total`. A posting whose resume could not be
 * measured on every criterion is scored out of a smaller `scoreableMax`
 * (`atsScorer` excludes unmeasurable criteria from the denominator rather than
 * silently scoring out of 100), so "62 of 90" and "62 of 100" are different
 * results with the same total. Ranking on the total would put them level and
 * quietly favour the less complete one. `compareScores` draws the same
 * distinction for the same reason.
 *
 * Failed rows sort last, never interleaved with real results -- a row with no
 * score is not "worst match", it is "not answered".
 */
export function rankMatchResults(results) {
  const rows = asArray(results).filter(isPlainObject);
  const scored = rows.filter((r) => isPlainObject(r.score) && typeof r.score.percentage === 'number');
  const unscored = rows.filter((r) => !(isPlainObject(r.score) && typeof r.score.percentage === 'number'));
  scored.sort((a, b) => b.score.percentage - a.score.percentage);
  return [...scored, ...unscored];
}

/** `results` without the row at `id`. Returns the argument when nothing matched. */
export function removeMatchResult(results, id) {
  const rows = asArray(results);
  const kept = rows.filter((r) => !(isPlainObject(r) && r.id === id));
  return kept.length === rows.length ? results : kept;
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

/**
 * Whether a completed batch still describes the resume in front of it.
 *
 * ONE FINGERPRINT FOR THE WHOLE BATCH, NOT ONE PER ROW. Every row in a batch is
 * scored against the same resume in the same run, so a resume change staleness
 * every row at once -- there is no state in which row 3 is stale and row 4 is
 * not. Storing a fingerprint per row would let those disagree, and a UI showing
 * "stale" on some rows and not others would be describing a situation that
 * cannot happen while implying it can.
 *
 * The JD is deliberately NOT part of this. Each row has its own posting, the
 * pipeline's `state.parsedJD` is a different artefact entirely, and a Match row
 * is not invalidated by the user running a new analysis on some other job. A
 * posting's own text changing is handled separately: editing it makes the
 * posting runnable again, and the row it produced is replaced on the next run.
 *
 * `null` means cannot tell -- no batch, or one stored before fingerprints
 * existed. Render that as unknown, never as fresh.
 *
 * @param {unknown} matchResults the stored `state.matchResults`
 * @param {unknown} resume the current resume
 * @returns {boolean | null} true when stale
 */
export function isMatchStale(matchResults, resume) {
  const batch = asObject(matchResults);
  if (asArray(batch.results).length === 0) return null;
  return isStaleAgainst(batch.resumeFingerprint, resume);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Parse and score every posting, in order.
 *
 * @param {object} options
 * @param {unknown[]} options.postings
 * @param {unknown} options.resume the CURRENT resume (selectCurrentResume)
 * @param {string} options.provider
 * @param {string} options.apiKey
 * @param {string} [options.model]
 * @param {(event: object) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.stopOnAuthError]
 * @returns {Promise<{ results: object[], resumeFingerprint: string, ranAt: string, provider: string, completed: number, failed: number, aborted: boolean }>}
 */
export async function runMatchBatch({
  postings,
  resume,
  provider,
  apiKey,
  model,
  onProgress,
  signal,
  stopOnAuthError = true,
}) {
  const queue = asArray(postings).filter(isRunnablePosting).slice(0, MAX_POSTINGS);
  if (queue.length === 0) throw new Error('runMatchBatch: no postings with any text.');
  if (!isPlainObject(resume)) throw new Error('runMatchBatch: no resume to match against.');

  const results = [];
  let aborted = false;

  for (let index = 0; index < queue.length; index += 1) {
    const posting = queue[index];

    if (signal?.aborted) {
      aborted = true;
      break;
    }

    onProgress?.({ phase: 'start', id: posting.id, index, total: queue.length });

    try {
      const parsed = await parseJobDescriptionWithAI(posting.text, { provider, apiKey, model });
      const parsedJD = asObject(parsed.data);
      // Pure and free, both of them. Only the parse above costs anything.
      const gap = analyzeCompetencyGaps(resume, parsedJD);
      const score = calculateATSScore(resume, parsedJD, gap);
      const row = buildMatchResult({ posting, parsedJD, gap, score, index });
      results.push(row);
      onProgress?.({ phase: 'done', id: posting.id, index, total: queue.length, result: row });
    } catch (err) {
      const row = buildFailedResult({
        posting,
        // `describeError` lives in utils and is React-free, but importing it
        // here would make this service depend on user-facing copy. The page
        // describes the error; this records what was thrown.
        error: { message: err?.message ?? 'This posting could not be read.', code: err?.code ?? null },
        index,
      });
      results.push(row);
      onProgress?.({ phase: 'failed', id: posting.id, index, total: queue.length, result: row, error: err });

      // An auth failure will fail identically for every remaining posting, so
      // continuing would burn the rest of the batch on the same rejection and
      // report it as though each posting were individually broken. Every other
      // error is posting-specific and the loop carries on.
      if (stopOnAuthError && err?.code === 'auth') {
        aborted = true;
        onProgress?.({ phase: 'aborted', reason: 'auth', index, total: queue.length });
        break;
      }
    }
  }

  return {
    results: rankMatchResults(results),
    resumeFingerprint: fingerprint(resume),
    ranAt: new Date().toISOString(),
    provider: asString(provider),
    completed: results.filter((r) => r.error === null).length,
    failed: results.filter((r) => r.error !== null).length,
    aborted,
  };
}
