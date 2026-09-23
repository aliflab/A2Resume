/**
 * The letter -> the shape the PDF template and the plain-text copy both read.
 *
 * WHY A PARALLEL NORMALISER AND NOT `normalizeResumeForExport`
 * -----------------------------------------------------------
 * Checked rather than assumed. `normalizeResumeForExport` is hard-bound to the
 * resume's eight sections: it returns exactly `name`, `contact`, `summary`,
 * `experience`, `projects`, `skills`, `education`, `certifications`, and every
 * entry it keeps must survive a `.filter()` that looks for a title, a company or
 * a bullet. There is no key a letter body could travel in, and its
 * `SECTION_ORDER` / `sectionHasContent` / line-builder machinery describes a
 * document made of repeating entries, which a letter is not. Bending it to carry
 * prose would mean adding a ninth section that every existing consumer has to
 * ignore, for one page.
 *
 * So this is a parallel normaliser, deliberately much smaller -- one object, no
 * sections, no ordering. What IS reused rather than rebuilt:
 *
 *   - `contactParts` and `normalizeResumeForExport` for the letterhead, so the
 *     name and contact line on the letter are formatted by exactly the code
 *     that formats them on the resume. Two documents from one session must not
 *     disagree about how the candidate's phone number is written.
 *   - `findUnsupportedPdfCharacters` unchanged. It walks every string in
 *     whatever it is given (`collectStrings` recurses on plain objects and
 *     arrays) and is shape-agnostic, so it works on a letter as-is. Verified,
 *     not assumed -- see `coverLetter.manual.js`.
 *
 * THE BODY IS THE SOURCE OF TRUTH
 * The letter is stored as one plain-text string with blank lines between
 * blocks, and this reads that structure back out. That is what lets a single
 * plain-text textarea be an honest editor: the user edits the exact string the
 * PDF is built from, so there is no second representation to drift.
 */

import { asArray, asObject, asString } from './gapAnalyzer.js';
import { contactParts, normalizeResumeForExport } from './resumeExport.js';

const clean = (value) => asString(value).replace(/\s+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');

/**
 * Blocks of the body, split on blank lines: `[greeting, ...paragraphs, signoff]`.
 *
 * Tolerant on purpose. The user can delete the greeting, run everything into
 * one block, or paste something with Windows line endings, and this must still
 * produce a printable letter rather than throwing or losing text. When there
 * are fewer than three blocks nothing is treated as a greeting or a sign-off --
 * every block is body, which prints the user's text verbatim instead of
 * silently promoting their first sentence into a salutation.
 *
 * @param {unknown} body
 */
export function splitLetterBlocks(body) {
  const blocks = asString(body)
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((block) => block.replace(/[ \t]+$/gm, '').trim())
    .filter(Boolean);

  if (blocks.length === 0) return { greeting: '', paragraphs: [], signoff: '' };
  if (blocks.length < 3) return { greeting: '', paragraphs: blocks, signoff: '' };
  return { greeting: blocks[0], paragraphs: blocks.slice(1, -1), signoff: blocks[blocks.length - 1] };
}

/**
 * "23 September 2026". Spelled out rather than numeric so it cannot be read as
 * the wrong date order in a different country, which is the one thing a date on
 * a letter has to get right.
 */
export function formatLetterDate(date = new Date()) {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

/**
 * One fixed shape of trimmed strings and string arrays, from a stored
 * `coverLetter` slice and the resume it belongs to.
 *
 * Everything downstream -- the template, the plain text, the filename, the font
 * check -- reads only this, exactly as everything on the resume side reads only
 * `normalizeResumeForExport`'s output.
 *
 * The letterhead is derived here rather than stored, so it can never be stale
 * relative to the resume. The cost, stated in the UI: editing the body does not
 * let you edit the letterhead, because the letterhead is not part of the body.
 *
 * @param {unknown} coverLetter the stored `state.coverLetter`
 * @param {unknown} resume the current resume
 * @param {unknown} parsedJD used for the addressee block only
 * @param {Date} [date]
 */
export function normalizeCoverLetterForExport(coverLetter, resume, parsedJD, date = new Date()) {
  const letter = asObject(coverLetter);
  const jd = asObject(parsedJD);
  const normalisedResume = normalizeResumeForExport(resume);
  const { greeting, paragraphs, signoff } = splitLetterBlocks(letter.body);

  return {
    name: normalisedResume.name,
    // Formatted by the resume's own contact line builder, so the two documents
    // cannot disagree about the candidate's details.
    contactLine: contactParts(normalisedResume).join(' | '),
    date: formatLetterDate(date),
    company: clean(jd.company),
    jobTitle: clean(jd.jobTitle),
    greeting,
    // Internal newlines inside a block are the user's own line breaks and are
    // kept; a PDF paragraph reflows anyway, and the plain text should look like
    // what was in the textarea.
    paragraphs: paragraphs.map((p) => p.replace(/\n+/g, ' ').trim()).filter(Boolean),
    signoff,
  };
}

/** False when there is no letter worth rendering. A letterhead alone is not a letter. */
export function hasExportableLetter(normalised) {
  const n = asObject(normalised);
  return asArray(n.paragraphs).length > 0 || Boolean(clean(n.greeting)) || Boolean(clean(n.signoff));
}

/**
 * The letter as plain text, for an application form with a text box and no
 * upload. Uppercase headings and `- ` bullets would be wrong here -- a letter is
 * prose -- so this is the letterhead, a blank line, and the body as written.
 *
 * @param {ReturnType<typeof normalizeCoverLetterForExport>} normalised
 * @param {{ includeLetterhead?: boolean }} [options]
 */
export function generateCoverLetterPlainText(normalised, { includeLetterhead = true } = {}) {
  const n = asObject(normalised);
  const blocks = [];

  if (includeLetterhead) {
    const head = [clean(n.name), clean(n.contactLine)].filter(Boolean).join('\n');
    if (head) blocks.push(head);
    if (clean(n.date)) blocks.push(clean(n.date));
    const addressee = [clean(n.company) ? `${clean(n.company)}` : '', clean(n.jobTitle) ? `Re: ${clean(n.jobTitle)}` : '']
      .filter(Boolean)
      .join('\n');
    if (addressee) blocks.push(addressee);
  }

  if (clean(n.greeting)) blocks.push(clean(n.greeting));
  for (const paragraph of asArray(n.paragraphs)) if (clean(paragraph)) blocks.push(clean(paragraph));
  if (asString(n.signoff).trim()) blocks.push(asString(n.signoff).trim());

  return `${blocks.join('\n\n')}\n`;
}

/**
 * "Jane_Doe_Cover_Letter_2026-09-23.pdf".
 *
 * Same rules as `buildResumeFileName`: accents folded to ASCII, a name with no
 * Latin letters falls back to a nameless filename rather than an unreadable one.
 * Not a call to that function, because it hard-codes the word "Resume" -- a
 * cover letter downloaded as `Jane_Doe_Resume_...pdf` is a genuine problem for
 * someone attaching two files to one application.
 *
 * @param {{ name?: string }} normalised
 * @param {Date} [date]
 */
export function buildCoverLetterFileName(normalised, date = new Date()) {
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const base = clean(asObject(normalised).name)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return `${base ? `${base}_` : ''}Cover_Letter_${ymd}.pdf`;
}
