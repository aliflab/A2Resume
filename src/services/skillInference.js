/**
 * Skill inference: read described work, propose the skills it evidences.
 *
 * A DIFFERENT OPERATION FROM PARSING -- READ THIS BEFORE EDITING
 * -------------------------------------------------------------
 * `resumeParser.js` is a strict transcriber. Its prompt forbids inventing
 * anything, and that rule is load-bearing: its output is treated as fact by
 * the rest of the app without anyone reviewing it.
 *
 * This module does the opposite thing on purpose. It is *allowed* to infer --
 * "Managing aisles with an Enforcer forklift" evidences "Forklift operation";
 * "Loading and unloading of goods" evidences "Inventory handling". That is
 * not a weakening of the parser's rule, it is a separate operation with a
 * different contract, and the two must not be merged or made to share a
 * prompt:
 *
 *   parser     -> output is fact, no human in the loop, never invents.
 *   inference  -> output is a *proposal*, every item cites its evidence, and
 *                 nothing reaches the resume until a human approves it
 *                 individually.
 *
 * The approval gate is what makes the softer prompt safe. **This function
 * must never mutate `parsedResume`, and its output must never be merged
 * automatically.** It returns suggestions and nothing else; the page renders
 * each with its evidence, and only approved ones are dispatched to
 * `MERGE_INFERRED_SKILLS`.
 *
 * If you ever find yourself wanting to auto-apply these, the correct move is
 * to improve the parser, not to drop the gate.
 */

import { callStructured, DEFAULT_TIMEOUT_MS } from './aiService.js';
import { asArray, asObject, asString } from './gapAnalyzer.js';

/**
 * Claude effort for skill inference (see AI_EFFORT_LEVELS in aiService.js).
 * "medium", one step up from the parsers: unlike them this call IS a judgment
 * -- the confidence rubric asks whether a sentence could be true of someone
 * without the skill -- and it runs once, on request, not per posting.
 */
export const SKILL_INFERENCE_EFFORT = 'medium';

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'];

export const SKILL_INFERENCE_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          skill: { type: 'string' },
          sourceText: { type: 'string' },
          confidence: { type: 'string', enum: CONFIDENCE_LEVELS },
        },
      },
    },
  },
};

/**
 * The confidence rubric is a decision procedure rather than three adjectives.
 *
 * Asking a model for "high/medium/low" without saying what separates them
 * reliably produces one level for everything -- usually "high", because each
 * suggestion looks reasonable considered alone. Each level here is therefore
 * defined by a *test* applied to the source sentence, and the low test is
 * deliberately the interesting one: could this sentence be true of someone
 * who lacks the skill? If yes, it is not high, whatever it feels like.
 */
export const SKILL_INFERENCE_SYSTEM_PROMPT = `You infer skills from described work experience. This is an inference task, not a transcription task: you are expected to name skills the resume demonstrates without naming them outright.

WHAT YOU MAY DO
- Read what the person describes doing, and name the skill that doing it requires.
- Example: "Managing aisles with an Enforcer forklift" evidences "Forklift operation".
- Example: "Loading and unloading of goods" evidences "Inventory handling".
- Example: "Ran the weekly stand-up for a team of six" evidences "Team leadership".

THE ONE HARD RULE: EVERY SUGGESTION MUST BE ANCHORED
- Every suggestion must quote, in sourceText, the exact sentence or bullet from the resume that it was inferred from. Copy it verbatim. Do not paraphrase it, do not shorten it, do not stitch together fragments from different places.
- If you cannot point at a specific line, the skill does not go in the list. No exceptions.
- Never infer from the job title alone, from the employer's industry, or from what someone in that role usually does. Infer only from what this resume says this person did.
- Do not suggest a skill the resume already lists in its skills section.
- Do not restate a technology the text already names as a skill in its own right. "Used PostgreSQL" gives you nothing to infer; skip it.

CONFIDENCE: APPLY THESE TESTS, DO NOT GUESS A FEELING
Work through the tests in order and stop at the first that matches.

- high: The source text names the skill, or names a tool or activity that IS the skill under another word. Someone could not have written this sentence truthfully without having the skill.
  "Managing aisles with an Enforcer forklift" -> "Forklift operation" is high. The sentence cannot be true of someone who cannot operate a forklift.

- medium: The source text describes an activity that ordinarily requires the skill, but the sentence would still be true of someone who did that activity in a limited or assisted way.
  "Loading and unloading of goods" -> "Inventory handling" is medium. The work implies it, but the sentence alone does not establish how much of it they owned.

- low: The skill is plausible given the context, but the source sentence could comfortably be true of someone who does not have it.
  "Worked in a busy warehouse" -> "Time management" is low. Plausible, unestablished.

CALIBRATION CHECK, RUN IT ON EVERY ITEM
Before assigning high, ask: could this exact sentence be true of a person who lacks this skill? If yes, it is not high.
A list where every item has the same confidence is wrong. Real evidence varies in strength, and a flat list tells the reader nothing. If you find yourself assigning the same level repeatedly, you are describing your enthusiasm rather than the evidence.

SCOPE
- Prefer concrete, nameable skills a hiring system would match on over vague traits. "Forklift operation" and "Inventory handling", not "hard working" or "team player".
- Suggest at most 12. Fewer well-anchored suggestions beat a long weak list.
- If the resume describes no work you can anchor a skill to, return an empty suggestions array. That is a valid and correct answer.

Return only the json object. No prose, no commentary, no code fences.`;

/**
 * Build the evidence the model is allowed to reason over.
 *
 * Only experience and project text is included. Passing the whole resume
 * would let the model "infer" a skill from the existing skills list, which is
 * circular, or from education, which is a credential rather than described
 * work. Restricting the input is a cheaper guarantee than asking the prompt
 * to ignore things.
 *
 * @param {unknown} parsedResume
 * @returns {{ text: string, lineCount: number }}
 */
export function collectInferenceEvidence(parsedResume) {
  const resume = asObject(parsedResume);
  const lines = [];

  for (const entry of asArray(resume.experience)) {
    const e = asObject(entry);
    const heading = [asString(e.title), asString(e.company)].filter(Boolean).join(' at ');
    if (heading) lines.push(`ROLE: ${heading}`);
    for (const bullet of asArray(e.bullets)) {
      const b = asString(bullet).trim();
      if (b) lines.push(`- ${b}`);
    }
  }

  for (const entry of asArray(resume.projects)) {
    const p = asObject(entry);
    const name = asString(p.name);
    if (name) lines.push(`PROJECT: ${name}`);
    const description = asString(p.description).trim();
    if (description) lines.push(`- ${description}`);
    for (const bullet of asArray(p.bullets)) {
      const b = asString(bullet).trim();
      if (b) lines.push(`- ${b}`);
    }
  }

  return { text: lines.join('\n'), lineCount: lines.filter((l) => l.startsWith('- ')).length };
}

/** Skills the resume already claims, so the model is not asked to repeat them. */
function existingSkills(parsedResume) {
  return asArray(asObject(parsedResume).skills)
    .flatMap((g) => asArray(asObject(g).skills))
    .map(asString)
    .filter(Boolean);
}

const normalise = (s) => asString(s).toLowerCase().replace(/[^a-z0-9+#]/g, '');

/**
 * Propose skills evidenced by the resume's described work.
 *
 * Does not modify `parsedResume`. Returns proposals for human review.
 *
 * @param {object} parsedResume Output of `parseResumeWithAI`. Any key may be absent.
 * @param {object} options
 * @param {'gemini'|'openai'|'deepseek'|'kimi'|'claude'} options.provider
 * @param {string} options.apiKey
 * @param {string} [options.model] Pin one model, skipping the fallback list.
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{
 *   suggestions: Array<{ skill: string, sourceText: string, confidence: 'high'|'medium'|'low', anchored: boolean }>,
 *   dropped: Array<{ skill: string, reason: string }>,
 *   provider: string,
 *   model: string,
 *   evidenceLines: number
 * }>}
 */
export async function inferSkillsFromExperience(parsedResume, { provider, apiKey, model, timeoutMs, effort, onModelFallback } = {}) {
  const evidence = collectInferenceEvidence(parsedResume);

  if (evidence.text.trim() === '') {
    throw new Error('inferSkillsFromExperience: the resume has no experience or project text to infer from.');
  }

  const already = existingSkills(parsedResume);

  const result = await callStructured({
    provider,
    apiKey,
    model,
    systemPrompt: SKILL_INFERENCE_SYSTEM_PROMPT,
    userPrompt: `Infer skills from the work described below.

${already.length ? `The resume already lists these skills. Do not suggest them again:\n${already.join(', ')}\n` : ''}
--- BEGIN DESCRIBED WORK ---
${evidence.text}
--- END DESCRIBED WORK ---`,
    schema: SKILL_INFERENCE_SCHEMA,
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    effort: effort ?? SKILL_INFERENCE_EFFORT,
    onModelFallback,
  });

  const { suggestions, dropped } = validateSuggestions(asObject(result.data).suggestions, {
    evidenceText: evidence.text,
    already,
  });

  return {
    suggestions,
    dropped,
    provider: result.provider,
    model: result.model,
    evidenceLines: evidence.lineCount,
  };
}

/**
 * Enforce the anchoring rule in code rather than trusting the prompt.
 *
 * The prompt says every suggestion must quote real resume text. A model that
 * ignores that produces an unfalsifiable citation, which is worse than no
 * citation -- it looks like evidence. So each `sourceText` is checked against
 * the evidence actually sent, and anything unanchored is dropped and
 * reported rather than shown to the user.
 *
 * Exported for the manual tests.
 */
export function validateSuggestions(raw, { evidenceText = '', already = [] } = {}) {
  const haystack = normalise(evidenceText);
  const claimed = new Set(already.map(normalise));
  const seen = new Set();

  const suggestions = [];
  const dropped = [];

  for (const item of asArray(raw)) {
    const entry = asObject(item);
    const skill = asString(entry.skill).trim();
    const sourceText = asString(entry.sourceText).trim();

    if (!skill) {
      dropped.push({ skill: '(blank)', reason: 'No skill name.' });
      continue;
    }

    const key = normalise(skill);
    if (!key) {
      dropped.push({ skill, reason: 'Skill name has no usable characters.' });
      continue;
    }
    if (seen.has(key)) {
      dropped.push({ skill, reason: 'Duplicate of an earlier suggestion.' });
      continue;
    }
    if (claimed.has(key)) {
      dropped.push({ skill, reason: 'The resume already lists this skill.' });
      continue;
    }

    if (!sourceText) {
      dropped.push({ skill, reason: 'No source text cited.' });
      continue;
    }

    // The citation must actually appear in what we sent. Whitespace and
    // punctuation are normalised away, so a quote that differs only in
    // spacing still counts; invented text does not.
    const anchored = haystack.includes(normalise(sourceText));
    if (!anchored) {
      dropped.push({ skill, reason: 'Cited source text does not appear in the resume.' });
      continue;
    }

    const confidence = CONFIDENCE_LEVELS.includes(asString(entry.confidence).toLowerCase())
      ? asString(entry.confidence).toLowerCase()
      : 'low'; // An unreadable confidence is treated as the weakest claim.

    seen.add(key);
    suggestions.push({ skill, sourceText, confidence, anchored: true });
  }

  // Strongest evidence first: that is the order a reviewer wants to approve in.
  const rank = { high: 0, medium: 1, low: 2 };
  suggestions.sort((a, b) => rank[a.confidence] - rank[b.confidence]);

  return { suggestions, dropped };
}

/**
 * Does this resume look like it would benefit from inference?
 *
 * True when there are no skills to speak of but there *is* described work to
 * infer from. Offering the button when either half is missing would be
 * offering something that cannot work.
 *
 * @param {unknown} parsedResume
 * @returns {boolean}
 */
export function shouldOfferSkillInference(parsedResume) {
  const skills = asArray(asObject(parsedResume).skills)
    .flatMap((g) => asArray(asObject(g).skills))
    .map(asString)
    .filter((s) => s.trim());

  return skills.length === 0 && collectInferenceEvidence(parsedResume).lineCount > 0;
}
