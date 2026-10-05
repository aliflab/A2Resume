import { Document, Font, Page, Text, pdf } from '@react-pdf/renderer';

import {
  FontImportError,
  customFamilyNames,
  getFontRecord,
  nameFromFileName,
  newFontId,
  readFontFile,
} from '../../services/fontLibrary.js';

/**
 * The PDF-engine side of imported fonts. Imports @react-pdf/renderer, so it
 * lives behind the lazy boundary with PdfPreview: PdfPreview registers fonts
 * before a render, and Designer loads this module only when a font is imported.
 *
 * WHY AN IMPORT IS PROVED, NOT TRUSTED
 * Every template promises real, selectable text an ATS can read. A font file
 * can break that promise and still look perfect on screen: a missing or wrong
 * ToUnicode mapping makes the PDF draw the right shapes while the text layer
 * says something else. So an import is accepted only after the real engine has
 * parsed it, laid out a probe paragraph in it, written a PDF, and pdf.js has
 * read the same words back out of that PDF -- the same round trip
 * templates.manual.js runs on the templates themselves.
 */

// Words a resume actually contains, including the ligature pairs (fi, ff, fl)
// a font may substitute, since a ligature that extracts wrongly splits a word.
const PROBE = 'Profile: certified engineer, 2026. Quick brown fox jumps over the lazy dog. Office workflow';
const BASIC_LATIN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const noHyphenation = (word) => [word];

const registered = new Set();

/** Registers an imported font with react-pdf, once per page load. False when it is not in the library. */
export function registerCustomFont(fontId) {
  const record = getFontRecord(fontId);
  if (!record) return false;
  if (registered.has(record.id)) return true;
  const family = customFamilyNames(record.id);
  Font.register({ family: family.regular, src: record.regular });
  if (record.bold) Font.register({ family: family.bold, src: record.bold });
  registered.add(record.id);
  return true;
}

/** Code points -> sorted `[first, last]` ranges. Small enough to store beside the font. */
function toRanges(codePoints) {
  const sorted = [...new Set(codePoints)].filter(Number.isInteger).sort((a, b) => a - b);
  const ranges = [];
  for (const cp of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && cp === last[1] + 1) last[1] = cp;
    else ranges.push([cp, cp]);
  }
  return ranges;
}

async function parseFace(file) {
  const read = await readFontFile(file);
  const family = `a2r-probe-${newFontId()}`;
  Font.register({ family, src: read.dataUrl });
  let font;
  try {
    await Font.load({ fontFamily: family });
    font = Font.getFont({ fontFamily: family }).data;
  } catch {
    font = null;
  }
  if (!font?.characterSet) {
    throw new FontImportError(
      'unreadable',
      `${read.name} could not be read as a font. It may be damaged, or use a format this PDF engine does not support.`,
    );
  }
  const os2 = font['OS/2'];
  // The font's own licence flags. react-pdf embeds a subset of every font it
  // uses, so a font that forbids embedding, or forbids subsetting, cannot be
  // put in a PDF without breaking its licence.
  if (os2?.fsType?.noEmbedding || os2?.fsType?.noSubsetting) {
    throw new FontImportError(
      'license',
      `${read.name}'s licence does not allow it to be embedded in documents, so it can't be used in a PDF.`,
    );
  }
  const subfamily = String(font.subfamilyName ?? '');
  return {
    file: read,
    familyName: String(font.getName?.('preferredFamily') || font.familyName || '').trim(),
    weight: os2?.usWeightClass || (/bold|black|heavy/i.test(subfamily) ? 700 : 400),
    italic: Boolean(os2?.fsSelection?.italic) || (font.italicAngle ?? 0) !== 0 || /italic|oblique/i.test(subfamily),
    variable: Object.keys(font.variationAxes ?? {}).length > 0,
    characterSet: font.characterSet,
    hasGlyph: (char) => font.hasGlyphForCodePoint(char.codePointAt(0)),
  };
}

/** Upright faces first, then by distance from the target weight. */
const closestTo = (faces, weight) =>
  [...faces].sort((a, b) => a.italic - b.italic || Math.abs(a.weight - weight) - Math.abs(b.weight - weight))[0];

const normalizeText = (text) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();

/** Renders the probe in the given families and reads it back. Throws when the words do not survive. */
async function proveExtractable(families, label) {
  const doc = (
    <Document>
      <Page size="A5" style={{ padding: 24 }}>
        {families.map((fontFamily) => (
          <Text key={fontFamily} style={{ fontFamily, fontSize: 11, marginBottom: 12 }} hyphenationCallback={noHyphenation}>
            {PROBE}
          </Text>
        ))}
      </Page>
    </Document>
  );
  let blob;
  try {
    blob = await pdf(doc).toBlob();
  } catch {
    throw new FontImportError('render_failed', `${label} could not be used to build a PDF, so it was not imported.`);
  }
  const { extractTextFromPdf } = await import('../../services/pdfParser.js');
  const { text } = await extractTextFromPdf(new File([blob], 'font-check.pdf', { type: 'application/pdf' }));
  const extracted = normalizeText(text);
  const expected = normalizeText(PROBE);
  const found = extracted.split(expected).length - 1;
  if (found < families.length) {
    throw new FontImportError(
      'not_extractable',
      `${label} draws text that can't be read back out of the PDF, so an applicant tracking system would see the wrong words. It was not imported.`,
    );
  }
}

/**
 * The user's chosen files -> a checked font, ready for fontLibrary.addFont:
 * `{ id, name, regular, bold, coverage, bytes, notes }`. Up to one regular and
 * one bold face are used; `notes` says what was skipped or assumed.
 * Throws FontImportError with a message written to be shown as it is.
 */
export async function importFontFiles(fileList) {
  const files = [...(fileList ?? [])];
  if (files.length === 0) throw new FontImportError('no_files', 'Choose a font file to import.');

  const faces = [];
  for (const file of files) faces.push(await parseFace(file));

  const notes = [];
  const regular = closestTo(faces, 400);
  const boldCandidates = faces.filter((f) => f !== regular && !f.italic && f.weight >= 600);
  const bold = boldCandidates.length > 0 ? closestTo(boldCandidates, 700) : null;
  const label = regular.familyName || nameFromFileName(regular.file.name);

  const missingLatin = [...BASIC_LATIN].filter((c) => !regular.hasGlyph(c));
  if (missingLatin.length > 0) {
    throw new FontImportError(
      'no_latin',
      `${label} is missing ${missingLatin.length} of the basic letters and digits a resume needs (${missingLatin.slice(0, 8).join(' ')}${missingLatin.length > 8 ? ' …' : ''}), so it was not imported.`,
    );
  }

  const skipped = faces.filter((f) => f !== regular && f !== bold);
  if (skipped.length > 0) {
    notes.push(`Only a regular and a bold face are used, so ${skipped.map((f) => f.file.name).join(', ')} ${skipped.length === 1 ? 'was' : 'were'} skipped.`);
  }
  if (regular.italic) notes.push('Only an italic face was chosen, so all text will be italic.');
  else if (regular.weight >= 600) notes.push('Only a bold face was chosen, so all text will be bold.');
  if (!bold && regular.weight < 600) {
    notes.push('No bold face was chosen, so headings and job titles use the regular weight. Import the bold file together with the regular one to fix that.');
  }
  if (regular.variable) {
    notes.push('This is a variable font. The PDF uses its default style only, so import a separate bold file for bold headings.');
  }

  const id = newFontId();
  const family = customFamilyNames(id);
  Font.register({ family: family.regular, src: regular.file.dataUrl });
  if (bold) Font.register({ family: family.bold, src: bold.file.dataUrl });
  await proveExtractable(bold ? [family.regular, family.bold] : [family.regular], label);
  registered.add(id);

  return {
    id,
    name: label,
    regular: regular.file.dataUrl,
    bold: bold?.file.dataUrl ?? null,
    coverage: toRanges(regular.characterSet),
    bytes: regular.file.bytes.length + (bold?.file.bytes.length ?? 0),
    notes,
  };
}
