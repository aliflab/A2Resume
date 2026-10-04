import { Component, Suspense, lazy, useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { ACTIONS, useApp } from '../context/AppContext.jsx';
import { getApiKey, getKeyPresence } from '../services/apiKeyService.js';
import { PROVIDER_LABELS } from '../services/aiService.js';
import { selectCurrentResume } from '../services/currentResume.js';
import { describeError } from '../utils/errorMessages.js';
import {
  DEFAULT_LENGTH,
  DEFAULT_TONE,
  LENGTHS,
  TONES,
  buildCoverLetterSlice,
  generateCoverLetter,
  getLength,
  getTone,
  isCoverLetterStale,
} from '../services/coverLetterGenerator.js';
import {
  buildCoverLetterFileName,
  generateCoverLetterPlainText,
  hasExportableLetter,
  normalizeCoverLetterForExport,
} from '../services/coverLetterExport.js';
import { findUnsupportedPdfCharacters } from '../services/resumeExport.js';
import { describeGroundingWarning, fabricationWarnings } from '../utils/coverLetterGrounding.js';
import Icon from '../components/Icon.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';
import ErrorNotice from '../components/ui/ErrorNotice.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';
import PreviewSkeleton from '../components/ui/PreviewSkeleton.jsx';
import ScoreRing from '../components/ui/ScoreRing.jsx';
import Spinner from '../components/ui/Spinner.jsx';
import WorkingLine from '../components/ui/WorkingLine.jsx';
import { gradeTone, gradeVerdict } from '../components/ui/scoreBands.js';

/**
 * Cover letter drafting.
 *
 * Reads the CURRENT resume through `selectCurrentResume` -- the tailored copy
 * when a pass exists, the original parse otherwise -- so this page never decides
 * for itself which resume is real, and never assumes Tailor was run. Like every
 * other page there is no route guard: loaded cold it shows an empty state
 * pointing at step 1.
 *
 * EDITING IS ONE PLAIN-TEXT TEXTAREA, COMMITTED BY AN EXPLICIT SAVE
 * Block-based editing like Tailor's is a later follow-up, not this. The commit
 * gesture is a Save button rather than a blur, and that is a deliberate choice:
 * a blur commit fires on every accidental focus change, and each commit here
 * re-runs the grounding check and writes the session, so blur would mean a
 * storage write and a banner recompute every time the user tabbed away. Save is
 * also the gesture the tailoring editor already established, so the two surfaces
 * behave the same way. There is no draft autosave on this page yet -- that is
 * `draftEdits`' job on Tailor and it is not wired here -- so the editor says
 * outright that unsaved typing is lost on reload.
 *
 * THE TEXTAREA IS KEYED ON `generatedAt`, NOT SYNCED BY AN EFFECT
 * A new letter has to replace whatever is in the box, and an effect calling
 * setDraft would be exactly the cascading-render pattern oxlint's
 * `react/set-state-in-effect` catches -- and the same bug shape as InputPage's
 * derive-during-render rule and `<Outlet key={resetCount}>` in App.jsx.
 * Remounting on a new `generatedAt` reads the fresh body through the useState
 * initialiser instead. A Save deliberately preserves `generatedAt`, so saving
 * does not remount and does not move the cursor.
 *
 * THE GROUNDING CHECK RE-RUNS ON EVERY SAVE
 * It is pure and network-free, so it costs nothing, and it means a user who
 * edits a fabricated company out of the letter watches the banner clear. A user
 * who types one IN gets warned about their own text, which is correct.
 *
 * STALENESS IS NEVER RESOLVED SILENTLY
 * Regenerating is a real paid AI call, so nothing here auto-discards or
 * auto-regenerates. A letter whose resume fingerprint no longer matches gets a
 * notice and an explicit choice.
 */

const PdfPreview = lazy(() => import('../components/export/PdfPreview.jsx'));

function safePresence() {
  try {
    return getKeyPresence();
  } catch {
    return {};
  }
}

export default function CoverLetter() {
  const { state, dispatch } = useApp();
  const { raw: resume, source } = selectCurrentResume(state);
  const parsedJD = state.parsedJD ?? null;
  const letter = state.coverLetter && typeof state.coverLetter === 'object' ? state.coverLetter : null;

  const [tone, setTone] = useState(getTone(letter?.tone ?? DEFAULT_TONE).id);
  const [length, setLength] = useState(getLength(letter?.length ?? DEFAULT_LENGTH).id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copyStatus, setCopyStatus] = useState(null);

  const provider = state.settings?.provider ?? state.sources?.provider ?? null;
  const hasKey = provider ? Boolean(safePresence()[provider]) : false;
  const stale = isCoverLetterStale(letter, resume, parsedJD);

  const normalised = useMemo(
    () => (letter ? normalizeCoverLetterForExport(letter, resume, parsedJD) : null),
    [letter, parsedJD, resume]
  );
  const plainText = normalised ? generateCoverLetterPlainText(normalised) : '';
  const fileName = normalised ? buildCoverLetterFileName(normalised) : '';
  // Shape-agnostic: it walks every string in whatever it is handed, so the
  // resume's own font check works unchanged on a letter.
  const unsupportedChars = normalised ? findUnsupportedPdfCharacters(normalised) : [];

  const fabrications = fabricationWarnings(letter?.grounding);
  const styleWarnings = (letter?.grounding?.warnings ?? []).filter((w) => w.kind === 'excluded-language');

  async function copy() {
    try {
      await navigator.clipboard.writeText(plainText);
      setCopyStatus({ ok: true, message: 'Copied. Paste it into the application.' });
    } catch {
      setCopyStatus({
        ok: false,
        message: 'Your browser blocked clipboard access. Select the text below and copy it yourself.',
      });
    }
  }

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const apiKey = getApiKey(provider);
      if (!apiKey) {
        setError({ message: `No API key stored for ${PROVIDER_LABELS[provider] ?? provider}.`, isAuth: true });
        return;
      }
      const result = await generateCoverLetter(resume, parsedJD, { tone, length, provider, apiKey });
      dispatch({ type: ACTIONS.SET_COVER_LETTER, payload: result });
    } catch (err) {
      setError(describeError(err, { provider }));
    } finally {
      setBusy(false);
    }
  }

  if (!resume || !parsedJD) {
    return (
      <EmptyState icon="mail" title="Nothing to write from yet" action={{ to: '/input', label: 'Add your resume' }}>
        A cover letter is written from your resume and the job posting, and checked against your resume afterwards.
        Add both on step 1 and run the analysis first, then come back here.
      </EmptyState>
    );
  }

  return (
    <section className="page page--wide cover-letter">
      <PageHeader eyebrow="Tools · Cover Letter" title="Cover letter">
        Written from your resume and this posting. It can only name employers, skills and achievements your resume
        actually contains &mdash; it is not allowed to invent one, and what it writes is checked against your resume
        afterwards.
      </PageHeader>

      <p className={`context-line${source === 'tailored' ? ' context-line--ok' : ''}`} role="status">
        <Icon name={source === 'tailored' ? 'checkCircle' : 'info'} size={16} />
        {source === 'tailored' ? (
          'Writing from your tailored resume from step 3.'
        ) : (
          <span>
            Writing from your resume as it was read in step 1. You haven&apos;t run the tailoring pass.{' '}
            <Link to="/tailor">Tailor it first</Link> for a letter that matches what you will send.
          </span>
        )}
      </p>

      <div className="workspace workspace--aside">
        <div className="stack">
          <section className="card">
            <h2>{letter ? 'Write it again' : 'Write the letter'}</h2>
            <p className="muted">Choose a tone and a length. You can edit every word afterwards.</p>

            <fieldset className="cover-letter__options" disabled={busy}>
              <legend className="field-label">Tone</legend>
              <div className="option-grid">
                {TONES.map((t) => (
                  <label key={t.id} className="cover-letter__option">
                    <input
                      type="radio"
                      name="cover-letter-tone"
                      value={t.id}
                      checked={tone === t.id}
                      onChange={() => setTone(t.id)}
                    />
                    <strong>{t.label}</strong>
                    <span className="muted">{t.hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="cover-letter__options" disabled={busy}>
              <legend className="field-label">Length</legend>
              <div className="option-grid">
                {LENGTHS.map((l) => (
                  <label key={l.id} className="cover-letter__option">
                    <input
                      type="radio"
                      name="cover-letter-length"
                      value={l.id}
                      checked={length === l.id}
                      onChange={() => setLength(l.id)}
                    />
                    <strong>{l.label}</strong>
                    <span className="muted">{l.hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {!provider || !hasKey ? (
              <p className="inline-status inline-status--error">
                This needs an AI provider. <Link to="/settings">Add a key in Settings</Link>.
              </p>
            ) : (
              <p className="actions">
                <button
                  type="button"
                  className="button button--primary button--lg"
                  onClick={generate}
                  disabled={busy}
                  aria-busy={busy || undefined}
                >
                  {busy && <Spinner />}
                  {busy ? 'Writing your letter...' : letter ? 'Write a new letter' : 'Write my cover letter'}
                </button>
                {letter && <span className="muted">This replaces the letter below, including any edits you made.</span>}
              </p>
            )}

            {busy && (
              <WorkingLine
                label={`Writing from your resume with ${PROVIDER_LABELS[provider] ?? provider}…`}
                detail="Then every company and tool it names is checked against your resume."
              />
            )}

            {error && <ErrorNotice compact error={error} onRetry={hasKey ? generate : undefined} />}
          </section>

          {!letter && busy && <LetterSkeleton />}

          {letter && (
            <div className={busy ? 'stack is-busy' : 'stack'} aria-busy={busy || undefined}>
              {stale === true && <StaleNotice onRegenerate={generate} busy={busy} />}

              {fabrications.length > 0 ? (
                <div className="notice notice--warn cover-letter__grounding" role="alert">
                  <p>
                    <strong>
                      {fabrications.length === 1
                        ? 'One thing in this letter is not in your resume.'
                        : `${fabrications.length} things in this letter are not in your resume.`}
                    </strong>{' '}
                    Check each one before you send it. These may be invented.
                  </p>
                  <ul>
                    {fabrications.map((w) => (
                      <li key={`${w.kind}:${w.term}`}>{describeGroundingWarning(w)}</li>
                    ))}
                  </ul>
                  <p className="muted">
                    This check looks at named things and known tool names. It cannot catch an invented number or a
                    fabricated claim written in ordinary words, so read the letter as well.
                  </p>
                </div>
              ) : (
                letter.grounding?.checkable === true && (
                  <div className="notice notice--ok cover-letter__grounding" role="status">
                    <p>
                      <strong>Nothing unsupported found.</strong> Every company and tool the letter names appears in
                      your resume ({letter.grounding.checkedNames} named{' '}
                      {letter.grounding.checkedNames === 1 ? 'thing' : 'things'}, {letter.grounding.checkedSkills}{' '}
                      {letter.grounding.checkedSkills === 1 ? 'tool' : 'tools'} checked).
                    </p>
                    <p className="muted">
                      That is a term check, not a fact check. It cannot see an invented number, a claim written in
                      ordinary words, or a true tool used to describe work you did not do. Read it before you send it.
                    </p>
                  </div>
                )
              )}

              {styleWarnings.length > 0 && (
                <div className="notice notice--info cover-letter__grounding" role="status">
                  <p>
                    <strong>The letter uses some of the posting&apos;s own language.</strong> These say nothing about
                    you and are worth replacing with something specific:
                  </p>
                  <ul>
                    {styleWarnings.map((w) => (
                      <li key={`${w.kind}:${w.term}`}>{describeGroundingWarning(w)}</li>
                    ))}
                  </ul>
                </div>
              )}

              {letter.lengthCheck && !letter.lengthCheck.ok && !letter.edited && (
                <div className="notice notice--info" role="status">
                  <p>
                    You asked for <strong>{getLength(letter.length).label.toLowerCase()}</strong> (
                    {getLength(letter.length).paragraphs} paragraphs, {getLength(letter.length).minWords}&ndash;
                    {getLength(letter.length).maxWords} words) and got {letter.lengthCheck.paragraphs}{' '}
                    {letter.lengthCheck.paragraphs === 1 ? 'paragraph' : 'paragraphs'} and {letter.lengthCheck.words}{' '}
                    words. Edit it below, or write it again.
                  </p>
                </div>
              )}

              {/* Keyed on the generation, not synced by an effect. See the note at
                  the top of this file. A Save keeps generatedAt, so it does not
                  remount and does not move the cursor. */}
              <LetterEditor key={letter.generatedAt ?? 'letter'} letter={letter} resume={resume} parsedJD={parsedJD} />

              {unsupportedChars.length > 0 && (
                <div className="notice notice--warn" role="status">
                  <p>
                    <strong>Some characters can&apos;t be shown in the PDF: </strong>
                    {unsupportedChars.map((char) => `"${char}"`).join(' ')}
                  </p>
                  <p>
                    The PDF uses a standard built-in font that only covers Western European characters, so these may
                    come out wrong or missing. Check the preview. The plain-text copy below is not affected.
                  </p>
                </div>
              )}

              {hasExportableLetter(normalised) && (
                <>
                  <section className="card">
                    <h2>PDF</h2>
                    <PdfErrorBoundary>
                      <Suspense fallback={<PreviewSkeleton />}>
                        <PdfPreview kind="coverLetter" data={normalised} fileName={fileName} />
                      </Suspense>
                    </PdfErrorBoundary>
                  </section>

                  <section className="card">
                    <h2>Plain text</h2>
                    <p className="muted">For an application form or an email body with no file upload.</p>
                    <p className="actions">
                      <button type="button" className="button" onClick={copy}>
                        <Icon name="copy" size={15} />
                        Copy as plain text
                      </button>
                    </p>
                    {copyStatus && (
                      <p
                        className={`inline-status ${copyStatus.ok ? 'inline-status--ok' : 'inline-status--error'}`}
                        role="status"
                      >
                        {copyStatus.message}
                      </p>
                    )}
                    <label className="field-label" htmlFor="cover-letter-plain-text">
                      Text that will be copied
                    </label>
                    <textarea id="cover-letter-plain-text" readOnly rows={12} value={plainText} />
                  </section>
                </>
              )}
            </div>
          )}
        </div>

        <aside className="aside" aria-label="About this job">
          <JobContext parsedJD={parsedJD} gap={state.gapAnalysis ?? state.atsScore?.gapAnalysis ?? null} score={state.atsScore} />
        </aside>
      </div>
    </section>
  );
}

/**
 * What the letter is being written for, beside the letter. Everything here is
 * read from the parsed posting and the existing analysis -- no extra call.
 */
function JobContext({ parsedJD, gap, score }) {
  const requirements = (Array.isArray(parsedJD?.requiredSkills) ? parsedJD.requiredSkills : []).slice(0, 5);
  const keywords = [
    ...asList(gap?.matched).map((k) => ({ ...k, tone: 'success', state: 'in your resume' })),
    ...asList(gap?.partial).map((k) => ({ ...k, tone: 'warning', state: 'partly in your resume' })),
    ...asList(gap?.missing).map((k) => ({ ...k, tone: 'danger', state: 'not in your resume' })),
  ]
    .filter((k) => k.priority === 'high')
    .slice(0, 10);

  return (
    <section className="card context-panel">
      <dl>
        <div>
          <dt>Role</dt>
          <dd>
            <strong>{parsedJD?.jobTitle || 'Untitled role'}</strong>
            {parsedJD?.company ? ` · ${parsedJD.company}` : ''}
          </dd>
        </div>
        {score && (
          <div>
            <dt>Your match</dt>
            <dd style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
              <ScoreRing percentage={score.percentage} size={40} tone={gradeTone(score)}>
                <strong style={{ fontSize: 'var(--text-xs)' }}>{score.grade}</strong>
              </ScoreRing>
              <span>
                {score.percentage}% &middot; {gradeVerdict(score)}
              </span>
            </dd>
          </div>
        )}
        {requirements.length > 0 && (
          <div>
            <dt>Key requirements</dt>
            <dd>
              <ul style={{ margin: 0, paddingLeft: 'var(--space-5)' }}>
                {requirements.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {keywords.length > 0 && (
          <div>
            <dt>High-priority keywords</dt>
            <dd className="pills" style={{ marginTop: 'var(--space-2)' }}>
              {keywords.map((k) => (
                <span key={k.keyword} className={`pill pill--${k.tone}`} title={`${k.keyword}: ${k.state}`}>
                  {k.keyword}
                  <span className="visually-hidden"> ({k.state})</span>
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

const asList = (v) => (Array.isArray(v) ? v : []);

/** The shape of a letter on its paper, while the first one is being written. Decorative. */
function LetterSkeleton() {
  return (
    <section className="card" aria-hidden="true">
      <span className="skeleton" style={{ width: '20%', marginBottom: 'var(--space-5)' }} />
      <div className="letter-sheet">
        <div className="letter-skeleton">
          <span className="skeleton skeleton--paper" />
          <span className="skeleton skeleton--paper" />
          <span className="skeleton skeleton--paper" />
          <span className="skeleton skeleton--paper skeleton--short" />
          <span className="skeleton skeleton--paper skeleton--gap" />
          <span className="skeleton skeleton--paper" />
          <span className="skeleton skeleton--paper skeleton--short" />
          <span className="skeleton skeleton--paper skeleton--gap" style={{ width: '25%' }} />
        </div>
      </div>
    </section>
  );
}

/**
 * The one editable surface: a plain-text textarea and an explicit Save.
 *
 * Its own component so the draft can live in a useState initialiser keyed on the
 * generation, rather than being pushed in by an effect. `letter.body` is read
 * once, on mount.
 */
function LetterEditor({ letter, resume, parsedJD }) {
  const { dispatch } = useApp();
  const [draft, setDraft] = useState(letter.body ?? '');
  const [saved, setSaved] = useState(false);

  const dirty = draft !== (letter.body ?? '');

  const save = useCallback(() => {
    // Rebuilt rather than patched, so the grounding report and the length check
    // describe what the letter now says. `edited: true` is what stops the page
    // claiming the model wrote this. `generatedAt` is deliberately carried over:
    // it is this editor's React key, and changing it would remount mid-save.
    dispatch({
      type: ACTIONS.UPDATE_COVER_LETTER,
      payload: buildCoverLetterSlice({
        ...letter,
        body: draft,
        resume,
        parsedJD,
        edited: true,
        generatedAt: letter.generatedAt,
      }),
    });
    setSaved(true);
  }, [dispatch, draft, letter, parsedJD, resume]);

  return (
    <section className="card">
      <div className="section-head">
        <div>
          <h2>The letter</h2>
          <p className="muted">
            {getTone(letter.tone).label} tone, {getLength(letter.length).label.toLowerCase()}
            {letter.edited ? ', edited by you' : ''}
            {letter.provider ? `, written by ${PROVIDER_LABELS[letter.provider] ?? letter.provider}` : ''}. It is
            yours to edit. Your name, contact details and the date are added around this text when it is exported.
          </p>
        </div>
        {letter.edited && <span className="badge badge--info">Edited</span>}
      </div>
      <label className="visually-hidden" htmlFor="cover-letter-body">
        Letter text
      </label>
      <div className="letter-sheet">
        <textarea
          id="cover-letter-body"
          rows={20}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setSaved(false);
          }}
        />
      </div>
      <p className="actions">
        <button type="button" className="button button--primary" onClick={save} disabled={!dirty}>
          Save changes
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            setDraft(letter.body ?? '');
            setSaved(false);
          }}
          disabled={!dirty}
        >
          Undo my edits
        </button>
        <button
          type="button"
          className="button button--danger"
          onClick={() => dispatch({ type: ACTIONS.CLEAR_COVER_LETTER })}
        >
          Delete this letter
        </button>
      </p>
      {dirty ? (
        <p className="inline-status inline-status--warn" role="status">
          Unsaved changes. Nothing is saved or exported until you press Save, and a reload loses them.
        </p>
      ) : (
        saved && (
          <p className="inline-status inline-status--ok" role="status">
            Saved. The export below and the check above both describe your edited version.
          </p>
        )
      )}
    </section>
  );
}

/**
 * The letter no longer matches the resume it was written from.
 *
 * Same register as Tailor's discard confirmation and the header's "Start over":
 * it states what happened, says plainly what it would cost, and never acts on
 * its own. Regenerating is a paid AI call, so keeping this one is a real option
 * and doing nothing is the default.
 */
function StaleNotice({ onRegenerate, busy }) {
  return (
    <div className="notice notice--warn" role="alert">
      <p>
        <strong>Your resume has changed since this letter was written.</strong> It may name something your resume no
        longer says, or miss something it now does.
      </p>
      <p className="muted">
        Nothing has been changed or thrown away. Writing it again is a new AI call on your own API key, so it is your
        choice &mdash; and it will replace the letter below, including any edits you have made to it.
      </p>
      <p className="actions">
        <button type="button" className="button button--primary" onClick={onRegenerate} disabled={busy} aria-busy={busy || undefined}>
          {busy && <Spinner />}
          {busy ? 'Writing your letter...' : 'Write it again from the current resume'}
        </button>
        <span className="muted">Or keep this one and edit it by hand below.</span>
      </p>
    </div>
  );
}

/**
 * The PDF engine is a separate chunk and a separate renderer. If either fails
 * -- a chunk that will not load, a render error inside react-pdf -- the page
 * keeps working and the plain-text copy is still there. Same boundary Export
 * uses, for the same reason.
 */
class PdfErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <p className="inline-status inline-status--error" role="status">
          The PDF preview could not be built. Reload the page to try again. The plain-text copy below still works.
        </p>
      );
    }
    return this.props.children;
  }
}
