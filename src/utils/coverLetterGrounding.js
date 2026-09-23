/**
 * Is this cover letter grounded in the resume, or did the model make things up?
 *
 * THE PROBLEM THIS EXISTS TO SOLVE
 * -------------------------------
 * A cover letter is the first thing in this app that is *generated prose*
 * rather than transcribed or edited text. `resumeParser.js` copies,
 * `resumeTailor.js` rewrites what is already there, `skillInference.js`
 * proposes and waits for approval. This writes new sentences, unreviewed, and
 * the most likely failure is a confident sentence naming an employer the
 * candidate never worked for or a tool they have never used. It reads
 * perfectly. An interviewer finds it in thirty seconds.
 *
 * Every other generative step here needed a code-level backstop behind its
 * prompt, so this one gets one too, on the same two-consumer structure as
 * `jdKeywordExclusions.js` and `transcriptionFidelity.js`:
 *
 *   1. `coverLetterGenerator.js` renders `buildGroundingPromptSection()` into
 *      its system prompt, so the model is asked not to do this at all. That is
 *      the layer doing the real work.
 *   2. `checkCoverLetterGrounding()` runs on the result and on every hand
 *      edit, as the backstop for when the prompt fails.
 *
 * `PROMPT_EXAMPLES` are asserted against the checker at module load, so an
 * example the prompt names but the code misses is a contradiction between the
 * layers and warns immediately.
 *
 * WHY THIS IS NOT `transcriptionFidelity` WITH A DIFFERENT INPUT
 * -------------------------------------------------------------
 * That module asks "does every content word here appear in the source?", which
 * is the right question for a field the model was told to COPY. A cover letter
 * is not copied. Asking it here would flag "excited", "opportunity",
 * "contribute" and every other ordinary English word the resume happens not to
 * contain -- hundreds of warnings on a perfect letter, which trains people to
 * ignore the banner. That is the only way a check like this actually fails.
 *
 * So this looks only at DISTINGUISHING terms -- the kind of word that is either
 * true or invented, never a stylistic choice:
 *
 *   - Named things. Multi-word capitalised phrases, plus single capitalised
 *     words that are not sentence-initial. "Nimbus Data", "Acme", "Kubernetes".
 *   - Known skill and tool names, from `skillSynonyms`' index, matched
 *     case-sensitively so "I have used Terraform" is a claim and "your
 *     deployment pipeline" is not. See `extractSkillTerms` for the honest
 *     letter that forced that rule.
 *
 * WHAT COUNTS AS THE SOURCE
 * -------------------------
 * The resume, plus the JD's company name and job title. Those two are
 * legitimate for the letter to name -- you are applying there, and the resume
 * obviously does not mention the employer you are writing to. Nothing else from
 * the JD is admitted: a tool the POSTING asks for and the resume does not have
 * is exactly the fabrication being hunted, and letting the JD vouch for it
 * would defeat the whole check.
 *
 * WHAT THIS CAN AND CANNOT DO -- READ THIS BEFORE TRUSTING A CLEAN RESULT
 * ----------------------------------------------------------------------
 * It is a term-presence test. A warning is strong evidence of a problem; a
 * clean result is weak evidence of correctness. Specifically it does NOT catch:
 *
 *   - A fabricated claim written entirely in lowercase common words. "I led a
 *     team of twelve" against a resume that never mentions leading anyone is
 *     invisible here, and it is a real fabrication.
 *   - A single-word invented proper noun at the START of a sentence. Sentence
 *     position is the only way to tell "Globex" from "During", with no
 *     dictionary available, so sentence-initial single words are skipped. A
 *     multi-word name is flagged wherever it appears.
 *   - An invented NUMBER. "increased revenue 40%" is not a term. `resumeTailor`
 *     has the same hole and guards it with the prompt only.
 *   - A true term used to support a false claim. Every word of "I architected
 *     Kubernetes migrations at Acme" can be in the resume while the sentence
 *     misdescribes what the candidate did.
 *
 * SYNONYMS DO NOT VOUCH FOR A TERM HERE, ON PURPOSE
 * ------------------------------------------------
 * `skillSynonyms`' groups are deliberately looser than true synonymy --
 * TypeScript sits with JavaScript, GitHub Actions with Jenkins. Downstream that
 * earns partial credit. Here it would earn a pass, and "the resume says
 * JavaScript so the letter may claim TypeScript" is precisely the fabrication
 * this exists to catch. Grounding is literal presence only. The index is used
 * to know what a tool name LOOKS like, never to accept one.
 */

import { asArray, asObject, asString, containsTerm } from '../services/gapAnalyzer.js';
import { SKILL_SYNONYM_GROUPS } from './skillSynonyms.js';
import { EXCLUSION_CATEGORIES, normalisePhrase } from './jdKeywordExclusions.js';

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Warning kinds, most serious first. The page renders them separately because
 * they are not the same problem: `fabricated-*` means the letter may contain a
 * claim that is not true, `excluded-language` means it parrots the posting's
 * perks back as if they were a qualification. Conflating them would let a real
 * fabrication hide inside a list of style notes.
 */
export const WARNING_KINDS = ['fabricated-name', 'fabricated-skill', 'excluded-language'];

// ---------------------------------------------------------------------------
// The source vocabulary
// ---------------------------------------------------------------------------

/** Every string anywhere in a value, flattened. Shape-agnostic on purpose. */
function collectStrings(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out));
  else if (isPlainObject(value)) Object.values(value).forEach((item) => collectStrings(item, out));
  return out;
}

/**
 * The text a letter is allowed to draw named things from: the whole resume,
 * plus the JD's company and job title and nothing else from the JD.
 *
 * Deliberately not `gapAnalyzer.collectResumeText`, which reads a named subset
 * of keys for scoring. Grounding must see everything the resume actually says,
 * including fields that module skips, or a true term in one of them reads as a
 * fabrication.
 *
 * @param {unknown} resume the CURRENT resume (tailored copy when one exists)
 * @param {unknown} parsedJD
 * @returns {string}
 */
export function buildGroundingSource(resume, parsedJD) {
  const jd = asObject(parsedJD);
  return [
    ...collectStrings(asObject(resume), []),
    asString(jd.company),
    asString(jd.jobTitle),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Every term in the synonym index, longest first so "GitHub Actions" is tried before "GitHub". */
const KNOWN_SKILL_TERMS = (() => {
  const terms = new Set();
  for (const group of SKILL_SYNONYM_GROUPS) for (const term of asArray(group)) if (term) terms.add(term);
  return [...terms].sort((a, b) => b.length - a.length);
})();

export const KNOWN_SKILL_TERM_COUNT = KNOWN_SKILL_TERMS.length;

// ---------------------------------------------------------------------------
// Named things in the letter
// ---------------------------------------------------------------------------

/**
 * Words that are capitalised in a letter for reasons that have nothing to do
 * with naming a company: the letter's own furniture, the calendar, and the
 * handful of title-cased role words every posting uses.
 *
 * `Hiring Manager`, `Dear` and `Sincerely` are boilerplate the generator itself
 * writes. Flagging them would make the banner fire on every clean letter.
 */
const BOILERPLATE = new Set(
  [
    'dear', 'sincerely', 'regards', 'kind regards', 'best regards', 'yours', 'yours sincerely',
    'yours faithfully', 'faithfully', 'best', 'thank you', 'thanks', 'sir', 'madam', 'sir or madam',
    'hiring manager', 'hiring team', 'recruiting team', 'recruitment team', 'talent team',
    'hiring', 'manager', 'team', 'committee', 'department', 'company', 'role', 'position',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
    'october', 'november', 'december',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'i', 'my', 'me',
  ].map((s) => s.toLowerCase())
);

/** Trailing possessive and stray punctuation, so "Nimbus's" and "Acme," match "Acme". */
const trimTerm = (term) =>
  term
    .replace(/[''’]s\b/gi, '')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9+#&]+$/g, '')
    .trim();

/**
 * Capitalised phrases in the letter that might be naming something.
 *
 * Sentences are split first, because position is the only signal separating a
 * name from an ordinary sentence-initial word with no dictionary to consult.
 * Within a sentence, a run of capitalised words is one candidate phrase.
 *
 * THE SENTENCE-INITIAL RULE, which is the judgment call in this file:
 * the first word of a sentence is capitalised because it is the first word, so
 * its capitalisation carries no information about whether it names anything. It
 * is therefore dropped from the phrase that gets CHECKED -- but the rest of the
 * run is not. "At Acme I migrated..." must test "Acme", not "At Acme", or every
 * sentence opening in the letter ("At", "During", "Working") becomes a warning
 * attached to the real name beside it. Without that, a clean letter reports
 * fabrications, which is the one failure mode that makes people ignore the
 * banner.
 *
 * What is REPORTED is still the whole run, because "At Acme" is what the user
 * can find in their letter and "Acme" alone might appear in three places.
 * Decision from the informative part, message from the full phrase.
 *
 * The cost: a single-word invented name at the head of a sentence is dropped
 * entirely and missed. That is stated in the module comment and asserted in
 * `coverLetter.manual.js`, so it is a known limit rather than a surprise.
 *
 * The split deliberately uses no lookbehind: an unsupported lookbehind is a
 * SyntaxError at construction, which would take the whole feature out on one
 * browser rather than degrading. Same rule as `gapAnalyzer.buildTermPattern`.
 *
 * @param {unknown} text
 * @returns {{ term: string, evaluate: string }[]} `term` to show, `evaluate` to test
 */
export function extractNamedTerms(text) {
  if (typeof text !== 'string') return [];

  const found = [];
  const seen = new Set();
  const sentences = text.split(/[.!?;:\n\r]+/);

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    const runs = trimmed.match(/[A-Z][A-Za-z0-9+#&''’-]*(?:[ \t]+[A-Z][A-Za-z0-9+#&''’-]*)*/g) ?? [];
    for (const run of runs) {
      const term = trimTerm(run);
      if (!term || term.length < 2) continue;

      // A run may be boilerplate wrapped around a real name ("Dear Nimbus
      // Data"), so boilerplate words are dropped rather than the whole run.
      const words = term.split(/\s+/).filter((word) => !BOILERPLATE.has(word.toLowerCase()));
      if (words.length === 0) continue;

      // The uninformative first word, when this run opens its sentence.
      const evaluated = trimmed.startsWith(run) ? words.slice(1) : words;
      if (evaluated.length === 0) continue;

      const phrase = words.join(' ');
      const evaluate = evaluated.join(' ');
      if (phrase.length < 2 || evaluate.length < 2) continue;

      const key = phrase.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ term: phrase, evaluate });
    }
  }
  return found;
}

/**
 * The boundary rules from `gapAnalyzer.buildTermPattern`, but CASE-SENSITIVE.
 *
 * The boundary expression is copied rather than imported because
 * `buildTermPattern` hard-codes the `i` flag and is load-bearing for scoring --
 * making it configurable to serve this one caller would put a scoring change
 * behind a cover-letter fix. The rules themselves are documented there: the
 * left character must not be alphanumeric, the right must not be alphanumeric,
 * `+`, `#` or `&`, and lookbehind is avoided so an unsupported lookbehind
 * cannot turn into a SyntaxError that takes out the feature on one browser.
 */
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function containsTermCased(text, term) {
  const raw = asString(term).trim();
  if (!raw) return false;
  return new RegExp(`(^|[^A-Za-z0-9])(?:${escapeRegex(raw)})(?![A-Za-z0-9+#&])`).test(asString(text));
}

/**
 * Known tool and skill names the letter CLAIMS.
 *
 * MATCHING IS CASE-SENSITIVE, AND THAT IS THE WHOLE POINT OF THIS FUNCTION.
 * Observed in the browser on a letter that was entirely honest: a closing line
 * reading "I would welcome the chance to bring that to your deployment
 * pipeline" was flagged as fabricating the skill "Deployment Pipeline", which
 * is a real entry in the synonym index. The letter was describing the
 * EMPLOYER'S pipeline, straight out of the posting's responsibilities. It
 * claimed nothing.
 *
 * The index mixes true product names ("AWS Lambda", "Spring Boot") with generic
 * competency phrases ("Cloud Computing", "Continuous Integration", "Deployment
 * Pipeline"), and every entry is Title Case, so the term itself cannot tell the
 * two apart. How the LETTER writes it can. A candidate claiming a technology
 * writes it as the proper noun it is -- "I have used Terraform", "built in Go".
 * Ordinary prose about a concept does not -- "your deployment pipeline", "we go
 * to market".
 *
 * This is the same rule, for the same reason, that `buildTermPattern` already
 * applies to its AMBIGUOUS_SHORT_TERM case: match a capitalised form only,
 * because otherwise ordinary English scores as a skill. Here it is applied to
 * the whole index rather than to two-letter terms, because here a false alarm
 * is not a scoring wobble -- it is a banner accusing an honest letter of
 * containing a fabrication, which is the one thing that teaches people to
 * ignore the banner.
 *
 * The cost, stated rather than hidden: a lowercase fabrication ("i have used
 * terraform") is missed. So is a term the candidate genuinely has but writes in
 * a case the index does not use. Both are rarer than the false positive this
 * prevents, and the named-term check misses lowercase text too, so this adds no
 * new class of blind spot.
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function extractSkillTerms(text) {
  const body = asString(text);
  if (!body.trim()) return [];
  const found = [];
  const claimed = new Set();
  for (const term of KNOWN_SKILL_TERMS) {
    if (!containsTermCased(body, term)) continue;
    const key = term.toLowerCase();
    if (claimed.has(key)) continue;
    claimed.add(key);
    found.push(term);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Excluded language parroted back
// ---------------------------------------------------------------------------

/** Every excluded phrase, normalised, with the category that claimed it. */
const EXCLUDED_PHRASES = (() => {
  const out = [];
  for (const category of EXCLUSION_CATEGORIES) {
    for (const term of category.terms) {
      const phrase = normalisePhrase(term);
      if (phrase) out.push({ phrase, category: category.id });
    }
  }
  return out;
})();

/**
 * Posting language the letter should not be reciting as if it described the
 * candidate. Whole-phrase, word-boundary matching, the same padding trick
 * `jdKeywordExclusions.matchExclusion` uses so "pension" does not fire inside
 * "suspension".
 *
 * This is the softest of the three checks and it will fire on letters that are
 * merely conventional -- "passionate" and "motivated" are in the traits list
 * and half the cover letters ever written contain them. That is why it is its
 * own warning kind rather than being mixed in with the fabrication warnings.
 *
 * @param {unknown} text
 * @returns {{ phrase: string, category: string }[]}
 */
export function extractExcludedLanguage(text) {
  const normalised = normalisePhrase(asString(text));
  if (!normalised) return [];
  const padded = ` ${normalised} `;
  const hits = [];
  const seen = new Set();
  for (const { phrase, category } of EXCLUDED_PHRASES) {
    if (!padded.includes(` ${phrase} `)) continue;
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    hits.push({ phrase, category });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * @typedef {object} GroundingWarning
 * @property {'fabricated-name' | 'fabricated-skill' | 'excluded-language'} kind
 * @property {string} term
 * @property {string} [category] only on excluded-language
 */

/**
 * @typedef {object} GroundingResult
 * @property {GroundingWarning[]} warnings
 * @property {number} checkedNames      how many named phrases were tested
 * @property {number} checkedSkills     how many known tool names were tested
 * @property {boolean} grounded         no fabrication warnings (excluded language does not count)
 * @property {boolean} checkable        false when there was no letter or no source to check against
 */

/**
 * Terms in the letter that appear nowhere in the resume (or the JD's company
 * and title).
 *
 * Never throws and never returns partial nonsense: a missing letter or a
 * missing resume yields `checkable: false`, which the page must render as "not
 * checked" rather than as "clean". Same degradation contract as every other
 * guard here.
 *
 * @param {unknown} letterText the letter body as plain text
 * @param {unknown} resume the current resume
 * @param {unknown} parsedJD
 * @returns {GroundingResult}
 */
export function checkCoverLetterGrounding(letterText, resume, parsedJD) {
  const body = asString(letterText);
  const source = buildGroundingSource(resume, parsedJD);

  if (!body.trim() || !source.trim()) {
    return { warnings: [], checkedNames: 0, checkedSkills: 0, grounded: false, checkable: false };
  }

  const warnings = [];

  const names = extractNamedTerms(body);
  for (const { term, evaluate } of names) {
    // A named phrase counts as supported when it occurs in the source, or when
    // every word of it does -- "Nimbus Data Platform" is grounded by a resume
    // that says "Nimbus Data" and "platform" separately, and treating the full
    // phrase as invented there would be a false alarm on ordinary rephrasing.
    const whole = containsTerm(source, evaluate);
    const everyWord = evaluate.split(/\s+/).every((word) => containsTerm(source, word));
    if (!whole && !everyWord) warnings.push({ kind: 'fabricated-name', term });
  }

  const skills = extractSkillTerms(body);
  for (const term of skills) {
    // THE TWO SIDES ARE MATCHED DIFFERENTLY, ON PURPOSE.
    // The LETTER side is case-sensitive (`extractSkillTerms`), because casing
    // is what separates a claim from ordinary prose. The RESUME side is
    // case-insensitive, because a resume writing "kubernetes" in a bullet still
    // vouches for a letter writing "Kubernetes" -- being strict here would
    // manufacture a fabrication out of a capital letter.
    // Literal presence only either way. Synonyms deliberately do not vouch:
    // see the module comment.
    if (!containsTerm(source, term)) warnings.push({ kind: 'fabricated-skill', term });
  }

  for (const hit of extractExcludedLanguage(body)) {
    warnings.push({ kind: 'excluded-language', term: hit.phrase, category: hit.category });
  }

  return {
    warnings,
    checkedNames: names.length,
    checkedSkills: skills.length,
    grounded: !warnings.some((w) => w.kind === 'fabricated-name' || w.kind === 'fabricated-skill'),
    checkable: true,
  };
}

/** The fabrication warnings only -- what the page leads with. */
export const fabricationWarnings = (result) =>
  asArray(asObject(result).warnings).filter((w) => w.kind === 'fabricated-name' || w.kind === 'fabricated-skill');

/** One line for a log or the UI. */
export function describeGroundingWarning(warning) {
  const w = asObject(warning);
  const term = asString(w.term);
  switch (w.kind) {
    case 'fabricated-name':
      return `"${term}" is named in the letter but appears nowhere in your resume.`;
    case 'fabricated-skill':
      return `"${term}" is claimed as a skill but your resume never mentions it.`;
    case 'excluded-language':
      return `"${term}" is the posting's own ${asString(w.category) || 'boilerplate'} language, not a qualification.`;
    default:
      return `"${term}" could not be grounded in your resume.`;
  }
}

// ---------------------------------------------------------------------------
// The prompt half of the same rule
// ---------------------------------------------------------------------------

/**
 * Fabrications this checker must catch, kept next to it. Each is
 * `{ letter, source, caught, why }`, asserted at module load.
 *
 * Showing the model what NOT to write is safe for the reason the parsers carry
 * no worked example: these demonstrate the failure, so imitating their shape is
 * impossible.
 */
export const PROMPT_EXAMPLES = [
  {
    letter: 'My three years at Globex Industries taught me to ship under pressure.',
    source: 'Senior Engineer at Acme. Engineer at Beta.',
    caught: 'Globex Industries',
    why: 'an employer the resume never mentions',
  },
  {
    letter: 'I have used Terraform to manage infrastructure across several teams.',
    source: 'Migrated 40 services to Kubernetes. Skills: Go, Python, Kubernetes.',
    caught: 'Terraform',
    why: 'a tool the resume never mentions, even though the posting asks for it',
  },
  {
    letter: 'I bring a positive attitude and a strong work ethic to every team.',
    source: 'Senior Engineer at Acme. Built a reporting API.',
    caught: 'positive attitude',
    why: "the posting's own trait language recited as if it were a qualification",
  },
];

/**
 * Rendered into the generator's system prompt, so the wording the model is
 * given and the rule the code enforces cannot drift apart.
 *
 * @returns {string}
 */
export function buildGroundingPromptSection() {
  const examples = PROMPT_EXAMPLES.map(
    (ex) => `- WRONG: "${ex.letter}"\n  Resume said: "${ex.source}"\n  Why:  "${ex.caught}" is ${ex.why}.`
  ).join('\n');

  return `EVERY CLAIM MUST COME FROM THE RESUME
You are writing about one real person, and the resume json you are given is the
only thing you know about them. It is the whole world.

- Name only the employers, job titles, institutions, projects and certifications
  that appear in that resume. Never another company, not as an example, not as
  a comparison, not as a guess at where they might have worked.
- Claim only the skills, tools, languages and technologies the resume states. If
  the posting asks for something the resume does not have, DO NOT claim it. Write
  about what the candidate has actually done instead. A claimed tool the
  candidate has never touched is found in the first interview question.
- Never invent a number, a duration, a team size, a percentage or an outcome. If
  the resume gives you a figure you may use it. If it does not, write the
  sentence without one.
- Never invent a responsibility or a seniority the resume does not show.
- The only things you may name that are not in the resume are the company you
  are writing to and the job title you are applying for.

Examples of exactly the failure this rule forbids:
${examples}

The letter is checked against the resume for named things and tool names that
never appeared in it.`;
}

// ---------------------------------------------------------------------------
// Load-time contradiction check
//
// An example the prompt names but the checker misses means the two layers have
// drifted, which is the whole thing this structure exists to prevent. It warns
// rather than throws: a bad example is a documentation bug and must not take
// the app down.
// ---------------------------------------------------------------------------

for (const example of PROMPT_EXAMPLES) {
  const result = checkCoverLetterGrounding(example.letter, { summary: example.source }, null);
  const caught = result.warnings.some((w) => w.term.toLowerCase() === example.caught.toLowerCase());
  if (!caught) {
    console.warn(
      `coverLetterGrounding: prompt example "${example.caught}" is not caught by checkCoverLetterGrounding. The prompt and the checker have drifted.`,
      result.warnings
    );
  }
}
