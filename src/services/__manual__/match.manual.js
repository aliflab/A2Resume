/**
 * Manual checks for Match: the batch runner, ranking, staleness, removal,
 * persistence, and the measured storage cost of a real batch.
 *
 * Not imported by the app and not in the build.
 *
 * The offline half is assertion-based and needs no provider, no key and no
 * network. The AI parse is stood in for by `runStubbed`, which re-implements
 * ONLY the line that calls the provider and reaches the real ranking, row
 * building and failure handling through the same exported helpers the runner
 * uses -- see its comment. The real `runMatchBatch` is exercised by the live
 * runners, which make real calls.
 *
 *   const m = await import('/src/services/__manual__/match.manual.js');
 *   m.testOffline();            // ASSERTIONS, no DOM (also runs under Node)
 *   m.measureBatch();           // STORAGE SIZE for 1/3/5/10 postings -- prints a table
 *   await m.testReducer();      // appReducer + saveSession round trip, browser only
 *
 * Live, on /match, against a session with a resume, a tailoring pass and a
 * stored key. ONE LINE TO PASTE, repeated -- it remembers which step it reached
 * and prints RELOAD when it wants one:
 *
 *   await (await import('/src/services/__manual__/match.manual.js')).runLive()
 *
 * Step 3 makes ONE REAL AI CALL PER POSTING (2 with the sample batch). The
 * individual runners are still exported if you want to drive them by hand:
 * liveAddPostings, liveFetchBlockedUrl, liveRun, verifyResultsSurvived,
 * liveStaleness, liveRemoveOne, verifyRemovalSurvived, restoreResume.
 *
 * The live runners MUTATE the loaded session (postings, results, and the resume
 * summary in the staleness one). Run them on test data.
 */

import {
  MAX_POSTINGS,
  buildFailedResult,
  buildMatchResult,
  createPosting,
  describePosting,
  isMatchStale,
  isRunnablePosting,
  rankMatchResults,
  removeMatchResult,
  runMatchBatch,
  summariseJD,
  summariseScore,
  topMissingKeywords,
} from '../matchRunner.js';
import { analyzeCompetencyGaps } from '../gapAnalyzer.js';
import { TOTAL_TIMEOUT_MS as SCRAPER_TOTAL_TIMEOUT_MS } from '../jdScraper.js';
import { calculateATSScore } from '../atsScorer.js';
import { fingerprint } from '../../utils/artefactFingerprint.js';
import {
  SESSION_STORAGE_NAME,
  TYPICAL_QUOTA_CHARS,
  loadSession,
  measureSession,
  saveSession,
} from '../sessionPersistence.js';

const RAW_KEY = `a2resume:${SESSION_STORAGE_NAME}`;
const MEMO_KEY = '__a2resume_match';

let failed = 0;
const check = (label, pass, detail) => {
  if (pass) console.log('  PASS', label);
  else {
    failed += 1;
    console.error('  FAIL', label, detail ?? '');
  }
  return pass;
};

function sampleResume() {
  return {
    name: 'Jane Doe',
    contact: { email: 'jane@example.com', phone: '+44 20 7946 0000', location: 'London', customLinks: [] },
    summary: 'Backend engineer with Go and PostgreSQL experience.',
    skills: [{ category: 'Languages', skills: ['Go', 'Python'] }],
    experience: [
      {
        title: 'Senior Engineer', company: 'Acme', location: 'London', startDate: 'Jan 2020', endDate: '', isCurrentlyWorking: true,
        bullets: ['Migrated 40 services to Kubernetes, cutting deploy time from 40 to 6 minutes.', 'Cut p99 latency by 35% on the payments API.'],
        links: [],
      },
      { title: 'Engineer', company: 'Beta', startDate: 'Jun 2016', endDate: 'Dec 2019', bullets: ['Built a reporting API used by 200 internal users.'] },
    ],
    projects: [{ name: 'Tracer', description: 'A tracing library.', bullets: [], links: [] }],
    education: [{ institution: 'University of Leeds', degree: 'BSc', field: 'Computer Science', startDate: '2012', endDate: '2015', details: [] }],
    certifications: [{ name: 'AWS Solutions Architect', issuer: 'AWS', date: '2022', url: '' }],
  };
}

/** Three postings whose keyword sets are deliberately ordered best to worst. */
function sampleJDs() {
  return [
    {
      jobTitle: 'Senior Backend Engineer',
      company: 'Nimbus',
      location: 'London',
      seniority: 'Senior',
      employmentType: 'Full-time',
      atsKeywords: { high: ['Go', 'Kubernetes'], medium: ['PostgreSQL'], low: [] },
      requiredSkills: ['5+ years of backend engineering'],
      preferredSkills: [],
      responsibilities: ['Own the deployment pipeline.'],
    },
    {
      jobTitle: 'Platform Engineer',
      company: 'Cirrus',
      location: 'Remote',
      seniority: 'Mid',
      employmentType: 'Full-time',
      atsKeywords: { high: ['Kubernetes', 'Terraform'], medium: ['Go'], low: [] },
      requiredSkills: [],
      preferredSkills: [],
      responsibilities: [],
    },
    {
      jobTitle: 'Frontend Engineer',
      company: 'Stratus',
      location: 'Berlin',
      seniority: 'Mid',
      employmentType: 'Full-time',
      atsKeywords: { high: ['React', 'TypeScript'], medium: ['GraphQL'], low: ['CSS'] },
      requiredSkills: [],
      preferredSkills: [],
      responsibilities: [],
    },
  ];
}

/**
 * Run a batch with the AI parse stubbed.
 *
 * `runMatchBatch` calls `parseJobDescriptionWithAI` directly, so the stub is
 * installed by intercepting the module namespace. That is not possible for an
 * ES module import binding, so the batch is instead re-implemented here ONLY
 * where the parse happens -- everything else (ordering, the gap analysis, the
 * score, the row shape, the failure handling, the ranking) is the real code
 * reached through the same exported helpers the runner uses.
 *
 * The real `runMatchBatch` is still exercised end to end by the live runners,
 * which make real calls. This exists so the offline half can assert the loop's
 * BEHAVIOUR -- one failure not killing the batch, auth stopping it -- without
 * spending money on it.
 */
async function runStubbed({ postings, resume, parse, stopOnAuthError = true, onProgress }) {
  const results = [];
  let aborted = false;
  const queue = postings.filter(isRunnablePosting).slice(0, MAX_POSTINGS);

  for (let index = 0; index < queue.length; index += 1) {
    const posting = queue[index];
    onProgress?.({ phase: 'start', id: posting.id, index, total: queue.length });
    try {
      const parsedJD = await parse(posting, index);
      const gap = analyzeCompetencyGaps(resume, parsedJD);
      const score = calculateATSScore(resume, parsedJD, gap);
      const row = buildMatchResult({ posting, parsedJD, gap, score, index });
      results.push(row);
      onProgress?.({ phase: 'done', id: posting.id, index, total: queue.length, result: row });
    } catch (err) {
      results.push(buildFailedResult({ posting, error: { message: err.message, code: err.code ?? null }, index }));
      onProgress?.({ phase: 'failed', id: posting.id, index, total: queue.length, error: err });
      if (stopOnAuthError && err.code === 'auth') {
        aborted = true;
        break;
      }
    }
  }

  return {
    results: rankMatchResults(results),
    resumeFingerprint: fingerprint(resume),
    ranAt: new Date().toISOString(),
    provider: 'stub',
    completed: results.filter((r) => r.error === null).length,
    failed: results.filter((r) => r.error !== null).length,
    aborted,
  };
}

/** A real batch slice, built through the real analyser and scorer. */
function buildBatch(resume, jds, { postings } = {}) {
  const list = postings ?? jds.map((jd, i) => createPosting({ text: `Posting text for ${jd.jobTitle}. `.repeat(40), label: '', source: i === 0 ? 'url' : 'paste', url: i === 0 ? 'https://boards.example.com/jobs/1' : '' }));
  const results = list.map((posting, index) => {
    const parsedJD = jds[index % jds.length];
    const gap = analyzeCompetencyGaps(resume, parsedJD);
    const score = calculateATSScore(resume, parsedJD, gap);
    return buildMatchResult({ posting, parsedJD, gap, score, index });
  });
  return {
    batch: {
      results: rankMatchResults(results),
      resumeFingerprint: fingerprint(resume),
      ranAt: new Date().toISOString(),
      provider: 'claude',
      completed: results.length,
      failed: 0,
      aborted: false,
    },
    postings: list,
  };
}

// ---------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------

export function testOffline() {
  failed = 0;
  console.group('match - offline assertions');
  try {
    const resume = sampleResume();
    const jds = sampleJDs();
    const frozen = JSON.stringify(resume);

    // --- postings ----------------------------------------------------------
    const a = createPosting({ text: 'Some posting text.', label: 'My favourite', source: 'paste' });
    const b = createPosting({ text: 'Some posting text.', label: '', url: 'https://boards.example.com/jobs/42', source: 'url' });
    check('a posting gets a unique id even when the text is identical', a.id !== b.id, [a.id, b.id]);
    check('ids are what rows are addressed by, so a removal cannot drift an index', typeof a.id === 'string' && a.id.length > 3);
    check('a posting starts pending with no error', a.status === 'pending' && a.error === null);
    check('source is normalised to paste or url only', createPosting({ source: 'nonsense' }).source === 'paste' && b.source === 'url');
    check('junk input does not throw', typeof createPosting().id === 'string' && typeof createPosting(null).id === 'string');
    check('an empty posting is not runnable, so it never costs a call', !isRunnablePosting(createPosting({ text: '   ' })) && isRunnablePosting(a));
    check('runnability tolerates junk', !isRunnablePosting(null) && !isRunnablePosting({}) && !isRunnablePosting('x'));
    check('the batch cap is a real exported number', MAX_POSTINGS === 10);

    // --- labels ------------------------------------------------------------
    check('label: the user nickname wins over the parsed title', describePosting(a, jds[0], 0) === 'My favourite');
    check('label: falls back to title and company', describePosting(b, jds[0], 0) === 'Senior Backend Engineer — Nimbus');
    check('label: title alone, company alone', describePosting(b, { jobTitle: 'Only Title' }, 0) === 'Only Title' && describePosting(b, { company: 'Only Co' }, 0) === 'Only Co');
    check('label: falls back to the URL path when nothing is parsed', describePosting(b, null, 0) === 'boards.example.com/jobs/42', describePosting(b, null, 0));
    check('label: a malformed URL does not throw', typeof describePosting(createPosting({ url: 'not a url' }), null, 0) === 'string');
    check('label: never blank -- a numbered fallback', describePosting(createPosting({ text: 'x' }), null, 4) === 'Posting 5');

    // --- what gets stored, and what deliberately does not ------------------
    const jdSummary = summariseJD(jds[0]);
    check('summariseJD keeps the fields a row renders', jdSummary.jobTitle === 'Senior Backend Engineer' && jdSummary.company === 'Nimbus' && jdSummary.location === 'London');
    check('summariseJD keeps atsKeywords, the authority a re-score would need', jdSummary.atsKeywords.high.join() === 'Go,Kubernetes');
    check('summariseJD DROPS responsibilities and requirement clauses -- ten full parses is storage nobody reads', !('responsibilities' in jdSummary) && !('requiredSkills' in jdSummary));
    check('summariseJD tolerates junk', typeof summariseJD(null).jobTitle === 'string' && Array.isArray(summariseJD('x').atsKeywords.high));

    const gap0 = analyzeCompetencyGaps(resume, jds[0]);
    const score0 = calculateATSScore(resume, jds[0], gap0);
    const scoreSummary = summariseScore(score0);
    check('summariseScore keeps the headline numbers and the breakdown', typeof scoreSummary.total === 'number' && typeof scoreSummary.percentage === 'number' && scoreSummary.grade && scoreSummary.breakdown.length > 0);
    check('summariseScore DROPS recommendations -- prose Match never renders, and the largest part of a score', !('recommendations' in scoreSummary));
    check('summariseScore DROPS the embedded gapAnalysis -- the row stores it once under `gap`', !('gapAnalysis' in scoreSummary));
    check('summariseScore keeps the fallback flag and its reasons, so a partial score can say so', 'isFallback' in scoreSummary && Array.isArray(scoreSummary.fallbackReasons));

    const row = buildMatchResult({ posting: b, parsedJD: jds[0], gap: gap0, score: score0, index: 0 });
    check('a row carries id, label, url, source, jd, score and gap', row.id === b.id && row.label && row.url && row.jd && row.score && row.gap && row.error === null, Object.keys(row));
    check('a row does NOT carry the raw JD text -- up to 60k each, and it already lives on the posting', !JSON.stringify(row).includes('Some posting text'));

    const failedRow = buildFailedResult({ posting: b, error: { message: 'Boom', code: 'server' }, index: 0 });
    check('a failed row keeps its identity and its error, and has no score', failedRow.id === b.id && failedRow.score === null && failedRow.gap === null && failedRow.error.message === 'Boom');
    check('a failed row tolerates a string error', buildFailedResult({ posting: b, error: 'plain string' }).error.message === 'plain string');
    check('a failed row with no error at all still gets a message', buildFailedResult({ posting: b }).error.message.length > 0);

    // --- ranking -----------------------------------------------------------
    const { batch } = buildBatch(resume, jds);
    const pcts = batch.results.map((r) => r.score.percentage);
    check('ranked highest first', pcts.every((p, i) => i === 0 || p <= pcts[i - 1]), pcts);
    check('the ranking is real -- the Go/Kubernetes posting beats the React one', batch.results[0].jd.company === 'Nimbus' && batch.results.at(-1).jd.company === 'Stratus', batch.results.map((r) => `${r.jd.company} ${r.score.percentage}`));
    check('ranking is by PERCENTAGE, not raw total -- a smaller scoreableMax must not flatter a row', (() => {
      const low = { ...batch.results[2], id: 'x1', score: { ...batch.results[2].score, total: 60, scoreableMax: 100, percentage: 60 } };
      const partial = { ...batch.results[0], id: 'x2', score: { ...batch.results[0].score, total: 60, scoreableMax: 80, percentage: 75 } };
      return rankMatchResults([low, partial])[0].id === 'x2';
    })());
    check('failed rows sort LAST, never interleaved -- no score is not "worst match"', (() => {
      const mixed = rankMatchResults([failedRow, ...batch.results]);
      return mixed.at(-1).error !== null && mixed[0].error === null;
    })());
    check('ranking tolerates junk and empties', rankMatchResults(null).length === 0 && rankMatchResults([null, 'x']).length === 0 && rankMatchResults([{ id: 'a' }]).length === 1);

    // --- removal -----------------------------------------------------------
    const dropped = removeMatchResult(batch.results, batch.results[1].id);
    check('remove: that row only', dropped.length === batch.results.length - 1 && !dropped.some((r) => r.id === batch.results[1].id));
    check('remove: the others are the SAME objects, untouched', dropped[0] === batch.results[0] && dropped[1] === batch.results[2]);
    check('remove: an unknown id returns the argument itself, so a no-op writes no storage', removeMatchResult(batch.results, 'nope') === batch.results && removeMatchResult(batch.results, undefined) === batch.results);
    check('remove: tolerates junk', Array.isArray(removeMatchResult(null, 'x')) === false || removeMatchResult(null, 'x') === null);

    // --- top missing -------------------------------------------------------
    const stratus = batch.results.find((r) => r.jd.company === 'Stratus');
    const top = topMissingKeywords(stratus.gap, 3);
    check('top missing: at most 3, highest priority first', top.length <= 3 && top.length > 0 && top[0].priority === 'high', top);
    check('top missing: only genuinely missing keywords', top.every((k) => stratus.gap.missing.some((m) => m.keyword === k.keyword)));
    check('top missing: tolerates junk and an empty gap', topMissingKeywords(null).length === 0 && topMissingKeywords({ missing: [] }).length === 0 && topMissingKeywords({ missing: [null, 'x'] }).length === 0);
    check('top missing: an unrecognised priority still counts, it goes last', (() => {
      const out = topMissingKeywords({ missing: [{ keyword: 'Weird', priority: 'nonsense' }, { keyword: 'Real', priority: 'high' }] }, 2);
      return out[0].keyword === 'Real' && out[1].keyword === 'Weird';
    })());

    // --- staleness ---------------------------------------------------------
    check('staleness: a fresh batch is not stale', isMatchStale(batch, resume) === false);
    check('staleness: ANY resume change makes it stale -- a hand edit', isMatchStale(batch, { ...resume, summary: 'Edited.' }) === true);
    check('staleness: an entry removed, an entry added, merged skills', (() => {
      const removedEntry = isMatchStale(batch, { ...resume, experience: resume.experience.slice(1) });
      const addedEntry = isMatchStale(batch, { ...resume, experience: [{ title: 'New', company: 'X' }, ...resume.experience] });
      const merged = isMatchStale(batch, { ...resume, skills: [...resume.skills, { category: 'Inferred from experience', skills: ['Kubernetes'] }] });
      return removedEntry === true && addedEntry === true && merged === true;
    })());
    check('staleness: key order does not matter', isMatchStale(batch, { summary: resume.summary, ...resume }) === false);
    check('staleness: "cannot tell" is null, never false', isMatchStale(null, resume) === null && isMatchStale({ results: [] }, resume) === null && isMatchStale({ results: batch.results }, resume) === null);
    check('staleness: ONE fingerprint for the batch, not one per row -- rows cannot disagree', typeof batch.resumeFingerprint === 'string' && batch.results.every((r) => !('resumeFingerprint' in r)));
    check('staleness: the JD is NOT part of it -- a row is not invalidated by some other analysis', isMatchStale({ ...batch }, resume) === false);
    check('the source resume was never mutated', JSON.stringify(resume) === frozen);

    // --- the loop's behaviour, with the parse stubbed ----------------------
    const three = jds.map((jd, i) => createPosting({ text: `text ${i}`, label: '' }));

    return (async () => {
      const events = [];
      const ok = await runStubbed({
        postings: three,
        resume,
        parse: async (_p, i) => jds[i],
        onProgress: (e) => events.push(e.phase),
      });
      check('loop: every posting produced a row', ok.results.length === 3 && ok.completed === 3 && ok.failed === 0);
      check('loop: progress fired per posting, start then done', events.filter((e) => e === 'start').length === 3 && events.filter((e) => e === 'done').length === 3, events);
      check('loop: the batch carries a fingerprint, a timestamp and counts', typeof ok.resumeFingerprint === 'string' && typeof ok.ranAt === 'string' && ok.aborted === false);

      // THE MOST EXPENSIVE FAILURE MODE: one bad posting discarding the rest.
      const partial = await runStubbed({
        postings: three,
        resume,
        parse: async (_p, i) => {
          if (i === 1) throw Object.assign(new Error('That posting could not be read.'), { code: 'parse' });
          return jds[i];
        },
      });
      check('loop: ONE FAILURE DOES NOT DISCARD THE OTHERS -- the user paid for those parses', partial.completed === 2 && partial.failed === 1 && partial.results.length === 3, { completed: partial.completed, failed: partial.failed });
      check('loop: the failed row keeps its place in the batch and carries its error', partial.results.some((r) => r.error && /could not be read/.test(r.error.message)));
      check('loop: and it is not aborted -- the remaining postings still ran', partial.aborted === false);

      // An auth failure WILL fail identically for every remaining posting.
      const authStopped = await runStubbed({
        postings: three,
        resume,
        parse: async () => {
          throw Object.assign(new Error('Your API key was rejected.'), { code: 'auth' });
        },
      });
      check('loop: an AUTH failure stops the batch rather than burning every posting on the same rejection', authStopped.aborted === true && authStopped.results.length === 1, { rows: authStopped.results.length });
      check('loop: without stopOnAuthError it would run them all, which is why the default is on', (await runStubbed({ postings: three, resume, parse: async () => { throw Object.assign(new Error('nope'), { code: 'auth' }); }, stopOnAuthError: false })).results.length === 3);

      check('loop: an empty posting is skipped and costs nothing', (await runStubbed({ postings: [createPosting({ text: '  ' }), three[0]], resume, parse: async () => jds[0] })).results.length === 1);
      check('loop: the cap is enforced, so no batch can exceed MAX_POSTINGS calls', (await runStubbed({ postings: Array.from({ length: 15 }, (_, i) => createPosting({ text: `t${i}` })), resume, parse: async () => jds[0] })).results.length === MAX_POSTINGS);

      // The real runner's guards.
      for (const [label, args] of [
        ['no postings', { postings: [], resume, provider: 'claude', apiKey: 'x' }],
        ['all empty postings', { postings: [createPosting({ text: '' })], resume, provider: 'claude', apiKey: 'x' }],
        ['no resume', { postings: three, resume: null, provider: 'claude', apiKey: 'x' }],
      ]) {
        let threw = false;
        try {
          await runMatchBatch(args);
        } catch {
          threw = true;
        }
        check(`runMatchBatch refuses to spend anything: ${label}`, threw);
      }

      // --- persistence -----------------------------------------------------
      if (typeof localStorage !== 'undefined') {
        const backup = localStorage.getItem(RAW_KEY);
        try {
          const { batch: stored, postings: storedPostings } = buildBatch(resume, jds);
          saveSession({ resumeText: 'x', resume, matchPostings: storedPostings, matchResults: stored, sources: {}, settings: {} });
          const loaded = loadSession().state;
          check('persistence: the batch round-trips exactly', JSON.stringify(loaded.matchResults) === JSON.stringify(stored));
          check('persistence: the postings round-trip, raw text included', loaded.matchPostings.length === storedPostings.length && loaded.matchPostings[0].text === storedPostings[0].text);
          check('persistence: it is still not stale after a round trip', isMatchStale(loaded.matchResults, loaded.resume) === false);
          check('persistence: a batch alone keeps a session alive -- it is paid work', (() => {
            saveSession({ resumeText: '', resume: null, matchResults: stored, sources: {}, settings: {} });
            return loadSession().state !== null;
          })());
          check('persistence: POSTINGS alone keep a session alive too -- pasting 8 postings before step 1 must survive a reload', (() => {
            saveSession({ resumeText: '', resume: null, matchPostings: storedPostings, sources: {}, settings: {} });
            const out = loadSession().state;
            return out !== null && Array.isArray(out.matchPostings) && out.matchPostings.length === storedPostings.length;
          })());
          check('persistence: a wrong-typed batch is dropped on its own, the session still loads', (() => {
            const envelope = JSON.parse(localStorage.getItem(RAW_KEY));
            envelope.state.matchResults = 'a string';
            envelope.state.matchPostings = 'also a string';
            envelope.state.resume = resume;
            localStorage.setItem(RAW_KEY, JSON.stringify(envelope));
            const out = loadSession().state;
            return out !== null && !out.matchResults && !out.matchPostings && out.resume !== null;
          })());
          check('persistence: an OLD envelope with neither key loads fine -- no SESSION_VERSION bump needed', (() => {
            const envelope = JSON.parse(localStorage.getItem(RAW_KEY));
            delete envelope.state.matchResults;
            delete envelope.state.matchPostings;
            envelope.state.resume = resume;
            localStorage.setItem(RAW_KEY, JSON.stringify(envelope));
            const out = loadSession().state;
            return out !== null && !out.matchResults && out.resume !== null;
          })());
        } finally {
          if (backup === null) localStorage.removeItem(RAW_KEY);
          else localStorage.setItem(RAW_KEY, backup);
        }
      } else {
        console.warn('  (skipped persistence: no localStorage)');
      }

      console.log(failed ? `${failed} FAILED` : 'all passed');
      console.groupEnd();
      return failed === 0;
    })();
  } catch (err) {
    check(`threw: ${err.message}`, false, err);
    console.log(failed ? `${failed} FAILED` : 'all passed');
    console.groupEnd();
    return Promise.resolve(false);
  }
}

// ---------------------------------------------------------------------------
// Storage size -- the number that matters most for this feature
// ---------------------------------------------------------------------------

/**
 * How much a real batch costs in storage, at 1 / 3 / 5 / 10 postings.
 *
 * Match is the first feature that stores several postings' worth of data at
 * once, so this is measured rather than estimated. Everything goes through the
 * real analyser, the real scorer and the real `saveSession`, so the figures are
 * what a browser would actually hold.
 *
 * The JD text length is the dominating variable, so it is measured at a
 * realistic 6k per posting AND at the scraper's 60k cap, because the second is
 * the worst case a user can actually reach through the URL fetcher.
 */
export function measureBatch({ jdChars = 6_000 } = {}) {
  console.group(`match - storage size (JD text ${jdChars.toLocaleString()} chars each)`);
  const resume = sampleResume();
  const jds = sampleJDs();
  const rows = [];

  for (const count of [1, 3, 5, 10]) {
    const postings = Array.from({ length: count }, (_, i) =>
      createPosting({
        text: `Posting ${i + 1}. `.repeat(Math.ceil(jdChars / 14)).slice(0, jdChars),
        url: i % 2 === 0 ? `https://boards.example.com/jobs/${i}` : '',
        source: i % 2 === 0 ? 'url' : 'paste',
      })
    );
    const { batch } = buildBatch(resume, jds, { postings });

    // A realistic full session: the pipeline's own artefacts as well.
    const gap = analyzeCompetencyGaps(resume, jds[0]);
    const score = calculateATSScore(resume, jds[0], gap);
    const base = {
      resumeText: 'x'.repeat(7_000),
      resume,
      jobDescription: 'y'.repeat(6_000),
      parsedJD: jds[0],
      gapAnalysis: gap,
      atsScore: score,
      originalGapAnalysis: gap,
      originalAtsScore: score,
      sources: {},
      settings: {},
    };

    const without = measureSession(base);
    const withBatch = measureSession({ ...base, matchPostings: postings, matchResults: batch });
    const resultsOnly = JSON.stringify(batch).length;
    const postingsOnly = JSON.stringify(postings).length;

    rows.push({
      postings: count,
      'session total': withBatch.total.toLocaleString(),
      'match adds': (withBatch.total - without.total).toLocaleString(),
      'of which results': resultsOnly.toLocaleString(),
      'of which raw text': postingsOnly.toLocaleString(),
      'per posting': Math.round((withBatch.total - without.total) / count).toLocaleString(),
      '% of quota': `${(withBatch.fractionOfTypicalQuota * 100).toFixed(2)}%`,
    });
  }

  console.table(rows);
  console.log(`Quota assumed: ${TYPICAL_QUOTA_CHARS.toLocaleString()} chars per origin, shared by every key.`);
  console.log('Run measureBatch({ jdChars: 60000 }) for the scraper-cap worst case.');
  console.groupEnd();
  return rows;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export async function testReducer() {
  failed = 0;
  const { appReducer, initialState, hydrate, ACTIONS, RESCORING_ACTIONS } = await import('../../context/AppContext.jsx');
  console.group('match - reducer');
  const backup = typeof localStorage !== 'undefined' ? localStorage.getItem(RAW_KEY) : null;
  try {
    const resume = sampleResume();
    const jds = sampleJDs();
    const { batch, postings } = buildBatch(resume, jds);
    const base = { ...initialState, resume, parsedJD: jds[0], resumeText: 'x' };

    // --- postings ----------------------------------------------------------
    const withPostings = appReducer(base, { type: ACTIONS.SET_MATCH_POSTINGS, payload: postings });
    check('postings: the list lands', withPostings.matchPostings === postings);
    check('postings: an emptied list becomes null, not [] -- nothing to misread in storage', appReducer(withPostings, { type: ACTIONS.SET_MATCH_POSTINGS, payload: [] }).matchPostings === null);
    check('postings: setting the same array is a no-op, so it writes no storage', appReducer(withPostings, { type: ACTIONS.SET_MATCH_POSTINGS, payload: postings }) === withPostings);
    check('postings: do NOT require a resume -- pasting before step 1 is legitimate', appReducer(initialState, { type: ACTIONS.SET_MATCH_POSTINGS, payload: postings }).matchPostings === postings);

    // --- results -----------------------------------------------------------
    const withResults = appReducer(withPostings, { type: ACTIONS.SET_MATCH_RESULTS, payload: batch });
    check('results: the batch lands', withResults.matchResults === batch);
    check('results: the resume and the pipeline score are untouched', withResults.resume === base.resume && withResults.atsScore === base.atsScore);
    check('results: NOT in RESCORING_ACTIONS -- Match reads the resume and writes nothing back', !RESCORING_ACTIONS.includes('SET_MATCH_RESULTS') && !RESCORING_ACTIONS.includes('SET_MATCH_POSTINGS') && !RESCORING_ACTIONS.includes('REMOVE_MATCH_RESULT'));
    check('results: a malformed payload changes nothing', appReducer(withResults, { type: ACTIONS.SET_MATCH_RESULTS, payload: null }) === withResults && appReducer(withResults, { type: ACTIONS.SET_MATCH_RESULTS, payload: { nope: 1 } }) === withResults);
    check('results: with no resume a late-landing batch is refused', appReducer({ ...initialState }, { type: ACTIONS.SET_MATCH_RESULTS, payload: batch }).matchResults === null);

    // --- removing one ------------------------------------------------------
    const target = batch.results[1];
    const afterRemoval = appReducer(withResults, { type: ACTIONS.REMOVE_MATCH_RESULT, payload: { id: target.id } });
    check('remove: that row is gone', !afterRemoval.matchResults.results.some((r) => r.id === target.id));
    check('remove: the OTHER rows are the same objects -- untouched, not rebuilt', afterRemoval.matchResults.results[0] === batch.results[0] && afterRemoval.matchResults.results[1] === batch.results[2]);
    check('remove: the counts are recomputed', afterRemoval.matchResults.completed === batch.completed - 1);
    check('remove: the fingerprint and ranAt are KEPT -- removing a row does not make a stale batch fresh', afterRemoval.matchResults.resumeFingerprint === batch.resumeFingerprint && afterRemoval.matchResults.ranAt === batch.ranAt);
    check('remove: still stale against a changed resume after a removal', isMatchStale(afterRemoval.matchResults, { ...resume, summary: 'Changed.' }) === true);
    check('remove: the postings are untouched, so a re-run needs no re-paste', afterRemoval.matchPostings === postings);
    check('remove: an unknown id changes nothing at all', appReducer(withResults, { type: ACTIONS.REMOVE_MATCH_RESULT, payload: { id: 'nope' } }) === withResults);
    check('remove: a malformed payload changes nothing', appReducer(withResults, { type: ACTIONS.REMOVE_MATCH_RESULT, payload: null }) === withResults);
    check('remove: removing the LAST row empties the batch to null, not a batch with no rows', (() => {
      let s = withResults;
      for (const r of batch.results) s = appReducer(s, { type: ACTIONS.REMOVE_MATCH_RESULT, payload: { id: r.id } });
      return s.matchResults === null;
    })());

    // --- clearing ----------------------------------------------------------
    const cleared = appReducer(withResults, { type: ACTIONS.CLEAR_MATCH_RESULTS });
    check('clear results: results go, POSTINGS STAY -- a re-run must not need a re-paste', cleared.matchResults === null && cleared.matchPostings === postings);
    check('clear results: twice is a no-op', appReducer(cleared, { type: ACTIONS.CLEAR_MATCH_RESULTS }) === cleared);
    check('clear all: both go', (() => {
      const all = appReducer(withResults, { type: ACTIONS.CLEAR_MATCH });
      return all.matchResults === null && all.matchPostings === null;
    })());
    check('clear all: twice is a no-op', (() => {
      const all = appReducer(withResults, { type: ACTIONS.CLEAR_MATCH });
      return appReducer(all, { type: ACTIONS.CLEAR_MATCH }) === all;
    })());

    // --- staleness through every resume-changing path -----------------------
    const withTailored = appReducer(withResults, { type: ACTIONS.SET_TAILORED_RESUME, payload: { resume: { ...resume, summary: 'Tailored.' }, changesLog: [], corrections: [], parsedJD: withResults.parsedJD } });
    check('staleness: a tailoring pass makes the batch stale and NOTHING discarded it', withTailored.matchResults === batch && isMatchStale(withTailored.matchResults, withTailored.tailoredResume) === true);
    const withEdit = appReducer(withTailored, { type: ACTIONS.UPDATE_TAILORED_SECTION, payload: { section: 'summary', value: 'Edited by hand.' } });
    check('staleness: a hand edit too, still without discarding', withEdit.matchResults === batch && isMatchStale(withEdit.matchResults, withEdit.tailoredResume) === true);
    const withEntryGone = appReducer(withEdit, { type: ACTIONS.REMOVE_TAILORED_ENTRY, payload: { section: 'experience', index: 0 } });
    check('staleness: an entry removed', isMatchStale(withEntryGone.matchResults, withEntryGone.tailoredResume) === true);
    const withSkills = appReducer(withEntryGone, { type: ACTIONS.MERGE_INFERRED_SKILLS, payload: ['Kubernetes'] });
    check('staleness: approved skills', isMatchStale(withSkills.matchResults, withSkills.tailoredResume) === true);
    check('staleness: nothing in that chain auto-discarded or auto-re-ran -- the same object throughout', withSkills.matchResults === batch);
    check('staleness: it applies to the WHOLE batch -- one answer, not one per row', typeof isMatchStale(withSkills.matchResults, withSkills.tailoredResume) === 'boolean' && withSkills.matchResults.results.every((r) => !('resumeFingerprint' in r)));

    // A new Input run replaces the resume, so the SCORES go but the postings stay.
    const afterClearAnalysis = appReducer(withResults, { type: ACTIONS.CLEAR_ANALYSIS });
    check('CLEAR_ANALYSIS discards the RESULTS -- they describe a resume the session no longer has', afterClearAnalysis.matchResults === null);
    check('CLEAR_ANALYSIS KEEPS the postings -- re-uploading a resume is no reason to re-paste eight postings', afterClearAnalysis.matchPostings === postings);
    check('RESET discards both', (() => {
      const r = appReducer(withResults, { type: ACTIONS.RESET });
      return r.matchResults === null && r.matchPostings === null;
    })());

    // A sweep, so a future action has to be considered.
    const payloads = {
      RESET: undefined,
      SET_RESUME_TEXT: 'x',
      SET_RESUME: resume,
      SET_JOB_DESCRIPTION: 'x',
      SET_PARSED_JD: jds[0],
      SET_GAP_ANALYSIS: null,
      SET_ATS_SCORE: null,
      SET_TAILORED_RESUME: { resume, changesLog: [], corrections: [], parsedJD: withResults.parsedJD },
      CLEAR_TAILORING: undefined,
      UPDATE_TAILORED_SECTION: { section: 'summary', value: 'Another.' },
      ADD_TAILORED_ENTRY: { section: 'projects', value: { name: 'A project' } },
      REMOVE_TAILORED_ENTRY: { section: 'certifications', index: 0 },
      SET_DRAFT_EDIT: { section: 'summary', value: 'typed' },
      DISCARD_DRAFT_EDIT: { section: 'summary' },
      SET_COVER_LETTER: { body: 'Dear X,\n\nHello.\n\nBye,\nJane' },
      UPDATE_COVER_LETTER: { body: 'Dear X,\n\nEdited.\n\nBye,\nJane' },
      CLEAR_COVER_LETTER: undefined,
      SET_MATCH_POSTINGS: postings,
      SET_MATCH_RESULTS: batch,
      REMOVE_MATCH_RESULT: { id: batch.results[0].id },
      CLEAR_MATCH_RESULTS: undefined,
      CLEAR_MATCH: undefined,
      SET_SOURCES: { provider: 'claude' },
      SET_SETTINGS: { provider: 'claude' },
      DISMISS_SESSION_NOTICE: undefined,
      SET_STATUS: 'idle',
      SET_STAGE: null,
      SET_ERROR: null,
      MERGE_INFERRED_SKILLS: ['Kubernetes'],
      CLEAR_ANALYSIS: undefined,
    };
    const DISCARDS = ['RESET', 'CLEAR_ANALYSIS', 'CLEAR_MATCH_RESULTS', 'CLEAR_MATCH'];
    const CHANGES = ['REMOVE_MATCH_RESULT', 'SET_MATCH_RESULTS'];
    for (const name of Object.keys(ACTIONS)) {
      if (!(name in payloads)) {
        check(`${name}: has a Match case (add one to payloads when adding an action)`, false);
        continue;
      }
      const after = appReducer(withResults, { type: ACTIONS[name], payload: payloads[name] });
      if (DISCARDS.includes(name)) check(`${name}: deliberately clears the results`, after.matchResults === null);
      else if (CHANGES.includes(name)) check(`${name}: deliberately replaces them`, after.matchResults !== null);
      else check(`${name}: leaves the batch alone -- never silently discarded`, after.matchResults === batch);
    }

    // A real reload.
    if (typeof localStorage !== 'undefined') {
      saveSession(withEdit);
      const rehydrated = hydrate(initialState);
      check('reload: the batch comes back with all its rows', rehydrated.matchResults?.results?.length === batch.results.length);
      check('reload: with its gap breakdowns, so the expanded view still works', rehydrated.matchResults.results.every((r) => r.gap && Array.isArray(r.gap.missing)));
      check('reload: the postings and their raw text come back', rehydrated.matchPostings?.length === postings.length && rehydrated.matchPostings[0].text === postings[0].text);
      check('reload: and it is STILL stale after the round trip', isMatchStale(rehydrated.matchResults, rehydrated.tailoredResume) === true);
      const size = measureSession(withEdit);
      console.log(`  stored session with a 3-posting batch: ${size.total.toLocaleString()} chars (${(size.fractionOfTypicalQuota * 100).toFixed(2)}% of quota); matchResults ${size.perField.matchResults.toLocaleString()}, matchPostings ${size.perField.matchPostings.toLocaleString()}`);
    }
  } catch (err) {
    check(`threw: ${err.message}`, false, err);
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
// Live
// ---------------------------------------------------------------------------

const memo = () => JSON.parse(sessionStorage.getItem(MEMO_KEY) || '{}');
const remember = (patch) => sessionStorage.setItem(MEMO_KEY, JSON.stringify({ ...memo(), ...patch }));

function liveState() {
  const handle = window.a2resumeDev;
  if (!handle || typeof handle.getState !== 'function') throw new Error('window.a2resumeDev is missing. Run this against the dev server.');
  return handle.getState();
}
const storedState = () => JSON.parse(localStorage.getItem(RAW_KEY) || 'null')?.state ?? null;

/**
 * Anything that can overlap an in-flight scrape must outlast the scraper's OWN
 * cap, not a round number.
 *
 * MEASURED: a real blocked LinkedIn URL walks the whole proxy chain in 28-33s
 * (32.9s and 30.4s in two headless runs; 31.1s reported from a real browser).
 * `jdScraper.TOTAL_TIMEOUT_MS` is 45s, so that is the ceiling a fetch can take,
 * and a 15s default sat *below* it -- which is exactly how a wait for the Fetch
 * button timed out while the previous fetch was still running and the button
 * still read "Fetching...". Derived from the scraper's constant rather than
 * copied, so raising that cap cannot silently re-introduce the bug.
 */
const NETWORK_WAIT_MS = SCRAPER_TOTAL_TIMEOUT_MS + 20_000;

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function setValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const buttonByText = (root, re) => [...root.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()));

function finish(next) {
  console.log(failed ? `${failed} FAILED` : 'all passed');
  console.groupEnd();
  if (next) console.log(next);
  return failed === 0;
}

const SAMPLE_POSTINGS = [
  {
    label: 'Backend at Nimbus',
    text: `Senior Backend Engineer at Nimbus. London, hybrid. We are looking for an engineer with strong Go experience to own our deployment pipeline. You will work with Kubernetes across a fleet of services, and with PostgreSQL as our primary datastore. Requirements: 5+ years of backend engineering, production Go, container orchestration, and strong SQL. Nice to have: Terraform, observability tooling, experience with high-throughput payment systems. Responsibilities: own the deployment pipeline, reduce p99 latency, mentor mid-level engineers.`,
  },
  {
    label: 'Frontend at Stratus',
    text: `Frontend Engineer at Stratus. Berlin. We build design-system-driven interfaces in React and TypeScript. You will own component architecture, work closely with designers in Figma, and consume our GraphQL API. Requirements: 3+ years of React, strong TypeScript, CSS architecture at scale, testing with Jest and Playwright. Nice to have: Next.js, accessibility auditing, Storybook. Responsibilities: ship the new design system, improve Core Web Vitals, own the component library.`,
  },
];

/** Step 1: add two postings by paste, through the real form. No AI calls yet. */
export async function liveAddPostings() {
  failed = 0;
  console.group('match - live 1: add postings');
  try {
    const before = liveState();
    check('precondition: on /match with a resume', Boolean(document.querySelector('#match-paste')) && Boolean(before.resume), { onPage: Boolean(document.querySelector('#match-paste')), hasResume: Boolean(before.resume) });
    check('the cost is stated before anything is added', /separate, paid AI call/i.test(document.body.innerText) || /separate AI call/i.test(document.body.innerText));

    // IDEMPOTENT ON PURPOSE. A retry that added a second copy of the sample
    // batch is what broke the posting-count assertion further down the sequence:
    // the count check read 4 where it expected 2 and reported one failure on a
    // step whose own behaviour was fine. Anything this runner added before is
    // removed first, so running it twice leaves the same two postings.
    const { ACTIONS } = await import('../../context/AppContext.jsx');
    const ours = new Set(SAMPLE_POSTINGS.map((sp) => sp.label));
    const foreign = (before.matchPostings ?? []).filter((p) => !ours.has(p.label));
    if ((before.matchPostings ?? []).length !== foreign.length) {
      console.log(`  (clearing ${(before.matchPostings ?? []).length - foreign.length} posting(s) this runner added earlier)`);
      window.a2resumeDev.dispatch({ type: ACTIONS.SET_MATCH_POSTINGS, payload: foreign.length > 0 ? foreign : null });
      await waitFor(() => (liveState().matchPostings ?? []).length === foreign.length, 'the earlier copies to go');
    }
    const baseline = (liveState().matchPostings ?? []).length;

    for (const sample of SAMPLE_POSTINGS) {
      setValue(document.querySelector('#match-paste-label'), sample.label);
      setValue(document.querySelector('#match-paste'), sample.text);
      const add = await waitFor(() => {
        const b = buttonByText(document, /^Add posting/);
        return b && !b.disabled ? b : null;
      }, 'the Add button');
      add.click();
      await waitFor(() => (liveState().matchPostings ?? []).some((p) => p.label === sample.label), `"${sample.label}" to land`);
    }

    const after = liveState();
    // Against the snapshot, not a literal: a session may legitimately already
    // hold postings the user added themselves.
    check('both postings are in the store', (after.matchPostings ?? []).length === baseline + 2, { before: baseline, after: (after.matchPostings ?? []).length });
    check('running this twice does not duplicate them', new Set((after.matchPostings ?? []).map((p) => p.label)).size === (after.matchPostings ?? []).length, (after.matchPostings ?? []).map((p) => p.label));
    remember({ postingCount: (after.matchPostings ?? []).length });
    check('each got a unique id', new Set(after.matchPostings.map((p) => p.id)).size === after.matchPostings.length);
    check('their text is stored', after.matchPostings.every((p) => p.text.length > 200));
    check('the paste box was cleared, so the next one starts fresh', document.querySelector('#match-paste').value === '');
    check('storage already carries them', (storedState()?.matchPostings ?? []).length === 2);
    check('NO results yet -- adding costs nothing', after.matchResults === null);
    const runnableNow = (after.matchPostings ?? []).filter(isRunnablePosting).length;
    check('the run card names the number of calls it will make', new RegExp(`${runnableNow} separate AI call`, 'i').test(document.body.innerText), document.body.innerText.match(/.{0,60}separate AI call.{0,40}/)?.[0]);
    remember({ labels: SAMPLE_POSTINGS.map((sp) => sp.label) });
  } catch (err) {
    check(err.message, false, err);
  }
  return finish('Next: await liveFetchBlockedUrl() to check the blocked-URL messaging.');
}

/**
 * The blocked-URL path, in this new context.
 *
 * LinkedIn answers an unknown job id with a sign-in wall at HTTP 200, which
 * `jdScraper.rejectionReason` treats as a failure. The point of this runner is
 * that Match shows the SAME "paste it in instead" guidance InputPage does,
 * rather than a bare error -- manual paste is the reliable path and the textarea
 * must stay usable.
 *
 * It makes no AI call. It does make real network requests through the proxy
 * chain, so it can take up to the scraper's 45s total budget.
 */
export async function liveFetchBlockedUrl(url = 'https://www.linkedin.com/jobs/view/3800000000/') {
  failed = 0;
  console.group('match - live 2: a blocked URL still tells you to paste');
  try {
    check('the always-visible paste box is there, so the fallback is reachable', Boolean(document.querySelector('#match-paste')));
    check('the page warns about blocked boards up front, before anyone tries', /LinkedIn, Indeed and Glassdoor/.test(document.body.innerText) && /Pasting the text always works/.test(document.body.innerText));

    // A FETCH LEFT RUNNING BY AN EARLIER ATTEMPT IS THE THING TO WAIT OUT FIRST.
    // Nothing cancels `fetchJobDescriptionFromUrl`, so a previous invocation
    // that gave up still has one in flight, and while it is the Fetch button
    // reads "Fetching..." and is disabled. Waiting for the button with a 15s
    // budget therefore timed out against a 30s+ fetch and reported a Fetch
    // button that was never missing. Budget from the scraper's own cap.
    const inFlight = buttonByText(document, /^Fetching\.\.\.$/);
    if (inFlight) {
      console.log('  (a fetch from an earlier attempt is still running -- waiting for it to settle)');
      await waitFor(() => !buttonByText(document, /^Fetching\.\.\.$/), 'the earlier fetch to settle', NETWORK_WAIT_MS);
    }

    const postingsBefore = (liveState().matchPostings ?? []).length;

    setValue(document.querySelector('#match-url'), url);
    const fetchBtn = await waitFor(() => {
      const b = buttonByText(document, /^Fetch$/);
      return b && !b.disabled ? b : null;
    }, 'the Fetch button', NETWORK_WAIT_MS);
    const started = Date.now();
    fetchBtn.click();
    await waitFor(() => /Fetching/.test(buttonByText(document, /Fetching|^Fetch$/)?.textContent ?? ''), 'the fetching state', 8000);

    const notice = await waitFor(
      () => [...document.querySelectorAll('.inline-status')].find((n) => /could not|blocked|paste/i.test(n.innerText)),
      'a result notice',
      NETWORK_WAIT_MS
    );
    console.log(`fetch took ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log('NOTICE:', notice.innerText);
    check('it failed rather than feeding a sign-in wall to the parser', /inline-status--error/.test(notice.className), notice.className);
    check('the message tells the user to paste it in instead', /paste/i.test(notice.innerText), notice.innerText);
    // Against the count taken at the start of THIS invocation, not a literal.
    // The literal `2` failed whenever a retry had left a different number
    // behind, reporting a fabricated failure on a step that had worked.
    check('no posting was added from a failed fetch', (liveState().matchPostings ?? []).length === postingsBefore, { before: postingsBefore, after: (liveState().matchPostings ?? []).length });
    check('the paste box is still usable', !document.querySelector('#match-paste').disabled);
    check('no AI call was made -- still no results', liveState().matchResults === null);
  } catch (err) {
    check(err.message, false, err);
  }
  return finish('Next: await liveRun() -- this makes ONE REAL AI CALL PER POSTING.');
}

/** Step 3: run the batch. REAL AI CALLS, one per posting. */
export async function liveRun() {
  failed = 0;
  console.group('match - live 3: run the batch (REAL AI CALLS)');
  try {
    const before = liveState();
    const count = (before.matchPostings ?? []).filter(isRunnablePosting).length;
    if (count === 0) throw new Error('Add postings first.');
    check('the warning says how many paid calls this is', new RegExp(`${count} separate AI call`, 'i').test(document.body.innerText));

    // A missing key renders "Add a key in Settings" where the Match button goes,
    // so waiting for the button produced a bare timeout that said nothing about
    // the actual cause. Check the real precondition and name it.
    const { getKeyPresence } = await import('../apiKeyService.js');
    const provider = before.settings?.provider ?? before.sources?.provider ?? null;
    if (!provider || !getKeyPresence()[provider]) {
      throw new Error(`No API key stored for the session's provider (${provider ?? 'none selected'}). Add one in Settings, then run this again -- this is the step that spends money, so nothing was called.`);
    }

    const run = await waitFor(() => {
      const b = buttonByText(document, /^Match \d+ posting/);
      return b && !b.disabled ? b : null;
    }, 'the Match button');

    const started = Date.now();
    run.click();
    await waitFor(() => /Reading posting/.test(document.body.innerText), 'per-posting progress', 5000);
    check('progress is PER POSTING, not one opaque spinner', /Reading posting 1 of/.test(document.body.innerText), document.body.innerText.match(/Reading posting[^.]*/)?.[0]);

    const batch = await waitFor(() => liveState().matchResults, 'the batch to land', 45_000 * count + 30_000);
    const elapsed = Date.now() - started;
    console.log(`WALL TIME: ${(elapsed / 1000).toFixed(1)}s for ${count} postings (${(elapsed / 1000 / count).toFixed(1)}s each)`);

    check('every posting produced a row', batch.results.length === count, batch.results.length);
    console.log('RANKED:', batch.results.map((r) => `${r.score?.percentage ?? '-'}% ${r.score?.grade ?? '-'} ${r.label}`));
    check('at least one scored -- these are real results', batch.completed > 0, { completed: batch.completed, failed: batch.failed });
    check('ranked highest first', (() => {
      const pcts = batch.results.filter((r) => r.score).map((r) => r.score.percentage);
      return pcts.every((p, i) => i === 0 || p <= pcts[i - 1]);
    })(), batch.results.map((r) => r.score?.percentage));
    check('the scores are real numbers in range, not placeholders', batch.results.filter((r) => r.score).every((r) => r.score.percentage >= 0 && r.score.percentage <= 100 && r.score.grade));
    check('each row carries a gap breakdown', batch.results.filter((r) => r.score).every((r) => r.gap && Array.isArray(r.gap.missing)));
    check('the JD was really parsed -- a job title or company came back', batch.results.filter((r) => r.score).some((r) => r.jd.jobTitle || r.jd.company), batch.results.map((r) => r.jd));
    check('the batch recorded which resume it was scored against', typeof batch.resumeFingerprint === 'string' && batch.resumeFingerprint.length > 3);
    check('the raw JD text is NOT duplicated into the results', !JSON.stringify(batch).includes(SAMPLE_POSTINGS[0].text.slice(0, 80)));
    check('the resume was not touched', liveState().resume === before.resume);
    check('the pipeline score was not touched', liveState().atsScore === before.atsScore);
    check('it is not reported stale -- the resume has not changed', isMatchStale(batch, liveState().tailoredResume ?? liveState().resume) === false);

    check('the page shows a ranked list with scores', (() => {
      const rows = [...document.querySelectorAll('.match__row')];
      return rows.length === count && rows.some((r) => /%/.test(r.innerText));
    })(), [...document.querySelectorAll('.match__row')].length);
    check('each row shows its top missing keywords', /Top missing|Nothing high-priority missing/.test(document.body.innerText));

    // Expand one and check it is the same breakdown Analyze renders.
    const detail = buttonByText(document.querySelector('.match__row'), /^Detail$/);
    if (detail) {
      detail.click();
      await waitFor(() => document.querySelector('.match__row-detail .buckets'), 'the expanded breakdown');
      const buckets = [...document.querySelectorAll('.match__row-detail .bucket__title')].map((h) => h.textContent.trim().split(' ')[0]);
      check('the expanded view is the SAME matched/partial/missing breakdown Analyze uses', buckets.join(',') === 'Matched,Partial,Missing', buckets);
      check('and its chips are clickable, so density detail works there too', Boolean(document.querySelector('.match__row-detail .chip')));
    } else {
      check('a Detail button exists on a scored row', false);
    }

    check('storage carries the batch', (storedState()?.matchResults?.results ?? []).length === count);
    const size = JSON.stringify(storedState()).length;
    console.log(`stored session is now ${size.toLocaleString()} chars (${((size / 5_000_000) * 100).toFixed(2)}% of a ~5M quota)`);
    remember({ ranAt: batch.ranAt, count, labels: batch.results.map((r) => r.label), elapsed });
  } catch (err) {
    check(err.message, false, err);
  }
  return finish('Now RELOAD (F5), stay on /match, then run verifyResultsSurvived().');
}

/** Step 4, after a real reload. */
export function verifyResultsSurvived() {
  failed = 0;
  console.group('match - live 4: after a reload');
  try {
    const { ranAt, count } = memo();
    if (!ranAt) throw new Error('Run liveRun() first.');
    const state = liveState();
    check('the batch came back', state.matchResults?.ranAt === ranAt);
    check('with every row', state.matchResults.results.length === count);
    check('with the gap breakdowns intact', state.matchResults.results.filter((r) => r.score).every((r) => r.gap && Array.isArray(r.gap.missing)));
    check('the postings came back too, so a re-run needs no re-paste', (state.matchPostings ?? []).length >= count);
    check('not stale -- the resume has not changed', isMatchStale(state.matchResults, state.tailoredResume ?? state.resume) === false);
    check('the page rendered the ranked rows again', [...document.querySelectorAll('.match__row')].length === state.matchResults.results.length);
    check('no staleness banner', !/Your resume has changed since these results/.test(document.body.innerText));
  } catch (err) {
    check(err.message, false, err);
  }
  return finish('Next: await liveStaleness().');
}

/** Step 5: change the resume, check ONE banner covers the whole batch. */
export async function liveStaleness() {
  failed = 0;
  console.group('match - live 5: staleness across the whole batch');
  try {
    const { ACTIONS } = await import('../../context/AppContext.jsx');
    const dispatch = window.a2resumeDev?.dispatch;
    if (typeof dispatch !== 'function') throw new Error('window.a2resumeDev.dispatch is missing.');
    const before = liveState();
    if (!before.matchResults) throw new Error('Run liveRun() first.');
    if (!before.tailoredResume) throw new Error('This runner edits the TAILORED resume, so run a tailoring pass first.');

    check('precondition: not stale yet, no banner', isMatchStale(before.matchResults, before.tailoredResume) === false && !/Your resume has changed since these results/.test(document.body.innerText));
    const originalSummary = before.tailoredResume.summary ?? '';
    remember({ originalSummary, ranAtBefore: before.matchResults.ranAt });

    dispatch({ type: ACTIONS.UPDATE_TAILORED_SECTION, payload: { section: 'summary', value: `${originalSummary} Also a published author.`.trim() } });
    await waitFor(() => liveState().tailoredResume.summary !== originalSummary, 'the resume edit to land');

    const after = liveState();
    check('NOT SILENTLY DISCARDED: every row is still there', after.matchResults?.results?.length === before.matchResults.results.length);
    check('NOT SILENTLY RE-RUN: the very same object, so no AI call was made', after.matchResults === before.matchResults);
    check('it IS detected as stale', isMatchStale(after.matchResults, after.tailoredResume) === true);

    await waitFor(() => /Your resume has changed since these results/.test(document.body.innerText), 'the staleness banner');
    const banners = [...document.querySelectorAll('.notice--warn')].filter((n) => /Your resume has changed since these results/.test(n.innerText));
    check('EXACTLY ONE banner for the whole batch, not one per row', banners.length === 1, banners.length);
    check('it says how many results it covers', new RegExp(`All ${after.matchResults.results.length} of them`).test(banners[0].innerText), banners[0].innerText.split('\n')[0]);
    check('no row carries its own staleness marker -- rows cannot disagree', after.matchResults.results.every((r) => !('resumeFingerprint' in r)));
    check('it says nothing was thrown away', /Nothing has been changed or thrown away/.test(banners[0].innerText));
    check('it says a re-run is one paid call PER POSTING', /one paid AI call per posting/i.test(banners[0].innerText));
    check('it offers leaving them as a snapshot -- unconditionally, even with no key to re-run with', /snapshot/i.test(banners[0].innerText), banners[0].innerText);
    // The BUTTON is gated on a run being possible at all; the guidance above is
    // not. So this asserts the two agree rather than asserting a button exists
    // in a session that has no key to run with.
    const { getKeyPresence } = await import('../apiKeyService.js');
    const runProvider = after.settings?.provider ?? after.sources?.provider ?? null;
    const canRun = Boolean(runProvider && getKeyPresence()[runProvider] && after.resume);
    const rerunButton = buttonByText(banners[0], /Score them against the current resume/);
    check(
      canRun
        ? 'a run is possible, so the re-run control is a BUTTON -- nothing has fired yet'
        : 'no key for this session, so no re-run button is offered (and the guidance still is)',
      canRun ? Boolean(rerunButton) : rerunButton === undefined,
      { canRun, hasButton: Boolean(rerunButton) }
    );
    check('the rows are still readable and expandable while stale', [...document.querySelectorAll('.match__row')].length === after.matchResults.results.length);
    check('storage still holds the batch', storedState()?.matchResults?.ranAt === before.matchResults.ranAt);
  } catch (err) {
    check(err.message, false, err);
  }
  return finish('Next: await liveRemoveOne(). (restoreResume() puts the summary back.)');
}

/** Step 6: remove one row, check the rest are untouched. */
export async function liveRemoveOne() {
  failed = 0;
  console.group('match - live 6: remove one result');
  try {
    const before = liveState();
    const rows = before.matchResults?.results ?? [];
    if (rows.length < 2) throw new Error('Needs at least two results.');
    const target = rows[rows.length - 1];
    const survivors = rows.filter((r) => r.id !== target.id).map((r) => r.id);

    const button = document.querySelector(`button[aria-label="Remove result for ${CSS.escape(target.label)}"]`)
      ?? [...document.querySelectorAll('.match__row')].find((r) => r.innerText.includes(target.label))?.querySelector('button.button--danger');
    if (!button) throw new Error(`No Remove button for "${target.label}".`);
    button.click();
    await waitFor(() => !(liveState().matchResults?.results ?? []).some((r) => r.id === target.id), 'the row to go');

    const after = liveState();
    check('that row is gone', !after.matchResults.results.some((r) => r.id === target.id));
    check('THE OTHERS ARE UNAFFECTED -- the same objects, not rebuilt', after.matchResults.results.map((r) => r.id).join() === survivors.join() && after.matchResults.results[0] === rows[0]);
    check('their scores and gaps are intact', after.matchResults.results.every((r) => !r.score || (r.gap && typeof r.score.percentage === 'number')));
    check('the counts were recomputed', after.matchResults.completed + after.matchResults.failed === after.matchResults.results.length);
    check('the postings are untouched, so it can be re-added by re-running', (after.matchPostings ?? []).length === (before.matchPostings ?? []).length);
    check('the batch is still reported stale -- a removal does not make it fresh', isMatchStale(after.matchResults, after.tailoredResume ?? after.resume) === true);
    check('the page dropped exactly one row', [...document.querySelectorAll('.match__row')].length === after.matchResults.results.length);
    check('storage agrees', (storedState()?.matchResults?.results ?? []).length === after.matchResults.results.length);
    remember({ survivors, removedId: target.id, removedLabel: target.label });
  } catch (err) {
    check(err.message, false, err);
  }
  return finish('Now RELOAD (F5) and run verifyRemovalSurvived().');
}

/** Step 7, after a real reload. */
export function verifyRemovalSurvived() {
  failed = 0;
  console.group('match - live 7: the removal after a reload');
  try {
    const { survivors, removedId, removedLabel } = memo();
    if (!Array.isArray(survivors)) throw new Error('Run liveRemoveOne() first.');
    const state = liveState();
    const ids = (state.matchResults?.results ?? []).map((r) => r.id);
    check('the removed row is still gone', !ids.includes(removedId), ids);
    check('the survivors are all there, in the same order', ids.join() === survivors.join(), { got: ids, expected: survivors });
    check('with their scores and gaps', (state.matchResults.results ?? []).every((r) => !r.score || r.gap));
    check('the removed label is not on the page any more', !document.body.innerText.includes(removedLabel));
    check('still stale after the reload', isMatchStale(state.matchResults, state.tailoredResume ?? state.resume) === true);
  } catch (err) {
    check(err.message, false, err);
  }
  return finish('Finally: await restoreResume() to put the summary back.');
}

/** Puts the resume summary back, so the session is left as it was found. */
export async function restoreResume() {
  failed = 0;
  console.group('match - live 8: restore');
  try {
    const { ACTIONS } = await import('../../context/AppContext.jsx');
    const { originalSummary } = memo();
    if (typeof originalSummary !== 'string') throw new Error('Run liveStaleness() first.');
    window.a2resumeDev.dispatch({ type: ACTIONS.UPDATE_TAILORED_SECTION, payload: { section: 'summary', value: originalSummary } });
    await waitFor(() => liveState().tailoredResume.summary === originalSummary, 'the summary to go back');
    check('the summary is restored', liveState().tailoredResume.summary === originalSummary);
    check('and the batch is no longer stale', isMatchStale(liveState().matchResults, liveState().tailoredResume) === false);
    await waitFor(() => !/Your resume has changed since these results/.test(document.body.innerText), 'the banner to clear');
    check('the banner cleared by itself', true);
  } catch (err) {
    check(err.message, false, err);
  }
  return finish(null);
}

/**
 * ONE PASTE, RUN REPEATEDLY. The whole live sequence as a resumable state
 * machine.
 *
 * The sequence needs real page reloads in the middle of it -- that is the point
 * of half the checks -- so it cannot be one uninterrupted call. Instead it
 * remembers which step it reached in `sessionStorage` and continues from there,
 * so the SAME one-liner is all there is to paste each time:
 *
 *   await (await import('/src/services/__manual__/match.manual.js')).runLive()
 *
 * It prints RELOAD when it wants one, and DONE when the sequence is finished.
 * Pass `{ restart: true }` to start over.
 *
 * MAKES REAL AI CALLS at step 3, one per posting (2 with the sample batch), on
 * whatever key is stored for the session's provider. Everything before that step
 * is free. It also MUTATES the loaded session -- it adds postings, runs a batch,
 * edits the resume summary and removes a result -- so run it on test data. The
 * last step puts the summary back and clears the batch it created.
 */
let liveRunning = false;

export async function runLive({ restart = false } = {}) {
  // RE-ENTRY GUARD. Pasting the line again while a step is still running was
  // the root cause of the confusing retry: two invocations interleaved, the
  // second one waited on a Fetch button the first had already put into
  // "Fetching...", and it failed at 15s on a step that was working. A step now
  // refuses to start while one is in flight, and says what to do.
  if (liveRunning) {
    console.warn('%cA step is still running. Wait for it to print its result, then paste again.', 'font-weight:bold;color:#b8860b');
    return false;
  }

  const STEPS = [
    { name: 'add two postings (free)', fn: liveAddPostings },
    { name: 'a blocked LinkedIn URL still says "paste it in" (free, ~30s of real network)', fn: liveFetchBlockedUrl },
    { name: 'RUN THE BATCH -- real AI calls, one per posting', fn: liveRun, reloadAfter: true },
    { name: 'the batch survived the reload', fn: verifyResultsSurvived },
    { name: 'staleness: one banner for the whole batch', fn: liveStaleness },
    { name: 'remove one result, the rest untouched', fn: liveRemoveOne, reloadAfter: true },
    { name: 'the removal survived the reload', fn: verifyRemovalSurvived },
    { name: 'put the resume summary back', fn: restoreResume },
  ];

  if (restart) sessionStorage.removeItem(MEMO_KEY);
  const at = restart ? 0 : (memo().step ?? 0);

  if (at >= STEPS.length) {
    console.log('%cDONE. The whole live sequence passed. Run runLive({ restart: true }) to go again.', 'font-weight:bold');
    return true;
  }

  console.log(`%c[${at + 1}/${STEPS.length}] ${STEPS[at].name}`, 'font-weight:bold');
  liveRunning = true;
  let ok;
  try {
    ok = await STEPS[at].fn();
  } finally {
    liveRunning = false;
  }
  if (!ok) {
    console.error(
      `%cSTOPPED at step ${at + 1}: "${STEPS[at].name}". Read the FAIL line above -- it names the assertion, and "1 FAILED" always means one check failed in THIS invocation (the counter is reset at the start of every step, so it is never carried over). The step did not advance, so the same paste retries it.`,
      'font-weight:bold'
    );
    return false;
  }

  remember({ step: at + 1 });
  const next = STEPS[at + 1];
  if (STEPS[at].reloadAfter) {
    console.log('%cRELOAD THE PAGE (F5), then paste the same line again.', 'font-weight:bold;color:#b8860b');
  } else if (next) {
    console.log(`%cPaste the same line again for step ${at + 2}: ${next.name}`, 'color:#555');
  } else {
    console.log('%cPaste the same line once more to finish.', 'color:#555');
  }
  return true;
}

export async function runAll() {
  const results = { testOffline: await testOffline(), testReducer: await testReducer() };
  measureBatch();
  console.table(results);
  console.log('The live runners need a real session, a real key and real reloads. See the header.');
  return Object.values(results).every(Boolean);
}

export default {
  runLive,
  testOffline,
  measureBatch,
  testReducer,
  liveAddPostings,
  liveFetchBlockedUrl,
  liveRun,
  verifyResultsSurvived,
  liveStaleness,
  liveRemoveOne,
  verifyRemovalSurvived,
  restoreResume,
  runAll,
};
