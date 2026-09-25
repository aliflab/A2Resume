/**
 * The resume template catalogue: ids, names and the one-line pitch the picker
 * shows. Metadata only.
 *
 * WHY THIS FILE DOES NOT IMPORT THE TEMPLATES
 * Export.jsx renders the picker before the PDF engine has loaded, and a
 * template component imports @react-pdf/renderer. Importing one here would
 * pull the whole engine into the main bundle and undo the lazy boundary that
 * PdfPreview.jsx exists to create. The id -> component map lives on the other
 * side of that boundary, in resumeDocuments.js.
 *
 * WHAT EVERY TEMPLATE PROMISES
 * All of them take the output of normalizeResumeForExport and nothing else --
 * no template shapes its own data -- and all of them are one column, standard
 * section headings in SECTION_ORDER, real selectable text in a built-in PDF
 * font, and no images. That is an ATS claim the app makes, and
 * templates.manual.js round-trips every template through pdfParser.js to hold
 * it to that, one template at a time.
 *
 * The chosen id is stored in `settings.resumeTemplate` (see Export.jsx for why
 * settings rather than per-run state). An id read back from storage is never
 * trusted: resolveResumeTemplate maps anything unknown to the default.
 */

export const DEFAULT_RESUME_TEMPLATE = 'classic';

export const RESUME_TEMPLATES = [
  {
    id: 'classic',
    label: 'Classic',
    font: 'Helvetica',
    description: 'Clean and even-handed. The safe default for most roles.',
  },
  {
    id: 'technical',
    label: 'Technical',
    font: 'Helvetica',
    description: 'Dense: smaller type and tighter spacing, so more fits on a page. Suits engineering roles.',
  },
  {
    id: 'formal',
    label: 'Formal',
    font: 'Times',
    description: 'Serif type and a traditional centred header. Suits executive and leadership roles.',
  },
  {
    id: 'modern',
    label: 'Modern',
    font: 'Helvetica',
    description: 'Airy spacing, dates first on their own line, a coloured accent on headings.',
  },
];

export const RESUME_TEMPLATE_IDS = RESUME_TEMPLATES.map((template) => template.id);

/** A known template id, or the default for anything else -- null, a typo, an id from a newer build. */
export function resolveResumeTemplate(id) {
  return RESUME_TEMPLATE_IDS.includes(id) ? id : DEFAULT_RESUME_TEMPLATE;
}
