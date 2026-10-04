import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { useApp, ACTIONS, INFERRED_SKILLS_CATEGORY } from '../context/AppContext.jsx';
import KeywordCoverage from '../components/analysis/KeywordCoverage.jsx';
import Icon from '../components/Icon.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';
import ErrorNotice from '../components/ui/ErrorNotice.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';
import ScoreRing from '../components/ui/ScoreRing.jsx';
import { band, gradeTone, gradeVerdict } from '../components/ui/scoreBands.js';
import { CRITERION_LABELS } from '../services/atsScorer.js';
import { compareScores, describeScoreChange, selectCurrentResume } from '../services/currentResume.js';
import { inferSkillsFromExperience, shouldOfferSkillInference } from '../services/skillInference.js';
import { getApiKey, getKeyPresence } from '../services/apiKeyService.js';
import { PROVIDER_LABELS } from '../services/aiService.js';
import { describeError } from '../utils/errorMessages.js';
import { loadTailor, prefetch } from '../routeChunks.js';

/**
 * Step 2: show what the analysis found.
 *
 * Reads only. The one thing that writes is the skill-inference gate, and it
 * writes only what the user has individually approved.
 *
 * The score shown is always the CURRENT resume's (currentResume.js): the
 * tailored copy, hand edits included, once Tailor has run. The reducer
 * recomputes it whenever that resume changes, so this page never has to.
 * When a tailoring pass exists, the Input run's baseline is shown beside it.
 *
 * No route guard protects this page and it guards nothing itself -- loaded
 * cold it shows an empty state pointing back to step 1.
 */

const asArray = (v) => (Array.isArray(v) ? v : []);

/** Current name for a criterion; a stored score may carry an older build's label. */
const criterionLabel = (c) => CRITERION_LABELS[c?.id] ?? c?.label;

/** One plain sentence per criterion: what it measures. Copy only; the scoring is atsScorer's. */
const CRITERION_DESCRIPTIONS = {
  keywordDensity: 'How many of the job’s keywords your resume uses, weighted by priority, and whether the important ones appear more than once.',
  topThirdPlacement: 'Whether the job’s keywords appear early: in your summary and your most recent role.',
  sectionHierarchy: 'Whether the standard sections an ATS looks for are present and actually filled in.',
  bulletQuality: 'Whether your bullets say what you did, with what, and the measurable result.',
  skillBreadth: 'How many distinct kinds of technical skill your resume demonstrates.',
  contactParsability: 'Whether an ATS can find your email, phone number and links.',
};

export default function Analyze() {
  const { state } = useApp();
  const atsScore = state.atsScore ?? null;
  const gapAnalysis = state.gapAnalysis ?? atsScore?.gapAnalysis ?? null;

  // The comparison exists only once there is something to compare: a
  // tailoring pass. Before that, the current score IS the baseline.
  const tailored = selectCurrentResume(state).source === 'tailored';
  const originalScore = state.originalAtsScore ?? null;
  const comparison = tailored
    ? compareScores(originalScore, atsScore, state.originalGapAnalysis ?? originalScore?.gapAnalysis, gapAnalysis)
    : null;
  const approvedSkills = asArray(state.resume?.skills).some((g) => g?.category === INFERRED_SKILLS_CATEGORY);

  // Tailor is the next step and a lazy chunk; fetch it now, while the user
  // reads the score, so moving on never waits on the network.
  useEffect(() => prefetch(loadTailor), []);

  if (!atsScore && !gapAnalysis) {
    return (
      <EmptyState
        icon="gauge"
        title="Nothing analyzed yet"
        action={{ to: '/input', label: 'Add your resume' }}
      >
        This page shows how your resume scores against a job description: the ATS score, the keywords you match and
        miss, and what to fix first. Add your resume and the job on step 1 to see it.
      </EmptyState>
    );
  }

  const providerLabel = state.sources?.provider ? PROVIDER_LABELS[state.sources.provider] ?? state.sources.provider : null;

  return (
    <section className="page analyze">
      <PageHeader
        eyebrow="Step 2 of 4"
        title="What the analysis found"
        actions={
          <Link to={tailored ? '/export' : '/tailor'} className="button button--primary">
            {tailored ? 'Continue to export' : 'Tailor for this job'}
            <Icon name="arrowRight" size={16} />
          </Link>
        }
      >
        {tailored ? (
          <p>
            Scored against your tailored resume from step 3, including anything you edited by hand. It updates as soon
            as you save a change there.
          </p>
        ) : (
          <p>How your resume reads to an applicant tracking system for this job, and what would move the score.</p>
        )}
        {providerLabel && (
          <p className="muted">
            Parsed with {providerLabel}
            {state.sources.resumeFileName ? ` · ${state.sources.resumeFileName}` : ''}
          </p>
        )}
      </PageHeader>

      {atsScore?.isFallback && <FallbackBanner atsScore={atsScore} />}

      {atsScore && <ScoreHero atsScore={atsScore} gap={gapAnalysis} parsedJD={state.parsedJD} />}

      <SkillInferenceGate />

      {comparison && <ComparisonCard comparison={comparison} approvedSkills={approvedSkills} />}
      {tailored && atsScore && !comparison && (
        <p className="notice notice--info">
          No before-tailoring score is saved for this session, so there is nothing to compare this one against.
        </p>
      )}

      {atsScore && <BreakdownCard atsScore={atsScore} />}

      {gapAnalysis && (
        <section className="card">
          <KeywordCoverage gap={gapAnalysis} />
        </section>
      )}
      {atsScore && <RecommendationsCard recommendations={asArray(atsScore.recommendations)} />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Fallback banner
// ---------------------------------------------------------------------------

/**
 * A low grade caused by missing data is a completely different message from a
 * low grade caused by a weak resume, and a user cannot tell them apart from
 * the number. So this sits above the score, not below it, and says which
 * criteria could not be measured at all.
 */
function FallbackBanner({ atsScore }) {
  const unscoreable = asArray(atsScore.breakdown).filter((c) => !c.scoreable);

  return (
    <div className="notice notice--warn analyze__fallback" role="status">
      <p>
        <strong>This score is incomplete — treat the grade with caution.</strong>
      </p>
      <p>
        Parts of your resume were missing, so some criteria could not be measured. A low grade here does not
        necessarily mean a weak resume; it may just mean there was not enough to score.
      </p>
      <ul>
        {asArray(atsScore.fallbackReasons).map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {unscoreable.length > 0 && (
        <p className="muted">
          Not measured: {unscoreable.map(criterionLabel).join(', ')}.{' '}
          {unscoreable.length === 1 ? 'That criterion is' : 'Those criteria are'} excluded from the total,
          which is why the score is out of {atsScore.scoreableMax} rather than {atsScore.maxScore}.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

/**
 * The headline. The ring shows the percentage, the large number is the total
 * out of what could be scored. `.card:not(.compare) .score__total` is what
 * pipeline.manual.js reads, so this stays a .card and the total stays the
 * first text in .score__total.
 */
function ScoreHero({ atsScore, gap, parsedJD }) {
  const tone = gradeTone(atsScore);
  const missingHigh = asArray(gap?.missing).filter((k) => k.priority === 'high').length;
  const recCount = asArray(atsScore.recommendations).length;
  const role = [parsedJD?.jobTitle, parsedJD?.company].filter(Boolean).join(' at ');

  return (
    <section className="card score-hero" aria-labelledby="score-title">
      <ScoreRing percentage={atsScore.percentage} size={148} tone={tone}>
        <span className="ring-figure">
          <span className="ring-figure__pct">
            {atsScore.percentage}
            <small>%</small>
          </span>
          <span className="ring-figure__grade">Grade {atsScore.grade}</span>
        </span>
      </ScoreRing>

      <div>
        <p className="eyebrow" id="score-title">
          ATS score{role ? ` · ${role}` : ''}
        </p>
        <p className="score__total">
          {atsScore.total} <span className="muted">/ {atsScore.scoreableMax}</span>
        </p>
        <p className={`score-hero__verdict score-hero__verdict--${atsScore.isFallback ? 'mid' : tone}`}>
          {gradeVerdict(atsScore)}
        </p>
        {atsScore.scoreableMax !== atsScore.maxScore && (
          <p className="score-hero__summary">
            {atsScore.maxScore - atsScore.scoreableMax} points could not be measured, so this is out of{' '}
            {atsScore.scoreableMax}, not {atsScore.maxScore}.
          </p>
        )}
        <ul className="metrics">
          {gap && (
            <li className="metric">
              <span className="metric__label">Keywords covered</span>
              <span className="metric__value">
                {gap.matchRate}
                <small>%</small>
              </span>
            </li>
          )}
          {gap && (
            <li className="metric">
              <span className="metric__label">High-priority missing</span>
              <span className={`metric__value${missingHigh > 0 ? ' metric__value--down' : ''}`}>{missingHigh}</span>
            </li>
          )}
          <li className="metric">
            <span className="metric__label">Recommendations</span>
            <span className="metric__value">{recCount}</span>
          </li>
        </ul>
      </div>
    </section>
  );
}

function BreakdownCard({ atsScore }) {
  const [openNotes, setOpenNotes] = useState(null);

  return (
    <section className="card">
      <div className="section-head">
        <div>
          <h2>Score breakdown</h2>
          <p className="muted">Six criteria, {atsScore.maxScore} points in all. Each says what it measures.</p>
        </div>
      </div>

      <ul className="criteria">
        {asArray(atsScore.breakdown).map((c) => {
          const pct = c.max ? Math.round((c.score / c.max) * 100) : 0;
          const open = openNotes === c.id;
          const notesId = `criterion-notes-${c.id}`;
          return (
            <li key={c.id} className={c.scoreable ? 'criterion' : 'criterion criterion--unscoreable'}>
              <span className="criterion__label">{criterionLabel(c)}</span>
              <div
                className="meter"
                role="img"
                aria-label={c.scoreable ? `${pct} percent of the points for this criterion` : 'Not measured'}
              >
                <div className={`meter__fill meter__fill--${band(pct)}`} style={{ width: `${c.scoreable ? pct : 0}%` }} />
              </div>
              <span className="criterion__value">
                {c.scoreable ? (
                  <>
                    {c.score} <span className="muted">/ {c.max}</span>
                  </>
                ) : (
                  <span className="muted">not measured</span>
                )}
              </span>
              <p className="criterion__desc">
                {CRITERION_DESCRIPTIONS[c.id] ?? ''}
                {asArray(c.notes).length > 0 && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => setOpenNotes(open ? null : c.id)}
                    aria-expanded={open}
                    aria-controls={notesId}
                  >
                    {open ? 'Hide how this is measured' : 'How this is measured'}
                  </button>
                )}
              </p>
              {open && (
                <ul className="criterion__notes" id={notesId}>
                  {c.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Before and after tailoring
// ---------------------------------------------------------------------------

/**
 * The Input run's baseline next to the current score, and which keywords
 * changed bucket between them. Rendered only when a tailoring pass exists.
 *
 * Keywords that LOST coverage are shown too, not just gains: a rewrite can
 * drop the exact wording a posting uses, and a net gain in the total would
 * otherwise hide it.
 */
function ComparisonCard({ comparison, approvedSkills }) {
  const { before, after, direction, sameScale, keywords } = comparison;
  const change = describeScoreChange(comparison);

  return (
    <section className="card compare">
      <h2>Before and after tailoring</h2>

      <div className="compare__scores">
        <ScoreFigure label="Before tailoring" score={before} />
        <span className="compare__arrow" aria-hidden="true">
          <Icon name="arrowRight" size={20} />
        </span>
        <ScoreFigure label="Now" score={after} />
        <p className={`compare__delta compare__delta--${direction}`}>{change.charAt(0).toUpperCase() + change.slice(1)}</p>
      </div>

      {!sameScale && (
        <p className="muted">
          The two totals are out of different maximums ({before.scoreableMax} and {after.scoreableMax}): a criterion
          that could not be measured on one resume could be on the other. So they are compared as percentages,{' '}
          {before.percentage}% → {after.percentage}%.
        </p>
      )}
      <p className="muted">
        &ldquo;Before&rdquo; is your resume as first analysed on step 1.
        {approvedSkills && ' Skills you approved on this page since then count toward “now”, not “before”.'}
      </p>

      <KeywordMoves
        title="Keywords gained"
        tone="ok"
        moves={keywords.improved}
        empty="No keyword moved to a better bucket."
      />
      {keywords.regressed.length > 0 && (
        <KeywordMoves
          title="Keywords lost"
          tone="poor"
          moves={keywords.regressed}
          blurb="Covered better before tailoring than now. A rewrite may have dropped the wording the posting uses."
        />
      )}
    </section>
  );
}

function ScoreFigure({ label, score }) {
  return (
    <div className="compare__figure">
      <p className="compare__label">{label}</p>
      <div className="score">
        <div className={`score__grade score__grade--${String(score.grade).toLowerCase()}`}>{score.grade}</div>
        <p className="score__total">
          {score.total} <span className="muted">/ {score.scoreableMax}</span>
        </p>
      </div>
    </div>
  );
}

function KeywordMoves({ title, tone, moves, empty, blurb }) {
  return (
    <div className="compare__moves">
      <h3 className={`bucket__title bucket__title--${tone}`}>
        {title} <span className="muted">({moves.length})</span>
      </h3>
      {blurb && <p className="muted bucket__blurb">{blurb}</p>}
      {moves.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="compare__list">
          {moves.map((m) => (
            <li key={m.keyword}>
              <span className={`chip chip--static chip--${tone}`}>{m.keyword}</span>{' '}
              <span className="muted">
                {m.from} → {m.to}
                {m.priority ? ` · ${m.priority} priority` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

function RecommendationsCard({ recommendations }) {
  return (
    <section className="card">
      <div className="section-head">
        <div>
          <h2>
            What to fix first{' '}
            {recommendations.length > 0 && <span className="muted">({recommendations.length})</span>}
          </h2>
          <p className="muted">Most important first.</p>
        </div>
      </div>
      {recommendations.length === 0 ? (
        <p className="muted">Nothing flagged. Every criterion scored well enough not to raise anything.</p>
      ) : (
        <ul className="recs">
          {recommendations.map((r, i) => (
            <li key={`${r.criterion}-${i}`} className={`rec rec--${r.severity}`}>
              <span className="rec__severity">{r.severity}</span>
              <span>{r.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Skill inference, behind an approval gate
// ---------------------------------------------------------------------------

/**
 * Offered only when the resume has no skills section but does describe work
 * to infer from -- `shouldOfferSkillInference` decides, not this component.
 *
 * The gate is the point. Suggestions are proposals until the user approves
 * them one at a time; there is deliberately no accept-all. Only approved
 * skills are dispatched. The reducer rescores in the same step (no AI call,
 * no key), and the confirmation names the before and after totals, so the
 * change in the number is visibly a consequence of the user's own decisions.
 */
function SkillInferenceGate() {
  const { state, dispatch } = useApp();
  const resume = state.resume;

  const [suggestions, setSuggestions] = useState(null);
  const [decisions, setDecisions] = useState({}); // skill -> 'approved' | 'rejected'
  const [dropped, setDropped] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [merged, setMerged] = useState(null); // { skills, alsoTailored, scoreBefore } after a merge

  const provider = state.settings?.provider ?? state.sources?.provider ?? null;
  const hasKey = provider ? !!safePresence()[provider] : false;

  const offer = shouldOfferSkillInference(resume);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const apiKey = getApiKey(provider);
      if (!apiKey) {
        setError({ message: `No API key stored for ${PROVIDER_LABELS[provider] ?? provider}.`, isAuth: true });
        return;
      }
      const result = await inferSkillsFromExperience(resume, { provider, apiKey });
      setSuggestions(result.suggestions);
      setDropped(result.dropped);
      setDecisions({});
    } catch (err) {
      setError(describeError(err, { provider }));
    } finally {
      setBusy(false);
    }
  }, [provider, resume]);

  const approved = useMemo(
    () => asArray(suggestions).filter((s) => decisions[s.skill] === 'approved'),
    [decisions, suggestions]
  );

  const applyApproved = useCallback(() => {
    if (approved.length === 0) return;
    dispatch({ type: ACTIONS.MERGE_INFERRED_SKILLS, payload: approved.map((s) => s.skill) });
    // The reducer adds them to an existing tailoring pass too; say so, since
    // that is the copy Export will use.
    setMerged({
      skills: approved.map((s) => s.skill),
      alsoTailored: Boolean(state.tailoredResume),
      scoreBefore: state.atsScore ?? null,
    });
    setSuggestions(null);
    setDecisions({});
  }, [approved, dispatch, state.atsScore, state.tailoredResume]);

  const decide = (skill, decision) =>
    setDecisions((d) => ({ ...d, [skill]: d[skill] === decision ? undefined : decision }));

  if (merged) {
    const before = merged.scoreBefore;
    const after = state.atsScore;
    return (
      <section className="card infer">
        <div className="section-head">
          <div className="section-head__title">
            <span className="section-head__icon">
              <Icon name="checkCircle" size={18} />
            </span>
            <div>
              <h2>
                {merged.skills.length} skill{merged.skills.length === 1 ? '' : 's'} added to your resume
              </h2>
              <p className="muted">
                Filed under &ldquo;Inferred from experience&rdquo;
                {merged.alsoTailored && ', in your tailored resume from step 3 too'}, so you can tell them apart from
                what you wrote yourself.
              </p>
            </div>
          </div>
        </div>
        <div className="pills">
          {merged.skills.map((skill) => (
            <span key={skill} className="pill pill--success">
              <Icon name="check" size={12} />
              {skill}
            </span>
          ))}
        </div>
        <p className="inline-status inline-status--ok">
          Score recomputed
          {typeof before?.total === 'number' && typeof after?.total === 'number' && (
            <>
              : {before.total} / {before.scoreableMax} → {after.total} / {after.scoreableMax}
            </>
          )}
          . The numbers on this page include them.
        </p>
      </section>
    );
  }

  if (!offer && !suggestions) return null;

  return (
    <section className="card infer" aria-labelledby="infer-title">
      <div className="section-head">
        <div className="section-head__title">
          <span className="section-head__icon">
            <Icon name="layers" size={18} />
          </span>
          <div>
            <h2 id="infer-title">Suggested skills</h2>
            <p className="muted">
              Your resume describes what you did but never lists your skills, and ATS systems match against that list.
              A2Resume can read your experience and propose skills it shows evidence for.
            </p>
          </div>
        </div>
        <span className="badge badge--info">Proposals</span>
      </div>

      <p className="muted">
        Each suggestion quotes the exact line it came from, and{' '}
        <strong>nothing is added to your resume unless you approve it individually.</strong>
      </p>

      {!suggestions && (
        <>
          {!provider || !hasKey ? (
            <p className="inline-status inline-status--error">
              This needs an AI provider. <Link to="/settings">Add a key in Settings</Link>.
            </p>
          ) : (
            <>
              <p className="actions">
                <button type="button" className="button button--primary" onClick={run} disabled={busy}>
                  {busy ? 'Reading your experience…' : 'Suggest skills from my experience'}
                </button>
              </p>
              {busy && (
                <div className="loading-line" role="status">
                  <span>Reading your experience with {PROVIDER_LABELS[provider] ?? provider}…</span>
                  <span className="progress-bar" aria-hidden="true" />
                </div>
              )}
            </>
          )}
          {error && <ErrorNotice compact error={error} onRetry={hasKey ? run : undefined} />}
        </>
      )}

      {suggestions && suggestions.length === 0 && (
        <p className="inline-status inline-status--warn">
          Nothing could be anchored to a specific line in your resume, so nothing is suggested. Adding a skills section
          by hand is the better move here.
        </p>
      )}

      {suggestions && suggestions.length > 0 && (
        <>
          <ul className="suggestions">
            {suggestions.map((s) => {
              const decision = decisions[s.skill];
              return (
                <li key={s.skill} className={`suggestion${decision ? ` suggestion--${decision}` : ''}`}>
                  <div className="suggestion__head">
                    <span className="suggestion__skill">{s.skill}</span>
                    <span className={`badge badge--dot badge--${s.confidence}`}>{s.confidence} confidence</span>
                  </div>

                  {/* The evidence is the whole point of the gate: the user
                      approves the inference, not the label. */}
                  <blockquote className="suggestion__source">{s.sourceText}</blockquote>

                  <div className="suggestion__actions">
                    <button
                      type="button"
                      className={decision === 'approved' ? 'button button--sm button--primary' : 'button button--sm'}
                      aria-pressed={decision === 'approved'}
                      onClick={() => decide(s.skill, 'approved')}
                    >
                      {decision === 'approved' && <Icon name="check" size={14} />}
                      {decision === 'approved' ? 'Approved' : 'Approve'}
                    </button>
                    <button
                      type="button"
                      className="button button--sm button--ghost"
                      aria-pressed={decision === 'rejected'}
                      onClick={() => decide(s.skill, 'rejected')}
                    >
                      {decision === 'rejected' ? 'Rejected' : 'Reject'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {dropped.length > 0 && (
            <p className="muted">
              {dropped.length} suggestion{dropped.length === 1 ? '' : 's'} discarded before you saw{' '}
              {dropped.length === 1 ? 'it' : 'them'} for failing the evidence check
              {dropped.length <= 3 && <> ({dropped.map((d) => `${d.skill}: ${d.reason}`).join('; ')})</>}.
            </p>
          )}

          <div className="actions">
            <button type="button" className="button button--primary" onClick={applyApproved} disabled={approved.length === 0}>
              Add {approved.length} approved skill{approved.length === 1 ? '' : 's'}
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => {
                setSuggestions(null);
                setDecisions({});
              }}
            >
              Discard all
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function safePresence() {
  try {
    return getKeyPresence();
  } catch {
    return {};
  }
}
