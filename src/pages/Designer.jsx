import { Component, Suspense, lazy, useCallback, useMemo } from 'react';
import { Link } from 'react-router';

import { ACTIONS, useApp } from '../context/AppContext.jsx';
import { resolveResumeTemplate, templateById } from '../components/export/resumeTemplates.js';
import {
  ACCENT_CHOICES,
  FONT_CHOICES,
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
 * Designer: accent colour and font, on top of the template picked on Export.
 *
 * WHAT IT DOES NOT DO
 * Layout, spacing, margins, sizes and section order stay the template's. There
 * is no picker for any of them, and the templates only accept a font family
 * and an accent colour (buildStyles in each template). The choices are
 * curated lists (resumeDesign.js): built-in PDF fonts only, and swatches that
 * all clear 7:1 contrast on white.
 *
 * PERSISTENCE: `settings.resumeAccent` and `settings.resumeFont`, next to
 * `settings.resumeTemplate`, for the same reason -- a standing preference about
 * how the user's resume looks, not an artefact of one run. So a new Input run
 * keeps them and Start over resets them. Stored as ids (or null = "the
 * template's own"), never as hex or face names, and resolved on read, so a
 * junk value from storage renders the template's defaults.
 *
 * The choice applies to whichever template is picked, not to one template:
 * switching template on Export keeps the colour and font. That is one setting
 * per concern rather than a grid of per-template overrides, and the note under
 * the swatches says where the accent will land in the current template.
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

  if (!raw || !hasExportableContent(resume)) return <EmptyState />;

  const templateFont = fontById(template.defaultFont);
  const effectiveFont = fontById(font) ?? templateFont;

  return (
    <section className="page designer">
      <header>
        <h1>Designer</h1>
        <p className="muted">
          Colour and font for your resume PDF, on top of the <strong>{template.label}</strong> template.{' '}
          <Link to="/export">Change the template on Export</Link>. Layout, spacing and margins always come from the
          template.
        </p>
      </header>

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

        <label className="field-label" htmlFor="designer-font">
          Font
        </label>
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
        <p className="muted designer__note">
          {effectiveFont.id === 'courier'
            ? 'Courier is monospaced and much wider than the others, so the same resume takes noticeably more pages. It reads fine to an ATS; it just costs room.'
            : 'Only the fonts built into every PDF reader are offered, so nothing is downloaded and every word stays selectable text.'}
        </p>

        <p className="actions">
          <button
            type="button"
            className="button"
            onClick={() => choose({ resumeAccent: null, resumeFont: null })}
            disabled={accent === null && font === null}
          >
            Reset to the template&apos;s own colour and font
          </button>
        </p>
      </section>

      {unsupportedChars.length > 0 && (
        <div className="notice notice--warn" role="status">
          <p>
            <strong>Some characters can&apos;t be shown in the PDF, in any of these fonts: </strong>
            {unsupportedChars.map((char) => `"${char}"`).join(' ')}
          </p>
        </div>
      )}

      <section className="card">
        <h2>Preview</h2>
        <PreviewBoundary>
          <Suspense fallback={<p className="muted">Loading the PDF preview...</p>}>
            <PdfPreview resume={resume} template={template.id} accent={accent} font={font} fileName={fileName} />
          </Suspense>
        </PreviewBoundary>
      </section>
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
    </label>
  );
}

function EmptyState() {
  return (
    <section className="page designer">
      <h1>Nothing to design yet</h1>
      <p className="muted">
        Designer previews your own resume, so it needs one first. Upload or paste yours on step 1 and run the analysis.
      </p>
      <p>
        <Link to="/input" className="button button--primary">
          Go to step 1
        </Link>
      </p>
    </section>
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
        <p className="inline-status inline-status--error" role="status">
          The PDF preview could not be built. Reload the page to try again.
        </p>
      );
    }
    return this.props.children;
  }
}
