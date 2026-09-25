/**
 * Manual check for Claude's `output_config.effort`. Not imported by the app,
 * not in the build. Run from the browser console with the dev server up and a
 * Claude key saved in Settings:
 *
 *   const e = await import('/src/services/__manual__/effort.manual.js');
 *   await e.testEffortOffline();           // no key, no network: the request bodies
 *   await e.compareEffort();               // REAL calls: parse at "high" vs the app's setting
 *   await e.compareEffort({ runs: 2 });    // two of each, to see past one noisy request
 *
 * THIS SPENDS THE USER'S MONEY. compareEffort makes 2 x runs Claude calls, each
 * a full resume parse. It prints what it is about to do before the first one.
 *
 * What it proves, and how:
 * - The body actually sent carries `output_config.effort` -- read off a
 *   wrapped `fetch`, not assumed from the code.
 * - "high" is what the app USED to send (omitting effort means high on
 *   Claude Opus 5). The comparison is against that, not against nothing.
 * - Cost is Anthropic's own `usage.output_tokens` (thinking tokens are billed
 *   as output and included there) and wall time per request. Both are noisy;
 *   read the averages, and a single run as an anecdote.
 * - Quality is not assumed either: it prints whether the two parses agree on
 *   the fields that matter and each one's fidelity warnings.
 *
 * Keys are never printed. The key is read from apiKeyService at call time,
 * like InputPage does, or passed in.
 */

import { callStructured } from '../aiService.js';
import { getApiKey } from '../apiKeyService.js';
import { RESUME_PARSE_EFFORT, parseResumeWithAI } from '../resumeParser.js';
import { SAMPLE_RESUME } from './parsers.manual.js';

// ---------------------------------------------------------------------------
// Offline: what goes on the wire
// ---------------------------------------------------------------------------

/**
 * Drive the REAL callStructured path with fetch stubbed: the stub records the
 * body it was handed and answers 400, so nothing leaves the browser and the
 * call fails fast after exactly one request.
 */
async function sentBody(provider, args) {
  let captured = null;
  const original = window.fetch;
  window.fetch = async (url, init) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({ error: { message: 'stubbed' } }), { status: 400 });
  };
  try {
    await callStructured({ provider, apiKey: 'sk-test-not-a-key', userPrompt: 'x', model: PROBE_MODEL[provider], ...args });
  } catch {
    // expected: the stub answers 400
  } finally {
    window.fetch = original;
  }
  return captured;
}

const PROBE_MODEL = { claude: 'claude-opus-5', openai: undefined, deepseek: undefined, kimi: undefined, gemini: undefined };

export async function testEffortOffline() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push(Boolean(ok));
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}`, ok ? '' : (detail ?? ''));
  };
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };

  const dflt = await sentBody('claude', { schema });
  check('effort is always sent, defaulting to "low"', dflt?.output_config?.effort === 'low', dflt);
  const med = await sentBody('claude', { schema, effort: 'medium' });
  check('an explicit "medium" is sent as-is', med?.output_config?.effort === 'medium');
  check('effort does not clobber the structured-output format', med?.output_config?.format?.type === 'json_schema');
  const hi = await sentBody('claude', { schema, effort: 'high' });
  check('...and the format does not clobber effort', hi?.output_config?.effort === 'high' && hi.output_config.format);
  const junk = await sentBody('claude', { schema, effort: 'turbo' });
  check('an unknown effort falls back to the default rather than 400ing', junk?.output_config?.effort === 'low');
  const noSchema = await sentBody('claude', {});
  check('without a schema, effort is still sent', noSchema?.output_config?.effort === 'low');
  check('the resume parse asks for "low"', RESUME_PARSE_EFFORT === 'low');

  // Other providers must not grow an Anthropic parameter.
  for (const id of ['openai', 'deepseek', 'kimi', 'gemini']) {
    const b = await sentBody(id, { schema, effort: 'medium' });
    check(`${id}: no output_config / effort in its body`, b && !/output_config|"effort"/.test(JSON.stringify(b)), JSON.stringify(b).slice(0, 120));
  }

  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `FAIL: ${failed}/${results.length}` : `PASS: ${results.length}/${results.length}`);
  return failed === 0;
}

// ---------------------------------------------------------------------------
// Live: the same parse at two effort levels
// ---------------------------------------------------------------------------

/** Wrap fetch for the duration of `fn`, recording each Anthropic request's effort. */
async function withSentEfforts(fn) {
  const sent = [];
  const original = window.fetch;
  window.fetch = (url, init) => {
    if (String(url).includes('api.anthropic.com')) {
      try {
        const b = JSON.parse(init.body);
        sent.push({ model: b.model, effort: b.output_config?.effort ?? '(omitted)' });
      } catch {
        sent.push({ effort: '(unreadable body)' });
      }
    }
    return original(url, init);
  };
  try {
    return { value: await fn(), sent };
  } finally {
    window.fetch = original;
  }
}

const summarise = (data) => ({
  name: data?.name ?? '',
  roles: (data?.experience ?? []).map((e) => `${e?.title} @ ${e?.company}`).join('; '),
  bullets: (data?.experience ?? []).reduce((n, e) => n + (e?.bullets?.length ?? 0), 0),
  skills: (data?.skills ?? []).reduce((n, g) => n + (g?.skills?.length ?? 0), 0),
});

/**
 * @param {{ apiKey?: string, runs?: number, levels?: string[], text?: string }} [options]
 */
export async function compareEffort({ apiKey, runs = 1, levels = ['high', RESUME_PARSE_EFFORT], text = SAMPLE_RESUME } = {}) {
  const key = apiKey || getApiKey('claude');
  if (!key) throw new Error('No Claude key stored. Save one in Settings, or pass { apiKey }.');
  console.log(`About to make ${runs * levels.length} Claude calls (${levels.join(' vs ')}, ${runs} each), each a full resume parse, on your key.`);

  const rows = [];
  for (let r = 0; r < runs; r += 1) {
    // Alternate the order so a warm-up or a provider hiccup does not always land on the same level.
    const order = r % 2 === 0 ? levels : [...levels].reverse();
    for (const effort of order) {
      const t0 = performance.now();
      const { value, sent } = await withSentEfforts(() => parseResumeWithAI(text, { provider: 'claude', apiKey: key, effort }));
      rows.push({
        effort,
        sentEffort: sent.map((s) => s.effort).join(','),
        model: value.model,
        seconds: +((performance.now() - t0) / 1000).toFixed(1),
        inputTokens: value.usage?.input_tokens ?? null,
        outputTokens: value.usage?.output_tokens ?? null,
        fidelityWarnings: value.fidelityWarnings?.length ?? 0,
        summary: summarise(value.data),
      });
    }
  }

  console.table(rows.map((row) => ({ ...row, summary: undefined })));
  const avg = (effort, field) => {
    const vals = rows.filter((row) => row.effort === effort).map((row) => row[field]).filter((v) => typeof v === 'number');
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const [hi, lo] = levels;
  const report = {
    avgOutputTokens: { [hi]: avg(hi, 'outputTokens'), [lo]: avg(lo, 'outputTokens') },
    avgSeconds: { [hi]: avg(hi, 'seconds'), [lo]: avg(lo, 'seconds') },
    sentAsAsked: rows.every((row) => row.sentEffort.split(',').every((s) => s === row.effort)),
    parsesAgree: rows.every((row) => JSON.stringify(row.summary) === JSON.stringify(rows[0].summary)),
    summaries: rows.map((row) => ({ effort: row.effort, ...row.summary })),
  };
  console.log(report);
  return { rows, report };
}

// Mirrors the Claude entry's fallback list; kept here because the registry is not exported.
const CLAUDE_MODELS = ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-4-6'];

/** One minimal structured call at a given effort -- the cheapest way to see the parameter accepted by every model. */
export async function probeEffortAccepted({ apiKey, effort = 'low' } = {}) {
  const key = apiKey || getApiKey('claude');
  if (!key) throw new Error('No Claude key stored.');
  const out = [];
  for (const model of CLAUDE_MODELS) {
    try {
      const r = await callStructured({
        provider: 'claude',
        apiKey: key,
        model,
        userPrompt: 'Reply with {"ok":true}',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        effort,
      });
      out.push({ model, ok: r.data?.ok === true, outputTokens: r.usage?.output_tokens });
    } catch (err) {
      out.push({ model, ok: false, code: err.code, message: String(err.message).slice(0, 120) });
    }
  }
  console.table(out);
  return out;
}
