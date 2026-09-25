/**
 * Turn anything thrown by the service layer into something a user can act on.
 *
 * Every service in this project already throws a typed error with a `code`
 * (`AiError`, `PdfError`, `ScrapeError`), and `PdfError` / `ScrapeError`
 * messages were written to be shown verbatim -- those pass through untouched.
 * `AiError` messages are terser and provider-shaped, so they are rewritten
 * here into a sentence that says what to do next.
 *
 * The one thing callers must not do is render `err.message` from an unknown
 * throw straight into the page. A raw stack or a provider's internal JSON is
 * not a user-facing message, and it can carry request detail that has no
 * business on screen.
 */

import { PROVIDER_LABELS } from '../services/aiService.js';

/**
 * `AiError` codes that mean "the key is wrong, missing, or not entitled".
 * These are the only ones worth sending someone to Settings for.
 */
const AUTH_CODES = new Set(['auth']);

const providerName = (provider) => PROVIDER_LABELS[provider] || provider || 'the provider';

/**
 * @typedef {object} DescribedError
 * @property {string} message   Safe to render verbatim.
 * @property {string} code      Original error code, or 'unknown'.
 * @property {string} kind      'ai' | 'pdf' | 'scrape' | 'unknown'
 * @property {boolean} isAuth   Whether to offer a link to Settings.
 * @property {boolean} retryable Whether "try again" is honest advice.
 * @property {string} [hint]    Optional second line.
 */

/**
 * @param {unknown} err
 * @param {{ provider?: string, step?: string }} [context]
 * @returns {DescribedError}
 */
export function describeError(err, context = {}) {
  const { provider } = context;
  const name = err?.name;
  const code = err?.code || 'unknown';

  // Already-user-facing errors from the ingestion layer.
  if (name === 'PdfError') {
    return {
      message: err.message,
      code,
      kind: 'pdf',
      isAuth: false,
      retryable: code === 'unknown',
    };
  }

  if (name === 'ScrapeError') {
    return {
      message: err.message,
      code,
      kind: 'scrape',
      isAuth: false,
      retryable: code === 'all_proxies_failed',
      hint: code === 'all_proxies_failed' ? 'Pasting the text is the reliable path -- it needs no network at all.' : undefined,
    };
  }

  if (name === 'AiError') {
    return describeAiFailure({ code, message: err.message, provider: provider ?? err.provider });
  }

  // Unknown throw. Say so plainly rather than dressing it up as something
  // understood, but do not dump the raw message unqualified.
  return {
    message: `Something went wrong: ${err?.message || 'no details available'}.`,
    code,
    kind: 'unknown',
    isAuth: false,
    retryable: true,
  };
}

/**
 * Describe an AI failure from its code alone.
 *
 * `testConnection` reports failure by *returning* `{ success: false, code,
 * error }` rather than throwing, so there is no `AiError` to hand
 * `describeError`. This is the same mapping by another door -- Settings and
 * the pipeline must not drift into two different explanations of the same
 * code.
 *
 * @param {{ code?: string, message?: string, provider?: string }} failure
 * @returns {DescribedError}
 */
export function describeAiFailure({ code = 'unknown', message = '', provider } = {}) {
  return {
    ...describeAiError({ code, message, provider }, provider),
    code,
    kind: 'ai',
    isAuth: AUTH_CODES.has(code),
  };
}

function describeAiError(err, provider) {
  const who = providerName(provider ?? err.provider);

  switch (err.code) {
    case 'auth':
      return {
        message: `${who} rejected your API key. It may be mistyped, revoked, or not enabled for the model this app uses.`,
        hint: 'Check the key in Settings, then run this again.',
        retryable: false,
      };

    case 'rate_limit':
      return {
        message: `${who} is rate-limiting your key. It retried a few times and kept getting turned away.`,
        hint: 'Wait a minute and try again, or pick a different provider for this run.',
        retryable: true,
      };

    case 'no_model':
      return {
        message: `None of the models this app tries are available on your ${who} account.`,
        hint: 'That usually means the account has no billing set up, or is limited to a different model family.',
        retryable: false,
      };

    case 'timeout':
      return {
        message: `${who} did not respond in time.`,
        hint: 'Long resumes take longer. Try again, or shorten the text.',
        retryable: true,
      };

    case 'network':
      return {
        message: `Could not reach ${who}. Your connection dropped, or a browser extension blocked the request.`,
        retryable: true,
      };

    case 'parse':
      return {
        message: `${who} returned something this app could not read as structured data.`,
        hint: 'This is usually transient. Try again, or use a different provider.',
        retryable: true,
      };

    case 'blocked':
      return {
        message: `${who} declined to process this content.`,
        hint: 'Try a different provider -- their content filters differ.',
        retryable: false,
      };

    case 'bad_request':
      return {
        message: `${who} rejected the request as malformed. The text may be too long for the model's context window.`,
        hint: 'Try trimming the resume or job description.',
        retryable: false,
      };

    case 'server':
      return {
        message: `${who} is having a problem on their end.`,
        hint: 'Not something you can fix. Try again shortly, or use a different provider.',
        retryable: true,
      };

    default:
      return {
        message: `${who} returned an unexpected error: ${err.message}`,
        retryable: true,
      };
  }
}

/**
 * One line for the moment a provider's fallback chain moves to its next model
 * (the `onModelFallback` event from callStructured). Shown as progress, not as
 * an error: the run is still going, it is just going slower.
 *
 * Keyed on the same codes describeAiFailure maps, so "busy" here and
 * "overloaded" there are the same condition seen at two different times. It
 * deliberately does not name the model ids -- "claude-sonnet-4-6" means
 * nothing to most users -- only the provider and how far down the list it is.
 *
 * @param {{ provider?: string, attempt?: number, of?: number, reason?: string } | null} event
 * @returns {string | null}
 */
export function describeModelFallback(event) {
  if (!event) return null;
  const name = providerName(event.provider);
  const why =
    {
      server: `${name}'s first-choice model is overloaded`,
      no_model: `That ${name} model isn't available on your key`,
      rate_limit: `${name} is rate limiting that model`,
    }[event.reason] ?? `${name}'s first-choice model didn't respond`;
  const where = event.attempt && event.of ? ` (${event.attempt} of ${event.of})` : '';
  return `${why}, so this is trying an alternate model${where}. This can take a little longer.`;
}
