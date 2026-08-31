/**
 * Manual smoke tests for pdfParser and jdScraper. Not imported by the app and
 * not part of the build -- run it by hand from the browser console with the
 * dev server up.
 *
 *   const t = await import('/src/services/__manual__/ingest.manual.js');
 *
 *   await t.pickPdf();       // opens a file picker, extracts, prints a report
 *   await t.testValidation(); // the four rejection paths, no real file needed
 *   await t.testScraper();    // the live proxy chain against real postings
 *   await t.runAll();         // validation + scraper (no picker; needs a click)
 *
 * The PDF half needs a real file, and a real file needs a user gesture, so
 * `pickPdf()` must be called from the console rather than from a runner.
 */

import { extractTextFromPdf, validatePdfFile, PdfError, MAX_FILE_SIZE } from '../pdfParser.js';
import { fetchJobDescriptionFromUrl, ScrapeError, PROXY_IDS } from '../jdScraper.js';

// ===========================================================================
// pdfParser
// ===========================================================================

/**
 * Open a file picker, extract whatever the user chooses, print a report.
 *
 * Call it, pick a resume, read the console. Try it on a normal exported PDF
 * first, then on a two-column template and on a scan -- those are the three
 * cases that behave differently and the only ones worth checking by hand.
 *
 * @returns {Promise<object|null>} The extraction result, or null if cancelled.
 */
export function pickPdf() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.style.display = 'none';
    document.body.appendChild(input);

    // Fires on cancel in browsers that support it; older ones just never
    // resolve, which is fine for a console test.
    input.addEventListener('cancel', () => {
      input.remove();
      console.warn('[pdf] cancelled');
      resolve(null);
    });

    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return resolve(null);
      resolve(await testPdf(file));
    });

    input.click();
    console.log('[pdf] file picker open -- choose a PDF');
  });
}

/**
 * Extract one File and report on it. Useful on its own if you already have a
 * File in hand (from a drop event, say).
 *
 * @param {File} file
 */
export async function testPdf(file) {
  console.group(`[pdf] ${file.name} (${(file.size / 1024).toFixed(0)} KB, type "${file.type}")`);
  const startedAt = performance.now();

  try {
    const result = await extractTextFromPdf(file, {
      onProgress: ({ page, pageCount }) => console.log(`  page ${page}/${pageCount}`),
    });
    const ms = Math.round(performance.now() - startedAt);

    console.log('pages          :', `${result.pagesWithText}/${result.pageCount} contained text`);
    console.log('characters     :', result.charCount);
    console.log('elapsed        :', `${ms} ms`);
    if (result.isLikelyScanned) {
      console.warn('LIKELY A SCAN -- almost no text came back. Needs OCR or manual paste.');
    }

    // The things worth checking by eye. Read the head against the top of the
    // actual resume: a two-column layout shows up here as interleaved
    // fragments, which is expected and which the parser prompt tolerates.
    console.log('--- first 800 chars ---\n' + result.text.slice(0, 800));
    console.log('--- last 300 chars ---\n' + result.text.slice(-300));

    const findings = auditText(result.text);
    if (findings.length) findings.forEach((f) => console.warn('  ' + f));
    else console.log('No obvious extraction defects.');

    console.groupEnd();
    return { ok: true, ms, ...result };
  } catch (err) {
    console.error(`FAILED [${err.code || err.name}] ${err.message}`);
    console.groupEnd();
    return { ok: false, code: err.code, error: err.message };
  }
}

/** Cheap heuristics for the ways PDF text extraction usually goes wrong. */
function auditText(text) {
  const findings = [];

  if (!/[.!?]/.test(text)) findings.push('No sentence punctuation -- text may be garbled.');
  if (!/\b(19|20)\d{2}\b/.test(text)) findings.push('No 4-digit year found -- dates may be missing.');
  if (!/@|\bhttps?:\/\/|\bwww\./.test(text)) findings.push('No email or url found -- contact block may be missing.');

  // Every character spaced apart is the classic bad-font-encoding signature.
  const spacedOut = (text.match(/\b\w \w \w/g) || []).length;
  if (spacedOut > 20) findings.push(`Letter-spacing artefacts (${spacedOut} runs) -- font encoding is off.`);

  // Replacement characters mean a cmap we do not have. See the NETWORK NOTE.
  const replacements = (text.match(/�/g) || []).length;
  if (replacements) findings.push(`${replacements} replacement characters -- unmapped glyphs.`);

  return findings;
}

/**
 * Exercise every rejection path without needing real files on disk. A File
 * built from a Blob is a real File as far as the validator is concerned.
 */
export async function testValidation() {
  const oversize = new File([new Uint8Array(MAX_FILE_SIZE + 1)], 'huge.pdf', { type: 'application/pdf' });

  const cases = [
    ['wrong type (docx)', new File(['x'], 'resume.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'wrong_type'],
    ['wrong type (png)', new File(['x'], 'scan.png', { type: 'image/png' }), 'wrong_type'],
    ['empty file', new File([], 'empty.pdf', { type: 'application/pdf' }), 'empty_file'],
    ['too large', oversize, 'too_large'],
    ['no file at all', null, 'wrong_type'],
    ['extension only, no mime', new File(['x'], 'resume.pdf', { type: '' }), null],
    ['mime only, no extension', new File(['x'], 'resume', { type: 'application/pdf' }), null],
  ];

  const rows = cases.map(([label, file, expected]) => {
    try {
      validatePdfFile(file);
      return { case: label, expected: expected ?? 'accepted', got: 'accepted', pass: expected === null, message: '' };
    } catch (err) {
      const got = err instanceof PdfError ? err.code : err.name;
      return { case: label, expected: expected ?? 'accepted', got, pass: got === expected, message: err.message };
    }
  });

  console.group('[pdf] validation');
  rows.forEach((r) => console.log(r.pass ? 'PASS' : 'FAIL', '|', r.case, '|', r.message));
  console.table(rows);
  console.groupEnd();

  // A .pdf that is not actually a PDF should survive validation and then fail
  // in pdf.js with a specific code, not a generic one.
  const fake = new File(['this is plain text, not a pdf'], 'fake.pdf', { type: 'application/pdf' });
  try {
    await extractTextFromPdf(fake);
    console.error('FAIL | a non-PDF with a .pdf name was accepted');
  } catch (err) {
    console.log(err.code === 'corrupt' ? 'PASS' : 'FAIL', '| non-PDF content ->', err.code, '|', err.message);
  }

  return rows;
}

// ===========================================================================
// jdScraper
// ===========================================================================

/**
 * Real, live postings on three different applicant tracking systems, plus one
 * site that is expected to fail. The first three are server-rendered or
 * client-rendered in different ways, which is the point -- they exercise
 * different parts of the chain.
 *
 * These go stale. When one 404s, pull a fresh id from the board's public API,
 * for example:
 *   https://boards-api.greenhouse.io/v1/boards/gitlab/jobs
 *   https://api.lever.co/v0/postings/matchgroup?mode=json
 *   https://api.ashbyhq.com/posting-api/job-board/openai
 */
export const SAMPLE_JD_URLS = [
  { board: 'Greenhouse', url: 'https://job-boards.greenhouse.io/gitlab/jobs/8503792002' },
  { board: 'Lever', url: 'https://jobs.lever.co/matchgroup/7fca4a70-174c-41a2-b44b-7ff1cb9422e7' },
  { board: 'Ashby (SPA)', url: 'https://jobs.ashbyhq.com/openai/240d459b-696d-43eb-8497-fab3e56ecd9b' },
  { board: 'LinkedIn (expected to fail)', url: 'https://www.linkedin.com/jobs/view/4123456789' },
];

/**
 * Run the chain against one URL and report which proxy won.
 * @param {string} url
 */
export async function testUrl(url, label = url) {
  console.group(`[jd] ${label}`);
  const startedAt = performance.now();

  try {
    const result = await fetchJobDescriptionFromUrl(url, {
      onAttempt: (a) =>
        console.log(`  ${a.ok ? 'OK  ' : 'fail'} ${a.label} (${a.ms} ms)${a.error ? ' -- ' + a.error : ''}`),
    });
    const ms = Math.round(performance.now() - startedAt);

    console.log('winner     :', result.proxy);
    console.log('characters :', result.charCount);
    console.log('elapsed    :', `${ms} ms`);

    const cleanliness = auditScrape(result.text);
    console.log('cleanliness:', cleanliness.verdict, cleanliness.notes.length ? cleanliness.notes : '');
    console.log('--- first 700 chars ---\n' + result.text.slice(0, 700));

    console.groupEnd();
    return { label, ok: true, proxy: result.proxy, chars: result.charCount, ms, ...cleanliness };
  } catch (err) {
    if (err instanceof ScrapeError) {
      console.error(`FAILED [${err.code}] ${err.message}`);
      console.table(err.attempts);
    } else {
      console.error('FAILED', err);
    }
    console.groupEnd();
    return { label, ok: false, proxy: '-', error: err.message, attempts: err.attempts };
  }
}

/** Did the cleaner actually clean it? Markup left behind is the failure mode. */
function auditScrape(text) {
  const notes = [];

  if (/<\/?[a-z][^>]*>/i.test(text)) notes.push('HTML TAGS SURVIVED');
  if (/&(nbsp|amp|lt|gt|quot|#\d+);/i.test(text)) notes.push('UNDECODED HTML ENTITIES');
  if (/function\s*\(|window\.|var\s+\w+\s*=/.test(text)) notes.push('SCRIPT CONTENT SURVIVED');
  if (/\{"[\w$]+":/.test(text)) notes.push('EMBEDDED JSON STATE PRESENT');
  if (/cookie|privacy policy/i.test(text)) notes.push('cookie/privacy boilerplate present (usually harmless)');

  // A real posting says these things. None of them is proof, all of them
  // missing is a strong hint we scraped the wrong region of the page.
  const jdSignals = ['responsib', 'require', 'qualifi', 'experience', 'skills', 'you will', 'about the role'];
  const hits = jdSignals.filter((s) => text.toLowerCase().includes(s));
  if (hits.length < 2) notes.push(`Only ${hits.length} job-description signals found -- may not be the posting.`);

  const verdict = notes.some((n) => n === n.toUpperCase()) ? 'DIRTY' : notes.length ? 'ok, minor noise' : 'clean';
  return { verdict, notes, signals: hits.length };
}

/** Run the whole chain against every sample URL. */
export async function testScraper(urls = SAMPLE_JD_URLS) {
  const rows = [];
  for (const { board, url } of urls) {
    rows.push(await testUrl(url, `${board} -- ${url}`));
  }

  console.group('[jd] summary');
  console.table(rows.map(({ label, ok, proxy, chars, ms, verdict }) => ({ label, ok, proxy, chars, ms, verdict })));
  console.groupEnd();
  return rows;
}

/**
 * Probe each proxy in isolation against one URL. Use this to find out whether
 * a proxy is down generally or just blocked by one site -- the cascade hides
 * that distinction by design.
 */
export async function probeProxies(url = SAMPLE_JD_URLS[0].url) {
  const rows = [];
  for (const id of PROXY_IDS) {
    const startedAt = performance.now();
    try {
      const r = await fetchJobDescriptionFromUrl(url, { only: [id] });
      rows.push({ proxy: id, ok: true, chars: r.charCount, ms: Math.round(performance.now() - startedAt) });
    } catch (err) {
      rows.push({ proxy: id, ok: false, error: err.attempts?.[0]?.error || err.message, ms: Math.round(performance.now() - startedAt) });
    }
  }
  console.table(rows);
  return rows;
}

// ===========================================================================

/**
 * Everything that does not need a user gesture. Call `pickPdf()` separately
 * for the real PDF path.
 */
export async function runAll() {
  const validation = await testValidation();
  const scraper = await testScraper();
  console.warn('PDF extraction itself is not covered here -- run pickPdf() and choose a real resume.');
  return { validation, scraper };
}

export default { pickPdf, testPdf, testValidation, testUrl, testScraper, probeProxies, runAll, SAMPLE_JD_URLS };
