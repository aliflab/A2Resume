/**
 * Fonts the user imported in Designer: their own font files, kept in this
 * browser. Pure storage and validation -- no react-pdf, no React -- so the
 * pages can list fonts without pulling in the PDF engine. Parsing a font and
 * proving it renders is the lazy side's job (components/export/customFonts.js).
 *
 * STORAGE
 * One entry, `a2resume:fonts`, through storageService, beside the session
 * rather than in it: the session is rewritten on every commit (and on a draft
 * autosave debounce), and rewriting a megabyte of font with it would be absurd.
 * A font is a standing preference like the theme, so Start over keeps it;
 * Start over only resets which font is selected (`settings.resumeFont`).
 *
 * Each font is stored as base64 data URLs. react-pdf decodes a base64 data URL
 * in memory (atob, no fetch), so using an imported font opens no socket --
 * the no-network rule holds. A remote URL is never accepted here.
 *
 * BUDGET
 * localStorage is roughly 5M characters per origin, shared with the session
 * (up to ~220k for a heavy one) and the API keys. Base64 costs 4/3, so the
 * library is capped at MAX_LIBRARY_CHARS (2.5M, about 1.8 MB of font files)
 * and a single file at MAX_FONT_FILE_BYTES. A write that still hits the quota
 * is reported, not swallowed, and the stored library is left as it was.
 *
 * Never throws on read: a missing or corrupt entry is an empty library.
 */
import { get, set } from './storageService.js';

const STORAGE_NAME = 'fonts';
const LIBRARY_VERSION = 1;

export const MAX_FONT_FILE_BYTES = 1024 * 1024;
export const MAX_LIBRARY_CHARS = 2_500_000;
export const FONT_FILE_ACCEPT = '.ttf,.otf,.woff,.woff2';

const CUSTOM_PREFIX = 'custom:';

export class FontImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FontImportError';
    this.code = code;
  }
}

/** The id stored in `settings.resumeFont` for an imported font. */
export const customFontId = (id) => `${CUSTOM_PREFIX}${id}`;
export const isCustomFontId = (value) => typeof value === 'string' && value.startsWith(CUSTOM_PREFIX);
const libraryId = (value) => (isCustomFontId(value) ? value.slice(CUSTOM_PREFIX.length) : null);

/**
 * The react-pdf family names a font is registered under. Built from the id,
 * never from the font's own name, so two imports of "Lato" never collide and
 * a font file cannot choose a name that shadows a built-in family.
 */
export const customFamilyNames = (id) => ({ regular: `a2r-font-${id}`, bold: `a2r-font-${id}-bold` });

export const newFontId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------------------
// Reading a file
// ---------------------------------------------------------------------------

/** The format from the first four bytes, which is what actually decides it -- not the file name. */
export function sniffFontFormat(bytes) {
  if (bytes.length < 4) return null;
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (tag === 'OTTO') return 'otf';
  if (tag === 'wOFF') return 'woff';
  if (tag === 'wOF2') return 'woff2';
  if (tag === 'ttcf') return 'collection';
  if (tag === 'true' || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) return 'ttf';
  return null;
}

const toBase64 = (bytes) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/**
 * A File -> `{ name, bytes, format, dataUrl }`, or a FontImportError that names
 * the actual problem. Nothing is parsed here; see customFonts.js.
 */
export async function readFontFile(file) {
  const name = file?.name ?? 'font';
  if (!file || file.size === 0) throw new FontImportError('empty_file', `${name} is empty.`);
  if (file.size > MAX_FONT_FILE_BYTES) {
    throw new FontImportError(
      'too_large',
      `${name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. Fonts up to 1 MB can be imported, because they are stored in your browser. A .woff2 version of the same font is usually much smaller.`,
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = sniffFontFormat(bytes);
  if (format === 'collection') {
    throw new FontImportError('collection', `${name} is a font collection (.ttc). Import the single .ttf or .otf files instead.`);
  }
  if (!format) {
    throw new FontImportError('wrong_type', `${name} is not a font file. Choose a .ttf, .otf, .woff or .woff2 file.`);
  }
  return { name, bytes, format, dataUrl: `data:font/${format};base64,${toBase64(bytes)}` };
}

/** "Lato-Regular.ttf" -> "Lato". Only a fallback for a font with no family name inside it. */
export const nameFromFileName = (fileName) =>
  String(fileName)
    .replace(/\.[^.]+$/, '')
    .replace(/[-_ ]?(regular|bold|italic|book|roman|medium)$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim() || 'Imported font';

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

const isRange = (r) => Array.isArray(r) && r.length === 2 && Number.isInteger(r[0]) && Number.isInteger(r[1]);
const isDataUrl = (v) => typeof v === 'string' && /^data:font\/(ttf|otf|woff2?);base64,[A-Za-z0-9+/=]+$/.test(v);

/** A stored record is used only if every part of it has the right shape. */
function sanitizeRecord(r) {
  if (!r || typeof r !== 'object') return null;
  if (typeof r.id !== 'string' || !/^[0-9a-f]{12}$/.test(r.id)) return null;
  if (typeof r.name !== 'string' || !r.name.trim() || !isDataUrl(r.regular)) return null;
  return {
    id: r.id,
    name: r.name.trim().slice(0, 80),
    regular: r.regular,
    bold: isDataUrl(r.bold) ? r.bold : null,
    coverage: Array.isArray(r.coverage) ? r.coverage.filter(isRange) : [],
    bytes: Number.isFinite(r.bytes) ? r.bytes : 0,
    addedAt: typeof r.addedAt === 'string' ? r.addedAt : null,
  };
}

let records = null;
let metas = [];
const listeners = new Set();

const toMeta = (r) => ({ id: r.id, name: r.name, hasBold: Boolean(r.bold), bytes: r.bytes, coverage: r.coverage });

function load() {
  if (records) return;
  let stored = null;
  try {
    stored = get(STORAGE_NAME);
  } catch {
    stored = null;
  }
  const list = stored?.version === LIBRARY_VERSION && Array.isArray(stored.fonts) ? stored.fonts : [];
  records = list.map(sanitizeRecord).filter(Boolean);
  metas = records.map(toMeta);
}

function commit(next) {
  const chars = next.reduce((n, r) => n + r.regular.length + (r.bold?.length ?? 0), 0);
  if (chars > MAX_LIBRARY_CHARS) {
    throw new FontImportError(
      'library_full',
      'There is not enough room for this font. Remove a font you no longer use, or import a .woff2 version, which is usually much smaller.',
    );
  }
  try {
    set(STORAGE_NAME, { version: LIBRARY_VERSION, fonts: next });
  } catch {
    throw new FontImportError(
      'storage_full',
      "Your browser's storage for this site is full, so the font could not be saved. Remove a font you no longer use and try again.",
    );
  }
  records = next;
  metas = records.map(toMeta);
  listeners.forEach((listener) => listener());
}

/** Imported fonts without their file data: `{ id, name, hasBold, bytes, coverage }[]`. Stable between changes. */
export function listFonts() {
  load();
  return metas;
}

export function subscribeFonts(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The full record, file data included, for a library id or a `custom:` font id. */
export function getFontRecord(idOrFontId) {
  load();
  const id = libraryId(idOrFontId) ?? idOrFontId;
  return records.find((r) => r.id === id) ?? null;
}

/**
 * Stores a font that customFonts.js has already checked. Throws FontImportError
 * when it does not fit. Importing exactly the same files again stores nothing
 * and returns the existing font, flagged `duplicate: true`.
 */
export function addFont({ id, name, regular, bold = null, coverage = [], bytes = 0 }) {
  load();
  const record = sanitizeRecord({ id, name, regular, bold, coverage, bytes, addedAt: new Date().toISOString() });
  if (!record) throw new FontImportError('invalid', 'The font could not be saved.');
  const existing = records.find((r) => r.regular === record.regular && r.bold === record.bold);
  if (existing) return { ...toMeta(existing), duplicate: true };
  commit([...records, record]);
  return toMeta(record);
}

export function removeFont(idOrFontId) {
  load();
  const id = libraryId(idOrFontId) ?? idOrFontId;
  commit(records.filter((r) => r.id !== id));
}
