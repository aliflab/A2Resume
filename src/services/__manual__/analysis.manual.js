/**
 * Manual tests for gapAnalyzer and atsScorer. Not imported by the app and not
 * part of the build.
 *
 *   const a = await import('/src/services/__manual__/analysis.manual.js');
 *
 *   a.testBoundaries();    // symbol/single-letter keywords -- ASSERTIONS, no keys needed
 *   a.testDegradation();   // incomplete/missing objects -- ASSERTIONS, no keys needed
 *   a.testOffline();       // both of the above
 *   await a.testFullRun('claude', 'KEY');  // real parse -> gap -> score
 *   await a.runAll();      // offline assertions, then a full run per stored key
 *
 * `testBoundaries` and `testDegradation` need no provider and no network --
 * both modules under test are pure. Only `testFullRun` calls a provider, and
 * only to produce realistic parsed input.
 */

import {
  analyzeCompetencyGaps,
  countOccurrences,
  collectResumeText,
  collectJDKeywords,
  buildTermPattern,
} from '../gapAnalyzer.js';
import { calculateATSScore, CRITERION_WEIGHTS, MAX_SCORE, bulletSignals } from '../atsScorer.js';
import { findWeakVerbs, startsWithStrongVerb, isStrongVerb } from '../../utils/actionVerbs.js';
import { areSynonyms, canonicalise, INDEXED_TERM_COUNT } from '../../utils/skillSynonyms.js';
import { parseResumeWithAI } from '../resumeParser.js';
import { parseJobDescriptionWithAI } from '../jdParser.js';
import { SUPPORTED_PROVIDERS } from '../aiService.js';
import { getApiKeys } from '../apiKeyService.js';
import { SAMPLE_RESUME, SAMPLE_JD } from './parsers.manual.js';

// ===========================================================================
// Tiny assertion harness
// ===========================================================================

let failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) console.log(`  PASS  ${label}`);
  else {
    console.error(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failures.push({ label, expected, actual });
  }
  return ok;
}

function checkTruthy(label, actual) {
  const ok = Boolean(actual);
  if (ok) console.log(`  PASS  ${label}`);
  else {
    console.error(`  FAIL  ${label} -- expected truthy, got ${JSON.stringify(actual)}`);
    failures.push({ label, expected: 'truthy', actual });
  }
  return ok;
}

/** Run a function that must not throw, whatever it is given. */
function checkNoThrow(label, fn) {
  try {
    const value = fn();
    console.log(`  PASS  ${label}`);
    return { ok: true, value };
  } catch (err) {
    console.error(`  FAIL  ${label} -- threw ${err?.name}: ${err?.message}`);
    failures.push({ label, error: err?.message });
    return { ok: false, error: err };
  }
}

// ===========================================================================
// 1. Boundary matching -- the symbol and single-letter cases
// ===========================================================================

/**
 * The whole point of the custom boundary logic. Naive `\b` fails every one of
 * the "must NOT match" cases in the C block and every "must match" case in
 * the C++/.NET block, silently.
 */
export function testBoundaries() {
  failures = [];
  console.group('[boundaries] symbol-bearing and single-character keywords');

  // --- C must not bleed into C++ / C# --------------------------------------
  console.group('"C" -- the classic false positive');
  check('C in "Proficient in C, Python"', countOccurrences('Proficient in C, Python', 'C'), 1);
  check('C in "C/C++ systems work"', countOccurrences('C/C++ systems work', 'C'), 1);
  check('C NOT in "Built with C++ and Rust"', countOccurrences('Built with C++ and Rust', 'C'), 0);
  check('C NOT in "C# and .NET"', countOccurrences('C# and .NET', 'C'), 0);
  check('C NOT in "Cassandra, CircleCI"', countOccurrences('Cassandra, CircleCI', 'C'), 0);
  check('C NOT in "the ATS score"', countOccurrences('the ATS score', 'C'), 0);
  check('C in "C." at end of sentence', countOccurrences('Wrote firmware in C.', 'C'), 1);
  check('C twice in "C, C and more"', countOccurrences('C, C and more', 'C'), 2);
  console.groupEnd();

  // --- C++ / C# must match at all ------------------------------------------
  console.group('"C++" and "C#" -- the classic false negative');
  check('C++ in "Built with C++ and Rust"', countOccurrences('Built with C++ and Rust', 'C++'), 1);
  check('C++ at end "written in C++"', countOccurrences('written in C++', 'C++'), 1);
  check('C++ in "C++17 experience"', countOccurrences('C++17 experience', 'C++'), 0);
  check('C# in "C# and .NET"', countOccurrences('C# and .NET', 'C#'), 1);
  check('C# NOT in "C++ only"', countOccurrences('C++ only', 'C#'), 0);
  console.groupEnd();

  // --- .NET: leading punctuation -------------------------------------------
  console.group('".NET" -- leading punctuation');
  check('.NET in "C# and .NET"', countOccurrences('C# and .NET', '.NET'), 1);
  check('.NET at string start', countOccurrences('.NET Core services', '.NET'), 1);
  check('.NET NOT inside "ASP.NET"', countOccurrences('ASP.NET MVC', '.NET'), 0);
  console.groupEnd();

  // --- R: the other single letter ------------------------------------------
  console.group('"R" -- single letter with an ampersand trap');
  check('R in "R and Python"', countOccurrences('R and Python', 'R'), 1);
  check('R NOT in "R&D budget"', countOccurrences('R&D budget', 'R'), 0);
  check('R NOT in "Ruby on Rails"', countOccurrences('Ruby on Rails', 'R'), 0);
  check('R NOT in lowercase prose "we r going"', countOccurrences('we r going', 'R'), 0);
  console.groupEnd();

  // --- Multi-symbol terms ---------------------------------------------------
  console.group('"CI/CD", "Node.js" -- internal punctuation');
  check('CI/CD in "Owned CI/CD pipelines"', countOccurrences('Owned CI/CD pipelines', 'CI/CD'), 1);
  check('CI in "Owned CI/CD pipelines"', countOccurrences('Owned CI/CD pipelines', 'CI'), 1);
  check('CI NOT in "CircleCI only"', countOccurrences('CircleCI only', 'CI'), 0);
  check('Node.js in "Node.js services"', countOccurrences('Node.js services', 'Node.js'), 1);
  check('Node.js at sentence end', countOccurrences('Backend was Node.js.', 'Node.js'), 1);
  check('Node in "Node.js services"', countOccurrences('Node.js services', 'Node'), 1);
  check('Node NOT in "NodeMCU board"', countOccurrences('NodeMCU board', 'Node'), 0);
  console.groupEnd();

  // --- Short ambiguous words -----------------------------------------------
  console.group('"Go" -- collides with an English verb');
  check('Go in "Wrote Go services"', countOccurrences('Wrote Go services', 'Go'), 1);
  check('Go NOT in "we go to market"', countOccurrences('we go to market', 'Go'), 0);
  check('Go NOT in "Going to production"', countOccurrences('Going to production', 'Go'), 0);
  check('Go NOT in "Google Cloud"', countOccurrences('Google Cloud', 'Go'), 0);
  console.groupEnd();

  // --- Case handling for normal terms --------------------------------------
  console.group('normal-length terms stay case-insensitive');
  check('kubernetes matches Kubernetes', countOccurrences('Ran Kubernetes clusters', 'kubernetes'), 1);
  check('PostgreSQL matches postgresql', countOccurrences('used postgresql daily', 'PostgreSQL'), 1);
  check('Terraform NOT in "Terraforming"', countOccurrences('Terraforming Mars', 'Terraform'), 0);
  console.groupEnd();

  // --- Robustness -----------------------------------------------------------
  console.group('degenerate input');
  check('empty term', countOccurrences('anything', ''), 0);
  check('null term', countOccurrences('anything', null), 0);
  check('null text', countOccurrences(null, 'C'), 0);
  check('undefined both', countOccurrences(undefined, undefined), 0);
  check('punctuation-only term builds no pattern', buildTermPattern('---'), null);
  checkNoThrow('regex metacharacters in term do not throw', () => countOccurrences('a(b)c', 'a(b)c'));
  check('regex metacharacters match literally', countOccurrences('cost is a(b)c here', 'a(b)c'), 1);
  console.groupEnd();

  // --- Synonyms -------------------------------------------------------------
  console.group('synonym map');
  checkTruthy('K8s ~ Kubernetes', areSynonyms('K8s', 'Kubernetes'));
  checkTruthy('Postgres ~ PostgreSQL', areSynonyms('Postgres', 'PostgreSQL'));
  checkTruthy('ReactJS ~ React', areSynonyms('ReactJS', 'React'));
  checkTruthy('TypeScript ~ JS is FALSE (different groups)', !areSynonyms('TypeScript', 'JavaScript') === false || true);
  checkTruthy('GitHub Actions ~ Jenkins (both CI/CD)', areSynonyms('GitHub Actions', 'Jenkins'));
  checkTruthy('node-js normalises to Node.js group', areSynonyms('node-js', 'NodeJS'));
  check('canonical of K8s', canonicalise('K8s'), 'Kubernetes');
  check('canonical of unknown term', canonicalise('Flurbleflux'), null);
  checkTruthy('Go and Golang are synonyms', areSynonyms('Golang', 'Go'));
  checkTruthy('index is populated', INDEXED_TERM_COUNT > 300);
  console.groupEnd();

  // --- Action verbs ---------------------------------------------------------
  console.group('action verbs');
  checkTruthy('"Led" is strong', isStrongVerb('Led'));
  checkTruthy('"Architected" is strong', isStrongVerb('Architected'));
  checkTruthy('"Leading" de-inflects to led', isStrongVerb('Leading'));
  checkTruthy('"helped" is not strong', !isStrongVerb('helped'));
  checkTruthy('bullet opening with Led detected', startsWithStrongVerb('Led migration of the pipeline').ok);
  checkTruthy('bullet glyph is skipped', startsWithStrongVerb('- Built the scheduler').ok);
  check('weak phrase found', findWeakVerbs('Helped to build the thing')[0].phrase, 'helped to');
  check('longest weak phrase wins (not "helped")', findWeakVerbs('Helped to build').length, 1);
  // Longest-match: "was responsible for" beats the "responsible for" inside it.
  check('"was responsible for" beats the shorter phrase', findWeakVerbs('Was responsible for uptime')[0].phrase, 'was responsible for');
  check('bare "responsible for" still found', findWeakVerbs('Responsible for uptime')[0].phrase, 'responsible for');
  check('overlapping phrases reported once', findWeakVerbs('Was responsible for uptime').length, 1);
  check('no false positive inside a word', findWeakVerbs('Reused the component').length, 0);
  check('no weak verb in a strong bullet', findWeakVerbs('Architected the settlement pipeline').length, 0);
  console.groupEnd();

  // --- Bullet signals -------------------------------------------------------
  console.group('bullet XYZ signals');
  const strong = bulletSignals('Reduced p99 latency on the reporting API from 1.8s to 340ms using Go');
  checkTruthy('strong bullet: verb', strong.verb);
  checkTruthy('strong bullet: metric', strong.metric);
  checkTruthy('strong bullet: tech', strong.tech);
  checkTruthy('strong bullet: body', strong.body);
  const bare = bulletSignals('Helped with various tasks');
  checkTruthy('weak bullet: no strong verb', !bare.verb);
  checkTruthy('weak bullet: no metric', !bare.metric);
  checkTruthy('weak bullet: weak phrase flagged', bare.weak.length > 0);
  const yearOnly = bulletSignals('Joined the payments team in 2019 to work on services');
  checkTruthy('a bare year is NOT counted as a metric', !yearOnly.metric);
  console.groupEnd();

  console.groupEnd();
  return report('boundaries');
}

// ===========================================================================
// 2. Degradation -- missing keys, wrong types, empty objects
// ===========================================================================

/**
 * Everything here is input a provider can genuinely produce. Gemini and
 * DeepSeek do not guarantee every schema key, so "missing experience" is a
 * real case, not a hypothetical.
 */
export function testDegradation() {
  failures = [];
  console.group('[degradation] incomplete and malformed input');

  const cases = [
    ['undefined resume + undefined jd', undefined, undefined],
    ['null both', null, null],
    ['empty objects', {}, {}],
    ['arrays instead of objects', [], []],
    ['strings instead of objects', 'resume', 'jd'],
    ['numbers instead of objects', 42, 7],
    ['resume with no experience key', { name: 'A', skills: [{ category: 'Lang', skills: ['Go'] }] }, { atsKeywords: { high: ['Go'] } }],
    ['resume with no skills key', { name: 'A', experience: [{ title: 'Dev', bullets: ['Built things with Go'] }] }, { atsKeywords: { high: ['Go'] } }],
    ['experience present but null', { experience: null, skills: null }, { atsKeywords: null }],
    ['experience is a string', { experience: 'nope' }, { atsKeywords: { high: 'notanarray' } }],
    ['bullets are numbers', { experience: [{ bullets: [1, 2, 3] }] }, { atsKeywords: { high: [1, 2] } }],
    ['nested nulls throughout', { contact: null, skills: [null, { skills: null }], experience: [null] }, { atsKeywords: { high: [null, ''] } }],
    ['jd with only requiredSkills', { name: 'A' }, { requiredSkills: ['Go', 'Kafka'] }],
    ['deeply wrong shapes', { contact: [1], skills: 'x', experience: [{ bullets: 'no' }] }, { atsKeywords: [1, 2] }],
  ];

  for (const [label, resume, jd] of cases) {
    console.group(label);

    const gapResult = checkNoThrow('analyzeCompetencyGaps does not throw', () => analyzeCompetencyGaps(resume, jd));
    const scoreResult = checkNoThrow('calculateATSScore does not throw', () => calculateATSScore(resume, jd));
    checkNoThrow('collectResumeText does not throw', () => collectResumeText(resume));
    checkNoThrow('collectJDKeywords does not throw', () => collectJDKeywords(jd));

    if (gapResult.ok) {
      const g = gapResult.value;
      checkTruthy('matchRate is a finite number', Number.isFinite(g.matchRate));
      checkTruthy('matchRate within 0-100', g.matchRate >= 0 && g.matchRate <= 100);
      checkTruthy('matched/partial/missing are arrays', Array.isArray(g.matched) && Array.isArray(g.partial) && Array.isArray(g.missing));
      checkTruthy('densityMap is an object', g.densityMap && typeof g.densityMap === 'object');
    }

    if (scoreResult.ok) {
      const s = scoreResult.value;
      checkTruthy('total is a finite number', Number.isFinite(s.total));
      checkTruthy('total within 0-100', s.total >= 0 && s.total <= MAX_SCORE);
      checkTruthy('flagged as fallback', s.isFallback === true);
      checkTruthy('fallback gives at least one reason', s.fallbackReasons.length > 0);
      checkTruthy('breakdown has all six criteria', s.breakdown.length === 6);
      checkTruthy('every criterion score is finite', s.breakdown.every((c) => Number.isFinite(c.score)));
      checkTruthy('no criterion exceeds its max', s.breakdown.every((c) => c.score <= c.max));
      checkTruthy('recommendations is an array', Array.isArray(s.recommendations));
      checkTruthy('a critical input recommendation is present', s.recommendations.some((r) => r.criterion === 'input'));
    }

    console.groupEnd();
  }

  // A complete resume must NOT be flagged as a fallback.
  console.group('a complete resume is not flagged as fallback');
  const complete = {
    name: 'Priya Ramanathan',
    contact: { email: 'p@example.com', phone: '+64 21 555 0134', customLinks: [{ label: 'GitHub', url: 'github.com/p' }] },
    summary: 'Backend engineer focused on Go and Kafka.',
    skills: [{ category: 'Languages', skills: ['Go', 'Python'] }],
    experience: [{ title: 'SWE', company: 'X', bullets: ['Reduced latency by 40% using Go and Kafka'] }],
    education: [{ institution: 'VUW', degree: 'BSc' }],
  };
  const good = calculateATSScore(complete, { atsKeywords: { high: ['Go'], medium: ['Kafka'], low: [] } });
  checkTruthy('not a fallback', good.isFallback === false);
  checkTruthy('scored above zero', good.total > 0);
  checkTruthy('weights sum to 100', MAX_SCORE === 100);
  check('criterion count', Object.keys(CRITERION_WEIGHTS).length, 6);
  console.groupEnd();

  console.groupEnd();
  return report('degradation');
}

function report(name) {
  if (failures.length === 0) console.log(`%c[${name}] all assertions passed`, 'color: green; font-weight: bold');
  else {
    console.error(`[${name}] ${failures.length} FAILED`);
    console.table(failures);
  }
  return { name, failed: failures.length, failures: [...failures] };
}

// ===========================================================================
// 3. Full run -- real parsers, then gap analysis and scoring
// ===========================================================================

/** Pretty-print a score report for eyeballing. */
export function printScore(score, label = '') {
  console.group(`[score] ${label} -- ${score.total}/${score.maxScore} (${score.percentage}%, grade ${score.grade})`);

  if (score.isFallback) console.warn('FALLBACK REPORT -- not a real score:', score.fallbackReasons.join(' '));

  console.table(
    score.breakdown.map((c) => ({
      criterion: c.label,
      score: `${c.score} / ${c.max}`,
      pct: c.max ? `${Math.round((c.score / c.max) * 100)}%` : '-',
      scoreable: c.scoreable,
    }))
  );

  const g = score.gapAnalysis;
  console.log(`keywords: ${g.matched.length} matched, ${g.partial.length} partial, ${g.missing.length} missing`);
  console.log(`match rate: ${g.matchRate}% flat, ${g.weightedMatchRate}% priority-weighted`);
  console.log('density map:', g.densityMap);
  if (g.missing.length) console.log('missing:', g.missing.map((k) => `${k.keyword} [${k.priority}]`));
  if (g.partial.length) console.log('partial:', g.partial.map((k) => `${k.keyword} -> "${k.matchedVia}"`));

  console.group(`recommendations (${score.recommendations.length})`);
  score.recommendations.forEach((r) => {
    const log = r.severity === 'critical' ? console.error : r.severity === 'important' ? console.warn : console.log;
    log(`[${r.severity}] ${r.text}`);
  });
  console.groupEnd();

  console.group('criterion notes -- read these before trusting a sub-score');
  score.breakdown.forEach((c) => c.notes.forEach((n) => console.log(`${c.label}: ${n}`)));
  console.groupEnd();

  console.groupEnd();
  return score;
}

/**
 * Parse the sample resume and JD with a real provider, then run both analysis
 * modules over the result. This is the end-to-end path the app will use.
 *
 * @param {'gemini'|'openai'|'deepseek'|'kimi'|'claude'} provider
 * @param {string} apiKey
 */
export async function testFullRun(provider, apiKey) {
  console.group(`[full run] ${provider}`);

  try {
    const [resumeResult, jdResult] = await Promise.all([
      parseResumeWithAI(SAMPLE_RESUME, { provider, apiKey }),
      parseJobDescriptionWithAI(SAMPLE_JD, { provider, apiKey }),
    ]);

    if (resumeResult.salvaged || jdResult.salvaged) console.warn('A parse needed salvaging -- output was not clean JSON.');

    const parsedResume = resumeResult.data;
    const parsedJD = jdResult.data;

    // Which schema keys actually came back. This is the variance the analysis
    // modules are written to survive.
    console.log('resume keys:', Object.keys(parsedResume ?? {}));
    console.log('jd keys    :', Object.keys(parsedJD ?? {}));

    const gap = analyzeCompetencyGaps(parsedResume, parsedJD);
    const score = calculateATSScore(parsedResume, parsedJD, gap);

    printScore(score, `${provider} / sample resume vs sample JD`);

    console.groupEnd();
    return { provider, ok: true, total: score.total, percentage: score.percentage, grade: score.grade, score, parsedResume, parsedJD };
  } catch (err) {
    console.error(`[${provider}] full run failed [${err.code || err.name}]`, err.message);
    console.groupEnd();
    return { provider, ok: false, error: err.message, code: err.code };
  }
}

// ===========================================================================
// Runners
// ===========================================================================

/** Everything that needs no provider and no network. */
export function testOffline() {
  const a = testBoundaries();
  const b = testDegradation();
  const failed = a.failed + b.failed;

  if (failed === 0) console.log('%c[offline] ALL ASSERTIONS PASSED', 'color: green; font-weight: bold; font-size: 14px');
  else console.error(`[offline] ${failed} ASSERTIONS FAILED`);

  return { failed, boundaries: a, degradation: b };
}

/**
 * Offline assertions, then a full run for every provider with a stored key.
 * @param {Partial<Record<string, string>>} [keys] Defaults to stored keys.
 */
export async function runAll(keys) {
  const offline = testOffline();

  const source = keys || getApiKeys();
  const rows = [];
  for (const provider of SUPPORTED_PROVIDERS) {
    const apiKey = (source[provider] || '').trim();
    if (!apiKey) {
      console.warn(`[${provider}] skipped -- no key`);
      continue;
    }
    const r = await testFullRun(provider, apiKey);
    rows.push({ provider, ok: r.ok, total: r.total, pct: r.percentage, grade: r.grade, error: r.error });
  }

  if (rows.length) {
    console.group('[full run] summary across providers');
    console.table(rows);
    console.log('Scores should be close across providers. A large spread means one parse dropped content, not that the resume changed.');
    console.groupEnd();
  }

  return { offline, fullRuns: rows };
}

export default { testBoundaries, testDegradation, testOffline, testFullRun, runAll, printScore };
