/**
 * Designer's two choices -- accent colour and font -- and how they resolve
 * against a template. No react-pdf import, so the Designer page can render its
 * swatches and dropdown without pulling in the PDF engine (the same rule as
 * resumeTemplates.js).
 *
 * WHAT DESIGNER MAY CHANGE, AND WHAT IT MAY NOT
 * Colour and typeface only. Layout, spacing, margins, sizes and section order
 * belong to the template. A template receives a resolved theme
 * `{ faces, accent }` and decides for itself where those go; nothing here
 * knows a template's styles.
 *
 * FONTS -- THE BUILT-IN THREE, PLUS THE USER'S OWN
 * @react-pdf/font's STANDARD_FONTS are three families, four faces each:
 * Helvetica, Times, Courier. They need no font file and fetch nothing. Those
 * are FONT_CHOICES. A user can also import their own font file in Designer
 * (services/fontLibrary.js); it is stored in this browser and decoded from a
 * data URL, so it fetches nothing either. A remote font URL is never used.
 * An imported font's id is `custom:<id>`, and it only resolves while the font
 * is still in the library -- a removed font falls back to the template's own.
 * The built-ins cover WinAnsi only; an imported font carries its own coverage,
 * which findUnsupportedPdfCharacters takes into account.
 *
 * ACCENTS -- A CURATED PALETTE, PLUS ANY COLOUR
 * The swatches are each >= 7:1 against white (WCAG AAA for normal text), and
 * ACCENT_MIN_CONTRAST is asserted in designer.manual.js. A custom colour can
 * be anything; Designer shows its contrast and warns when a template that
 * draws the accent on text (Modern) would make it hard to read.
 *
 * `null` for either choice means "the template's own", and is what is stored
 * until the user picks something. What is stored is a preset id, a strictly
 * validated `#rrggbb`, or a `custom:` font id that must exist in the library.
 * Anything else resolves to null, so a junk stored value cannot inject an
 * arbitrary style or font.
 */

import { customFamilyNames, customFontId, getFontRecord, isCustomFontId, listFonts } from '../../services/fontLibrary.js';

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
/** Below this, a custom accent drawn on text (Modern) is flagged as hard to read: WCAG AA for normal text. */
export const ACCENT_TEXT_MIN_CONTRAST = 4.5;
/** Below this, a custom accent drawn only as a thin rule is flagged as likely to vanish, on screen or in print. */
export const ACCENT_RULE_MIN_CONTRAST = 1.5;

const FONT_IDS = FONT_CHOICES.map((f) => f.id);
const ACCENT_IDS = ACCENT_CHOICES.map((a) => a.id);
const STORED_HEX = /^#[0-9a-f]{6}$/;

/**
 * What a person types or a colour input gives -> `#rrggbb` (lowercase), or
 * null. Accepts `#abc`, `abc`, `#aabbcc` and `aabbcc`, case-insensitively.
 */
export function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().toLowerCase().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${hex}`;
}

/** Whether a stored accent value is a custom colour rather than a preset id. */
export const isCustomAccent = (value) => typeof value === 'string' && STORED_HEX.test(value);

/** A built-in id, or an imported font still in the library; null ("the template's own") for anything else. */
export function resolveFontChoice(id) {
  if (FONT_IDS.includes(id)) return id;
  return isCustomFontId(id) && getFontRecord(id) ? id : null;
}

/** A preset id, or a custom colour stored as `#rrggbb`; null ("the template's own") for anything else. */
export const resolveAccentChoice = (id) => (ACCENT_IDS.includes(id) || isCustomAccent(id) ? id : null);

/**
 * A font choice with the faces a template draws with. An imported font has no
 * italic of its own, so italic uses the upright faces; with no bold file,
 * bold uses the regular one too, and headings lose their weight.
 */
export function fontById(id) {
  const builtIn = FONT_CHOICES.find((f) => f.id === id);
  if (builtIn) return builtIn;
  if (!isCustomFontId(id)) return null;
  const meta = listFonts().find((f) => customFontId(f.id) === id);
  if (!meta) return null;
  const family = customFamilyNames(meta.id);
  const bold = meta.hasBold ? family.bold : family.regular;
  return {
    id,
    label: meta.name,
    note: meta.hasBold ? 'Imported' : 'Imported, regular only',
    faces: { regular: family.regular, bold, italic: family.regular, boldItalic: bold },
    custom: true,
    hasBold: meta.hasBold,
    coverage: meta.coverage,
  };
}

export function accentById(id) {
  const preset = ACCENT_CHOICES.find((a) => a.id === id);
  if (preset) return preset;
  return isCustomAccent(id) ? { id, label: `Custom ${id.toUpperCase()}`, hex: id, custom: true } : null;
}

/**
 * The theme a template renders with.
 *
 * @param {string} defaultFontId The template's own family (its catalogue `defaultFont`).
 * @param {{ font?: string | null, accent?: string | null }} [design] Stored values; unknown ones are ignored.
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
