import { useCallback, useState } from 'react';

import { PROVIDER_IDS, getApiKey, getKeyPresence, setApiKey, clearApiKey } from '../services/apiKeyService.js';
import { PROVIDER_LABELS, testConnection } from '../services/aiService.js';
import { describeAiFailure } from '../utils/errorMessages.js';
import Icon from '../components/Icon.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';
import Spinner from '../components/ui/Spinner.jsx';

/**
 * Settings -> API keys.
 *
 * Storage and connection testing only. Choosing a default provider is
 * InputPage's decision and is deliberately not made here.
 *
 * THE MASKING RULE
 * ----------------
 * A stored key is never read into React state, never set as an input's
 * `value`, and never rendered. `getKeyPresence()` returns booleans, and that
 * is all this page knows about a saved key -- so there is nothing in the
 * component tree, the DOM, or a React DevTools inspection to leak.
 *
 * "Populated" therefore means the field *shows* a saved key exists (a
 * placeholder of fixed-length dots plus a "Saved" badge), not that it
 * contains one. The dots are a constant string, not derived from the real
 * key, so even its length is not disclosed.
 *
 * The one time a key value exists in this component is while the user is
 * typing a replacement, which is unavoidable and is what `type="password"`
 * masks. That draft is dropped from state the moment it is saved.
 *
 * There is deliberately no reveal toggle. Typo diagnosis is what Test
 * Connection is for, and it answers the real question -- "does this key
 * work?" -- better than squinting at the characters would.
 */

/** Fixed-width mask. Not derived from any real key, including its length. */
const MASK = '••••••••••••••••••••';

export default function Settings() {
  return (
    <section className="page page--narrow settings">
      <PageHeader eyebrow="Settings" title="Settings">
        Your AI provider keys, and what this browser keeps. A2Resume has no accounts, no server and no database, so
        everything here lives on this device only.
      </PageHeader>
      <ApiKeysSection />
      <SessionDataSection />
    </section>
  );
}

/** Plain statement of where resume content lives. Kept in sync with PERSISTED_FIELD_NAMES and resetSession. */
function SessionDataSection() {
  return (
    <section className="card settings__section" aria-labelledby="your-data-title">
      <div className="section-head">
        <div className="section-head__title">
          <span className="section-head__icon">
            <Icon name="database" size={18} />
          </span>
          <div>
            <h2 id="your-data-title">Your data</h2>
            <p className="muted">Your resume and the job description are saved only in this browser, on this device.</p>
          </div>
        </div>
      </div>

      <ul className="byok-points">
        <li>
          <Icon name="file" size={16} />
          <span>
            <strong>Your resume and the job description</strong> are stored locally, so a reload picks up where you
            left off.
          </span>
        </li>
        <li>
          <Icon name="layers" size={16} />
          <span>
            <strong>Everything made from them</strong> &mdash; the analysis, the score, the tailored resume, cover
            letters and job matches &mdash; is stored locally too.
          </span>
        </li>
        <li>
          <Icon name="refresh" size={16} />
          <span>
            <strong>Start over</strong>, in the header, deletes all of it. Clearing your browser data deletes it too.
            Start over does not remove your API keys.
          </span>
        </li>
        <li>
          <Icon name="lock" size={16} />
          <span>Until then, anyone who can use this browser profile can open them.</span>
        </li>
      </ul>
    </section>
  );
}

function ApiKeysSection() {
  // Booleans only. Never key values.
  const [presence, setPresence] = useState(() => safeKeyPresence());
  const refreshPresence = useCallback(() => setPresence(safeKeyPresence()), []);
  const configured = PROVIDER_IDS.filter((id) => presence[id]).length;

  return (
    <section className="card settings__section" aria-labelledby="providers-title">
      <div className="section-head">
        <div className="section-head__title">
          <span className="section-head__icon">
            <Icon name="key" size={18} />
          </span>
          <div>
            <h2 id="providers-title">AI providers</h2>
            <p className="muted">
              {configured === 0
                ? 'Add a key for at least one provider to run an analysis.'
                : `${configured} of ${PROVIDER_IDS.length} configured.`}
            </p>
          </div>
        </div>
      </div>

      <ul className="byok-points">
        <li>
          <Icon name="key" size={16} />
          <span>
            <strong>Bring your own key.</strong> It is saved only in this browser, on this device, and is never shown
            again once saved &mdash; not even its length.
          </span>
        </li>
        <li>
          <Icon name="shield" size={16} />
          <span>
            When you run an analysis, your resume goes <strong>directly from your browser to the provider you
            picked</strong>, using your key. It does not pass through a server belonging to this app, because there
            isn&apos;t one.
          </span>
        </li>
        <li>
          <Icon name="info" size={16} />
          <span>
            Clearing your browser data deletes your keys, they do not follow you to another device, and anyone who can
            use this browser profile can use them. Charges appear on your own account with that provider.
          </span>
        </li>
      </ul>

      <ol className="providers">
        {PROVIDER_IDS.map((id) => (
          <ProviderRow key={id} provider={id} hasKey={!!presence[id]} onChanged={refreshPresence} />
        ))}
      </ol>
    </section>
  );
}

function ProviderRow({ provider, hasKey, onChanged }) {
  /** What the user is typing right now. Never seeded from storage. */
  const [draft, setDraft] = useState('');
  const [saveState, setSaveState] = useState(null); // { tone, message }
  const [testState, setTestState] = useState(null); // { tone, message, hint }
  const [testing, setTesting] = useState(false);

  const label = PROVIDER_LABELS[provider] ?? provider;
  const inputId = `key-${provider}`;
  const trimmed = draft.trim();

  const handleSave = useCallback(() => {
    if (!trimmed) return;
    try {
      setApiKey(provider, trimmed);
      setDraft(''); // Drop the value as soon as it belongs to storage.
      setSaveState({ tone: 'ok', message: 'Key saved in this browser.' });
      // A new key invalidates whatever the last test said about the old one.
      setTestState(null);
      onChanged();
    } catch (err) {
      setSaveState({ tone: 'error', message: err?.message || 'Could not save the key.' });
    }
  }, [onChanged, provider, trimmed]);

  const handleClear = useCallback(() => {
    try {
      clearApiKey(provider);
      setDraft('');
      setSaveState({ tone: 'ok', message: 'Key removed from this browser.' });
      setTestState(null);
      onChanged();
    } catch (err) {
      setSaveState({ tone: 'error', message: err?.message || 'Could not remove the key.' });
    }
  }, [onChanged, provider]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestState(null);
    setSaveState(null);

    try {
      // Prefer what is typed but unsaved, so a key can be checked before it is
      // committed. Otherwise read storage at the last moment and do not hold
      // the value beyond this call.
      const key = trimmed || getApiKey(provider);
      if (!key) {
        setTestState({ tone: 'error', message: 'No key to test. Enter one above, or save one first.' });
        return;
      }

      const result = await testConnection({ provider, apiKey: key });

      if (result.success) {
        // The model id is deliberately not shown: it is an internal detail of
        // the fallback list, and it changes as providers retire models.
        setTestState({ tone: 'ok', message: `Connection successful. ${label} accepted this key.` });
      } else {
        const described = describeAiFailure({ code: result.code, message: result.error, provider });
        setTestState({
          tone: 'error',
          message: described.message,
          // Auth hints are written for the pipeline, where the next step is
          // "go to Settings". Here the user is already in Settings with the
          // field in front of them, so the hint would be circular.
          hint: described.isAuth ? undefined : described.hint,
        });
      }
    } catch (err) {
      // testConnection is documented not to throw; if it ever does, say so
      // rather than leaving the row stuck on "Testing...".
      setTestState({ tone: 'error', message: `The test itself failed: ${err?.message || 'unknown error'}.` });
    } finally {
      setTesting(false);
    }
  }, [label, provider, trimmed]);

  return (
    <li className={`provider${hasKey ? ' provider--saved' : ''}`} aria-busy={testing || undefined}>
      <div className="provider__head">
        <span className="provider__mark" aria-hidden="true">
          {label.replace(/^Google\s+/, '').charAt(0)}
        </span>
        <label htmlFor={inputId} className="provider__name">
          {label}
        </label>
        <span className={hasKey ? 'badge badge--dot badge--on' : 'badge badge--dot'}>
          {hasKey ? 'Configured' : 'Not configured'}
        </span>
      </div>

      <div className="row">
        <input
          id={inputId}
          type="password"
          className="provider__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          // A saved key shows as a constant mask. The field itself stays empty:
          // typing here replaces the stored key, it does not edit it.
          placeholder={hasKey ? `${MASK}  (saved)` : `Paste your ${label} API key`}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`status-${provider}`}
        />
        <button type="button" className={trimmed ? 'button button--primary' : 'button'} onClick={handleSave} disabled={!trimmed}>
          {hasKey && trimmed ? 'Replace' : 'Save'}
        </button>
        <button
          type="button"
          className="button"
          onClick={handleTest}
          disabled={testing || (!trimmed && !hasKey)}
          aria-busy={testing || undefined}
        >
          {testing && <Spinner />}
          {testing ? 'Testing connection…' : 'Test connection'}
        </button>
        <button type="button" className="button button--ghost" onClick={handleClear} disabled={!hasKey}>
          Remove
        </button>
      </div>

      {/*
        Test results persist until the next action on this row rather than
        fading: the point of this page is to see, at a glance, which providers
        actually work. A toast would take that away the moment you looked away.
      */}
      <div id={`status-${provider}`} className="provider__status" aria-live="polite">
        {saveState && <p className={`inline-status inline-status--${saveState.tone}`}>{saveState.message}</p>}
        {testState && (
          <p className={`inline-status inline-status--${testState.tone}`}>
            <span>
              {testState.message}
              {testState.hint && <span className="muted"> {testState.hint}</span>}
            </span>
          </p>
        )}
      </div>
    </li>
  );
}

/** localStorage throws in some private modes; unreadable storage means no keys. */
function safeKeyPresence() {
  try {
    return getKeyPresence();
  } catch {
    return {};
  }
}
