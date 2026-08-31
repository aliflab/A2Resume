/**
 * Upload policy constants.
 *
 * These live apart from `pdfParser.js` for one reason: bundle size. pdfParser
 * pulls in pdf.js (~440 kB raw), so anything that statically imports it drags
 * the whole PDF engine into that chunk. The upload UI needs to *say* what the
 * limit is long before anyone picks a file, and importing pdfParser just to
 * read a number would put pdf.js in the main bundle for every visitor,
 * including those who never upload anything.
 *
 * `pdfParser.js` re-exports `MAX_FILE_SIZE`, so its public API is unchanged
 * and callers that already have the parser loaded need not know this file
 * exists.
 */

/**
 * Largest PDF we will attempt. Resumes are small; anything past this is a
 * portfolio or a scan, and both cost more than they return.
 */
export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

/** Page ceiling. A resume that runs past this is not a resume. */
export const MAX_PAGES = 30;
