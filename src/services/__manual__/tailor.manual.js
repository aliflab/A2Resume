/**
 * Manual tests for resumeTailor. Not imported by the app and not part of the
 * build.
 *
 *   const t = await import('/src/services/__manual__/tailor.manual.js');
 *
 *   t.testMerge();                        // ASSERTIONS, no key, no network
 *   await t.testLiveTailor('claude', 'KEY');  // a real pass, reports corrections
 *   await t.runAll();                     // merge assertions, then a live pass per stored key
 *
 * `testMerge` is the important one and it needs no provider: it feeds
 * mergeNonDestructiveResume deliberately NON-COMPLIANT model output -- the
 * exact things the prompt forbids -- and asserts the net catches every one.
 *
 * This is the same shape as validateSuggestions in skillInference.js and the
 * adversarial jdKeywordExclusions test: a safety net is only worth having if
 * it has been run against its own worst case. Testing it against well-formed
 * output proves nothing, because well-formed output needs no net.
 */

import { mergeNonDestructiveResume, tailorResumeWithAI, collectTargetKeywords } from '../resumeTailor.js';
import { parseResumeWithAI } from '../resumeParser.js';
import { parseJobDescriptionWithAI } from '../jdParser.js';
import { analyzeCompetencyGaps } from '../gapAnalyzer.js';
import { SUPPORTED_PROVIDERS } from '../aiService.js';
import { getApiKeys } from '../apiKeyService.js';
import { SAMPLE_RESUME, SAMPLE_JD } from './parsers.manual.js';

// ===========================================================================
// Assertion harness -- same style as analysis.manual.js
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

// ===========================================================================
// The original: a resume with everything the merge is supposed to protect --
// a current role, a past role, links at three levels, dated entries, two
// skill categories, education and a certification.
// ===========================================================================

export const ORIGINAL = {
  name: 'Priya Ramanathan',
  contact: {
    email: 'priya.r@example.com',
    phone: '+64 21 555 0134',
    location: 'Wellington, NZ',
    customLinks: [
      { label: 'Portfolio', url: 'https://priyar.dev' },
      { label: 'GitHub', url: 'https://github.com/priyar' },
      { label: 'LinkedIn', url: 'https://linkedin.com/in/priyaramanathan' },
    ],
  },
  summary: 'Backend engineer with 6 years building payment infrastructure.',
  skills: [
    { category: 'Languages', skills: ['Go', 'Python'] },
    { category: 'Infrastructure', skills: ['PostgreSQL', 'Kafka', 'Terraform', 'AWS'] },
  ],
  experience: [
    {
      company: 'Kiwibank',
      title: 'Senior Software Engineer',
      location: 'Wellington, NZ',
      startDate: 'March 2022',
      endDate: '',
      isCurrentlyWorking: true,
      bullets: [
        'Led migration of the settlement pipeline to an event-driven service, cutting reconciliation lag from 14 hours to under 5 minutes.',
        'Introduced structured logging and distributed tracing across 11 services.',
      ],
      links: [{ label: 'Kiwibank', url: 'https://kiwibank.co.nz' }],
    },
    {
      company: 'Xero',
      title: 'Software Engineer',
      location: 'Wellington, NZ',
      startDate: 'Jan 2019',
      endDate: 'Feb 2022',
      isCurrentlyWorking: false,
      bullets: ['Built the invoice reminder scheduler handling 2.3M notifications per day.'],
      links: [],
    },
  ],
  projects: [
    {
      name: 'ledgerlint',
      description: 'A static analyser for double-entry bookkeeping code.',
      bullets: ['Parses ledger files and flags unbalanced transactions.'],
      links: [{ label: 'ledgerlint', url: 'https://github.com/priyar/ledgerlint' }],
    },
  ],
  education: [
    {
      institution: 'Victoria University of Wellington',
      degree: 'BSc',
      field: 'Computer Science',
      location: 'Wellington, NZ',
      startDate: '2015',
      endDate: '2018',
      details: [],
    },
  ],
  certifications: [
    {
      name: 'AWS Certified Solutions Architect - Associate',
      issuer: 'Amazon Web Services',
      date: '2023',
      url: 'https://credly.com/badges/abc123',
    },
  ],
};

// ===========================================================================
// The adversarial "tailored" output: every rule broken at once.
// ===========================================================================

const NON_COMPLIANT = {
  name: 'Priya Ramanathan',
  contact: {
    email: 'priya.r@example.com',
    phone: '+64 21 555 0134',
    location: 'Wellington, NZ',
    customLinks: [
      // Same portfolio url, different casing and a trailing slash -- must
      // collapse to one entry, not appear twice.
      { label: 'Portfolio', url: 'HTTPS://PriyaR.dev/' },
      // GitHub and LinkedIn simply dropped.
    ],
  },
  summary: 'Backend engineer with 6 years building payment infrastructure.',
  // Skills SHRANK: Python, Terraform and AWS gone, and a perk added.
  skills: [
    { category: 'Languages', skills: ['Go'] },
    { category: 'Infrastructure', skills: ['PostgreSQL', 'Kafka'] },
    { category: 'Other', skills: ['health insurance', 'a positive attitude', 'gRPC'] },
  ],
  experience: [
    {
      company: 'Kiwibank',
      title: 'Senior Software Engineer',
      location: 'Wellington, NZ',
      startDate: 'March 2022',
      // endDate invented, and isCurrentlyWorking flipped off.
      endDate: 'Present',
      isCurrentlyWorking: false,
      bullets: [
        'Architected an event-driven settlement pipeline in Go, cutting reconciliation lag from 14 hours to under 5 minutes.',
        'Instrumented 11 services with structured logging and distributed tracing.',
      ],
      // Entry link dropped.
      links: [],
    },
    // The entire Xero role is missing.
  ],
  // The whole projects array is missing.
  education: [],
  certifications: [],
};

// ===========================================================================
// testMerge
// ===========================================================================

export function testMerge() {
  failures = [];
  console.log('\n=== mergeNonDestructiveResume vs. deliberately non-compliant output ===\n');

  const { resume, corrections } = mergeNonDestructiveResume(ORIGINAL, NON_COMPLIANT);
  const types = corrections.map((c) => c.type);

  console.log('  corrections reported:', corrections.length);
  for (const c of corrections) console.log(`    - [${c.type}] ${c.detail}`);
  console.log('');

  console.log('  a dropped experience entry is restored');
  check('two experience entries survive', resume.experience.length, 2);
  check('the dropped role is back', resume.experience[1].company, 'Xero');
  check('it is back in its original position', resume.experience.map((e) => e.company), ['Kiwibank', 'Xero']);
  checkTruthy('the restore was reported', types.includes('entry_restored'));
  check('its bullets came back intact', resume.experience[1].bullets, ORIGINAL.experience[1].bullets);

  console.log('\n  a dropped project entry is restored');
  check('the project survives', resume.projects.length, 1);
  check('with its name', resume.projects[0].name, 'ledgerlint');
  check('and its link', resume.projects[0].links[0].url, 'https://github.com/priyar/ledgerlint');

  console.log('\n  isCurrentlyWorking and dates are restored, never taken from the model');
  check('isCurrentlyWorking is back to true', resume.experience[0].isCurrentlyWorking, true);
  check('the invented endDate is discarded', resume.experience[0].endDate, '');
  check('startDate is untouched', resume.experience[0].startDate, 'March 2022');
  checkTruthy('the flag restore was reported', types.includes('isCurrentlyWorking_restored'));
  checkTruthy('the date restore was reported', types.includes('endDate_restored'));

  console.log('\n  a skills list that shrank is unioned back up');
  const allSkills = resume.skills.flatMap((g) => g.skills);
  checkTruthy('Python survived', allSkills.includes('Python'));
  checkTruthy('Terraform survived', allSkills.includes('Terraform'));
  checkTruthy('AWS survived', allSkills.includes('AWS'));
  checkTruthy('the model addition gRPC was kept', allSkills.includes('gRPC'));
  checkTruthy('the shrink was reported', types.includes('skills_shrank'));

  console.log('\n  excluded vocabulary never reaches the skills list');
  check('no benefit/trait terms survive', allSkills.filter((s) => /health insurance|positive attitude/i.test(s)), []);
  checkTruthy('the strip was reported', types.includes('excluded_skills_stripped'));

  console.log('\n  customLinks are deduplicated by lowercased url, and none are lost');
  const urls = resume.contact.customLinks.map((l) => l.url);
  check('three links, not four', urls.length, 3);
  check(
    'the case/slash variant did not create a duplicate',
    urls.filter((u) => /priyar\.dev/i.test(u)).length,
    1
  );
  checkTruthy('GitHub was restored', urls.some((u) => /github\.com\/priyar$/i.test(u)));
  checkTruthy('LinkedIn was restored', urls.some((u) => /linkedin/i.test(u)));
  checkTruthy('the link restore was reported', types.includes('links_restored'));

  console.log('\n  entry-level links are restored');
  check('the Kiwibank link is back', resume.experience[0].links[0].url, 'https://kiwibank.co.nz');

  console.log('\n  education and certifications are never taken from the model');
  check('education survives', resume.education.length, 1);
  check('certifications survive', resume.certifications.length, 1);
  check('the certification url survives', resume.certifications[0].url, 'https://credly.com/badges/abc123');

  console.log('\n  the improved bullets ARE kept -- the net protects facts, not prose');
  checkTruthy(
    'the rewritten bullet is the one that survived',
    resume.experience[0].bullets[0].startsWith('Architected')
  );

  console.log('\n  a fully compliant output produces no corrections');
  const clean = mergeNonDestructiveResume(ORIGINAL, ORIGINAL);
  check('no corrections on identical input', clean.corrections.length, 0);
  check('and nothing is lost', clean.resume.experience.length, 2);

  console.log('\n  degenerate input does not throw');
  for (const bad of [null, undefined, 'string', 42, [], { experience: 'not an array' }]) {
    try {
      const r = mergeNonDestructiveResume(ORIGINAL, bad);
      checkTruthy(`survives ${JSON.stringify(bad)} and keeps both roles`, r.resume.experience.length === 2);
    } catch (err) {
      console.error(`  FAIL  threw on ${JSON.stringify(bad)}: ${err?.message}`);
      failures.push({ label: 'degenerate input', error: err?.message });
    }
  }
  try {
    const r = mergeNonDestructiveResume(null, NON_COMPLIANT);
    checkTruthy('survives a null original', Array.isArray(r.resume.experience));
  } catch (err) {
    console.error(`  FAIL  threw on null original: ${err?.message}`);
    failures.push({ label: 'null original', error: err?.message });
  }

  console.log(`\n[merge] ${failures.length === 0 ? 'ALL ASSERTIONS PASSED' : `${failures.length} FAILURE(S)`}`);
  return { failed: failures.length, failures: [...failures] };
}

// ===========================================================================
// testLiveTailor -- a real pass, reported honestly
// ===========================================================================

/**
 * Parse the samples, analyse, then tailor. The number worth reading here is
 * `corrections.length`: it says how much the safety net actually had to do
 * against a real, compliant-intentioned model, as opposed to the hand-built
 * worst case above.
 */
export async function testLiveTailor(provider, apiKey) {
  console.log(`\n=== live tailoring pass: ${provider} ===\n`);

  const resume = (await parseResumeWithAI(SAMPLE_RESUME, { provider, apiKey })).data;
  const jd = (await parseJobDescriptionWithAI(SAMPLE_JD, { provider, apiKey })).data;
  const gap = analyzeCompetencyGaps(resume, jd);

  const targets = collectTargetKeywords(gap);
  console.log(`  targeting ${targets.missing.length} missing, ${targets.partial.length} partial keyword(s)`);

  const result = await tailorResumeWithAI(resume, jd, gap, { provider, apiKey });

  console.log(`  model              : ${result.model}`);
  console.log(`  changes logged     : ${result.changesLog.length}`);
  console.log(`  MERGE CORRECTIONS  : ${result.corrections.length}`);
  if (result.corrections.length === 0) {
    console.log('    (none -- the model complied with the additive-only rules on its own)');
  } else {
    for (const c of result.corrections) console.log(`    - [${c.type}] ${c.detail}`);
  }

  // Independent of what the model claimed, verify nothing was actually lost.
  const before = { exp: resume.experience?.length ?? 0, proj: resume.projects?.length ?? 0 };
  const after = { exp: result.resume.experience.length, proj: result.resume.projects.length };
  console.log(`  experience entries : ${before.exp} -> ${after.exp}`);
  console.log(`  project entries    : ${before.proj} -> ${after.proj}`);

  const skillsBefore = (resume.skills ?? []).flatMap((g) => g.skills ?? []).length;
  const skillsAfter = result.resume.skills.flatMap((g) => g.skills).length;
  console.log(`  skills             : ${skillsBefore} -> ${skillsAfter}`);

  console.log('\n  sample rewrites:');
  for (const change of result.changesLog.slice(0, 3)) {
    console.log(`    [${change.section}${change.target ? ` / ${change.target}` : ''}]`);
    console.log(`      before: ${change.before.slice(0, 120)}`);
    console.log(`      after : ${change.after.slice(0, 120)}`);
    console.log(`      why   : ${change.reason}`);
  }

  return result;
}

// ===========================================================================

export async function runAll(keys) {
  const merge = testMerge();

  const stored = keys ?? getApiKeys();
  const available = SUPPORTED_PROVIDERS.filter((p) => stored?.[p]);

  if (available.length === 0) {
    console.log('\nNo stored API keys -- skipping the live pass.');
    return { merge, live: [] };
  }

  const live = [];
  for (const provider of available) {
    try {
      live.push({ provider, result: await testLiveTailor(provider, stored[provider]) });
    } catch (err) {
      console.error(`  ${provider} failed: ${err?.code ?? ''} ${err?.message}`);
      live.push({ provider, error: err?.message });
    }
  }

  console.log('\n=== correction counts across providers ===');
  for (const entry of live) {
    console.log(
      `  ${entry.provider.padEnd(10)} ${entry.error ? `ERROR ${entry.error}` : `${entry.result.corrections.length} correction(s), ${entry.result.changesLog.length} change(s)`}`
    );
  }

  return { merge, live };
}

export default { testMerge, testLiveTailor, runAll, ORIGINAL };
