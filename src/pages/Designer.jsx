import { Component, Suspense, lazy, useCallback, useMemo } from 'react';
import { Link } from 'react-router';

import { ACTIONS, useApp } from '../context/AppContext.jsx';
import Icon from '../components/Icon.jsx';
import TemplatePicker from '../components/export/TemplatePicker.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';
import { resolveResumeTemplate, templateById } from '../components/export/resumeTemplates.js';
import {
  ACCENT_CHOICES,
  FONT_CHOICES,
  accentById,
  fontById,
  resolveAccentChoice,
  resolveFontChoice,
} from '../components/export/resumeDesign.js';
import {
  buildResumeFileName,
  findUnsupportedPdfCharacters,
  hasExportableContent,
  normalizeResumeForExport,
  selectExportSource,
} from '../services/resumeExport.js';

/**
 * Designer: template, accent colour and font, with the live PDF beside them.
 *
 * WHAT IT DOES NOT DO
 * Layout, spacing, margins, sizes and section order stay the template's. There
 * is no picker for any of them, and the templates only accept a font family
 * and an accent colour (buildStyles in each template). The choices are
 * curated lists (resumeDesign.js): built-in PDF fonts only, and swatches that
 * all clear 7:1 contrast on white. There is deliberately no free colour picker.
 *
 * PERSISTENCE: `settings.resumeAccent`, `settings.resumeFont` and
 * `settings.resumeTemplate` -- standing preferences about how the user's
 * resume looks, not artefacts of one run. So a new Input run keeps them and
 * Start over resets them. Stored as ids (or null = "the template's own"),
 * never as hex or face names, and resolved on read, so a junk value from
 * storage renders the template's defaults. The template picker here writes the
 * same setting as Export's, so the two pages always agree.
 *
 * Same empty state as Export, and the same lazy PdfPreview: the preview and
 * the download on this page are the file Export would produce.
 */

const PdfPreview = lazy(() => import('../components/export/PdfPreview.jsx'));

const ACCENT_NOTES = {
  rules:
    'This template has no colour of its own apart from the divider line under each section heading, so the accent colours that line and nothing else. All text stays near-black.',
  text: 'This template already uses a colour for the name, section headings, bullet marks and links. The accent replaces it everywhere it was used.',
};

export default function Designer() {
  const { state, dispatch } = useApp();
  const { raw } = selectExportSource(state);

  const resume = useMemo(() => normalizeResumeForExport(raw), [raw]);
  const fileName = useMemo(() => buildResumeFileName(resume), [resume]);
  const unsupportedChars = useMemo(() => findUnsupportedPdfCharacters(resume), [resume]);

  const template = templateById(resolveResumeTemplate(state?.settings?.resumeTemplate));
  const accent = resolveAccentChoice(state?.settings?.resumeAccent);
  const font = resolveFontChoice(state?.settings?.resumeFont);

  const choose = useCallback((payload) => dispatch({ type: ACTIONS.SET_SETTINGS, payload }), [dispatch]);

  if (!raw || !hasExportableContent(resume)) {
    return (
      <EmptyState
        icon="palette"
        title="Nothing to design yet"
        action={{ to: '/input', label: 'Add your resume' }}
      >
        Designer previews your own resume in each template, colour and font, so it needs one first. Upload or paste
        yours on step 1 and run the analysis.
      </EmptyState>
    );
  }

  const templateFont = fontById(template.defaultFont);
  const effectiveFont = fontById(font) ?? templateFont;
  const accentHex = accentById(accent)?.hex ?? null;

  return (
    <section className="page page--wide designer">
      <PageHeader
        eyebrow="Tools · Designer"
        title="Design your resume"
        actions={
          <Link to="/export" className="button">
            Back to export
            <Icon name="arrowRight" size={16} />
          </Link>
        }
      >
        Template, colour and font for your PDF. Layout, spacing and margins always come from the template, and every
        choice keeps the resume readable to an ATS.
      </PageHeader>

      {unsupportedChars.length > 0 && (
        <div className="notice notice--warn" role="status">
          <p>
            <strong>Some characters can&apos;t be shown in the PDF, in any of these fonts: </strong>
            {unsupportedChars.map((char) => `"${char}"`).join(' ')}
          </p>
        </div>
      )}

      <div className="workspace workspace--preview">
        <div className="stack">
          <section className="card">
            <TemplatePicker
              value={template.id}
              onChange={(id) => choose({ resumeTemplate: resolveResumeTemplate(id) })}
              accentHex={accentHex}
              note={false}
            />
          </section>

          <section className="card">
            <fieldset className="designer__group">
              <legend className="field-label">Accent colour</legend>
              <div className="swatches">
                <Swatch id={null} label="Template default" hex={null} checked={accent === null} onPick={() => choose({ resumeAccent: null })} />
                {ACCENT_CHOICES.map((a) => (
                  <Swatch key={a.id} id={a.id} label={a.label} hex={a.hex} checked={accent === a.id} onPick={() => choose({ resumeAccent: a.id })} />
                ))}
              </div>
              <p className="muted designer__note">{ACCENT_NOTES[template.accentUse]}</p>
            </fieldset>
          </section>

          <section className="card">
            <label className="field-label" htmlFor="designer-font" style={{ marginTop: 0 }}>
              Font
            </label>
            <div className="designer__font-row">
              <span className={`font-sample font-sample--${effectiveFont.id}`} aria-hidden="true">
                Aa
              </span>
              <select
                id="designer-font"
                value={font ?? ''}
                onChange={(event) => choose({ resumeFont: resolveFontChoice(event.target.value) })}
              >
                <option value="">Template default ({templateFont.label})</option>
                {FONT_CHOICES.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label} ({f.note.split(',')[0].toLowerCase()})
                  </option>
                ))}
              </select>
            </div>
            <p className="muted designer__note">
              {effectiveFont.id === 'courier'
                ? 'Courier is monospaced and much wider than the others, so the same resume takes noticeably more pages. It reads fine to an ATS; it just costs room.'
                : 'Only the fonts built into every PDF reader are offered, so nothing is downloaded and every word stays selectable text.'}
            </p>

            <p className="actions">
              <button
                type="button"
                className="button button--ghost"
                onClick={() => choose({ resumeAccent: null, resumeFont: null })}
                disabled={accent === null && font === null}
              >
                <Icon name="refresh" size={15} />
                Reset colour and font
              </button>
            </p>
          </section>
        </div>

        <div>
          <PreviewBoundary>
            <Suspense
              fallback={
                <div className="preview-loading" role="status">
                  <span>Preparing the PDF preview…</span>
                  <span className="progress-bar" aria-hidden="true" />
                </div>
              }
            >
              <PdfPreview resume={resume} template={template.id} accent={accent} font={font} fileName={fileName} />
            </Suspense>
          </PreviewBoundary>
        </div>
      </div>
    </section>
  );
}

/** One swatch: a real radio, so the group is keyboard- and screen-reader-operable. */
function Swatch({ id, label, hex, checked, onPick }) {
  return (
    <label className={`swatch${checked ? ' swatch--selected' : ''}`}>
      <input type="radio" name="designer-accent" value={id ?? ''} checked={checked} onChange={onPick} />
      <span className={`swatch__chip${hex ? '' : ' swatch__chip--default'}`} style={hex ? { background: hex } : undefined} aria-hidden="true" />
      <span className="swatch__label">{label}</span>
      {checked && <Icon name="check" size={14} className="swatch__check" />}
    </label>
  );
}

/** Same contract as Export's: a failed PDF chunk or render never takes the page down. */
class PreviewBoundary extends Component {
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
            <p className="error-notice__message">Reload the page to try again.</p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
