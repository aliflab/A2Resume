import { Component, Suspense, lazy, useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { ACTIONS, useApp } from '../context/AppContext.jsx';
import Icon from '../components/Icon.jsx';
import TemplatePicker from '../components/export/TemplatePicker.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';
import ScoreRing from '../components/ui/ScoreRing.jsx';
import { gradeTone, gradeVerdict } from '../components/ui/scoreBands.js';
import { resolveResumeTemplate, templateById } from '../components/export/resumeTemplates.js';
import { accentById, fontById, resolveAccentChoice, resolveFontChoice } from '../components/export/resumeDesign.js';
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
 * provider. An unknown id read back from storage renders the default
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
  // Designer's choices ride on top of whichever template is picked here, so
  // the download from this page matches what Designer previewed.
  const accent = resolveAccentChoice(state?.settings?.resumeAccent);
  const font = resolveFontChoice(state?.settings?.resumeFont);
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

  // A .txt of the same text, made in the browser from a Blob. Nothing is
  // fetched or uploaded; the object URL is released straight after.
  const downloadText = useCallback(() => {
    const url = URL.createObjectURL(new Blob([plainText], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName.replace(/\.pdf$/i, '.txt');
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [fileName, plainText]);

  if (!raw) {
    return (
      <EmptyState icon="download" title="Nothing to export yet" action={{ to: '/input', label: 'Add your resume' }}>
        Export turns your resume into an ATS-friendly PDF or plain text. It needs a resume to work with: upload or
        paste yours on step 1 and run the analysis.
      </EmptyState>
    );
  }
  if (!hasExportableContent(resume)) {
    return (
      <EmptyState icon="alert" title="Nothing usable came out of your resume" action={{ to: '/input', label: 'Check it on step 1' }}>
        Your resume was read, but there is no name, experience, skills or education to print. Go back to step 1,
        check the extracted text, and run it again.
      </EmptyState>
    );
  }

  const templateInfo = templateById(template);
  const accentInfo = accentById(accent);
  const fontInfo = fontById(font) ?? fontById(templateInfo.defaultFont);
  const score = state.atsScore ?? null;

  return (
    <section className="page page--wide export">
      <PageHeader eyebrow="Step 4 of 4" title="Your resume is ready.">
        Check the preview, choose a template, then download the PDF or copy the text.
      </PageHeader>

      <section className="card ready" aria-label="Export summary">
        <span className="ready__mark">
          <Icon name="check" size={22} />
        </span>
        <div>
          <h2 className="ready__title">{resume.name || 'Your resume'}</h2>
          <ul className="ready__facts">
            <li>
              Template <strong>{templateInfo.label}</strong>
            </li>
            <li>
              Font <strong>{fontInfo?.label ?? 'Template default'}</strong>
            </li>
            <li>
              Colour <strong>{accentInfo?.label ?? 'Template default'}</strong>
            </li>
            <li>
              {source === 'tailored' ? (
                <strong>Tailored for this job</strong>
              ) : (
                <>
                  Original resume · <Link to="/tailor">Tailor it first</Link>
                </>
              )}
            </li>
          </ul>
        </div>
        {score && (
          <div className="ready__score">
            <ScoreRing percentage={score.percentage} size={52} tone={gradeTone(score)}>
              <span className="ring-figure ring-figure--sm">
                <span className="ring-figure__pct">{score.grade}</span>
              </span>
            </ScoreRing>
            <span className="ready__score-text">
              <strong>
                {score.total} / {score.scoreableMax}
              </strong>
              {gradeVerdict(score)}
            </span>
          </div>
        )}
      </section>

      {unsupportedChars.length > 0 && (
        <div className="notice notice--warn" role="status">
          <p>
            <strong>Some characters can&apos;t be shown in the PDF: </strong>
            {unsupportedChars.map((char) => `"${char}"`).join(' ')}
          </p>
          <p>
            Every template and every Designer font is a standard built-in PDF font (Helvetica, Times or Courier) that
            only covers Western European characters, so these may come out wrong or missing whichever template you
            pick. Check the preview. The plain-text copy is not affected.
          </p>
        </div>
      )}

      <div className="workspace workspace--preview">
        <div className="stack">
          <section className="card">
            <TemplatePicker value={template} onChange={chooseTemplate} accentHex={accentInfo?.hex ?? null} />
          </section>

          <section className="card">
            <h2>Design</h2>
            <ul className="design-summary">
              <li>
                <span>Template</span>
                <span>{templateInfo.label}</span>
              </li>
              <li>
                <span>Font</span>
                <span>{fontInfo?.label ?? 'Template default'}</span>
              </li>
              <li>
                <span>Colour</span>
                <span>
                  {accentInfo && (
                    <span className="design-summary__swatch" style={{ background: accentInfo.hex }} aria-hidden="true" />
                  )}
                  {accentInfo?.label ?? 'Template default'}
                </span>
              </li>
            </ul>
            <Link to="/designer" className="button">
              <Icon name="palette" size={16} />
              Customize design
            </Link>
          </section>

          <section className="card">
            <h2>Plain text</h2>
            <p className="muted">For application forms that only have a text box and no file upload.</p>
            <div className="actions">
              <button type="button" className="button" onClick={copy}>
                <Icon name="copy" size={15} />
                Copy as plain text
              </button>
              <button type="button" className="button button--ghost" onClick={downloadText}>
                <Icon name="download" size={15} />
                Download .txt
              </button>
            </div>
            {copyStatus && (
              <p className={`inline-status ${copyStatus.ok ? 'inline-status--ok' : 'inline-status--error'}`} role="status">
                {copyStatus.message}
              </p>
            )}
            <label className="field-label" htmlFor="export-plain-text">
              Text that will be copied
            </label>
            <textarea id="export-plain-text" className="textarea--source" readOnly rows={10} value={plainText} />
          </section>
        </div>

        <div>
          <PdfErrorBoundary>
            <Suspense fallback={<PreviewLoading />}>
              <PdfPreview resume={resume} template={template} accent={accent} font={font} fileName={fileName} />
            </Suspense>
          </PdfErrorBoundary>
        </div>
      </div>
    </section>
  );
}

function PreviewLoading() {
  return (
    <div className="preview-loading" role="status">
      <span>Preparing the PDF preview…</span>
      <span className="progress-bar" aria-hidden="true" />
    </div>
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
        <div className="error-notice" role="alert">
          <div className="error-notice__body">
            <p className="error-notice__title">The PDF preview couldn&rsquo;t be built</p>
            <p className="error-notice__message">
              Reload the page to try again. The plain-text copy beside this still works.
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
