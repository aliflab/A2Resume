import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { useApp, ACTIONS } from '../context/AppContext.jsx';
import { CRITERION_LABELS, calculateATSScore } from '../services/atsScorer.js';
import { analyzeCompetencyGaps } from '../services/gapAnalyzer.js';
import { inferSkillsFromExperience, shouldOfferSkillInference } from '../services/skillInference.js';
import { getApiKey, getKeyPresence } from '../services/apiKeyService.js';
import { PROVIDER_LABELS } from '../services/aiService.js';
import { describeError } from '../utils/errorMessages.js';

/**
 * Step 2: show what the analysis found.
 *
 * Reads only. The one thing that writes is the skill-inference gate, and it
 * writes only what the user has individually approved.
 *
 * No route guard protects this page and it guards nothing itself -- loaded
 * cold it shows an empty state pointing back to step 1.
 */

const asArray = (v) => (Array.isArray(v) ? v : []);
const PRIORITIES = ['high', 'medium', 'low'];

/** Current name for a criterion; a stored score may carry an older build's label. */
const criterionLabel = (c) => CRITERION_LABELS[c?.id] ?? c?.label;

export default function Analyze() {
  const { state } = useApp();
  const atsScore = state.atsScore ?? null;
  const gapAnalysis = state.gapAnalysis ?? atsScore?.gapAnalysis ?? null;

  if (!atsScore && !gapAnalysis) return <EmptyState />;

  return (
    <section className="page analyze">
      <header className="analyze__head">
        <p className="analyze__step">Step 2 of 4</p>
        <h1>What the analysis found</h1>
        {state.sources?.provider && (
          <p className="muted">
            Parsed with {PROVIDER_LABELS[state.sources.provider] ?? state.sources.provider}
            {state.sources.resumeFileName ? ` · ${state.sources.resumeFileName}` : ''}
          </p>
        )}
      </header>

      {atsScore?.isFallback && <FallbackBanner atsScore={atsScore} />}

      <SkillInferenceGate />

      {atsScore && <ScoreCard atsScore={atsScore} />}
      {gapAnalysis && <KeywordCard gap={gapAnalysis} />}
      {atsScore && <RecommendationsCard recommendations={asArray(atsScore.recommendations)} />}
    </section>
  );
}

function EmptyState() {
  return (
    <section className="page analyze">
      <h1>Nothing analysed yet</h1>
      <p className="muted">
        This page shows the result of a run. Add your resume and a job description on step 1, and the
        analysis will appear here.
      </p>
      <p>
        <Link to="/input" className="button button--primary">
          Go to step 1
        </Link>
      </p>
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

function ScoreCard({ atsScore }) {
  const [openNotes, setOpenNotes] = useState(null);

  return (
    <section className="card">
      <h2>ATS score</h2>

      <div className="score">
        <div className={`score__grade score__grade--${String(atsScore.grade).toLowerCase()}`}>
          {atsScore.grade}
        </div>
        <div>
          <p className="score__total">
            {atsScore.total} <span className="muted">/ {atsScore.scoreableMax}</span>
          </p>
          <p className="muted">
            {atsScore.percentage}%
            {atsScore.scoreableMax !== atsScore.maxScore && ` · ${atsScore.maxScore - atsScore.scoreableMax} points could not be measured`}
          </p>
        </div>
      </div>

      <ul className="criteria">
        {asArray(atsScore.breakdown).map((c) => {
          const pct = c.max ? Math.round((c.score / c.max) * 100) : 0;
          const open = openNotes === c.id;
          return (
            <li key={c.id} className={c.scoreable ? 'criterion' : 'criterion criterion--unscoreable'}>
              <div className="criterion__row">
                <span className="criterion__label">{criterionLabel(c)}</span>
                <span className="criterion__value">
                  {c.scoreable ? (
                    <>
                      {c.score} <span className="muted">/ {c.max}</span>
                    </>
                  ) : (
                    <span className="muted">not measured</span>
                  )}
                </span>
              </div>
              <div className="meter" aria-hidden="true">
                <div className={`meter__fill meter__fill--${band(pct)}`} style={{ width: `${c.scoreable ? pct : 0}%` }} />
              </div>
              {asArray(c.notes).length > 0 && (
                <>
                  <button type="button" className="link" onClick={() => setOpenNotes(open ? null : c.id)}>
                    {open ? 'Hide how this is measured' : 'How this is measured'}
                  </button>
                  {open && (
                    <ul className="criterion__notes">
                      {c.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const band = (pct) => (pct >= 75 ? 'good' : pct >= 45 ? 'mid' : 'poor');

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

/**
 * Three buckets, split by priority. The density map is deliberately not in
 * the main view -- it is per-keyword detail that would triple the row count
 * for something most readers never need. It expands per keyword instead, and
 * is also carried in the title attribute for a hover.
 */
function KeywordCard({ gap }) {
  const [expanded, setExpanded] = useState(null);

  const buckets = useMemo(
    () => [
      { id: 'matched', label: 'Matched', items: asArray(gap.matched), tone: 'ok', blurb: 'Found in your resume as written.' },
      { id: 'partial', label: 'Partial', items: asArray(gap.partial), tone: 'warn', blurb: 'You said something equivalent, but not the words the posting uses.' },
      { id: 'missing', label: 'Missing', items: asArray(gap.missing), tone: 'poor', blurb: 'Not found anywhere in your resume.' },
    ],
    [gap]
  );

  const total = gap.totalKeywords ?? 0;

  return (
    <section className="card">
      <h2>Keyword coverage</h2>
      <p className="muted">
        {total} keyword{total === 1 ? '' : 's'} from the job description · {gap.matchRate}% covered
        {typeof gap.weightedMatchRate === 'number' && ` · ${gap.weightedMatchRate}% weighted by priority`}
      </p>

      {total === 0 ? (
        <p className="muted">
          {asArray(gap.degraded?.reasons).join(' ') || 'No keywords were extracted from the job description.'}
        </p>
      ) : (
        <div className="buckets">
          {buckets.map((b) => (
            <div key={b.id} className="bucket">
              <h3 className={`bucket__title bucket__title--${b.tone}`}>
                {b.label} <span className="muted">({b.items.length})</span>
              </h3>
              <p className="muted bucket__blurb">{b.blurb}</p>

              {b.items.length === 0 ? (
                <p className="muted">None.</p>
              ) : (
                PRIORITIES.map((priority) => {
                  const items = b.items.filter((k) => k.priority === priority);
                  if (items.length === 0) return null;
                  return (
                    <div key={priority} className="bucket__group">
                      <p className="bucket__priority">{priority} priority</p>
                      <ul className="chips">
                        {items.map((k) => {
                          const id = `${b.id}-${k.keyword}`;
                          const open = expanded === id;
                          const count = gap.densityMap?.[k.keyword];
                          return (
                            <li key={id}>
                              <button
                                type="button"
                                className={`chip chip--${b.tone}${open ? ' chip--open' : ''}`}
                                onClick={() => setExpanded(open ? null : id)}
                                title={
                                  count
                                    ? `Appears ${count} time${count === 1 ? '' : 's'} in your resume`
                                    : 'Not found in your resume'
                                }
                                aria-expanded={open}
                              >
                                {k.keyword}
                                {count > 1 && <span className="chip__count">{count}</span>}
                              </button>
                              {open && (
                                <p className="chip__detail">
                                  {count
                                    ? `Appears ${count} time${count === 1 ? '' : 's'}.`
                                    : 'Does not appear.'}
                                  {k.matchedVia && k.matchedVia !== k.keyword && (
                                    <> Matched via your wording &ldquo;{k.matchedVia}&rdquo;.</>
                                  )}
                                </p>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

function RecommendationsCard({ recommendations }) {
  if (recommendations.length === 0) {
    return (
      <section className="card">
        <h2>Recommendations</h2>
        <p className="muted">Nothing flagged. Every criterion scored well enough not to raise anything.</p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Recommendations <span className="muted">({recommendations.length})</span></h2>
      <ul className="recs">
        {recommendations.map((r, i) => (
          <li key={`${r.criterion}-${i}`} className={`rec rec--${r.severity}`}>
            <span className="rec__severity">{r.severity}</span>
            <span>{r.text}</span>
          </li>
        ))}
      </ul>
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
 * skills are dispatched, and the score is re-run only afterwards, so the
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
  const [merged, setMerged] = useState(null); // { count } after a merge
  const [rescored, setRescored] = useState(false);

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
    setMerged({ count: approved.length, alsoTailored: Boolean(state.tailoredResume) });
    setSuggestions(null);
    setDecisions({});
    setRescored(false);
  }, [approved, dispatch, state.tailoredResume]);

  // Re-run the deterministic half of the pipeline only. No AI call, no key,
  // no re-parse -- the resume object already changed, so the score simply
  // needs recomputing against it.
  const rescore = useCallback(() => {
    const gap = analyzeCompetencyGaps(state.resume, state.parsedJD);
    dispatch({ type: ACTIONS.SET_GAP_ANALYSIS, payload: gap });
    dispatch({ type: ACTIONS.SET_ATS_SCORE, payload: calculateATSScore(state.resume, state.parsedJD, gap) });
    setRescored(true);
  }, [dispatch, state.parsedJD, state.resume]);

  if (merged) {
    return (
      <section className="card infer">
        <h2>Skills added</h2>
        <p>
          {merged.count} approved skill{merged.count === 1 ? '' : 's'} added to your resume
          {merged.alsoTailored && ' and to your tailored resume from step 3'}, filed under &ldquo;Inferred from
          experience&rdquo; so you can tell them apart from what you wrote yourself.
        </p>
        {rescored ? (
          <p className="inline-status inline-status--ok">Score updated. The numbers below now include them.</p>
        ) : (
          <p>
            <button type="button" className="button button--primary" onClick={rescore}>
              Re-run the score with these skills
            </button>
          </p>
        )}
      </section>
    );
  }

  if (!offer && !suggestions) return null;

  return (
    <section className="card infer">
      <h2>No skills section found</h2>
      <p>
        Your resume describes what you did, but does not list your skills anywhere. ATS systems match against
        that list, so this costs you matches. A2Resume can read your experience and suggest skills it
        evidences.
      </p>
      <p className="muted">
        Suggestions are proposals, not facts. Each one shows the exact line it came from, and{' '}
        <strong>nothing is added to your resume unless you approve it individually.</strong>
      </p>

      {!suggestions && (
        <>
          {!provider || !hasKey ? (
            <p className="inline-status inline-status--error">
              This needs an AI provider. <Link to="/settings">Add a key in Settings</Link>.
            </p>
          ) : (
            <p>
              <button type="button" className="button button--primary" onClick={run} disabled={busy}>
                {busy ? 'Reading your experience...' : 'Suggest skills from my experience'}
              </button>
            </p>
          )}
          {error && (
            <p className="inline-status inline-status--error">
              {error.message} {error.isAuth && <Link to="/settings">Open Settings</Link>}
            </p>
          )}
        </>
      )}

      {suggestions && suggestions.length === 0 && (
        <p className="inline-status inline-status--warn">
          Nothing could be anchored to a specific line in your resume, so nothing is suggested. Adding a
          skills section by hand is the better move here.
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
                    <span className={`badge badge--${s.confidence}`}>{s.confidence} confidence</span>
                  </div>

                  {/* The evidence is the whole point of the gate: the user
                      approves the inference, not the label. */}
                  <blockquote className="suggestion__source">{s.sourceText}</blockquote>

                  <div className="suggestion__actions">
                    <button
                      type="button"
                      className={decision === 'approved' ? 'button--primary' : ''}
                      onClick={() => setDecisions((d) => ({ ...d, [s.skill]: d[s.skill] === 'approved' ? undefined : 'approved' }))}
                    >
                      {decision === 'approved' ? 'Approved' : 'Approve'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDecisions((d) => ({ ...d, [s.skill]: d[s.skill] === 'rejected' ? undefined : 'rejected' }))}
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
            <button type="button" onClick={() => { setSuggestions(null); setDecisions({}); }}>
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
