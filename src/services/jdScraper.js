/**
 * Job posting URL -> clean plain text, for `parseJobDescriptionWithAI`.
 *
 * THE HONEST LIMITATION
 * ---------------------
 * This app has no backend, so the browser must fetch the posting itself. Job
 * boards do not send `Access-Control-Allow-Origin`, so a direct fetch fails on
 * CORS for essentially every real posting. The only thing standing in for a
 * backend here is a chain of free public proxies, and they are genuinely not
 * a substitute for one:
 *
 *   - they go down, with no warning and no status page worth watching
 *   - they rate-limit by IP, which a user shares with everyone behind their NAT
 *   - job boards block them: LinkedIn, Indeed and Glassdoor serve a login wall
 *     or an anti-bot page to datacentre IPs regardless of which proxy asks
 *   - they see the URL being fetched, so a posting URL is not private the way
 *     an uploaded resume is
 *
 * Two of the four public proxies below were returning HTTP 522 for the whole
 * session this module was written, and a third was rate-limiting. That is the
 * normal state of affairs, not an outage worth coding around. The chain exists
 * so that one failure is invisible; when it all fails, `fetchJobDescriptionFromUrl` throws
 * `ScrapeError('all_proxies_failed')` with a message telling the user to
 * paste the job description in directly. Manual paste is the reliable path
 * and always will be -- URL fetching is the convenience on top of it.
 *
 * Do not treat a failure here as a bug to be papered over. Surface it.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Per-proxy budget. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Budget for the whole chain. Without it the worst case is the sum of every
 * per-proxy timeout -- comfortably over a minute of a user watching a
 * spinner, which is long past the point where pasting the text themselves
 * would have been faster. When this runs out the chain stops early and says
 * so, rather than continuing to spend time the user has already lost.
 */
export const TOTAL_TIMEOUT_MS = 45_000;

/**
 * A "successful" fetch that yields less than this is a login wall, an
 * anti-bot page, or an unrendered SPA shell. Treated as a failure so the
 * chain moves on instead of handing a stub to the parser.
 */
const MIN_USEFUL_TEXT = 400;

/**
 * Postings are long, but nothing past this is the posting -- it is related
 * jobs, footer boilerplate and cookie policy. Truncating protects the token
 * budget of the parse that follows.
 */
export const MAX_TEXT_LENGTH = 60_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * @typedef {'bad_url'|'all_proxies_failed'|'no_content'} ScrapeErrorCode
 */

export class ScrapeError extends Error {
  /**
   * @param {ScrapeErrorCode} code
   * @param {string} message Human-readable, safe to show a user verbatim.
   * @param {{ url?: string, attempts?: Array<object>, cause?: unknown }} [meta]
   */
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'ScrapeError';
    this.code = code;
    this.url = meta.url;
    /** Per-proxy outcome, in order tried. Log this when diagnosing. */
    this.attempts = meta.attempts || [];
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

const PASTE_INSTEAD =
  'Copy the job description text from the posting and paste it in directly -- that always works.';

// ---------------------------------------------------------------------------
// The chain
//
// Ordered best-first. `kind` decides how the response body is cleaned:
// 'text' arrives already extracted, 'html' is a raw document.
// ---------------------------------------------------------------------------

const PROXIES = [
  {
    id: 'direct',
    kind: 'html',
    label: 'direct fetch',
    // Free, instant, and leaks nothing to a third party. Works only for the
    // rare posting whose host sends permissive CORS headers -- some ATS JSON
    // endpoints do. Cheap enough to always be worth one attempt.
    build: (url) => url,
    timeoutMs: 8_000,
  },
  {
    id: 'jina',
    kind: 'text',
    label: 'Jina Reader (r.jina.ai)',
    // The one that actually works. It is a reader, not a dumb pipe: it
    // renders JavaScript and returns article text as markdown, so it handles
    // client-rendered boards (Ashby, Workday) that a raw-HTML proxy returns an
    // empty shell for. Keyless tier is IP-rate-limited; there is no key to add
    // here because this app has no backend to hide one behind.
    build: (url) => `https://r.jina.ai/${url}`,
    timeoutMs: 30_000, // it renders the page, so it is the slowest by design
  },
  {
    id: 'corssh',
    kind: 'html',
    label: 'cors.sh',
    // The only fallback observed working. Keyless requests succeeded when
    // this was written, but it rate-limits fast (an HTTP 429 inside one test
    // run) and cors.sh documents an API key for production origins, so expect
    // this one to start 401ing without notice.
    build: (url) => `https://proxy.cors.sh/${url}`,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  },
  {
    id: 'allorigins',
    kind: 'html',
    label: 'AllOrigins',
    // Returning HTTP 522 (Cloudflare: origin unreachable) throughout testing.
    // Kept because it costs nothing when it is up and it has been up before.
    build: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  },
  {
    id: 'codetabs',
    kind: 'html',
    label: 'CodeTabs',
    // Also HTTP 522 throughout testing. Last resort, for the same reason.
    build: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  },
];

export const PROXY_IDS = PROXIES.map((p) => p.id);

// ---------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------

/**
 * Elements that are never the job description. Removed wholesale before the
 * text is read, so their contents cannot leak into the output.
 */
const NOISE_SELECTOR = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'button',
  'select',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]',
].join(',');

/** Where the posting usually lives, best-first. */
const CONTENT_SELECTOR = ['main', 'article', '[role="main"]', '#content', '.content'].join(',');

/**
 * Elements that render as their own line. `textContent` ignores layout
 * entirely, so without this a heading welds itself to the paragraph below it
 * ("Account Executive - ItalyRemote, ItalyGitLab is..."), and a bullet list
 * arrives as one unbroken sentence. That costs the parser real accuracy,
 * since its prompt asks for one entry per responsibility.
 */
const BLOCK_SELECTOR =
  'p,div,br,hr,li,ul,ol,h1,h2,h3,h4,h5,h6,tr,td,th,section,article,pre,blockquote,dt,dd,figcaption';

// ---------------------------------------------------------------------------
// Is this actually a job posting?
//
// Length alone is not enough. LinkedIn answers an unknown job id with a
// verbose sign-in wall and a generic search listing -- 10 kB of real text that
// sails past any size check and is not the posting. Handing that to
// `parseJobDescriptionWithAI` is worse than failing: the parser is a strict
// transcriber, so it faithfully transcribes the wrong page and the user gets
// a confident, wrong result.
//
// The two lists below were tuned against live Greenhouse, Lever, Ashby and
// LinkedIn responses. The real postings hit zero block markers and five
// signals; the LinkedIn wall hit a block marker and three signals. Being
// wrong here is cheap in one direction only -- a false reject just advances
// the chain, and if everything rejects, "paste it in directly" is exactly the
// right advice for a page behind a login.
// ---------------------------------------------------------------------------

/** Phrases that appear on login walls and bot checks, never in a posting. */
const BLOCK_MARKERS = [
  /\bsign in to (?:view|see|continue|apply)/i,
  /\bjoin (?:now|linkedin) to\b/i,
  /\bcreate (?:a free )?account to\b/i,
  /\byou must (?:sign in|log in|be signed in)\b/i,
  /\benable javascript\b/i,
  /\bverify (?:you are|that you are) (?:a )?human\b/i,
  /\bare you a robot\b/i,
  /\baccess (?:to this page )?(?:has been )?denied\b/i,
  /\bunusual traffic\b/i,
  /\bcaptcha\b/i,
];

/** Vocabulary every real posting uses some of. */
const POSTING_SIGNALS = [
  /responsibilit/i,
  /qualificat/i,
  /requirement/i,
  /what you.{0,5}ll do/i,
  /about the (?:role|job|position)/i,
  /\byears of experience\b/i,
  /nice to have/i,
  /preferred/i,
  /\bwe.{0,3}re looking for\b/i,
  /benefits/i,
];

/** Minimum distinct signals before we believe this is a posting. */
const MIN_POSTING_SIGNALS = 2;

/**
 * @param {string} text
 * @returns {string|null} Why this is not a posting, or null if it looks fine.
 */
function rejectionReason(text) {
  if (text.length < MIN_USEFUL_TEXT) {
    return `only ${text.length} chars of text (looks like a block page or an empty shell)`;
  }

  const blocked = BLOCK_MARKERS.find((re) => re.test(text));
  if (blocked) return `page looks like a login wall or bot check (matched ${blocked})`;

  const signals = POSTING_SIGNALS.filter((re) => re.test(text)).length;
  if (signals < MIN_POSTING_SIGNALS) {
    return `only ${signals} job-posting signals found -- this does not read like a job description`;
  }

  return null;
}

/**
 * Raw HTML -> readable text.
 *
 * DOMParser is the right tool rather than a regex: it decodes entities for
 * free, and a document it builds is inert -- scripts do not run, images and
 * stylesheets are not fetched. Parsing hostile HTML here does not itself make
 * a network request.
 *
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  doc.querySelectorAll(NOISE_SELECTOR).forEach((el) => el.remove());

  // Put the line breaks back before reading text. Appending inside each block
  // puts the break at the end of that block's own content, which is where the
  // rendered page would have one.
  doc.querySelectorAll(BLOCK_SELECTOR).forEach((el) => el.append('\n'));

  // Prefer the main content region, but only if stripping to it did not throw
  // the posting away -- plenty of job boards put the description outside any
  // <main>.
  const region = doc.querySelector(CONTENT_SELECTOR);
  const scoped = region?.textContent?.trim() || '';
  const whole = doc.body?.textContent?.trim() || '';
  const text = scoped.length >= MIN_USEFUL_TEXT ? scoped : whole;

  return tidy(text);
}

/**
 * Reader output is markdown, not HTML. It needs far less work -- just the
 * image embeds and link URLs stripped, which are pure token cost to the
 * parser downstream. Link *text* is kept; it is often a skill or a title.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function readerToText(markdown) {
  return tidy(
    markdown
      // Jina prefixes a small header; the URL line is the only useless part.
      .replace(/^URL Source:.*$/gm, '')
      .replace(/^Markdown Content:\s*$/gm, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> their text
      .replace(/^\s*[|:-]{3,}\s*$/gm, '') // table rules
  );
}

/** Shared whitespace normalisation. Paragraph breaks survive; nothing else. */
function tidy(text) {
  const out = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return out.length > MAX_TEXT_LENGTH ? `${out.slice(0, MAX_TEXT_LENGTH).trimEnd()}\n[truncated]` : out;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * @param {string} input
 * @returns {string} The normalised absolute URL.
 * @throws {ScrapeError}
 */
export function normaliseUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ScrapeError('bad_url', 'No URL was provided.');
  }

  const raw = input.trim();
  // Users paste "jobs.lever.co/..." as often as they paste a full URL.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ScrapeError('bad_url', `"${raw}" is not a valid URL. Paste the full link to the job posting.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ScrapeError('bad_url', `Only http and https links can be fetched, not "${parsed.protocol}".`);
  }

  return parsed.toString();
}

/** One proxy, one attempt. Resolves with text or throws. */
async function fetchVia(proxy, url, budgetMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);

  try {
    const response = await fetch(proxy.build(url), {
      signal: controller.signal,
      redirect: 'follow',
      // No credentials: we are reading a public page, and sending cookies to a
      // third-party proxy would be indefensible.
      credentials: 'omit',
      headers: { Accept: 'text/html,text/plain,*/*' },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const body = await response.text();
    const text = proxy.kind === 'text' ? readerToText(body) : htmlToText(body);

    // A 200 OK is not success. Job boards answer bots with a login wall at the
    // same status code as a posting, so the body has to be inspected.
    const reason = rejectionReason(text);
    if (reason) throw new Error(reason);

    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a job posting and return text ready for `parseJobDescriptionWithAI`.
 *
 * Walks the proxy chain in order and returns the first result that looks like
 * a real page. Every failure is recorded rather than swallowed -- read
 * `attempts` on the result or on the thrown error to see what actually
 * happened, which is the only way to tell "the site blocked us" from "the
 * proxy is down".
 *
 * @param {string} url The job posting URL. A bare host is accepted.
 * @param {object} [options]
 * @param {string[]} [options.only] Restrict the chain to these proxy ids.
 * @param {(attempt: { id: string, label: string, ok: boolean, ms: number, error?: string }) => void} [options.onAttempt]
 * @returns {Promise<{ text: string, url: string, proxy: string, charCount: number, attempts: object[] }>}
 * @throws {ScrapeError}
 */
export async function fetchJobDescriptionFromUrl(
  url,
  { only, onAttempt, totalTimeoutMs = TOTAL_TIMEOUT_MS } = {}
) {
  const target = normaliseUrl(url);
  const chain = only ? PROXIES.filter((p) => only.includes(p.id)) : PROXIES;
  const attempts = [];
  const deadline = Date.now() + totalTimeoutMs;

  for (const proxy of chain) {
    const startedAt = Date.now();

    // Never start a proxy we cannot give a fair run at. Anything under a
    // couple of seconds would only time out and pad the log.
    const budgetMs = Math.min(proxy.timeoutMs, deadline - startedAt);
    if (budgetMs < 2_000) {
      const attempt = { id: proxy.id, label: proxy.label, ok: false, ms: 0, error: 'skipped -- overall time budget spent' };
      attempts.push(attempt);
      onAttempt?.(attempt);
      continue;
    }

    try {
      const text = await fetchVia(proxy, target, budgetMs);
      const attempt = { id: proxy.id, label: proxy.label, ok: true, ms: Date.now() - startedAt };
      attempts.push(attempt);
      onAttempt?.(attempt);

      return { text, url: target, proxy: proxy.id, charCount: text.length, attempts };
    } catch (err) {
      const attempt = {
        id: proxy.id,
        label: proxy.label,
        ok: false,
        ms: Date.now() - startedAt,
        // An AbortError here is our own timeout, not the user cancelling.
        error: err?.name === 'AbortError' ? `timed out after ${budgetMs} ms` : err?.message || 'failed',
      };
      attempts.push(attempt);
      onAttempt?.(attempt);
    }
  }

  throw new ScrapeError(
    'all_proxies_failed',
    `Could not read the job posting at ${target}. Every fetch route failed -- the site may block automated access (LinkedIn, Indeed and Glassdoor usually do), or the public proxies this app relies on may be down. ${PASTE_INSTEAD}`,
    { url: target, attempts }
  );
}
