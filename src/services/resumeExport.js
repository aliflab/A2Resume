/**
 * Everything the Export step needs that is not React and not the PDF engine.
 *
 * Pure and network-free, like the analysis services, so the page, the PDF
 * template and the plain-text copy all read one normalised resume and cannot
 * drift into three different ideas of what the resume says.
 *
 * WHY A NORMALISER RATHER THAN RECONCILING TAILORED AGAINST ORIGINAL
 * `mergeNonDestructiveResume` already returns a fixed shape: the same eight
 * top-level keys, every contact field present, links rebuilt as
 * `{ label, url }`, blank bullets filtered out. The tailored resume is the
 * *well-behaved* input. The original parse is the one with no guarantees --
 * DeepSeek's json_object mode enforces no schema, any key may be missing or
 * the wrong type, and entries the merge restored verbatim carry the original's
 * raw shape into the tailored object too. So the problem is not "two shapes";
 * it is "an unknown shape", and one normaliser that both pass through is the
 * whole fix.
 */

import { asArray, asObject, asString } from './gapAnalyzer.js';
import { selectCurrentResume } from './currentResume.js';

const clean = (value) => asString(value).trim();
const cleanList = (value) => asArray(value).map(clean).filter(Boolean);
const cleanLinks = (value) =>
  asArray(value)
    .map((link) => ({ label: clean(asObject(link).label), url: clean(asObject(link).url) }))
    .filter((link) => link.url);

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Source selection
// ---------------------------------------------------------------------------

/**
 * The tailored resume when a tailoring pass exists, otherwise the original
 * parse. Export must never assume Tailor was run.
 *
 * This is `selectCurrentResume` (currentResume.js), the same selection the ATS
 * score is recomputed against, so what Export prints and what Analyze scores
 * cannot be two different resumes.
 *
 * @param {unknown} state The AppContext state.
 * @returns {{ raw: object | null, source: 'tailored' | 'original' | null }}
 */
export const selectExportSource = selectCurrentResume;

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * "Jan 2021 – Present". The dates are transcribed text, not parsed dates, so
 * they are joined as written and never reformatted.
 */
export function formatDateRange(startDate, endDate, isCurrentlyWorking) {
  const start = clean(startDate);
  const current = isCurrentlyWorking === true || isCurrentlyWorking === 'true';
  const end = clean(endDate) || (current ? 'Present' : '');
  if (start && end) return `${start} – ${end}`;
  return start || end;
}

/**
 * Collapse any resume-shaped value into one fixed shape with every field a
 * trimmed string or an array of them. Entries with nothing printable are
 * dropped so a malformed parse produces a shorter resume, never an empty
 * heading or a throw.
 *
 * @param {unknown} raw
 */
export function normalizeResumeForExport(raw) {
  const resume = asObject(raw);
  const contact = asObject(resume.contact);

  return {
    name: clean(resume.name),
    contact: {
      email: clean(contact.email),
      phone: clean(contact.phone),
      location: clean(contact.location),
      links: cleanLinks(contact.customLinks),
    },
    summary: clean(resume.summary),

    experience: asArray(resume.experience)
      .map((value) => {
        const e = asObject(value);
        return {
          title: clean(e.title),
          company: clean(e.company),
          location: clean(e.location),
          dates: formatDateRange(e.startDate, e.endDate, e.isCurrentlyWorking),
          bullets: cleanList(e.bullets),
          links: cleanLinks(e.links),
        };
      })
      .filter((e) => e.title || e.company || e.bullets.length > 0),

    projects: asArray(resume.projects)
      .map((value) => {
        const p = asObject(value);
        return {
          name: clean(p.name),
          description: clean(p.description),
          bullets: cleanList(p.bullets),
          links: cleanLinks(p.links),
        };
      })
      .filter((p) => p.name || p.description || p.bullets.length > 0),

    skills: asArray(resume.skills)
      .map((value) => ({ category: clean(asObject(value).category), skills: cleanList(asObject(value).skills) }))
      .filter((group) => group.skills.length > 0),

    education: asArray(resume.education)
      .map((value) => {
        const ed = asObject(value);
        return {
          institution: clean(ed.institution),
          degree: clean(ed.degree),
          field: clean(ed.field),
          location: clean(ed.location),
          dates: formatDateRange(ed.startDate, ed.endDate, false),
          details: cleanList(ed.details),
        };
      })
      .filter((ed) => ed.institution || ed.degree || ed.field),

    certifications: asArray(resume.certifications)
      .map((value) => {
        const c = asObject(value);
        return { name: clean(c.name), issuer: clean(c.issuer), date: clean(c.date), url: clean(c.url) };
      })
      .filter((c) => c.name || c.issuer),
  };
}

/**
 * False when there is nothing worth rendering. Contact details alone do not
 * count -- a PDF holding only an email address is the "blank PDF" the empty
 * state exists to prevent.
 */
export function hasExportableContent(resume) {
  const r = asObject(resume);
  return Boolean(
    clean(r.name) ||
      clean(r.summary) ||
      asArray(r.experience).length ||
      asArray(r.projects).length ||
      asArray(r.skills).length ||
      asArray(r.education).length ||
      asArray(r.certifications).length
  );
}

// ---------------------------------------------------------------------------
// Shared layout vocabulary
//
// The PDF template and the plain-text copy both build their lines from these,
// so the two outputs cannot disagree about what a heading says.
// ---------------------------------------------------------------------------

/** Section order after the contact header. Standard ATS hierarchy. */
export const SECTION_ORDER = ['summary', 'experience', 'projects', 'skills', 'education', 'certifications'];

export const SECTION_TITLES = {
  summary: 'Summary',
  experience: 'Experience',
  projects: 'Projects',
  skills: 'Skills',
  education: 'Education',
  certifications: 'Certifications',
};

/** Does a normalised resume have anything in this section? */
export function sectionHasContent(resume, section) {
  const value = resume[section];
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

const join = (parts, separator) => parts.filter(Boolean).join(separator);

/** email | phone | location | every contact link url. */
export function contactParts(resume) {
  const c = resume.contact;
  return [c.email, c.phone, c.location, ...c.links.map((link) => link.url)].filter(Boolean);
}

export const roleHeading = (entry) => join([entry.title, entry.company], ' — ');
export const metaLine = (entry) => join([entry.location, entry.dates], ' | ');

/** "Bachelor of Science, Physics" -- the field is skipped when the degree already names it. */
export function degreeLine(entry) {
  const repeats = entry.field && entry.degree.toLowerCase().includes(entry.field.toLowerCase());
  return join([entry.degree, repeats ? '' : entry.field], ', ');
}

export const educationHeading = (entry) => join([degreeLine(entry), entry.institution], ' — ');
export const certificationHeading = (c) => join([c.name, join([c.issuer, c.date], ', ')], ' — ');
export const skillLine = (group) => (group.category ? `${group.category}: ` : '') + group.skills.join(', ');

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

/**
 * The resume as plain text, for application forms that only take a text box.
 *
 * Deliberately plain: uppercase headings, "- " bullets, blank lines between
 * blocks. No tabs, no box-drawing, no bullets that a form field might mangle.
 *
 * @param {ReturnType<typeof normalizeResumeForExport>} resume
 * @returns {string}
 */
export function generatePlainText(resume) {
  const blocks = [];
  const header = [resume.name, contactParts(resume).join(' | ')].filter(Boolean);
  if (header.length) blocks.push(header.join('\n'));

  const bulletLines = (items) => items.map((item) => `- ${item}`);

  for (const section of SECTION_ORDER) {
    if (!sectionHasContent(resume, section)) continue;
    const title = SECTION_TITLES[section].toUpperCase();
    const lines = [];

    switch (section) {
      case 'summary':
        lines.push(resume.summary);
        break;
      case 'experience':
        resume.experience.forEach((e, i) => {
          if (i > 0) lines.push('');
          lines.push(...[roleHeading(e), metaLine(e)].filter(Boolean), ...bulletLines(e.bullets));
          lines.push(...e.links.map((link) => link.url));
        });
        break;
      case 'projects':
        resume.projects.forEach((p, i) => {
          if (i > 0) lines.push('');
          lines.push(...[p.name, p.description].filter(Boolean), ...bulletLines(p.bullets));
          lines.push(...p.links.map((link) => link.url));
        });
        break;
      case 'skills':
        lines.push(...resume.skills.map(skillLine));
        break;
      case 'education':
        resume.education.forEach((ed, i) => {
          if (i > 0) lines.push('');
          lines.push(...[educationHeading(ed), metaLine(ed)].filter(Boolean), ...bulletLines(ed.details));
        });
        break;
      case 'certifications':
        resume.certifications.forEach((c) => {
          lines.push(certificationHeading(c));
          if (c.url) lines.push(c.url);
        });
        break;
      default:
        break;
    }

    blocks.push([title, ...lines].join('\n'));
  }

  return `${blocks.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// File name
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

/**
 * "Jane_Doe_Resume_2026-09-13.pdf". Accents are folded to ASCII; a name with
 * no Latin letters at all falls back to "Resume_<date>.pdf" rather than an
 * unreadable or empty filename. The template is deliberately not in the name:
 * the file goes to a recruiter, and "Jane_Doe_Resume_Formal.pdf" tells them
 * about the tool, not the candidate.
 *
 * @param {ReturnType<typeof normalizeResumeForExport>} resume
 * @param {Date} [date]
 */
export function buildResumeFileName(resume, date = new Date()) {
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const base = clean(asObject(resume).name)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return `${base ? `${base}_` : ''}Resume_${ymd}.pdf`;
}

// ---------------------------------------------------------------------------
// Font coverage
// ---------------------------------------------------------------------------

/**
 * The built-in PDF fonts (Helvetica, Times, Courier) cover the WinAnsi
 * (Windows-1252) character set and nothing else. A font the user imported in
 * Designer covers whatever its file covers, and react-pdf draws any character
 * it lacks in Helvetica instead. So a character comes out wrong only when
 * neither the chosen font nor WinAnsi has it. Rather than let it come out
 * silently wrong, the page names it.
 */
const WIN_ANSI_EXTRAS = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

function isWinAnsi(char) {
  const code = char.codePointAt(0);
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRAS.has(char);
}

function collectStrings(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out));
  else if (isPlainObject(value)) Object.values(value).forEach((item) => collectStrings(item, out));
}

/**
 * Distinct characters in the resume that the PDF cannot draw.
 *
 * @param {ReturnType<typeof normalizeResumeForExport>} resume
 * @param {{ coverage?: number[][] | null }} [font] An imported font's `[first, last]`
 *   code point ranges (fontById(...).coverage). Omitted for a built-in font.
 * @returns {string[]}
 */
export function findUnsupportedPdfCharacters(resume, { coverage = null } = {}) {
  const strings = [];
  collectStrings(resume, strings);
  const covered = (char) => {
    const cp = char.codePointAt(0);
    return Array.isArray(coverage) && coverage.some(([first, last]) => cp >= first && cp <= last);
  };
  const unsupported = new Set();
  for (const text of strings) {
    for (const char of text) {
      if (char !== '\n' && char !== '\t' && !isWinAnsi(char) && !covered(char)) unsupported.add(char);
    }
  }
  return [...unsupported];
}
