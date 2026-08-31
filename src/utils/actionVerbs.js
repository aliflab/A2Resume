/**
 * Resume action verbs: a catalogue of strong ones, and a map from the weak
 * constructions that dilute a bullet to stronger replacements.
 *
 * Used by the ATS scorer's bullet-quality check, and later by the content
 * editor when it offers rewrites.
 *
 * TENSE
 * -----
 * Verbs are catalogued in the simple past ("led", "built"), because that is
 * how resume bullets are written. `isStrongVerb` also accepts the present and
 * gerund forms, since current roles often use them ("leading", "own"), by
 * de-inflecting rather than by listing every form. That de-inflection is
 * crude on purpose -- it is a scoring heuristic, not a conjugator.
 */

/**
 * Strong verbs, grouped by the kind of contribution they claim. The grouping
 * carries no scoring weight today; it is there so the content editor can
 * later suggest a replacement from the *same* category rather than swapping
 * a leadership claim for an engineering one.
 *
 * @type {Record<string, string[]>}
 */
export const STRONG_VERBS_BY_CATEGORY = {
  leadership: [
    'led', 'directed', 'headed', 'spearheaded', 'championed', 'drove', 'orchestrated',
    'chaired', 'oversaw', 'governed', 'steered', 'founded', 'established', 'initiated',
  ],
  building: [
    'built', 'architected', 'designed', 'developed', 'engineered', 'implemented',
    'created', 'authored', 'constructed', 'prototyped', 'shipped', 'delivered',
    'launched', 'deployed', 'released', 'introduced', 'programmed', 'coded',
  ],
  improvement: [
    'optimised', 'optimized', 'improved', 'reduced', 'increased', 'accelerated',
    'streamlined', 'refactored', 'modernised', 'modernized', 'strengthened',
    'enhanced', 'upgraded', 'simplified', 'consolidated', 'eliminated', 'cut',
    'boosted', 'doubled', 'tripled', 'halved',
  ],
  scale: [
    'scaled', 'migrated', 'transformed', 'rebuilt', 'redesigned', 'restructured',
    'expanded', 'extended', 'ported', 'consolidated', 'decomposed', 'partitioned',
  ],
  ownership: [
    'owned', 'managed', 'maintained', 'operated', 'administered', 'coordinated',
    'executed', 'ran', 'handled', 'supported',
  ],
  analysis: [
    'analysed', 'analyzed', 'diagnosed', 'identified', 'investigated', 'evaluated',
    'assessed', 'measured', 'benchmarked', 'audited', 'researched', 'debugged',
    'troubleshot', 'resolved', 'root-caused',
  ],
  automation: [
    'automated', 'instrumented', 'integrated', 'orchestrated', 'configured',
    'provisioned', 'containerised', 'containerized', 'scripted', 'pipelined',
  ],
  people: [
    'mentored', 'coached', 'trained', 'onboarded', 'guided', 'advised', 'taught',
    'hired', 'recruited', 'reviewed', 'facilitated', 'unblocked',
  ],
  influence: [
    'negotiated', 'persuaded', 'aligned', 'partnered', 'collaborated', 'presented',
    'proposed', 'advocated', 'influenced', 'secured', 'won', 'closed',
  ],
};

/** Every strong verb, flattened. */
export const STRONG_ACTION_VERBS = Object.freeze([
  ...new Set(Object.values(STRONG_VERBS_BY_CATEGORY).flat()),
]);

const STRONG_VERB_SET = new Set(STRONG_ACTION_VERBS);

/**
 * Weak constructions -> stronger replacements.
 *
 * Two kinds are mixed here, and the distinction matters when reading a
 * recommendation:
 *
 *   filler verbs      -- "helped", "assisted". The work may have been real,
 *                        but the verb hands the credit to someone else.
 *   passive framings  -- "responsible for", "duties included". These describe
 *                        a job description, not an accomplishment.
 *
 * Keys are lowercase and matched as whole phrases, anywhere in the bullet,
 * though position matters to the scorer -- see `findWeakVerbs`.
 *
 * @type {Record<string, string[]>}
 */
export const WEAK_VERB_REPLACEMENTS = {
  // Filler verbs.
  'helped': ['drove', 'enabled', 'accelerated', 'delivered'],
  'helped to': ['drove', 'enabled', 'delivered'],
  'assisted': ['supported', 'enabled', 'partnered on'],
  'assisted with': ['supported', 'delivered', 'contributed to'],
  'aided': ['supported', 'enabled'],
  'contributed to': ['built', 'delivered', 'shipped'],
  'participated in': ['drove', 'led', 'delivered'],
  'took part in': ['drove', 'led', 'delivered'],
  'involved in': ['led', 'built', 'owned'],
  'was involved in': ['led', 'built', 'owned'],
  'worked on': ['built', 'developed', 'delivered', 'engineered'],
  'worked with': ['partnered with', 'collaborated with', 'integrated'],
  'worked as': ['served as', 'operated as'],
  'dealt with': ['resolved', 'handled', 'owned'],
  'looked after': ['owned', 'maintained', 'operated'],
  'took care of': ['owned', 'managed', 'maintained'],

  // Passive framings.
  'responsible for': ['owned', 'led', 'managed', 'drove'],
  'was responsible for': ['owned', 'led', 'managed'],
  'responsibilities included': ['owned', 'led', 'delivered'],
  'duties included': ['owned', 'delivered', 'executed'],
  'tasked with': ['owned', 'led', 'delivered'],
  'in charge of': ['owned', 'led', 'directed'],
  'accountable for': ['owned', 'led'],
  'part of a team that': ['built', 'delivered', 'shipped'],
  'member of': ['contributed to', 'built'],

  // Vague activity verbs.
  'used': ['applied', 'leveraged', 'built with', 'implemented'],
  'utilised': ['used', 'applied', 'leveraged'],
  'utilized': ['used', 'applied', 'leveraged'],
  'made': ['built', 'created', 'engineered'],
  'did': ['executed', 'delivered', 'performed'],
  'handled': ['owned', 'resolved', 'managed'],
  'attended': ['led', 'facilitated', 'presented at'],
  'learned': ['mastered', 'applied', 'adopted'],
  'familiar with': ['proficient in', 'experienced with'],
  'exposure to': ['experienced with', 'proficient in'],
  'gained experience': ['delivered', 'built', 'owned'],
};

/** Weak phrases, longest first, so "helped to" wins over "helped". */
const WEAK_PHRASES = Object.keys(WEAK_VERB_REPLACEMENTS).sort((a, b) => b.length - a.length);

/**
 * Strip common inflections so "leading" and "leads" reach "lead", which then
 * needs the irregular map to reach "led".
 *
 * Crude by design. It exists to stop a current-tense bullet ("Leading the
 * migration...") from scoring as verbless, not to be correct English.
 */
const IRREGULAR_STEMS = {
  lead: 'led', leading: 'led', leads: 'led',
  build: 'built', building: 'built', builds: 'built',
  run: 'ran', running: 'ran', runs: 'ran',
  drive: 'drove', driving: 'drove', drives: 'drove',
  win: 'won', winning: 'won', wins: 'won',
  hold: 'held', holding: 'held', holds: 'held',
  rebuild: 'rebuilt', rebuilding: 'rebuilt',
  oversee: 'oversaw', overseeing: 'oversaw',
  cut: 'cut', cutting: 'cut', cuts: 'cut',
};

/**
 * @param {string} word Already lowercased.
 * @returns {string[]} Candidate past-tense forms to test against the catalogue.
 */
function candidateForms(word) {
  const forms = new Set([word]);

  if (IRREGULAR_STEMS[word]) forms.add(IRREGULAR_STEMS[word]);

  // "-ing" and "-s" present forms -> a guessed past form.
  if (word.endsWith('ing') && word.length > 5) {
    const stem = word.slice(0, -3);
    forms.add(`${stem}ed`);
    forms.add(`${stem}d`); // "migrating" -> "migrat" -> "migrated" needs the e
    forms.add(`${stem}ded`);
    if (IRREGULAR_STEMS[stem]) forms.add(IRREGULAR_STEMS[stem]);
  }
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) {
    const stem = word.slice(0, -1);
    forms.add(stem);
    forms.add(`${stem}ed`);
    if (IRREGULAR_STEMS[stem]) forms.add(IRREGULAR_STEMS[stem]);
  }
  // Bare present ("own", "lead") -> past.
  forms.add(`${word}ed`);
  forms.add(`${word}d`);

  return [...forms];
}

/**
 * Is this word a strong resume action verb, in any tense we recognise?
 *
 * @param {unknown} word
 * @returns {boolean}
 */
export function isStrongVerb(word) {
  if (typeof word !== 'string') return false;
  const clean = word.toLowerCase().replace(/[^a-z-]/g, '');
  if (!clean) return false;

  return candidateForms(clean).some((form) => STRONG_VERB_SET.has(form));
}

/**
 * Does the bullet open with a strong action verb?
 *
 * Openings are what a recruiter's eye and most ATS keyword extractors weight
 * hardest, so this is checked separately from whether a strong verb appears
 * anywhere at all. Leading bullet glyphs and list markers are skipped.
 *
 * @param {unknown} bullet
 * @returns {{ ok: boolean, word: string }}
 */
export function startsWithStrongVerb(bullet) {
  if (typeof bullet !== 'string') return { ok: false, word: '' };

  const first = bullet
    .replace(/^[\s•‣◦⁃∙*\-–—+·]+/, '') // bullet glyphs
    .trim()
    .split(/\s+/)[0] || '';

  return { ok: isStrongVerb(first), word: first.replace(/[^A-Za-z-]/g, '') };
}

/**
 * Find weak constructions in a bullet.
 *
 * Matching is phrase-based and punctuation-aware rather than `\b`-based, so
 * "helped" does not fire inside "unhelpedly" and "used" does not fire inside
 * "reused". Longest phrases match first, and overlapping matches are dropped,
 * so "helped to" is reported once rather than as both "helped to" and
 * "helped".
 *
 * @param {unknown} bullet
 * @returns {Array<{ phrase: string, index: number, atStart: boolean, suggestions: string[] }>}
 */
export function findWeakVerbs(bullet) {
  if (typeof bullet !== 'string' || bullet.trim() === '') return [];

  const haystack = bullet.toLowerCase();
  const found = [];
  const claimed = []; // [start, end) ranges already matched by a longer phrase

  for (const phrase of WEAK_PHRASES) {
    let from = 0;
    for (;;) {
      const index = haystack.indexOf(phrase, from);
      if (index === -1) break;
      from = index + 1;

      const end = index + phrase.length;

      // Whole-phrase only: neighbours must not be letters.
      const before = haystack[index - 1];
      const after = haystack[end];
      if (before !== undefined && /[a-z]/.test(before)) continue;
      if (after !== undefined && /[a-z]/.test(after)) continue;

      if (claimed.some(([s, e]) => index < e && end > s)) continue;
      claimed.push([index, end]);

      found.push({
        phrase,
        index,
        // "Within the first few words" rather than "at index 0": a bullet
        // opening "Was responsible for..." is the same problem as one opening
        // "Responsible for...".
        atStart: haystack.slice(0, index).split(/\s+/).filter(Boolean).length <= 2,
        suggestions: WEAK_VERB_REPLACEMENTS[phrase],
      });
    }
  }

  return found.sort((a, b) => a.index - b.index);
}

/**
 * A ready-to-show rewrite hint for the first weak phrase in a bullet.
 *
 * @param {unknown} bullet
 * @returns {string|null}
 */
export function suggestReplacement(bullet) {
  const [first] = findWeakVerbs(bullet);
  if (!first) return null;

  return `"${first.phrase}" -> ${first.suggestions.slice(0, 3).join(', ')}`;
}

/** Total distinct strong verbs catalogued. Handy for a sanity check. */
export const STRONG_VERB_COUNT = STRONG_ACTION_VERBS.length;
