import { useState, useSyncExternalStore } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';

import { useApp } from './context/AppContext.jsx';
import { getPersistenceStatus, hasSessionContent, subscribePersistence } from './services/sessionPersistence.js';

// The four wizard steps, then the side tools. Nothing here guards anything --
// every page must survive being opened directly with empty state.
const NAV = [
  { to: '/input', label: '1. Input' },
  { to: '/analyze', label: '2. Analyze' },
  { to: '/tailor', label: '3. Tailor' },
  { to: '/export', label: '4. Export' },
  { to: '/match', label: 'Match' },
  { to: '/cover-letter', label: 'Cover Letter' },
  { to: '/designer', label: 'Designer' },
  { to: '/settings', label: 'Settings' },
];

export default function App() {
  // Bumped by "Start over" and used as the routed page's key. Emptying the
  // store is not enough on its own: the page on screen seeded its local form
  // state from the store on mount (InputPage's textareas), and navigating to
  // the route it is already on does not remount it -- so the old job
  // description stayed visible, one click away from being re-run. A new key
  // forces a fresh mount that reads the now-empty store.
  const [resetCount, setResetCount] = useState(0);

  return (
    <div className="shell">
      <header className="shell__header">
        <NavLink to="/" className="shell__brand">
          A2Resume
        </NavLink>
        <nav className="shell__nav">
          {NAV.map(({ to, label }) => (
            <NavLink key={to} to={to}>
              {label}
            </NavLink>
          ))}
        </nav>
        <SessionControls onReset={() => setResetCount((n) => n + 1)} />
      </header>

      <main className="shell__main">
        <Outlet key={resetCount} />
      </main>

      <footer className="shell__footer">
        <span>Runs entirely in your browser. Your data never leaves this device.</span>
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
        <>
          <span className="shell__session-prompt">Clear your resume, job and results? API keys stay.</span>
          <button type="button" className="button button--danger" onClick={startOver}>
            Yes, start over
          </button>
          <button type="button" className="button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          className="button"
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
