import { useCallback, useState } from 'react';
import { Link } from 'react-router';

import { useApp, ACTIONS } from '../context/AppContext.jsx';
import TailoredResumeEditor from '../components/tailor/TailoredResumeEditor.jsx';
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

  if (!resume || !parsedJD) return <EmptyState />;

  return (
    <section className="page tailor">
      <header className="tailor__head">
        <p className="tailor__step">Step 3 of 4</p>
        <h1>Tailor your resume</h1>
        <p className="muted">
          Rewrites your bullets toward the posting. It never deletes a role, a date, or a skill, and it is not
          allowed to invent a number your resume does not already support. You can then edit the result by hand.
        </p>
      </header>

      {!tailored && (
        <section className="card">
          <h2>Run the tailoring pass</h2>
          {!provider || !hasKey ? (
            <p className="inline-status inline-status--error">
              This needs an AI provider. <Link to="/settings">Add a key in Settings</Link>.
            </p>
          ) : (
            <p>
              <button type="button" className="button button--primary" onClick={run} disabled={busy}>
                {busy ? 'Tailoring your resume...' : 'Tailor my resume'}
              </button>
            </p>
          )}
          {error && (
            <p className="inline-status inline-status--error">
              {error.message} {error.isAuth && <Link to="/settings">Open Settings</Link>}
            </p>
          )}
        </section>
      )}

      {tailored && (
        <>
          <section className="card">
            <h2>What changed</h2>
            <p className="muted">
              {changesLog.length === 0
                ? 'The AI pass reported no changes.'
                : `The AI pass reported ${plural(changesLog.length, 'change')}.`}
            </p>
            {edits.length > 0 && (
              <p className="tailor__edits" role="status">
                You have edited {plural(edits.length, 'part')} by hand since then: {edits.join('; ')}. Export uses your
                edited version.
              </p>
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

            {confirmingDiscard ? (
              <DiscardConfirmation edits={edits} onConfirm={discard} onCancel={() => setConfirmingDiscard(false)} />
            ) : (
              <p className="actions">
                <Link to="/export" className="button button--primary">
                  Continue to export
                </Link>
                <button type="button" className="button" onClick={requestDiscard}>
                  Discard and start over
                </button>
              </p>
            )}
          </section>

          {corrections.length > 0 && <CorrectionsNotice corrections={corrections} />}

          <TailoredResumeEditor resume={tailored} />

          {changesLog.length > 0 && <ChangesList changes={changesLog} edited={edits.length > 0} />}
        </>
      )}
    </section>
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
        <button type="button" className="button button--danger" onClick={onConfirm}>
          Discard my edits and start over
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Keep my edits
        </button>
      </p>
    </div>
  );
}

function EmptyState() {
  return (
    <section className="page tailor">
      <h1>Nothing to tailor yet</h1>
      <p className="muted">
        Tailoring needs your resume and the job description you are targeting. Add both on step 1 and run the
        analysis first.
      </p>
      <p>
        <Link to="/input" className="button button--primary">
          Go to step 1
        </Link>
      </p>
    </section>
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
      <h2>Before and after</h2>
      {edited && (
        <p className="muted">
          This is what the AI pass changed. Your hand edits are not listed here, so an &ldquo;After&rdquo; below may
          no longer match your resume.
        </p>
      )}
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
