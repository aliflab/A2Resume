import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { useApp, ACTIONS, PIPELINE_STAGES } from '../context/AppContext.jsx';
import { fetchJobDescriptionFromUrl } from '../services/jdScraper.js';
import { MAX_FILE_SIZE } from '../utils/uploadLimits.js';
import { runAnalysisPipeline } from '../services/analysisPipeline.js';
import { getKeyPresence, getApiKey, PROVIDER_IDS } from '../services/apiKeyService.js';
import { SUPPORTED_PROVIDERS, PROVIDER_LABELS } from '../services/aiService.js';
import { describeError } from '../utils/errorMessages.js';
import { describeManualEdits } from '../services/tailoredEdits.js';

/**
 * Step 1 of the wizard: get a resume and a job description in, pick a
 * provider, run the pipeline.
 *
 * No route guard protects this page, and it guards nothing itself -- it can be
 * loaded cold, mid-flow, or after a refresh that emptied the store, and every
 * read from AppContext is written for `null`.
 *
 * KEY HANDLING
 * ------------
 * This page never reads, writes, or caches a key value. `getKeyPresence()`
 * (booleans only) drives which providers are offered, and `getApiKey()` is
 * called once at submit and handed straight to the pipeline. Nothing about
 * which providers exist or whether one is usable is decided here -- that is
 * `apiKeyService` and `aiService` respectively.
 */

/** Providers the AI layer supports *and* the key store knows about. */
const KNOWN_PROVIDERS = SUPPORTED_PROVIDERS.filter((id) => PROVIDER_IDS.includes(id));

const formatBytes = (b) => `${(b / (1024 * 1024)).toFixed(0)} MB`;

export default function InputPage() {
  const { state, dispatch } = useApp();
  const navigate = useNavigate();

  // --- Resume input ---------------------------------------------------------
  const [resumeMode, setResumeMode] = useState('upload'); // 'upload' | 'paste'
  const [resumeText, setResumeText] = useState(state.resumeText ?? '');
  const [resumeFileName, setResumeFileName] = useState(state.sources?.resumeFileName ?? null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfNotice, setPdfNotice] = useState(null); // { tone, message }
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef(null);

  // --- Job description input ------------------------------------------------
  const [jdText, setJdText] = useState(state.jobDescription ?? '');
  const [jdUrl, setJdUrl] = useState(state.sources?.jobDescriptionUrl ?? '');
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlNotice, setUrlNotice] = useState(null);

  // --- Provider -------------------------------------------------------------
  // Read once per mount. Settings lives on another route, so a change there
  // means a remount on the way back; re-reading on every render would just be
  // a localStorage hit per keystroke.
  const [presence, setPresence] = useState(() => safeKeyPresence());
  const availableProviders = useMemo(
    () => KNOWN_PROVIDERS.filter((id) => presence[id]),
    [presence]
  );
  const [chosenProvider, setProvider] = useState(() => state.settings?.provider ?? null);

  // Derived during render rather than synced by an effect: the effective
  // provider is the user's choice while it remains usable, otherwise the first
  // one that is. A key removed in Settings therefore cannot leave a stale
  // selection pointing at a provider with no key.
  const provider =
    chosenProvider && availableProviders.includes(chosenProvider)
      ? chosenProvider
      : availableProviders[0] ?? null;

  // A key added in another tab, or in Settings before this page was mounted.
  useEffect(() => {
    const refresh = () => setPresence(safeKeyPresence());
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  // --- Run state ------------------------------------------------------------
  const status = state.ui?.status ?? 'idle';
  const stage = state.ui?.stage ?? null;
  const error = state.ui?.error ?? null;
  const running = status === 'running';
  const abortRef = useRef(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // --- Resume: PDF ----------------------------------------------------------
  const handleFile = useCallback(async (file) => {
    if (!file) return;

    setPdfBusy(true);
    setPdfNotice(null);
    try {
      // Loaded on demand: pdfParser pulls in pdf.js, which is most of the
      // app's weight and is useless to anyone who pastes their resume in.
      const { extractTextFromPdf } = await import('../services/pdfParser.js');
      const result = await extractTextFromPdf(file);
      setResumeText(result.text);
      setResumeFileName(result.fileName);

      setPdfNotice({
        tone: result.isLikelyScanned ? 'warn' : 'ok',
        message: result.isLikelyScanned
          ? `Read ${result.pageCount} page${result.pageCount === 1 ? '' : 's'} but found almost no text -- this looks like a scan. Check the text below and paste it in manually if it is wrong.`
          : `Read ${result.charCount.toLocaleString()} characters from ${result.pagesWithText} of ${result.pageCount} page${result.pageCount === 1 ? '' : 's'}. Check it below before running.`,
      });

      // Extraction is imperfect on multi-column layouts, so the text is always
      // shown and always editable rather than hidden behind a filename chip.
      setResumeMode('paste');
    } catch (err) {
      const described = describeError(err);
      setPdfNotice({ tone: 'error', message: described.message });
      setResumeFileName(null);
    } finally {
      setPdfBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, []);

  const onDrop = useCallback(
    (event) => {
      event.preventDefault();
      setDragging(false);
      handleFile(event.dataTransfer?.files?.[0]);
    },
    [handleFile]
  );

  // --- Job description: URL -------------------------------------------------
  const handleFetchUrl = useCallback(async () => {
    if (!jdUrl.trim()) return;

    setUrlBusy(true);
    setUrlNotice(null);
    try {
      const result = await fetchJobDescriptionFromUrl(jdUrl);
      setJdText(result.text);
      setUrlNotice({
        tone: 'ok',
        message: `Fetched ${result.charCount.toLocaleString()} characters via ${result.proxy}. Check it below -- readers pick up navigation and boilerplate as well as the posting.`,
      });
    } catch (err) {
      const described = describeError(err);
      setUrlNotice({
        tone: 'error',
        message: described.message,
        hint: described.hint,
      });
    } finally {
      setUrlBusy(false);
    }
  }, [jdUrl]);

  // --- Run ------------------------------------------------------------------
  const canRun =
    !running && !pdfBusy && !urlBusy && resumeText.trim() !== '' && jdText.trim() !== '' && !!provider;

  const handleRun = useCallback(
    async (event) => {
      event?.preventDefault();
      if (!canRun) return;

      const controller = new AbortController();
      abortRef.current = controller;

      // Persist the inputs before the run so nothing is lost if it fails.
      dispatch({ type: ACTIONS.SET_RESUME_TEXT, payload: resumeText });
      dispatch({ type: ACTIONS.SET_JOB_DESCRIPTION, payload: jdText });
      dispatch({
        type: ACTIONS.SET_SOURCES,
        payload: {
          resume: resumeFileName ? 'pdf' : 'paste',
          resumeFileName,
          jobDescription: jdUrl.trim() ? 'url' : 'paste',
          jobDescriptionUrl: jdUrl.trim() || null,
          provider,
        },
      });
      dispatch({ type: ACTIONS.SET_SETTINGS, payload: { provider } });

      dispatch({ type: ACTIONS.CLEAR_ANALYSIS });
      dispatch({ type: ACTIONS.SET_STATUS, payload: 'running' });

      try {
        // Read the key at the last possible moment and do not hold it in
        // component state, where it would sit in a React DevTools tree.
        const apiKey = getApiKey(provider);
        if (!apiKey) {
          throw Object.assign(new Error('No API key stored for this provider.'), {
            name: 'AiError',
            code: 'auth',
            provider,
          });
        }

        await runAnalysisPipeline({
          resumeText,
          jdText,
          provider,
          apiKey,
          signal: controller.signal,
          onStage: (id) => dispatch({ type: ACTIONS.SET_STAGE, payload: id }),
          // Dispatched per step, so a failure at step 3 still leaves steps 1
          // and 2 in the store for the next page to show.
          onResult: (key, value) => dispatch({ type: RESULT_ACTIONS[key], payload: value }),
        });

        dispatch({ type: ACTIONS.SET_STAGE, payload: null });
        dispatch({ type: ACTIONS.SET_STATUS, payload: 'done' });
        navigate('/analyze');
      } catch (err) {
        if (err?.name === 'AbortError') {
          dispatch({ type: ACTIONS.SET_STATUS, payload: 'idle' });
          dispatch({ type: ACTIONS.SET_STAGE, payload: null });
          return;
        }
        const described = describeError(err, { provider });
        dispatch({ type: ACTIONS.SET_ERROR, payload: described });
      } finally {
        abortRef.current = null;
      }
    },
    [canRun, dispatch, jdText, jdUrl, navigate, provider, resumeFileName, resumeText]
  );

  const noProviders = availableProviders.length === 0;

  return (
    <section className="page input-page">
      <header className="input-page__head">
        <p className="input-page__step">Step 1 of 4</p>
        <h1>Add your resume and the job</h1>
        <p className="input-page__lede">
          Everything is processed in your browser. Your resume is only ever sent to the AI provider you
          pick below, using your own key.
        </p>
      </header>

      <form onSubmit={handleRun}>
        {/* ------------------------------------------------------------- */}
        <fieldset className="card" disabled={running}>
          <legend>1. Your resume</legend>

          <div className="tabs" role="tablist" aria-label="Resume input method">
            <TabButton active={resumeMode === 'upload'} onClick={() => setResumeMode('upload')}>
              Upload a PDF
            </TabButton>
            <TabButton active={resumeMode === 'paste'} onClick={() => setResumeMode('paste')}>
              Paste text
            </TabButton>
          </div>

          {resumeMode === 'upload' && (
            <div
              className={`dropzone${dragging ? ' dropzone--active' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,.pdf"
                id="resume-file"
                onChange={(e) => handleFile(e.target.files?.[0])}
                hidden
              />
              <label htmlFor="resume-file" className="button">
                {pdfBusy ? 'Reading...' : 'Choose a PDF'}
              </label>
              <p className="muted">
                or drop one here &middot; up to {formatBytes(MAX_FILE_SIZE)} &middot; never uploaded anywhere
              </p>
              <p className="muted">
                Scanned or image-only PDFs have no text to read.{' '}
                <button type="button" className="link" onClick={() => setResumeMode('paste')}>
                  Paste the text instead
                </button>
                .
              </p>
            </div>
          )}

          {pdfNotice && <Notice tone={pdfNotice.tone}>{pdfNotice.message}</Notice>}

          {resumeMode === 'paste' && (
            <>
              <label htmlFor="resume-text" className="field-label">
                Resume text
                {resumeFileName && <span className="muted"> &middot; extracted from {resumeFileName}</span>}
              </label>
              <textarea
                id="resume-text"
                value={resumeText}
                onChange={(e) => setResumeText(e.target.value)}
                rows={14}
                placeholder="Paste your full resume here, including contact details, experience bullets, skills and education."
                spellCheck={false}
              />
              <p className="muted">
                {resumeText.trim() ? `${resumeText.length.toLocaleString()} characters` : 'Nothing yet.'} Fix any
                mangled columns here before running -- what you see is exactly what gets parsed.
              </p>
            </>
          )}
        </fieldset>

        {/* ------------------------------------------------------------- */}
        <fieldset className="card" disabled={running}>
          <legend>2. The job description</legend>

          <label htmlFor="jd-url" className="field-label">
            Fetch from a URL <span className="muted">(optional)</span>
          </label>
          <div className="row">
            <input
              id="jd-url"
              type="url"
              value={jdUrl}
              onChange={(e) => setJdUrl(e.target.value)}
              placeholder="https://jobs.example.com/postings/12345"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleFetchUrl();
                }
              }}
            />
            <button type="button" onClick={handleFetchUrl} disabled={urlBusy || !jdUrl.trim()}>
              {urlBusy ? 'Fetching...' : 'Fetch'}
            </button>
          </div>
          <p className="muted">
            Fetching goes through public proxies and fails on some boards -- LinkedIn, Indeed and Glassdoor
            block it outright. Pasting the text always works.
          </p>

          {urlNotice && (
            <Notice tone={urlNotice.tone}>
              {urlNotice.message}
              {urlNotice.hint && <> {urlNotice.hint}</>}
            </Notice>
          )}

          <label htmlFor="jd-text" className="field-label">
            Job description text
          </label>
          <textarea
            id="jd-text"
            value={jdText}
            onChange={(e) => setJdText(e.target.value)}
            rows={12}
            placeholder="Paste the job description here -- responsibilities, requirements, and nice-to-haves."
            spellCheck={false}
          />
          <p className="muted">
            {jdText.trim() ? `${jdText.length.toLocaleString()} characters` : 'Nothing yet.'}
          </p>
        </fieldset>

        {/* ------------------------------------------------------------- */}
        <fieldset className="card" disabled={running}>
          <legend>3. AI provider</legend>

          {noProviders ? (
            <Notice tone="warn">
              No API keys are set up yet, so there is no provider to run with. A2Resume has no backend and no
              account system -- it uses your own key, stored only in this browser.{' '}
              <Link to="/settings">Add a key in Settings</Link> and come back.
            </Notice>
          ) : (
            <>
              <label htmlFor="provider" className="field-label">
                Run this analysis with
              </label>
              <select id="provider" value={provider ?? ''} onChange={(e) => setProvider(e.target.value)}>
                {availableProviders.map((id) => (
                  <option key={id} value={id}>
                    {PROVIDER_LABELS[id] ?? id}
                  </option>
                ))}
              </select>
              <p className="muted">
                Only providers with a stored key are listed.{' '}
                <Link to="/settings">Manage keys in Settings</Link>.
                {availableProviders.length < KNOWN_PROVIDERS.length && (
                  <> {KNOWN_PROVIDERS.length - availableProviders.length} other provider
                    {KNOWN_PROVIDERS.length - availableProviders.length === 1 ? ' is' : 's are'} supported but
                    have no key.</>
                )}
              </p>
            </>
          )}
        </fieldset>

        {/* ------------------------------------------------------------- */}
        {error && <ErrorPanel error={error} onDismiss={() => dispatch({ type: ACTIONS.SET_ERROR, payload: null })} />}

        {running && <StageProgress current={stage} />}

        {/* A new run clears tailoring (CLEAR_ANALYSIS), hand edits included.
            Said up front, next to the button that does it. */}
        {!running && state.tailoredResume && describeManualEdits(state.tailorManualEdits).length > 0 && (
          <div className="notice notice--warn" role="status">
            <p>
              <strong>
                Running a new analysis replaces your tailored resume from step 3, including{' '}
                {describeManualEdits(state.tailorManualEdits).length} part
                {describeManualEdits(state.tailorManualEdits).length === 1 ? '' : 's'} you edited by hand.
              </strong>{' '}
              <Link to="/export">Export your edited resume</Link> first if you want to keep it.
            </p>
          </div>
        )}

        <div className="actions">
          <button type="submit" className="button button--primary" disabled={!canRun}>
            {running ? 'Analysing...' : 'Analyse my resume'}
          </button>
          {running && (
            <button type="button" onClick={() => abortRef.current?.abort()}>
              Cancel
            </button>
          )}
          {!running && !canRun && !noProviders && (
            <p className="muted">
              {resumeText.trim() === '' && 'Add your resume. '}
              {jdText.trim() === '' && 'Add the job description. '}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}

/** action to dispatch for each artefact the pipeline emits. */
const RESULT_ACTIONS = {
  resume: ACTIONS.SET_RESUME,
  parsedJD: ACTIONS.SET_PARSED_JD,
  gapAnalysis: ACTIONS.SET_GAP_ANALYSIS,
  atsScore: ACTIONS.SET_ATS_SCORE,
};

/** localStorage can throw in private modes; an unreadable store means no keys. */
function safeKeyPresence() {
  try {
    return getKeyPresence();
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Presentational bits
// ---------------------------------------------------------------------------

function TabButton({ active, onClick, children }) {
  return (
    <button type="button" role="tab" aria-selected={active} className={active ? 'tab tab--active' : 'tab'} onClick={onClick}>
      {children}
    </button>
  );
}

function Notice({ tone = 'ok', children }) {
  return (
    <p className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

/**
 * Per-stage progress rather than one spinner. The two AI calls are slow and
 * the two local steps are instant, so a single spinner would sit still for
 * most of the run and tell the user nothing about where it is.
 */
function StageProgress({ current }) {
  const currentIndex = PIPELINE_STAGES.findIndex((s) => s.id === current);

  return (
    <ol className="stages" aria-live="polite">
      {PIPELINE_STAGES.map((s, i) => {
        const stateName = currentIndex === -1 ? 'pending' : i < currentIndex ? 'done' : i === currentIndex ? 'active' : 'pending';
        return (
          <li key={s.id} className={`stage stage--${stateName}`}>
            <span className="stage__marker" aria-hidden="true">
              {stateName === 'done' ? '✓' : stateName === 'active' ? '•' : '○'}
            </span>
            <span>{s.label}</span>
            {stateName === 'active' && <span className="muted"> - working...</span>}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * An auth failure is the one error with a single obvious next step, so it gets
 * a link rather than only prose. Everything else shows the described message
 * and its hint -- never a raw error object.
 */
function ErrorPanel({ error, onDismiss }) {
  return (
    <div className="notice notice--error" role="alert">
      <p>
        <strong>{error.isAuth ? 'Provider rejected your key' : 'That run did not finish'}</strong>
      </p>
      <p>{error.message}</p>
      {error.hint && <p className="muted">{error.hint}</p>}
      <p>
        {error.isAuth && (
          <>
            <Link to="/settings">Open Settings</Link>
            {' · '}
          </>
        )}
        <button type="button" className="link" onClick={onDismiss}>
          Dismiss
        </button>
      </p>
    </div>
  );
}
