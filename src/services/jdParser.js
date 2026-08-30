/**
 * Job description text -> structured JSON, via the shared provider layer.
 *
 * Same contract as resumeParser: strict extraction from the posting, never
 * inference about the employer or the role.
 */

import { callStructured, DEFAULT_TIMEOUT_MS } from './aiService.js';

export const JD_SCHEMA = {
  type: 'object',
  properties: {
    jobTitle: { type: 'string' },
    company: { type: 'string' },
    experienceLevel: { type: 'string' },

    // Kept separate on purpose: the gap analyser will weight these differently.
    requiredSkills: { type: 'array', items: { type: 'string' } },
    preferredSkills: { type: 'array', items: { type: 'string' } },

    atsKeywords: {
      type: 'object',
      properties: {
        high: { type: 'array', items: { type: 'string' } },
        medium: { type: 'array', items: { type: 'string' } },
        low: { type: 'array', items: { type: 'string' } },
      },
    },

    actionVerbs: { type: 'array', items: { type: 'string' } },
    responsibilities: { type: 'array', items: { type: 'string' } },
  },
};

export const JD_SYSTEM_PROMPT = `You are a strict extraction engine. You transcribe a job posting into structured json. You are not a recruiter, a summariser, or an editor.

TRANSCRIBE, DO NOT COMPOSE
- Copy text from the source verbatim. Preserve the original wording, capitalisation, and numbers.
- Do not rephrase, expand, or summarise. Do not editorialise about the role or the employer.

NEVER INVENT
- Never invent a company name, job title, seniority level, skill, technology, or responsibility that is not stated in the posting.
- If a field is absent, return an empty string for text fields and an empty array for list fields. An empty value is correct when the posting is silent.

REQUIRED VERSUS PREFERRED
- requiredSkills: skills the posting frames as mandatory, for example under headings like "Requirements", "Must have", "Qualifications", or phrased with "required", "must", "you have".
- preferredSkills: skills the posting frames as optional, for example "Nice to have", "Preferred", "Bonus", "a plus", "desirable".
- A skill belongs in exactly one of the two lists, never both.
- If the posting does not distinguish, place the skill in requiredSkills.

ATS KEYWORDS
Classify each keyword by how strongly the posting emphasises it. Base this only on the posting's own emphasis, never on outside knowledge of the industry.
- high: appears in the job title, or in a mandatory requirement, or is repeated in more than one section.
- medium: stated once in the body as a genuine expectation of the role.
- low: mentioned in passing, listed as optional, or appears only in boilerplate such as benefits or company description.
- A keyword appears in exactly one bucket.

OTHER FIELDS
- experienceLevel: transcribe as stated, for example "Senior", "3-5 years", "Entry level". Empty string if the posting does not say. Never infer a level from the responsibilities.
- actionVerbs: the verbs the posting itself uses to describe the work, as written in the posting.
- responsibilities: one entry per responsibility as written. Do not merge, split, or reorder them.

Return only the json object. No prose, no commentary, no code fences.`;

/**
 * @param {string} jdText Raw job description text.
 * @param {object} options
 * @param {'gemini'|'openai'|'deepseek'|'kimi'|'claude'} options.provider
 * @param {string} options.apiKey
 * @param {string} [options.model] Pin one model, skipping the fallback list.
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ data: object, provider: string, model: string, salvaged: boolean }>}
 */
export async function parseJobDescriptionWithAI(
  jdText,
  { provider, apiKey, model, timeoutMs } = {}
) {
  if (typeof jdText !== 'string' || jdText.trim() === '') {
    throw new Error('parseJobDescriptionWithAI: jdText is empty.');
  }

  return callStructured({
    provider,
    apiKey,
    model,
    systemPrompt: JD_SYSTEM_PROMPT,
    userPrompt: `Extract the following job posting into the required json structure.

--- BEGIN JOB POSTING ---
${jdText}
--- END JOB POSTING ---`,
    schema: JD_SCHEMA,
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}
