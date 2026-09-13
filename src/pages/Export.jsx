import { Component, Suspense, lazy, useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { useApp } from '../context/AppContext.jsx';
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
 */

const PdfPreview = lazy(() => import('../components/export/PdfPreview.jsx'));

export default function Export() {
  const { state } = useApp();
  const { raw, source } = selectExportSource(state);

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
            The PDF uses a standard built-in font that only covers Western European characters, so these may come
            out wrong or missing. Check the preview. The plain-text copy below is not affected.
          </p>
        </div>
      )}

      <section className="card">
        <h2>PDF</h2>
        <PdfErrorBoundary>
          <Suspense fallback={<p className="muted">Loading the PDF preview...</p>}>
            <PdfPreview resume={resume} fileName={fileName} />
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
