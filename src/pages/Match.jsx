import { useMemo, useState } from 'react';
import { Link } from 'react-router';

import { ACTIONS, useApp } from '../context/AppContext.jsx';
import { getApiKey, getKeyPresence } from '../services/apiKeyService.js';
import { PROVIDER_LABELS } from '../services/aiService.js';
import { selectCurrentResume } from '../services/currentResume.js';
import { fetchJobDescriptionFromUrl } from '../services/jdScraper.js';
import {
  MAX_POSTINGS,
  createPosting,
  describePosting,
  isMatchStale,
  isRunnablePosting,
  rankMatchResults,
  runMatchBatch,
  topMissingKeywords,
} from '../services/matchRunner.js';
import { describeError } from '../utils/errorMessages.js';
import KeywordCoverage from '../components/analysis/KeywordCoverage.jsx';

/**
 * Match: one resume against several postings, ranked.
 *
 * Reads the CURRENT resume through `selectCurrentResume`, the same selector
 * Export and Cover Letter use -- the tailored copy when a pass exists, the
 * original parse otherwise. Nothing here writes to the resume.
 *
 * No route guard, like every other page. Loaded cold with no resume it still
 * lets postings be added and says what is missing, because pasting eight job
 * descriptions is real work that should not require the pipeline to have run
 * first. Only the Run button needs a resume.
 *
 * THE COST WARNING IS THE POINT OF THE RUN CARD
 * Every posting is a separate provider call on the user's own key. The button
 * says how many calls it is about to make, in those words, and the count is
 * derived from the runnable postings rather than written as a fixed sentence, so
 * it cannot drift from what actually happens. Same spirit as Tailor's re-run
 * warning: state the cost before the click, not after.
 *
 * PROGRESS IS PER POSTING, NOT ONE SPINNER
 * A batch of eight is minutes of wall time and a single spinner would sit still
 * for most of it. Each row shows its own state as the loop reaches it, driven by
 * `runMatchBatch`'s `onProgress`.
 */

const asArray = (v) => (Array.isArray(v) ? v : []);

function safePresence() {
  try {
    return getKeyPresence();
  } catch {
    return {};
  }
}

export default function Match() {
  const { state, dispatch } = useApp();
  const { raw: resume, source: resumeSource } = selectCurrentResume(state);

  const postings = asArray(state.matchPostings);
  const batch = state.matchResults && typeof state.matchResults === 'object' ? state.matchResults : null;
  const results = useMemo(() => rankMatchResults(batch?.results), [batch]);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null); // { id, index, total, phase }
  const [runError, setRunError] = useState(null);
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlNotice, setUrlNotice] = useState(null);
  const [url, setUrl] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [pasteLabel, setPasteLabel] = useState('');
  const [confirmingClear, setConfirmingClear] = useState(false);

  const provider = state.settings?.provider ?? state.sources?.provider ?? null;
  const hasKey = provider ? Boolean(safePresence()[provider]) : false;

  const runnable = postings.filter(isRunnablePosting);
  const full = postings.length >= MAX_POSTINGS;
  const stale = isMatchStale(batch, resume);

  // Plain functions, not useCallback. They are event handlers on buttons, so
  // there is nothing downstream to memoize for, and the React Compiler rejects
  // hand-written dep arrays that omit the setState functions it infers. Same
  // choice as CoverLetter.jsx for the same reason.
  function setPostings(next) {
    dispatch({ type: ACTIONS.SET_MATCH_POSTINGS, payload: next.length > 0 ? next : null });
  }

  function addPosting(input) {
    if (postings.length >= MAX_POSTINGS) return false;
    setPostings([...postings, createPosting(input)]);
    return true;
  }

  // --- adding by paste -------------------------------------------------------
  function addPaste() {
    if (!pasteText.trim()) return;
    if (addPosting({ text: pasteText, label: pasteLabel, source: 'paste' })) {
      setPasteText('');
      setPasteLabel('');
    }
  }

  // --- adding by URL ---------------------------------------------------------
  // The same scraper, the same notice shape and the same "pasting always works"
  // messaging InputPage uses. Fetching is not a second implementation here: on
  // success the text lands in the paste box so the user reviews it before it
  // becomes a posting, because a reader picks up navigation and boilerplate
  // along with the posting and only the user can tell.
  async function fetchUrl() {
    if (!url.trim()) return;
    setUrlBusy(true);
    setUrlNotice(null);
    try {
      const result = await fetchJobDescriptionFromUrl(url);
      setPasteText(result.text);
      setUrlNotice({
        tone: 'ok',
        message: `Fetched ${result.charCount.toLocaleString()} characters via ${result.proxy}. Check it below, then add it -- readers pick up navigation and boilerplate as well as the posting.`,
        keepUrl: url.trim(),
      });
    } catch (err) {
      // Straight through describeError, so a ScrapeError's own message and hint
      // are shown verbatim -- including all_proxies_failed's "paste it in
      // instead", which is the reliable path and the reason the textarea below
      // is always visible.
      const described = describeError(err);
      setUrlNotice({ tone: 'error', message: described.message, hint: described.hint });
    } finally {
      setUrlBusy(false);
    }
  }

  function addFetched() {
    if (!pasteText.trim()) return;
    const keptUrl = urlNotice?.keepUrl ?? '';
    if (addPosting({ text: pasteText, label: pasteLabel, url: keptUrl, source: keptUrl ? 'url' : 'paste' })) {
      setPasteText('');
      setPasteLabel('');
      setUrl('');
      setUrlNotice(null);
    }
  }

  function removePosting(id) {
    setPostings(postings.filter((p) => p.id !== id));
  }

  function relabel(id, label) {
    setPostings(postings.map((p) => (p.id === id ? { ...p, label } : p)));
  }

  // --- the run ---------------------------------------------------------------
  async function run() {
    setRunning(true);
    setRunError(null);
    setProgress({ phase: 'start', index: 0, total: runnable.length });
    try {
      const apiKey = getApiKey(provider);
      if (!apiKey) {
        setRunError({ message: `No API key stored for ${PROVIDER_LABELS[provider] ?? provider}.`, isAuth: true });
        return;
      }
      const result = await runMatchBatch({
        postings: runnable,
        resume,
        provider,
        apiKey,
        onProgress: (event) => setProgress(event),
      });
      dispatch({ type: ACTIONS.SET_MATCH_RESULTS, payload: result });
      if (result.aborted) {
        setRunError({
          message: `Stopped after ${result.completed + result.failed} of ${runnable.length}. The provider rejected the key, so the remaining postings would have failed the same way.`,
          isAuth: true,
        });
      }
    } catch (err) {
      setRunError(describeError(err, { provider }));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  const statusOf = (posting) => {
    if (!running || !progress) return null;
    const at = runnable.findIndex((p) => p.id === posting.id);
    if (at === -1) return null;
    if (progress.id === posting.id) return progress.phase === 'start' ? 'running' : progress.phase;
    return at < (progress.index ?? 0) ? 'done' : 'pending';
  };

  return (
    <section className="page match">
      <header className="match__head">
        <h1>Match against several jobs</h1>
        <p className="muted">
          Scores your resume against each posting you add and ranks them, using the same scoring as step 2. Nothing
          here changes your resume.
        </p>
      </header>

      {!resume ? (
        <div className="notice notice--info" role="status">
          <p>
            You can add postings now, but scoring them needs a resume. <Link to="/input">Run step 1</Link> and come
            back &mdash; anything you add here is kept.
          </p>
        </div>
      ) : (
        <div className={`notice ${resumeSource === 'tailored' ? 'notice--ok' : 'notice--info'}`} role="status">
          <p>
            {resumeSource === 'tailored'
              ? 'Matching with your tailored resume from step 3, hand edits included.'
              : 'Matching with your resume as it was read in step 1. You have not run the tailoring pass.'}
          </p>
        </div>
      )}

      {stale === true && <StaleBanner count={results.length} onRerun={run} running={running} canRun={Boolean(resume) && hasKey} />}

      {/* ---------------------------------------------------------------- */}
      <section className="card">
        <h2>Job postings</h2>
        <p className="muted">
          Up to {MAX_POSTINGS}. Each one is a separate, paid AI call when you run the match &mdash; they are parsed
          one at a time on your own API key, so a batch of {MAX_POSTINGS} is {MAX_POSTINGS} calls, not one.
        </p>

        {postings.length > 0 && (
          <ul className="match__postings">
            {postings.map((posting, index) => {
              const status = statusOf(posting);
              return (
                <li key={posting.id} className="match__posting">
                  <div className="match__posting-main">
                    <label className="field-label" htmlFor={`match-label-${posting.id}`}>
                      Name for this posting <span className="muted">(optional)</span>
                    </label>
                    <input
                      id={`match-label-${posting.id}`}
                      type="text"
                      value={posting.label}
                      placeholder={describePosting({ ...posting, label: '' }, null, index)}
                      onChange={(e) => relabel(posting.id, e.target.value)}
                      disabled={running}
                    />
                    <p className="muted match__posting-meta">
                      {posting.source === 'url' ? 'Fetched' : 'Pasted'} &middot;{' '}
                      {posting.text.trim().length.toLocaleString()} characters
                      {posting.url && (
                        <>
                          {' '}
                          &middot;{' '}
                          <a href={posting.url} target="_blank" rel="noreferrer noopener">
                            source
                          </a>
                        </>
                      )}
                      {!isRunnablePosting(posting) && <strong> &middot; empty, it will be skipped</strong>}
                    </p>
                  </div>
                  <div className="match__posting-side">
                    {status && <span className={`match__status match__status--${status}`}>{STATUS_LABEL[status]}</span>}
                    <button
                      type="button"
                      className="button button--danger"
                      onClick={() => removePosting(posting.id)}
                      disabled={running}
                      aria-label={`Remove posting ${index + 1}`}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {full ? (
          <p className="inline-status inline-status--warn" role="status">
            That is {MAX_POSTINGS} postings, the most one batch holds. Remove one to add another.
          </p>
        ) : (
          <fieldset className="match__add" disabled={running}>
            <legend className="field-label">Add a posting</legend>

            <label className="field-label" htmlFor="match-url">
              Fetch from a URL <span className="muted">(optional)</span>
            </label>
            <div className="row">
              <input
                id="match-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://jobs.example.com/postings/12345"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    fetchUrl();
                  }
                }}
              />
              <button type="button" onClick={fetchUrl} disabled={urlBusy || !url.trim()}>
                {urlBusy ? 'Fetching...' : 'Fetch'}
              </button>
            </div>
            <p className="muted">
              Fetching goes through public proxies and fails on some boards &mdash; LinkedIn, Indeed and Glassdoor
              block it outright. Pasting the text always works.
            </p>

            {urlNotice && (
              <p
                className={`inline-status inline-status--${urlNotice.tone === 'ok' ? 'ok' : 'error'}`}
                role="status"
              >
                {urlNotice.message}
                {urlNotice.hint && <> {urlNotice.hint}</>}
              </p>
            )}

            <label className="field-label" htmlFor="match-paste-label">
              Name for this posting <span className="muted">(optional)</span>
            </label>
            <input
              id="match-paste-label"
              type="text"
              value={pasteLabel}
              onChange={(e) => setPasteLabel(e.target.value)}
              placeholder="Leave blank to use the job title once it is parsed"
            />

            <label className="field-label" htmlFor="match-paste">
              Job description text
            </label>
            <textarea
              id="match-paste"
              rows={8}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="Paste the posting here, or fetch it above and check what came back."
            />
            <p className="actions">
              <button
                type="button"
                className="button button--primary"
                onClick={urlNotice?.keepUrl ? addFetched : addPaste}
                disabled={!pasteText.trim()}
              >
                Add posting{postings.length > 0 ? ` (${postings.length + 1} of ${MAX_POSTINGS})` : ''}
              </button>
            </p>
          </fieldset>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="card">
        <h2>{batch ? 'Run it again' : 'Run the match'}</h2>

        {runnable.length === 0 ? (
          <p className="muted">Add at least one posting with some text.</p>
        ) : (
          <>
            {/* THE COST IS STATED WHENEVER THERE IS A BATCH TO PRICE, not only
                when it can be run. Found in browser testing: with no key stored
                this whole block was replaced by "add a key in Settings", so the
                one place that names the actual number of calls disappeared for
                exactly the user who has not committed to paying for any yet.
                Someone deciding whether to add a key should be able to see what
                a run would cost. The blockers below are additional, not a
                substitute. */}
            <div className="notice notice--warn" role="status">
              <p>
                <strong>
                  This makes {runnable.length} separate AI call{runnable.length === 1 ? '' : 's'} on your own API key
                  {provider ? ` (${PROVIDER_LABELS[provider] ?? provider})` : ''}.
                </strong>{' '}
                One per posting, run one at a time, each billed to you. Scoring itself is free and local &mdash; only
                reading the postings costs anything.
              </p>
              {batch && (
                <p className="muted">
                  This replaces the {results.length} result{results.length === 1 ? '' : 's'} below and pays for every
                  posting again, including the ones that already scored.
                </p>
              )}
            </div>

            {!resume ? (
              <p className="inline-status inline-status--error">
                Scoring needs a resume. <Link to="/input">Run step 1</Link> first.
              </p>
            ) : !provider || !hasKey ? (
              <p className="inline-status inline-status--error">
                This needs an AI provider. <Link to="/settings">Add a key in Settings</Link>.
              </p>
            ) : (
              <p className="actions">
                <button type="button" className="button button--primary" onClick={run} disabled={running}>
                  {running
                    ? `Reading posting ${Math.min((progress?.index ?? 0) + 1, runnable.length)} of ${runnable.length}...`
                    : `Match ${runnable.length} posting${runnable.length === 1 ? '' : 's'}`}
                </button>
              </p>
            )}
          </>
        )}

        {runError && (
          <p className="inline-status inline-status--error" role="alert">
            {runError.message} {runError.isAuth && <Link to="/settings">Open Settings</Link>}
          </p>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {batch && results.length > 0 && (
        <section className="card">
          <div className="match__results-head">
            <h2>
              Ranked results <span className="muted">({results.length})</span>
            </h2>
            {confirmingClear ? (
              <span className="match__confirm">
                <span>Clear all {results.length} results? Your postings are kept.</span>
                <button
                  type="button"
                  className="button button--danger"
                  onClick={() => {
                    dispatch({ type: ACTIONS.CLEAR_MATCH_RESULTS });
                    setConfirmingClear(false);
                  }}
                >
                  Yes, clear them
                </button>
                <button type="button" className="button" onClick={() => setConfirmingClear(false)}>
                  Keep them
                </button>
              </span>
            ) : (
              <button type="button" className="button" onClick={() => setConfirmingClear(true)} disabled={running}>
                Clear all results
              </button>
            )}
          </div>

          <p className="muted">
            Highest first, ranked by percentage rather than raw points &mdash; a posting whose resume could not be
            measured on every criterion is scored out of less than 100, so the percentages are what compare fairly.
            Read with {batch.provider ? `${PROVIDER_LABELS[batch.provider] ?? batch.provider}, ` : ''}
            {new Date(batch.ranAt).toLocaleString()}.
            {batch.failed > 0 && ` ${batch.failed} posting${batch.failed === 1 ? '' : 's'} could not be read.`}
          </p>

          <ol className="match__results">
            {results.map((row, rank) => (
              <MatchRow
                key={row.id}
                row={row}
                rank={rank}
                onRemove={() => dispatch({ type: ACTIONS.REMOVE_MATCH_RESULT, payload: { id: row.id } })}
                disabled={running}
              />
            ))}
          </ol>
        </section>
      )}
    </section>
  );
}

const STATUS_LABEL = { pending: 'Waiting', running: 'Reading...', done: 'Done', failed: 'Failed' };

const band = (pct) => (pct >= 75 ? 'good' : pct >= 45 ? 'mid' : 'poor');

/**
 * One result. Collapsed it is the ranking line; expanded it is the same
 * matched / partial / missing breakdown Analyze renders, from the same
 * component -- see KeywordCoverage for why that is shared rather than copied.
 */
function MatchRow({ row, rank, onRemove, disabled }) {
  const [open, setOpen] = useState(false);
  const failed = row.error !== null && row.error !== undefined;
  const score = row.score;
  const topMissing = topMissingKeywords(row.gap, 3);

  return (
    <li className={`match__row${failed ? ' match__row--failed' : ''}`}>
      <div className="match__row-head">
        <span className="match__rank">{failed ? '—' : rank + 1}</span>

        <div className="match__row-main">
          <h3 className="match__row-title">{row.label}</h3>
          <p className="muted match__row-meta">
            {[row.jd?.company, row.jd?.location, row.jd?.seniority].filter(Boolean).join(' · ') ||
              (failed ? 'Not read' : 'No company given in the posting')}
            {row.url && (
              <>
                {' '}
                &middot;{' '}
                <a href={row.url} target="_blank" rel="noreferrer noopener">
                  source
                </a>
              </>
            )}
          </p>

          {failed ? (
            <p className="inline-status inline-status--error">
              {row.error?.message ?? 'This posting could not be read.'}
            </p>
          ) : (
            <p className="match__row-missing">
              {topMissing.length === 0 ? (
                <span className="muted">Nothing high-priority missing.</span>
              ) : (
                <>
                  <span className="muted">Top missing: </span>
                  {topMissing.map((k) => (
                    <span key={k.keyword} className={`chip chip--poor chip--static chip--${k.priority}`}>
                      {k.keyword}
                    </span>
                  ))}
                </>
              )}
            </p>
          )}
        </div>

        {!failed && score && (
          <div className={`match__score match__score--${band(score.percentage)}`}>
            <strong className="match__score-grade">{score.grade}</strong>
            <span className="match__score-pct">{score.percentage}%</span>
            <span className="muted match__score-total">
              {score.total} / {score.scoreableMax}
              {score.isFallback && <> &middot; partial</>}
            </span>
          </div>
        )}

        <div className="match__row-side">
          {!failed && (
            <button type="button" className="button" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? 'Hide detail' : 'Detail'}
            </button>
          )}
          <button
            type="button"
            className="button button--danger"
            onClick={onRemove}
            disabled={disabled}
            aria-label={`Remove result for ${row.label}`}
          >
            Remove
          </button>
        </div>
      </div>

      {open && !failed && (
        <div className="match__row-detail">
          {score?.isFallback && (
            <p className="notice notice--warn">
              <strong>Treat this score with caution.</strong>{' '}
              {asArray(score.fallbackReasons).join(' ') || 'Some criteria could not be measured.'} It is out of{' '}
              {score.scoreableMax}, not 100.
            </p>
          )}
          {row.gap ? (
            // The same component Analyze uses. `idPrefix` keeps several of these
            // on one page from expanding each other's chips.
            <KeywordCoverage gap={row.gap} title={null} idPrefix={`${row.id}-`} />
          ) : (
            <p className="muted">No keyword breakdown was stored for this posting.</p>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The resume changed after the batch ran.
 *
 * ONE BANNER FOR THE WHOLE BATCH, NOT A FLAG ON EVERY ROW. Every row was scored
 * against the same resume in the same run, so there is no state in which some
 * rows are stale and others are not -- see `isMatchStale`. Marking rows
 * individually would imply a partial staleness that cannot happen, and would
 * put the same sentence on screen ten times.
 *
 * It never acts on its own: re-running is N paid calls, so it says how many and
 * waits, the same register as Tailor's discard confirmation and the cover
 * letter's staleness notice.
 */
function StaleBanner({ count, onRerun, running, canRun }) {
  return (
    <div className="notice notice--warn" role="alert">
      <p>
        <strong>Your resume has changed since these results were scored.</strong> All {count} of them describe the
        older version, not the resume you have now.
      </p>
      <p className="muted">
        Nothing has been changed or thrown away, and the scores below are exactly what was computed at the time.
        Re-running reads every posting again, which is one paid AI call per posting on your own key, so it is your
        choice.
      </p>
      {/* The guidance is unconditional; only the button is gated. Found in
          browser testing: with no key stored the whole actions block vanished,
          which took "or leave them as a snapshot" with it -- so the user was
          told their results were stale and given no statement that keeping them
          is a legitimate option. The advice applies whether or not a run is
          currently possible. */}
      <p className="actions">
        {canRun && (
          <button type="button" className="button button--primary" onClick={onRerun} disabled={running}>
            {running ? 'Re-running...' : 'Score them against the current resume'}
          </button>
        )}
        <span className="muted">Or leave them and read them as a snapshot of that moment.</span>
      </p>
    </div>
  );
}
