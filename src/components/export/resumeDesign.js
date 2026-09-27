/**
 * Designer's two choices -- accent colour and font -- and how they resolve
 * against a template. Pure data: no react-pdf import, so the Designer page can
 * render its swatches and dropdown without pulling in the PDF engine (the same
 * rule as resumeTemplates.js).
 *
 * WHAT DESIGNER MAY CHANGE, AND WHAT IT MAY NOT
 * Colour and typeface only. Layout, spacing, margins, sizes and section order
 * belong to the template. A template receives a resolved theme
 * `{ faces, accent }` and decides for itself where those go; nothing here
 * knows a template's styles.
 *
 * FONTS -- ONLY THE ONES react-pdf ALREADY HAS
 * @react-pdf/font's STANDARD_FONTS are three families, four faces each:
 * Helvetica, Times, Courier. They are the PDF standard fonts: no font file,
 * nothing fetched, and their metrics already ship in the PDF chunk whether they
 * are used or not. That list is the whole menu -- anything else would mean a
 * bundled font file, and a remote one would break the no-network rule.
 * All three cover the same WinAnsi set, so findUnsupportedPdfCharacters and
 * Export's warning are unchanged by a font choice.
 *
 * ACCENTS -- CURATED, NOT A PICKER
 * Modern draws its accent on TEXT (the name, headings, links at 9pt), so every
 * swatch must read as small text on white. Each is >= 7:1 against white (WCAG
 * AAA for normal text) and dark in greyscale print; ACCENT_MIN_CONTRAST is
 * asserted in designer.manual.js so a new swatch cannot quietly fail it.
 *
 * `null` for either choice means "the template's own", and is what is stored
 * until the user picks something. Ids are stored, never hex values or face
 * names, so a stored choice cannot inject an arbitrary colour or font.
 */

export const FONT_CHOICES = [
  {
    id: 'helvetica',
    label: 'Helvetica',
    note: 'Sans-serif',
    faces: { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique' },
  },
  {
    id: 'times',
    label: 'Times',
    note: 'Serif',
    faces: { regular: 'Times-Roman', bold: 'Times-Bold', italic: 'Times-Italic', boldItalic: 'Times-BoldItalic' },
  },
  {
    id: 'courier',
    label: 'Courier',
    note: 'Monospace, and much wider: expect more pages',
    faces: { regular: 'Courier', bold: 'Courier-Bold', italic: 'Courier-Oblique', boldItalic: 'Courier-BoldOblique' },
  },
];

export const ACCENT_CHOICES = [
  { id: 'charcoal', label: 'Charcoal', hex: '#262626' },
  { id: 'navy', label: 'Navy', hex: '#1e3a8a' },
  { id: 'slate', label: 'Slate', hex: '#334155' },
  { id: 'teal', label: 'Teal', hex: '#1f5f7a' },
  { id: 'forest', label: 'Forest', hex: '#166534' },
  { id: 'burgundy', label: 'Burgundy', hex: '#7f1d1d' },
  { id: 'plum', label: 'Plum', hex: '#581c87' },
];

/** WCAG contrast every swatch must reach against white. Asserted, not assumed. */
export const ACCENT_MIN_CONTRAST = 7;

const FONT_IDS = FONT_CHOICES.map((f) => f.id);
const ACCENT_IDS = ACCENT_CHOICES.map((a) => a.id);

/** A known font id, or null ("the template's own") for anything else. */
export const resolveFontChoice = (id) => (FONT_IDS.includes(id) ? id : null);
/** A known accent id, or null ("the template's own") for anything else. */
export const resolveAccentChoice = (id) => (ACCENT_IDS.includes(id) ? id : null);

export const fontById = (id) => FONT_CHOICES.find((f) => f.id === id) ?? null;
export const accentById = (id) => ACCENT_CHOICES.find((a) => a.id === id) ?? null;

/**
 * The theme a template renders with.
 *
 * @param {string} defaultFontId The template's own family (its catalogue `defaultFont`).
 * @param {{ font?: string | null, accent?: string | null }} [design] Stored ids; unknown ones are ignored.
 * @returns {{ faces: { regular: string, bold: string, italic: string, boldItalic: string }, accent: string | null }}
 *   `accent` is a hex, or null for "use the template's own colours".
 */
export function resolveResumeTheme(defaultFontId, design = {}) {
  const font = fontById(resolveFontChoice(design?.font)) ?? fontById(defaultFontId) ?? FONT_CHOICES[0];
  const accent = accentById(resolveAccentChoice(design?.accent));
  return { faces: font.faces, accent: accent ? accent.hex : null };
}

/** WCAG 2.x contrast ratio between two #rrggbb colours. */
export function contrastRatio(hexA, hexB = '#ffffff') {
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [luminance(hexA), luminance(hexB)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
