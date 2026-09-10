/**
 * Provider-agnostic structured-JSON client.
 *
 * One orchestration loop (timeout, model fallback, 429 backoff, parsing) is
 * shared by every provider. A provider contributes only pure, stateless
 * description: how to build a request, how to pull text out of a response,
 * and how to recognise its own "model not found" signal.
 *
 * Wired this session: "gemini", "openai".
 * Adding "deepseek" | "kimi" | "claude" later = one new entry in PROVIDERS.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 20_000;
export const TEST_TIMEOUT_MS = 8_000;

/** Attempts per model on HTTP 429, including the first. */
const MAX_ATTEMPTS_429 = 3;

/**
 * Statuses that mean "this model is temporarily out of capacity" rather than
 * "something is broken". These fall through to the next model in the ordered
 * list, exactly as a 404 does; every other 5xx still surfaces immediately, so a
 * real server-side bug is never papered over by silently trying four more
 * models.
 *
 * Only status codes are used to make the distinction, because the providers
 * agree on them and the bodies are free text:
 *   503 -- Gemini ("model is currently experiencing high demand"), and the
 *          OpenAI-shaped providers (OpenAI, DeepSeek, Kimi) for server overload.
 *   529 -- Anthropic's documented `overloaded_error`. Anthropic does not use
 *          503 for this, and its 500 is `api_error` (a service fault or bug),
 *          which is exactly what must keep surfacing.
 */
const OVERLOADED_STATUSES = new Set([503, 529]);
const BACKOFF_BASE_MS = 600;
const BACKOFF_MAX_MS = 8_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * @typedef {'auth'|'bad_request'|'rate_limit'|'server'|'timeout'|'network'|'parse'|'no_model'|'blocked'|'unknown'} AiErrorCode
 */

export class AiError extends Error {
  /**
   * @param {AiErrorCode} code
   * @param {string} message Human-readable, safe to show a user.
   * @param {{ provider?: string, model?: string, status?: number, cause?: unknown }} [meta]
   */
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.provider = meta.provider;
    this.model = meta.model;
    this.status = meta.status;
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers -- every provider branch calls into these
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Full jitter exponential backoff. */
function backoffDelay(attempt) {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(Math.random() * ceiling);
}

/**
 * fetch() with an AbortController deadline, normalising abort/network faults.
 * @returns {Promise<{ status: number, ok: boolean, body: any, rawText: string }>}
 */
async function fetchWithTimeout(url, init, timeoutMs, ctx) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new AiError('timeout', `${ctx.provider} timed out after ${timeoutMs}ms.`, {
        ...ctx,
        cause: err,
      });
    }
    throw new AiError('network', `Could not reach ${ctx.provider}. Check your connection.`, {
      ...ctx,
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }

  const rawText = await response.text().catch(() => '');
  let body = null;
  try {
    body = rawText ? JSON.parse(rawText) : null;
  } catch {
    body = null; // Non-JSON error page; rawText is kept for messaging.
  }

  return { status: response.status, ok: response.ok, body, rawText };
}

/**
 * Strip markdown fences, parse JSON, and salvage the first top-level object or
 * array before giving up. Never returns partial or malformed data silently.
 *
 * `fenced` and `salvaged` are diagnostics: either being true means the provider
 * did not return clean JSON, which is a signal that its prompt needs
 * tightening rather than something to paper over.
 *
 * @returns {{ data: any, fenced: boolean, salvaged: boolean }}
 */
export function parseStructuredWithMeta(text, ctx = {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new AiError('parse', 'The model returned an empty response.', ctx);
  }

  let cleaned = text.trim();
  let fenced = false;

  // ```json ... ``` or ``` ... ```
  if (cleaned.startsWith('```')) {
    fenced = true;
    cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/, '');
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();
  }

  try {
    return { data: JSON.parse(cleaned), fenced, salvaged: false };
  } catch (primaryErr) {
    for (const [open, close] of [
      ['{', '}'],
      ['[', ']'],
    ]) {
      const first = cleaned.indexOf(open);
      const last = cleaned.lastIndexOf(close);
      if (first !== -1 && last > first) {
        try {
          return { data: JSON.parse(cleaned.slice(first, last + 1)), fenced, salvaged: true };
        } catch {
          // fall through to the next shape
        }
      }
    }
    throw new AiError('parse', `Could not parse the model's output as JSON: ${primaryErr.message}`, {
      ...ctx,
      cause: primaryErr,
    });
  }
}

/**
 * Parse-only form. Use parseStructuredWithMeta when you care whether the
 * provider needed fence-stripping or salvage.
 * @param {string} text
 * @returns {any}
 */
export function parseStructured(text, ctx = {}) {
  return parseStructuredWithMeta(text, ctx).data;
}

function requireApiKey(provider, apiKey) {
  const clean = (apiKey || '').trim();
  if (!clean) {
    throw new AiError('auth', `No ${provider} API key provided.`, { provider });
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Schema adaptation
//
// The two providers disagree about JSON Schema, so the same caller-supplied
// `schema` has to be bent slightly per provider. This is the one genuinely
// provider-specific transform; keep it here rather than in callers.
// ---------------------------------------------------------------------------

/** OpenAI strict mode demands additionalProperties:false and a full `required`. */
function toOpenAiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(toOpenAiSchema);

  const out = { ...schema };
  if (out.type === 'object') {
    if (out.properties) {
      out.properties = Object.fromEntries(
        Object.entries(out.properties).map(([k, v]) => [k, toOpenAiSchema(v)])
      );
      if (!out.required) out.required = Object.keys(out.properties);
    }
    out.additionalProperties = false;
  }
  if (out.items) out.items = toOpenAiSchema(out.items);
  return out;
}

/** Gemini's responseSchema rejects `additionalProperties` and `$schema`. */
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);

  const { additionalProperties, $schema, ...rest } = schema;
  void additionalProperties;
  void $schema;

  const out = { ...rest };
  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([k, v]) => [k, toGeminiSchema(v)])
    );
  }
  if (out.items) out.items = toGeminiSchema(out.items);
  return out;
}


/**
 * Builds a registry entry for any OpenAI-compatible /chat/completions provider.
 * OpenAI, DeepSeek and Kimi differ only in URL, model list, which JSON mode
 * they accept, and the name of the max-tokens field -- so response reading and
 * model-not-found detection are written once here and shared by all three.
 */
function openAiCompatible({
  label,
  url,
  models,
  supportsJsonSchema,
  maxTokensField = 'max_tokens',
  extraHeaders = {},
}) {
  return {
    label,
    models,
    supportsJsonSchema,

    /**
     * Structured-output strategy for this family: a `response_format` fragment.
     * Providers without json_schema fall back to json_object, which enforces
     * nothing -- so the schema is folded into the system prompt instead.
     */
    structuredMode({ schema, systemPrompt }) {
      if (supportsJsonSchema && schema) {
        return {
          body: {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'structured_output',
                schema: toOpenAiSchema(schema),
                strict: true,
              },
            },
          },
          systemPrompt,
        };
      }
      return {
        body: { response_format: { type: 'json_object' } },
        systemPrompt: withJsonInstruction(systemPrompt, schema),
      };
    },

    buildRequest({ apiKey, model, systemPrompt, userPrompt, schema, maxOutputTokens }) {
      const structured = this.structuredMode({ schema, systemPrompt });

      const messages = [];
      if (structured.systemPrompt) {
        messages.push({ role: 'system', content: structured.systemPrompt });
      }
      messages.push({ role: 'user', content: userPrompt });

      const body = { model, messages, ...structured.body };
      if (maxOutputTokens) body[maxTokensField] = maxOutputTokens;

      return {
        url,
        init: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...extraHeaders,
          },
          body: JSON.stringify(body),
        },
      };
    },

    extractText(body, ctx) {
      const choice = body?.choices?.[0];
      if (choice?.message?.refusal) {
        throw new AiError('blocked', `${label} refused the request: ${choice.message.refusal}`, ctx);
      }
      if (choice?.finish_reason === 'length') {
        throw new AiError('parse', `${label} hit its output token limit before finishing.`, ctx);
      }
      const content = (choice?.message?.content || '').trim();
      if (content === '') {
        // DeepSeek documents this as an occasional json_object failure mode.
        throw new AiError('parse', `${label} returned empty content. Try rephrasing the prompt.`, ctx);
      }
      return content;
    },

    isModelNotFound(status, body) {
      if (status === 404) return true;
      const code = body?.error?.code || '';
      const msg = body?.error?.message || '';
      return (
        code === 'model_not_found' ||
        /does not exist|do not have access|invalid model|unknown model/i.test(msg)
      );
    },

    errorMessage(body, rawText) {
      return body?.error?.message || rawText || '';
    },
  };
}

/**
 * Fold the schema into the system prompt for providers stuck on json_object.
 * Also guarantees the literal word "json" is present, which DeepSeek requires.
 */
function withJsonInstruction(systemPrompt, schema) {
  const instruction = schema
    ? `Respond with a single json object conforming to this JSON Schema:
${JSON.stringify(schema)}
Output json only, with no prose and no code fences.`
    : 'Respond with valid json only, with no prose and no code fences.';

  if (!systemPrompt) return instruction;
  return `${systemPrompt}

${instruction}`;
}

// ---------------------------------------------------------------------------
// Provider registry
//
// Each provider is a plain description. No provider owns any control flow --
// retries, timeouts, fallback and parsing all live in runWithFallback().
// ---------------------------------------------------------------------------

const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    // Ordered best-effort; a 404 falls through to the next entry.
    models: [
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-flash-latest',
    ],

    /** Structured-output strategy: a `generationConfig` fragment. */
    structuredMode({ schema, systemPrompt }) {
      const generationConfig = { responseMimeType: 'application/json' };
      if (schema) generationConfig.responseSchema = toGeminiSchema(schema);
      return { body: { generationConfig }, systemPrompt };
    },

    buildRequest({ apiKey, model, systemPrompt, userPrompt, schema, maxOutputTokens }) {
      const structured = this.structuredMode({ schema, systemPrompt });
      const generationConfig = { ...structured.body.generationConfig };
      // Thinking is on by default on Gemini 3 models and its tokens are drawn
      // from maxOutputTokens, so a small ceiling is spent entirely on thoughts
      // and the answer comes back truncated as finishReason MAX_TOKENS. Floor
      // it, exactly as the Claude entry does for the same reason.
      if (maxOutputTokens) generationConfig.maxOutputTokens = Math.max(maxOutputTokens, 1024);

      const body = {
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig,
      };
      if (structured.systemPrompt) {
        body.systemInstruction = { parts: [{ text: structured.systemPrompt }] };
      }

      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        init: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Header form, not ?key= -- keeps the key out of URLs and logs.
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(body),
        },
      };
    },

    extractText(body, ctx) {
      const blockReason = body?.promptFeedback?.blockReason;
      if (blockReason) {
        throw new AiError('blocked', `Gemini blocked the prompt (${blockReason}).`, ctx);
      }
      const candidate = body?.candidates?.[0];
      if (candidate?.finishReason === 'MAX_TOKENS') {
        throw new AiError('parse', 'Gemini hit its output token limit before finishing.', ctx);
      }
      if (candidate?.finishReason === 'SAFETY') {
        throw new AiError('blocked', 'Gemini stopped the response for safety reasons.', ctx);
      }
      return (candidate?.content?.parts || [])
        .map((part) => part?.text || '')
        .join('')
        .trim();
    },

    isModelNotFound(status, body) {
      if (status === 404) return true;
      const msg = body?.error?.message || '';
      return status === 400 && /not found|not supported|NOT_FOUND/i.test(msg);
    },

    errorMessage(body, rawText) {
      return body?.error?.message || rawText || '';
    },
  },

  openai: openAiCompatible({
    label: 'OpenAI',
    url: 'https://api.openai.com/v1/chat/completions',
    models: ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-4o-mini'],
    supportsJsonSchema: true,
    // Current OpenAI models reject the legacy `max_tokens`.
    maxTokensField: 'max_completion_tokens',
  }),

  deepseek: openAiCompatible({
    label: 'DeepSeek',
    url: 'https://api.deepseek.com/v1/chat/completions',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    // DeepSeek documents json_object only -- no json_schema, no strict mode.
    // The schema is pushed into the prompt instead; see withJsonInstruction().
    supportsJsonSchema: false,
  }),

  kimi: openAiCompatible({
    label: 'Kimi',
    url: 'https://api.moonshot.ai/v1/chat/completions',
    models: ['kimi-k3', 'kimi-k2.6', 'kimi-k2.5'],
    supportsJsonSchema: true,
  }),

  claude: {
    label: 'Claude',
    // Bare IDs only -- never date-suffixed. All four are documented as
    // supporting output_config.format.
    models: ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-4-6'],

    /**
     * Structured-output strategy: `output_config.format`. Anthropic does have a
     * native response-format equivalent, so this needs no tool-use plumbing --
     * the constrained JSON comes back in an ordinary text block.
     */
    structuredMode({ schema, systemPrompt }) {
      if (!schema) return { body: {}, systemPrompt: withJsonInstruction(systemPrompt, schema) };
      return {
        body: {
          output_config: {
            format: { type: 'json_schema', schema: toOpenAiSchema(schema) },
          },
        },
        systemPrompt,
      };
    },

    buildRequest({ apiKey, model, systemPrompt, userPrompt, schema, maxOutputTokens }) {
      const structured = this.structuredMode({ schema, systemPrompt });

      const body = {
        model,
        // Always sent. Thinking is on by default on current models and shares
        // this budget, so a tiny ceiling starves the answer -- floor it.
        max_tokens: maxOutputTokens ? Math.max(maxOutputTokens, 1024) : 16000,
        messages: [{ role: 'user', content: userPrompt }],
        ...structured.body,
      };
      // `system` is a top-level parameter; there is no system message role.
      if (structured.systemPrompt) body.system = structured.systemPrompt;

      return {
        url: 'https://api.anthropic.com/v1/messages',
        init: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            // Required for direct browser calls. Safe here only because the key
            // is the user's own (BYOK) and never leaves their machine.
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify(body),
        },
      };
    },

    extractText(body, ctx) {
      if (body?.stop_reason === 'refusal') {
        const category = body?.stop_details?.category;
        throw new AiError(
          'blocked',
          `Claude declined the request${category ? ` (${category})` : ''}.`,
          ctx
        );
      }
      if (body?.stop_reason === 'max_tokens') {
        throw new AiError('parse', 'Claude hit its output token limit before finishing.', ctx);
      }
      // Skip thinking blocks -- adaptive thinking is on by default.
      const text = (body?.content || [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text || '')
        .join('')
        .trim();
      if (text === '') {
        throw new AiError('parse', 'Claude returned no text content.', ctx);
      }
      return text;
    },

    isModelNotFound(status, body) {
      if (status === 404) return true;
      return body?.error?.type === 'not_found_error';
    },

    errorMessage(body, rawText) {
      return body?.error?.message || rawText || '';
    },
  },
};

export const SUPPORTED_PROVIDERS = Object.keys(PROVIDERS);

/**
 * provider id -> human-readable name, derived from the registry rather than
 * retyped in the UI. A provider's display name is registry metadata; if the
 * UI kept its own copy, adding a provider would mean editing two files and
 * the second one would eventually be forgotten.
 *
 * @type {Record<string, string>}
 */
export const PROVIDER_LABELS = Object.fromEntries(
  Object.entries(PROVIDERS).map(([id, spec]) => [id, spec.label || id])
);

// ---------------------------------------------------------------------------
// Shared orchestration -- the only place control flow lives
// ---------------------------------------------------------------------------

/**
 * Try each candidate model in order. Within a model, retry 429 with backoff.
 * Falls through to the next model on 404 / model-not-found. Never falls across
 * providers.
 *
 * @returns {Promise<{ text: string, model: string, raw: any }>}
 */
async function runWithFallback({ provider, apiKey, models, timeoutMs, buildArgs }) {
  const spec = PROVIDERS[provider];
  let lastError = null;

  for (const model of models) {
    const ctx = { provider, model };
    const { url, init } = spec.buildRequest({ apiKey, model, ...buildArgs });

    for (let attempt = 0; attempt < MAX_ATTEMPTS_429; attempt += 1) {
      const { status, ok, body, rawText } = await fetchWithTimeout(url, init, timeoutMs, ctx);

      if (ok) {
        return { text: spec.extractText(body, ctx), model, raw: body };
      }

      const detail = spec.errorMessage(body, rawText);

      // Capacity fallback: this model is up but full, so try the next one
      // rather than failing the whole call. Bounded by the ordered list --
      // one request per model, and no extra attempts against this one.
      if (OVERLOADED_STATUSES.has(status)) {
        lastError = new AiError(
          'server',
          `${spec.label} is overloaded (${status}). Try again shortly.`,
          { ...ctx, status }
        );
        break; // next model
      }

      // Model-level fallback: checked before the 400 rule, since some
      // providers report an unknown model as a 400.
      if (spec.isModelNotFound(status, body)) {
        lastError = new AiError('no_model', `${spec.label}: model ${model} unavailable.`, {
          ...ctx,
          status,
        });
        break; // next model
      }

      // Non-retryable: surface immediately.
      if (status === 401 || status === 403) {
        throw new AiError(
          'auth',
          `${spec.label} rejected the API key. Check the key and its permissions.`,
          { ...ctx, status }
        );
      }
      if (status === 400) {
        throw new AiError('bad_request', `${spec.label} rejected the request: ${detail}`, {
          ...ctx,
          status,
        });
      }

      // Retryable: 429 only.
      if (status === 429) {
        if (attempt < MAX_ATTEMPTS_429 - 1) {
          await sleep(backoffDelay(attempt));
          continue;
        }
        lastError = new AiError('rate_limit', `${spec.label} is rate limiting requests.`, {
          ...ctx,
          status,
        });
        break; // next model
      }

      // Every remaining 5xx (500, 502, 504, ...) is a fault rather than a
      // capacity limit, so it surfaces immediately instead of falling through.
      if (status >= 500) {
        throw new AiError('server', `${spec.label} server error (${status}). Try again shortly.`, {
          ...ctx,
          status,
        });
      }

      throw new AiError('unknown', `${spec.label} error (${status}): ${detail}`, { ...ctx, status });
    }
  }

  throw (
    lastError ||
    new AiError('no_model', `No ${spec.label} model accepted the request.`, { provider })
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Call a provider and return parsed JSON.
 *
 * @param {object} options
 * @param {'gemini'|'openai'|'deepseek'|'kimi'|'claude'} options.provider
 * @param {string} options.apiKey
 * @param {string} [options.model] Pin a single model, skipping the fallback list.
 * @param {string} [options.systemPrompt]
 * @param {string} options.userPrompt
 * @param {object} [options.schema] JSON Schema; enables strict/structured mode.
 * @param {number} [options.timeoutMs=DEFAULT_TIMEOUT_MS]
 * @returns {Promise<{ data: any, provider: string, model: string }>}
 */
export async function callStructured({
  provider,
  apiKey,
  model,
  systemPrompt,
  userPrompt,
  schema,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const spec = PROVIDERS[provider];
  if (!spec) {
    throw new AiError(
      'bad_request',
      `Unknown provider "${provider}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}.`
    );
  }
  if (typeof userPrompt !== 'string' || userPrompt.trim() === '') {
    throw new AiError('bad_request', 'userPrompt is required.', { provider });
  }

  const key = requireApiKey(provider, apiKey);
  const models = model ? [model] : spec.models;

  const { text, model: usedModel } = await runWithFallback({
    provider,
    apiKey: key,
    models,
    timeoutMs,
    buildArgs: { systemPrompt, userPrompt, schema },
  });

  const { data, fenced, salvaged } = parseStructuredWithMeta(text, {
    provider,
    model: usedModel,
  });
  return { data, provider, model: usedModel, fenced, salvaged };
}

/**
 * Cheapest valid call that proves a key works.
 *
 * @param {{ provider: 'gemini'|'openai'|'deepseek'|'kimi'|'claude', apiKey: string }} options
 * @returns {Promise<{ success: boolean, provider: string, model?: string, error?: string, code?: string }>}
 */
export async function testConnection({ provider, apiKey }) {
  const spec = PROVIDERS[provider];
  if (!spec) {
    return {
      success: false,
      provider,
      error: `Unknown provider "${provider}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}.`,
      code: 'bad_request',
    };
  }

  try {
    const key = requireApiKey(provider, apiKey);
    const { model } = await runWithFallback({
      provider,
      apiKey: key,
      models: spec.models,
      timeoutMs: TEST_TIMEOUT_MS,
      buildArgs: {
        userPrompt: 'Reply with {"ok":true}',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        maxOutputTokens: 16,
      },
    });
    return { success: true, provider, model };
  } catch (err) {
    return {
      success: false,
      provider,
      error: err instanceof AiError ? err.message : 'Connection failed.',
      code: err instanceof AiError ? err.code : 'unknown',
    };
  }
}
