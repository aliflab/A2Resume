import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { useApp, ACTIONS, PIPELINE_STAGES } from '../context/AppContext.jsx';
import { fetchJobDescriptionFromUrl } from '../services/jdScraper.js';
import { MAX_FILE_SIZE } from '../utils/uploadLimits.js';
import { runAnalysisPipeline } from '../services/analysisPipeline.js';
import { getKeyPresence, getApiKey, PROVIDER_IDS } from '../services/apiKeyService.js';
import { SUPPORTED_PROVIDERS, PROVIDER_LABELS } from '../services/aiService.js';
import { describeError, describeModelFallback } from '../utils/errorMessages.js';
import { describeManualEdits } from '../services/tailoredEdits.js';
import Icon from '../components/Icon.jsx';
import ErrorNotice from '../components/ui/ErrorNotice.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';

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
  // Opens on the text when there already is some (a reload, or a return from
  // step 2), so the resume being worked on is what the user sees first.
  const [resumeMode, setResumeMode] = useState(() => (state.resumeText?.trim() ? 'paste' : 'upload')); // 'upload' | 'paste'
  const [resumeText, setResumeText] = useState(state.resumeText ?? '');
  const [resumeFileName, setResumeFileName] = useState(state.sources?.resumeFileName ?? null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfNotice, setPdfNotice] = useState(null); // { tone, message }
  // What the last extraction found, for the file card. Display only: the
  // text itself is `resumeText`, always shown and editable below it.
  const [pdfInfo, setPdfInfo] = useState(null);
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
  // The latest model-fallback event of the current AI step, or null. Page-local
  // on purpose: transient progress detail, only shown by this page's stage
  // list, and cleared whenever the stage changes -- a fallback during the
  // resume parse says nothing about the job-description parse after it.
  const [modelFallback, setModelFallback] = useState(null);

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
      setPdfInfo({ pageCount: result.pageCount, charCount: result.charCount, isLikelyScanned: result.isLikelyScanned });

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
      setPdfInfo(null);
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
          onStage: (id) => {
            setModelFallback(null);
            dispatch({ type: ACTIONS.SET_STAGE, payload: id });
          },
          onModelFallback: setModelFallback,
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
        setModelFallback(null);
      }
    },
    [canRun, dispatch, jdText, jdUrl, navigate, provider, resumeFileName, resumeText]
  );

  const noProviders = availableProviders.length === 0;
  const pasteRef = useRef(null);
  const missing = [resumeText.trim() === '' && 'your resume', jdText.trim() === '' && 'the job description'].filter(Boolean);

  if (running) {
    return (
      <section className="page input-page">
        <ProgressWorkspace
          current={stage}
          provider={provider}
          note={modelFallback?.stage === stage ? describeModelFallback(modelFallback) : null}
          onCancel={() => abortRef.current?.abort()}
        />
      </section>
    );
  }

  return (
    <section className="page input-page">
      <PageHeader eyebrow="Step 1 of 4" title="Add your resume and the job">
        Everything is processed in your browser. Your resume is only ever sent to the AI provider you pick below,
        using your own key.
      </PageHeader>

      <form onSubmit={handleRun}>
        {error && <ErrorNotice error={error} onDismiss={() => dispatch({ type: ACTIONS.SET_ERROR, payload: null })} />}

        <div className="workspace workspace--split">
          {/* ------------------------------------------------------------- */}
          <fieldset className="card input-panel" disabled={running}>
            <legend>
              <PanelTitle icon="file" title="Your resume" />
            </legend>
            <p className="input-panel__intro">Upload the PDF you would send, or paste the text.</p>

            <div className="tabs" role="tablist" aria-label="Resume input method">
              <TabButton active={resumeMode === 'upload'} onClick={() => setResumeMode('upload')}>
                Upload a PDF
              </TabButton>
              <TabButton active={resumeMode === 'paste'} onClick={() => setResumeMode('paste')}>
                {resumeFileName ? 'Extracted text' : 'Paste text'}
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
                <span className="dropzone__icon">
                  <Icon name="upload" size={22} />
                </span>
                <p className="dropzone__title">{pdfBusy ? 'Reading your PDF…' : 'Drop your resume PDF here'}</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  id="resume-file"
                  onChange={(e) => handleFile(e.target.files?.[0])}
                  hidden
                />
                <label htmlFor="resume-file" className="button">
                  {pdfBusy ? 'Reading…' : 'Choose a PDF'}
                </label>
                <p className="muted">
                  PDF up to {formatBytes(MAX_FILE_SIZE)} &middot; read in your browser, never uploaded
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

            {pdfNotice?.tone === 'error' && (
              <ErrorNotice compact error={{ message: pdfNotice.message, kind: 'pdf' }} />
            )}

            {resumeMode === 'paste' && (
              <>
                {resumeFileName && (
                  <div className="file-card">
                    <span className="file-card__icon">
                      <Icon name="file" size={18} />
                    </span>
                    <span className="file-card__main">
                      <span className="file-card__name">{resumeFileName}</span>
                      <span className="file-card__meta">
                        {pdfInfo
                          ? `${pdfInfo.pageCount} page${pdfInfo.pageCount === 1 ? '' : 's'} · ${pdfInfo.charCount.toLocaleString()} characters extracted`
                          : 'Text extracted from this file'}
                      </span>
                    </span>
                    {pdfInfo?.isLikelyScanned ? (
                      <span className="badge badge--warning">Looks scanned</span>
                    ) : (
                      <span className="badge badge--success">Extracted</span>
                    )}
                    <button type="button" className="button button--sm button--ghost" onClick={() => setResumeMode('upload')}>
                      Replace
                    </button>
                  </div>
                )}
                {pdfNotice?.tone === 'warn' && <Notice tone="warn">{pdfNotice.message}</Notice>}

                <label htmlFor="resume-text" className="field-label">
                  {resumeFileName ? 'Extracted text — check it before you run' : 'Resume text'}
                </label>
                <textarea
                  id="resume-text"
                  className="textarea--source"
                  value={resumeText}
                  onChange={(e) => setResumeText(e.target.value)}
                  rows={16}
                  placeholder="Paste your full resume here, including contact details, experience bullets, skills and education."
                  spellCheck={false}
                />
                <p className="text-meta">
                  <span>Fix any mangled columns here. What you see is exactly what gets parsed.</span>
                  <span>{resumeText.trim() ? `${resumeText.length.toLocaleString()} characters` : 'Empty'}</span>
                </p>
              </>
            )}
          </fieldset>

          {/* ------------------------------------------------------------- */}
          <fieldset className="card input-panel" disabled={running}>
            <legend>
              <PanelTitle icon="briefcase" title="The job description" />
            </legend>
            <p className="input-panel__intro">Paste the posting, or fetch it from its URL and check what came back.</p>

            <label htmlFor="jd-url" className="field-label">
              Job posting URL <span className="muted">(optional)</span>
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
                <Icon name="link" size={15} />
                {urlBusy ? 'Fetching…' : 'Fetch'}
              </button>
            </div>
            <p className="field-hint">
              Fetching goes through public proxies and fails on some boards. LinkedIn, Indeed and Glassdoor block it
              outright.
            </p>

            {urlNotice &&
              (urlNotice.tone === 'error' ? (
                <ErrorNotice compact error={{ message: urlNotice.message, hint: urlNotice.hint, kind: 'scrape' }}>
                  <button type="button" className="button button--sm" onClick={() => pasteRef.current?.focus()}>
                    Paste job description
                  </button>
                </ErrorNotice>
              ) : (
                <Notice tone={urlNotice.tone}>{urlNotice.message}</Notice>
              ))}

            <label htmlFor="jd-text" className="field-label">
              Job description text
            </label>
            <textarea
              ref={pasteRef}
              id="jd-text"
              className="textarea--source"
              value={jdText}
              onChange={(e) => setJdText(e.target.value)}
              rows={14}
              placeholder="Paste the job description here: responsibilities, requirements, and nice-to-haves."
              spellCheck={false}
            />
            <p className="text-meta">
              <span className="paste-callout">
                <Icon name="checkCircle" size={14} />
                Pasting always works, on every job board.
              </span>
              <span>{jdText.trim() ? `${jdText.length.toLocaleString()} characters` : 'Empty'}</span>
            </p>
          </fieldset>
        </div>

        {/* A new run clears tailoring (CLEAR_ANALYSIS), hand edits included.
            Said up front, next to the button that does it. */}
        {state.tailoredResume && describeManualEdits(state.tailorManualEdits).length > 0 && (
          <div className="notice notice--warn" role="status" style={{ marginTop: 'var(--space-6)' }}>
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

        {/* ------------------------------------------------------------- */}
        <div className="run-bar">
          {noProviders ? (
            <p className="run-bar__none" role="status">
              <Icon name="alert" size={16} />
              <span>
                No AI provider is set up yet. A2Resume uses your own key, stored only in this browser.{' '}
                <Link to="/settings">Add a key in Settings</Link>.
              </span>
            </p>
          ) : (
            <div className="run-bar__provider">
              <label htmlFor="provider" className="field-label">
                AI provider
              </label>
              <select id="provider" value={provider ?? ''} onChange={(e) => setProvider(e.target.value)}>
                {availableProviders.map((id) => (
                  <option key={id} value={id}>
                    {PROVIDER_LABELS[id] ?? id}
                  </option>
                ))}
              </select>
              <Link to="/settings">Manage providers</Link>
            </div>
          )}

          <div className="run-bar__go">
            {!canRun && !noProviders && missing.length > 0 && (
              <span className="run-bar__missing">Add {missing.join(' and ')} to continue.</span>
            )}
            <button type="submit" className="button button--primary button--lg" disabled={!canRun}>
              Analyze my resume
              <Icon name="arrowRight" size={18} />
            </button>
          </div>
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

function PanelTitle({ icon, title }) {
  return (
    <span className="panel-title">
      <span className="panel-title__icon">
        <Icon name={icon} size={17} />
      </span>
      {title}
    </span>
  );
}

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

// What each stage is doing, in words, and where it runs. The two AI calls are
// slow and the two local steps are instant -- saying which is which is what
// makes a long pause on step 1 read as work rather than a hang.
const STAGE_COPY = {
  parseResume: { icon: 'file', working: 'Reading your resume…', ai: true },
  parseJD: { icon: 'briefcase', working: 'Understanding the role…', ai: true },
  gapAnalysis: { icon: 'compare', working: 'Comparing your experience…', ai: false },
  atsScore: { icon: 'gauge', working: 'Calculating your score…', ai: false },
};

/**
 * The page while the pipeline runs: one row per stage rather than one
 * spinner. The two AI calls are slow and the two local steps are instant, so
 * a single spinner would sit still for most of the run and tell the user
 * nothing about where it is.
 *
 * `note` appears on the active row when the provider's fallback chain has
 * moved on to another model. Same list, same row -- a different kind of
 * waiting, not a different stage, and a long pause during a real overload
 * should say why rather than look frozen. It never names a model id.
 */
function ProgressWorkspace({ current, provider, note, onCancel }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const providerName = PROVIDER_LABELS[provider] ?? provider ?? 'your provider';
  const currentIndex = PIPELINE_STAGES.findIndex((s) => s.id === current);

  return (
    <section className="progress-workspace" aria-labelledby="progress-title">
      <div className="progress-workspace__head">
        <p className="eyebrow">Step 1 of 4 · Running</p>
        <h2 id="progress-title">Analyzing your resume</h2>
        <p>
          Two steps are read by {providerName} and usually take 10 to 60 seconds each. The other two run instantly in
          your browser.
        </p>
      </div>

      <ol className="stages" aria-live="polite">
        {PIPELINE_STAGES.map((s, i) => {
          const copy = STAGE_COPY[s.id] ?? { icon: 'clock', working: 'Working…', ai: false };
          const stateName =
            currentIndex === -1 ? 'pending' : i < currentIndex ? 'done' : i === currentIndex ? 'active' : 'pending';
          return (
            <li key={s.id} className={`stage stage--${stateName}`}>
              <span className="stage__marker" aria-hidden="true">
                <Icon name={stateName === 'done' ? 'check' : copy.icon} size={stateName === 'done' ? 16 : 17} />
              </span>
              <span className="stage__text">
                <span className="stage__label">{s.label}</span>
                <span className="stage__detail">
                  {stateName === 'active' ? copy.working : copy.ai ? `With ${providerName}` : 'In your browser'}
                </span>
                {stateName === 'active' && note && <span className="stage__note">{note}</span>}
              </span>
              <span className="stage__status">
                {stateName === 'done' ? 'Done' : stateName === 'active' ? 'In progress' : 'Waiting'}
              </span>
              {stateName === 'active' && <span className="progress-bar stage__bar" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>

      <div className="progress-workspace__foot">
        <span role="timer" aria-live="off">
          {elapsed}s elapsed. You will land on the results when it finishes.
        </span>
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
