/**
 * Current resume + parsed JD -> a cover letter, plus a grounding report.
 *
 * WHERE THIS SITS AMONG THE OTHER AI SERVICES
 * -------------------------------------------
 * `resumeParser.js` transcribes and must never invent. `resumeTailor.js`
 * rewrites prose that already exists, additively, with
 * `mergeNonDestructiveResume` enforcing the structural half in code.
 * `skillInference.js` infers freely but only *proposes*, and a human approves
 * each item. This one writes brand-new prose with no per-item approval gate,
 * from a source it is the only reader of.
 *
 * So the discipline is split the same way, deliberately:
 *
 *   1. The prompt forbids naming anything the resume does not contain, via
 *      `buildGroundingPromptSection()`.
 *   2. `checkCoverLetterGrounding()` tests the actual output against the actual
 *      resume, whether or not the prompt was followed, and its result travels
 *      with the letter.
 *
 * Layer 2 cannot be complete -- a letter is prose, not a transcription, and
 * `coverLetterGrounding.js` states plainly what it does and does not catch.
 * Read that before treating a clean result as proof.
 *
 * WHY THE LETTER IS GENERATED STRUCTURED AND STORED AS PLAIN TEXT
 * --------------------------------------------------------------
 * `callStructured` is the only way to call a provider here, and asking for
 * `{ greeting, paragraphs[], closing, signature }` is what stops the model
 * returning markdown headings, bullet lists and "Here is your cover letter:"
 * preamble -- all of which it does when asked for free text. The parts are then
 * joined into ONE plain-text body, which is the single source of truth for the
 * editor, the plain-text copy and the PDF. One string cannot drift from itself,
 * and it is what makes a single editable textarea honest: what you edit is
 * exactly what you export.
 *
 * Changes what a stored session would contain for the same input? Bump
 * ARTEFACT_VERSION in sessionPersistence.js, so restored results are flagged.
 */

import { callStructured } from './aiService.js';
import { asArray, asObject, asString } from './gapAnalyzer.js';
import { buildExclusionPromptSection } from '../utils/jdKeywordExclusions.js';
import { buildGroundingPromptSection, checkCoverLetterGrounding } from '../utils/coverLetterGrounding.js';
import { fingerprint, isStaleAgainst } from '../utils/artefactFingerprint.js';

/**
 * Cover letter generation gets its own timeout rather than the shared 20s
 * default, on the same reasoning as `RESUME_PARSE_TIMEOUT_MS` (90s) and
 * `TAILOR_TIMEOUT_MS` (150s): the shared default was set for a small, fast
 * extraction and this is neither.
 *
 * NOT YET MEASURED AGAINST A LIVE PROVIDER. This value is reasoned, and the
 * reasoning is written down so the first real measurement can correct it rather
 * than inherit it. Do not cite it as measured until `coverLetter.manual.js`'s
 * `liveGenerate()` has been run -- it prints the wall time for exactly this
 * purpose, and the numbers belong here once they exist.
 *
 * The reasoning: the input is the whole resume json plus the posting's
 * requirements, which is the same order of magnitude as the tailoring call's
 * input, and the output is several hundred words of prose written with adaptive
 * thinking on by default, drawing from the same token budget. That is plainly
 * not the small, fast extraction the shared 20s default was set for -- the
 * resume parser needed 90s for a comparable input and failed 3/3 on 20s.
 *
 * 60s is well clear of the parser's *median* measured runs (Claude 16.7 / 9.1 /
 * 6.9s, Gemini 25.2 / 6.4 / 43.4s on a real resume, 2026-09-13) while staying
 * far below TAILOR_TIMEOUT_MS, because this returns one letter rather than an
 * entire resume object plus a changelog entry per edit. If a real run comes in
 * near 60s, raise this -- and note that the worst-case wall time of one
 * generation is up to one full timeout per model in the provider's list.
 *
 * Note this is per REQUEST, not per call: `runWithFallback` starts a fresh
 * timer for each model attempt, so a fallthrough never eats into the next
 * model's budget. What grows with the model list is the worst-case wall time of
 * one generation.
 */
export const COVER_LETTER_TIMEOUT_MS = 60_000;

/**
 * Claude effort for the cover letter (see AI_EFFORT_LEVELS in aiService.js).
 * "medium": prose written under a grounding rule, where quality is visible to
 * the reader. The grounding check still runs on every result, so a lower tier
 * cannot quietly let a fabrication through.
 */
export const COVER_LETTER_EFFORT = 'medium';

// ---------------------------------------------------------------------------
// Tone and length
//
// Both are REAL generation parameters, not adjectives dropped into one shared
// prompt. Each carries the instruction that makes it mean something, so
// "concise" actually removes sentences rather than being a word the model reads
// and ignores.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ToneSpec
 * @property {string} id
 * @property {string} label       for the UI
 * @property {string} hint        one line, for the UI
 * @property {string} instruction rendered into the prompt
 */

/** @type {ToneSpec[]} */
export const TONES = [
  {
    id: 'formal',
    label: 'Formal',
    hint: 'Traditional and restrained. Safest for finance, government, law, healthcare and large corporates.',
    instruction: `TONE: FORMAL
Write in a traditional, professional register.
- Open with "Dear Hiring Manager," unless the posting names a person.
- Use complete, measured sentences. No contractions: write "I have", not "I've".
- No exclamation marks. No rhetorical questions. No "I'm thrilled" or "I'd love to".
- Refer to the organisation by name rather than as "you guys" or "your team".
- Close with "Sincerely," and the candidate's name.
- Reserved does not mean vague. Be specific about what the candidate has done.`,
  },
  {
    id: 'warm',
    label: 'Warm',
    hint: 'Human and direct, still professional. Suits startups, agencies, product and design teams.',
    instruction: `TONE: WARM
Write as one person writing to another, while staying professional.
- Open with "Dear Hiring Manager," unless the posting names a person.
- Contractions are fine. First person throughout. Plain words over corporate ones.
- Show genuine, specific interest in what this organisation actually does, drawn from the posting -- never generic flattery, and never "I am passionate about" or "I have always dreamed of".
- At most one exclamation mark in the whole letter, and only if it is earned.
- Close with "Best regards," and the candidate's name.
- Warmth comes from directness and specificity, not from enthusiasm adjectives.`,
  },
  {
    id: 'concise',
    label: 'Concise',
    hint: 'Stripped to the argument. Best when a recruiter is reading fifty of these.',
    instruction: `TONE: CONCISE
Write the shortest letter that still makes the case.
- Open with "Dear Hiring Manager," unless the posting names a person.
- Every sentence must carry new information. Delete any sentence that only restates the role or announces that the candidate is applying.
- No preamble. The first sentence after the greeting states what the candidate does and why it fits this role.
- No summary sentence at the end repeating what was already said.
- Close with "Regards," and the candidate's name.
- Concise means fewer sentences, not compressed unreadable ones.`,
  },
];

/**
 * @typedef {object} LengthSpec
 * @property {string} id
 * @property {string} label
 * @property {string} hint
 * @property {number} minWords
 * @property {number} maxWords
 * @property {number} paragraphs body paragraphs, excluding greeting and closing
 * @property {string} instruction
 */

/**
 * Word counts are stated as a hard range AND as a paragraph count, because a
 * word budget alone is routinely ignored while a paragraph count is not. The
 * two together are what make "short" reliably shorter than "long".
 *
 * @type {LengthSpec[]}
 */
export const LENGTHS = [
  {
    id: 'short',
    label: 'Short',
    hint: 'About 150 words, 2 paragraphs. A note, not an essay.',
    minWords: 110,
    maxWords: 190,
    paragraphs: 2,
    instruction: '',
  },
  {
    id: 'medium',
    label: 'Medium',
    hint: 'About 250 words, 3 paragraphs. The default for most applications.',
    minWords: 200,
    maxWords: 320,
    paragraphs: 3,
    instruction: '',
  },
  {
    id: 'long',
    label: 'Long',
    hint: 'About 400 words, 4 paragraphs. Only when there is genuinely more to say.',
    minWords: 330,
    maxWords: 470,
    paragraphs: 4,
    instruction: '',
  },
];

// The instruction is derived from the numbers rather than retyped beside them,
// so a budget can never disagree with the prose describing it.
for (const spec of LENGTHS) {
  spec.instruction = `LENGTH: ${spec.label.toUpperCase()} -- THIS IS A CONSTRAINT, NOT A SUGGESTION
- Exactly ${spec.paragraphs} body ${spec.paragraphs === 1 ? 'paragraph' : 'paragraphs'} in "paragraphs". Not ${spec.paragraphs + 1}. Not ${spec.paragraphs - 1}.
- Between ${spec.minWords} and ${spec.maxWords} words across those paragraphs in total, excluding the greeting, the closing and the signature.
- If you are over, cut the weakest claim entirely rather than shortening every sentence.
- If you are under, add one more specific piece of evidence from the resume rather than padding with adjectives.`;
}

export const TONE_IDS = TONES.map((t) => t.id);
export const LENGTH_IDS = LENGTHS.map((l) => l.id);
export const DEFAULT_TONE = 'warm';
export const DEFAULT_LENGTH = 'medium';

export const getTone = (id) => TONES.find((t) => t.id === id) ?? TONES.find((t) => t.id === DEFAULT_TONE);
export const getLength = (id) => LENGTHS.find((l) => l.id === id) ?? LENGTHS.find((l) => l.id === DEFAULT_LENGTH);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Flat, shallow, and free of the keywords providers disagree on -- no `$ref`,
 * no `anyOf`, no `minimum`/`maxLength`, no `minItems > 1`. Gemini's
 * `responseSchema` subset and Anthropic's structured-output restrictions are
 * the binding constraints; the shared adapters in `aiService` handle the rest.
 *
 * The word and paragraph budgets are NOT expressed here as schema constraints
 * precisely because of that: `minItems`/`maxItems` are exactly the kind of
 * keyword the adapters cannot carry across all five providers. They live in the
 * prompt, and `enforceLength` reports in code when they were not honoured.
 */
export const COVER_LETTER_SCHEMA = {
  type: 'object',
  properties: {
    greeting: { type: 'string' },
    paragraphs: { type: 'array', items: { type: 'string' } },
    closing: { type: 'string' },
    signature: { type: 'string' },
  },
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * The system prompt for one tone and one length.
 *
 * Built per call rather than being one constant with the tone mentioned in
 * passing. That is the difference between a parameter and a hint: the formal
 * and concise prompts give genuinely different instructions about contractions,
 * openings and sentence economy, and a single prompt with "tone: concise"
 * appended reliably produces the same letter three times.
 *
 * No worked example of a GOOD letter appears here, the same rule the parser and
 * tailor prompts follow: a sample paragraph teaches the model to produce
 * paragraphs of that shape rather than paragraphs grounded in this candidate's
 * material. The only examples shown are the counter-examples from
 * `buildGroundingPromptSection()`, which cannot be imitated because they
 * demonstrate what not to write.
 */
export function buildCoverLetterSystemPrompt({ tone, length } = {}) {
  const toneSpec = getTone(tone);
  const lengthSpec = getLength(length);

  return `You are helping one real person write one cover letter for one specific job. You are not a copywriter and you are not marketing. You are making an honest, specific case from material you have been given.

${buildGroundingPromptSection()}

WHAT THE LETTER HAS TO DO
Connect this candidate's real experience to what this posting actually asks for.
- Pick the two or three strongest genuine overlaps and write about those. A letter that gestures at everything says nothing.
- Where the candidate has plainly done what the posting describes but called it something else, use the posting's term and describe the candidate's actual work.
- Where the posting asks for something the candidate does not have, say nothing about it. Do not hedge, do not promise to learn it, do not imply it. A real gap left unmentioned is far better than a claimed skill.
- Prefer a concrete thing the candidate built, shipped, ran or fixed over any adjective about them.

NEVER RECITE THE POSTING'S OWN LANGUAGE BACK
A posting's "what we offer" and "who you are" sections are not descriptions of this candidate. Do not work any of the following into the letter as though it were a qualification:
${buildExclusionPromptSection()}
These are things an employer offers, or things any person could claim about themselves without evidence. "I have a positive attitude and a strong work ethic" tells a reader nothing and costs you the paragraph it sits in.

${toneSpec.instruction}

${lengthSpec.instruction}

STRUCTURE
- greeting: the salutation line only, for example "Dear Hiring Manager,".
- paragraphs: the body, one string per paragraph. Plain prose only -- no bullet points, no markdown, no headings, no bold, no numbered lists.
- closing: the sign-off line only, for example "Sincerely,".
- signature: the candidate's name exactly as the resume gives it, and nothing else.
Do not put the date, the candidate's address, the employer's address or any letterhead in any field. Those are added around your text.

Return only the json object. No prose, no commentary, no code fences.`;
}

// ---------------------------------------------------------------------------
// Assembling the body
// ---------------------------------------------------------------------------

/** Markdown the model was told not to emit, removed rather than shown to the user. */
function stripMarkdown(text) {
  return asString(text)
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/`{1,3}/g, '')
    .trim();
}

const collapse = (text) => stripMarkdown(text).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();

/**
 * The model's parts as one plain-text body: greeting, blank line, each
 * paragraph separated by a blank line, blank line, closing, newline, signature.
 *
 * Blank-line separation is the only structure the body carries, and it is what
 * `normalizeCoverLetterForExport` reads back out. That makes the format
 * round-trip through a plain textarea without losing anything, which is the
 * whole reason editing is one textarea this session.
 *
 * @param {unknown} data the model's structured response
 * @param {unknown} resume used only to fall back to the candidate's name
 * @returns {string}
 */
export function assembleLetterBody(data, resume) {
  const d = asObject(data);
  const greeting = collapse(d.greeting) || 'Dear Hiring Manager,';
  const paragraphs = asArray(d.paragraphs).map(collapse).filter(Boolean);
  const closing = collapse(d.closing) || 'Sincerely,';
  const signature = collapse(d.signature) || asString(asObject(resume).name).trim();

  const blocks = [greeting, ...paragraphs, closing ? `${closing}\n${signature}`.trim() : signature];
  return blocks.filter(Boolean).join('\n\n');
}

/** Body paragraphs only -- what the word and paragraph budgets are measured against. */
export function bodyParagraphs(letterBody) {
  const blocks = asString(letterBody)
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  // First block is the greeting, last is the closing plus signature.
  return blocks.length <= 2 ? [] : blocks.slice(1, -1);
}

export const countWords = (text) => asString(text).trim().split(/\s+/).filter(Boolean).length;

/**
 * Whether the model actually honoured the length it was given.
 *
 * Reported rather than enforced by truncation: cutting a letter mid-argument to
 * hit a word count produces something worse than a letter 40 words over. Same
 * choice as `callStructured` returning `fenced` and `salvaged` -- a diagnostic
 * that says the prompt needs work on this provider, not a silent repair.
 *
 * @returns {{ words: number, paragraphs: number, withinWords: boolean, withinParagraphs: boolean, ok: boolean }}
 */
export function enforceLength(letterBody, length) {
  const spec = getLength(length);
  const paras = bodyParagraphs(letterBody);
  const words = paras.reduce((sum, p) => sum + countWords(p), 0);
  const withinWords = words >= spec.minWords && words <= spec.maxWords;
  const withinParagraphs = paras.length === spec.paragraphs;
  return { words, paragraphs: paras.length, withinWords, withinParagraphs, ok: withinWords && withinParagraphs };
}

// ---------------------------------------------------------------------------
// Staleness fingerprint
// ---------------------------------------------------------------------------

/**
 * Re-exported from `../utils/artefactFingerprint.js`, which is now the one
 * definition -- `matchRunner` needs the same thing and must not have to import
 * from the cover letter to get it. Re-exported rather than moved outright so
 * this module's public API is unchanged, the same shape as `uploadLimits.js`
 * being re-exported from `pdfParser.js`.
 *
 * Read that module for why staleness is a fingerprint comparison and not a list
 * of invalidating actions.
 */
export { fingerprint };

/**
 * Whether a stored letter still describes the resume and posting in front of
 * it. `null` for "cannot tell" -- a letter stored without a fingerprint by an
 * older build, or no letter at all. The page must render that as unknown, never
 * as fresh.
 *
 * @param {unknown} coverLetter the stored `state.coverLetter`
 * @param {unknown} resume the current resume
 * @param {unknown} parsedJD
 * @returns {boolean | null} true when stale
 */
export function isCoverLetterStale(coverLetter, resume, parsedJD) {
  const letter = asObject(coverLetter);
  if (!asString(letter.body).trim()) return null;
  const resumeStale = isStaleAgainst(letter.resumeFingerprint, resume);
  const jdStale = isStaleAgainst(letter.jdFingerprint, parsedJD);
  // Either fingerprint missing means the letter predates them, so nothing can
  // be concluded. "Cannot tell" is not "fresh".
  if (resumeStale === null || jdStale === null) return null;
  return resumeStale || jdStale;
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/** What the model is told about the posting. Responsibilities and requirements, not perks. */
function describePosting(parsedJD) {
  const jd = asObject(parsedJD);
  const list = (items, empty) => {
    const lines = asArray(items).map(asString).map((s) => s.trim()).filter(Boolean);
    return lines.length > 0 ? lines.map((l) => `- ${l}`).join('\n') : empty;
  };
  const keywords = asObject(asObject(jd.atsKeywords));
  const byPriority = ['high', 'medium', 'low']
    .map((p) => {
      const terms = asArray(keywords[p]).map(asString).filter(Boolean);
      return terms.length > 0 ? `${p}: ${terms.join(', ')}` : '';
    })
    .filter(Boolean)
    .join('\n');

  return `TARGET ROLE
${asString(jd.jobTitle) || '(not stated)'}${asString(jd.company) ? ` at ${asString(jd.company)}` : ''}

WHAT THE POSTING SAYS IT NEEDS
${list(jd.requiredSkills, '(none listed)')}

NICE TO HAVE
${list(jd.preferredSkills, '(none listed)')}

RESPONSIBILITIES THE POSTING DESCRIBES
${list(jd.responsibilities, '(none listed)')}

TERMS THE POSTING EMPHASISES, BY PRIORITY
${byPriority || '(none listed)'}`;
}

/**
 * Generate one cover letter.
 *
 * Takes the CURRENT resume -- `currentResume.selectCurrentResume(state).raw`,
 * which is the tailored copy when a pass exists and the original parse
 * otherwise -- rather than choosing for itself. Same rule as
 * `parseResumeWithAI`: this module does not decide which resume or which
 * provider, because those choices belong to the page.
 *
 * Returns the grounding report alongside the letter, the way `callStructured`
 * returns `fenced` and `salvaged`: a sibling of the data, never merged into it.
 * Merging it would put fabricated terms into the letter body, where the next
 * grounding check would then find them in the "source" and pass them.
 *
 * @param {unknown} currentResume
 * @param {unknown} parsedJD
 * @param {object} options
 * @param {string} [options.tone]
 * @param {string} [options.length]
 * @param {string} options.provider
 * @param {string} options.apiKey
 * @param {string} [options.model]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<object>} the `coverLetter` slice, ready to dispatch
 */
export async function generateCoverLetter(
  currentResume,
  parsedJD,
  { tone = DEFAULT_TONE, length = DEFAULT_LENGTH, provider, apiKey, model, timeoutMs, effort, onModelFallback } = {}
) {
  const resume = asObject(currentResume);
  if (Object.keys(resume).length === 0) {
    throw new Error('generateCoverLetter: no resume to write from.');
  }

  const toneId = getTone(tone).id;
  const lengthId = getLength(length).id;

  const userPrompt = `Write a cover letter for this candidate and this posting.

${describePosting(parsedJD)}

--- BEGIN RESUME JSON ---
${JSON.stringify(resume, null, 2)}
--- END RESUME JSON ---

Every employer, tool, skill and outcome you mention must come from that resume json.`;

  const started = Date.now();
  const result = await callStructured({
    provider,
    apiKey,
    model,
    systemPrompt: buildCoverLetterSystemPrompt({ tone: toneId, length: lengthId }),
    userPrompt,
    schema: COVER_LETTER_SCHEMA,
    timeoutMs: timeoutMs ?? COVER_LETTER_TIMEOUT_MS,
    effort: effort ?? COVER_LETTER_EFFORT,
    onModelFallback,
  });

  const body = assembleLetterBody(result.data, resume);
  if (!body.trim()) {
    throw new Error('generateCoverLetter: the model returned no letter text.');
  }

  return buildCoverLetterSlice({
    body,
    tone: toneId,
    length: lengthId,
    resume,
    parsedJD,
    provider: result.provider ?? provider,
    model: result.model ?? model ?? null,
    fenced: result.fenced === true,
    salvaged: result.salvaged === true,
    elapsedMs: Date.now() - started,
    edited: false,
  });
}

/**
 * The stored `coverLetter` slice for a body of text.
 *
 * Used by `generateCoverLetter` and again on every hand edit, so a letter the
 * user has rewritten carries a grounding report computed against what it now
 * says rather than what the model originally wrote. The check is pure and
 * network-free, so re-running it on an edit costs nothing and a user who edits
 * a fabrication out sees the banner clear.
 */
export function buildCoverLetterSlice({
  body,
  tone,
  length,
  resume,
  parsedJD,
  provider = null,
  model = null,
  fenced = false,
  salvaged = false,
  elapsedMs = null,
  edited = false,
  generatedAt = null,
}) {
  const text = asString(body);
  return {
    body: text,
    tone: getTone(tone).id,
    length: getLength(length).id,
    grounding: checkCoverLetterGrounding(text, resume, parsedJD),
    lengthCheck: enforceLength(text, length),
    resumeFingerprint: fingerprint(resume),
    jdFingerprint: fingerprint(parsedJD),
    provider,
    model,
    fenced,
    salvaged,
    elapsedMs,
    edited,
    generatedAt: generatedAt ?? new Date().toISOString(),
  };
}
