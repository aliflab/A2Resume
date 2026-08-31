/**
 * ATS score: 100 points across six weighted criteria.
 *
 * Pure and deterministic, like gapAnalyzer.js -- no AI call, no provider, no
 * network. Same input contract too: any field of either parsed object may be
 * absent or the wrong type, and every read is guarded.
 *
 * WHAT THIS NUMBER IS AND IS NOT
 * ------------------------------
 * It is a heuristic proxy for how a keyword-matching applicant tracking
 * system and a skimming recruiter are likely to treat the resume. It is not a
 * simulation of any specific ATS -- no vendor publishes its ranking -- and
 * three of the six criteria required judgment calls that are documented at
 * their implementations below. Read `breakdown[].notes` before treating a
 * sub-score as objective.
 */

import {
  asArray,
  asObject,
  asString,
  collectResumeText,
  collectJDKeywords,
  countOccurrences,
  analyzeCompetencyGaps,
} from './gapAnalyzer.js';
import { findWeakVerbs, startsWithStrongVerb } from '../utils/actionVerbs.js';
import { isKnownSkill, canonicalise, normaliseSkill } from '../utils/skillSynonyms.js';

// ---------------------------------------------------------------------------
// Weights. These sum to 100 and the code asserts it below.
// ---------------------------------------------------------------------------

export const CRITERION_WEIGHTS = {
  keywordDensity: 35,
  topThirdPlacement: 15,
  sectionHierarchy: 15,
  bulletQuality: 15,
  skillBreadth: 10,
  contactParsability: 10,
};

export const MAX_SCORE = Object.values(CRITERION_WEIGHTS).reduce((a, b) => a + b, 0);

if (MAX_SCORE !== 100) {
  // A miscount here silently rescales every score, so it is worth shouting.
  console.warn(`atsScorer: criterion weights sum to ${MAX_SCORE}, not 100.`);
}

/** Below this fraction of a criterion's max, it earns a recommendation. */
const RECOMMEND_BELOW = 0.7;

const round1 = (n) => Math.round(n * 10) / 10;
const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

// ---------------------------------------------------------------------------
// 1. Keyword density match -- 35
// ---------------------------------------------------------------------------

/**
 * Two parts, because "density" and "coverage" are different failures:
 *
 *   coverage (28) -- how much of what the JD asks for appears at all, using
 *                    the gap analyser's priority-weighted rate so a missing
 *                    "high" keyword costs more than a missing "low" one.
 *   density   (7) -- how many matched keywords appear more than once. A term
 *                    mentioned once in a skills list reads as a claim; the
 *                    same term recurring in bullets reads as experience.
 *
 * Repetition is capped at "appears at least twice" on purpose. Rewarding
 * raw frequency would reward keyword stuffing, which modern parsers punish;
 * excessive repetition is surfaced as a warning instead of a penalty.
 */
function scoreKeywordDensity(gap) {
  const max = CRITERION_WEIGHTS.keywordDensity;
  const notes = [];

  const totalKeywords = gap.totalKeywords ?? 0;
  if (totalKeywords === 0) {
    return {
      score: 0,
      max,
      scoreable: false,
      notes: ['The job description produced no keywords, so coverage cannot be measured.'],
      detail: { coverage: 0, density: 0, reinforced: 0, stuffed: [] },
    };
  }

  const coverage = round1((clamp01((gap.weightedMatchRate ?? 0) / 100) * max * 28) / 35);

  const present = [...asArray(gap.matched), ...asArray(gap.partial)];
  const reinforced = present.filter((k) => (k.occurrences ?? 0) >= 2);
  const densityRatio = present.length === 0 ? 0 : reinforced.length / present.length;
  const density = round1(clamp01(densityRatio) * ((max * 7) / 35));

  const stuffed = present.filter((k) => (k.occurrences ?? 0) > 8).map((k) => k.keyword);
  if (stuffed.length > 0) {
    notes.push(`Very high repetition (>8x) on: ${stuffed.join(', ')}. Not penalised, but it reads as stuffing.`);
  }
  notes.push('Coverage is priority-weighted: high-priority JD keywords count 3x low-priority ones.');

  return {
    score: round1(coverage + density),
    max,
    scoreable: true,
    notes,
    detail: {
      coverage,
      density,
      reinforced: reinforced.length,
      presentCount: present.length,
      stuffed,
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Top-third keyword placement -- 15
// ---------------------------------------------------------------------------

/**
 * JUDGMENT CALL: what "top third" means.
 *
 * Parsing destroys page geometry. By the time this runs, the resume is a JSON
 * object with no pages, no line positions, and no character offsets back into
 * the original PDF -- so a literal upper third of the page cannot be
 * computed, and a literal first third of the characters would move with
 * section verbosity rather than with layout.
 *
 * So "top third" is defined structurally: the summary plus the first
 * experience entry, which is what occupies the top of a conventionally
 * ordered resume. `collectResumeText` builds that window as `topThird`.
 *
 * This is the criterion most worth reviewing by eye. It is right for a
 * standard chronological layout and wrong for a resume that leads with
 * projects or education -- for those it measures something real, but not the
 * thing the name promises.
 *
 * Only high-priority keywords are measured. Placement of a low-priority
 * keyword is not a signal worth 15 points.
 */
function scoreTopThirdPlacement(parsedResume, gap) {
  const max = CRITERION_WEIGHTS.topThirdPlacement;
  const { topThird } = collectResumeText(parsedResume);
  const notes = [
    'Window is structural: the summary plus the first experience entry. Page position is not recoverable after parsing.',
  ];

  const present = [...asArray(gap.matched), ...asArray(gap.partial)];
  let pool = present.filter((k) => k.priority === 'high');

  if (pool.length === 0) {
    // No high-priority keywords landed anywhere. Fall back to all present
    // keywords rather than reporting a placement score for an empty set.
    pool = present;
    if (pool.length > 0) notes.push('No high-priority keywords matched; measured across all matched keywords instead.');
  }

  if (pool.length === 0 || topThird.trim() === '') {
    return {
      score: 0,
      max,
      scoreable: false,
      notes: [
        ...notes,
        topThird.trim() === ''
          ? 'No summary or first experience entry to measure placement within.'
          : 'No keywords matched anywhere in the resume.',
      ],
      detail: { inTopThird: [], buriedBelow: [], poolSize: 0 },
    };
  }

  const inTopThird = [];
  const buriedBelow = [];
  for (const k of pool) {
    const term = asString(k.matchedVia) || asString(k.keyword);
    if (countOccurrences(topThird, term) > 0) inTopThird.push(k.keyword);
    else buriedBelow.push(k.keyword);
  }

  return {
    score: round1((inTopThird.length / pool.length) * max),
    max,
    scoreable: true,
    notes,
    detail: { inTopThird, buriedBelow, poolSize: pool.length },
  };
}

// ---------------------------------------------------------------------------
// 3. Standard section hierarchy -- 15
// ---------------------------------------------------------------------------

/**
 * JUDGMENT CALL: order cannot be checked, only presence and substance.
 *
 * The brief asks for "conventional order/structure". Order is not
 * recoverable: `RESUME_SCHEMA` fixes the key order of the parsed object, so
 * every parsed resume presents its sections in schema order regardless of how
 * the source document arranged them. Checking it would measure the schema,
 * not the resume, and would return a perfect score for every input.
 *
 * What is checked instead is presence *and* substance -- a section that
 * exists but carries nothing earns nothing, and an experience section whose
 * entries have no bullets earns partial credit. Weights reflect how much each
 * section matters to a screen, not an even split.
 *
 * To score real ordering, the section sequence would have to be captured
 * during PDF extraction and carried through the parse. That is a change to
 * pdfParser.js and RESUME_SCHEMA, not to this file.
 */
function scoreSectionHierarchy(parsedResume) {
  const max = CRITERION_WEIGHTS.sectionHierarchy;
  const resume = asObject(parsedResume);
  const { sections } = collectResumeText(parsedResume);

  const experience = asArray(resume.experience);
  const withBullets = experience.filter((e) => asArray(asObject(e).bullets).some((b) => asString(b).trim()));

  /** Each: [name, weight, earnedFraction, note] */
  const checks = [
    ['summary', 3, sections.summary.trim() ? 1 : 0],
    [
      'experience',
      5,
      experience.length === 0 ? 0 : withBullets.length === 0 ? 0.4 : 0.6 + 0.4 * clamp01(withBullets.length / experience.length),
    ],
    ['skills', 4, asArray(resume.skills).some((g) => asArray(asObject(g).skills).length > 0) ? 1 : 0],
    ['education', 3, asArray(resume.education).length > 0 ? 1 : 0],
  ];

  const missing = [];
  let score = 0;
  for (const [name, weight, fraction] of checks) {
    score += weight * fraction;
    if (fraction === 0) missing.push(name);
  }

  const notes = ['Section ORDER is not measured -- it is not recoverable from the parsed object. Presence and substance only.'];
  if (experience.length > 0 && withBullets.length < experience.length) {
    notes.push(`${experience.length - withBullets.length} of ${experience.length} experience entries have no bullets.`);
  }

  return {
    score: round1(score),
    max,
    scoreable: true,
    notes,
    detail: { missing, experienceEntries: experience.length, entriesWithBullets: withBullets.length },
  };
}

// ---------------------------------------------------------------------------
// 4. XYZ-formula bullet quality -- 15
// ---------------------------------------------------------------------------

/**
 * "Accomplished X, as measured by Y, by doing Z" -- scored as four signals
 * per bullet, averaged across all bullets:
 *
 *   verb   (0.30) -- opens with a strong action verb (actionVerbs.js)
 *   metric (0.35) -- carries a quantified result. Weighted highest because it
 *                    is the signal most resumes actually lack.
 *   tech   (0.20) -- names a concrete technology or skill
 *   body   (0.15) -- long enough to be a claim rather than a fragment
 *
 * JUDGMENT CALL: `tech` is detected via the skillSynonyms index, so a bullet
 * using a technology that is not in that map scores zero on this signal even
 * though a human would credit it. The map is a starting set and this
 * criterion gets more accurate as it grows. That is a known bias toward
 * mainstream tooling.
 *
 * JUDGMENT CALL: `metric` deliberately ignores bare four-digit years, so
 * "since 2019" is not mistaken for a quantified outcome. It does count
 * percentages, currency, multipliers, durations, and plain counts.
 */
const YEAR_LIKE = /\b(?:19|20)\d{2}\b/g;
const METRIC_PATTERNS = [
  /\d+(?:\.\d+)?\s*%/, // 40%
  /[$£€¥]\s?\d/, // $2M
  /\b\d+(?:\.\d+)?\s*[kmb]\b/i, // 2.3M, 400k
  /\b\d+(?:\.\d+)?\s*x\b/i, // 3x
  /\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds|min|mins|minutes|hours?|days?|weeks?|months?|years?)\b/i,
  /\b\d{1,3}(?:,\d{3})+\b/, // 1,200,000
  /\b\d+(?:\.\d+)?\b/, // any remaining plain number
];

function bulletSignals(bullet) {
  const text = asString(bullet);
  const withoutYears = text.replace(YEAR_LIKE, ' ');

  const verb = startsWithStrongVerb(text);
  const weak = findWeakVerbs(text);
  const metric = METRIC_PATTERNS.some((re) => re.test(withoutYears));

  // Any token that the synonym index recognises as a real skill name.
  const tech = withoutYears
    .split(/[^A-Za-z0-9+#./-]+/)
    .filter(Boolean)
    .some((token) => isKnownSkill(token.replace(/[.,;:]+$/, '')));

  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const body = words >= 8;

  return { verb: verb.ok, verbWord: verb.word, metric, tech, body, words, weak };
}

function scoreBulletQuality(parsedResume) {
  const max = CRITERION_WEIGHTS.bulletQuality;
  const { bullets } = collectResumeText(parsedResume);

  if (bullets.length === 0) {
    return {
      score: 0,
      max,
      scoreable: false,
      notes: ['No bullets found in experience or projects.'],
      detail: { bulletCount: 0, weakVerbBullets: [], noMetricCount: 0, noVerbCount: 0 },
    };
  }

  const weights = { verb: 0.3, metric: 0.35, tech: 0.2, body: 0.15 };
  let total = 0;
  const weakVerbBullets = [];
  let noMetricCount = 0;
  let noVerbCount = 0;

  for (const bullet of bullets) {
    const s = bulletSignals(bullet);
    total += (s.verb ? weights.verb : 0) + (s.metric ? weights.metric : 0) + (s.tech ? weights.tech : 0) + (s.body ? weights.body : 0);

    if (!s.metric) noMetricCount += 1;
    if (!s.verb) noVerbCount += 1;
    if (s.weak.length > 0) {
      weakVerbBullets.push({
        bullet: bullet.slice(0, 90),
        phrase: s.weak[0].phrase,
        suggestions: s.weak[0].suggestions.slice(0, 3),
      });
    }
  }

  return {
    score: round1((total / bullets.length) * max),
    max,
    scoreable: true,
    notes: [
      'Technology detection relies on the skillSynonyms map; bullets using tooling outside that map under-score.',
      'Bare four-digit years are not counted as quantified impact.',
    ],
    detail: { bulletCount: bullets.length, weakVerbBullets, noMetricCount, noVerbCount },
  };
}

// ---------------------------------------------------------------------------
// 5. Technical skill category breadth -- 10
// ---------------------------------------------------------------------------

/**
 * JUDGMENT CALL: category names come from the parse, not the resume.
 *
 * `skills` is an array of `{ category, skills[] }` buckets, and the category
 * labels are whatever the extracting model chose. A resume with one
 * undifferentiated "Skills:" line yields one category however broad it
 * actually is, and different providers bucket the same resume differently.
 *
 * Counting categories alone would therefore measure the parse. So breadth is
 * scored twice and blended: declared categories (6) and how many distinct
 * synonym groups the skills actually span (4). The second half is
 * parse-independent -- five flavours of JavaScript collapse to one group,
 * while Go, Postgres, Kafka and Terraform span four.
 */
function scoreSkillBreadth(parsedResume) {
  const max = CRITERION_WEIGHTS.skillBreadth;
  const groups = asArray(asObject(parsedResume).skills);

  const populated = groups.filter((g) => asArray(asObject(g).skills).some((s) => asString(s).trim()));
  const allSkills = groups.flatMap((g) => asArray(asObject(g).skills)).map(asString).filter(Boolean);

  if (allSkills.length === 0) {
    return {
      score: 0,
      max,
      scoreable: false,
      notes: ['No skills found to measure breadth across.'],
      detail: { categories: 0, distinctGroups: 0, skillCount: 0, unrecognised: [] },
    };
  }

  // Declared categories, saturating at 5.
  const categoryScore = clamp01(populated.length / 5) * 6;

  // Distinct synonym groups, saturating at 8. Unrecognised skills each count
  // as their own group -- an unknown skill is still a distinct claim, and
  // punishing it would just penalise anything outside the map.
  const seen = new Set();
  const unrecognised = [];
  for (const skill of allSkills) {
    const canonical = canonicalise(skill);
    if (canonical) seen.add(normaliseSkill(canonical));
    else {
      seen.add(`?${normaliseSkill(skill)}`);
      unrecognised.push(skill);
    }
  }
  const diversityScore = clamp01(seen.size / 8) * 4;

  return {
    score: round1(categoryScore + diversityScore),
    max,
    scoreable: true,
    notes: ['Category labels are chosen by the parsing model, so half the weight uses parse-independent synonym-group spread.'],
    detail: {
      categories: populated.length,
      distinctGroups: seen.size,
      skillCount: allSkills.length,
      unrecognised: unrecognised.slice(0, 10),
    },
  };
}

// ---------------------------------------------------------------------------
// 6. Contact info parsability -- 10
// ---------------------------------------------------------------------------

/**
 * Presence is not enough -- an ATS has to be able to *extract* each field, so
 * each is checked for a plausible shape and earns half credit when present
 * but malformed.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

function scoreContactParsability(parsedResume) {
  const max = CRITERION_WEIGHTS.contactParsability;
  const resume = asObject(parsedResume);
  const contact = asObject(resume.contact);

  const name = asString(resume.name).trim();
  const email = asString(contact.email).trim();
  const phone = asString(contact.phone).trim();
  const links = asArray(contact.customLinks)
    .map((l) => asString(asObject(l).url).trim())
    .filter(Boolean);

  const issues = [];
  const each = max / 4;

  // Name: present, and not a whole line of extra text.
  let nameScore = 0;
  if (!name) issues.push('no name');
  else if (name.length > 60 || name.split(/\s+/).length > 5) {
    nameScore = each / 2;
    issues.push('name field looks like it absorbed other text');
  } else nameScore = each;

  let emailScore = 0;
  if (!email) issues.push('no email');
  else if (!EMAIL_RE.test(email)) {
    emailScore = each / 2;
    issues.push(`email "${email}" is not in a cleanly extractable form`);
  } else emailScore = each;

  let phoneScore = 0;
  const digits = phone.replace(/\D/g, '').length;
  if (!phone) issues.push('no phone number');
  else if (digits < 7) {
    phoneScore = each / 2;
    issues.push(`phone "${phone}" has too few digits to be parsed`);
  } else phoneScore = each;

  let linkScore = 0;
  const usableLinks = links.filter((u) => /\./.test(u) && !/\s/.test(u));
  if (links.length === 0) issues.push('no links (portfolio, LinkedIn, GitHub)');
  else if (usableLinks.length === 0) {
    linkScore = each / 2;
    issues.push('links are present but not in an extractable url form');
  } else linkScore = each;

  return {
    score: round1(nameScore + emailScore + phoneScore + linkScore),
    max,
    scoreable: true,
    notes: ['Malformed-but-present fields earn half credit; an ATS usually recovers something from them.'],
    detail: { issues, hasName: !!name, hasEmail: !!email, hasPhone: !!phone, linkCount: links.length },
  };
}

// ---------------------------------------------------------------------------
// Fallback detection
// ---------------------------------------------------------------------------

/**
 * Is there enough here to produce a score worth showing?
 *
 * @returns {{ isFallback: boolean, reasons: string[] }}
 */
function assessInput(parsedResume, parsedJD) {
  const reasons = [];
  const resume = asObject(parsedResume);
  const hasResume = parsedResume && typeof parsedResume === 'object' && !Array.isArray(parsedResume);

  if (!hasResume) reasons.push('No parsed resume was supplied.');
  else {
    if (Object.keys(resume).length === 0) reasons.push('The parsed resume is an empty object.');
    if (asArray(resume.experience).length === 0) reasons.push('The resume has no experience entries.');
    if (asArray(resume.skills).length === 0) reasons.push('The resume has no skills section.');
  }

  const hasJD = parsedJD && typeof parsedJD === 'object' && !Array.isArray(parsedJD);
  if (!hasJD) reasons.push('No parsed job description was supplied.');
  else if (collectJDKeywords(parsedJD).length === 0) {
    reasons.push('The job description produced no keywords.');
  }

  return { isFallback: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

function buildRecommendations(breakdown, gap, input) {
  const recs = [];
  const at = (id) => breakdown.find((b) => b.id === id) || {};
  const weak = (id) => {
    const c = at(id);
    return c.scoreable && c.max > 0 && c.score / c.max < RECOMMEND_BELOW;
  };

  if (input.isFallback) {
    recs.push({
      severity: 'critical',
      criterion: 'input',
      text: `This score is not reliable: ${input.reasons.join(' ')} Fill the gaps and re-run for a real score.`,
    });
  }

  // 1. Keywords.
  const missingHigh = asArray(gap.missing).filter((k) => k.priority === 'high');
  if (missingHigh.length > 0) {
    recs.push({
      severity: missingHigh.length > 3 ? 'critical' : 'important',
      criterion: 'keywordDensity',
      text: `${missingHigh.length} high-priority keyword${missingHigh.length === 1 ? '' : 's'} from the job description ${missingHigh.length === 1 ? 'is' : 'are'} absent: ${missingHigh.slice(0, 6).map((k) => k.keyword).join(', ')}${missingHigh.length > 6 ? ', ...' : ''}. Work the genuine ones into your bullets.`,
    });
  }
  const partials = asArray(gap.partial).filter((k) => k.priority === 'high');
  if (partials.length > 0) {
    recs.push({
      severity: 'suggestion',
      criterion: 'keywordDensity',
      text: `${partials.length} high-priority keyword${partials.length === 1 ? '' : 's'} only matched by synonym: ${partials.slice(0, 5).map((k) => `${k.keyword} (you wrote "${k.matchedVia}")`).join(', ')}. An ATS matching literally will miss these -- use the job description's exact wording where it is honest to.`,
    });
  }
  const stuffed = asArray(at('keywordDensity').detail?.stuffed);
  if (stuffed.length > 0) {
    recs.push({
      severity: 'suggestion',
      criterion: 'keywordDensity',
      text: `These terms appear more than 8 times: ${stuffed.join(', ')}. That reads as keyword stuffing to a human reviewer.`,
    });
  }

  // 2. Placement.
  if (weak('topThirdPlacement')) {
    const buried = asArray(at('topThirdPlacement').detail?.buriedBelow);
    if (buried.length > 0) {
      recs.push({
        severity: 'important',
        criterion: 'topThirdPlacement',
        text: `${buried.length} high-priority keyword${buried.length === 1 ? '' : 's'} appear only below your first role: ${buried.slice(0, 5).join(', ')}. Surface the relevant ones in your summary or most recent position.`,
      });
    }
  }

  // 3. Sections.
  const missingSections = asArray(at('sectionHierarchy').detail?.missing);
  if (missingSections.length > 0) {
    recs.push({
      severity: 'important',
      criterion: 'sectionHierarchy',
      text: `Missing or empty standard section${missingSections.length === 1 ? '' : 's'}: ${missingSections.join(', ')}. Most ATS parsers look for these by heading.`,
    });
  }
  const noBullets = (at('sectionHierarchy').detail?.experienceEntries ?? 0) - (at('sectionHierarchy').detail?.entriesWithBullets ?? 0);
  if (noBullets > 0) {
    recs.push({
      severity: 'important',
      criterion: 'sectionHierarchy',
      text: `${noBullets} experience entr${noBullets === 1 ? 'y has' : 'ies have'} no bullets. A role with only a title and dates contributes nothing to keyword matching.`,
    });
  }

  // 4. Bullets.
  const bq = at('bulletQuality').detail || {};
  const weakBullets = asArray(bq.weakVerbBullets);
  if (weakBullets.length > 0) {
    const phrases = [...new Set(weakBullets.map((b) => `"${b.phrase}"`))].slice(0, 3).join(', ');
    recs.push({
      severity: weakBullets.length > 2 ? 'important' : 'suggestion',
      criterion: 'bulletQuality',
      text: `${weakBullets.length} bullet${weakBullets.length === 1 ? '' : 's'} use weak verbs like ${phrases} -- consider ${weakBullets[0].suggestions.join(', ')} instead. First: "${weakBullets[0].bullet}..."`,
    });
  }
  if ((bq.noMetricCount ?? 0) > 0 && (bq.bulletCount ?? 0) > 0) {
    const pct = Math.round((bq.noMetricCount / bq.bulletCount) * 100);
    if (pct >= 30) {
      recs.push({
        severity: pct >= 60 ? 'critical' : 'important',
        criterion: 'bulletQuality',
        text: `${bq.noMetricCount} of ${bq.bulletCount} bullets (${pct}%) carry no number. Quantified outcomes are the single strongest bullet signal -- add scale, percentage, time saved, or money moved.`,
      });
    }
  }
  if ((bq.noVerbCount ?? 0) > 0 && (bq.bulletCount ?? 0) > 0 && bq.noVerbCount / bq.bulletCount >= 0.3) {
    recs.push({
      severity: 'suggestion',
      criterion: 'bulletQuality',
      text: `${bq.noVerbCount} of ${bq.bulletCount} bullets do not open with a recognised strong action verb. Lead with the action, not the context.`,
    });
  }

  // 5. Breadth.
  if (weak('skillBreadth')) {
    const d = at('skillBreadth').detail || {};
    recs.push({
      severity: 'suggestion',
      criterion: 'skillBreadth',
      text: `Skills span ${d.categories} categor${d.categories === 1 ? 'y' : 'ies'} and ${d.distinctGroups} distinct technology area${d.distinctGroups === 1 ? '' : 's'}. Grouping them under clearer headings (Languages, Infrastructure, Data, Testing) reads as broader coverage and parses more cleanly.`,
    });
  }

  // 6. Contact.
  const issues = asArray(at('contactParsability').detail?.issues);
  if (issues.length > 0) {
    recs.push({
      severity: issues.length > 2 ? 'important' : 'suggestion',
      criterion: 'contactParsability',
      text: `Contact block problems: ${issues.join('; ')}. These are the fields an ATS uses to create your candidate record.`,
    });
  }

  const order = { critical: 0, important: 1, suggestion: 2 };
  return recs.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Score a parsed resume against a parsed job description.
 *
 * @param {unknown} parsedResume Output of `parseResumeWithAI`. Any key may be absent.
 * @param {unknown} parsedJD Output of `parseJobDescriptionWithAI`. Any key may be absent.
 * @param {object} [gapAnalysis] Output of `analyzeCompetencyGaps`. Recomputed if omitted.
 * @returns {{
 *   total: number,
 *   maxScore: number,
 *   scoreableMax: number,
 *   percentage: number,
 *   grade: string,
 *   isFallback: boolean,
 *   fallbackReasons: string[],
 *   breakdown: Array<object>,
 *   recommendations: Array<object>,
 *   gapAnalysis: object
 * }}
 */
export function calculateATSScore(parsedResume, parsedJD, gapAnalysis) {
  const input = assessInput(parsedResume, parsedJD);

  // Recompute rather than trust a caller-supplied object of unknown shape.
  const gap =
    gapAnalysis && typeof gapAnalysis === 'object' && Array.isArray(gapAnalysis.matched)
      ? gapAnalysis
      : analyzeCompetencyGaps(parsedResume, parsedJD);

  const breakdown = [
    { id: 'keywordDensity', label: 'Keyword density match', ...scoreKeywordDensity(gap) },
    { id: 'topThirdPlacement', label: 'Top-third keyword placement', ...scoreTopThirdPlacement(parsedResume, gap) },
    { id: 'sectionHierarchy', label: 'Standard section hierarchy', ...scoreSectionHierarchy(parsedResume) },
    { id: 'bulletQuality', label: 'XYZ-formula bullet quality', ...scoreBulletQuality(parsedResume) },
    { id: 'skillBreadth', label: 'Technical skill breadth', ...scoreSkillBreadth(parsedResume) },
    { id: 'contactParsability', label: 'Contact info parsability', ...scoreContactParsability(parsedResume) },
  ];

  const total = round1(breakdown.reduce((sum, c) => sum + c.score, 0));

  // Criteria that could not be measured at all are excluded from the
  // denominator, so a partial resume is not silently scored against 100.
  const scoreableMax = breakdown.filter((c) => c.scoreable).reduce((sum, c) => sum + c.max, 0);
  const percentage = scoreableMax === 0 ? 0 : round1((total / scoreableMax) * 100);

  return {
    total,
    maxScore: MAX_SCORE,
    scoreableMax,
    percentage,
    grade: gradeFor(percentage),
    isFallback: input.isFallback,
    fallbackReasons: input.reasons,
    breakdown,
    recommendations: buildRecommendations(breakdown, gap, input),
    gapAnalysis: gap,
  };
}

/**
 * Bands are conventional letter thresholds. They carry no extra information
 * beyond `percentage` -- they exist so the UI has something short to show.
 */
function gradeFor(percentage) {
  if (percentage >= 90) return 'A';
  if (percentage >= 80) return 'B';
  if (percentage >= 70) return 'C';
  if (percentage >= 60) return 'D';
  return 'F';
}

export { bulletSignals };
