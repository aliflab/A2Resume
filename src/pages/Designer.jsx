import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router';

import { ACTIONS, useApp } from '../context/AppContext.jsx';
import Icon from '../components/Icon.jsx';
import TemplatePicker from '../components/export/TemplatePicker.jsx';
import EmptyState from '../components/ui/EmptyState.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';
import PreviewSkeleton from '../components/ui/PreviewSkeleton.jsx';
import WorkingLine from '../components/ui/WorkingLine.jsx';
import { resolveResumeTemplate, templateById } from '../components/export/resumeTemplates.js';
import {
  ACCENT_CHOICES,
  ACCENT_RULE_MIN_CONTRAST,
  ACCENT_TEXT_MIN_CONTRAST,
  FONT_CHOICES,
  accentById,
  contrastRatio,
  fontById,
  isCustomAccent,
  normalizeHex,
  resolveAccentChoice,
  resolveFontChoice,
} from '../components/export/resumeDesign.js';
import {
  FONT_FILE_ACCEPT,
  addFont,
  customFontId,
  getFontRecord,
  listFonts,
  removeFont,
  subscribeFonts,
} from '../services/fontLibrary.js';
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
 * and an accent colour (buildStyles in each template).
 *
 * COLOUR: a curated palette (every swatch >= 7:1 on white) plus any colour,
 * through a colour input or a typed hex. A custom colour shows its contrast,
 * and warns when the template would draw it on text too faint to read.
 *
 * FONT: the three built-in PDF fonts, plus fonts the user imports from their
 * own files (services/fontLibrary.js). An import is parsed and proved by the
 * real PDF engine first -- drawn into a test PDF and read back -- in
 * components/export/customFonts.jsx, which this page loads only when a font is
 * imported, since it pulls in react-pdf and pdf.js.
 *
 * PERSISTENCE: `settings.resumeAccent`, `settings.resumeFont` and
 * `settings.resumeTemplate` -- standing preferences about how the user's
 * resume looks, not artefacts of one run. So a new Input run keeps them and
 * Start over resets them. The accent is a preset id or a validated `#rrggbb`;
 * the font is a built-in id or `custom:<id>`. Both are resolved on read, so a
 * junk value from storage renders the template's defaults. The imported font
 * files themselves live in their own entry and survive Start over.
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

/** Where the custom colour starts before the user has picked one: a dark blue, 8:1 on white. */
const DEFAULT_CUSTOM_ACCENT = '#2f4f86';
/** Dragging a colour input fires many events; the PDF is rebuilt once the pointer settles. */
const ACCENT_COMMIT_MS = 250;

export default function Designer() {
  const { state, dispatch } = useApp();
  const { raw } = selectExportSource(state);
  // Subscribing re-renders the page when a font is imported or removed, so the
  // font choice below is resolved against the library as it is now.
  const library = useSyncExternalStore(subscribeFonts, listFonts);

  const template = templateById(resolveResumeTemplate(state?.settings?.resumeTemplate));
  const accent = resolveAccentChoice(state?.settings?.resumeAccent);
  const font = resolveFontChoice(state?.settings?.resumeFont);
  const templateFont = fontById(template.defaultFont);
  const effectiveFont = fontById(font) ?? templateFont;

  const resume = useMemo(() => normalizeResumeForExport(raw), [raw]);
  const fileName = useMemo(() => buildResumeFileName(resume), [resume]);
  // Not memoized: only characters outside WinAnsi reach the coverage lookup.
  const unsupportedChars = findUnsupportedPdfCharacters(resume, { coverage: effectiveFont.coverage });

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
            <strong>
              {effectiveFont.custom
                ? `Some characters can't be shown in the PDF with ${effectiveFont.label}: `
                : "Some characters can't be shown in the PDF with the built-in fonts: "}
            </strong>
            {unsupportedChars.map((char) => `"${char}"`).join(' ')}
          </p>
          <p>
            {effectiveFont.custom
              ? 'Your font does not include them, and the built-in fallback only covers Western European characters, so they may come out wrong or missing. Check the preview.'
              : 'The built-in fonts only cover Western European characters. Importing a font that includes these characters fixes that.'}
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
            <AccentPicker accent={accent} accentUse={template.accentUse} choose={choose} />
          </section>

          <section className="card">
            <FontPicker
              font={font}
              effectiveFont={effectiveFont}
              templateFont={templateFont}
              library={library}
              choose={choose}
            />

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
            <Suspense fallback={<PreviewSkeleton />}>
              <PdfPreview resume={resume} template={template.id} accent={accent} font={font} fileName={fileName} />
            </Suspense>
          </PreviewBoundary>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Accent colour
// ---------------------------------------------------------------------------

/**
 * The palette, plus "Custom": a native colour input and a hex field that
 * drive the same draft. The draft updates the swatch at once; the stored
 * setting (and so the PDF rebuild) follows ACCENT_COMMIT_MS after the last
 * change, and a pending change is flushed if the page is left first.
 */
function AccentPicker({ accent, accentUse, choose }) {
  const storedCustom = isCustomAccent(accent) ? accent : null;
  const [draft, setDraft] = useState(storedCustom ?? DEFAULT_CUSTOM_ACCENT);
  const [hexText, setHexText] = useState((storedCustom ?? DEFAULT_CUSTOM_ACCENT).toUpperCase());
  // `pending` holds the colour waiting for its debounced commit, and the state
  // flag keeps "Custom" selected during that wait, before the store has it.
  const pending = useRef(null);
  const timer = useRef(null);
  const [awaiting, setAwaiting] = useState(false);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (pending.current) choose({ resumeAccent: pending.current });
    pending.current = null;
    setAwaiting(false);
  }, [choose]);

  useEffect(() => flush, [flush]);

  const commit = (hex, { now = false, keepText = false } = {}) => {
    setDraft(hex);
    if (!keepText) setHexText(hex.toUpperCase());
    pending.current = hex;
    setAwaiting(true);
    clearTimeout(timer.current);
    if (now) flush();
    else timer.current = setTimeout(flush, ACCENT_COMMIT_MS);
  };

  const pickPreset = (id) => {
    clearTimeout(timer.current);
    pending.current = null;
    setAwaiting(false);
    choose({ resumeAccent: id });
  };

  const customSelected = storedCustom !== null || awaiting;
  const ratio = contrastRatio(draft);
  const hexValid = normalizeHex(hexText) !== null;

  return (
    <fieldset className="designer__group">
      <legend className="field-label">Accent colour</legend>
      <div className="swatches">
        <Swatch
          id={null}
          label="Template default"
          hex={null}
          checked={accent === null && !customSelected}
          onPick={() => pickPreset(null)}
        />
        {ACCENT_CHOICES.map((a) => (
          <Swatch key={a.id} id={a.id} label={a.label} hex={a.hex} checked={accent === a.id} onPick={() => pickPreset(a.id)} />
        ))}
        <Swatch id="custom" label="Custom" hex={draft} checked={customSelected} onPick={() => commit(draft, { now: true })} />
      </div>

      <div className="accent-custom">
        <label className="accent-custom__well" title="Pick any colour">
          <input
            type="color"
            value={draft}
            onChange={(event) => commit(normalizeHex(event.target.value) ?? draft)}
            aria-label="Custom accent colour"
          />
        </label>
        <label className="visually-hidden" htmlFor="designer-accent-hex">
          Custom accent colour as a hex code
        </label>
        <input
          id="designer-accent-hex"
          className="input accent-custom__hex"
          value={hexText}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!hexValid || undefined}
          onChange={(event) => {
            setHexText(event.target.value);
            const hex = normalizeHex(event.target.value);
            if (hex) commit(hex, { keepText: true });
          }}
          onBlur={() => setHexText(draft.toUpperCase())}
        />
        <span className="accent-custom__ratio">
          {ratio.toFixed(1)}:1 <span className="muted">on white</span>
        </span>
      </div>

      {customSelected && <ContrastAdvice ratio={ratio} accentUse={accentUse} />}
      {!hexValid && (
        <p className="inline-status inline-status--error" role="status">
          Enter a colour as a hex code, like #2F4F86.
        </p>
      )}
      <p className="muted designer__note">{ACCENT_NOTES[accentUse]}</p>
    </fieldset>
  );
}

/** How a custom colour will read where this template draws it. */
function ContrastAdvice({ ratio, accentUse }) {
  const shown = ratio.toFixed(1);
  if (accentUse === 'text' && ratio < ACCENT_TEXT_MIN_CONTRAST) {
    return (
      <p className="inline-status inline-status--warn" role="status">
        Hard to read: this template draws your name, section headings and links in this colour, and at {shown}:1 on
        white it is below the {ACCENT_TEXT_MIN_CONTRAST}:1 small text needs. It may also fade in greyscale print. An ATS
        reads the words either way.
      </p>
    );
  }
  if (accentUse === 'rules' && ratio < ACCENT_RULE_MIN_CONTRAST) {
    return (
      <p className="inline-status inline-status--warn" role="status">
        This colour is so light that the divider lines may barely show, on screen or in print.
      </p>
    );
  }
  return null;
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

// ---------------------------------------------------------------------------
// Font
// ---------------------------------------------------------------------------

const formatSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * Loads an imported font into the page itself, from its data URL, so the "Aa"
 * sample is drawn in it. Local only: a data: URL is decoded, not fetched.
 */
const pageFonts = new Set();
function usePageFont(fontId) {
  useEffect(() => {
    if (!fontId || pageFonts.has(fontId) || typeof FontFace === 'undefined') return;
    const record = getFontRecord(fontId);
    if (!record) return;
    pageFonts.add(fontId);
    const face = new FontFace(`a2r-sample-${record.id}`, `url(${record.regular})`);
    face
      .load()
      .then(() => document.fonts.add(face))
      .catch(() => pageFonts.delete(fontId));
  }, [fontId]);
}

function FontPicker({ font, effectiveFont, templateFont, library, choose }) {
  const fileInput = useRef(null);
  const [importState, setImportState] = useState(null);
  const busy = importState?.status === 'checking';
  usePageFont(effectiveFont.custom ? effectiveFont.id : null);

  const onFiles = async (event) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    if (files.length === 0) return;
    setImportState({ status: 'checking' });
    try {
      const { importFontFiles } = await import('../components/export/customFonts.jsx');
      const checked = await importFontFiles(files);
      const meta = addFont(checked);
      choose({ resumeFont: customFontId(meta.id) });
      setImportState({
        status: 'done',
        message: meta.duplicate
          ? `${meta.name} is already in your fonts, so that copy is used. It is now your resume font.`
          : `Imported ${meta.name} (${meta.hasBold ? 'regular and bold' : 'regular only'}). It is now your resume font.`,
        notes: meta.duplicate ? [] : checked.notes,
      });
    } catch (err) {
      setImportState({
        status: 'error',
        message:
          err?.name === 'FontImportError' ? err.message : 'The font could not be imported. Try a different file.',
      });
    }
  };

  const remove = (meta) => {
    try {
      removeFont(meta.id);
      if (font === customFontId(meta.id)) choose({ resumeFont: null });
      setImportState({ status: 'done', message: `Removed ${meta.name} from this browser.`, notes: [] });
    } catch (err) {
      setImportState({ status: 'error', message: err?.message ?? 'The font could not be removed.' });
    }
  };

  const sampleStyle = effectiveFont.custom
    ? { fontFamily: `'a2r-sample-${effectiveFont.id.slice('custom:'.length)}', sans-serif` }
    : undefined;

  let fontNote;
  if (effectiveFont.id === 'courier') {
    fontNote =
      'Courier is monospaced and much wider than the others, so the same resume takes noticeably more pages. It reads fine to an ATS; it just costs room.';
  } else if (effectiveFont.custom && !effectiveFont.hasBold) {
    fontNote =
      'This font was imported without a bold file, so headings and job titles use the regular weight. Import the regular and bold files together to fix that.';
  } else if (effectiveFont.custom) {
    fontNote = 'Your own font, embedded in the PDF. It was checked when you imported it: every word stays selectable text an ATS can read.';
  } else {
    fontNote = 'The built-in fonts are part of every PDF reader, so nothing is embedded and every word stays selectable text.';
  }

  return (
    <>
      <label className="field-label" htmlFor="designer-font" style={{ marginTop: 0 }}>
        Font
      </label>
      <div className="designer__font-row">
        <span
          className={`font-sample${effectiveFont.custom ? '' : ` font-sample--${effectiveFont.id}`}`}
          style={sampleStyle}
          aria-hidden="true"
        >
          Aa
        </span>
        <select
          id="designer-font"
          value={font ?? ''}
          onChange={(event) => choose({ resumeFont: resolveFontChoice(event.target.value) })}
        >
          <option value="">Template default ({templateFont.label})</option>
          <optgroup label="Built into every PDF reader">
            {FONT_CHOICES.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label} ({f.note.split(',')[0].toLowerCase()})
              </option>
            ))}
          </optgroup>
          {library.length > 0 && (
            <optgroup label="Your fonts">
              {library.map((f) => (
                <option key={f.id} value={customFontId(f.id)}>
                  {f.hasBold ? f.name : `${f.name} (regular only)`}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
      <p className="muted designer__note">{fontNote}</p>

      <div className="font-library">
        <div className="font-library__head">
          <span className="field-label">Your fonts</span>
          <button type="button" className="button button--sm" onClick={() => fileInput.current?.click()} disabled={busy}>
            <Icon name="upload" size={14} />
            Import a font
          </button>
          <input
            ref={fileInput}
            id="designer-font-file"
            type="file"
            accept={FONT_FILE_ACCEPT}
            multiple
            className="visually-hidden"
            tabIndex={-1}
            onChange={onFiles}
          />
        </div>
        <p className="muted designer__note">
          A .ttf, .otf, .woff or .woff2 file, up to 1 MB each. Choose the regular and bold files together and both are
          used. The font stays in this browser and is never uploaded.
        </p>

        {library.length > 0 && (
          <ul className="font-library__list">
            {library.map((f) => (
              <li key={f.id} className="font-library__item">
                <span className="font-library__name">{f.name}</span>
                <span className="muted">
                  {f.hasBold ? 'Regular and bold' : 'Regular only'} · {formatSize(f.bytes)}
                </span>
                <button
                  type="button"
                  className="button button--sm button--danger"
                  onClick={() => remove(f)}
                  aria-label={`Remove ${f.name}`}
                  disabled={busy}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        {busy && (
          <WorkingLine
            label="Checking the font…"
            detail="It is drawn into a test PDF and read back, to make sure an ATS can still read every word."
          />
        )}
        {importState?.status === 'error' && (
          <p className="inline-status inline-status--error" role="alert">
            {importState.message}
          </p>
        )}
        {importState?.status === 'done' && (
          <div role="status">
            <p className="inline-status inline-status--ok">{importState.message}</p>
            {importState.notes.length > 0 && (
              <ul className="font-library__notes">
                {importState.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </>
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
