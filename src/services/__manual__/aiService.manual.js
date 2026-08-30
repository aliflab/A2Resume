/**
 * Manual smoke test for aiService. Not imported by the app and not part of the
 * build -- run it by hand from the browser console (see CLAUDE.md).
 *
 * Exercises every wired provider independently with a trivial prompt + schema.
 * Prints masked keys only; key values are never logged.
 */

import { callStructured, testConnection, SUPPORTED_PROVIDERS } from '../aiService.js';
import { getApiKeys } from '../apiKeyService.js';

const SCHEMA = {
  type: 'object',
  properties: {
    capital: { type: 'string' },
    population_millions: { type: 'number' },
  },
  required: ['capital', 'population_millions'],
};

const SYSTEM_PROMPT = 'You are a precise data extractor. Reply with JSON only.';
const USER_PROMPT = 'What is the capital of Japan and its population in millions?';

const mask = (key) => (key ? `${key.slice(0, 4)}…${key.slice(-2)} (${key.length} chars)` : '(unset)');

/**
 * Run both checks against one provider.
 * @param {'gemini'|'openai'|'deepseek'|'kimi'} provider
 * @param {string} apiKey
 */
export async function testProvider(provider, apiKey) {
  console.group(`[${provider}] ${mask(apiKey)}`);
  const result = { provider, connection: null, structured: null };

  try {
    const started = performance.now();
    result.connection = await testConnection({ provider, apiKey });
    const ms = Math.round(performance.now() - started);
    console.log(result.connection.success ? `✅ connection ok (${ms}ms)` : '❌ connection failed', result.connection);
  } catch (err) {
    result.connection = { success: false, error: err.message, code: err.code };
    console.error('❌ testConnection threw', err);
  }

  try {
    const started = performance.now();
    const { data, model } = await callStructured({
      provider,
      apiKey,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: USER_PROMPT,
      schema: SCHEMA,
    });
    const ms = Math.round(performance.now() - started);
    result.structured = { success: true, model, data };
    console.log(`✅ callStructured ok via ${model} (${ms}ms)`, data);
  } catch (err) {
    result.structured = { success: false, error: err.message, code: err.code, model: err.model };
    console.error('❌ callStructured failed', err);
  }

  console.groupEnd();
  return result;
}

/**
 * Test every wired provider. Pass keys explicitly, or omit to read them from
 * localStorage via apiKeyService.
 * @param {Partial<Record<string, string>>} [keys]
 */
export async function runAll(keys) {
  const source = keys || getApiKeys();
  const results = [];

  for (const provider of SUPPORTED_PROVIDERS) {
    const apiKey = (source[provider] || '').trim();
    if (!apiKey) {
      console.warn(`[${provider}] skipped — no key`);
      results.push({ provider, skipped: true });
      continue;
    }
    results.push(await testProvider(provider, apiKey));
  }

  console.table(
    results.map((r) => ({
      provider: r.provider,
      connection: r.skipped ? 'skipped' : r.connection?.success ? 'ok' : 'FAIL',
      structured: r.skipped ? 'skipped' : r.structured?.success ? 'ok' : 'FAIL',
      model: r.structured?.model || r.connection?.model || '',
    }))
  );

  return results;
}

export default { runAll, testProvider };
