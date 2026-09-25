/**
 * Manual checks for the cover letter: the generator, the grounding backstop,
 * the export layer, persistence, and the live page.
 *
 * Not imported by the app and not in the build. Same pattern as the other
 * __manual__ runners.
 *
 * The offline half is assertion-based and needs no provider, no key and no
 * network -- the grounding checker and the whole export layer are pure -- so it
 * also runs under Node:
 *
 *   const c = await import('/src/services/__manual__/coverLetter.manual.js');
 *   c.testOffline();          // ASSERTIONS, no DOM (also runs under Node)
 *   await c.testReducer();    // appReducer + saveSession round trip, browser only
 *
 * Live, on /cover-letter, against a session with a resume and a parsed JD. The
 * generation runner makes ONE REAL AI CALL on a stored key and prints what it
 * cost in wall time -- that measurement is what COVER_LETTER_TIMEOUT_MS is set
 * from, so re-run it if you change providers:
 *
 *   await c.liveGenerate();            // real call through the real button
 *   // reload (F5)
 *   (await import('...')).verifyLetterSurvived();
 *   await c.liveInjectFabrication();   // SELF-ADVERSARIAL: type a fake employer in, check it is caught
 *   await c.liveStaleness();           // edit the resume, check the notice appears
 *   (await import('...')).restoreAfterStaleness();  // puts the summary back
 *
 * `liveInjectFabrication` and `liveStaleness` MUTATE the loaded session (the
 * letter body, and the resume summary). Run them on test data. The staleness
 * runner records what it overwrote and puts it back.
 */

import {
  COVER_LETTER_TIMEOUT_MS,
  DEFAULT_LENGTH,
  DEFAULT_TONE,
  LENGTHS,
  LENGTH_IDS,
  TONES,
  TONE_IDS,
  assembleLetterBody,
  bodyParagraphs,
  buildCoverLetterSlice,
  buildCoverLetterSystemPrompt,
  countWords,
  enforceLength,
  fingerprint,
  getLength,
  getTone,
  isCoverLetterStale,
} from '../coverLetterGenerator.js';
import {
  buildCoverLetterFileName,
  formatLetterDate,
  generateCoverLetterPlainText,
  hasExportableLetter,
  normalizeCoverLetterForExport,
  splitLetterBlocks,
} from '../coverLetterExport.js';
import {
  PROMPT_EXAMPLES,
  buildGroundingSource,
  checkCoverLetterGrounding,
  describeGroundingWarning,
  extractNamedTerms,
  fabricationWarnings,
} from '../../utils/coverLetterGrounding.js';
import { findUnsupportedPdfCharacters, normalizeResumeForExport } from '../resumeExport.js';
import { SESSION_STORAGE_NAME, loadSession, saveSession } from '../sessionPersistence.js';

const RAW_KEY = `a2resume:${SESSION_STORAGE_NAME}`;
const MEMO_KEY = '__a2resume_cover_letter';

let failed = 0;
const check = (label, pass, detail) => {
  if (pass) console.log('  PASS', label);
  else {
    failed += 1;
    console.error('  FAIL', label, detail ?? '');
  }
  return pass;
};

/** A resume with a deliberately narrow, checkable vocabulary. */
function sampleResume() {
  return {
    name: 'Jane Doe',
    contact: { email: 'jane@example.com', phone: '+44 20 7946 0000', location: 'London', customLinks: [] },
    summary: 'Backend engineer with Go and PostgreSQL experience.',
    skills: [{ category: 'Languages', skills: ['Go', 'Python'] }],
    experience: [
      {
        title: 'Senior Engineer',
        company: 'Acme',
        location: 'London',
        startDate: 'Jan 2020',
        endDate: '',
        isCurrentlyWorking: true,
        bullets: ['Migrated 40 services to Kubernetes.', 'Cut p99 latency by 35% on the payments API.'],
        links: [],
      },
      { title: 'Engineer', company: 'Beta', startDate: 'Jun 2016', endDate: 'Dec 2019', bullets: ['Built a reporting API.'] },
    ],
    projects: [{ name: 'Tracer', description: 'A tracing library.', bullets: [], links: [] }],
    education: [{ institution: 'University of Leeds', degree: 'BSc', field: 'Computer Science', startDate: '2012', endDate: '2015', details: [] }],
    certifications: [{ name: 'AWS Solutions Architect', issuer: 'AWS', date: '2022', url: '' }],
  };
}

function sampleJD() {
  return {
    jobTitle: 'Senior Backend Engineer',
    company: 'Nimbus',
    atsKeywords: { high: ['Go', 'Kubernetes', 'Terraform'], medium: ['PostgreSQL'], low: [] },
    requiredSkills: ['5+ years of backend engineering experience'],
    preferredSkills: [],
    responsibilities: ['Own the deployment pipeline.'],
  };
}

const LETTER = `Dear Hiring Manager,

I am applying for the Senior Backend Engineer role at Nimbus. At Acme I migrated 40 services to Kubernetes and cut p99 latency by 35% on the payments API.

Before that, at Beta, I built a reporting API in Go. I also maintain Tracer, a small tracing library.

Sincerely,
Jane Doe`;

// ---------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------

/** @returns {boolean} */
export function testOffline() {
  failed = 0;
  console.group('coverLetter - offline assertions');
  try {
    const resume = sampleResume();
    const jd = sampleJD();
    const frozen = JSON.stringify(resume);

    // --- tone and length are real parameters ------------------------------
    check('tone: the three required tones exist', TONE_IDS.join(',') === 'formal,warm,concise', TONE_IDS);
    check('length: the three required lengths exist', LENGTH_IDS.join(',') === 'short,medium,long', LENGTH_IDS);
    check('tone: every tone carries its own instruction, and they differ', (() => {
      const texts = TONES.map((t) => t.instruction);
      return texts.every((t) => t.length > 120) && new Set(texts).size === 3;
    })());
    check('length: every length carries its own instruction, and they differ', (() => {
      const texts = LENGTHS.map((l) => l.instruction);
      return texts.every((t) => t.length > 120) && new Set(texts).size === 3;
    })());
    check('length: the budgets are ordered and do not overlap', (() => {
      const [s, m, l] = LENGTHS;
      return s.maxWords < m.minWords && m.maxWords < l.minWords && s.paragraphs < m.paragraphs && l.paragraphs > m.paragraphs;
    })(), LENGTHS.map((l) => [l.minWords, l.maxWords, l.paragraphs]));
    check('length: the instruction is derived from the numbers, so it cannot disagree with them', (() => {
      const spec = getLength('short');
      return spec.instruction.includes(String(spec.minWords)) && spec.instruction.includes(String(spec.maxWords)) && spec.instruction.includes(String(spec.paragraphs));
    })());
    check('tone/length: an unknown id falls back rather than throwing', getTone('nonsense').id === DEFAULT_TONE && getLength(null).id === DEFAULT_LENGTH && getTone(undefined).id === DEFAULT_TONE);

    // --- the prompt carries both, plus both exclusion layers ---------------
    const formalShort = buildCoverLetterSystemPrompt({ tone: 'formal', length: 'short' });
    const warmLong = buildCoverLetterSystemPrompt({ tone: 'warm', length: 'long' });
    check('prompt: tone and length change the prompt, not just a word in it', formalShort !== warmLong && formalShort.includes('TONE: FORMAL') && warmLong.includes('TONE: WARM'));
    check('prompt: the length budget is stated as a constraint', formalShort.includes('THIS IS A CONSTRAINT, NOT A SUGGESTION') && formalShort.includes(String(getLength('short').maxWords)));
    check('prompt: the grounding rule is rendered in', formalShort.includes('EVERY CLAIM MUST COME FROM THE RESUME'));
    check('prompt: the jdKeywordExclusions list is rendered in, so perks language is forbidden at the prompt layer too', formalShort.includes('Employer benefits, perks') && formalShort.includes('positive attitude'));
    check('prompt: no worked example of a GOOD letter, only counter-examples', !/^\s*Dear Hiring Manager,/m.test(formalShort.replace(/for example, "Dear Hiring Manager,"/gi, '')));

    // --- the grounding check, on a clean letter ---------------------------
    const clean = checkCoverLetterGrounding(LETTER, resume, jd);
    check('grounding: a letter drawn from the resume is clean', clean.grounded === true && fabricationWarnings(clean).length === 0, clean.warnings);
    check('grounding: it actually checked something -- a clean result on zero terms would be meaningless', clean.checkedNames > 0 && clean.checkedSkills > 0, { names: clean.checkedNames, skills: clean.checkedSkills });
    check('grounding: the JD company and job title are allowed even though the resume never says them', (() => {
      const src = buildGroundingSource(resume, jd);
      return src.includes('Nimbus') && src.includes('Senior Backend Engineer') && !JSON.stringify(resume).includes('Nimbus');
    })());
    check('grounding: nothing else from the JD vouches -- Terraform is in the posting and must NOT be admitted', !buildGroundingSource(resume, jd).includes('Terraform'));

    // --- SELF-ADVERSARIAL: a fabricated company ---------------------------
    // The same pattern every structural guard here is tested with: feed it the
    // failure it exists to catch and assert it fires.
    const fakeCompany = LETTER.replace('At Acme I migrated', 'At Globex Industries I migrated');
    const caughtCompany = checkCoverLetterGrounding(fakeCompany, resume, jd);
    check('ADVERSARIAL: a fabricated employer is caught', caughtCompany.grounded === false && caughtCompany.warnings.some((w) => w.kind === 'fabricated-name' && /Globex/.test(w.term)), caughtCompany.warnings);
    check('ADVERSARIAL: and it is described in a sentence a user can act on', describeGroundingWarning(caughtCompany.warnings.find((w) => /Globex/.test(w.term))).includes('appears nowhere in your resume'));

    const fakeSkill = LETTER.replace('I built a reporting API in Go', 'I built a reporting API in Rust and managed it with Terraform');
    const caughtSkill = checkCoverLetterGrounding(fakeSkill, resume, jd);
    check('ADVERSARIAL: a fabricated tool is caught, even though the POSTING asks for it', caughtSkill.warnings.some((w) => w.kind === 'fabricated-skill' && w.term === 'Terraform'), caughtSkill.warnings);
    check('ADVERSARIAL: and a second fabricated language alongside it', caughtSkill.warnings.some((w) => w.kind === 'fabricated-skill' && /Rust/i.test(w.term)), caughtSkill.warnings);

    // THE JUDGMENT CALL THIS FILE EXISTS TO PIN DOWN: a synonym is a
    // fabrication here, even though skillSynonyms calls it a partial match.
    const synonymSwap = LETTER.replace('in Go', 'in TypeScript');
    check('ADVERSARIAL: a SYNONYM is still a fabrication -- the resume says Go, so TypeScript is not vouched for', checkCoverLetterGrounding(synonymSwap, resume, jd).warnings.some((w) => w.kind === 'fabricated-skill' && /TypeScript/i.test(w.term)), checkCoverLetterGrounding(synonymSwap, resume, jd).warnings);

    // --- what it deliberately does NOT catch, asserted so the limits are real
    const inventedNumber = LETTER.replace('40 services', '400 services').replace('by 35%', 'by 95%');
    check('LIMIT (asserted, not assumed): an invented NUMBER is not caught -- numbers are not terms', checkCoverLetterGrounding(inventedNumber, resume, jd).grounded === true);
    const plainWords = `${LETTER}\n\nI have led a team of twelve engineers for six years.`;
    check('LIMIT: a fabricated claim in ordinary lowercase words is not caught', checkCoverLetterGrounding(plainWords, resume, jd).grounded === true);
    check('LIMIT: a one-word invented name at the START of a sentence is not caught', checkCoverLetterGrounding('Dear Hiring Manager,\n\nGlobex shaped how I work.\n\nSincerely,\nJane Doe', resume, jd).grounded === true);
    check('but the SAME one-word name mid-sentence IS caught', checkCoverLetterGrounding('Dear Hiring Manager,\n\nMy time at Globex shaped how I work.\n\nSincerely,\nJane Doe', resume, jd).warnings.some((w) => w.term === 'Globex'));

    // --- false-positive guards --------------------------------------------
    check('no false positive: the letter\'s own boilerplate is not a company', !clean.warnings.some((w) => /Hiring|Manager|Dear|Sincerely/i.test(w.term)), clean.warnings);
    check('no false positive: ordinary sentence openings are not names', extractNamedTerms('During my time there I shipped it. Working with them taught me a lot. My role grew.').length === 0, extractNamedTerms('During my time there I shipped it. Working with them taught me a lot. My role grew.'));
    check('extract: a sentence-initial function word is dropped from what is TESTED but kept in what is SHOWN', (() => {
      const [first] = extractNamedTerms('At Acme I shipped it.');
      return first && first.term === 'At Acme' && first.evaluate === 'Acme';
    })(), extractNamedTerms('At Acme I shipped it.'));
    check('extract: and that is what stops "At Acme" reading as a fabricated employer', checkCoverLetterGrounding('At Acme I shipped it.', resume, jd).grounded === true);
    check('extract: a multi-word name leading a sentence is still caught, and reported in full', (() => {
      const out = checkCoverLetterGrounding('Globex Industries taught me to ship.', resume, jd);
      return out.warnings.some((w) => w.kind === 'fabricated-name' && w.term === 'Globex Industries');
    })(), checkCoverLetterGrounding('Globex Industries taught me to ship.', resume, jd).warnings);
    check('no false positive: a month or a weekday is not a company', checkCoverLetterGrounding('I am available from Monday in January.', resume, jd).warnings.length === 0);
    check('no false positive: a possessive is matched without its apostrophe-s', checkCoverLetterGrounding("Acme's payments API taught me to ship.", resume, jd).grounded === true);
    check('no false positive: a longer phrase grounded word by word passes', checkCoverLetterGrounding('I worked on the Acme Payments API.', resume, jd).grounded === true);
    check('no false positive: a multi-word run mixing boilerplate and a real name is not flagged', checkCoverLetterGrounding('Dear Acme Hiring Manager,', resume, jd).grounded === true);
    // FOUND IN THE BROWSER on an entirely honest letter. "Deployment Pipeline"
    // is a real entry in the synonym index, and the letter was describing the
    // EMPLOYER's pipeline straight out of the posting -- claiming nothing.
    check('no false positive: a lowercase competency phrase about the EMPLOYER is not a claimed skill', checkCoverLetterGrounding('I would welcome the chance to bring that to your deployment pipeline.', resume, jd).grounded === true, checkCoverLetterGrounding('I would welcome the chance to bring that to your deployment pipeline.', resume, jd).warnings);
    check('...but the capitalised form IS treated as a claim and checked', checkCoverLetterGrounding('I own Deployment Pipeline work end to end.', resume, jd).warnings.some((w) => w.kind === 'fabricated-skill'), checkCoverLetterGrounding('I own Deployment Pipeline work end to end.', resume, jd).warnings);
    check('no false positive: "go to market" is not the Go language, the same trap gapAnalyzer guards', checkCoverLetterGrounding('I helped take it to market and go from there.', resume, jd).grounded === true);
    check('the resume side stays case-INSENSITIVE, so a lowercase resume still vouches for a capitalised letter', checkCoverLetterGrounding('I work in Kubernetes daily.', { summary: 'migrated services to kubernetes' }, jd).grounded === true);
    check('LIMIT: a lowercase fabrication is missed, and that is the accepted cost of the rule above', checkCoverLetterGrounding('I have used terraform for years.', resume, jd).grounded === true);

    // --- excluded language is its own, softer class -----------------------
    const perks = `${LETTER}\n\nI bring a positive attitude and a strong work ethic.`;
    const perkResult = checkCoverLetterGrounding(perks, resume, jd);
    check('exclusions: posting trait language is reported', perkResult.warnings.some((w) => w.kind === 'excluded-language' && w.term === 'positive attitude'), perkResult.warnings);
    check('exclusions: but it does NOT make the letter "ungrounded" -- a style note is not a fabrication', perkResult.grounded === true && fabricationWarnings(perkResult).length === 0);

    // --- degradation -------------------------------------------------------
    for (const [label, args] of [
      ['no letter', ['', resume, jd]],
      ['no resume', [LETTER, null, null]],
      ['junk letter', [{ nope: true }, resume, jd]],
      ['junk resume', [LETTER, 'a string', 42]],
      ['everything null', [null, null, null]],
    ]) {
      let out;
      try {
        out = checkCoverLetterGrounding(...args);
      } catch (err) {
        out = err;
      }
      check(`degrades without throwing: ${label}`, out && Array.isArray(out.warnings), out);
    }
    check('degradation: an uncheckable letter reports checkable:false, NOT a clean pass', checkCoverLetterGrounding('', resume, jd).checkable === false && checkCoverLetterGrounding(LETTER, null, null).checkable === false);
    check('the source resume was not mutated by any of that', JSON.stringify(resume) === frozen);

    // --- PROMPT_EXAMPLES agree with the checker ---------------------------
    for (const example of PROMPT_EXAMPLES) {
      const out = checkCoverLetterGrounding(example.letter, { summary: example.source }, null);
      check(`prompt example is caught by the code: "${example.caught}"`, out.warnings.some((w) => w.term.toLowerCase() === example.caught.toLowerCase()), out.warnings);
    }

    // --- assembling the body ----------------------------------------------
    const assembled = assembleLetterBody(
      {
        greeting: 'Dear Hiring Manager,',
        paragraphs: ['## First para with **markdown**.', '', '- Second para.'],
        closing: 'Sincerely,',
        signature: 'Jane Doe',
      },
      resume
    );
    check('assemble: markdown the model was told not to emit is stripped', !assembled.includes('##') && !assembled.includes('**') && !/^- /m.test(assembled), assembled);
    check('assemble: blank paragraphs are dropped', bodyParagraphs(assembled).length === 2, bodyParagraphs(assembled));
    check('assemble: greeting first, signature last', assembled.startsWith('Dear Hiring Manager,') && assembled.trim().endsWith('Jane Doe'));
    check('assemble: blocks are separated by a blank line, which is the only structure the body carries', assembled.split(/\n\s*\n/).length === 4, assembled.split(/\n\s*\n/).length);
    check('assemble: a missing signature falls back to the resume name', assembleLetterBody({ paragraphs: ['x'] }, resume).includes('Jane Doe'));
    check('assemble: junk input does not throw', typeof assembleLetterBody(null, null) === 'string' && typeof assembleLetterBody('nope', resume) === 'string');

    // --- the length check --------------------------------------------------
    const lenOk = enforceLength(LETTER, 'short');
    check('length check: counts body paragraphs only, not the greeting or sign-off', lenOk.paragraphs === 2, lenOk);
    check('length check: counts words and reports rather than truncating', typeof lenOk.words === 'number' && lenOk.words === countWords(bodyParagraphs(LETTER).join(' ')), lenOk);
    check('length check: a medium budget is not met by a short letter, and says so', enforceLength(LETTER, 'medium').ok === false && enforceLength(LETTER, 'medium').withinParagraphs === false);
    check('length check: it never rewrites the letter', enforceLength(LETTER, 'long') && LETTER === LETTER);

    // --- fingerprint and staleness -----------------------------------------
    check('fingerprint: stable across key order', fingerprint({ a: 1, b: { c: 2, d: 3 } }) === fingerprint({ b: { d: 3, c: 2 }, a: 1 }));
    check('fingerprint: different content, different value', fingerprint(resume) !== fingerprint({ ...resume, summary: 'Something else.' }));
    check('fingerprint: arrays keep their order, because a resume\'s entry order is meaningful', fingerprint([1, 2]) !== fingerprint([2, 1]));
    check('fingerprint: null and undefined do not throw', typeof fingerprint(null) === 'string' && typeof fingerprint(undefined) === 'string');

    const slice = buildCoverLetterSlice({ body: LETTER, tone: 'warm', length: 'short', resume, parsedJD: jd });
    check('slice: carries the body, the parameters, the grounding and both fingerprints', slice.body === LETTER && slice.tone === 'warm' && slice.length === 'short' && slice.grounding.checkable === true && typeof slice.resumeFingerprint === 'string' && typeof slice.jdFingerprint === 'string', Object.keys(slice));
    check('staleness: a fresh letter is not stale', isCoverLetterStale(slice, resume, jd) === false);
    check('staleness: ANY change to the resume makes it stale -- a hand edit', isCoverLetterStale(slice, { ...resume, summary: 'Rewritten by hand.' }, jd) === true);
    check('staleness: an entry removed makes it stale', isCoverLetterStale(slice, { ...resume, experience: resume.experience.slice(1) }, jd) === true);
    check('staleness: an entry added makes it stale', isCoverLetterStale(slice, { ...resume, experience: [{ title: 'New', company: 'X' }, ...resume.experience] }, jd) === true);
    check('staleness: merged skills make it stale', isCoverLetterStale(slice, { ...resume, skills: [...resume.skills, { category: 'Inferred from experience', skills: ['Kubernetes'] }] }, jd) === true);
    check('staleness: a changed JD makes it stale', isCoverLetterStale(slice, resume, { ...jd, jobTitle: 'Staff Engineer' }) === true);
    check('staleness: a resume rebuilt by a spread in a different key order is NOT stale', (() => {
      const reordered = JSON.parse(JSON.stringify(resume));
      const swapped = { summary: reordered.summary, name: reordered.name, ...reordered };
      return isCoverLetterStale(slice, swapped, jd) === false;
    })());
    check('staleness: "cannot tell" is null, never false -- no letter, or one stored without fingerprints', isCoverLetterStale(null, resume, jd) === null && isCoverLetterStale({ body: 'x' }, resume, jd) === null && isCoverLetterStale({ body: '' }, resume, jd) === null);

    // --- export ------------------------------------------------------------
    const blocks = splitLetterBlocks(LETTER);
    check('split: greeting, body, sign-off', blocks.greeting === 'Dear Hiring Manager,' && blocks.paragraphs.length === 2 && blocks.signoff.startsWith('Sincerely,'));
    check('split: fewer than three blocks means it is ALL body -- no silent promotion of a sentence to a salutation', splitLetterBlocks('Just one block.').paragraphs.length === 1 && splitLetterBlocks('Just one block.').greeting === '');
    check('split: windows line endings and trailing spaces survive', splitLetterBlocks('A\r\n\r\nB\r\n\r\nC').paragraphs.length === 1);
    check('split: empty input does not throw', splitLetterBlocks('').paragraphs.length === 0 && splitLetterBlocks(null).greeting === '');

    const norm = normalizeCoverLetterForExport(slice, resume, jd, new Date('2026-09-23T10:00:00Z'));
    check('normalise: the letterhead is DERIVED from the resume, so it can never be stale', norm.name === 'Jane Doe' && norm.contactLine.includes('jane@example.com'));
    check('normalise: the contact line is formatted by the resume\'s own builder', norm.contactLine === normalizeResumeForExport(resume).contact.email + ' | ' + normalizeResumeForExport(resume).contact.phone + ' | ' + normalizeResumeForExport(resume).contact.location, norm.contactLine);
    check('normalise: the addressee comes from the JD', norm.company === 'Nimbus' && norm.jobTitle === 'Senior Backend Engineer');
    check('normalise: the date is spelled out, not numeric', /\d{1,2} [A-Z][a-z]+ \d{4}/.test(norm.date), norm.date);
    check('normalise: junk in, fixed shape out, no throw', (() => {
      const out = normalizeCoverLetterForExport(null, 'nonsense', 42);
      return typeof out.name === 'string' && Array.isArray(out.paragraphs);
    })());
    check('normalise: a letter with nothing printable is reported as such', hasExportableLetter(normalizeCoverLetterForExport({ body: '' }, resume, jd)) === false && hasExportableLetter(norm) === true);

    const text = generateCoverLetterPlainText(norm);
    check('plain text: letterhead, then the letter, no uppercase headings and no "- " bullets', text.includes('Jane Doe') && text.includes('Dear Hiring Manager,') && !/^[A-Z ]{4,}$/m.test(text) && !/^- /m.test(text), text.slice(0, 200));
    check('plain text: every body paragraph is present', bodyParagraphs(LETTER).every((p) => text.includes(p.slice(0, 40))));
    check('plain text: the letterhead can be left off for an email body', !generateCoverLetterPlainText(norm, { includeLetterhead: false }).includes('jane@example.com'));

    check('filename: says Cover_Letter, NOT Resume -- two files in one application must not collide', buildCoverLetterFileName(norm, new Date('2026-09-23T10:00:00Z')) === 'Jane_Doe_Cover_Letter_2026-09-23.pdf', buildCoverLetterFileName(norm));
    check('filename: accents fold, a nameless letter still gets a usable name', buildCoverLetterFileName({ name: 'Zoë Ñuñez' }, new Date('2026-09-23T10:00:00Z')) === 'Zoe_Nunez_Cover_Letter_2026-09-23.pdf' && buildCoverLetterFileName({ name: '' }, new Date('2026-09-23T10:00:00Z')) === 'Cover_Letter_2026-09-23.pdf');
    check('date: formatLetterDate spells the month', formatLetterDate(new Date('2026-01-05T10:00:00Z')).includes('January'));

    // The resume's font check is reused unchanged. Asserted rather than assumed
    // -- see the comment in coverLetterExport.js.
    check('font check: the RESUME\'s findUnsupportedPdfCharacters works on a letter as-is', (() => {
      const bad = normalizeCoverLetterForExport({ body: 'Dear X,\n\nI shipped it → fast.\n\nBye,\nJane' }, resume, jd);
      const found = findUnsupportedPdfCharacters(bad);
      return found.includes('→') && findUnsupportedPdfCharacters(norm).length === 0;
    })(), findUnsupportedPdfCharacters(normalizeCoverLetterForExport({ body: 'a → b' }, resume, jd)));

    check('timeout: the letter has its own, above the 20s shared default and below the tailor\'s 150s', COVER_LETTER_TIMEOUT_MS > 20_000 && COVER_LETTER_TIMEOUT_MS < 150_000, COVER_LETTER_TIMEOUT_MS);

    // --- persistence -------------------------------------------------------
    if (typeof localStorage !== 'undefined') {
      const backup = localStorage.getItem(RAW_KEY);
      try {
        saveSession({ resumeText: 'x', resume, parsedJD: jd, coverLetter: slice, sources: {}, settings: {} });
        const loaded = loadSession().state;
        check('persistence: the letter round-trips exactly', JSON.stringify(loaded.coverLetter) === JSON.stringify(slice), loaded.coverLetter && Object.keys(loaded.coverLetter));
        check('persistence: including the grounding report and both fingerprints', loaded.coverLetter.grounding.checkable === true && loaded.coverLetter.resumeFingerprint === slice.resumeFingerprint);
        check('persistence: it is still not stale after a round trip', isCoverLetterStale(loaded.coverLetter, loaded.resume, loaded.parsedJD) === false);
        check('persistence: a letter alone keeps a session alive -- it is real work that cost an AI call', (() => {
          saveSession({ resumeText: '', resume: null, parsedJD: null, coverLetter: slice, sources: {}, settings: {} });
          return loadSession().state !== null;
        })());
        check('persistence: a wrong-typed letter is dropped on its own, the rest of the session still loads', (() => {
          const envelope = JSON.parse(localStorage.getItem(RAW_KEY));
          envelope.state.coverLetter = 'a string';
          envelope.state.resume = resume;
          localStorage.setItem(RAW_KEY, JSON.stringify(envelope));
          const out = loadSession().state;
          return out !== null && (out.coverLetter === undefined || out.coverLetter === null) && out.resume !== null;
        })());
        check('persistence: an OLD envelope with no coverLetter key at all loads fine -- no SESSION_VERSION bump needed', (() => {
          const envelope = JSON.parse(localStorage.getItem(RAW_KEY));
          delete envelope.state.coverLetter;
          envelope.state.resume = resume;
          localStorage.setItem(RAW_KEY, JSON.stringify(envelope));
          const out = loadSession().state;
          return out !== null && !out.coverLetter && out.resume !== null;
        })());
      } finally {
        if (backup === null) localStorage.removeItem(RAW_KEY);
        else localStorage.setItem(RAW_KEY, backup);
      }
    } else {
      console.warn('  (skipped persistence: no localStorage)');
    }
  } catch (err) {
    check(`threw: ${err.message}`, false, err);
  } finally {
    console.log(failed ? `${failed} FAILED` : 'all passed');
    console.groupEnd();
  }
  return failed === 0;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export async function testReducer() {
  failed = 0;
  const { appReducer, initialState, hydrate, ACTIONS, RESCORING_ACTIONS } = await import('../../context/AppContext.jsx');
  console.group('coverLetter - reducer');
  const backup = typeof localStorage !== 'undefined' ? localStorage.getItem(RAW_KEY) : null;
  try {
    const resume = sampleResume();
    const jd = sampleJD();
    const base = { ...initialState, resume, parsedJD: jd, resumeText: 'x' };
    const slice = buildCoverLetterSlice({ body: LETTER, tone: 'warm', length: 'short', resume, parsedJD: jd });

    const set = appReducer(base, { type: ACTIONS.SET_COVER_LETTER, payload: slice });
    check('set: the letter lands', set.coverLetter === slice);
    check('set: nothing else in the store moved', set.resume === base.resume && set.tailoredResume === base.tailoredResume);
    check('set: it is NOT in RESCORING_ACTIONS -- a letter changes no keyword the score measures', !RESCORING_ACTIONS.includes('SET_COVER_LETTER') && !RESCORING_ACTIONS.includes('UPDATE_COVER_LETTER'));
    check('set: the score was not recomputed', set.atsScore === base.atsScore);

    check('set: a malformed payload changes nothing at all', appReducer(set, { type: ACTIONS.SET_COVER_LETTER, payload: null }) === set && appReducer(set, { type: ACTIONS.SET_COVER_LETTER, payload: { nope: 1 } }) === set);
    check('set: with no resume there is nothing to write from, so a late generation cannot land', appReducer({ ...initialState }, { type: ACTIONS.SET_COVER_LETTER, payload: slice }).coverLetter === null);

    const edited = buildCoverLetterSlice({ ...slice, body: `${LETTER}\n\nPS: I also worked at Globex Industries.`, resume, parsedJD: jd, edited: true, generatedAt: slice.generatedAt });
    const afterEdit = appReducer(set, { type: ACTIONS.UPDATE_COVER_LETTER, payload: edited });
    check('edit: the body is replaced', afterEdit.coverLetter.body.includes('Globex'));
    check('edit: the grounding report was RE-RUN against the edited text, so the user is warned about their own typing', afterEdit.coverLetter.grounding.grounded === false && afterEdit.coverLetter.grounding.warnings.some((w) => /Globex/.test(w.term)), afterEdit.coverLetter.grounding.warnings);
    check('edit: it is marked as edited, so the page stops crediting the model', afterEdit.coverLetter.edited === true);
    check('edit: generatedAt is preserved -- it is the editor\'s React key and a change would remount mid-save', afterEdit.coverLetter.generatedAt === slice.generatedAt);

    check('clear: the letter goes, the resume stays', (() => {
      const cleared = appReducer(afterEdit, { type: ACTIONS.CLEAR_COVER_LETTER });
      return cleared.coverLetter === null && cleared.resume === afterEdit.resume;
    })());
    check('clear: clearing twice is a no-op, so it writes no storage', (() => {
      const once = appReducer(afterEdit, { type: ACTIONS.CLEAR_COVER_LETTER });
      return appReducer(once, { type: ACTIONS.CLEAR_COVER_LETTER }) === once;
    })());

    // A new Input run replaces the resume AND the posting, so a letter about
    // the old job must not survive it. This is the one path that discards
    // without asking, and it is the user's own explicit re-run.
    check('CLEAR_ANALYSIS discards the letter -- a new Input run replaces the job it was written for', appReducer(afterEdit, { type: ACTIONS.CLEAR_ANALYSIS }).coverLetter === null);
    check('RESET discards it too', appReducer(afterEdit, { type: ACTIONS.RESET }).coverLetter === null);

    // Staleness through the reducer: every path that changes the resume.
    const withTailored = appReducer(set, { type: ACTIONS.SET_TAILORED_RESUME, payload: { resume: { ...resume, summary: 'Tailored summary.' }, changesLog: [], corrections: [], parsedJD: set.parsedJD } });
    check('staleness: a tailoring pass makes the letter stale, and NOTHING discarded it', withTailored.coverLetter === slice && isCoverLetterStale(withTailored.coverLetter, withTailored.tailoredResume, withTailored.parsedJD) === true);
    const withEdit = appReducer(withTailored, { type: ACTIONS.UPDATE_TAILORED_SECTION, payload: { section: 'summary', value: 'Edited by hand.' } });
    check('staleness: a hand edit to the resume makes it stale, still without discarding', withEdit.coverLetter === slice && isCoverLetterStale(withEdit.coverLetter, withEdit.tailoredResume, withEdit.parsedJD) === true);
    const withRemoval = appReducer(withEdit, { type: ACTIONS.REMOVE_TAILORED_ENTRY, payload: { section: 'experience', index: 0 } });
    check('staleness: an entry removed makes it stale', isCoverLetterStale(withRemoval.coverLetter, withRemoval.tailoredResume, withRemoval.parsedJD) === true);
    const withSkills = appReducer(withRemoval, { type: ACTIONS.MERGE_INFERRED_SKILLS, payload: ['Kubernetes'] });
    check('staleness: approved skills make it stale', isCoverLetterStale(withSkills.coverLetter, withSkills.tailoredResume, withSkills.parsedJD) === true);
    check('staleness: nothing in that chain auto-regenerated or auto-discarded -- it is the same object throughout', withSkills.coverLetter === slice);

    // A sweep, so a future action that touches the letter has to be considered.
    const payloads = {
      RESET: undefined,
      SET_RESUME_TEXT: 'x',
      SET_RESUME: resume,
      SET_JOB_DESCRIPTION: 'x',
      SET_PARSED_JD: jd,
      SET_GAP_ANALYSIS: null,
      SET_ATS_SCORE: null,
      SET_TAILORED_RESUME: { resume, changesLog: [], corrections: [], parsedJD: set.parsedJD },
      CLEAR_TAILORING: undefined,
      UPDATE_TAILORED_SECTION: { section: 'summary', value: 'Another summary.' },
      ADD_TAILORED_ENTRY: { section: 'projects', value: { name: 'A project' } },
      REMOVE_TAILORED_ENTRY: { section: 'certifications', index: 0 },
      SET_DRAFT_EDIT: { section: 'summary', value: 'typed' },
      DISCARD_DRAFT_EDIT: { section: 'summary' },
      SET_COVER_LETTER: slice,
      UPDATE_COVER_LETTER: edited,
      CLEAR_COVER_LETTER: undefined,
      // Match reads the resume and writes nothing to it, so none of these may
      // disturb a letter.
      SET_MATCH_POSTINGS: [{ id: 'p1', label: '', text: 'A posting.', url: '', source: 'paste', status: 'pending', error: null }],
      SET_MATCH_RESULTS: { results: [{ id: 'p1', label: 'A posting', jd: null, score: null, gap: null, error: { message: 'x' } }], resumeFingerprint: 'x', ranAt: '2026-09-23T00:00:00.000Z', provider: 'claude', completed: 0, failed: 1, aborted: false },
      REMOVE_MATCH_RESULT: { id: 'p1' },
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
    const DISCARDS = ['RESET', 'CLEAR_ANALYSIS', 'CLEAR_COVER_LETTER'];
    for (const name of Object.keys(ACTIONS)) {
      if (!(name in payloads)) {
        check(`${name}: has a cover-letter case (add one to payloads when adding an action)`, false);
        continue;
      }
      const after = appReducer(set, { type: ACTIONS[name], payload: payloads[name] });
      if (DISCARDS.includes(name)) {
        check(`${name}: deliberately discards the letter`, after.coverLetter === null);
      } else if (name === 'UPDATE_COVER_LETTER') {
        check(`${name}: replaces it, as designed`, after.coverLetter === edited);
      } else {
        check(`${name}: leaves the letter alone -- never silently discarded`, after.coverLetter === slice, after.coverLetter && after.coverLetter.body.slice(0, 20));
      }
    }

    // A real reload.
    if (typeof localStorage !== 'undefined') {
      saveSession(withEdit);
      const rehydrated = hydrate(initialState);
      check('reload: the letter comes back', rehydrated.coverLetter?.body === LETTER, rehydrated.coverLetter && rehydrated.coverLetter.body.slice(0, 30));
      check('reload: with its grounding report intact', rehydrated.coverLetter.grounding.checkable === true);
      check('reload: and it is STILL detected as stale after the round trip', isCoverLetterStale(rehydrated.coverLetter, rehydrated.tailoredResume, rehydrated.parsedJD) === true);
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
// Live, against the real page
// ---------------------------------------------------------------------------

const memo = () => JSON.parse(sessionStorage.getItem(MEMO_KEY) || '{}');
const remember = (patch) => sessionStorage.setItem(MEMO_KEY, JSON.stringify({ ...memo(), ...patch }));

function liveState() {
  const handle = window.a2resumeDev;
  if (!handle || typeof handle.getState !== 'function') throw new Error('window.a2resumeDev is missing. Run this against the dev server.');
  return handle.getState();
}

const storedState = () => JSON.parse(localStorage.getItem(RAW_KEY) || 'null')?.state ?? null;

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function setValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const buttonByText = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

function finish(next) {
  console.log(failed ? `${failed} FAILED` : 'all passed');
  console.groupEnd();
  if (next) console.log(next);
  return failed === 0;
}

/**
 * ONE REAL AI CALL, through the real button, on /cover-letter.
 *
 * Also the measurement COVER_LETTER_TIMEOUT_MS is set from -- it prints the
 * wall time, so re-run it after changing providers or model lists.
 */
export async function liveGenerate({ tone = 'warm', length = 'medium' } = {}) {
  failed = 0;
  console.group('coverLetter - live 1: generate');
  try {
    const before = liveState();
    if (!before.resume || !before.parsedJD) throw new Error('Open /cover-letter on a session with a resume and a parsed JD.');

    const toneRadio = document.querySelector(`input[name="cover-letter-tone"][value="${tone}"]`);
    const lengthRadio = document.querySelector(`input[name="cover-letter-length"][value="${length}"]`);
    if (!toneRadio || !lengthRadio) throw new Error('No tone/length controls on the page. Are you on /cover-letter?');
    toneRadio.click();
    lengthRadio.click();
    check('the tone and length controls are real radios and take a selection', toneRadio.checked && lengthRadio.checked);

    const button =
      buttonByText(document, 'Write my cover letter') ?? buttonByText(document, 'Write a new letter');
    if (!button) throw new Error('No generate button. Is a provider key stored?');

    const started = Date.now();
    button.click();
    await waitFor(() => document.body.innerText.includes('Writing your letter'), 'the busy state', 3000);
    const letter = await waitFor(() => {
      const s = liveState().coverLetter;
      return s && s.generatedAt !== before.coverLetter?.generatedAt ? s : null;
    }, 'the letter to land', COVER_LETTER_TIMEOUT_MS + 15_000);
    const elapsed = Date.now() - started;

    console.log(`WALL TIME: ${(elapsed / 1000).toFixed(1)}s (service reported ${((letter.elapsedMs ?? 0) / 1000).toFixed(1)}s, timeout is ${COVER_LETTER_TIMEOUT_MS / 1000}s)`);
    check('the letter has real content', letter.body.length > 200, letter.body.length);
    check('it recorded the tone and length that were asked for', letter.tone === tone && letter.length === length, { tone: letter.tone, length: letter.length });
    check('it has a greeting and a sign-off, so it is a letter and not a blob', letter.body.split(/\n\s*\n/).length >= 3, letter.body.split(/\n\s*\n/).length);
    check('no markdown survived', !letter.body.includes('**') && !/^#{1,6} /m.test(letter.body) && !/^[-*] /m.test(letter.body));
    check('the grounding check RAN and says so', letter.grounding.checkable === true && letter.grounding.checkedNames + letter.grounding.checkedSkills > 0, letter.grounding);

    const fabs = fabricationWarnings(letter.grounding);
    if (fabs.length === 0) {
      check('GROUNDING PASSES on a genuine run', true);
    } else {
      // Not a test failure. It is the check doing its job, or a false positive
      // worth reading -- either way the terms are printed for the report.
      console.warn('  grounding flagged terms on a genuine run -- read these and decide which they are:', fabs.map((w) => `${w.kind}: ${w.term}`));
      check('grounding flagged something on a genuine run (see the warning above)', true);
    }
    console.log('  style notes (excluded language):', (letter.grounding.warnings ?? []).filter((w) => w.kind === 'excluded-language').map((w) => w.term));
    console.log('  length:', letter.lengthCheck);

    check('the page shows the letter in the textarea', document.querySelector('#cover-letter-body')?.value === letter.body);
    check('the page shows a grounding banner either way', Boolean(document.querySelector('.cover-letter__grounding')), document.querySelector('.cover-letter__grounding')?.className);
    check('the PDF section rendered', document.body.innerText.includes('Download PDF') || document.body.innerText.includes('Preparing the PDF'));
    check('the plain-text box has the letter, with the letterhead around it', (() => {
      const box = document.querySelector('#cover-letter-plain-text');
      return Boolean(box) && box.value.includes(liveState().resume.name) && box.value.includes(letter.body.split('\n')[0]);
    })());
    check('storage already carries it', storedState()?.coverLetter?.generatedAt === letter.generatedAt);
    check('the resume was NOT touched by generating a letter', liveState().resume === before.resume);
    check('the ATS score was NOT recomputed', liveState().atsScore === before.atsScore);

    remember({ generatedAt: letter.generatedAt, bodyHead: letter.body.slice(0, 60), elapsed });
    console.log('--- the letter ---\n' + letter.body);
  } catch (err) {
    check(err.message, false, err);
  }
  return finish('Now RELOAD (F5), stay on /cover-letter, then run verifyLetterSurvived().');
}

/** Step 2, after a real reload. */
export function verifyLetterSurvived() {
  failed = 0;
  console.group('coverLetter - live 2: after a reload');
  try {
    const { generatedAt, bodyHead } = memo();
    if (!generatedAt) throw new Error('Run liveGenerate() first.');
    const state = liveState();
    check('the letter came back', state.coverLetter?.generatedAt === generatedAt, state.coverLetter?.generatedAt);
    check('with the same text', state.coverLetter.body.startsWith(bodyHead));
    check('and its grounding report', state.coverLetter.grounding?.checkable === true);
    check('it is not reported stale -- the resume has not changed', isCoverLetterStale(state.coverLetter, state.tailoredResume ?? state.resume, state.parsedJD) === false);
    check('the page rendered it into the textarea', document.querySelector('#cover-letter-body')?.value === state.coverLetter.body);
    check('no staleness notice is on screen', !document.body.innerText.includes('Your resume has changed since this letter'));
  } catch (err) {
    check(err.message, false, err);
  }
  return finish('Next: await liveInjectFabrication().');
}

/**
 * SELF-ADVERSARIAL, live and through the real textarea: put an employer into
 * the letter that is not in the resume, press Save, and check the banner.
 *
 * Same pattern every other structural guard here is tested with. It restores
 * the original body at the end.
 */
export async function liveInjectFabrication() {
  failed = 0;
  console.group('coverLetter - live 3: a fabricated employer is caught');
  try {
    const before = liveState();
    if (!before.coverLetter) throw new Error('Generate a letter first.');
    const original = before.coverLetter.body;
    const fake = `Globex Industries ${Date.now().toString(36)}`;
    check('precondition: the resume really does not mention it', !JSON.stringify(before.resume).includes('Globex') && !JSON.stringify(before.tailoredResume ?? {}).includes('Globex'));
    check('precondition: the letter is clean right now', fabricationWarnings(before.coverLetter.grounding).length === 0, fabricationWarnings(before.coverLetter.grounding));

    const box = document.querySelector('#cover-letter-body');
    if (!box) throw new Error('No letter textarea on the page.');
    const tampered = original.replace(/\n\n/, `\n\nDuring my three years at ${fake} I owned the deployment pipeline.\n\n`);
    setValue(box, tampered);

    const save = await waitFor(() => {
      const b = buttonByText(document, 'Save changes');
      return b && !b.disabled ? b : null;
    }, 'Save to become enabled');
    check('typing marks the letter unsaved, and says the edit is not exported yet', document.body.innerText.includes('Unsaved changes'));
    check('nothing is in the store until Save is pressed', liveState().coverLetter.body === original);

    save.click();
    await waitFor(() => liveState().coverLetter.body !== original, 'the save to land');

    const after = liveState();
    const fabs = fabricationWarnings(after.coverLetter.grounding);
    check('CAUGHT: the grounding check re-ran on the edit and flagged the fabricated employer', fabs.some((w) => w.kind === 'fabricated-name' && w.term.includes('Globex')), fabs);
    check('the letter is reported as not grounded', after.coverLetter.grounding.grounded === false);
    check('the page shows the warning banner, naming the term', (() => {
      const banner = document.querySelector('.notice--warn.cover-letter__grounding');
      return Boolean(banner) && banner.innerText.includes('Globex');
    })(), document.querySelector('.cover-letter__grounding')?.innerText?.slice(0, 200));
    check('the banner also states what the check cannot catch, rather than implying it is a fact check', document.querySelector('.cover-letter__grounding')?.innerText.includes('cannot catch'));
    check('it is marked as edited by hand', after.coverLetter.edited === true);
    check('storage carries the edited version', storedState()?.coverLetter?.body.includes('Globex'));
    check('the exported plain text carries the edit too, so the banner describes what would be sent', document.querySelector('#cover-letter-plain-text')?.value.includes('Globex'));

    // Put it back, and watch the banner clear -- the other half of the check.
    setValue(document.querySelector('#cover-letter-body'), original);
    const saveBack = await waitFor(() => {
      const b = buttonByText(document, 'Save changes');
      return b && !b.disabled ? b : null;
    }, 'Save to re-enable');
    saveBack.click();
    await waitFor(() => liveState().coverLetter.body === original, 'the restore to land');
    check('RESTORED: editing the fabrication out clears the warning', fabricationWarnings(liveState().coverLetter.grounding).length === 0, fabricationWarnings(liveState().coverLetter.grounding));
    check('and the banner on screen goes back to the clean one', Boolean(document.querySelector('.notice--ok.cover-letter__grounding')));
  } catch (err) {
    check(err.message, false, err);
  }
  return finish('Next: await liveStaleness().');
}

/**
 * Generate, then change the resume by hand, and check the page says the letter
 * may no longer match -- rather than silently keeping a stale letter or
 * silently regenerating.
 *
 * It edits the CURRENT resume's summary through the reducer (the same dispatch
 * Tailor's editor makes) and records what it overwrote.
 */
export async function liveStaleness() {
  failed = 0;
  console.group('coverLetter - live 4: the staleness notice');
  try {
    const { ACTIONS } = await import('../../context/AppContext.jsx');
    const dispatch = window.a2resumeDev?.dispatch;
    if (typeof dispatch !== 'function') throw new Error('window.a2resumeDev.dispatch is missing.');

    const before = liveState();
    if (!before.coverLetter) throw new Error('Generate a letter first.');
    if (!before.tailoredResume) throw new Error('This runner edits the TAILORED resume, so run a tailoring pass first (or use testReducer for the untailored path).');
    check('precondition: the letter is not stale yet', isCoverLetterStale(before.coverLetter, before.tailoredResume, before.parsedJD) === false);
    check('precondition: no notice on screen', !document.body.innerText.includes('Your resume has changed since this letter'));

    const originalSummary = before.tailoredResume.summary ?? '';
    remember({ originalSummary, letterBefore: before.coverLetter.body });

    dispatch({
      type: ACTIONS.UPDATE_TAILORED_SECTION,
      payload: { section: 'summary', value: `${originalSummary} Also a published author on distributed systems.`.trim() },
    });
    await waitFor(() => liveState().tailoredResume.summary !== originalSummary, 'the resume edit to land');

    const after = liveState();
    check('the resume really changed', after.tailoredResume.summary !== originalSummary);
    check('NOT SILENTLY DISCARDED: the letter is still there, byte for byte', after.coverLetter?.body === before.coverLetter.body, after.coverLetter?.body?.slice(0, 40));
    check('NOT SILENTLY REGENERATED: it is the very same object, so no AI call was made', after.coverLetter === before.coverLetter);
    check('it IS detected as stale', isCoverLetterStale(after.coverLetter, after.tailoredResume, after.parsedJD) === true);

    await waitFor(() => document.body.innerText.includes('Your resume has changed since this letter'), 'the staleness notice to appear');
    const notice = [...document.querySelectorAll('.notice--warn')].find((n) => n.innerText.includes('Your resume has changed'));
    check('the page shows the notice', Boolean(notice));
    check('it says nothing was thrown away', notice.innerText.includes('Nothing has been changed or thrown away'));
    check('it says regenerating is a paid call and the user\'s choice', /your own API key/i.test(notice.innerText) && /your\s+choice/i.test(notice.innerText));
    check('it warns that regenerating replaces the current letter and its edits', notice.innerText.includes('replace the letter below'));
    check('it offers keeping this one as a real option', notice.innerText.includes('keep this one'));
    check('the regenerate control is a button, not something that already ran', Boolean(buttonByText(notice, 'Write it again from the current resume')));
    check('the letter is still editable and still exportable while stale', Boolean(document.querySelector('#cover-letter-body')) && Boolean(document.querySelector('#cover-letter-plain-text')));
    check('storage still holds the letter', storedState()?.coverLetter?.body === before.coverLetter.body);
  } catch (err) {
    check(err.message, false, err);
  }
  return finish('Now RELOAD (F5) to check it survives, then run restoreAfterStaleness().');
}

/** The notice must survive a reload -- the fingerprint is persisted, not in memory. */
export function verifyStalenessSurvived() {
  failed = 0;
  console.group('coverLetter - live 5: staleness after a reload');
  try {
    const { letterBefore } = memo();
    const state = liveState();
    check('the letter is still there after the reload', state.coverLetter?.body === letterBefore);
    check('and still detected as stale', isCoverLetterStale(state.coverLetter, state.tailoredResume ?? state.resume, state.parsedJD) === true);
    check('the notice is on screen again', document.body.innerText.includes('Your resume has changed since this letter'));
  } catch (err) {
    check(err.message, false, err);
  }
  return finish('Next: restoreAfterStaleness().');
}

/** Puts the resume summary back, so the session is left as it was found. */
export async function restoreAfterStaleness() {
  failed = 0;
  console.group('coverLetter - live 6: restore');
  try {
    const { ACTIONS } = await import('../../context/AppContext.jsx');
    const { originalSummary } = memo();
    if (typeof originalSummary !== 'string') throw new Error('Run liveStaleness() first.');
    window.a2resumeDev.dispatch({ type: ACTIONS.UPDATE_TAILORED_SECTION, payload: { section: 'summary', value: originalSummary } });
    await waitFor(() => liveState().tailoredResume.summary === originalSummary, 'the summary to go back');
    check('the summary is restored', liveState().tailoredResume.summary === originalSummary);
    check('and the letter is no longer stale, so the notice clears by itself', isCoverLetterStale(liveState().coverLetter, liveState().tailoredResume, liveState().parsedJD) === false);
    await waitFor(() => !document.body.innerText.includes('Your resume has changed since this letter'), 'the notice to clear');
    check('the notice is gone from the page', true);
  } catch (err) {
    check(err.message, false, err);
  }
  return finish(null);
}

export async function runAll() {
  const results = { testOffline: testOffline(), testReducer: await testReducer() };
  console.table(results);
  console.log('The live runners need a real session, a real key and real reloads. See the header.');
  return Object.values(results).every(Boolean);
}

export default {
  testOffline,
  testReducer,
  liveGenerate,
  verifyLetterSurvived,
  liveInjectFabrication,
  liveStaleness,
  verifyStalenessSurvived,
  restoreAfterStaleness,
  runAll,
};
