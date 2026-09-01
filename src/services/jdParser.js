/**
 * Job description text -> structured JSON, via the shared provider layer.
 *
 * Same contract as resumeParser: strict extraction from the posting, never
 * inference about the employer or the role.
 */

import { callStructured, DEFAULT_TIMEOUT_MS } from './aiService.js';
import { buildExclusionPromptSection } from '../utils/jdKeywordExclusions.js';

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
- Both lists are SKILLS. The same exclusions listed under ATS KEYWORDS below apply here in
  full: never place an employer benefit, perk, wellbeing or rewards program, culture or
  values phrase, or a generic personality trait in either list. A posting that says it wants
  "a positive attitude and a willingness to learn" is stating a preference about a person,
  not naming a skill -- omit it. If that leaves a list empty, an empty array is correct.

ATS KEYWORDS
atsKeywords is not a digest of the posting. It is the set of terms a candidate could plausibly
write on their own resume, and that an applicant tracking system could match there. Anything a
candidate can never state about themselves is noise: downstream it is reported as a missing
keyword, which manufactures a gap the candidate has no way to close.

ADMIT only terms of these kinds:
- Hard skills, tools, technologies, systems, equipment, machinery, and software.
- Certifications, licences, tickets, clearances, and formal qualifications.
- Role-specific duties, tasks, and domain terminology -- the work itself.
- Named methodologies, standards, and regulations the role must follow.
- Genuine soft skills, but only as the compact competency noun a resume would actually list
  (customer service, teamwork, communication, time management, attention to detail).

EXCLUDE ENTIRELY, from all three buckets:
${buildExclusionPromptSection()}

THE TEST
Before admitting a keyword, ask: could a candidate write this on their resume as something they
have done, hold, or can do? If it is something the employer provides to the candidate, or a
personality adjective claimable without evidence, it fails and is left out.

KEYWORD SHAPE
A keyword is a compact term, not a sentence. Aim for one to four words. Take the noun phrase out
of the posting's sentence and drop the surrounding filler: leading gerunds and articles, trailing
decoration, and any trailing list of adjectives. A whole bullet copied verbatim is not a keyword
-- it can never match a resume literally, which is the same unwinnable gap the exclusion rules
exist to prevent.
- "Being an expert in stock handling by making sure our products are in date" -> "stock handling"
- "Keeping shelves stocked with products so that our customers can find all their favourites"
  -> "stocking shelves"
- "Creating eye-catching displays of our special buys" -> "eye-catching displays"
- "Keeping the store tidy, organised and looking great" -> "store presentation" is WRONG (the
  posting never says that); "keeping the store tidy" is right.

GROUND EVERY KEYWORD IN THE POSTING'S OWN WORDS
The exclusion rules narrow what you admit. They never license you to invent. A keyword must be
the posting's own wording for the thing, not the standard industry term for it. If the posting
says "serving customers at the registers", the keyword is "serving customers at the registers"
or "registers" -- not "cash handling", which the posting never says. If it says "creating
eye-catching displays", the keyword is "displays" -- not "merchandising". Substituting the
conventional term invents a keyword the candidate is then told they are missing, which is the
same harm the exclusion rules exist to prevent.

WORKED DISTINCTION
The lists below are illustrative of the two CATEGORIES only. They are not a vocabulary to draw
from, and no term is to be copied into your output unless the posting itself uses that term.
  category admitted (a candidate could claim it):
           forklift certification, customer service, stock handling, food safety,
           inventory management, manual handling, rostering, teamwork
  category excluded (the employer provides it, or anyone could claim it):
           a positive attitude, a willingness to learn, health insurance, paid parental leave,
           a company-branded wellbeing program, a subsidised fitness scheme, employee assistance
           program, physiotherapy, diversity, inclusive environment, competitive salary,
           staff discount

PRIORITY
Classify each ADMITTED keyword by how strongly the posting emphasises it. Base this only on the
posting's own emphasis, never on outside knowledge of the industry.
- high: appears in the job title, or in a mandatory requirement, or is repeated in more than one section.
- medium: stated once in the body as a genuine expectation of the role.
- low: mentioned in passing, or listed as optional, desirable, or nice to have.
- A keyword appears in exactly one bucket.
- low is not a dumping ground. A term that fails the exclusion rules is omitted from the output
  altogether -- it is never demoted into low. If that leaves a bucket empty, an empty array is
  the correct answer.

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
