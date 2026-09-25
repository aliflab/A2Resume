/**
 * Manual checks for the resume templates. Not imported by the app, not in the
 * build. Run from the browser console with the dev server up:
 *
 *   const t = await import('/src/services/__manual__/templates.manual.js');
 *   await t.testRoundTrips();      // every template x every fixture, through pdfParser.js
 *   t.testPersistenceOffline();    // the stored choice: round trip, CLEAR_ANALYSIS, RESET, junk ids
 *   await t.testPageBreakSweep();  // 24 summary lengths per template: no heading left at a page bottom
 *   await t.testRoundTrip('formal', 'heavy');   // one pair, with the extracted text printed
 *   // on /export, with a resume loaded:
 *   await t.liveSwitchTemplates(); // clicks each option, checks the preview and the download link
 *   // then reload, and:
 *   (await import('/src/services/__manual__/templates.manual.js')).verifyTemplateSurvived();
 *
 * WHAT THE ROUND TRIP IS FOR
 * The original Export session rendered a PDF, read it back through
 * pdfParser.js, and found the name and the email extracted as one word
 * ("Jane Doejane@x.io") -- the name's line box overlapped the contact line.
 * An ATS reading it that way loses both. It is the only test that has ever
 * caught that class of bug, and every template has its own header and its own
 * entry layout, so each one is round-tripped on its own. Nothing here is
 * shared between templates except the fixture.
 *
 * THE CHECKS
 * - MAGIC: the blob starts "%PDF-" and ends with "%%EOF".
 * - WORDS: every whitespace-separated word pdfParser extracts is a word the
 *   resume actually contains (case-folded, edge punctuation stripped). This is
 *   the weld detector, and it is template-agnostic: two fields run together
 *   ("Doejane@x.io"), a hyphenated split ("Kuber-" / "netes") and letter-spaced
 *   headings ("E X P") all produce words the resume never said.
 * - FIELDS: every field value appears contiguously in the extracted text, so
 *   nothing was dropped or interleaved.
 * - HYPHEN: no extracted line ends in a hyphen (a hyphen react-pdf drew at a
 *   wrap, which the WORDS check's punctuation stripping cannot see).
 * - HEADER: the name is followed by a line break, not by the next field.
 * - ORDER: the section headings are lines of their own, in SECTION_ORDER.
 * - PAGES: no blank page, and no page ends on a section heading or an entry
 *   heading (a stranded heading is the page-break failure a dense layout risks).
 *
 * Fixtures are synthetic. No provider, no key, no network.
 */

import { createElement } from 'react';
import { pdf } from '@react-pdf/renderer';

import { extractTextFromPdf } from '../pdfParser.js';
import {
  SECTION_ORDER,
  SECTION_TITLES,
  contactParts,
  degreeLine,
  educationHeading,
  findUnsupportedPdfCharacters,
  normalizeResumeForExport,
  roleHeading,
  sectionHasContent,
  skillLine,
  certificationHeading,
  metaLine,
} from '../resumeExport.js';
import { RESUME_DOCUMENTS } from '../../components/export/resumeDocuments.js';
import { ACTIONS, appReducer, hydrate, initialState } from '../../context/AppContext.jsx';
import { loadSession, saveSession } from '../sessionPersistence.js';
import { get, remove, set } from '../storageService.js';
import { RESUME_TEMPLATE_IDS, resolveResumeTemplate } from '../../components/export/resumeTemplates.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const role = (title, company, location, startDate, endDate, bullets, extra = {}) => ({
  title,
  company,
  location,
  startDate,
  endDate,
  isCurrentlyWorking: endDate === '',
  bullets,
  links: [],
  ...extra,
});

/** A realistic one-to-two page resume. */
export const SAMPLE = {
  name: 'Jane Doe',
  contact: {
    email: 'jane.doe@example.com',
    phone: '+61 400 123 456',
    location: 'Sydney, NSW',
    customLinks: [
      { label: 'GitHub', url: 'https://github.com/janedoe' },
      { label: 'LinkedIn', url: 'https://linkedin.com/in/janedoe' },
    ],
  },
  summary:
    'Backend engineer with eight years building payment and logistics platforms. Led the migration of a monolith to Kubernetes-hosted services and cut p99 latency by 40%.',
  experience: [
    role('Senior Software Engineer', 'Acme Payments', 'Sydney, NSW', 'Mar 2021', '', [
      'Led the migration of 14 services from a Rails monolith to Go microservices on Kubernetes, cutting deploy time from 45 minutes to 6.',
      'Designed an idempotent payments ledger in PostgreSQL that processed $2.1B in the first year with zero reconciliation incidents.',
      'Built Terraform modules and GitHub Actions pipelines adopted by 9 teams.',
    ], { links: [{ label: 'Talk', url: 'https://example.com/talks/ledger' }] }),
    role('Software Engineer', 'Globex Logistics', 'Melbourne, VIC', 'Jan 2018', 'Feb 2021', [
      'Rewrote the route-planning service in TypeScript and Node.js, reducing compute cost by 35%.',
      'Introduced OpenTelemetry tracing across 20 services, halving mean time to resolution.',
    ]),
  ],
  projects: [
    {
      name: 'ledgerlint',
      description: 'An open-source linter for double-entry accounting schemas.',
      bullets: ['Used by 300+ repositories; written in Rust.'],
      links: [{ label: 'Repo', url: 'https://github.com/janedoe/ledgerlint' }],
    },
  ],
  skills: [
    { category: 'Languages', skills: ['Go', 'TypeScript', 'Python', 'SQL'] },
    { category: 'Infrastructure', skills: ['Kubernetes', 'Terraform', 'AWS', 'GitHub Actions'] },
  ],
  education: [
    {
      institution: 'University of Sydney',
      degree: 'Bachelor of Science',
      field: 'Computer Science',
      location: 'Sydney, NSW',
      startDate: '2011',
      endDate: '2014',
      details: ['First Class Honours'],
    },
  ],
  certifications: [
    { name: 'Certified Kubernetes Administrator', issuer: 'CNCF', date: '2022', url: 'https://example.com/cka' },
  ],
};

const LONG_WORDS = [
  'containerisation',
  'infrastructure-as-code',
  'observability',
  'internationalisation',
  'Kubernetes',
  'PostgreSQL',
  'microservices',
  'reconciliation',
];

/**
 * The heaviest realistic session this app has measured (CLAUDE.md, "Heavy":
 * 10 roles x 8 bullets), with long technical words placed to land at line ends
 * so hyphenation and page breaks both get exercised.
 */
export function buildHeavyResume() {
  const companies = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark', 'Wayne', 'Wonka', 'Tyrell', 'Cyberdyne'];
  const experience = companies.map((company, r) =>
    role(
      r === 0 ? 'Principal Engineer' : `Software Engineer ${10 - r}`,
      `${company} Systems`,
      r % 2 ? 'Remote' : 'Sydney, NSW',
      `Jan ${2024 - r * 2}`,
      r === 0 ? '' : `Dec ${2025 - r * 2}`,
      Array.from({ length: 8 }, (_, b) => {
        const word = LONG_WORDS[(r + b) % LONG_WORDS.length];
        return `Delivered ${word} improvements for the ${company} platform team across ${b + 3} services, measured against quarterly reliability targets and reported to leadership monthly (${r}.${b}).`;
      }),
    ),
  );
  return {
    ...SAMPLE,
    summary: `${SAMPLE.summary} ${SAMPLE.summary}`,
    experience,
    projects: Array.from({ length: 5 }, (_, i) => ({
      name: `project-${i + 1}`,
      description: `A tool for ${LONG_WORDS[i]} work, maintained since ${2016 + i}.`,
      bullets: [`Adopted by ${10 * (i + 1)} teams internally.`, 'Written in Go with a PostgreSQL backend.'],
      links: [{ label: 'Repo', url: `https://github.com/janedoe/project-${i + 1}` }],
    })),
    skills: [
      ...SAMPLE.skills,
      { category: 'Data', skills: ['PostgreSQL', 'Kafka', 'Redis', 'BigQuery', 'dbt'] },
      { category: 'Practices', skills: ['Observability', 'Incident response', 'Code review', 'Mentoring'] },
      { category: 'Cloud', skills: ['AWS', 'GCP', 'Cloudflare'] },
      { category: 'Frontend', skills: ['React', 'Next.js', 'CSS'] },
    ],
    education: [
      ...SAMPLE.education,
      { institution: 'UNSW Sydney', degree: 'Master of Information Technology', field: '', location: 'Sydney, NSW', startDate: '2015', endDate: '2016', details: [] },
    ],
    certifications: Array.from({ length: 5 }, (_, i) => ({
      name: `Certification Number ${i + 1}`,
      issuer: 'Example Institute',
      date: String(2018 + i),
      url: '',
    })),
  };
}

/** Sections with zero entries: no summary, no projects, no certifications. */
export const SPARSE = { ...SAMPLE, summary: '', projects: [], certifications: [] };

/** Characters Helvetica and Times cannot draw. */
export const UNICODE = {
  ...SAMPLE,
  name: 'Zoë Nguyễn',
  summary: 'Moved services from AWS → GCP and led a team in 東京. Shipped ✓ on time.',
};

export const FIXTURES = { sample: SAMPLE, heavy: buildHeavyResume(), sparse: SPARSE, unicode: UNICODE };

/**
 * The page-break sweep. One fixture only lands one set of headings near one
 * set of page bottoms, which is how a stranded heading hid in Classic for as
 * long as it did. Growing the summary one sentence at a time slides every
 * heading below it down the page in small steps, so across the sweep each one
 * spends a turn at a page bottom. A template whose page count never changes
 * across the sweep was not actually swept -- check `pageCounts`.
 */
const SWEEP_SENTENCE = 'Known for pragmatic engineering, careful reviews, and clear written design documents.';
// Three extra roles so even Technical, the densest, crosses a page inside the
// sweep; testPageBreakSweep reports the page counts it saw so that stays true.
const SWEEP_BASE = { ...SAMPLE, experience: [...SAMPLE.experience, ...FIXTURES.heavy.experience.slice(2, 5)] };
for (let k = 1; k <= 24; k += 1) {
  FIXTURES[`sweep${k}`] = { ...SWEEP_BASE, summary: `${SAMPLE.summary} ${Array(k * 2).fill(SWEEP_SENTENCE).join(' ')}` };
}
const BASE_FIXTURES = ['sample', 'heavy', 'sparse', 'unicode'];

// ---------------------------------------------------------------------------
// Rendering and extraction
// ---------------------------------------------------------------------------

export async function renderTemplatePdf(templateId, normalized) {
  const Doc = RESUME_DOCUMENTS[templateId];
  if (!Doc) throw new Error(`No template "${templateId}"`);
  return pdf(createElement(Doc, { resume: normalized })).toBlob();
}

export async function checkMagicBytes(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const head = String.fromCharCode(...bytes.slice(0, 5));
  const tail = String.fromCharCode(...bytes.slice(-32));
  return { ok: head === '%PDF-' && tail.includes('%%EOF'), head, size: bytes.length };
}

const squash = (s) => s.replace(/\s+/g, ' ').trim();
const EDGE_PUNCT = /^[\s|•·,:;()"'—–\-.]+|[\s|•·,:;()"'—–\-.]+$/g;
const words = (s) =>
  s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(EDGE_PUNCT, ''))
    .filter(Boolean);

/** Every string the resume can print, one per field. The atoms the checks look for. */
function fieldAtoms(r) {
  const atoms = [r.name, ...contactParts(r), r.summary];
  for (const e of r.experience) atoms.push(e.title, e.company, e.location, e.dates, ...e.bullets, ...e.links.map((l) => l.url));
  for (const p of r.projects) atoms.push(p.name, p.description, ...p.bullets, ...p.links.map((l) => l.url));
  for (const g of r.skills) atoms.push(g.category, ...g.skills);
  for (const ed of r.education) atoms.push(degreeLine(ed), ed.institution, ed.location, ed.dates, ...ed.details);
  for (const c of r.certifications) atoms.push(certificationHeading(c), c.url);
  return atoms.filter(Boolean);
}

/** Lines that must never be the last thing on a page. */
function headingLines(r) {
  const out = SECTION_ORDER.map((s) => SECTION_TITLES[s]);
  for (const e of r.experience) out.push(roleHeading(e), e.company, e.title, e.dates, metaLine(e));
  for (const p of r.projects) out.push(p.name);
  for (const ed of r.education) out.push(educationHeading(ed), ed.institution, ed.dates);
  return out.filter(Boolean).map((s) => s.toLowerCase());
}

/**
 * Render one template with one fixture, read it back through pdfParser.js, and
 * assert everything in the header comment. Returns a result object; logs a table.
 */
export async function roundTrip(templateId, fixtureName, { printText = false } = {}) {
  const resume = normalizeResumeForExport(FIXTURES[fixtureName]);
  const failures = [];
  const fail = (check, detail) => failures.push({ check, detail });

  const t0 = performance.now();
  const blob = await renderTemplatePdf(templateId, resume);
  const renderMs = Math.round(performance.now() - t0);

  const magic = await checkMagicBytes(blob);
  if (!magic.ok) fail('MAGIC', magic.head);

  const file = new File([blob], `${templateId}-${fixtureName}.pdf`, { type: 'application/pdf' });
  const extracted = await extractTextFromPdf(file);
  const { text, pageCount, pagesWithText } = extracted;
  if (printText) console.log(`---- ${templateId} / ${fixtureName} ----\n${text}`);

  // Characters the font cannot draw come out wrong by design (Export names
  // them). Atoms containing one are excluded from the word and field checks,
  // and what they became is reported instead.
  const unsupported = findUnsupportedPdfCharacters(resume);
  const drawable = (s) => ![...s].some((ch) => unsupported.includes(ch));
  const atoms = fieldAtoms(resume).filter(drawable);

  // WORDS
  const allowed = new Set([...atoms, ...SECTION_ORDER.map((s) => SECTION_TITLES[s]), skillLine({ category: '', skills: [] })].flatMap(words));
  const untrusted = new Set(fieldAtoms(resume).filter((a) => !drawable(a)).flatMap(words));
  const strangers = [...new Set(words(text))].filter((w) => !allowed.has(w) && !untrusted.has(w));
  // An undrawable character comes out as some other glyph ("ễ" as "å"), which
  // makes a stranger word by design -- Export names those characters rather
  // than hiding it. Only words carrying a non-ASCII character are excused, and
  // only when the resume has undrawable characters at all: an all-ASCII
  // stranger is always a weld or a split.
  const isGlyphSwap = (w) => unsupported.length > 0 && /[^\x20-\x7e]/.test(w);
  const glyphs = strangers.filter(isGlyphSwap);
  const welds = strangers.filter((w) => !isGlyphSwap(w));
  if (welds.length) fail('WORDS', welds.slice(0, 12));

  // HYPHEN -- a line that ends in a hyphen. The WORDS check strips edge
  // punctuation, so a stray "|-" at a wrap would otherwise pass it.
  const hyphenLines = text.split('\n').filter((line) => /-\s*$/.test(line));
  if (hyphenLines.length) fail('HYPHEN', hyphenLines.slice(0, 3));

  // FIELDS
  const flat = squash(text);
  const missing = atoms.filter((a) => !flat.includes(squash(a)));
  if (missing.length) fail('FIELDS', missing.slice(0, 6));

  // HEADER
  if (resume.name && drawable(resume.name) && !new RegExp(`(^|\\n)${resume.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`).test(text)) {
    fail('HEADER', JSON.stringify(text.slice(0, 80)));
  }

  // ORDER
  const lines = text.split('\n').map((l) => l.trim().toLowerCase());
  const titleAt = SECTION_ORDER.filter((s) => sectionHasContent(resume, s)).map((s) => ({
    s,
    at: lines.indexOf(SECTION_TITLES[s].toLowerCase()),
  }));
  const lost = titleAt.filter((t) => t.at < 0).map((t) => t.s);
  if (lost.length) fail('ORDER', `heading not on a line of its own: ${lost.join(', ')}`);
  const positions = titleAt.filter((t) => t.at >= 0).map((t) => t.at);
  if (positions.some((p, i) => i > 0 && p < positions[i - 1])) fail('ORDER', titleAt);
  const absent = SECTION_ORDER.filter((s) => !sectionHasContent(resume, s) && lines.includes(SECTION_TITLES[s].toLowerCase()));
  if (absent.length) fail('EMPTY', `heading printed for an empty section: ${absent.join(', ')}`);

  // PAGES
  if (pagesWithText !== pageCount) fail('PAGES', `${pageCount - pagesWithText} blank page(s)`);
  const pages = text.split('\n\n');
  if (pages.length === pageCount) {
    const heads = headingLines(resume);
    pages.slice(0, -1).forEach((page, i) => {
      const last = page.trim().split('\n').pop().trim().toLowerCase();
      if (heads.some((h) => last === h || last.startsWith(`${h} |`))) fail('PAGES', `page ${i + 1} ends on a heading: "${last}"`);
    });
  } else {
    fail('PAGES', `could not split pages (${pages.length} blocks for ${pageCount} pages)`);
  }

  // What the undrawable characters actually became, for the report.
  const unicodeSample = unsupported.length ? squash(text).match(/Moved services[^.]*\./)?.[0] ?? '' : '';

  return {
    template: templateId,
    fixture: fixtureName,
    ok: failures.length === 0,
    pages: pageCount,
    bytes: magic.size,
    renderMs,
    chars: text.length,
    unsupported: unsupported.join(' '),
    unicodeSample,
    glyphs,
    failures,
    text,
  };
}

/** Every template against every fixture. Each template is judged on its own. */
export async function testRoundTrips({ templates = RESUME_TEMPLATE_IDS, fixtures = BASE_FIXTURES } = {}) {
  const results = [];
  for (const templateId of templates) {
    for (const fixtureName of fixtures) {
      try {
        results.push(await roundTrip(templateId, fixtureName));
      } catch (err) {
        results.push({ template: templateId, fixture: fixtureName, ok: false, failures: [{ check: 'THROW', detail: String(err) }] });
      }
    }
  }
  console.table(
    results.map(({ template, fixture, ok, pages, bytes, renderMs, unsupported, glyphs = [], failures }) => ({
      template,
      fixture,
      ok,
      pages,
      bytes,
      renderMs,
      unsupported,
      glyphs: glyphs.join(' '),
      failures: failures.map((f) => `${f.check}: ${typeof f.detail === 'string' ? f.detail : JSON.stringify(f.detail)}`).join(' / '),
    })),
  );
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `FAIL: ${failed.length}/${results.length}` : `PASS: ${results.length}/${results.length}`);
  return results;
}

/** Every template across the whole summary-length sweep. Only failures are listed. */
export async function testPageBreakSweep({ templates = RESUME_TEMPLATE_IDS } = {}) {
  const fixtures = Object.keys(FIXTURES).filter((name) => name.startsWith('sweep'));
  const rows = [];
  for (const templateId of templates) {
    let pages = new Set();
    let failed = [];
    for (const fixtureName of fixtures) {
      const r = await roundTrip(templateId, fixtureName);
      pages.add(r.pages);
      if (!r.ok) failed.push(`${fixtureName}: ${r.failures.map((f) => `${f.check} ${typeof f.detail === 'string' ? f.detail : JSON.stringify(f.detail)}`).join(' / ')}`);
    }
    rows.push({ template: templateId, runs: fixtures.length, pageCounts: [...pages].join(','), failed: failed.length, detail: failed.slice(0, 3).join(' || ') });
  }
  console.table(rows);
  console.log(rows.every((r) => r.failed === 0) ? `PASS: ${rows.length} templates x ${fixtures.length} offsets` : 'FAIL');
  return rows;
}

/** One pair, with the extracted text printed. */
export async function testRoundTrip(templateId, fixtureName = 'sample') {
  const result = await roundTrip(templateId, fixtureName, { printText: true });
  console.log(result.ok ? 'PASS' : 'FAIL', result.failures);
  return result;
}

// ---------------------------------------------------------------------------
// Persistence, offline (no DOM; restores whatever session was stored)
// ---------------------------------------------------------------------------

export function testPersistenceOffline() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: Boolean(ok) });
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}`, ok ? '' : detail ?? '');
  };
  const before = get('session');
  try {
    const seeded = appReducer({ ...initialState, resumeText: 'x', resume: SAMPLE }, {
      type: ACTIONS.SET_SETTINGS,
      payload: { resumeTemplate: 'formal' },
    });
    check('SET_SETTINGS stores the id', seeded.settings.resumeTemplate === 'formal');
    check('...and leaves the provider alone', seeded.settings.provider === initialState.settings.provider);

    saveSession(seeded);
    check('saveSession -> loadSession keeps it', loadSession().state?.settings?.resumeTemplate === 'formal');
    check('hydrate restores it into a fresh store', hydrate(initialState).settings.resumeTemplate === 'formal');

    const rerun = appReducer(seeded, { type: ACTIONS.CLEAR_ANALYSIS });
    check('CLEAR_ANALYSIS (a new Input run) keeps it', rerun.settings.resumeTemplate === 'formal');
    check('RESET (Start over) clears it', appReducer(seeded, { type: ACTIONS.RESET }).settings.resumeTemplate === null);

    set('session', { version: 1, state: { resumeText: 'x', settings: { resumeTemplate: 'no-such-template' } } });
    const junk = hydrate(initialState).settings.resumeTemplate;
    check('an unknown stored id loads as-is...', junk === 'no-such-template');
    check('...and resolves to the default for rendering', resolveResumeTemplate(junk) === 'classic');

    set('session', { version: 1, state: { resumeText: 'x', settings: { resumeTemplate: 42 } } });
    check('a wrong-typed stored id is dropped by the flat sanitiser', hydrate(initialState).settings.resumeTemplate === null);
    check('resolveResumeTemplate(null) is the default', resolveResumeTemplate(null) === 'classic');
    check('every catalogue id has a component', RESUME_TEMPLATE_IDS.every((id) => typeof RESUME_DOCUMENTS[id] === 'function'));
  } finally {
    if (before === null) remove('session');
    else set('session', before);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `FAIL: ${failed}/${results.length}` : `PASS: ${results.length}/${results.length}`);
  return failed === 0;
}

// ---------------------------------------------------------------------------
// Live, on /export
// ---------------------------------------------------------------------------

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, { timeout = 20000, step = 100 } = {}) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const value = predicate();
    if (value) return value;
    await wait(step);
  }
  return null;
}

const downloadHref = () => [...document.querySelectorAll('a')].find((a) => a.textContent.trim() === 'Download PDF')?.href;
const storedTemplate = () => {
  try {
    return JSON.parse(localStorage.getItem('a2resume:session'))?.state?.settings?.resumeTemplate ?? null;
  } catch {
    return 'unreadable';
  }
};

/**
 * Click every template option on the real page. For each: the radio is checked,
 * the preview frame and the download link are rebuilt, the download link's
 * blob is a valid PDF, and it round-trips through pdfParser.js with the name
 * and the email on separate lines. Leaves `leaveOn` selected for the reload check.
 */
export async function liveSwitchTemplates({ leaveOn = 'formal' } = {}) {
  if (!location.pathname.startsWith('/export')) throw new Error('Open /export first.');
  const rows = [];
  const order = [...RESUME_TEMPLATE_IDS.filter((id) => id !== leaveOn), leaveOn];
  // Clicking the radio that is already checked fires no change, so nothing
  // would rebuild. Never start on the current selection.
  const current = document.querySelector('input[name="resume-template"]:checked')?.value;
  if (order[0] === current) order.push(order.shift());
  // ...and still finish on `leaveOn`, which the reload check expects.
  order.splice(order.indexOf(leaveOn), 1);
  order.push(leaveOn);

  for (const id of order) {
    const radio = document.querySelector(`input[name="resume-template"][value="${id}"]`);
    if (!radio) {
      rows.push({ id, ok: false, note: 'no radio' });
      continue;
    }
    const beforeHref = downloadHref();
    const beforeFrame = document.querySelector('iframe.export__preview')?.src;
    radio.click();

    const href = await until(() => {
      const h = downloadHref();
      return h && h !== beforeHref ? h : null;
    });
    const frame = await until(() => {
      const f = document.querySelector('iframe.export__preview')?.src;
      return f && f !== beforeFrame ? f : null;
    });
    const blob = href ? await (await fetch(href)).blob() : null;
    const magic = blob ? await checkMagicBytes(blob) : { ok: false };
    const extracted = blob ? await extractTextFromPdf(new File([blob], `${id}.pdf`, { type: 'application/pdf' })) : null;
    const firstLines = extracted?.text.split('\n').slice(0, 2) ?? [];

    rows.push({
      id,
      checked: radio.checked,
      selectedCard: radio.closest('label')?.classList.contains('template-option--selected'),
      linkRebuilt: Boolean(href),
      previewRebuilt: Boolean(frame),
      magic: magic.ok,
      bytes: magic.size,
      pages: extracted?.pageCount,
      line1: firstLines[0],
      line2: (firstLines[1] ?? '').slice(0, 60),
      stored: storedTemplate(),
    });
  }

  rows.forEach((r) => {
    r.ok = r.checked && r.selectedCard && r.linkRebuilt && r.previewRebuilt && r.magic && r.stored === r.id;
  });
  console.table(rows);
  console.log(rows.every((r) => r.ok) ? `PASS: ${rows.length} templates` : 'FAIL');
  console.log(`Left on "${leaveOn}". Reload, then run verifyTemplateSurvived().`);
  return rows;
}

/** After a reload: the stored choice, the checked radio and the live store all agree. */
export function verifyTemplateSurvived(expected = 'formal') {
  const stored = storedTemplate();
  const checked = document.querySelector('input[name="resume-template"]:checked')?.value ?? null;
  const live = window.a2resumeDev?.getState?.()?.settings?.resumeTemplate ?? '(no dev handle)';
  const ok = stored === expected && checked === expected && resolveResumeTemplate(live) === expected;
  console.log(ok ? 'PASS' : 'FAIL', { expected, stored, checked, live });
  return ok;
}
