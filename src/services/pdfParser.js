/**
 * PDF -> raw text, entirely inside the browser.
 *
 * The file never leaves the machine. That is a hard requirement of this
 * project, not a nice-to-have, so the extraction engine and its worker are
 * both bundled from node_modules and every remote-resource hook pdf.js offers
 * is explicitly nulled out below. See NETWORK NOTE.
 *
 * Output goes to `parseResumeWithAI` in resumeParser.js. This module does no
 * interpretation of its own -- it hands back the text pdf.js found, plus
 * enough diagnostics to tell a real extraction from an empty one.
 */

import * as pdfjsLib from 'pdfjs-dist';
import { MAX_FILE_SIZE, MAX_PAGES } from '../utils/uploadLimits.js';

// The worker is imported as an *asset URL*, so Vite copies pdf.worker.min.mjs
// into dist/ and rewrites this to a same-origin hashed path. Left to itself
// pdf.js guesses a worker location, and several of its guesses are CDNs.
//
// oxlint resolves the specifier literally and cannot see past Vite's `?url`
// query, so it reports a missing default export that exists at build time.
// eslint-disable-next-line import/default
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Size and page caps live in utils/uploadLimits.js and are re-exported here so
 * this module's public API is unchanged. The upload UI needs the numbers to
 * render its hint text, and importing this file to read one would pull pdf.js
 * into the main bundle for every visitor.
 */
export { MAX_FILE_SIZE, MAX_PAGES } from '../utils/uploadLimits.js';

/** Below this many characters we assume the PDF is images, not text. */
const SCANNED_TEXT_THRESHOLD = 100;

const PDF_MIME_TYPES = new Set(['application/pdf', 'application/x-pdf']);

// ---------------------------------------------------------------------------
// NETWORK NOTE
//
// pdf.js can fetch four kinds of auxiliary resource at runtime. All four
// default to null in pdfjs-dist v6, and all four are pinned to null here so a
// future default change cannot quietly open a socket:
//
//   cMapUrl             - character maps for predefined CJK encodings
//   standardFontDataUrl - the 14 standard Type1 fonts
//   iccUrl / wasmUrl    - colour profiles and the wasm image decoders
//
// The cost of leaving cMapUrl null is that a PDF using a predefined CJK
// encoding extracts as garbage rather than text. To support those, copy
// node_modules/pdfjs-dist/cmaps into public/ and point cMapUrl at it -- still
// same-origin, still no egress. None of the four is needed for text
// extraction from a Latin-script resume, which is the case that matters here.
// ---------------------------------------------------------------------------

const NO_REMOTE_RESOURCES = {
  cMapUrl: null,
  standardFontDataUrl: null,
  iccUrl: null,
  wasmUrl: null,
  // We never paint the PDF, so the font machinery is pure cost.
  disableFontFace: true,
  useSystemFonts: false,
  // Defence in depth: pdf.js only evals for font rendering, which is off.
  isEvalSupported: false,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * @typedef {'wrong_type'|'empty_file'|'too_large'|'too_many_pages'|'encrypted'|'corrupt'|'no_text'|'unknown'} PdfErrorCode
 */

export class PdfError extends Error {
  /**
   * @param {PdfErrorCode} code
   * @param {string} message Human-readable, safe to show a user verbatim.
   * @param {{ fileName?: string, cause?: unknown }} [meta]
   */
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'PdfError';
    this.code = code;
    this.fileName = meta.fileName;
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

const formatBytes = (bytes) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Check a File without reading it. Every rejection names the actual problem --
 * a user who picked a .docx and a user who picked a 40 MB scan need different
 * next steps, so they must not share an error message.
 *
 * Exported separately so a drop zone can reject a file before any work starts.
 *
 * @param {File} file
 * @throws {PdfError}
 */
export function validatePdfFile(file) {
  if (!file || typeof file !== 'object' || typeof file.size !== 'number') {
    throw new PdfError('wrong_type', 'No file was provided. Choose a PDF to upload.');
  }

  const name = file.name || 'file';
  const hasPdfExtension = /\.pdf$/i.test(name);
  const hasPdfMime = PDF_MIME_TYPES.has((file.type || '').toLowerCase());

  // Either signal is enough: some browsers hand over an empty type for files
  // dragged from unusual sources, and some tools save PDFs without the
  // extension. Requiring both would reject valid files.
  if (!hasPdfMime && !hasPdfExtension) {
    const seen = file.type ? `"${file.type}"` : `"${name}"`;
    throw new PdfError(
      'wrong_type',
      `${seen} is not a PDF. Only .pdf files can be read here -- export your resume as a PDF and try again.`,
      { fileName: name }
    );
  }

  if (file.size === 0) {
    throw new PdfError(
      'empty_file',
      `"${name}" is empty (0 bytes). The file may have failed to download or save -- re-export it and try again.`,
      { fileName: name }
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new PdfError(
      'too_large',
      `"${name}" is ${formatBytes(file.size)}, over the ${formatBytes(MAX_FILE_SIZE)} limit. Remove embedded images or export a text-only version.`,
      { fileName: name }
    );
  }
}

// ---------------------------------------------------------------------------
// Text assembly
// ---------------------------------------------------------------------------

/**
 * pdf.js returns positioned fragments, not lines. `hasEOL` is its own signal
 * that a fragment ended a visual line, and it is more reliable than
 * reconstructing lines from the transform matrix ourselves.
 *
 * Multi-column layouts still interleave, because fragments arrive in
 * content-stream order rather than reading order. The extraction prompts
 * downstream are written to tolerate that; nothing here tries to fix it.
 *
 * @param {{ items: Array<{ str?: string, hasEOL?: boolean }> }} textContent
 * @returns {string}
 */
function itemsToText(textContent) {
  let out = '';

  for (const item of textContent.items) {
    if (typeof item.str !== 'string') continue; // marked-content markers
    out += item.str;
    if (item.hasEOL) out += '\n';
  }

  return out;
}

/** Collapse the whitespace PDFs are full of, without losing paragraph breaks. */
function tidy(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Read every page of a PDF and return its text.
 *
 * Returns an object rather than a bare string for the same reason
 * `callStructured` does: the diagnostics matter. `isLikelyScanned` in
 * particular is the difference between "this resume is blank" and "this
 * resume is a photograph", and only the caller can decide what to say about
 * that.
 *
 * @param {File} file A .pdf from a file input or a drop event.
 * @param {object} [options]
 * @param {(progress: { page: number, pageCount: number }) => void} [options.onProgress]
 * @returns {Promise<{
 *   text: string,
 *   pageCount: number,
 *   pagesWithText: number,
 *   charCount: number,
 *   isLikelyScanned: boolean,
 *   fileName: string
 * }>}
 * @throws {PdfError}
 */
export async function extractTextFromPdf(file, { onProgress } = {}) {
  validatePdfFile(file);

  const fileName = file.name || 'file.pdf';
  const buffer = await file.arrayBuffer();

  if (buffer.byteLength === 0) {
    throw new PdfError('empty_file', `"${fileName}" read back as empty. Re-export the file and try again.`, {
      fileName,
    });
  }

  // The loading task, not the document proxy, is what owns the worker --
  // `destroy()` lives here. The proxy only has `cleanup()`, which frees parsed
  // pages but leaves the worker running.
  const loadingTask = pdfjsLib.getDocument({
    // pdf.js takes ownership of the typed array and detaches it. The File
    // itself is untouched, so a caller can retry with the same File object.
    data: new Uint8Array(buffer),
    ...NO_REMOTE_RESOURCES,
  });

  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    await loadingTask.destroy().catch(() => {});
    throw toPdfError(err, fileName);
  }

  try {
    const pageCount = doc.numPages;

    if (pageCount > MAX_PAGES) {
      throw new PdfError(
        'too_many_pages',
        `"${fileName}" has ${pageCount} pages, over the ${MAX_PAGES}-page limit. Upload just the resume, not the full portfolio.`,
        { fileName }
      );
    }

    const pages = [];
    let pagesWithText = 0;

    for (let n = 1; n <= pageCount; n += 1) {
      const page = await doc.getPage(n);
      try {
        const pageText = tidy(itemsToText(await page.getTextContent()));
        if (pageText) {
          pages.push(pageText);
          pagesWithText += 1;
        }
      } finally {
        // Each page holds its parsed operator list until told otherwise.
        page.cleanup();
      }
      onProgress?.({ page: n, pageCount });
    }

    // A blank line between pages: a page break is a real boundary, and the
    // extraction prompts read better with it than with pages run together.
    const text = pages.join('\n\n');
    const charCount = text.length;
    const isLikelyScanned = charCount < SCANNED_TEXT_THRESHOLD;

    if (charCount === 0) {
      throw new PdfError(
        'no_text',
        `No text could be read from "${fileName}". It is most likely a scan or an image export -- run it through OCR, or paste the text in directly.`,
        { fileName }
      );
    }

    return { text, pageCount, pagesWithText, charCount, isLikelyScanned, fileName };
  } finally {
    // Tears down the worker. Skipping this leaks one worker per upload.
    await loadingTask.destroy();
  }
}

/** Map pdf.js's own exception names onto our codes. */
function toPdfError(err, fileName) {
  if (err instanceof PdfError) return err;

  const kind = err?.name;

  if (kind === 'PasswordException') {
    return new PdfError(
      'encrypted',
      `"${fileName}" is password-protected. Remove the password, or paste the text in directly.`,
      { fileName, cause: err }
    );
  }

  if (kind === 'InvalidPDFException') {
    return new PdfError(
      'corrupt',
      `"${fileName}" is not a readable PDF -- the file looks damaged, or is a different format with a .pdf name.`,
      { fileName, cause: err }
    );
  }

  return new PdfError('unknown', `Could not read "${fileName}": ${err?.message || 'unknown error'}.`, {
    fileName,
    cause: err,
  });
}
