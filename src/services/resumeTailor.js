/**
 * Resume + JD + gap analysis -> a tailored resume, plus a log of what changed.
 *
 * THIS IS THE FIRST SERVICE HERE THAT REWRITES THE CANDIDATE'S WORDS.
 * ------------------------------------------------------------------
 * `resumeParser.js` transcribes and never invents. `skillInference.js` infers
 * but only proposes, and a human approves each item. This one edits prose that
 * will go on a real resume, and there is no per-item approval gate in front of
 * it. That makes the failure mode different in kind: a parser that drops a
 * bullet produces something visibly incomplete, but a tailoring pass that
 * quietly deletes a job, rewrites a date, or invents "improved performance by
 * 40%" produces something that looks *better* while being wrong or dishonest.
 *
 * So the discipline is split across two layers, deliberately:
 *
 *   1. The prompt asks for additive-only editing and forbids invented metrics.
 *   2. `mergeNonDestructiveResume` enforces the structural half of that in
 *      code, against the model's actual output, whether or not the prompt was
 *      followed.
 *
 * Layer 2 is load-bearing, in the same way the jdKeywordExclusions filter is
 * load-bearing on the fallback keyword path. A prompt is an instruction, not a
 * guarantee -- it can fail on an unusual resume, a weaker provider, or a long
 * input where the model starts summarising. Every fact the candidate cannot
 * afford to lose (dates, employment flags, links, whole entries) is restored
 * from the original by code, so the worst a non-compliant model can do is
 * write a weaker bullet, never erase a job.
 *
 * `mergeNonDestructiveResume` reports what it had to correct. That number is
 * the honest measure of how much the safety net is doing -- if it is always
 * zero the model is disciplined; if it is not, the prompt needs work and the
 * net is the only reason the output is safe.
 *
 * Changes what a stored session would contain for the same input? Bump
 * ARTEFACT_VERSION in sessionPersistence.js, so restored results are flagged.
 */

import { callStructured } from './aiService.js';
import { RESUME_SCHEMA } from './resumeParser.js';
import { asArray, asString, asObject } from './gapAnalyzer.js';
import { buildExclusionPromptSection, isExcludedKeyword } from '../utils/jdKeywordExclusions.js';

/**
 * Tailoring gets its own timeout rather than the shared 20s default.
 *
 * This is by far the largest generation in the app: the model returns the
 * entire resume object plus a changesLog entry for every edit, where the
 * parsers return one pass over a much smaller input. Measured runs against a
 * two-role sample resume took ~65s, so the shared default failed every time
 * with "did not respond in time" -- a timeout that looks like a provider fault
 * but is really a budget set for a different kind of call.
 */
export const TAILOR_TIMEOUT_MS = 150_000;

/**
 * Claude effort for the tailoring pass (see AI_EFFORT_LEVELS in aiService.js).
 * "medium": a constrained rewrite -- work JD keywords in honestly, never invent,
 * keep every entry -- which is more judgment than extraction. Not "high": the
 * non-destructive merge and the correction log catch what the model drops, so
 * paying for frontier-depth reasoning buys little here.
 */
export const TAILOR_EFFORT = 'medium';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * The tailored resume travels under `resume` so `changesLog` can sit beside it
 * without polluting the resume shape that every other module reads.
 */
export const TAILOR_SCHEMA = {
  type: 'object',
  properties: {
    resume: RESUME_SCHEMA,

    changesLog: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          section: { type: 'string' },
          target: { type: 'string' },
          before: { type: 'string' },
          after: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * No worked example of a rewritten bullet appears here, for the same reason
 * the parser prompts carry none: a sample "after" bullet with a plausible
 * metric in it teaches the model to produce metrics of that shape rather than
 * metrics grounded in this candidate's material. The XYZ shape is described,
 * not demonstrated.
 */
export const TAILOR_SYSTEM_PROMPT = `You are an experienced resume editor. You are editing one real person's resume so it reads better against one specific job posting. You are not writing a new resume, and you are not a copywriter inventing achievements.

ADDITIVE ONLY -- THIS IS THE RULE THAT MATTERS MOST
You are editing, not replacing. The candidate's history is fact and it is not yours to change.
- Never delete an experience entry, a project, an education entry, or a certification. Every entry present in the input must be present in your output.
- Never delete a bullet. Every bullet in the input must have a counterpart in your output, rewritten or unchanged.
- Never change, shorten, or "tidy" a date, a company name, a job title, an institution, or a degree.
- Never change or drop the isCurrentlyWorking flag on any role. It is a fact about the candidate's employment, not a formatting choice.
- Never drop a link. Every url in the input must appear in your output, on the same entry it came from.
- skills is a UNION, never a replacement. Keep every skill already listed, then add genuinely relevant ones. Removing a skill the candidate claimed is not your decision.

NEVER INVENT A NUMBER
This is the difference between tailoring and lying, and it is the easiest rule to break by accident.
- Only state a metric that the original bullet already contained, or that it clearly implies. If the original says "reduced load time from 1.8s to 340ms", you may keep and reshape those numbers.
- If a bullet gives you no basis for a number, DO NOT ADD ONE. Do not write "improved efficiency by 30%", "increased sales by 15%", or any other figure the source does not support. A percentage that no one can defend in an interview is worse than no percentage at all.
- A bullet with no available metric is still improved by a stronger opening verb, a clearer statement of what was actually built or done, and naming the tools involved. Do that instead.
- Never invent a technology, employer, responsibility, or outcome that the source does not state.

BULLET SHAPE
Rewrite each bullet toward: a strong action verb + what was built or done + with what tools or technology + the impact it had. Apply as much of that shape as the source material genuinely supports, and no more.
- Lead with a specific past-tense action verb. Replace filler openings such as "helped with", "worked on", "responsible for", and "duties included".
- Name the concrete technologies, systems, or tools where the source mentions them.
- Keep the candidate's voice. This is their resume, not a template.
- Do not pad. A shorter honest bullet beats a longer padded one.

RELEVANCE TO THE POSTING
You will be given the keywords this resume is currently missing or only partially matching.
- Work a keyword in only where the candidate's real experience actually supports it. A keyword bolted onto work that does not demonstrate it is a lie that an interview will expose.
- Where the candidate has clearly done the thing but called it something else, prefer the posting's term.
- If a missing keyword has no honest home in this resume, leave it out. Reporting a real gap is more useful than hiding it.

NEVER WRITE THIS LANGUAGE INTO THE RESUME
The keyword list you are given is filtered, but postings are full of language that must never end up in a resume bullet. Do not work any of the following into the resume, and do not add it to skills:
${buildExclusionPromptSection()}
These describe what an employer offers or what any person could claim about themselves. They are not achievements and they do not belong in this candidate's experience.

CHANGES LOG
Record every change you make in changesLog, one entry per changed bullet or field.
- section: which part changed, for example "summary", "experience", "projects", "skills".
- target: which entry it belongs to -- the company name for experience, the project name for projects. Empty string for summary or skills.
- before: the original text, copied exactly. Empty string if you added something new.
- after: your replacement text, copied exactly as it appears in your resume output.
- reason: one short sentence on why the change helps against this posting.
Do not log a change you did not make, and do not make a change you do not log. An unchanged bullet gets no entry.

Return only the json object. No prose, no commentary, no code fences.`;

// ---------------------------------------------------------------------------
// Normalisation helpers used for matching entries across the two objects
// ---------------------------------------------------------------------------

const norm = (v) => asString(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const urlKey = (v) => asString(v).trim().toLowerCase().replace(/\/+$/, '');

/** Identity of an experience entry: employer plus title, both normalised. */
const experienceKey = (entry) => `${norm(asObject(entry).company)}|${norm(asObject(entry).title)}`;

/** Identity of a project entry. */
const projectKey = (entry) => norm(asObject(entry).name);

// ---------------------------------------------------------------------------
// The safety net
// ---------------------------------------------------------------------------

/**
 * Reconcile the model's tailored resume against the original, restoring
 * anything it dropped or altered that it had no business touching.
 *
 * Deterministic and pure: no network, no provider, no randomness. Running it
 * twice on the same pair gives the same answer.
 *
 * WHAT IT ENFORCES
 * - skills: union per category. A category present in either side survives,
 *   and a skill present in the original is never dropped.
 * - contact.customLinks: union, de-duplicated on lowercased url.
 * - experience / projects: any entry in the original that is missing from the
 *   tailored output is restored in its original position.
 * - dates, isCurrentlyWorking, and links on every entry are taken from the
 *   original unconditionally. These are facts; a rewrite has no licence to
 *   change them, so there is no case where the model's version is preferred.
 * - bullets: the model's rewrite is kept, but an entry that came back with no
 *   bullets at all falls back to the original's.
 *
 * WHAT IT DELIBERATELY DOES NOT ENFORCE
 * Bullet *wording*. Rewriting bullets is the entire point of the operation, so
 * the merge cannot second-guess the text without undoing the work. Invented
 * metrics are therefore a prompt-layer concern that this function cannot catch
 * -- which is exactly why the prompt states the no-invented-numbers rule as
 * plainly as it does, and why changesLog shows the user every before/after.
 *
 * @param {unknown} original The parsed resume that went in.
 * @param {unknown} tailored The model's `resume` object.
 * @returns {{ resume: object, corrections: Array<{ type: string, detail: string }> }}
 */
export function mergeNonDestructiveResume(original, tailored) {
  const src = asObject(original);
  const out = asObject(tailored);

  /** @type {Array<{ type: string, detail: string }>} */
  const corrections = [];
  const note = (type, detail) => corrections.push({ type, detail });

  // -- scalars the model may not touch -------------------------------------
  const name = asString(out.name).trim() || asString(src.name);
  if (asString(src.name) && norm(name) !== norm(src.name)) {
    note('name_changed', `name restored to "${asString(src.name)}"`);
  }

  // -- contact --------------------------------------------------------------
  const srcContact = asObject(src.contact);
  const outContact = asObject(out.contact);

  const links = [];
  const seenUrls = new Set();
  for (const link of [...asArray(srcContact.customLinks), ...asArray(outContact.customLinks)]) {
    const entry = asObject(link);
    const key = urlKey(entry.url);
    if (!key) continue;
    if (seenUrls.has(key)) continue;
    seenUrls.add(key);
    links.push({ label: asString(entry.label), url: asString(entry.url).trim() });
  }
  const outLinkList = asArray(outContact.customLinks).map((l) => urlKey(asObject(l).url)).filter(Boolean);
  const outLinkKeys = new Set(outLinkList);
  const droppedLinks = [...new Set(asArray(srcContact.customLinks).map((l) => urlKey(asObject(l).url)).filter(Boolean))]
    .filter((k) => !outLinkKeys.has(k));
  if (droppedLinks.length > 0) {
    note('links_restored', `${droppedLinks.length} contact link(s) restored: ${droppedLinks.join(', ')}`);
  }

  // A duplicate is the model listing one url twice in its OWN output. The
  // overlap between original and tailored is the union working as intended and
  // must not be counted -- doing so reported a correction on identical input.
  const outDuplicates = outLinkList.length - outLinkKeys.size;
  if (outDuplicates > 0) {
    note('links_deduplicated', `${outDuplicates} duplicate contact link(s) collapsed by url`);
  }

  const contact = {
    email: asString(outContact.email).trim() || asString(srcContact.email),
    phone: asString(outContact.phone).trim() || asString(srcContact.phone),
    location: asString(outContact.location).trim() || asString(srcContact.location),
    customLinks: links,
  };

  // -- skills: union per category ------------------------------------------
  const skills = unionSkills(asArray(src.skills), asArray(out.skills), note);

  // -- experience and projects ---------------------------------------------
  const experience = reconcileEntries({
    originals: asArray(src.experience),
    tailoreds: asArray(out.experience),
    keyOf: experienceKey,
    label: 'experience',
    describe: (e) => asString(asObject(e).company) || asString(asObject(e).title) || 'untitled role',
    restoreFields: ['company', 'title', 'location', 'startDate', 'endDate', 'isCurrentlyWorking'],
    note,
  });

  const projects = reconcileEntries({
    originals: asArray(src.projects),
    tailoreds: asArray(out.projects),
    keyOf: projectKey,
    label: 'project',
    describe: (e) => asString(asObject(e).name) || 'untitled project',
    restoreFields: ['name'],
    note,
  });

  // -- education and certifications are facts; never taken from the model ---
  const education = asArray(src.education);
  const certifications = asArray(src.certifications);
  if (asArray(out.education).length < education.length) {
    note('education_restored', `${education.length - asArray(out.education).length} education entry(s) restored`);
  }
  if (asArray(out.certifications).length < certifications.length) {
    note(
      'certifications_restored',
      `${certifications.length - asArray(out.certifications).length} certification(s) restored`
    );
  }

  return {
    resume: {
      name,
      contact,
      summary: asString(out.summary).trim() || asString(src.summary),
      skills,
      experience,
      projects,
      education,
      certifications,
    },
    corrections,
  };
}

/**
 * Union two categorised skill lists. Categories are matched on a normalised
 * name so "Languages" and "languages" do not become two buckets.
 */
function unionSkills(srcGroups, outGroups, note) {
  /** @type {Map<string, { category: string, skills: string[], seen: Set<string> }>} */
  const byCategory = new Map();
  const skillKey = (s) => asString(s).toLowerCase().replace(/[^a-z0-9+#]/g, '');

  const absorb = (groups) => {
    for (const group of groups) {
      const g = asObject(group);
      const category = asString(g.category).trim();
      const key = norm(category);
      if (!byCategory.has(key)) byCategory.set(key, { category, skills: [], seen: new Set() });
      const bucket = byCategory.get(key);
      if (!bucket.category) bucket.category = category;

      for (const skill of asArray(g.skills)) {
        const text = asString(skill).trim();
        const k = skillKey(text);
        if (!k || bucket.seen.has(k)) continue;
        bucket.seen.add(k);
        bucket.skills.push(text);
      }
    }
  };

  // Original first, so the candidate's own ordering and casing win.
  absorb(srcGroups);
  absorb(outGroups);

  // A shrink is measured as "original skills the model did not return", NOT as
  // a drop in total count. Comparing totals misses the common case where the
  // model deletes real skills and adds an equal number of new ones, which nets
  // to zero and looks compliant while having lost the candidate's material.
  const returned = new Set(
    outGroups.flatMap((g) => asArray(asObject(g).skills)).map((sk) => skillKey(asString(sk))).filter(Boolean)
  );
  const missing = [
    ...new Set(
      srcGroups.flatMap((g) => asArray(asObject(g).skills)).map((sk) => asString(sk).trim()).filter(Boolean)
    ),
  ].filter((sk) => !returned.has(skillKey(sk)));

  if (missing.length > 0) {
    note(
      'skills_shrank',
      `${missing.length} original skill(s) missing from the rewrite and restored by union: ${missing.join(', ')}`
    );
  }

  // A skill the model added that is excluded vocabulary should never have been
  // proposed. Drop it rather than write perks into the candidate's skills.
  let stripped = 0;
  for (const bucket of byCategory.values()) {
    const kept = bucket.skills.filter((s) => !isExcludedKeyword(s));
    stripped += bucket.skills.length - kept.length;
    bucket.skills = kept;
  }
  if (stripped > 0) note('excluded_skills_stripped', `${stripped} benefit/trait term(s) removed from skills`);

  return [...byCategory.values()]
    .filter((b) => b.skills.length > 0)
    .map((b) => ({ category: b.category, skills: b.skills }));
}

/**
 * Rebuild a list of entries so that nothing present in the original is lost
 * and no factual field is taken from the model.
 *
 * Matching is by normalised identity first, falling back to position. A model
 * that renames "Kiwibank" to "Kiwibank Ltd" would otherwise look like a delete
 * plus an insert, and the entry would be duplicated.
 */
function reconcileEntries({ originals, tailoreds, keyOf, label, describe, restoreFields, note }) {
  const remaining = new Map();
  tailoreds.forEach((entry, index) => {
    const key = keyOf(entry);
    if (!remaining.has(key)) remaining.set(key, []);
    remaining.get(key).push({ entry, index });
  });

  const usedIndexes = new Set();
  const take = (key, fallbackIndex) => {
    const bucket = remaining.get(key);
    if (bucket && bucket.length > 0) {
      const found = bucket.shift();
      usedIndexes.add(found.index);
      return found.entry;
    }
    // Positional fallback, only if that slot is still unclaimed.
    const candidate = tailoreds[fallbackIndex];
    if (candidate !== undefined && !usedIndexes.has(fallbackIndex)) {
      usedIndexes.add(fallbackIndex);
      return candidate;
    }
    return null;
  };

  return originals.map((originalEntry, index) => {
    const source = asObject(originalEntry);
    const matched = take(keyOf(originalEntry), index);

    if (matched === null) {
      note('entry_restored', `${label} entry "${describe(originalEntry)}" was dropped and has been restored`);
      return originalEntry;
    }

    const edited = asObject(matched);
    const merged = { ...edited };

    // Facts come from the original, always.
    for (const field of restoreFields) {
      const before = source[field];
      const after = edited[field];
      merged[field] = before;

      const differs =
        typeof before === 'boolean' || typeof after === 'boolean'
          ? Boolean(before) !== Boolean(after)
          : norm(before) !== norm(after);

      if (differs && (before !== undefined || after !== undefined)) {
        note(
          `${field}_restored`,
          `${label} "${describe(originalEntry)}": ${field} restored to ${JSON.stringify(before ?? null)} (model returned ${JSON.stringify(after ?? null)})`
        );
      }
    }

    // Links: union, original wins on label, de-duplicated on url.
    const seen = new Set();
    const links = [];
    for (const link of [...asArray(source.links), ...asArray(edited.links)]) {
      const entry = asObject(link);
      const key = urlKey(entry.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      links.push({ label: asString(entry.label), url: asString(entry.url).trim() });
    }
    const editedUrls = new Set(asArray(edited.links).map((l) => urlKey(asObject(l).url)).filter(Boolean));
    const lostLinks = [...new Set(asArray(source.links).map((l) => urlKey(asObject(l).url)).filter(Boolean))].filter(
      (k) => !editedUrls.has(k)
    );
    if (lostLinks.length > 0) {
      note('links_restored', `${label} "${describe(originalEntry)}": ${lostLinks.length} link(s) restored`);
    }
    merged.links = links;

    // Bullets: the rewrite is the point, so it is kept -- unless it is empty,
    // which is a drop rather than an edit.
    const bullets = asArray(edited.bullets).map((b) => asString(b)).filter((b) => b.trim());
    if (bullets.length === 0 && asArray(source.bullets).length > 0) {
      note('bullets_restored', `${label} "${describe(originalEntry)}": all bullets were dropped and have been restored`);
      merged.bullets = asArray(source.bullets);
    } else {
      if (bullets.length < asArray(source.bullets).length) {
        note(
          'bullets_lost',
          `${label} "${describe(originalEntry)}": ${asArray(source.bullets).length - bullets.length} bullet(s) missing from the rewrite`
        );
      }
      merged.bullets = bullets;
    }

    // Non-bullet prose the model may legitimately rewrite.
    if ('description' in source || 'description' in edited) {
      merged.description = asString(edited.description).trim() || asString(source.description);
    }

    return merged;
  });
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/**
 * Keywords worth aiming at: the ones the resume misses or only partially
 * matches. Filtered through the exclusion guard a second time -- the JD parser
 * should already have kept perks out, but this is the point where such a term
 * would be written into the candidate's own prose, which is the worst place
 * for it to end up.
 */
export function collectTargetKeywords(gapAnalysis) {
  const gap = asObject(gapAnalysis);
  const pick = (list) =>
    asArray(list)
      .map((entry) => ({ keyword: asString(asObject(entry).keyword), priority: asString(asObject(entry).priority) }))
      .filter((k) => k.keyword && !isExcludedKeyword(k.keyword));

  const missing = pick(gap.missing);
  const partial = pick(gap.partial);

  const order = { high: 0, medium: 1, low: 2 };
  const sort = (a, b) => (order[a.priority] ?? 3) - (order[b.priority] ?? 3);

  return { missing: missing.sort(sort), partial: partial.sort(sort) };
}

/**
 * Tailor a resume against a job description.
 *
 * The merge runs inside this function rather than being left to the caller, so
 * there is no code path that reaches a page with un-reconciled model output.
 *
 * @param {object} parsedResume Output of parseResumeWithAI.
 * @param {object} parsedJD Output of parseJobDescriptionWithAI.
 * @param {object} gapAnalysis Output of analyzeCompetencyGaps.
 * @param {object} options
 * @param {'gemini'|'openai'|'deepseek'|'kimi'|'claude'} options.provider
 * @param {string} options.apiKey
 * @param {string} [options.model]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{
 *   resume: object,
 *   changesLog: Array<object>,
 *   corrections: Array<{ type: string, detail: string }>,
 *   provider: string,
 *   model: string,
 *   salvaged: boolean,
 * }>}
 */
export async function tailorResumeWithAI(
  parsedResume,
  parsedJD,
  gapAnalysis,
  { provider, apiKey, model, timeoutMs, effort, onModelFallback } = {}
) {
  const resume = asObject(parsedResume);
  if (Object.keys(resume).length === 0) {
    throw new Error('tailorResumeWithAI: parsedResume is empty.');
  }

  const jd = asObject(parsedJD);
  const targets = collectTargetKeywords(gapAnalysis);

  const asList = (items) => (items.length === 0 ? '(none)' : items.map((k) => `${k.keyword} [${k.priority}]`).join(', '));

  const userPrompt = `Tailor this resume for the job posting below.

TARGET ROLE
${asString(jd.jobTitle) || '(not stated)'}${asString(jd.company) ? ` at ${asString(jd.company)}` : ''}

KEYWORDS THE RESUME CURRENTLY MISSES ENTIRELY
${asList(targets.missing)}

KEYWORDS THE RESUME ONLY PARTIALLY MATCHES
${asList(targets.partial)}

RESPONSIBILITIES THE POSTING DESCRIBES
${asArray(jd.responsibilities).map((r) => `- ${asString(r)}`).join('\n') || '(none listed)'}

--- BEGIN RESUME JSON ---
${JSON.stringify(resume, null, 2)}
--- END RESUME JSON ---

Return the edited resume under "resume", and every change you made under "changesLog".`;

  const result = await callStructured({
    provider,
    apiKey,
    model,
    systemPrompt: TAILOR_SYSTEM_PROMPT,
    userPrompt,
    schema: TAILOR_SCHEMA,
    timeoutMs: timeoutMs ?? TAILOR_TIMEOUT_MS,
    effort: effort ?? TAILOR_EFFORT,
    onModelFallback,
  });

  const data = asObject(result.data);
  const { resume: merged, corrections } = mergeNonDestructiveResume(resume, data.resume);

  const changesLog = asArray(data.changesLog)
    .map((entry) => {
      const e = asObject(entry);
      return {
        section: asString(e.section),
        target: asString(e.target),
        before: asString(e.before),
        after: asString(e.after),
        reason: asString(e.reason),
      };
    })
    .filter((e) => e.before || e.after);

  return {
    resume: merged,
    changesLog,
    corrections,
    provider: result.provider,
    model: result.model,
    salvaged: Boolean(result.salvaged),
  };
}
