import { Component, Suspense, lazy, useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { ACTIONS, useApp } from '../context/AppContext.jsx';
import { RESUME_TEMPLATES, resolveResumeTemplate } from '../components/export/resumeTemplates.js';
import {
  buildResumeFileName,
  findUnsupportedPdfCharacters,
  generatePlainText,
  hasExportableContent,
  normalizeResumeForExport,
  selectExportSource,
} from '../services/resumeExport.js';

/**
 * Step 4: preview the resume as a PDF, download it, or copy it as plain text.
 *
 * Reads `state.tailoredResume` when a tailoring pass exists and falls back to
 * `state.resume` otherwise -- nothing here assumes Tailor was run. Both go
 * through normalizeResumeForExport, which is what makes that fallback safe.
 *
 * Like every other page there is no route guard: loaded cold it shows an empty
 * state pointing back at step 1 instead of rendering a blank PDF.
 *
 * THE TEMPLATE CHOICE IS A SETTING, NOT PART OF THE RUN
 * It is stored as `settings.resumeTemplate`, next to the provider choice, not
 * as a new pipeline field. What a resume looks like is the user's preference,
 * not an artefact of one run, so it should outlive the run: CLEAR_ANALYSIS (a
 * new Input run for a new job) keeps `settings`, and so keeps the template.
 * "Start over" resets settings along with everything else, the same as the
 * provider. `settings` is already persisted as a 'flat' block, which keeps
 * string values only, so no new PERSISTED_FIELDS entry and no SESSION_VERSION
 * bump were needed. An unknown id read back from storage renders the default
 * (resolveResumeTemplate), never a blank preview.
 *
 * Switching is live: the same normalised resume is handed to a different
 * layout, and the preview and the download follow it together.
 */

const PdfPreview = lazy(() => import('../components/export/PdfPreview.jsx'));

export default function Export() {
  const { state, dispatch } = useApp();
  const { raw, source } = selectExportSource(state);
  const template = resolveResumeTemplate(state?.settings?.resumeTemplate);
  const chooseTemplate = useCallback(
    (id) => dispatch({ type: ACTIONS.SET_SETTINGS, payload: { resumeTemplate: resolveResumeTemplate(id) } }),
    [dispatch],
  );

  const resume = useMemo(() => normalizeResumeForExport(raw), [raw]);
  const plainText = useMemo(() => generatePlainText(resume), [resume]);
  const fileName = useMemo(() => buildResumeFileName(resume), [resume]);
  const unsupportedChars = useMemo(() => findUnsupportedPdfCharacters(resume), [resume]);

  const [copyStatus, setCopyStatus] = useState(null);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(plainText);
      setCopyStatus({ ok: true, message: 'Copied. Paste it into the application form.' });
    } catch {
      setCopyStatus({
        ok: false,
        message: 'Your browser blocked clipboard access. Select the text below and copy it yourself.',
      });
    }
  }, [plainText]);

  if (!raw) return <EmptyState />;
  if (!hasExportableContent(resume)) return <EmptyState parsedButEmpty />;

  return (
    <section className="page export">
      <header className="export__head">
        <p className="export__step">Step 4 of 4</p>
        <h1>Export your resume</h1>
        <p className="muted">Check the preview, then download the PDF or copy the text.</p>
      </header>

      {source === 'tailored' ? (
        <div className="notice notice--ok" role="status">
          <p>Using your tailored resume from step 3.</p>
        </div>
      ) : (
        <div className="notice notice--info" role="status">
          <p>
            Using your resume as it was read in step 1. You haven&apos;t run the tailoring pass.{' '}
            <Link to="/tailor">Tailor it for the job</Link> first, or export it as it is.
          </p>
        </div>
      )}

      {unsupportedChars.length > 0 && (
        <div className="notice notice--warn" role="status">
          <p>
            <strong>Some characters can&apos;t be shown in the PDF: </strong>
            {unsupportedChars.map((char) => `"${char}"`).join(' ')}
          </p>
          <p>
            Every template uses a standard built-in font (Helvetica, or Times for Formal) that only covers Western
            European characters, so these may come out wrong or missing whichever template you pick. Check the
            preview. The plain-text copy below is not affected.
          </p>
        </div>
      )}

      <section className="card">
        <h2>PDF</h2>
        <TemplatePicker value={template} onChange={chooseTemplate} />
        <PdfErrorBoundary>
          <Suspense fallback={<p className="muted">Loading the PDF preview...</p>}>
            <PdfPreview resume={resume} template={template} fileName={fileName} />
          </Suspense>
        </PdfErrorBoundary>
      </section>

      <section className="card">
        <h2>Plain text</h2>
        <p className="muted">
          For application forms that only have a text box and no file upload.
        </p>
        <p className="actions">
          <button type="button" className="button" onClick={copy}>
            Copy as plain text
          </button>
        </p>
        {copyStatus && (
          <p className={`inline-status ${copyStatus.ok ? 'inline-status--ok' : 'inline-status--error'}`} role="status">
            {copyStatus.message}
          </p>
        )}
        <label className="field-label" htmlFor="export-plain-text">
          Text that will be copied
        </label>
        <textarea id="export-plain-text" readOnly rows={18} value={plainText} />
      </section>
    </section>
  );
}

/**
 * A radio group, so it is one tab stop with arrow-key selection for free. Every
 * option is a text description rather than a thumbnail: a thumbnail would mean
 * rendering four PDFs to show one, and the live preview below already shows the
 * real thing the moment an option is picked.
 */
function TemplatePicker({ value, onChange }) {
  return (
    <fieldset className="template-picker">
      <legend className="field-label">Template</legend>
      <p className="muted template-picker__note">
        Every template is one column with standard headings and real, selectable text, so an ATS reads them all the
        same way. Only the look changes.
      </p>
      <div className="template-picker__options">
        {RESUME_TEMPLATES.map((t) => (
          <label key={t.id} className={`template-option${t.id === value ? ' template-option--selected' : ''}`}>
            <input
              type="radio"
              name="resume-template"
              value={t.id}
              checked={t.id === value}
              onChange={() => onChange(t.id)}
            />
            <span className="template-option__label">{t.label}</span>
            <span className="template-option__description">{t.description}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function EmptyState({ parsedButEmpty = false }) {
  return (
    <section className="page export">
      <h1>Nothing to export yet</h1>
      <p className="muted">
        {parsedButEmpty
          ? 'Your resume was read, but nothing usable came out of it -- no name, experience, skills or education. Go back to step 1, check the extracted text, and run it again.'
          : 'Export needs a resume to work with. Upload or paste yours on step 1 and run the analysis first.'}
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
 * The PDF engine is a separate chunk and a separate renderer. If either fails
 * -- a chunk that will not load, a render error inside react-pdf -- the page
 * keeps working, and the plain-text copy is still there.
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
