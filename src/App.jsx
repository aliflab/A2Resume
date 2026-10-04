import { useState, useSyncExternalStore } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';

import Icon from './components/Icon.jsx';
import { ACTIONS, useApp } from './context/AppContext.jsx';
import {
  describeArtefactDrift,
  getPersistenceStatus,
  hasSessionContent,
  subscribePersistence,
} from './services/sessionPersistence.js';

// Three tiers, and the header draws them differently on purpose:
// - STEPS, the wizard most visits walk through in order. A connected track in
//   the centre, and the most prominent thing in the header.
// - TOOLS, side pages that work on the same resume but are not a step. Quieter,
//   grouped under their own label on the right.
// - Settings and Start over, which act on the app rather than on a resume.
// Nothing here guards anything -- every page must survive being opened
// directly with empty state. The paths are the routes in router.jsx.
//
// `done` reads whether the artefact a step produces exists. It only changes
// how a step looks (a check instead of its number); no step is ever disabled.
// Export produces nothing stored, so it is never shown as done.
const STEPS = [
  { to: '/input', label: 'Input', done: (s) => Boolean(s.resume && s.parsedJD) },
  { to: '/analyze', label: 'Analyze', done: (s) => Boolean(s.atsScore) },
  { to: '/tailor', label: 'Tailor', done: (s) => Boolean(s.tailoredResume) },
  { to: '/export', label: 'Export', done: () => false },
];

const TOOLS = [
  { to: '/match', label: 'Match', icon: 'target' },
  { to: '/cover-letter', label: 'Cover Letter', icon: 'mail' },
  { to: '/designer', label: 'Designer', icon: 'palette' },
];

export default function App() {
  const { state } = useApp();
  // Bumped by "Start over" and used as the routed page's key. Emptying the
  // store is not enough on its own: the page on screen seeded its local form
  // state from the store on mount (InputPage's textareas), and navigating to
  // the route it is already on does not remount it -- so the old job
  // description stayed visible, one click away from being re-run. A new key
  // forces a fresh mount that reads the now-empty store.
  const [resetCount, setResetCount] = useState(0);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="shell__header">
        <div className="shell__bar">
          <NavLink to="/" className="shell__brand" end aria-label="A2Resume, home">
            <span className="shell__logo">
              <Icon name="logo" size={15} />
            </span>
            <span className="shell__wordmark">A2Resume</span>
          </NavLink>

          <nav className="steps-nav" aria-label="Resume steps">
            <ol>
              {STEPS.map(({ to, label, done }, i) => {
                const complete = done(state);
                return (
                  <li key={to} className={complete ? 'is-complete' : undefined}>
                    <NavLink to={to} className="steps-nav__link">
                      <span className="steps-nav__num" aria-hidden="true">
                        {complete ? <Icon name="check" size={12} /> : i + 1}
                      </span>
                      <span className="visually-hidden">Step {i + 1}: </span>
                      <span className="steps-nav__label">{label}</span>
                      {complete && <span className="visually-hidden"> (done)</span>}
                    </NavLink>
                  </li>
                );
              })}
            </ol>
          </nav>

          <div className="shell__right">
            <nav className="tools-nav" aria-labelledby="tools-nav-label">
              <span id="tools-nav-label" className="tools-nav__label">
                Tools
              </span>
              {TOOLS.map(({ to, label, icon }) => (
                <NavLink key={to} to={to} className="tools-nav__link">
                  <Icon name={icon} size={15} />
                  {label}
                </NavLink>
              ))}
            </nav>

            <span className="shell__divider" aria-hidden="true" />

            <NavLink to="/settings" className="shell__settings">
              <Icon name="settings" size={16} />
              <span className="shell__settings-label">Settings</span>
            </NavLink>
            <SessionControls onReset={() => setResetCount((n) => n + 1)} />
          </div>
        </div>
      </header>

      <main className="shell__main" id="main">
        <div className="page session-notice-slot">
          <SessionNotice />
        </div>
        <Outlet key={resetCount} />
      </main>

      <footer className="shell__footer">
        <div className="shell__footer-inner">
          <p className="shell__footer-note">
            <Icon name="lock" size={14} />
            {/* "Never leaves this device" is not true once an analysis runs:
                the resume goes to the provider the user picked. Input says so,
                and this line agrees with it. */}
            <span>
              Runs entirely in your browser. Your data is stored only on this device, and is sent only to the AI
              provider you choose.
            </span>
          </p>
          <p className="shell__footer-meta">No account · No server · Your own API key</p>
        </div>
      </footer>
    </div>
  );
}

/**
 * "Start over", in the header so it is reachable from every step.
 *
 * Confirmed inline rather than with window.confirm, which blocks the page. The
 * session now survives reloads, so finishing one resume and starting another
 * needs a real wipe -- overwriting piecemeal would leave the previous job's
 * tailoring behind until a new run happened to replace it.
 *
 * Disabled while the analysis pipeline is running: its remaining steps would
 * dispatch into the emptied store and persist the old run straight back.
 */
function SessionControls({ onReset }) {
  const { state, resetSession } = useApp();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const persistence = useSyncExternalStore(subscribePersistence, getPersistenceStatus);

  const running = state.ui?.status === 'running';
  const hasData = hasSessionContent(state);

  const startOver = () => {
    resetSession();
    onReset();
    setConfirming(false);
    navigate('/input');
  };

  return (
    <div className="shell__session">
      {!persistence.ok && (
        <span className="shell__session-warn" role="status">
          Not saved: {persistence.message}
        </span>
      )}

      {confirming ? (
        <div className="shell__confirm" role="group" aria-label="Confirm start over">
          <span className="shell__session-prompt">Clear your resume, job and results? API keys stay.</span>
          <button type="button" className="button button--sm button--danger-solid" onClick={startOver}>
            Yes, start over
          </button>
          <button type="button" className="button button--sm" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="button button--sm button--danger"
          onClick={() => setConfirming(true)}
          disabled={!hasData || running}
          title={running ? 'Wait for the analysis to finish' : hasData ? undefined : 'Nothing to clear'}
        >
          Start over
        </button>
      )}
    </div>
  );
}

const joinList = (items) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/**
 * What the stored session turned out to be, said once, on whatever page the
 * reload landed on. Two cases, and they are different failures:
 *
 * - `ui.restoreIssue`: the session could not be restored at all (a different
 *   SESSION_VERSION, or unreadable JSON). The store is empty and the old entry
 *   is already gone, so the notice is the only record that anything was lost.
 * - describeArtefactDrift: the session restored fine, but its results were
 *   made by a different build (ARTEFACT_VERSION). They are shown, and this
 *   says which of them are not what this build would produce.
 *
 * Dismissible, not a gate. Dismissing drift is remembered per stamp in the
 * persisted `provenance`, so it does not come back on every reload.
 */
function SessionNotice() {
  const { state, dispatch } = useApp();
  const dismiss = () => dispatch({ type: ACTIONS.DISMISS_SESSION_NOTICE });

  const issue = state.ui?.restoreIssue ?? null;
  if (issue) {
    return (
      <div className="notice notice--warn session-notice" role="status">
        <p>
          <strong>Your previous session couldn&apos;t be restored.</strong>
        </p>
        <p>
          {issue === 'incompatible'
            ? 'It was saved by a version of A2Resume that stored its data differently, so it was cleared rather than loaded half-understood.'
            : 'The saved data could not be read, so it was cleared.'}{' '}
          Your API keys are not affected. Start again from <Link to="/input">step 1</Link>.
        </p>
        <p>
          <button type="button" className="button button--sm" onClick={dismiss}>
            Dismiss
          </button>
        </p>
      </div>
    );
  }

  const drift = describeArtefactDrift(state);
  if (!drift) return null;

  const which = drift.relation === 'newer' ? 'a newer' : drift.relation === 'older' ? 'an earlier' : 'a different';
  return (
    <div className="notice notice--warn session-notice" role="status">
      <p>
        <strong>These results were made by {which} version of A2Resume.</strong>
      </p>
      <p>
        {drift.rescored ? 'Your current ATS score was recalculated with this version when the page loaded. ' : ''}
        {drift.artefacts.length > 0
          ? `${joinList(drift.artefacts).replace(/^./, (c) => c.toUpperCase())} ${drift.artefacts.length === 1 ? 'was' : 'were'} not, and may differ from what this version would produce.`
          : ''}{' '}
        To refresh everything, run the analysis again on <Link to="/input">step 1</Link>. Your resume and job
        description text are kept.
      </p>
      <p>
        <button type="button" className="button" onClick={dismiss}>
          Got it
        </button>
      </p>
    </div>
  );
}

