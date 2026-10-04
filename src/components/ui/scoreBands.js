/**
 * How a score is described in words and colour. Presentation only: the score
 * itself, its grade and its percentage all come from atsScorer.js unchanged.
 *
 * One definition, so the score ring on Analyze, the side panel on Tailor, the
 * summary on Export and the rows on Match never disagree about what "strong"
 * means or which colour a 62% is.
 */

/** good / mid / poor, from a percentage. The same cut-offs Analyze's meters always used. */
export const band = (pct) => (pct >= 75 ? 'good' : pct >= 45 ? 'mid' : 'poor');

/**
 * The tone for a whole score, from its letter grade (atsScorer's gradeFor:
 * A >= 90, B >= 80, C >= 70, D >= 60). Wherever a grade letter is on screen,
 * its colour comes from the letter -- a green ring around a "C" would say two
 * different things. A/B success, C warning, D/F danger. Falls back to the
 * percentage band for a score with no readable grade.
 */
export function gradeTone(score) {
  const grade = String(score?.grade ?? '').toUpperCase();
  if (grade === 'A' || grade === 'B') return 'good';
  if (grade === 'C') return 'mid';
  if (grade === 'D' || grade === 'F') return 'poor';
  return band(Number(score?.percentage) || 0);
}

const VERDICTS = {
  A: 'Excellent match',
  B: 'Strong match',
  C: 'Moderate match',
  D: 'Weak match',
  F: 'Poor match',
};

/** A word for a grade. An incomplete score says so instead of sounding sure of itself. */
export function gradeVerdict(score) {
  if (!score || typeof score !== 'object') return '';
  if (score.isFallback) return 'Incomplete score';
  return VERDICTS[String(score.grade).toUpperCase()] ?? '';
}
