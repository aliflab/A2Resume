/**
 * What a JD keyword must never be: employer benefits, perks, culture language,
 * and generic personality traits.
 *
 * THE PROBLEM THIS EXISTS TO SOLVE
 * -------------------------------
 * A job posting's "what we offer" section is not a description of the
 * candidate. "Health insurance", "paid parental leave", "MyALDI Wellbeing
 * program" and "a positive attitude" can never literally appear on a resume as
 * written, so classifying them as keywords manufactures a gap the candidate has
 * no way to close -- an unwinnable, misleading signal rather than a measurement.
 *
 * ONE SOURCE, TWO CONSUMERS
 * -------------------------
 * This module is the single definition of that exclusion, and it is consumed
 * twice on purpose:
 *
 *   1. `jdParser.js` renders `buildExclusionPromptSection()` into
 *      JD_SYSTEM_PROMPT, so the model is asked not to produce this content at
 *      all. This is the layer that does the real work.
 *   2. `gapAnalyzer.collectJDKeywords` calls `isExcludedKeyword()` on the
 *      `requiredSkills` / `preferredSkills` fallback path, as a backstop for
 *      when the prompt-level instruction fails on unfamiliar phrasing, an
 *      unfamiliar provider, or a posting whose benefits section is worded in a
 *      way the prompt never anticipated.
 *
 * Keeping both off one structure is the point: a prompt rule and a code filter
 * that are maintained separately drift apart silently, and the drift is only
 * visible as a slow return of false keywords. `PROMPT_EXAMPLES` are checked
 * against the matcher at module load for exactly that reason -- an example the
 * filter would not catch is a contradiction between the two layers.
 *
 * WHY THE CODE FILTER IS DELIBERATELY NOT APPLIED TO `atsKeywords`
 * ---------------------------------------------------------------
 * These terms are only *usually* wrong. For a health insurance claims role
 * "health insurance" is the domain; for a physiotherapy clinic "physiotherapy"
 * is the job; for a D&I lead "inclusion" is the work. A blanket code filter
 * would strip the single most important keyword from those postings.
 *
 * `atsKeywords` is the authority path in `collectJDKeywords` and is left
 * unfiltered, so a genuine domain term survives there. Only the *fallback*
 * path is filtered, where the cost of a false reject is low (the term is a
 * duplicate or an also-ran) and the cost of a false accept is high (it enters
 * the analysis at `high` priority). That asymmetry is the whole design.
 */

// ---------------------------------------------------------------------------
// Normalisation
//
// NOT `normaliseSkill` from skillSynonyms.js: that strips every separator, so
// "positive attitude" becomes "positiveattitude" and phrase boundaries are
// lost. Matching here is phrase-level, so words must stay separated.
// ---------------------------------------------------------------------------

/**
 * Lowercase, reduce punctuation to single spaces, drop a leading article.
 * "A positive attitude!" -> "positive attitude"
 *
 * @param {unknown} term
 * @returns {string}
 */
export function normalisePhrase(term) {
  if (typeof term !== 'string') return '';

  return term
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .replace(/^\s*(?:a|an|the|our|your|and)\s+/, '')
    .trim();
}

// ---------------------------------------------------------------------------
// The exclusion categories
//
// `terms` is the matcher's vocabulary -- broad, and written in the normalised
// form above. `promptExamples` is the curated subset shown to the model; it is
// display-cased for readability and every entry must be caught by the matcher.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ExclusionCategory
 * @property {string} id
 * @property {string} promptDescription Prose shown to the model, minus examples.
 * @property {string[]} promptExamples   Display-cased; asserted matchable.
 * @property {string[]} terms            Normalised phrases the matcher looks for.
 */

/** @type {ExclusionCategory[]} */
export const EXCLUSION_CATEGORIES = [
  {
    id: 'benefits',
    promptDescription:
      'Employer benefits, perks, pay, and leave entitlements. These are things the employer gives the candidate, never things the candidate holds.',
    promptExamples: [
      'health insurance',
      'paid parental leave',
      'sick leave',
      'superannuation',
      'staff discount',
      'free parking',
      'competitive salary',
      'hourly rate',
      'physiotherapy',
      'Employee Assistance Program',
    ],
    terms: [
      'health insurance', 'life insurance', 'medical insurance', 'private health',
      'health cover', 'health benefits', 'health checks', 'dental cover', 'vision cover',
      'parental leave', 'maternity leave', 'paternity leave', 'annual leave', 'sick leave',
      'paid leave', 'unpaid leave', 'compassionate leave', 'bereavement leave',
      'carer leave', 'carers leave', 'study leave', 'long service leave', 'birthday leave',
      'natural disaster leave', 'emergency services leave', 'leave entitlements',
      'leave entitlement', 'paid time off',
      'superannuation', 'pension', 'retirement plan', 'retirement savings', '401k',
      'share scheme', 'employee share', 'stock options', 'equity package',
      'employee assistance', 'employee assistance program', 'employee assistance programme',
      'gym membership', 'gym discount', 'gym discounts', 'gym access', 'fitness passport',
      'fitness membership',
      'staff discount', 'staff discounts', 'employee discount', 'employee discounts',
      'team member discount',
      'free parking', 'travel allowance', 'relocation assistance', 'relocation package',
      'meal allowance', 'free meals',
      'hourly rate', 'pay rate', 'competitive salary', 'competitive pay', 'salary package',
      'remuneration', 'shift allowance', 'shift allowances', 'penalty rates', 'overtime pay',
      'bonus scheme', 'annual bonus', 'signing bonus', 'performance bonus',
      'physiotherapy', 'flu vaccination', 'flu shots', 'novated lease', 'salary sacrifice',
      'employee benefits', 'benefits package', 'staff benefits', 'perks',
      'work life balance',
    ],
  },
  {
    id: 'programs',
    promptDescription:
      'Named internal programs and branded employer schemes -- wellbeing, rewards, discount or recognition programs carrying a company or product name.',
    promptExamples: ['MyALDI Wellbeing program', 'Fitness Passport', 'a rewards program'],
    terms: [
      'myaldi', 'wellbeing program', 'wellbeing programme', 'wellness program',
      'wellness programme', 'wellbeing benefits', 'wellbeing support', 'rewards program',
      'rewards programme', 'recognition program', 'recognition programme',
      'discount program', 'discount programme', 'perks program', 'loyalty program',
    ],
  },
  {
    id: 'culture',
    promptDescription:
      'Culture, values, and "why work here" language.',
    promptExamples: [
      'diversity',
      'an inclusive environment',
      'a supportive team',
      'a fast-paced environment',
      'Employer of Choice',
    ],
    terms: [
      'diversity', 'inclusion', 'inclusive environment', 'inclusive culture',
      'inclusive workplace', 'diverse and inclusive', 'equal opportunity',
      'equal opportunities', 'supportive environment', 'supportive team',
      'friendly environment', 'fast paced environment', 'great culture',
      'company culture', 'values', 'sense of belonging', 'belonging',
      'welcoming environment', 'positive work environment', 'team environment',
      'collaborative environment', 'employer of choice', 'great place to work',
      'good vibes', 'no two days are the same',
    ],
  },
  {
    id: 'traits',
    promptDescription:
      'Generic personality traits, however the posting phrases them. These are claims anyone can make without evidence. Note the contrast with the compact competency nouns admitted above: "teamwork" is a skill a resume lists; "a positive attitude" is not.',
    promptExamples: [
      'a positive attitude',
      'a willingness to learn',
      'a can-do attitude',
      'a strong work ethic',
      'a team player',
      'enthusiasm',
      'passion',
    ],
    terms: [
      'positive attitude', 'can do attitude', 'good attitude', 'great attitude',
      'positive mindset', 'growth mindset', 'can do',
      'willingness to learn', 'willing to learn', 'eagerness to learn', 'eager to learn',
      'keen to learn', 'desire to learn',
      'work ethic', 'team player', 'self starter', 'self motivated', 'self driven',
      'go getter', 'hard working', 'hardworking',
      'enthusiasm', 'enthusiastic', 'passionate', 'passion', 'motivated', 'motivation',
      'outgoing', 'bubbly', 'energetic', 'punctual', 'punctuality', 'proactive',
      'sense of humour', 'sense of humor', 'down to earth', 'bring your whole self',
    ],
  },
  {
    id: 'company',
    promptDescription:
      'Company description, mission statements, marketing, awards, employee counts, and office locations.',
    promptExamples: ['our mission', 'award-winning', 'about us'],
    terms: [
      'our mission', 'our purpose', 'about us', 'founded in', 'we are proud',
      'stores nationwide', 'award winning', 'employer brand', 'our story',
      'good different',
    ],
  },
  {
    id: 'logistics',
    promptDescription:
      'Application and recruitment logistics.',
    promptExamples: ['how to apply', 'closing date', 'the interview process'],
    terms: [
      'how to apply', 'closing date', 'applications close', 'application deadline',
      'interview process', 'recruitment process', 'hiring process', 'right to work',
      'working rights', 'apply now', 'submit your application', 'video interview',
    ],
  },
];

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------

/**
 * Every excluded term, normalised, mapped to the category that claimed it.
 * @type {Map<string, string>}
 */
const TERM_INDEX = (() => {
  /** @type {Map<string, string>} */
  const index = new Map();

  for (const category of EXCLUSION_CATEGORIES) {
    for (const term of category.terms) {
      const key = normalisePhrase(term);
      if (!key) continue;

      // Same convention as skillSynonyms: a term in two categories is a
      // modelling slip, not a crash. Report it and keep the first.
      if (index.has(key) && index.get(key) !== category.id) {
        console.warn(
          `jdKeywordExclusions: "${term}" is in both "${index.get(key)}" and "${category.id}"; keeping "${index.get(key)}".`
        );
        continue;
      }
      index.set(key, category.id);
    }
  }

  return index;
})();

/**
 * Does this term look like a benefit, perk, culture phrase, or generic trait?
 *
 * Matching is whole-phrase against the normalised term: a term is excluded if
 * any indexed phrase appears in it on word boundaries. Padding both sides with
 * a space is what makes it word-level -- without it "pension" would fire on
 * "suspension" and "passion" on "compassionate".
 *
 * @param {unknown} term
 * @returns {boolean}
 */
export function isExcludedKeyword(term) {
  return matchExclusion(term) !== null;
}

/**
 * Same test, but reports which phrase and category matched. Used by the manual
 * tests so a false positive can be traced to the entry responsible.
 *
 * @param {unknown} term
 * @returns {{ phrase: string, category: string } | null}
 */
export function matchExclusion(term) {
  const normalised = normalisePhrase(term);
  if (!normalised) return null;

  const padded = ` ${normalised} `;

  for (const [phrase, category] of TERM_INDEX) {
    if (padded.includes(` ${phrase} `)) return { phrase, category };
  }

  return null;
}

// ---------------------------------------------------------------------------
// The prompt half
// ---------------------------------------------------------------------------

/**
 * Render the exclusion rules as the prompt bullet list, so JD_SYSTEM_PROMPT and
 * `isExcludedKeyword` are two views of one definition.
 *
 * @returns {string}
 */
export function buildExclusionPromptSection() {
  return EXCLUSION_CATEGORIES.map(
    (c) => `- ${c.promptDescription} For example: ${c.promptExamples.join(', ')}.`
  ).join('\n');
}

// ---------------------------------------------------------------------------
// Load-time consistency check
//
// Every example shown to the model must also be caught by the code filter. An
// example that is not is precisely the drift this module exists to prevent, so
// it is reported loudly -- but it warns rather than throws, because a bad
// example is a documentation bug and must not take the app down.
// ---------------------------------------------------------------------------

for (const category of EXCLUSION_CATEGORIES) {
  for (const example of category.promptExamples) {
    if (!isExcludedKeyword(example)) {
      console.warn(
        `jdKeywordExclusions: prompt example "${example}" (${category.id}) is not caught by isExcludedKeyword. The prompt and the filter have drifted.`
      );
    }
  }
}
