/**
 * Resume text -> structured JSON, via the shared provider layer.
 *
 * This is a strict extraction task. Nothing here rewrites, improves, or
 * summarises a resume -- that belongs to the tailoring services, later.
 */

import { callStructured, DEFAULT_TIMEOUT_MS } from './aiService.js';
import {
  buildTranscriptionPromptSection,
  checkTranscriptionFidelity,
} from '../utils/transcriptionFidelity.js';

/** Inlined rather than shared via $ref -- not every provider resolves refs. */
const linkArray = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      label: { type: 'string' },
      url: { type: 'string' },
    },
  },
};

export const RESUME_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },

    contact: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        phone: { type: 'string' },
        location: { type: 'string' },
        // Deliberately open-ended: resumes carry arbitrary links, so there is
        // no fixed set of social fields to model.
        customLinks: linkArray,
      },
    },

    summary: { type: 'string' },

    // Categorised, not flat. An array of buckets rather than dynamic object
    // keys, which cannot be expressed under additionalProperties: false.
    skills: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          skills: { type: 'array', items: { type: 'string' } },
        },
      },
    },

    experience: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          company: { type: 'string' },
          title: { type: 'string' },
          location: { type: 'string' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          isCurrentlyWorking: { type: 'boolean' },
          bullets: { type: 'array', items: { type: 'string' } },
          links: linkArray,
        },
      },
    },

    projects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
          links: linkArray,
        },
      },
    },

    education: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          institution: { type: 'string' },
          degree: { type: 'string' },
          field: { type: 'string' },
          location: { type: 'string' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          details: { type: 'array', items: { type: 'string' } },
        },
      },
    },

    certifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          issuer: { type: 'string' },
          date: { type: 'string' },
          url: { type: 'string' },
        },
      },
    },
  },
};

/**
 * No filled-in example appears in this prompt on purpose. A worked example
 * with plausible-looking content invites the model to produce content of the
 * same shape rather than the content actually in the source. The schema is
 * carried by the schema parameter, which describes structure without
 * demonstrating prose.
 */
export const RESUME_SYSTEM_PROMPT = `You are a strict extraction engine. You transcribe an existing resume into structured json. You are not a writer, an editor, or a proofreader.

TRANSCRIBE, DO NOT COMPOSE
- Copy text from the source verbatim. Preserve the original wording, word order, capitalisation, punctuation, and numbers exactly as written.
- Do not rephrase, tighten, expand, translate, or "improve" any text.
- Do not fix spelling, grammar, or formatting errors. Transcribe them as they appear.

${buildTranscriptionPromptSection()}

NEVER INVENT
- Never invent or infer a date, company, job title, employer, degree, institution, certification, skill, or url.
- Never complete a partial value or supply a plausible-looking placeholder.
- If a field is absent from the source, return an empty string for text fields and an empty array for list fields. An empty value is always correct when the source is silent. A guessed value is always wrong.

CAPTURE EVERYTHING
- Every bullet point in the source must appear as its own entry in the relevant bullets array. Do not merge two bullets into one. Do not split one bullet into two. Do not drop, shorten, summarise, or reorder bullets.
- Every url in the source must appear somewhere in the output, exactly as written.
- Links belonging to a specific role, project, or certification go on that entry. Links from the header or contact block go in contact.customLinks.
- For a link label, use the text the source associates with it. If there is none, use the site or domain name. Never invent a description of where the link goes.

FIELD RULES
- Dates: transcribe exactly as written, in the source's own format. Do not normalise or reformat.
- isCurrentlyWorking: true only when the source explicitly marks the role as ongoing, for example "Present", "Current", or "Now". Otherwise false.
- skills: group into the categories the source itself uses. If the source presents skills without categories, use one category named "Skills". Never invent a category the source does not support.

Return only the json object. No prose, no commentary, no code fences.`;

/**
 * @param {string} rawText Extracted resume text.
 * @param {object} options
 * @param {'gemini'|'openai'|'deepseek'|'kimi'|'claude'} options.provider
 * @param {string} options.apiKey
 * @param {string} [options.model] Pin one model, skipping the fallback list.
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ data: object, provider: string, model: string, salvaged: boolean,
 *   fidelityWarnings: { path: string, text: string, unsupportedWords: string[] }[] }>}
 *   `fidelityWarnings` is non-empty when a copied field contains words that
 *   never appear in `rawText` -- see utils/transcriptionFidelity.js. Treat it
 *   like `salvaged`: a signal the prompt did not hold, not something to ignore.
 */
export async function parseResumeWithAI(rawText, { provider, apiKey, model, timeoutMs } = {}) {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    throw new Error('parseResumeWithAI: rawText is empty.');
  }

  const result = await callStructured({
    provider,
    apiKey,
    model,
    systemPrompt: RESUME_SYSTEM_PROMPT,
    userPrompt: `Extract the following resume into the required json structure.

--- BEGIN RESUME ---
${rawText}
--- END RESUME ---`,
    schema: RESUME_SCHEMA,
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  // Backstop for the prompt rule above. A diagnostic sibling of `data`, like
  // `fenced` and `salvaged` -- deliberately NOT merged into `data`, which must
  // stay exactly the schema's shape: `collectResumeText` reads named keys and
  // would be unaffected, but the manual test's `collectStrings` walks every
  // value, and warning text quoting a bullet would make that bullet look
  // captured when it was not.
  return { ...result, fidelityWarnings: checkTranscriptionFidelity(rawText, result.data) };
}
