/**
 * Pipeline-level manual test: does the score follow the resume across stages?
 * Not imported by the app and not in the build.
 *
 * WHY THIS FILE EXISTS
 * The ATS score was computed once, in the Input pipeline, against the original
 * parse, and never again. Tailor, the hand editor and skill approvals all
 * changed the resume, and Analyze kept showing the pre-tailoring number. Every
 * per-stage test passed, because every stage was correct in isolation. The
 * wiring between stages was the bug. So the tests here drive the store through
 * the same dispatch sequence the pages use, end to end, and check the score at
 * every step against a fresh computation of what it should be.
 *
 *   const p = await import('/src/services/__manual__/pipeline.manual.js');
 *
 *   await p.testScenario();   // ASSERTIONS, no key, no network. Also runs under Node via Vite's SSR loader.
 *   p.measureSizes();         // session size with and without a diverged baseline
 *
 * The same scenario against the REAL app, with real AI calls and your own key.
 * It edits the summary of whatever session is loaded, so use test data:
 *
 *   1. On /input, run an analysis. On /analyze:
 *        p.liveAfterInput();
 *   2. On /tailor, run "Tailor my resume". Then open /analyze:
 *        (await import('/src/services/__manual__/pipeline.manual.js')).liveAfterTailor();
 *   3. Back on /tailor (no re-run):
 *        await (await import('/src/services/__manual__/pipeline.manual.js')).liveManualEdit();
 *   4. Optional: reload, then liveVerifyReload(); and liveUndoEdit() on /tailor to put the summary back.
 *
 * Live checks read the store through window.a2resumeDev (dev builds only).
 * They print scores and keyword names, never resume text.
 */

import { analyzeCompetencyGaps, collectResumeSkills, collectResumeText, countOccurrences } from '../gapAnalyzer.js';
import { calculateATSScore } from '../atsScorer.js';
import { compareScores, describeScoreChange, recoverBaseline, rescoreCurrentResume, selectCurrentResume } from '../currentResume.js';
import { mergeNonDestructiveResume } from '../resumeTailor.js';
import { newEntryDraft, toDraft } from '../tailoredEdits.js';
import { SESSION_STORAGE_NAME, SESSION_VERSION, loadSession, measureSession, saveSession } from '../sessionPersistence.js';

const RAW_KEY = `a2resume:${SESSION_STORAGE_NAME}`;
const LIVE_KEY = '__a2resume_pipeline_live';

let failed = 0;
const check = (label, pass, detail) => {
  if (pass) console.log('  PASS', label);
  else {
    failed += 1;
    console.error('  FAIL', label, detail ?? '');
  }
  return pass;
};

const json = (value) => JSON.stringify(value ?? null);
const isObj = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const bucketOf = (gap, keyword) =>
  ['matched', 'partial', 'missing'].find((b) => (gap?.[b] ?? []).some((k) => k.keyword.toLowerCase() === keyword.toLowerCase())) ?? null;

/** What the score for this state SHOULD be: the current resume, scored from scratch. */
function expectedScore(state) {
  const { raw } = selectCurrentResume(state);
  if (!raw || !isObj(state.parsedJD)) return null;
  return calculateATSScore(raw, state.parsedJD, analyzeCompetencyGaps(raw, state.parsedJD));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function parsedResume() {
  return {
    name: 'Priya Ramanathan',
    contact: { email: 'priya.r@example.com', phone: '+64 21 555 0134', location: 'Wellington, NZ', customLinks: [{ label: 'GitHub', url: 'https://github.com/priyar' }] },
    summary: 'Backend engineer with 6 years building payment infrastructure.',
    skills: [
      { category: 'Languages', skills: ['Go', 'Python'] },
      { category: 'Infrastructure', skills: ['PostgreSQL', 'Kafka', 'AWS'] },
    ],
    experience: [
      {
        company: 'Kiwibank', title: 'Senior Software Engineer', location: 'Wellington, NZ', startDate: 'March 2022', endDate: '', isCurrentlyWorking: true,
        bullets: [
          'Led migration of the settlement pipeline to an event-driven service, cutting reconciliation lag from 14 hours to under 5 minutes.',
          'Introduced structured logging and distributed tracing across 11 services.',
        ],
        links: [],
      },
      {
        company: 'Xero', title: 'Software Engineer', location: 'Wellington, NZ', startDate: 'Jan 2019', endDate: 'Feb 2022', isCurrentlyWorking: false,
        bullets: ['Built the invoice reminder scheduler in Go, handling 2.3M notifications per day on PostgreSQL.'],
        links: [],
      },
    ],
    projects: [{ name: 'ledgerlint', description: 'A static analyser for double-entry bookkeeping code.', bullets: ['Flags unbalanced transactions.'], links: [{ label: 'Repo', url: 'https://github.com/priyar/ledgerlint' }] }],
    education: [{ institution: 'Victoria University of Wellington', degree: 'BSc', field: 'Computer Science', location: 'Wellington, NZ', startDate: '2015', endDate: '2018', details: [] }],
    certifications: [{ name: 'AWS Certified Solutions Architect', issuer: 'Amazon Web Services', date: '2023', url: '' }],
  };
}

/** Missing from the original: event-driven architecture, observability, Terraform, Kubernetes, gRPC. */
function parsedJD(title = 'Senior Backend Engineer') {
  return {
    jobTitle: title,
    atsKeywords: {
      high: ['Go', 'Kubernetes', 'gRPC', 'PostgreSQL'],
      medium: ['event-driven architecture', 'distributed tracing', 'Terraform'],
      low: ['Kafka', 'observability'],
    },
    requiredSkills: [],
    preferredSkills: [],
  };
}

/** A second posting, for the "new run after tailoring" staleness case. */
function otherJD() {
  return { jobTitle: 'Data Engineer', atsKeywords: { high: ['Python', 'Airflow', 'dbt'], medium: ['Snowflake'], low: [] }, requiredSkills: [], preferredSkills: [] };
}

/** The model's tailored output: rewordings that surface two missing keywords. */
function modelOutput() {
  const r = parsedResume();
  r.experience[0].bullets = [
    'Led migration of the settlement pipeline to an event-driven architecture, cutting reconciliation lag from 14 hours to under 5 minutes.',
    'Improved observability with structured logging and distributed tracing across 11 services.',
  ];
  return r;
}

const CHANGES = [
  { section: 'experience', target: 'Kiwibank', before: 'event-driven service', after: 'event-driven architecture', reason: 'Posting wording.' },
  { section: 'experience', target: 'Kiwibank', before: 'Introduced structured logging', after: 'Improved observability with structured logging', reason: 'Posting wording.' },
];

// ---------------------------------------------------------------------------
// The scenario, through the real reducer
// ---------------------------------------------------------------------------

/** @returns {Promise<boolean>} */
export async function testScenario() {
  failed = 0;
  const { appReducer, initialState, ACTIONS, RESCORING_ACTIONS, hydrate } = await import('../../context/AppContext.jsx');
  const run = (state, type, payload) => appReducer(state, { type: ACTIONS[type], payload });
  const consistent = (state) => json(state.atsScore) === json(expectedScore(state)) && (state.atsScore == null || state.atsScore.gapAnalysis === state.gapAnalysis);

  /** InputPage.handleRun's dispatch order, with analysisPipeline's onResult order inside it. */
  const inputRun = (state, resume, jd, { stopAfter } = {}) => {
    let s = state;
    s = run(s, 'SET_RESUME_TEXT', 'resume text');
    s = run(s, 'SET_JOB_DESCRIPTION', 'job description text');
    s = run(s, 'SET_SOURCES', { resume: 'paste', jobDescription: 'paste', provider: 'gemini' });
    s = run(s, 'SET_SETTINGS', { provider: 'gemini' });
    s = run(s, 'CLEAR_ANALYSIS');
    s = run(s, 'SET_STATUS', 'running');
    s = run(s, 'SET_RESUME', resume);
    if (stopAfter === 'resume') return s;
    s = run(s, 'SET_PARSED_JD', jd);
    // The save effect writes after every dispatch, so a real save lands here:
    // resume and JD parsed, neither score computed yet.
    if (stopAfter === 'parsedJD') return s;
    const gap = analyzeCompetencyGaps(resume, jd);
    s = run(s, 'SET_GAP_ANALYSIS', gap);
    s = run(s, 'SET_ATS_SCORE', calculateATSScore(resume, jd, gap));
    s = run(s, 'SET_STAGE', null);
    return run(s, 'SET_STATUS', 'done');
  };

  console.group('pipeline - score follows the resume (reducer scenario)');
  const backup = typeof localStorage !== 'undefined' ? localStorage.getItem(RAW_KEY) : null;
  try {
    // --- 1. Input ---------------------------------------------------------
    console.log('1. Input run');
    const input = inputRun(initialState, parsedResume(), parsedJD());
    const baselineJson = json(input.originalAtsScore);
    check('baseline set by the Input run', isObj(input.originalAtsScore) && isObj(input.originalGapAnalysis));
    check('before tailoring, baseline and current are the same objects', input.originalAtsScore === input.atsScore && input.originalGapAnalysis === input.gapAnalysis);
    check('current score matches the original resume', consistent(input));
    check('Analyze shows no comparison: the current resume is the original', selectCurrentResume(input).source === 'original');
    // The first two start as partial via skillSynonyms ("event-driven service",
    // "distributed tracing"); asserted as "not matched" so a growing synonym
    // map cannot break the fixture.
    for (const k of ['event-driven architecture', 'observability']) {
      check(`fixture: "${k}" starts not matched`, bucketOf(input.gapAnalysis, k) !== 'matched', bucketOf(input.gapAnalysis, k));
    }
    for (const k of ['Terraform', 'Kubernetes', 'gRPC']) {
      check(`fixture: "${k}" starts missing`, bucketOf(input.gapAnalysis, k) === 'missing');
    }

    // --- 2. Tailor --------------------------------------------------------
    console.log('2. Tailor pass lands');
    const merged = mergeNonDestructiveResume(input.resume, modelOutput());
    const pass = { resume: merged.resume, changesLog: CHANGES, corrections: merged.corrections };
    const tailored = run(input, 'SET_TAILORED_RESUME', { ...pass, parsedJD: input.parsedJD });
    check('tailored resume stored', isObj(tailored.tailoredResume));
    check('THE BUG: score is no longer the Input-time score', tailored.atsScore !== input.atsScore && json(tailored.atsScore) !== baselineJson);
    check('score equals a fresh score of the TAILORED resume', consistent(tailored), { got: tailored.atsScore?.total, expected: expectedScore(tailored)?.total });
    check('score went up', tailored.atsScore.total > input.originalAtsScore.total, { before: input.originalAtsScore.total, after: tailored.atsScore.total });
    check('baseline untouched: same objects, same content', tailored.originalAtsScore === input.originalAtsScore && tailored.originalGapAnalysis === input.originalGapAnalysis && json(tailored.originalAtsScore) === baselineJson);
    const cmp = compareScores(tailored.originalAtsScore, tailored.atsScore, tailored.originalGapAnalysis, tailored.gapAnalysis);
    const gained = cmp.keywords.improved.filter((m) => m.to === 'matched').map((m) => m.keyword);
    check('comparison names the keywords the rewrite surfaced', gained.includes('event-driven architecture') && gained.includes('observability'), cmp.keywords.improved);
    console.log(`     ${cmp.before.total} -> ${cmp.after.total}, ${describeScoreChange(cmp)}`);
    const tailoredSkills = collectResumeSkills(tailored.tailoredResume).map((s) => s.toLowerCase());
    check('no skill listed on the tailored resume is reported missing', !tailored.gapAnalysis.missing.some((k) => tailoredSkills.includes(k.keyword.toLowerCase())));
    const text = collectResumeText(tailored.tailoredResume).full;
    check('every matched keyword really occurs in the tailored resume', tailored.gapAnalysis.matched.every((k) => countOccurrences(text, k.keyword) > 0));

    // --- 3. Hand edits, no re-run ------------------------------------------
    console.log('3. Hand edits on Tailor');
    const skillsDraft = toDraft('skills', tailored.tailoredResume.skills).map((g) =>
      g.category === 'Infrastructure' ? { ...g, skills: [...g.skills, 'Terraform'] } : g
    );
    const edited = run(tailored, 'UPDATE_TAILORED_SECTION', { section: 'skills', value: skillsDraft });
    check('skills edit: score recomputed', edited.atsScore !== tailored.atsScore && consistent(edited));
    check('skills edit: Terraform moved missing -> matched', bucketOf(tailored.gapAnalysis, 'Terraform') === 'missing' && bucketOf(edited.gapAnalysis, 'Terraform') === 'matched');
    check('skills edit: Tailor was not re-run (same changesLog)', edited.changesLog === tailored.changesLog);
    check('skills edit: baseline untouched', edited.originalAtsScore === input.originalAtsScore);

    const summary = `${edited.tailoredResume.summary} Designs gRPC services.`;
    const edited2 = run(edited, 'UPDATE_TAILORED_SECTION', { section: 'summary', value: summary });
    check('summary (prose) edit: score recomputed, gRPC matched', consistent(edited2) && bucketOf(edited2.gapAnalysis, 'gRPC') === 'matched');
    check('score rose again after the edits', edited2.atsScore.total > tailored.atsScore.total, { tailored: tailored.atsScore.total, edited: edited2.atsScore.total });
    check('a no-op save changes nothing, same state object', run(edited2, 'UPDATE_TAILORED_SECTION', { section: 'summary', value: summary }) === edited2);

    const project = toDraft('projects', edited2.tailoredResume.projects[0]);
    const relinked = run(edited2, 'UPDATE_TAILORED_SECTION', {
      section: 'projects', index: 0, value: { ...project, links: [{ label: 'Repo', url: 'https://gitlab.com/priyar/ledgerlint' }] },
    });
    check(
      'an edit that cannot move the score keeps the very same score objects',
      relinked.tailoredResume !== edited2.tailoredResume && relinked.atsScore === edited2.atsScore && relinked.gapAnalysis === edited2.gapAnalysis,
      { changedJson: json(expectedScore(relinked)) !== json(edited2.atsScore) }
    );
    check('rescoring an already-current state returns it unchanged', rescoreCurrentResume(edited2) === edited2);

    // --- 4. Skill approvals --------------------------------------------------
    console.log('4. Skill approvals');
    const approvedAfter = run(edited2, 'MERGE_INFERRED_SKILLS', ['Kubernetes']);
    check('approval with a tailoring pass: rescored against the tailored copy', consistent(approvedAfter) && bucketOf(approvedAfter.gapAnalysis, 'Kubernetes') === 'matched');
    check('approval: baseline untouched, edit log kept', approvedAfter.originalAtsScore === input.originalAtsScore && approvedAfter.tailorManualEdits === edited2.tailorManualEdits);
    const approvedBefore = run(input, 'MERGE_INFERRED_SKILLS', ['Kubernetes']);
    check('approval before tailoring: score recomputed with no button', consistent(approvedBefore) && approvedBefore.atsScore.total > input.atsScore.total);
    check('approval before tailoring: baseline untouched, still no comparison', approvedBefore.originalAtsScore === input.originalAtsScore && selectCurrentResume(approvedBefore).source === 'original');

    // --- 5. Discard -------------------------------------------------------
    console.log('5. Discarding the pass');
    const discarded = run(edited2, 'CLEAR_TAILORING');
    check('discard: score falls back to the original resume, as the very baseline objects', discarded.atsScore === input.originalAtsScore && discarded.gapAnalysis === input.originalGapAnalysis);
    const discardedAfterApproval = run(approvedAfter, 'CLEAR_TAILORING');
    check('discard after an approval: scored against the original plus the approved skill', consistent(discardedAfterApproval) && json(discardedAfterApproval.atsScore) !== baselineJson);

    // --- 6. Persistence and reload ------------------------------------------
    if (typeof localStorage !== 'undefined') {
      console.log('6. Persistence and reload');
      const reload = (state) => {
        saveSession(state);
        return hydrate(initialState, loadSession);
      };
      let env;
      const r1 = reload(edited2);
      env = JSON.parse(localStorage.getItem(RAW_KEY));
      check('diverged: both pairs written', env.originalScoreSharesCurrent === false && isObj(env.state.originalAtsScore));
      check('diverged reload: current and baseline both restored exactly', json(r1.atsScore) === json(edited2.atsScore) && json(r1.originalAtsScore) === baselineJson && consistent(r1));

      const r2 = reload(input);
      env = JSON.parse(localStorage.getItem(RAW_KEY));
      check('untailored: baseline stored once', env.originalScoreSharesCurrent === true && !('originalAtsScore' in env.state));
      check('untailored reload: baseline and current are one object again', r2.originalAtsScore === r2.atsScore && json(r2.atsScore) === baselineJson);

      // A session saved by the build with the bug: tailored resume, Input-time score, no baseline fields.
      const legacy = { ...edited2, gapAnalysis: input.gapAnalysis, atsScore: input.atsScore };
      delete legacy.originalGapAnalysis;
      delete legacy.originalAtsScore;
      delete legacy.ui;
      localStorage.setItem(RAW_KEY, JSON.stringify({ version: SESSION_VERSION, state: legacy }));
      const r3 = hydrate(initialState, loadSession);
      check('pre-fix session: its stale score becomes the baseline', json(r3.originalAtsScore) === baselineJson);
      check('pre-fix session: the tailored resume is rescored on load', json(r3.atsScore) === json(edited2.atsScore) && consistent(r3));

      // --- 6b. The baseline hole -------------------------------------------
      // A save taken between SET_PARSED_JD and SET_GAP_ANALYSIS has no score,
      // so toStoredSlice writes both baseline keys as null. loadSession then
      // sees those keys PRESENT and skips its shares-current fallback, and the
      // rescore on load computes a score into a state with no baseline. The
      // session showed no before/after card ever again. Found in a real stored
      // session (2026-09-16), not synthesised: dev reloads on every save to
      // AppContext.jsx, which is enough to take that mid-run snapshot.
      console.log('6b. A lost baseline is recovered on load');
      const midSave = inputRun(initialState, parsedResume(), parsedJD(), { stopAfter: 'parsedJD' });
      check('mid-run state: a resume and a JD, but no score yet', isObj(midSave.resume) && isObj(midSave.parsedJD) && midSave.atsScore === null && midSave.originalAtsScore === null);
      saveSession(midSave);
      env = JSON.parse(localStorage.getItem(RAW_KEY));
      check(
        'mid-run save writes the null-baseline envelope that caused the hole',
        env.originalScoreSharesCurrent === false && env.state.originalAtsScore === null && env.state.atsScore === null,
        env.originalScoreSharesCurrent
      );
      const r4 = hydrate(initialState, loadSession);
      check('mid-run reload: the rescore still computes a current score', isObj(r4.atsScore) && consistent(r4));
      check('THE HOLE: that score now arrives with a baseline', isObj(r4.originalAtsScore) && isObj(r4.originalGapAnalysis), { baseline: r4.originalAtsScore });
      check('mid-run reload: untailored, so baseline and current are one object', r4.originalAtsScore === r4.atsScore && r4.originalGapAnalysis === r4.gapAnalysis);
      check('mid-run baseline equals a full Input run of the same pair', json(r4.originalAtsScore) === baselineJson);
      saveSession(r4);
      env = JSON.parse(localStorage.getItem(RAW_KEY));
      check('the session heals in place: its next save is a normal shared-baseline envelope', env.originalScoreSharesCurrent === true && !('originalAtsScore' in env.state));
      check('and it stays healed across a second reload', isObj(hydrate(initialState, loadSession).originalAtsScore));

      // The shape the real stored session was found in: a tailoring pass and a
      // genuine current score, with both baseline keys explicitly null. Here
      // adopting the current score as the baseline would report "no change"
      // and claim the rewrite achieved nothing, so it must be recomputed.
      const lost = { ...edited2, originalGapAnalysis: null, originalAtsScore: null };
      saveSession(lost);
      env = JSON.parse(localStorage.getItem(RAW_KEY));
      check('tailored session with a lost baseline: stored with null baseline keys', env.originalScoreSharesCurrent === false && env.state.originalAtsScore === null && isObj(env.state.atsScore));
      const r5 = hydrate(initialState, loadSession);
      check('tailored + lost baseline: recovered on load', isObj(r5.originalAtsScore) && isObj(r5.originalGapAnalysis));
      check('recovered baseline is the ORIGINAL resume, not a copy of the tailored score', r5.originalAtsScore.total !== r5.atsScore.total, { baseline: r5.originalAtsScore.total, current: r5.atsScore.total });
      check('recovered baseline reproduces exactly what the Input run computed', json(r5.originalAtsScore) === baselineJson);
      check('current score still describes the tailored resume', consistent(r5));
      const recovered = compareScores(r5.originalAtsScore, r5.atsScore, r5.originalGapAnalysis, r5.gapAnalysis);
      check('the before/after comparison is back, and says the rewrite helped', recovered?.direction === 'up', recovered && describeScoreChange(recovered));
      check('and it names the keywords the rewrite surfaced', recovered.keywords.improved.some((m) => m.to === 'matched'));

      // What recovery must NOT do.
      check('a state that already has a baseline is returned untouched', recoverBaseline(edited2) === edited2);
      check('no score yet: no baseline invented (the Input run will seed it)', recoverBaseline(midSave) === midSave);
      check('no parsed JD: no baseline invented, no throw', recoverBaseline({ ...lost, parsedJD: null }).originalAtsScore == null);
      check('no resume: no baseline invented, no throw', recoverBaseline({ ...lost, resume: null }).originalAtsScore == null);
      check('a half-written baseline is rebuilt as a matched pair', isObj(recoverBaseline({ ...edited2, originalAtsScore: null }).originalAtsScore));
    }

    // --- 7. Staleness -----------------------------------------------------
    console.log('7. Stale job description / stale passes');
    const rerun = inputRun(edited2, parsedResume(), otherJD());
    check('new Input run: tailoring and hand edits cleared', rerun.tailoredResume === null && rerun.tailorManualEdits === null);
    check('new Input run: baseline is the new run\'s, not the old one', json(rerun.originalAtsScore) !== baselineJson && rerun.originalAtsScore === rerun.atsScore && consistent(rerun));
    check('stale pass landing after the new run: refused', run(rerun, 'SET_TAILORED_RESUME', { ...pass, parsedJD: input.parsedJD }) === rerun);
    const midRun = inputRun(edited2, parsedResume(), otherJD(), { stopAfter: 'resume' });
    check('stale pass landing mid-run (resume parsed, JD not yet): refused', run(midRun, 'SET_TAILORED_RESUME', { ...pass, parsedJD: input.parsedJD }) === midRun);
    check('a pass with no JD stamp: refused', run(input, 'SET_TAILORED_RESUME', pass) === input);
    const approvedMidRun = run(midRun, 'MERGE_INFERRED_SKILLS', ['Kubernetes']);
    check('approval while the JD is missing: no score invented, no throw', approvedMidRun.atsScore === null && approvedMidRun.gapAnalysis === null);
    const inFlight = run(run(input, 'MERGE_INFERRED_SKILLS', ['Kubernetes']), 'SET_TAILORED_RESUME', { ...pass, parsedJD: input.parsedJD });
    check('approval while a pass is in flight: the pass still lands (same JD) and is scored', isObj(inFlight.tailoredResume) && consistent(inFlight));
    const lateScore = run(edited2, 'SET_ATS_SCORE', { total: 1 });
    check('a stray SET_ATS_SCORE cannot overwrite the baseline', lateScore.originalAtsScore === input.originalAtsScore);
    const jdTyped = run(edited2, 'SET_JOB_DESCRIPTION', 'a different posting, typed but not run');
    check('JD text alone changes no parsed JD, tailoring or score', jdTyped.parsedJD === edited2.parsedJD && jdTyped.tailoredResume === edited2.tailoredResume && jdTyped.atsScore === edited2.atsScore);

    // A pending draft is typing, not a resume. Nothing about it may reach the
    // score; only the Save that commits it does. The loop below asserts the
    // invariant for every action, but this is the case the feature turns on.
    const drafted = run(edited2, 'SET_DRAFT_EDIT', { section: 'summary', value: `${edited2.tailoredResume.summary} Terraform, Kubernetes, gRPC.` });
    check('a pending draft is stored', Array.isArray(drafted.draftEdits) && drafted.draftEdits.length === 1);
    check('a pending draft does NOT rescore: same score objects', drafted.atsScore === edited2.atsScore && drafted.gapAnalysis === edited2.gapAnalysis);
    check('a pending draft does NOT touch the resume Export prints', drafted.tailoredResume === edited2.tailoredResume);
    check('a pending draft is not a hand edit', drafted.tailorManualEdits === edited2.tailorManualEdits);
    const committed = run(drafted, 'UPDATE_TAILORED_SECTION', { section: 'summary', value: drafted.draftEdits[0].value });
    check('committing that same draft DOES rescore', committed.atsScore !== drafted.atsScore && consistent(committed));
    check('committing clears the draft it came from', committed.draftEdits === null);
    check('discarding a draft rescores nothing and leaves the resume alone', (() => {
      const d = run(drafted, 'DISCARD_DRAFT_EDIT', { section: 'summary' });
      return d.draftEdits === null && d.atsScore === edited2.atsScore && d.tailoredResume === edited2.tailoredResume;
    })());

    // --- 8. Every action keeps score and resume in step ------------------------
    console.log('8. Invariant across every action');
    check('RESCORING_ACTIONS all name real actions', RESCORING_ACTIONS.every((name) => name in ACTIONS));
    const PIPELINE_STEPS = ['SET_RESUME', 'SET_PARSED_JD', 'SET_GAP_ANALYSIS', 'SET_ATS_SCORE']; // mid-run; the run's own SET_ATS_SCORE closes the gap
    const payloads = {
      RESET: undefined,
      SET_RESUME_TEXT: 'x',
      SET_JOB_DESCRIPTION: 'x',
      SET_TAILORED_RESUME: { ...pass, parsedJD: edited2.parsedJD },
      CLEAR_TAILORING: undefined,
      UPDATE_TAILORED_SECTION: { section: 'summary', value: 'Staff engineer. Kubernetes.' },
      // Adding and removing a whole entry changes which keywords the resume
      // contains, so both must rescore exactly like a hand edit.
      ADD_TAILORED_ENTRY: { section: 'experience', value: { ...newEntryDraft('experience'), title: 'Platform Engineer', company: 'Nimbus Data', startDate: 'Feb 2024', bullets: ['Ran the Terraform migration for 12 AWS accounts.'] } },
      REMOVE_TAILORED_ENTRY: { section: 'experience', index: 0 },
      SET_SOURCES: { provider: 'claude' },
      SET_SETTINGS: { provider: 'claude' },
      SET_STATUS: 'idle',
      SET_STAGE: null,
      SET_ERROR: null,
      MERGE_INFERRED_SKILLS: ['Airflow'],
      SET_DRAFT_EDIT: { section: 'summary', value: 'Typed but not saved. Kubernetes, gRPC, Terraform.' },
      DISCARD_DRAFT_EDIT: { section: 'summary' },
      // Neither the cover letter nor the Match batch is part of the current
      // resume, so none of these may move the score -- which is exactly what
      // this sweep asserts for every action.
      SET_COVER_LETTER: { body: ['Dear X,', 'Hello.', 'Bye,'].join('\n\n'), tone: 'warm', length: 'short' },
      UPDATE_COVER_LETTER: { body: ['Dear X,', 'Edited.', 'Bye,'].join('\n\n'), tone: 'warm', length: 'short' },
      CLEAR_COVER_LETTER: undefined,
      SET_MATCH_POSTINGS: [{ id: 'p1', label: '', text: 'A posting.', url: '', source: 'paste', status: 'pending', error: null }],
      SET_MATCH_RESULTS: { results: [{ id: 'p1', label: 'A posting', jd: null, score: null, gap: null, error: { message: 'x' } }], resumeFingerprint: 'x', ranAt: '2026-09-23T00:00:00.000Z', provider: 'claude', completed: 0, failed: 1, aborted: false },
      REMOVE_MATCH_RESULT: { id: 'p1' },
      CLEAR_MATCH_RESULTS: undefined,
      CLEAR_MATCH: undefined,
      CLEAR_ANALYSIS: undefined,
    };
    for (const name of Object.keys(ACTIONS)) {
      if (PIPELINE_STEPS.includes(name)) continue;
      if (!(name in payloads)) {
        check(`${name}: has an invariant case (add one to payloads when adding an action)`, false);
        continue;
      }
      const after = run(edited2, name, payloads[name]);
      check(`${name}: score still matches the current resume`, consistent(after), { total: after.atsScore?.total, expected: expectedScore(after)?.total });
    }
  } finally {
    if (typeof localStorage !== 'undefined') {
      if (backup === null) localStorage.removeItem(RAW_KEY);
      else localStorage.setItem(RAW_KEY, backup);
    }
    console.log(failed ? `${failed} FAILED` : 'all passed');
    console.groupEnd();
  }
  return failed === 0;
}

// ---------------------------------------------------------------------------
// Session size
// ---------------------------------------------------------------------------

const VOCAB = [
  'Go', 'Python', 'PostgreSQL', 'Kafka', 'Kubernetes', 'Terraform', 'AWS', 'gRPC', 'Redis', 'Docker', 'GraphQL', 'TypeScript', 'React', 'CI/CD', 'Linux',
  'observability', 'distributed tracing', 'event-driven architecture', 'microservices', 'REST APIs', 'SQL', 'Airflow', 'dbt', 'Snowflake', 'Spark',
  'Prometheus', 'Grafana', 'OpenTelemetry', 'Helm', 'Argo CD', 'GCP', 'Azure', 'Java', 'Kotlin', 'Rust', 'Node.js', 'Elasticsearch', 'RabbitMQ',
  'DynamoDB', 'MongoDB', 'Jenkins', 'GitHub Actions', 'Ansible', 'Vault', 'Istio', 'Envoy', 'NATS', 'ClickHouse', 'BigQuery', 'Looker', 'Tableau',
  'pandas', 'NumPy', 'PyTorch', 'TensorFlow', 'scikit-learn', 'MLflow', 'Kubeflow', 'Ray', 'Dask', 'Flink', 'Beam', 'Pulsar', 'Cassandra', 'ScyllaDB',
  'CockroachDB', 'TiDB', 'Vitess', 'Nginx', 'HAProxy', 'Consul', 'Nomad', 'Packer', 'Pulumi', 'CloudFormation', 'Lambda', 'ECS', 'EKS', 'GKE', 'AKS',
  'Cloud Run', 'Firestore', 'Spanner', 'Pub/Sub', 'SQS', 'SNS', 'Kinesis', 'Glue', 'Athena', 'Redshift',
];

/** A synthetic session of the shape the earlier persistence measurements used, scored by the real services. */
function syntheticSession({ roles, bullets, keywords, jdChars, changes }) {
  const services = ['billing', 'search', 'ledger', 'notifications', 'reporting', 'identity', 'payments', 'pricing'];
  const resume = parsedResume();
  resume.experience = Array.from({ length: roles }, (_, i) => ({
    company: `Company ${i + 1}`, title: 'Senior Software Engineer', location: 'Wellington, NZ',
    startDate: `Jan ${2008 + i * 2}`, endDate: i === 0 ? '' : `Dec ${2009 + i * 2}`, isCurrentlyWorking: i === 0,
    bullets: Array.from({ length: bullets }, (__, j) =>
      `Rebuilt the ${services[j % services.length]} service in ${VOCAB[(i + j) % 8]}, cutting p95 latency by ${10 + i + j}% across ${j + 2}M monthly requests.`),
    links: [],
  }));
  const terms = VOCAB.slice(0, keywords);
  const jd = { jobTitle: 'Senior Backend Engineer', atsKeywords: { high: terms.filter((_, i) => i % 3 === 0), medium: terms.filter((_, i) => i % 3 === 1), low: terms.filter((_, i) => i % 3 === 2) }, requiredSkills: [], preferredSkills: [] };

  const tailoredResume = structuredClone(resume);
  tailoredResume.experience.forEach((e, i) => { e.bullets[0] = `${e.bullets[0]} Worked with ${VOCAB[(8 + i) % keywords]} and ${VOCAB[(9 + i) % keywords]}.`; });
  tailoredResume.summary = `${resume.summary} ${VOCAB.slice(8, 14).join(', ')}.`;

  const filler = (n) => 'Rebuilt the billing service in Go, cutting latency across monthly requests. '.repeat(Math.ceil(n / 78)).slice(0, n);
  const gap = analyzeCompetencyGaps(resume, jd);
  const score = calculateATSScore(resume, jd, gap);
  const tGap = analyzeCompetencyGaps(tailoredResume, jd);
  const tScore = calculateATSScore(tailoredResume, jd, tGap);
  const base = {
    resumeText: filler(7000), resume, jobDescription: filler(jdChars), parsedJD: jd,
    changesLog: Array.from({ length: changes }, (_, i) => ({ section: 'experience', target: `Company ${(i % roles) + 1}`, before: resume.experience[i % roles].bullets[0], after: tailoredResume.experience[i % roles].bullets[0], reason: 'Uses the wording the posting uses.' })),
    tailorCorrections: [], tailorManualEdits: null,
    sources: { resume: 'paste', jobDescription: 'paste', resumeFileName: null, jobDescriptionUrl: null, provider: 'gemini' }, settings: { provider: 'gemini' },
  };
  return {
    // Before this change a tailored session stored exactly one pair (the stale Input-time one).
    // Measured here as a tailored session whose baseline is shared with current: one pair plus the flags.
    onePair: { ...base, tailoredResume, gapAnalysis: tGap, atsScore: tScore, originalGapAnalysis: tGap, originalAtsScore: tScore },
    // After: tailored, the baseline diverged from current, so both pairs are stored.
    twoPairs: { ...base, tailoredResume, gapAnalysis: tGap, atsScore: tScore, originalGapAnalysis: gap, originalAtsScore: score },
  };
}

export function measureSizes() {
  const rows = [];
  for (const [label, shape] of [
    ['realistic', { roles: 5, bullets: 6, keywords: 30, jdChars: 6000, changes: 30 }],
    ['heavy', { roles: 10, bullets: 8, keywords: 90, jdChars: 60000, changes: 80 }],
  ]) {
    const { onePair, twoPairs } = syntheticSession(shape);
    const one = measureSession(onePair);
    const two = measureSession(twoPairs);
    rows.push({
      session: label,
      onePairChars: one.total,
      twoPairsChars: two.total,
      addedChars: two.total - one.total,
      addedPct: +(((two.total - one.total) / one.total) * 100).toFixed(1),
      baselineGap: two.perField.originalGapAnalysis,
      baselineScore: two.perField.originalAtsScore,
      quotaPct: +(two.fractionOfTypicalQuota * 100).toFixed(2),
    });
  }
  console.table(rows);
  return rows;
}

// ---------------------------------------------------------------------------
// Live, against the real app
// ---------------------------------------------------------------------------

function liveState() {
  const handle = window.a2resumeDev;
  if (!handle || typeof handle.getState !== 'function') throw new Error('window.a2resumeDev is missing. Run this against the dev server.');
  return handle.getState();
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function setValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const saved = () => JSON.parse(sessionStorage.getItem(LIVE_KEY) || '{}');
const remember = (patch) => sessionStorage.setItem(LIVE_KEY, JSON.stringify({ ...saved(), ...patch }));
/** The main ScoreCard's total as rendered, not the comparison card's. */
const renderedTotal = () => document.querySelector('.card:not(.compare) .score__total')?.firstChild?.textContent.trim() ?? null;

function finish(label) {
  console.log(failed ? `${failed} FAILED` : 'all passed');
  console.groupEnd();
  if (label) console.log(label);
  return failed === 0;
}

/** Step 1: after a real Input run, on /analyze. */
export function liveAfterInput() {
  failed = 0;
  console.group('pipeline - live 1: after the Input run');
  const s = liveState();
  check('store: a completed run (resume, parsed JD, score)', isObj(s.resume) && isObj(s.parsedJD) && isObj(s.atsScore));
  check('store: no tailoring pass yet (discard it on step 3 first if there is one)', !s.tailoredResume);
  check('store: baseline set, the same objects as the current score', s.originalAtsScore === s.atsScore && s.originalGapAnalysis === s.gapAnalysis);
  check('store: score matches a fresh score of the resume', json(s.atsScore) === json(expectedScore(s)));
  if (location.pathname === '/analyze') {
    check('page: ScoreCard shows the current total', renderedTotal() === String(s.atsScore?.total), renderedTotal());
    check('page: no before/after card without a tailoring pass', !document.querySelector('.compare'));
  } else console.warn('Not on /analyze: page checks skipped.');
  remember({ baseline: json(s.originalAtsScore), baselineTotal: s.atsScore?.total });
  console.log(`baseline ${s.atsScore?.total} / ${s.atsScore?.scoreableMax}, missing: ${(s.gapAnalysis?.missing ?? []).map((k) => k.keyword).join(', ')}`);
  return finish('Next: run "Tailor my resume" on /tailor, open /analyze, then liveAfterTailor().');
}

/** Step 2: after a real Tailor pass, on /analyze. */
export function liveAfterTailor() {
  failed = 0;
  console.group('pipeline - live 2: after Tailor');
  const s = liveState();
  const was = saved();
  check('store: tailoring pass present', isObj(s.tailoredResume));
  check('store: baseline unchanged since step 1', was.baseline ? json(s.originalAtsScore) === was.baseline : false, 'run liveAfterInput() first');
  check('store: score matches a fresh score of the TAILORED resume', json(s.atsScore) === json(expectedScore(s)));
  check('store: score is not the Input-time score', json(s.atsScore) !== was.baseline, { total: s.atsScore?.total });
  check('store: score visibly changed', s.atsScore?.total !== was.baselineTotal, { before: was.baselineTotal, after: s.atsScore?.total });
  const skills = collectResumeSkills(s.tailoredResume).map((x) => x.toLowerCase());
  check('content: no skill on the tailored resume is reported missing', !(s.gapAnalysis?.missing ?? []).some((k) => skills.includes(k.keyword.toLowerCase())));
  const text = collectResumeText(s.tailoredResume).full;
  const phantom = (s.gapAnalysis?.matched ?? []).filter((k) => countOccurrences(text, k.keyword) === 0).map((k) => k.keyword);
  check('content: every matched keyword occurs in the tailored resume', phantom.length === 0, phantom);

  const cmp = compareScores(s.originalAtsScore, s.atsScore, s.originalGapAnalysis, s.gapAnalysis);
  if (cmp) {
    console.log(`score ${cmp.before.total} / ${cmp.before.scoreableMax} -> ${cmp.after.total} / ${cmp.after.scoreableMax}: ${describeScoreChange(cmp)}`);
    console.log('gained:', cmp.keywords.improved.map((m) => `${m.keyword} (${m.from} -> ${m.to})`).join(', ') || '(none)');
    console.log('lost:', cmp.keywords.regressed.map((m) => `${m.keyword} (${m.from} -> ${m.to})`).join(', ') || '(none)');
  }
  if (location.pathname === '/analyze') {
    const card = document.querySelector('.compare');
    check('page: before/after card shown', Boolean(card));
    check('page: it shows both totals', Boolean(card) && card.innerText.includes(String(cmp?.before.total)) && card.innerText.includes(String(cmp?.after.total)));
    check('page: ScoreCard shows the tailored total', renderedTotal() === String(s.atsScore?.total), renderedTotal());
  } else console.warn('Not on /analyze: page checks skipped.');
  remember({ afterTailor: json(s.atsScore), changesLog: json(s.changesLog) });
  return finish('Next: on /tailor (do not re-run it), await liveManualEdit().');
}

/** Step 3: a hand edit on /tailor, through the real editor. Appends one sentence to the summary. */
export async function liveManualEdit() {
  failed = 0;
  console.group('pipeline - live 3: a hand edit rescores without a re-run');
  try {
    let s = liveState();
    const gap = s.gapAnalysis ?? {};
    const target = [...(gap.missing ?? []), ...(gap.partial ?? [])].sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.priority] ?? 3) - ({ high: 0, medium: 1, low: 2 }[b.priority] ?? 3))[0];
    if (!target) throw new Error('Every keyword is already matched, so there is nothing for an edit to move.');
    const before = { score: s.atsScore, bucket: bucketOf(gap, target.keyword), changesLog: json(s.changesLog) };

    const button = document.querySelector('button[aria-label="Edit summary"]');
    if (!button) throw new Error('No "Edit summary" button. Open /tailor on a session with a tailoring pass.');
    const block = button.closest('.edit-block');
    button.click();
    const field = await waitFor(() => block.querySelector('textarea[name="summary"]'), 'summary field');
    remember({ summaryBeforeEdit: field.value, keyword: target.keyword });
    setValue(field, `${field.value.trim()} Hands-on with ${target.keyword}.`.trim());
    [...block.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save').click();
    await waitFor(() => !block.querySelector('.editor'), 'editor to close');
    s = await waitFor(() => (liveState().atsScore !== before.score ? liveState() : null), 'the score to change');

    check(`"${target.keyword}" moved out of ${before.bucket}`, bucketOf(s.gapAnalysis, target.keyword) !== before.bucket, bucketOf(s.gapAnalysis, target.keyword));
    check('score recomputed and matches the edited resume', json(s.atsScore) === json(expectedScore(s)));
    check('score total changed', s.atsScore.total !== before.score.total, { before: before.score.total, after: s.atsScore.total });
    check('Tailor was not re-run (changesLog unchanged)', json(s.changesLog) === before.changesLog && json(s.changesLog) === saved().changesLog);
    check('the edit is logged as a hand edit', (s.tailorManualEdits ?? []).some((e) => e.section === 'summary'));
    check('baseline still the Input-time score', json(s.originalAtsScore) === saved().baseline);
    check('storage: the saved session already has the new score', loadSession().state?.atsScore?.total === s.atsScore.total);
    const line = document.querySelector('.tailor__score');
    check('page: Tailor\'s score line shows the new total', Boolean(line) && line.innerText.includes(String(s.atsScore.total)), line?.innerText);
    console.log(`score ${before.score.total} -> ${s.atsScore.total}`);
  } catch (err) {
    check(err.message, false);
  }
  return finish('Optional: reload and run liveVerifyReload(); run liveUndoEdit() on /tailor to restore the summary.');
}

/** After a reload: the scores came back as they were saved, and still match the resume. */
export function liveVerifyReload() {
  failed = 0;
  console.group('pipeline - live: after reload');
  const s = liveState();
  check('baseline still the Input-time score', json(s.originalAtsScore) === saved().baseline);
  check('current score matches the current resume', json(s.atsScore) === json(expectedScore(s)));
  return finish();
}

/** Put the summary back to what it was before liveManualEdit(), through the editor. */
export async function liveUndoEdit() {
  failed = 0;
  console.group('pipeline - live: undo the summary edit');
  try {
    const { summaryBeforeEdit } = saved();
    if (typeof summaryBeforeEdit !== 'string') throw new Error('Run liveManualEdit() first.');
    const button = document.querySelector('button[aria-label="Edit summary"]');
    if (!button) throw new Error('Open /tailor first.');
    const block = button.closest('.edit-block');
    button.click();
    const field = await waitFor(() => block.querySelector('textarea[name="summary"]'), 'summary field');
    setValue(field, summaryBeforeEdit);
    [...block.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save').click();
    await waitFor(() => !block.querySelector('.editor'), 'editor to close');
    const s = liveState();
    check('summary restored', s.tailoredResume?.summary === summaryBeforeEdit.trim());
    check('score matches the restored resume', json(s.atsScore) === json(expectedScore(s)));
    if (saved().afterTailor) check('score back to the post-Tailor value (if nothing else was edited)', json(s.atsScore) === saved().afterTailor);
  } catch (err) {
    check(err.message, false);
  }
  return finish();
}

export default { testScenario, measureSizes, liveAfterInput, liveAfterTailor, liveManualEdit, liveVerifyReload, liveUndoEdit };
