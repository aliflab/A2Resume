/**
 * Did the model transcribe the source, or did it quietly rewrite it?
 *
 * THE PROBLEM THIS EXISTS TO SOLVE
 * -------------------------------
 * Observed in production: a resume reading "work experience in the logistic
 * and customer service industry" was parsed with a `summary` reading "work
 * experience in the logistic and retail industry". "customer service" became
 * "retail". Nothing was missing, the json was well-formed, every other field
 * was populated and correct, and no existing check noticed -- the url check
 * looks for urls, the bullet check looks at a 40-character prefix, and the
 * year check looks for dates. A single substituted content word in the middle
 * of a populated field is invisible to all three.
 *
 * This is a different failure from the one `resumeParser.js`'s "NEVER INVENT"
 * rule was written against. That rule guards against content appearing from
 * nothing -- a date, an employer, a degree the source never mentioned. This is
 * *true content being altered while it is copied*: the claim stays plausible,
 * stays the same shape, and reads perfectly. It is more dangerous precisely
 * because it does not look wrong. A candidate whose background is customer
 * service is now applying with a resume that says retail.
 *
 * ONE SOURCE, TWO CONSUMERS
 * -------------------------
 * Same structure as `jdKeywordExclusions.js`, for the same reason: a prompt
 * rule and a code check maintained separately drift apart silently.
 *
 *   1. `resumeParser.js` renders `buildTranscriptionPromptSection()` into
 *      RESUME_SYSTEM_PROMPT, so the model is asked not to do this at all.
 *      This is the layer that does the real work.
 *   2. `parseResumeWithAI` calls `checkTranscriptionFidelity()` on the result
 *      and returns `fidelityWarnings`, as a backstop for when the prompt-level
 *      instruction fails -- on an unfamiliar provider, an unfamiliar phrasing,
 *      or a model that simply drifts. `parsers.manual.js` prints the same
 *      warnings next to the existing fidelity heuristics.
 *
 * `PROMPT_EXAMPLES` are asserted against the checker at module load, so an
 * example the checker would not catch is a contradiction between the two
 * layers and fails loudly rather than rotting.
 *
 * WHAT THIS CHECK CAN AND CANNOT DO
 * ---------------------------------
 * It is a word-presence test, not a semantic one. It asks: does every content
 * word in this transcribed field actually occur somewhere in the source text?
 * That catches substitution ("retail" for "customer service") because the
 * substituted word is new. It does **not** catch reordering, deletion, or a
 * substitution that happens to reuse a word from elsewhere in the source -- a
 * summary that swaps two real employers' descriptions would pass clean.
 *
 * So a warning is strong evidence of a problem; a clean result is weak
 * evidence of correctness. It is deliberately tuned that way: the check runs
 * on every parse, and a false alarm that makes someone read their own summary
 * costs a few seconds, while a missed substitution ships a false resume.
 */

// ---------------------------------------------------------------------------
// Tokenisation
//
// NOT `normaliseSkill` from skillSynonyms.js (which strips every separator and
// would weld a phrase into one token) and NOT `normalisePhrase` from
// jdKeywordExclusions.js (which is phrase-level). This is word-level: the unit
// of the failure being detected is a single substituted word.
// ---------------------------------------------------------------------------

/**
 * Function words carry no evidence about content, and a model reflowing a
 * sentence legitimately changes them. Only content words are compared.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'his', 'i', 'in', 'into', 'is', 'it', 'its',
  'my', 'of', 'on', 'or', 'our', 's', 'she', 'that', 'the', 'their', 'them',
  'they', 'this', 'to', 'was', 'were', 'while', 'with', 'within', 'you', 'your',
]);

/**
 * Lowercase, split on anything that is not a letter, digit, +, # or . -- the
 * same characters `skillSynonyms.normaliseSkill` protects, so "C++", "C#" and
 * "Node.js" survive as single tokens rather than fragmenting into noise.
 *
 * Both the source and the parsed field go through this identically, so any
 * mangling it does is applied to both sides and cannot create a false alarm on
 * its own.
 *
 * @param {unknown} text
 * @returns {string[]} content tokens, stopwords and single characters removed
 */
export function tokeniseContent(text) {
  if (typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((token) => token.replace(/^\.+|\.+$/g, ''))
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/**
 * Crude singular/plural fold, in the same spirit as `actionVerbs.isStrongVerb`
 * de-inflecting crudely on purpose. A source saying "industry" and a summary
 * saying "industries" is a reflow, not a substitution, and flagging it would
 * train people to ignore the warning -- which is the only way this check
 * actually fails.
 *
 * @param {string} token
 * @returns {string[]} forms to try against the source index
 */
function inflections(token) {
  const forms = [token];
  if (token.endsWith('ies') && token.length > 4) forms.push(`${token.slice(0, -3)}y`);
  if (token.endsWith('es') && token.length > 3) forms.push(token.slice(0, -2));
  if (token.endsWith('s') && token.length > 2) forms.push(token.slice(0, -1));
  else forms.push(`${token}s`);
  return forms;
}

/**
 * Every content word the source text contains, in every form the fold accepts.
 *
 * @param {unknown} sourceText
 * @returns {Set<string>}
 */
export function buildSourceIndex(sourceText) {
  const index = new Set();
  for (const token of tokeniseContent(sourceText)) {
    for (const form of inflections(token)) index.add(form);
  }
  return index;
}

/**
 * Content words in `text` that occur nowhere in the source.
 *
 * @param {unknown} text
 * @param {Set<string>} sourceIndex
 * @returns {string[]} unique, in order of first appearance
 */
export function findUnsupportedWords(text, sourceIndex) {
  const unsupported = [];
  const seen = new Set();
  for (const token of tokeniseContent(text)) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (!inflections(token).some((form) => sourceIndex.has(form))) unsupported.push(token);
  }
  return unsupported;
}

// ---------------------------------------------------------------------------
// Which fields this applies to
//
// Every free-text field the parser is supposed to COPY rather than compose.
// Structured fields (dates, company, title, email) are left out: they are
// short, and the existing "NEVER INVENT" checks and the reader's own eye cover
// them. `skills` is left out too -- a skills line is a list of terms, and the
// model is explicitly allowed to bucket it into categories it names itself.
// ---------------------------------------------------------------------------

const asArray = (v) => (Array.isArray(v) ? v : []);
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/**
 * Walk a parsed resume and yield every field that should be a verbatim copy.
 *
 * @param {unknown} parsedResume
 * @returns {{ path: string, text: string }[]}
 */
export function collectTranscribedFields(parsedResume) {
  const resume = asObject(parsedResume);
  const fields = [];
  const push = (path, value) => {
    if (typeof value === 'string' && value.trim() !== '') fields.push({ path, text: value });
  };

  push('summary', resume.summary);

  asArray(resume.experience).forEach((entry, i) => {
    asArray(asObject(entry).bullets).forEach((bullet, j) => {
      push(`experience[${i}].bullets[${j}]`, bullet);
    });
  });

  asArray(resume.projects).forEach((entry, i) => {
    const project = asObject(entry);
    push(`projects[${i}].description`, project.description);
    asArray(project.bullets).forEach((bullet, j) => {
      push(`projects[${i}].bullets[${j}]`, bullet);
    });
  });

  asArray(resume.education).forEach((entry, i) => {
    asArray(asObject(entry).details).forEach((detail, j) => {
      push(`education[${i}].details[${j}]`, detail);
    });
  });

  return fields;
}

/**
 * Check a whole parsed resume against the text it was extracted from.
 *
 * Pure and network-free, like the analysis services. Defensive in the same way:
 * a malformed parse must produce fewer warnings, never a throw.
 *
 * @param {unknown} sourceText The raw resume text handed to the parser.
 * @param {unknown} parsedResume
 * @returns {{ path: string, text: string, unsupportedWords: string[] }[]}
 */
export function checkTranscriptionFidelity(sourceText, parsedResume) {
  if (typeof sourceText !== 'string' || sourceText.trim() === '') return [];
  const sourceIndex = buildSourceIndex(sourceText);

  return collectTranscribedFields(parsedResume)
    .map(({ path, text }) => ({ path, text, unsupportedWords: findUnsupportedWords(text, sourceIndex) }))
    .filter((warning) => warning.unsupportedWords.length > 0);
}

/**
 * One-line summary for logs and, later, for the UI.
 *
 * @param {{ path: string, unsupportedWords: string[] }} warning
 * @returns {string}
 */
export function describeFidelityWarning(warning) {
  const words = warning.unsupportedWords.map((w) => `"${w}"`).join(', ');
  return `${warning.path}: ${words} ${warning.unsupportedWords.length === 1 ? 'does' : 'do'} not appear in your original resume.`;
}

// ---------------------------------------------------------------------------
// The prompt half of the same rule
// ---------------------------------------------------------------------------

/**
 * Real substitutions, kept next to the checker that must catch them. The first
 * is the production failure this module was written for.
 *
 * Each is `{ source, wrong, why }` where `wrong` is what the model returned
 * for a field copied from `source`.
 */
export const PROMPT_EXAMPLES = [
  {
    source: 'Work experience in the logistic and customer service industry.',
    wrong: 'Work experience in the logistic and retail industry.',
    why: '"customer service" was replaced with "retail" -- a different industry',
  },
  {
    source: 'Managed a portfolio of 12 wholesale accounts.',
    wrong: 'Managed a portfolio of 12 enterprise accounts.',
    why: '"wholesale" was replaced with "enterprise" -- a different market',
  },
  {
    source: 'Assisted the finance team with month-end reconciliation.',
    wrong: 'Supported the finance team with month-end reconciliation.',
    why: '"Assisted" was replaced with "Supported" -- a synonym swap, still wrong',
  },
];

/**
 * The prompt section. Rendered into RESUME_SYSTEM_PROMPT so the wording the
 * model is given and the rule the code enforces cannot drift apart.
 *
 * @returns {string}
 */
export function buildTranscriptionPromptSection() {
  const examples = PROMPT_EXAMPLES.map(
    (ex) => `- Source: "${ex.source}"\n  WRONG:  "${ex.wrong}"\n  Why:    ${ex.why}.`
  ).join('\n');

  return `NEVER ALTER TRUE CONTENT
This is a separate rule from NEVER INVENT, and it is the one most often broken.
NEVER INVENT is about content appearing out of nothing. This rule is about true
content being changed while you copy it. Both produce a false resume.

- Do not substitute a synonym for a word the source used. Not a better word, not
  a more common word, not a more professional word. The source's word.
- Do not swap a term for a related one from a neighbouring domain. "customer
  service" is not "retail". "wholesale" is not "enterprise". "logistics" is not
  "supply chain". These describe different work and different careers.
- Do not generalise a specific term or specialise a general one.
- summary, bullets, project descriptions and education details are COPIED
  fields. If the source has a summary, reproduce that summary's words. If the
  source has no summary, return an empty string -- never compose one.
- Every content word you write in these fields must be a word that appears in
  the source. If you find yourself choosing a word, you have already left
  transcription and are writing, which is not your task.

Examples of exactly the failure this rule forbids:
${examples}

The output is checked against the source for words that never appeared in it.`;
}

// ---------------------------------------------------------------------------
// Load-time contradiction check
//
// Same discipline as jdKeywordExclusions' PROMPT_EXAMPLES assertion: an example
// the prompt names but the checker misses means the two layers disagree, and
// the disagreement would otherwise only show up as a slow return of the bug.
// ---------------------------------------------------------------------------

for (const example of PROMPT_EXAMPLES) {
  const index = buildSourceIndex(example.source);
  if (findUnsupportedWords(example.wrong, index).length === 0) {
    console.warn(
      `[transcriptionFidelity] PROMPT_EXAMPLES entry is not caught by the checker: "${example.wrong}". ` +
        'The prompt rule and the code check disagree.'
    );
  }
}
