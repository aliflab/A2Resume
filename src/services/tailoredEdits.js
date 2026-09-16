/**
 * Hand edits to the tailored resume.
 *
 * Pure and React-free, like the other services: the reducer calls
 * applyTailoredEdit, the editor calls toDraft and toggleCurrentlyWorking, and
 * __manual__/tailorEditor.manual.js asserts all of it without a browser.
 *
 * ONE SECTION (OR ONE ENTRY) AT A TIME
 * An edit names a section, and for list sections an entry index, and replaces
 * only that. Nothing else in the resume is rewritten, so a save in the
 * Education block cannot disturb an experience bullet, and every write can be
 * described ("Experience: Senior Engineer — Acme") in the edit log below.
 *
 * DRAFT vs COMMIT
 * `toDraft` turns a stored value into a form-friendly shape of plain strings
 * (the tailored resume can hold undefined fields, verbatim-restored entries,
 * DeepSeek's unenforced shapes). The committers turn a draft back into stored
 * shape: trimmed, blank bullets dropped, links without a url dropped. Entries
 * keep any fields the editor does not know about.
 *
 * NO-OP SAVES ARE NOT EDITS
 * A save is compared against the stored value put through the same
 * draft-then-commit round trip, not against the raw value. Otherwise opening a
 * restored entry that lacks `location` and pressing Save would write
 * `location: ''`, change nothing visible, and still be logged as a manual edit.
 */

import { asArray, asObject, asString } from './gapAnalyzer.js';

export const EDITABLE_SECTIONS = ['header', 'summary', 'skills', 'experience', 'projects', 'education', 'certifications'];

/** Sections edited one entry at a time, addressed by index. */
export const LIST_SECTIONS = ['experience', 'projects', 'education', 'certifications'];

export const SECTION_LABELS = {
  header: 'Header and contact',
  summary: 'Summary',
  skills: 'Skills',
  experience: 'Experience',
  projects: 'Projects',
  education: 'Education',
  certifications: 'Certifications',
};

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const str = (value) => asString(value).trim();
const lines = (value) => asArray(value).map(str).filter(Boolean);
const asFlag = (value) => value === true || value === 'true';

const linkDrafts = (value) =>
  asArray(value).map((link) => ({ label: asString(asObject(link).label), url: asString(asObject(link).url) }));

/** A link is its url. One without a url cannot be printed, so it is not kept. */
const commitLinks = (value) =>
  asArray(value)
    .map((link) => ({ label: str(asObject(link).label), url: str(asObject(link).url) }))
    .filter((link) => link.url);

/** End-date words that mean "still here". Typed into End date, they set the flag instead. */
const PRESENT_WORDS = /^(present|current|now|to date|ongoing)$/i;
export const isPresentWord = (value) => PRESENT_WORDS.test(str(value));

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/**
 * A stored value as a form draft: every field a string (or a list of them).
 *
 * `header` takes the whole resume (it covers `name` and `contact`); a list
 * section takes one entry; `summary` a string; `skills` the group array.
 */
export function toDraft(section, value) {
  const v = asObject(value);
  switch (section) {
    case 'header': {
      const contact = asObject(v.contact);
      return {
        name: asString(v.name),
        email: asString(contact.email),
        phone: asString(contact.phone),
        location: asString(contact.location),
        customLinks: linkDrafts(contact.customLinks),
      };
    }
    case 'summary':
      return asString(value);
    case 'skills':
      return asArray(value).map((group) => ({
        category: asString(asObject(group).category),
        skills: lines(asObject(group).skills),
      }));
    case 'experience': {
      // A parse that wrote "Present" as the end date means the same thing as
      // the flag. The draft shows it one way only: flag on, end date empty.
      const current = asFlag(v.isCurrentlyWorking) || isPresentWord(v.endDate);
      return {
        title: asString(v.title),
        company: asString(v.company),
        location: asString(v.location),
        startDate: asString(v.startDate),
        endDate: current ? '' : asString(v.endDate),
        isCurrentlyWorking: current,
        bullets: asArray(v.bullets).map(asString),
        links: linkDrafts(v.links),
      };
    }
    case 'projects':
      return {
        name: asString(v.name),
        description: asString(v.description),
        bullets: asArray(v.bullets).map(asString),
        links: linkDrafts(v.links),
      };
    case 'education':
      return {
        institution: asString(v.institution),
        degree: asString(v.degree),
        field: asString(v.field),
        location: asString(v.location),
        startDate: asString(v.startDate),
        endDate: asString(v.endDate),
        details: asArray(v.details).map(asString),
      };
    case 'certifications':
      return { name: asString(v.name), issuer: asString(v.issuer), date: asString(v.date), url: asString(v.url) };
    default:
      return null;
  }
}

/**
 * The "I currently work here" checkbox, on a draft.
 *
 * Checking it empties End date, because a current role prints "Present" and a
 * leftover end date would print instead (formatDateRange prefers a written
 * end date). The cleared date is handed back as `stash` so unchecking again
 * restores it rather than making the user retype it. A stashed "Present" is
 * not restored: unchecking means the role ended, so it gets an empty field.
 *
 * @returns {{ draft: object, stash: string }}
 */
export function toggleCurrentlyWorking(draft, checked, stash = '') {
  const d = asObject(draft);
  if (checked) {
    const end = asString(d.endDate);
    return { draft: { ...d, isCurrentlyWorking: true, endDate: '' }, stash: isPresentWord(end) ? '' : end };
  }
  return { draft: { ...d, isCurrentlyWorking: false, endDate: isPresentWord(stash) ? '' : asString(stash) }, stash: '' };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

function commitHeader(draft, resume) {
  const d = asObject(draft);
  return {
    name: str(d.name),
    contact: {
      ...asObject(resume.contact),
      email: str(d.email),
      phone: str(d.phone),
      location: str(d.location),
      customLinks: commitLinks(d.customLinks),
    },
  };
}

/**
 * Categories are matched case-insensitively, so moving a skill into a category
 * that was renamed to match another merges the two rather than printing the
 * same heading twice. A skill appears once per category; empty categories go.
 */
function commitSkills(draft) {
  const byKey = new Map();
  for (const group of asArray(draft)) {
    const category = str(asObject(group).category);
    const key = category.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, { category, skills: [], seen: new Set() });
    const bucket = byKey.get(key);
    for (const skill of lines(asObject(group).skills)) {
      const k = skill.toLowerCase();
      if (bucket.seen.has(k)) continue;
      bucket.seen.add(k);
      bucket.skills.push(skill);
    }
  }
  return [...byKey.values()].filter((b) => b.skills.length > 0).map(({ category, skills }) => ({ category, skills }));
}

const COMMIT_ENTRY = {
  experience: (draft, current) => {
    const d = asObject(draft);
    let endDate = str(d.endDate);
    let isCurrentlyWorking = d.isCurrentlyWorking === true;
    if (isPresentWord(endDate)) isCurrentlyWorking = true;
    if (isCurrentlyWorking) endDate = '';
    return {
      ...current,
      title: str(d.title),
      company: str(d.company),
      location: str(d.location),
      startDate: str(d.startDate),
      endDate,
      isCurrentlyWorking,
      bullets: lines(d.bullets),
      links: commitLinks(d.links),
    };
  },
  projects: (draft, current) => {
    const d = asObject(draft);
    return { ...current, name: str(d.name), description: str(d.description), bullets: lines(d.bullets), links: commitLinks(d.links) };
  },
  education: (draft, current) => {
    const d = asObject(draft);
    return {
      ...current,
      institution: str(d.institution),
      degree: str(d.degree),
      field: str(d.field),
      location: str(d.location),
      startDate: str(d.startDate),
      endDate: str(d.endDate),
      details: lines(d.details),
    };
  },
  certifications: (draft, current) => {
    const d = asObject(draft);
    return { ...current, name: str(d.name), issuer: str(d.issuer), date: str(d.date), url: str(d.url) };
  },
};

/** "Senior Engineer — Acme", "University of Leeds". For headings and the edit log. */
export function describeEntry(section, entry) {
  const e = asObject(entry);
  const parts = {
    experience: [e.title, e.company],
    projects: [e.name],
    education: [e.degree, e.institution],
    certifications: [e.name, e.issuer],
  }[section];
  return (parts ?? []).map(str).filter(Boolean).join(' — ') || 'Untitled entry';
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Apply one section edit to a tailored resume. Returns a new resume (the input
 * is never mutated) plus a description of the edit, or null when the edit is
 * invalid or changes nothing.
 *
 * Invalid means: no tailored resume, an unknown section, a list index out of
 * range, or a value of the wrong kind. A malformed payload must not be able to
 * blank an entry by committing an empty draft over it.
 *
 * @param {unknown} tailored
 * @param {{ section: string, index?: number, value: unknown }} payload
 * @returns {{ resume: object, edit: { section: string, index: number | null, label: string } } | null}
 */
export function applyTailoredEdit(tailored, payload) {
  if (!isPlainObject(tailored)) return null;
  const { section, index, value } = asObject(payload);
  if (!EDITABLE_SECTIONS.includes(section)) return null;

  if (section === 'header') {
    if (!isPlainObject(value)) return null;
    const next = commitHeader(value, tailored);
    if (same(next, commitHeader(toDraft('header', tailored), tailored))) return null;
    return { resume: { ...tailored, ...next }, edit: { section, index: null, label: SECTION_LABELS.header } };
  }

  if (section === 'summary') {
    if (typeof value !== 'string') return null;
    const next = str(value);
    if (next === str(tailored.summary)) return null;
    return { resume: { ...tailored, summary: next }, edit: { section, index: null, label: SECTION_LABELS.summary } };
  }

  if (section === 'skills') {
    if (!Array.isArray(value)) return null;
    const next = commitSkills(value);
    if (same(next, commitSkills(toDraft('skills', tailored.skills)))) return null;
    return { resume: { ...tailored, skills: next }, edit: { section, index: null, label: SECTION_LABELS.skills } };
  }

  // A list section: exactly one existing entry.
  const list = asArray(tailored[section]);
  if (!Number.isInteger(index) || index < 0 || index >= list.length || !isPlainObject(value)) return null;

  const current = asObject(list[index]);
  const commit = COMMIT_ENTRY[section];
  const entry = commit(value, current);
  if (same(entry, commit(toDraft(section, current), current))) return null;

  return {
    resume: { ...tailored, [section]: list.map((e, i) => (i === index ? entry : e)) },
    edit: { section, index, label: `${SECTION_LABELS[section]}: ${describeEntry(section, entry)}` },
  };
}

// ---------------------------------------------------------------------------
// The edit log
// ---------------------------------------------------------------------------

/**
 * One row per edited part: editing the same entry twice updates its row and
 * moves it last rather than adding a second one. The log exists so that a
 * discard or a re-run can say exactly what it is about to throw away.
 */
export function recordManualEdit(edits, edit) {
  if (!isPlainObject(edit)) return asArray(edits);
  const kept = asArray(edits).filter((e) => isPlainObject(e) && !(e.section === edit.section && e.index === edit.index));
  return [...kept, { section: edit.section, index: edit.index ?? null, label: asString(edit.label) }];
}

/** Labels of the edited parts, tolerating a stored log of any shape. */
export function describeManualEdits(edits) {
  return asArray(edits)
    .filter((e) => isPlainObject(e) && typeof e.label === 'string' && e.label.trim())
    .map((e) => e.label);
}

// ---------------------------------------------------------------------------
// Pending drafts -- editor content typed but not yet saved
// ---------------------------------------------------------------------------

/**
 * A draft is what is in an open editor block right now. It is NOT part of the
 * resume: nothing reads it for Export, and nothing scores it. It exists only
 * so that a crash or a reload does not silently throw away typing.
 *
 * Stored as a list rather than a single slot because the editor genuinely
 * allows several blocks to be open at once -- every EditableBlock keeps its
 * own state and nothing closes the others. A single slot would silently drop
 * every draft but the newest, which is the exact failure this prevents.
 * Same shape and same replace-or-append rule as `tailorManualEdits`.
 */

/**
 * How long after the last keystroke a draft is written. Long enough that a
 * burst of typing is one write rather than one per character, short enough
 * that little is lost if the tab dies mid-sentence. Lives here, not in the
 * component, so the manual test waits exactly as long as the editor does.
 */
export const DRAFT_AUTOSAVE_MS = 1500;

/** Stable identity for one editable block. List sections are addressed by index. */
export function draftKey(section, index) {
  return LIST_SECTIONS.includes(section) ? `${section}:${index}` : section;
}

/** Whether `section`/`index` names a block that can hold a draft at all. */
export function isDraftAddress(section, index) {
  if (!EDITABLE_SECTIONS.includes(section)) return false;
  return LIST_SECTIONS.includes(section) ? Number.isInteger(index) && index >= 0 : index === null || index === undefined;
}

/**
 * The saved value of one block as a draft, or undefined when the block does
 * not exist on this resume (an index past the end of a shortened list).
 * This is what a pending draft is compared against to decide whether it holds
 * anything the user would miss.
 */
export function committedDraft(section, index, tailored) {
  if (!isPlainObject(tailored) || !isDraftAddress(section, index)) return undefined;
  if (section === 'header') return toDraft('header', tailored);
  if (section === 'summary') return toDraft('summary', tailored.summary);
  if (section === 'skills') return toDraft('skills', tailored.skills);
  const list = asArray(tailored[section]);
  if (index >= list.length) return undefined;
  return toDraft(section, list[index]);
}

/**
 * `drafts` with this block's draft recorded. Returns the very same array when
 * the stored draft is already identical, so an autosave tick that repeats
 * itself changes no state and therefore writes no storage.
 */
export function putPendingDraft(drafts, { section, index = null, value }) {
  const list = asArray(drafts).filter(isPlainObject);
  if (!isDraftAddress(section, index)) return drafts;
  const at = index ?? null;
  const existing = list.find((d) => d.section === section && (d.index ?? null) === at);
  if (existing && same(existing.value, value)) return drafts;
  const kept = list.filter((d) => !(d.section === section && (d.index ?? null) === at));
  return [...kept, { section, index: at, value }];
}

/**
 * `drafts` without this block's draft.
 *
 * Returns the argument itself -- same reference, null included -- when there
 * was nothing to drop. Callers use that identity to decide whether anything
 * changed, and a reducer that returned a fresh object for a no-op would make
 * a no-op save look like a real one.
 */
export function dropPendingDraft(drafts, section, index = null) {
  const list = asArray(drafts);
  const at = index ?? null;
  const kept = list.filter((d) => !(isPlainObject(d) && d.section === section && (d.index ?? null) === at));
  return kept.length === list.length ? drafts : kept;
}

/**
 * The drafts worth offering back: a real address on this resume, and content
 * that actually differs from what is saved there. A draft equal to the saved
 * value is dropped rather than surfaced -- nothing was lost, so re-opening the
 * block and calling it unsaved would be a lie.
 *
 * @returns {{ section: string, index: number | null, key: string, label: string, value: unknown }[]}
 */
export function recoverableDrafts(drafts, tailored) {
  const out = [];
  for (const draft of asArray(drafts)) {
    if (!isPlainObject(draft)) continue;
    const { section, value } = draft;
    const index = draft.index ?? null;
    const committed = committedDraft(section, index, tailored);
    if (committed === undefined || same(committed, value)) continue;
    const label =
      index === null
        ? SECTION_LABELS[section]
        : `${SECTION_LABELS[section]}: ${describeEntry(section, asArray(asObject(tailored)[section])[index])}`;
    out.push({ section, index, key: draftKey(section, index), label, value });
  }
  return out;
}
