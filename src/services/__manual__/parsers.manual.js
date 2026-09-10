/**
 * Manual smoke test for resumeParser and jdParser. Not imported by the app and
 * not part of the build -- run it by hand from the browser console.
 *
 * Beyond printing the parsed output, it runs cheap fidelity checks against the
 * source text: every url present, every bullet accounted for, no dates in the
 * output that never appeared in the input. These are heuristics meant to point
 * your eye at suspicious spots -- they are not a substitute for reading the
 * output next to the source.
 */

import { parseResumeWithAI } from '../resumeParser.js';
import { parseJobDescriptionWithAI } from '../jdParser.js';
import { SUPPORTED_PROVIDERS } from '../aiService.js';
import { getApiKeys } from '../apiKeyService.js';
import {
  checkTranscriptionFidelity,
  describeFidelityWarning,
  findUnsupportedWords,
  buildSourceIndex,
} from '../../utils/transcriptionFidelity.js';

// ---------------------------------------------------------------------------
// Samples -- short but deliberately awkward: a typo, an ongoing role, an
// uncategorised skills line, bare and labelled links, a bullet containing a
// number, and a certification with a url.
// ---------------------------------------------------------------------------

export const SAMPLE_RESUME = `PRIYA RAMANATHAN
Wellington, NZ | priya.r@example.com | +64 21 555 0134
Portfolio: https://priyar.dev | github.com/priyar | linkedin.com/in/priyaramanathan

SUMMARY
Backend engineer with 6 years building payment infrastructure. Focused on reliabilty and observability.

EXPERIENCE

Kiwibank — Senior Software Engineer
Wellington, NZ | March 2022 - Present
- Led migration of the settlement pipeline from a nightly batch job to an event-driven service, cutting reconciliation lag from 14 hours to under 5 minutes.
- Introduced structured logging and distributed tracing across 11 services.
- Mentored 3 junior engineers through their first on-call rotations.

Xero — Software Engineer
Wellington, NZ | Jan 2019 - Feb 2022
- Built the invoice reminder scheduler handling 2.3M notifications per day.
- Reduced p99 latency on the reporting API from 1.8s to 340ms.

PROJECTS

ledgerlint — https://github.com/priyar/ledgerlint
A static analyser for double-entry bookkeeping code.
- Parses ledger files and flags unbalanced transactions.
- 400+ stars on GitHub.

SKILLS
Go, Python, PostgreSQL, Kafka, Terraform, AWS, gRPC

EDUCATION
Victoria University of Wellington
BSc Computer Science, 2015 - 2018

CERTIFICATIONS
AWS Certified Solutions Architect - Associate, 2023 - https://credly.com/badges/abc123`;

export const SAMPLE_JD = `Senior Backend Engineer
Sharesies — Wellington (Hybrid)

About the role
We are looking for a Senior Backend Engineer to join our Payments team. You will own critical services that move real money for over 600,000 investors.

What you will do
- Design and build event-driven services in Go.
- Partner with the Risk team to harden fraud detection.
- Improve observability across the payments platform.
- Participate in a shared on-call rotation.

Requirements
- 5+ years of backend engineering experience.
- Strong Go or Java. We use Go.
- Production experience with PostgreSQL.
- Experience with event streaming (Kafka, Kinesis, or similar) is required.

Nice to have
- Experience in fintech or a regulated industry.
- Familiarity with Terraform.
- Exposure to gRPC.

Benefits
Health insurance, 5 weeks leave, and a yearly learning budget.`;

// ---------------------------------------------------------------------------
// Fidelity checks
// ---------------------------------------------------------------------------

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s|)<>,]+|\b[a-z0-9-]+\.(?:com|dev|io|nz|org|net)\/[^\s|)<>,]+/gi;

const findUrls = (text) => [...new Set((text.match(URL_RE) || []).map((u) => u.replace(/[.,]$/, '')))];

/** Every line the source marks as a bullet. */
const findSourceBullets = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());

/** Walk any nested structure and collect every string. */
function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function checkFidelity(sourceText, parsed) {
  const haystack = collectStrings(parsed);
  const flat = norm(haystack.join('  '));

  const missingUrls = findUrls(sourceText).filter(
    (url) => !flat.includes(norm(url.replace(/^https?:\/\//, '')))
  );

  const sourceBullets = findSourceBullets(sourceText);
  const missingBullets = sourceBullets.filter((bullet) => {
    // A bullet counts as captured if a reasonably long prefix survives.
    const probe = norm(bullet).slice(0, 40);
    return !flat.includes(probe);
  });

  // Any 4-digit year in the output that never appeared in the source is a
  // strong invention signal.
  const sourceYears = new Set(sourceText.match(/\b(19|20)\d{2}\b/g) || []);
  const inventedYears = [
    ...new Set(haystack.join(' ').match(/\b(19|20)\d{2}\b/g) || []),
  ].filter((y) => !sourceYears.has(y));

  return {
    urls: `${findUrls(sourceText).length - missingUrls.length}/${findUrls(sourceText).length}`,
    missingUrls,
    bullets: `${sourceBullets.length - missingBullets.length}/${sourceBullets.length}`,
    missingBullets,
    inventedYears,
  };
}

function report(label, sourceText, result) {
  const { data, provider, model, fenced, salvaged } = result;
  console.group(`[${provider}/${model}] ${label}`);
  if (salvaged) console.warn('SALVAGE PARSE USED - output was not clean JSON. Prompt needs tightening.');
  else if (fenced) console.warn('Output arrived inside code fences - not clean JSON, but recoverable.');
  else console.log('Clean JSON.');

  const fidelity = checkFidelity(sourceText, data);
  console.log('urls captured   :', fidelity.urls, fidelity.missingUrls.length ? fidelity.missingUrls : '');
  console.log('bullets captured:', fidelity.bullets, fidelity.missingBullets.length ? fidelity.missingBullets : '');
  if (fidelity.inventedYears.length) console.error('INVENTED YEARS :', fidelity.inventedYears);

  // Word-level substitution inside a populated field -- the failure the three
  // checks above cannot see. `result.fidelityWarnings` is computed by the
  // parser itself; recomputed here when absent so this also works on a jd row.
  const warnings = result.fidelityWarnings ?? checkTranscriptionFidelity(sourceText, data);
  if (warnings.length) {
    console.error(`ALTERED CONTENT: ${warnings.length} field(s) contain words absent from the source`);
    warnings.forEach((w) => {
      console.error('  ' + describeFidelityWarning(w));
      console.error('    got:', w.text);
    });
  } else {
    console.log('altered content :  none detected');
  }

  console.log(data);
  console.groupEnd();

  return { provider, model, fenced, salvaged, ...fidelity, alteredFields: warnings.length };
}

// ---------------------------------------------------------------------------
// Offline assertions for the substitution check
//
// No provider, no key, no network -- transcriptionFidelity.js is pure. These
// exist because a safety net that has never been tested against its own worst
// case is not a safety net. Add a case here before changing the checker.
// ---------------------------------------------------------------------------

const CASES = [
  // The production failure this was written for.
  ['catches the observed substitution',
    'Work experience in the logistic and customer service industry.',
    'Work experience in the logistic and retail industry.', ['retail']],
  // Must stay silent on a faithful copy, or it trains people to ignore it.
  ['silent on a verbatim copy',
    'Work experience in the logistic and customer service industry.',
    'Work experience in the logistic and customer service industry.', []],
  ['silent on a case change',
    'Backend engineer with 6 years building payment infrastructure.',
    'BACKEND ENGINEER WITH 6 YEARS BUILDING PAYMENT INFRASTRUCTURE.', []],
  ['silent on singular/plural reflow',
    'Work in the customer service industry.',
    'Work in customer service industries.', []],
  // A "corrected" typo is an alteration -- the prompt forbids fixing spelling.
  ['catches a silently corrected typo',
    'Focused on reliabilty and observability.',
    'Focused on reliability and observability.', ['reliability']],
  // Synonym swap: the subtlest form, and the one a reader skims past.
  ['catches a synonym swap',
    'Assisted the finance team with month-end reconciliation.',
    'Supported the finance team with month-end reconciliation.', ['supported']],
  ['catches an altered metric',
    'Reduced p99 latency from 1.8s to 340ms.',
    'Reduced p99 latency from 1.8s to 240ms.', ['240ms']],
  ['catches a swapped technology',
    'Built event-driven services in Go.',
    'Built event-driven services in Java.', ['java']],
  ['leaves C++ / C# / Node.js intact',
    'Built services in Go, C++, C# and Node.js.',
    'Built services in Go, C++, C# and Node.js.', []],
];

/** @returns {boolean} true when every case passes */
export function testFidelityOffline() {
  let failed = 0;
  console.group('transcriptionFidelity - offline assertions');

  for (const [label, source, produced, expected] of CASES) {
    const got = findUnsupportedWords(produced, buildSourceIndex(source));
    const pass = JSON.stringify(got) === JSON.stringify(expected);
    if (pass) console.log('PASS', label);
    else {
      failed += 1;
      console.error('FAIL', label, '- got', got, 'expected', expected);
    }
  }

  // Malformed parses must degrade, never throw -- same contract as the
  // analysis services.
  const malformed = [null, undefined, 'string', 42, [], {}, { summary: null },
    { summary: 42 }, { experience: 'nope' }, { experience: [null] },
    { experience: [{ bullets: 'nope' }] }, { projects: [{ bullets: [null, 42] }] },
    { education: [{ details: {} }] }, { summary: '' }];
  try {
    malformed.forEach((shape) => checkTranscriptionFidelity('some source text', shape));
    console.log('PASS no throw on malformed parses');
  } catch (err) {
    failed += 1;
    console.error('FAIL malformed parse threw', err);
  }

  console.log(failed ? `${failed} FAILED` : 'all passed');
  console.groupEnd();
  return failed === 0;
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

/**
 * Parse both samples with one provider.
 * @param {'gemini'|'openai'|'deepseek'|'kimi'|'claude'} provider
 * @param {string} apiKey
 */
export async function testParsers(provider, apiKey) {
  const rows = [];

  try {
    rows.push(report('resume', SAMPLE_RESUME, await parseResumeWithAI(SAMPLE_RESUME, { provider, apiKey })));
  } catch (err) {
    console.error(`[${provider}] resume parse failed`, err);
    rows.push({ provider, label: 'resume', error: err.message, code: err.code });
  }

  try {
    rows.push(report('jd', SAMPLE_JD, await parseJobDescriptionWithAI(SAMPLE_JD, { provider, apiKey })));
  } catch (err) {
    console.error(`[${provider}] jd parse failed`, err);
    rows.push({ provider, label: 'jd', error: err.message, code: err.code });
  }

  return rows;
}

/**
 * Run both parsers across every provider that has a key.
 * @param {Partial<Record<string, string>>} [keys] Defaults to stored keys.
 */
export async function runAll(keys) {
  const source = keys || getApiKeys();
  const rows = [];

  for (const provider of SUPPORTED_PROVIDERS) {
    const apiKey = (source[provider] || '').trim();
    if (!apiKey) {
      console.warn(`[${provider}] skipped - no key`);
      continue;
    }
    rows.push(...(await testParsers(provider, apiKey)));
  }

  console.table(rows);
  return rows;
}

export default { runAll, testParsers, testFidelityOffline, SAMPLE_RESUME, SAMPLE_JD };
