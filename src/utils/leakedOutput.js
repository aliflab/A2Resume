/**
 * Did the model write its own working into a resume field?
 *
 * THE PROBLEM THIS EXISTS TO SOLVE
 * -------------------------------
 * Observed on a real resume with no summary section: the parse came back as
 * valid json with every field in place, and `summary` held the header lines,
 * a page footer, the model thinking out loud ("Wait, no summary was present
 * as a distinct section. I will set summary to empty string as per
 * instructions"), the prompt's own "--- END RESUME ---" delimiter, and then a
 * fenced copy of the whole json answer. Tailor kept it, so it went on to the
 * editor and the PDF.
 *
 * `transcriptionFidelity.js` would warn about it -- most of those words are
 * not in the source -- but a warning is a diagnostic, and this is not a
 * borderline transcription. It is something that can never be resume content,
 * so it is removed in code rather than reported.
 *
 * WHAT COUNTS
 * -----------
 * Only text that has a recognisable shape: a code fence, a json object, the
 * prompt's delimiters, and a short list of phrases a model uses about its own
 * instructions. Each marker counts only when the matched text is NOT in the
 * source, so a resume that really says "followed the instructions" or quotes a
 * json snippet is left alone. In the summary, the candidate's own email or
 * phone number is a marker too: that is the header copied in, not a summary.
 *
 * WHAT IS DONE ABOUT IT
 * ---------------------
 * A whole field goes, not just the matched part. In the observed case nothing
 * before or after the marker was summary text either, and cutting at the
 * marker would keep the header lines and look like a real summary.
 */

const asArray = (v) => (Array.isArray(v) ? v : []);
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const asString = (v) => (typeof v === 'string' ? v : '');

/** Patterns that only ever come from a model talking about its own output. */
export const LEAK_MARKERS = [
  { id: 'code_fence', pattern: /```/ },
  { id: 'json_object', pattern: /\{\s*"[A-Za-z_][\w ]*"\s*:/ },
  { id: 'prompt_delimiter', pattern: /-{3}\s*(?:BEGIN|END)\s+RESUME/i },
  { id: 'instructions', pattern: /\b(?:as per|per the|according to the) (?:instructions?|schema)\b/i },
  // Not plain "the schema": a tailored bullet may well say "redesigned the schema".
  { id: 'schema', pattern: /\b(?:the|this) json schema\b|\bschema (?:says|requires|exactly)\b/i },
  { id: 'empty_string', pattern: /\b(?:set|return|leave)(?:ing)? (?:the )?(?:summary|field|it) (?:to |as )?(?:an )?empty string\b/i },
  { id: 'self_talk', pattern: /(?:^|[.!?]\s+)(?:Wait|Actually|Hmm|Okay|OK),\s/m },
  { id: 'lets', pattern: /\blet(?:'|’)s (?:follow|keep|set|use|output|return)\b/i },
  { id: 'output_talk', pattern: /\b(?:json output|output is generated|raw block|omitting for)\b/i },
];

/**
 * The first marker in `text` whose matched words are not in the source, or null.
 *
 * @param {unknown} text
 * @param {unknown} sourceText
 * @param {{ contact?: string[] }} [options] contact details that must not appear (summary only)
 * @returns {string | null} the marker id
 */
export function findLeak(text, sourceText, { contact = [] } = {}) {
  const value = asString(text);
  if (!value.trim()) return null;
  const source = asString(sourceText).toLowerCase();
  for (const { id, pattern } of LEAK_MARKERS) {
    const match = value.match(pattern);
    if (match && !source.includes(match[0].toLowerCase().trim())) return id;
  }
  for (const detail of contact) {
    const d = asString(detail).trim();
    if (d.length >= 6 && value.includes(d)) return 'contact_details';
  }
  return null;
}

/** The candidate's email and phone: in a summary they mean the header was copied in. */
export function contactDetails(resume) {
  const contact = asObject(asObject(resume).contact);
  return [contact.email, contact.phone];
}

/**
 * Remove leaked fields from a parsed resume: a summary or project description
 * is emptied, a bullet or education detail is dropped. Never mutates the input,
 * never throws.
 *
 * @param {unknown} parsedResume
 * @param {unknown} sourceText the text the model was given
 * @returns {{ resume: object, removed: { path: string, marker: string, text: string }[] }}
 */
export function scrubLeakedFields(parsedResume, sourceText) {
  const resume = asObject(parsedResume);
  const removed = [];
  const leak = (path, value, options) => {
    const marker = findLeak(value, sourceText, options);
    if (marker) removed.push({ path, marker, text: asString(value) });
    return marker !== null;
  };
  const keepLines = (list, path) => asArray(list).filter((line, j) => !leak(`${path}[${j}]`, line));

  const out = { ...resume };
  if (leak('summary', resume.summary, { contact: contactDetails(resume) })) out.summary = '';
  if (Array.isArray(resume.experience)) {
    out.experience = resume.experience.map((entry, i) => {
      const e = asObject(entry);
      return Array.isArray(e.bullets) ? { ...e, bullets: keepLines(e.bullets, `experience[${i}].bullets`) } : entry;
    });
  }
  if (Array.isArray(resume.projects)) {
    out.projects = resume.projects.map((entry, i) => {
      const p = { ...asObject(entry) };
      if (leak(`projects[${i}].description`, p.description)) p.description = '';
      if (Array.isArray(p.bullets)) p.bullets = keepLines(p.bullets, `projects[${i}].bullets`);
      return p;
    });
  }
  if (Array.isArray(resume.education)) {
    out.education = resume.education.map((entry, i) => {
      const e = asObject(entry);
      return Array.isArray(e.details) ? { ...e, details: keepLines(e.details, `education[${i}].details`) } : entry;
    });
  }
  return { resume: removed.length > 0 ? out : resume, removed };
}

/** Every string in a value, joined: the "source" when the model was given json rather than text. */
export function stringsOf(value) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return out.join('\n');
}
