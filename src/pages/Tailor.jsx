import { useCallback, useState } from 'react';
import { Link } from 'react-router';

import { useApp, ACTIONS } from '../context/AppContext.jsx';
import { tailorResumeWithAI } from '../services/resumeTailor.js';
import { getApiKey, getKeyPresence } from '../services/apiKeyService.js';
import { PROVIDER_LABELS } from '../services/aiService.js';
import { describeError } from '../utils/errorMessages.js';

/**
 * Step 3: run the tailoring pass and show what it changed.
 *
 * Deliberately minimal this session. There is no inline bullet editor and no
 * chat copilot here yet -- this page exists to trigger the pass and let the
 * user read every rewrite next to its original, which is the review step that
 * has to exist before any of the richer editing does.
 *
 * Like every other page there is no route guard, so loaded cold it shows an
 * empty state pointing back at the step that produces its input.
 */

const asArray = (v) => (Array.isArray(v) ? v : []);

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

  const resume = state.resume ?? null;
  const parsedJD = state.parsedJD ?? null;
  const gapAnalysis = state.gapAnalysis ?? state.atsScore?.gapAnalysis ?? null;
  const tailored = state.tailoredResume ?? null;
  const changesLog = asArray(state.changesLog);
  const corrections = asArray(state.tailorCorrections);

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
      dispatch({ type: ACTIONS.SET_TAILORED_RESUME, payload: result });
    } catch (err) {
      setError(describeError(err, { provider }));
    } finally {
      setBusy(false);
    }
  }, [dispatch, gapAnalysis, parsedJD, provider, resume]);

  const discard = useCallback(() => {
    dispatch({ type: ACTIONS.CLEAR_TAILORING });
    setError(null);
  }, [dispatch]);

  if (!resume || !parsedJD) return <EmptyState />;

  return (
    <section className="page tailor">
      <header className="tailor__head">
        <p className="tailor__step">Step 3 of 4</p>
        <h1>Tailor your resume</h1>
        <p className="muted">
          Rewrites your bullets toward the posting. It never deletes a role, a date, or a skill, and it is not
          allowed to invent a number your resume does not already support.
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
                ? 'The model reported no changes.'
                : `${changesLog.length} change${changesLog.length === 1 ? '' : 's'} reported.`}
            </p>
            <p>
              <button type="button" className="button" onClick={discard}>
                Discard and start over
              </button>
            </p>
          </section>

          {corrections.length > 0 && <CorrectionsNotice corrections={corrections} />}

          {changesLog.length > 0 && <ChangesList changes={changesLog} />}
        </>
      )}
    </section>
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

function ChangesList({ changes }) {
  return (
    <section className="card">
      <h2>Before and after</h2>
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
