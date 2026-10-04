import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';

import { useApp, ACTIONS } from '../context/AppContext.jsx';
import TailoredResumeEditor from '../components/tailor/TailoredResumeEditor.jsx';
import Icon from '../components/Icon.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';
import ErrorNotice from '../components/ui/ErrorNotice.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';
import ScoreRing from '../components/ui/ScoreRing.jsx';
import { gradeTone } from '../components/ui/scoreBands.js';
import { tailorResumeWithAI } from '../services/resumeTailor.js';
import { compareScores, describeScoreChange } from '../services/currentResume.js';
import { describeManualEdits } from '../services/tailoredEdits.js';
import { getApiKey, getKeyPresence } from '../services/apiKeyService.js';
import { PROVIDER_LABELS } from '../services/aiService.js';
import { describeError } from '../utils/errorMessages.js';

/**
 * Step 3: run the tailoring pass, edit the result by hand, and read what the
 * pass changed.
 *
 * The editor (components/tailor/TailoredResumeEditor.jsx) writes one section
 * or entry at a time through UPDATE_TAILORED_SECTION, and each save is recorded
 * in `tailorManualEdits`. That log is what the discard confirmation reads: a
 * new pass starts from the original resume, so hand edits never carry over,
 * and the user is told which ones they are about to lose before it happens.
 *
 * Like every other page there is no route guard, so loaded cold it shows an
 * empty state pointing back at the step that produces its input.
 */

const asArray = (v) => (Array.isArray(v) ? v : []);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function safePresence() {
  try {
    return getKeyPresence();
  } catch {
    return {};
  }
}

export default function Tailor() {
  const { state, dispatch } = useApp();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const resume = state.resume ?? null;
  const parsedJD = state.parsedJD ?? null;
  const gapAnalysis = state.gapAnalysis ?? state.atsScore?.gapAnalysis ?? null;
  const tailored = state.tailoredResume && typeof state.tailoredResume === 'object' ? state.tailoredResume : null;
  const changesLog = asArray(state.changesLog);
  const corrections = asArray(state.tailorCorrections);
  const edits = describeManualEdits(state.tailorManualEdits);
  // The reducer rescores on every pass and every saved edit, so this line
  // moves the moment Save is pressed. Analyze has the full breakdown.
  const comparison = tailored
    ? compareScores(state.originalAtsScore, state.atsScore, state.originalGapAnalysis, state.gapAnalysis)
    : null;

  const provider = state.settings?.provider ?? state.sources?.provider ?? null;
  const hasKey = provider ? Boolean(safePresence()[provider]) : false;

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const apiKey = getApiKey(provider);
      if (!apiKey) {
        setError({ message: `No API key stored for ${PROVIDER_LABELS[provider] ?? provider}.`, isAuth: true });
        return;
      }
      const result = await tailorResumeWithAI(resume, parsedJD, gapAnalysis, { provider, apiKey });
      // Stamped with the JD it was built against. A new Input run started
      // while this was in flight replaces parsedJD, and the reducer then
      // refuses the pass instead of scoring it against the wrong posting.
      dispatch({ type: ACTIONS.SET_TAILORED_RESUME, payload: { ...result, parsedJD } });
    } catch (err) {
      setError(describeError(err, { provider }));
    } finally {
      setBusy(false);
    }
  }, [dispatch, gapAnalysis, parsedJD, provider, resume]);

  const discard = useCallback(() => {
    dispatch({ type: ACTIONS.CLEAR_TAILORING });
    setError(null);
    setConfirmingDiscard(false);
  }, [dispatch]);

  // With no hand edits there is nothing but the AI pass to lose, and it can
  // be run again, so the discard stays one click. With edits it asks first.
  const requestDiscard = useCallback(() => {
    if (edits.length > 0) setConfirmingDiscard(true);
    else discard();
  }, [discard, edits.length]);

  // What the side panel summarises. All of it is read from what the pass and
  // the reducer already produced -- nothing here is computed for display only
  // except the de-duplicated list of sections the AI touched.
  const gained = comparison?.keywords?.improved ?? [];
  const lost = comparison?.keywords?.regressed ?? [];
  const sectionsChanged = [
    ...new Set(changesLog.map((c) => String(c?.section || '').trim()).filter(Boolean)),
  ].map((section) => section.charAt(0).toUpperCase() + section.slice(1));

  if (!resume || !parsedJD) {
    return (
      <EmptyState icon="pencil" title="Nothing to tailor yet" action={{ to: '/input', label: 'Add your resume' }}>
        Tailoring rewrites your resume toward one job description, so it needs both. Add them on step 1 and run the
        analysis first.
      </EmptyState>
    );
  }

  const role = [parsedJD?.jobTitle, parsedJD?.company].filter(Boolean).join(' at ');

  return (
    <section className="page page--wide tailor">
      <PageHeader eyebrow="Step 3 of 4" title="Tailor your resume">
        Rewrites your bullets toward the posting. It never deletes a role, a date, or a skill, and it is not allowed
        to invent a number your resume does not already support. You can then edit the result by hand.
      </PageHeader>

      {!tailored && (
        <section className="card tailor-start" aria-labelledby="tailor-start-title">
          <div>
            <h2 id="tailor-start-title">Improve your resume for {role || 'this job'}</h2>
            <p>
              One AI pass rewrites the relevant sections in the posting&rsquo;s language. Nothing is final: you review
              every change and can edit any part by hand before you export.
            </p>
            <ul className="tailor-start__rules">
              <li>
                <Icon name="check" size={14} />
                Never deletes a role, date or skill
              </li>
              <li>
                <Icon name="check" size={14} />
                Never invents a number
              </li>
              <li>
                <Icon name="check" size={14} />
                Your original stays untouched
              </li>
            </ul>
          </div>
          <div>
            {!provider || !hasKey ? (
              <p className="inline-status inline-status--error">
                This needs an AI provider. <Link to="/settings">Add a key in Settings</Link>.
              </p>
            ) : (
              <button type="button" className="button button--primary button--lg" onClick={run} disabled={busy}>
                {busy ? 'Improving…' : 'Tailor my resume'}
                {!busy && <Icon name="arrowRight" size={18} />}
              </button>
            )}
          </div>
          {busy && <WorkingLine provider={provider} />}
          {error && (
            <div style={{ gridColumn: '1 / -1' }}>
              <ErrorNotice compact error={error} onRetry={hasKey ? run : undefined} />
            </div>
          )}
        </section>
      )}

      {tailored && (
        <div className="workspace workspace--aside">
          <div className="stack">
            {corrections.length > 0 && <CorrectionsNotice corrections={corrections} />}
            <TailoredResumeEditor resume={tailored} />
            {changesLog.length > 0 && <ChangesList changes={changesLog} edited={edits.length > 0} />}
          </div>

          <aside className="aside" aria-label="Tailoring summary">
            <section className="card tailor-panel">
              <h2>Tailoring result</h2>

              {comparison && (
                <div className="tailor-panel__delta">
                  <ScoreRing percentage={comparison.after.percentage} size={64} tone={gradeTone(comparison.after)}>
                    <span className="ring-figure ring-figure--sm">
                      <span className="ring-figure__pct">{comparison.after.grade}</span>
                    </span>
                  </ScoreRing>
                  <div>
                    <span
                      className={`tailor-panel__points tailor-panel__points--${comparison.direction}`}
                      aria-label={describeScoreChange(comparison)}
                    >
                      {comparison.delta > 0 ? '+' : ''}
                      {comparison.delta} {comparison.unit === 'points' ? 'ATS points' : 'percentage points'}
                    </span>
                    <span className="muted">
                      {comparison.before.total} → {comparison.after.total} / {comparison.after.scoreableMax}
                    </span>
                  </div>
                </div>
              )}

              {comparison && (
                <p className="tailor__score" role="status">
                  ATS score: {comparison.before.total} / {comparison.before.scoreableMax} before tailoring,{' '}
                  <strong>
                    {comparison.after.total} / {comparison.after.scoreableMax} now
                  </strong>{' '}
                  ({describeScoreChange(comparison)}). It updates each time you save an edit.{' '}
                  <Link to="/analyze">See which keywords moved</Link>.
                </p>
              )}

              <div className="tailor-panel__group">
                <p className="tailor-panel__label">Keywords gained</p>
                {gained.length === 0 ? (
                  <p className="muted">None moved to a better bucket yet.</p>
                ) : (
                  <div className="pills">
                    {gained.slice(0, 10).map((m) => (
                      <span key={m.keyword} className="pill pill--success">
                        {m.keyword}
                      </span>
                    ))}
                    {gained.length > 10 && <span className="pill">+{gained.length - 10} more</span>}
                  </div>
                )}
                {lost.length > 0 && (
                  <p className="inline-status inline-status--warn">
                    {plural(lost.length, 'keyword')} lost coverage. <Link to="/analyze">Check them</Link>.
                  </p>
                )}
              </div>

              {sectionsChanged.length > 0 && (
                <div className="tailor-panel__group">
                  <p className="tailor-panel__label">Sections improved</p>
                  <div className="pills">
                    {sectionsChanged.map((section) => (
                      <span key={section} className="pill">
                        {section}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="tailor-panel__group">
                <ul className="metrics tailor-panel__stats">
                  <li className="metric">
                    <span className="metric__label">AI changes</span>
                    <span className="metric__value">{changesLog.length}</span>
                  </li>
                  <li className="metric">
                    <span className="metric__label">Your edits</span>
                    <span className="metric__value">{edits.length}</span>
                  </li>
                </ul>
                {edits.length > 0 && (
                  <p className="tailor__edits" role="status">
                    You have edited {plural(edits.length, 'part')} by hand since then: {edits.join('; ')}. Export uses
                    your edited version.
                  </p>
                )}
              </div>

              <div className="tailor-panel__group">
                {confirmingDiscard ? (
                  <DiscardConfirmation edits={edits} onConfirm={discard} onCancel={() => setConfirmingDiscard(false)} />
                ) : (
                  <div className="actions">
                    <Link to="/export" className="button button--primary">
                      Continue to export
                      <Icon name="arrowRight" size={16} />
                    </Link>
                    <button type="button" className="button button--ghost" onClick={requestDiscard}>
                      Discard and start over
                    </button>
                  </div>
                )}
              </div>
            </section>
          </aside>
        </div>
      )}
    </section>
  );
}

/** The one AI call on this page: an honest "still working" line with the time it has taken. */
function WorkingLine({ provider }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="loading-line" role="status">
      <span className="loading-line__text">
        <span>Improving relevant sections with {PROVIDER_LABELS[provider] ?? provider}… this usually takes under a minute.</span>
        <span className="loading-line__elapsed" aria-hidden="true">
          {elapsed}s
        </span>
      </span>
      <span className="progress-bar" aria-hidden="true" />
    </div>
  );
}

/**
 * The only way to get a fresh AI pass is to discard this one, and a fresh pass
 * starts from the original resume -- so this is the moment hand edits would be
 * lost. Inline rather than window.confirm, like Start over. It names the edits
 * and says plainly that they will not carry over.
 */
function DiscardConfirmation({ edits, onConfirm, onCancel }) {
  return (
    <div className="notice notice--warn tailor__discard" role="alert">
      <p>
        <strong>Discarding throws away your {plural(edits.length, 'hand edit')}.</strong>
      </p>
      <p>
        This removes the tailored resume, including what you changed in: {edits.join('; ')}. Running tailoring again
        starts from your original resume from step 1, so none of these edits will carry over.
      </p>
      <p className="actions">
        <button type="button" className="button button--danger-solid" onClick={onConfirm}>
          Discard my edits and start over
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Keep my edits
        </button>
      </p>
    </div>
  );
}

/**
 * Surfaced rather than hidden. When the merge has to put something back, the
 * user should know the model's output was not fully compliant -- that is
 * relevant to how carefully they read the rest of it.
 */
function CorrectionsNotice({ corrections }) {
  return (
    <div className="notice notice--warn" role="status">
      <p>
        <strong>
          {corrections.length} thing{corrections.length === 1 ? '' : 's'} had to be put back automatically.
        </strong>
      </p>
      <p>
        The tailoring pass changed or dropped something it was told not to. Those parts were restored from your
        original resume, so nothing is lost — but read the rewrites below with a closer eye.
      </p>
      <ul>
        {corrections.map((c, i) => (
          <li key={`${c.type}-${i}`}>{c.detail}</li>
        ))}
      </ul>
    </div>
  );
}

function ChangesList({ changes, edited }) {
  return (
    <section className="card">
      <div className="section-head">
        <div>
          <h2>
            What the AI changed <span className="muted">({changes.length})</span>
          </h2>
          <p className="muted">
            {edited
              ? 'Your hand edits are not listed here, so an “After” below may no longer match your resume.'
              : 'Each rewrite next to the original it replaced, with the reason it gave.'}
          </p>
        </div>
      </div>
      <ol className="changes">
        {changes.map((change, i) => (
          <li key={`${change.section}-${i}`} className="change">
            <p className="change__where">
              <span className="badge">{change.section || 'resume'}</span>
              {change.target && <span className="change__target">{change.target}</span>}
            </p>

            {change.before ? (
              <p className="change__before">
                <span className="change__label">Before</span>
                {change.before}
              </p>
            ) : (
              <p className="change__before change__before--empty">
                <span className="change__label">Before</span>
                <em>(new — nothing here previously)</em>
              </p>
            )}

            <p className="change__after">
              <span className="change__label">After</span>
              {change.after}
            </p>

            {change.reason && <p className="change__reason muted">{change.reason}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}
