/**
 * Keyword gap analysis: what the JD asks for, and what the resume actually
 * says.
 *
 * Pure and deterministic. No AI call, no provider, no API key, no network.
 * Input is the two already-parsed JSON objects from resumeParser.js and
 * jdParser.js; output is a classification of every JD keyword. Running this
 * twice on the same input must give the same answer, which is the whole
 * reason it is not an AI call.
 *
 * DEFENSIVE BY CONTRACT
 * ---------------------
 * Parsed objects arrive with keys missing. Gemini and DeepSeek do not
 * guarantee every schema key is present -- DeepSeek's json_object mode
 * enforces no schema at all -- so any field may be undefined, null, or the
 * wrong type. Every read goes through `asArray` / `asString` / `asObject`.
 * A missing `experience` array must produce a smaller corpus and a lower
 * score, never a throw. Do not "simplify" those guards away on the strength
 * of what a schema currently promises.
 */

import { SKILL_SYNONYM_GROUPS, getSynonyms, canonicalise, normaliseSkill } from '../utils/skillSynonyms.js';

// ---------------------------------------------------------------------------
// Type guards -- every field from a parsed object goes through one of these
// ---------------------------------------------------------------------------

/** @returns {any[]} */
export const asArray = (v) => (Array.isArray(v) ? v : []);

/** @returns {string} */
export const asString = (v) => (typeof v === 'string' ? v : '');

/** @returns {Record<string, any>} */
export const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** Priority weights for the priority-weighted match rate. */
export const PRIORITY_WEIGHTS = { high: 3, medium: 2, low: 1 };

/** A synonym match is worth this fraction of an exact match. */
export const PARTIAL_CREDIT = 0.6;

// ---------------------------------------------------------------------------
// Keyword boundary matching
//
// THE BUG THIS EXISTS TO PREVENT
// ------------------------------
// `\b` is wrong for skill names, in both directions, and it fails silently:
//
//   /\bC\b/          matches the "C" inside "C++" and "C#"   -> false positive
//   /\bC\+\+\b/      never matches anything at all           -> false negative
//                    (`\b` after "+" needs a word char next; "C++ code" has a
//                     space, so the boundary assertion can never hold)
//   /\b\.NET\b/      never matches at the start of a string  -> false negative
//   /\bR\b/          matches the "R" inside "R&D"            -> false positive
//
// So boundaries are defined by what may sit *next to* a term, not by `\b`:
//
//   left  -- the preceding character must not be alphanumeric.
//   right -- the following character must not be alphanumeric, and must not be
//            `+`, `#` or `&`. Those three extend a term's identity: C, C++ and
//            C# are three skills, and "R&D" is not "R".
//
// Punctuation that merely separates ( , . / ) is *not* excluded on the right,
// so "C" matches in "C, Python" and in "C/C++", and "Node" matches inside
// "Node.js" -- all of which are wanted.
//
// Lookbehind would express the left rule more directly. It is avoided
// deliberately: an unsupported lookbehind is a SyntaxError at regex
// construction, which takes out the whole feature on one browser rather than
// degrading. The leading character is consumed by a capture group instead,
// which is safe for adjacent occurrences because the character consumed by
// one match is always the separator *before* it, never one a later match
// needs.
// ---------------------------------------------------------------------------

/** Characters that continue a skill name to the right. */
const RIGHT_EXTENDERS = 'A-Za-z0-9+#&';

/**
 * Terms this short and purely alphabetic collide with ordinary English --
 * "go", "r", "c", "it". For those, and only those, matching is
 * case-sensitive and requires a capitalised form, because every resume writes
 * the language as "Go", "R", "C". Without this, "we go to market" scores as
 * the Go language.
 */
const AMBIGUOUS_SHORT_TERM = /^[a-z]{1,2}$/;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build the occurrence-matching regex for one keyword.
 *
 * @param {unknown} term
 * @returns {RegExp|null} Null when the term is unusable.
 */
export function buildTermPattern(term) {
  const raw = asString(term).trim();
  if (!raw) return null;

  const normalised = normaliseSkill(raw);
  if (!normalised) return null;

  const body = escapeRegex(raw);
  const boundary = `(^|[^A-Za-z0-9])(?:${body})(?![${RIGHT_EXTENDERS}])`;

  if (AMBIGUOUS_SHORT_TERM.test(normalised)) {
    // Case-sensitive, and only in a capitalised form: "C" and "GO", not "go".
    const title = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    const upper = raw.toUpperCase();
    const forms = [...new Set([title, upper])].map(escapeRegex).join('|');
    return new RegExp(`(^|[^A-Za-z0-9])(?:${forms})(?![${RIGHT_EXTENDERS}])`, 'g');
  }

  return new RegExp(boundary, 'gi');
}

/**
 * How many times a term occurs in a body of text, using the boundary rules
 * above rather than `\b`.
 *
 * @param {unknown} text
 * @param {unknown} term
 * @returns {number}
 */
export function countOccurrences(text, term) {
  const haystack = asString(text);
  if (!haystack) return 0;

  const pattern = buildTermPattern(term);
  if (!pattern) return 0;

  let count = 0;
  // The pattern is freshly built, so lastIndex starts at 0 and this loop
  // cannot inherit state from a previous call.
  while (pattern.exec(haystack) !== null) count += 1;
  return count;
}

/** Convenience predicate over `countOccurrences`. */
export const containsTerm = (text, term) => countOccurrences(text, term) > 0;

// ---------------------------------------------------------------------------
// Turning a parsed resume into searchable text
// ---------------------------------------------------------------------------

/**
 * Flatten a parsed resume into text, whole and by section.
 *
 * `topThird` is the placement window the ATS scorer uses: the summary plus
 * the first experience entry. That is a structural definition, not a literal
 * third of the characters -- see the note in atsScorer.js.
 *
 * Every field is read defensively; a resume missing every key yields empty
 * strings rather than throwing.
 *
 * @param {unknown} parsedResume
 * @returns {{
 *   full: string,
 *   sections: Record<string, string>,
 *   topThird: string,
 *   bullets: string[],
 *   presentSections: string[]
 * }}
 */
export function collectResumeText(parsedResume) {
  const resume = asObject(parsedResume);
  const contact = asObject(resume.contact);

  const linkText = (links) =>
    asArray(links)
      .map((l) => `${asString(asObject(l).label)} ${asString(asObject(l).url)}`)
      .join(' ');

  const sections = {
    name: asString(resume.name),

    contact: [
      asString(contact.email),
      asString(contact.phone),
      asString(contact.location),
      linkText(contact.customLinks),
    ]
      .filter(Boolean)
      .join(' '),

    summary: asString(resume.summary),

    skills: asArray(resume.skills)
      .map((group) => {
        const g = asObject(group);
        return `${asString(g.category)}: ${asArray(g.skills).map(asString).join(', ')}`;
      })
      .join('\n'),

    experience: asArray(resume.experience)
      .map((entry) => {
        const e = asObject(entry);
        return [
          asString(e.title),
          asString(e.company),
          asString(e.location),
          asArray(e.bullets).map(asString).join('\n'),
          linkText(e.links),
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n'),

    projects: asArray(resume.projects)
      .map((entry) => {
        const p = asObject(entry);
        return [
          asString(p.name),
          asString(p.description),
          asArray(p.bullets).map(asString).join('\n'),
          linkText(p.links),
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n'),

    education: asArray(resume.education)
      .map((entry) => {
        const e = asObject(entry);
        return [
          asString(e.institution),
          asString(e.degree),
          asString(e.field),
          asArray(e.details).map(asString).join(' '),
        ]
          .filter(Boolean)
          .join(' ');
      })
      .join('\n'),

    certifications: asArray(resume.certifications)
      .map((entry) => {
        const c = asObject(entry);
        return [asString(c.name), asString(c.issuer), asString(c.url)].filter(Boolean).join(' ');
      })
      .join('\n'),
  };

  // Every bullet in the document, for the XYZ-formula check.
  const bullets = [
    ...asArray(resume.experience).flatMap((e) => asArray(asObject(e).bullets)),
    ...asArray(resume.projects).flatMap((p) => asArray(asObject(p).bullets)),
  ]
    .map(asString)
    .filter((b) => b.trim() !== '');

  const firstRole = asObject(asArray(resume.experience)[0]);
  const topThird = [
    sections.summary,
    asString(firstRole.title),
    asString(firstRole.company),
    asArray(firstRole.bullets).map(asString).join('\n'),
  ]
    .filter(Boolean)
    .join('\n');

  return {
    full: Object.values(sections).filter(Boolean).join('\n\n'),
    sections,
    topThird,
    bullets,
    presentSections: Object.keys(sections).filter((k) => sections[k].trim() !== ''),
  };
}

/**
 * Every skill named in the resume's `skills` buckets, flattened.
 * @param {unknown} parsedResume
 * @returns {string[]}
 */
export function collectResumeSkills(parsedResume) {
  return asArray(asObject(parsedResume).skills)
    .flatMap((group) => asArray(asObject(group).skills))
    .map(asString)
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Pulling keywords out of a parsed JD
// ---------------------------------------------------------------------------

/**
 * Longest a fallback-sourced term may be before it is treated as prose.
 *
 * `requiredSkills` legitimately contains whole clauses -- "5+ years of
 * backend engineering experience" is a requirement, not a keyword. Such a
 * string can never match literally, so admitting it would park a permanent
 * unearnable penalty in the score. `atsKeywords` entries are exempt: the JD
 * prompt asks for keywords there, so a long one is a deliberate phrase.
 */
const MAX_FALLBACK_KEYWORD_WORDS = 4;
const MAX_FALLBACK_KEYWORD_CHARS = 40;

const isKeywordShaped = (term) =>
  term.length <= MAX_FALLBACK_KEYWORD_CHARS && term.split(/\s+/).filter(Boolean).length <= MAX_FALLBACK_KEYWORD_WORDS;

/**
 * Collect JD keywords with their priority.
 *
 * `atsKeywords.{high,medium,low}` is the authority. The JD prompt asks the
 * model to weigh each keyword by how hard the posting leans on it, and that
 * judgment is better than anything inferable from which list a skill landed
 * in -- a posting saying "Strong Go or Java. We use Go." rates Java low on
 * purpose.
 *
 * `requiredSkills` / `preferredSkills` are therefore a strict *fallback*:
 * they contribute only terms `atsKeywords` never mentioned, so a JD parse
 * that filled one field but not the other still yields an analysis. They
 * never promote or demote a keyword `atsKeywords` already rated. An earlier
 * version let them override, which silently re-rated a deliberate "low" to
 * "high" and skewed the priority-weighted score.
 *
 * @param {unknown} parsedJD
 * @returns {Array<{ keyword: string, priority: 'high'|'medium'|'low', source: string }>}
 */
export function collectJDKeywords(parsedJD) {
  const jd = asObject(parsedJD);
  const ats = asObject(jd.atsKeywords);

  /** @type {Map<string, { keyword: string, priority: string, source: string }>} */
  const byNormalised = new Map();

  const add = (term, priority, source, { keywordShapedOnly = false } = {}) => {
    const keyword = asString(term).trim();
    if (!keyword) return;
    if (keywordShapedOnly && !isKeywordShaped(keyword)) return;

    const key = normaliseSkill(keyword);
    if (!key) return;

    // First writer wins. atsKeywords runs first, so its rating is never
    // overwritten by the fallback lists.
    if (byNormalised.has(key)) return;

    byNormalised.set(key, { keyword, priority, source });
  };

  asArray(ats.high).forEach((t) => add(t, 'high', 'atsKeywords'));
  asArray(ats.medium).forEach((t) => add(t, 'medium', 'atsKeywords'));
  asArray(ats.low).forEach((t) => add(t, 'low', 'atsKeywords'));

  asArray(jd.requiredSkills).forEach((t) => add(t, 'high', 'requiredSkills', { keywordShapedOnly: true }));
  asArray(jd.preferredSkills).forEach((t) => add(t, 'low', 'preferredSkills', { keywordShapedOnly: true }));

  return [...byNormalised.values()];
}

// ---------------------------------------------------------------------------
// The analysis
// ---------------------------------------------------------------------------

const emptyBucketCounts = () => ({ matched: 0, partial: 0, missing: 0, total: 0 });

/**
 * Classify every JD keyword against the resume.
 *
 * A keyword is:
 *   matched -- it occurs literally in the resume text.
 *   partial -- it does not, but one of its synonyms does. Worth
 *              `PARTIAL_CREDIT` (0.6), because the resume says something
 *              adjacent rather than the thing asked for.
 *   missing -- neither.
 *
 * @param {unknown} parsedResume
 * @param {unknown} parsedJD
 * @returns {{
 *   matched: Array<object>,
 *   partial: Array<object>,
 *   missing: Array<object>,
 *   densityMap: Record<string, number>,
 *   matchRate: number,
 *   weightedMatchRate: number,
 *   byPriority: Record<string, object>,
 *   totalKeywords: number,
 *   degraded: { noKeywords: boolean, noResumeText: boolean, reasons: string[] }
 * }}
 */
export function analyzeCompetencyGaps(parsedResume, parsedJD) {
  const { full: resumeText } = collectResumeText(parsedResume);
  const keywords = collectJDKeywords(parsedJD);

  const matched = [];
  const partial = [];
  const missing = [];
  /** @type {Record<string, number>} */
  const densityMap = {};
  const byPriority = { high: emptyBucketCounts(), medium: emptyBucketCounts(), low: emptyBucketCounts() };

  for (const { keyword, priority } of keywords) {
    const bucket = byPriority[priority] || byPriority.low;
    bucket.total += 1;

    const exact = countOccurrences(resumeText, keyword);

    if (exact > 0) {
      densityMap[keyword] = exact;
      matched.push({ keyword, priority, occurrences: exact, matchedVia: keyword, matchType: 'exact' });
      bucket.matched += 1;
      continue;
    }

    // No literal hit. Try the keyword's synonym group.
    const synonymHits = [];
    let synonymTotal = 0;
    for (const synonym of getSynonyms(keyword)) {
      const n = countOccurrences(resumeText, synonym);
      if (n > 0) {
        synonymHits.push({ term: synonym, occurrences: n });
        synonymTotal += n;
      }
    }

    if (synonymHits.length > 0) {
      // Most frequent synonym is the most representative thing to report.
      synonymHits.sort((a, b) => b.occurrences - a.occurrences);
      densityMap[keyword] = synonymTotal;
      partial.push({
        keyword,
        priority,
        occurrences: synonymTotal,
        matchedVia: synonymHits[0].term,
        canonical: canonicalise(keyword),
        allMatches: synonymHits,
        matchType: 'synonym',
      });
      bucket.partial += 1;
      continue;
    }

    missing.push({ keyword, priority, occurrences: 0, matchType: 'none' });
    bucket.missing += 1;
  }

  const total = keywords.length;
  const credit = matched.length + partial.length * PARTIAL_CREDIT;
  const matchRate = total === 0 ? 0 : round1((credit / total) * 100);

  // Priority-weighted: missing a "high" keyword should hurt more than missing
  // a "low" one. The ATS scorer uses this rather than the flat rate.
  let earned = 0;
  let possible = 0;
  for (const { priority } of keywords) possible += PRIORITY_WEIGHTS[priority] ?? 1;
  for (const { priority } of matched) earned += PRIORITY_WEIGHTS[priority] ?? 1;
  for (const { priority } of partial) earned += (PRIORITY_WEIGHTS[priority] ?? 1) * PARTIAL_CREDIT;
  const weightedMatchRate = possible === 0 ? 0 : round1((earned / possible) * 100);

  const reasons = [];
  if (total === 0) reasons.push('The job description produced no keywords to match against.');
  if (resumeText.trim() === '') reasons.push('The resume produced no text to search.');

  return {
    matched,
    partial,
    missing,
    densityMap,
    matchRate,
    weightedMatchRate,
    byPriority,
    totalKeywords: total,
    degraded: {
      noKeywords: total === 0,
      noResumeText: resumeText.trim() === '',
      reasons,
    },
  };
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Skills the resume claims that the JD never asks for. Not part of the score
 * -- it feeds the "what to cut" side of tailoring later.
 *
 * @param {unknown} parsedResume
 * @param {unknown} parsedJD
 * @returns {string[]}
 */
export function findUnusedResumeSkills(parsedResume, parsedJD) {
  const keywords = collectJDKeywords(parsedJD);
  const jdKeys = new Set(keywords.map((k) => normaliseSkill(k.keyword)));

  // A resume skill counts as "used" if the JD names it or any of its synonyms.
  const jdGroups = new Set(
    keywords.map((k) => canonicalise(k.keyword)).filter(Boolean).map(normaliseSkill)
  );

  return collectResumeSkills(parsedResume).filter((skill) => {
    const key = normaliseSkill(skill);
    if (jdKeys.has(key)) return false;

    const canonical = canonicalise(skill);
    return !(canonical && jdGroups.has(normaliseSkill(canonical)));
  });
}

/** Exposed so the manual tests can assert the map loaded. */
export const SYNONYM_GROUP_COUNT = SKILL_SYNONYM_GROUPS.length;
