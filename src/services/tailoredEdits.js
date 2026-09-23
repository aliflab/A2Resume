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
 *
 * WHOLE ENTRIES CAN BE ADDED AND REMOVED
 * Tailoring for a specific job often means dropping an old role outright, not
 * rewording every bullet in it. `applyTailoredEntryAdd` and
 * `applyTailoredEntryRemoval` change the length of a list section, which makes
 * index-based addressing move underneath everything that holds one --
 * `draftEdits` and `tailorManualEdits` both do. `reindexRowsAfterRemoval` and
 * `reindexRowsAfterInsertion` are what keep those rows pointing at the entry
 * they were written for; see their comments for the bug they exist to prevent.
 *
 * WHERE AN ADD LANDS IS PER SECTION -- see `ENTRY_INSERT_AT`. Experience and
 * education are read newest-first, so a hand-added entry belongs at the top;
 * projects and certifications have no such convention, so they append.
 * Appending is the only position that moves no existing index, so it needs no
 * reindexing at all. Inserting at the top moves every index in the section up
 * one, which is exactly the drift a removal causes in the other direction, so
 * it goes through the same row-shifting machinery.
 */

import { asArray, asObject, asString } from './gapAnalyzer.js';

export const EDITABLE_SECTIONS = ['header', 'summary', 'skills', 'experience', 'projects', 'education', 'certifications'];

/** Sections edited one entry at a time, addressed by index. */
export const LIST_SECTIONS = ['experience', 'projects', 'education', 'certifications'];

/**
 * Where `applyTailoredEntryAdd` puts a new entry, per section.
 *
 * `'top'` (index 0) for experience and education: both are read newest-first
 * by every human and every ATS, so a role added by hand is almost always the
 * most recent one, and appending it would print it below a job the candidate
 * left years earlier. `'end'` for projects and certifications, which carry no
 * chronological convention -- there is nothing to be wrong about there, and
 * appending is free.
 *
 * The cost of `'top'` is stated rather than hidden: it moves every existing
 * index in the section up one, so the add must shift `draftEdits` and
 * `tailorManualEdits` with it (`reindexRowsAfterInsertion`). There is still no
 * reordering in this editor, so `'end'` sections still print a hand-added
 * entry last.
 */
export const ENTRY_INSERT_AT = {
  experience: 'top',
  projects: 'end',
  education: 'top',
  certifications: 'end',
};

/** The index a new entry in `section` takes in a list of `length` entries. */
export function entryInsertIndex(section, length) {
  return ENTRY_INSERT_AT[section] === 'top' ? 0 : length;
}

/** True when an add to `section` inserts at the top, and so moves existing indices. */
export const insertsAtTop = (section) => ENTRY_INSERT_AT[section] === 'top';

/**
 * The draft address of a list section's "add a new entry" form.
 *
 * A new entry has no index yet -- it is not in the list -- but its form is a
 * real editable block that can hold the most typing anyone does here, so it
 * must be autosaved and recoverable like every other block. A sentinel index
 * gives it an address without pretending it is at a position, and because it is
 * not an integer, the row reindexers leave it alone.
 */
export const NEW_ENTRY_INDEX = 'new';

export const isNewEntryIndex = (index) => index === NEW_ENTRY_INDEX;

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
// Whole entries: add and remove
// ---------------------------------------------------------------------------

/**
 * A blank draft for a new entry in a list section, in exactly the shape the
 * section's existing edit form already renders. `toDraft` of an empty object
 * is that shape by construction, so the add form and the edit form cannot
 * drift apart -- adding a field to one adds it to the other.
 *
 * @returns {object | null} null for a section that has no entries.
 */
export function newEntryDraft(section) {
  return LIST_SECTIONS.includes(section) ? toDraft(section, {}) : null;
}

/**
 * True when a new-entry draft still holds nothing worth adding. The editor
 * disables the add button on it, rather than letting the click do nothing
 * visible, and `applyTailoredEntryAdd` refuses the same shape.
 */
export function isBlankEntryDraft(section, draft) {
  const commit = COMMIT_ENTRY[section];
  if (!commit || !isPlainObject(draft)) return true;
  return same(commit(draft, {}), commit(newEntryDraft(section), {}));
}

/**
 * Add one new entry to a list section, at that section's insertion point.
 *
 * WHERE IT LANDS IS `ENTRY_INSERT_AT`, not a fixed rule. Experience and
 * education insert at index 0 because they are read newest-first; projects and
 * certifications append. An append moves nothing, so it needs no follow-up. An
 * insert at the top moves every existing index in the section up one, and the
 * caller MUST shift the index-addressed rows with it -- `index` is returned for
 * exactly that, and the reducer feeds it to `reindexRowsAfterInsertion`. Get
 * that wrong and you have the drift bug described on
 * `reindexRowsAfterRemoval`, pointing the other way.
 *
 * An entry with nothing typed in it is rejected the same way a no-op save is:
 * it would add a block that Export drops (`normalizeResumeForExport` filters
 * entries with nothing printable), so it would be a row in the editor that is
 * nowhere in the output.
 *
 * @param {unknown} tailored
 * @param {{ section: string, value: unknown }} payload
 * @returns {{ resume: object, index: number, edit: object } | null}
 */
export function applyTailoredEntryAdd(tailored, payload) {
  if (!isPlainObject(tailored)) return null;
  const { section, value } = asObject(payload);
  if (!LIST_SECTIONS.includes(section) || !isPlainObject(value)) return null;

  const commit = COMMIT_ENTRY[section];
  const entry = commit(value, {});
  if (same(entry, commit(newEntryDraft(section), {}))) return null;

  const list = asArray(tailored[section]);
  const index = entryInsertIndex(section, list.length);
  const next = [...list];
  next.splice(index, 0, entry);
  return {
    resume: { ...tailored, [section]: next },
    index,
    edit: { section, index, label: `${SECTION_LABELS[section]}: ${describeEntry(section, entry)} (added by hand)` },
  };
}

/**
 * Remove one entry from a list section.
 *
 * This is the only operation here that destroys content the user did not type
 * in this session, so the page confirms it by name first (see
 * TailoredResumeEditor). What it destroys is only the tailored copy:
 * `state.resume` is untouched, so discarding the whole pass brings the entry
 * back. Nothing else does -- see the comment on `reindexRowsAfterRemoval`
 * and the merge note in resumeTailor.js.
 *
 * The returned edit is `append: true`: a removal is not an edit *to* a
 * surviving entry, so it must never replace a row keyed on the index it used
 * to occupy, and two removals must never collapse into one row.
 *
 * @param {unknown} tailored
 * @param {{ section: string, index: number }} payload
 * @returns {{ resume: object, index: number, edit: object } | null}
 */
export function applyTailoredEntryRemoval(tailored, payload) {
  if (!isPlainObject(tailored)) return null;
  const { section, index } = asObject(payload);
  if (!LIST_SECTIONS.includes(section)) return null;

  const list = asArray(tailored[section]);
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return null;

  const described = describeEntry(section, list[index]);
  return {
    resume: { ...tailored, [section]: list.filter((_, i) => i !== index) },
    index,
    edit: {
      section,
      index: null,
      append: true,
      label: `${SECTION_LABELS[section]}: ${described} (removed by hand)`,
    },
  };
}

/**
 * Every index-addressed row in `section` put through `move`, which returns the
 * row's new index or null to drop it.
 *
 * Rows that are not addressed by an integer index in this section are passed
 * through untouched: other sections, the single-section rows with a null index,
 * the NEW_ENTRY_INDEX sentinel (deliberately not an integer, so it lands here),
 * and junk from storage. That list is the whole reason this walks rows rather
 * than mapping over a section's own array.
 *
 * Returns the argument itself, null included, when no row moved, matching
 * `dropPendingDraft` so callers can use identity to mean "no change" -- a
 * reducer returning a fresh array for a no-op would make a no-op look like a
 * real change and write storage for nothing.
 */
function moveIndexedRows(rows, section, move) {
  const list = asArray(rows);
  let changed = false;
  const out = [];
  for (const row of list) {
    if (!isPlainObject(row) || row.section !== section || !Number.isInteger(row.index)) {
      out.push(row);
      continue;
    }
    const next = move(row.index);
    if (next === null) changed = true;
    else if (next === row.index) out.push(row);
    else {
      changed = true;
      out.push({ ...row, index: next });
    }
  }
  return changed ? out : rows;
}

/**
 * Rows addressed by array index, moved to follow a removal from `section`.
 *
 * THE BUG THIS EXISTS TO PREVENT
 * `draftEdits` and `tailorManualEdits` both store `{ section, index }` against
 * a plain array index. Remove experience 1 of four and the entry that was at 2
 * is now at 1, 3 is now at 2 -- but a pending draft still says 2. On the next
 * load `recoverableDrafts` resolves 2 to what used to be entry 3, finds it
 * different from the draft, and offers it back labelled as that entry with the
 * *other* entry's text in the form. Pressing Save then writes one role's
 * content over another's. It is silent, it looks like a recovered draft
 * working correctly, and it is the same class of bug as any index drift on a
 * mutated array.
 *
 * So: a row at the removed index is dropped (its entry is gone), a row above
 * it moves down one, and everything else is left exactly as it is -- see
 * `moveIndexedRows` for what "everything else" covers.
 */
export function reindexRowsAfterRemoval(rows, section, removedIndex) {
  if (!Number.isInteger(removedIndex)) return rows;
  return moveIndexedRows(rows, section, (index) => {
    if (index === removedIndex) return null;
    return index > removedIndex ? index - 1 : index;
  });
}

/**
 * Rows addressed by array index, moved to follow an insertion into `section`.
 *
 * THE SAME BUG AS `reindexRowsAfterRemoval`, POINTING THE OTHER WAY. Insert a
 * new role at index 0 of three and the entry that was at 0 is now at 1, 1 is
 * now at 2 -- but a pending draft still says 0, and so does its edit-log row.
 * Without this, `recoverableDrafts` resolves 0 to the brand-new entry, finds it
 * different from the draft, and offers the draft back labelled as the new entry
 * with the old entry's text in the form; Save then writes one role's content
 * over another's. The edit log drifts the same way, naming the wrong entry as
 * hand-edited. Nothing throws and nothing looks wrong.
 *
 * So: a row at or above the inserted index moves up one, and nothing is
 * dropped -- an insertion destroys no entry, so every row still has one.
 *
 * `>=`, not `>`, is the whole point: the row at the insertion point is exactly
 * the one that got displaced. Appending (an index equal to the old length)
 * therefore moves nothing, which is why `ENTRY_INSERT_AT`'s `'end'` sections
 * need no special-casing here.
 */
export function reindexRowsAfterInsertion(rows, section, insertedIndex) {
  if (!Number.isInteger(insertedIndex)) return rows;
  return moveIndexedRows(rows, section, (index) => (index >= insertedIndex ? index + 1 : index));
}

/**
 * Stable React keys for one list section's blocks.
 *
 * Index keys were safe while entries could not be added, removed or reordered,
 * and the old comment in the editor said exactly that. They are not safe now:
 * removing entry 0 of three re-renders the entry that was at 1 under key 0, so
 * React keeps the *previous* block's component state -- an open editor holding
 * the removed entry's draft would carry on under the surviving entry's
 * heading. Keying on what the entry says instead means a block keeps its state
 * only while it is the same entry. Duplicate descriptions get an occurrence
 * suffix so two identically-named entries are still two blocks.
 */
export function entryBlockKeys(section, entries) {
  const seen = new Map();
  return asArray(entries).map((entry) => {
    const base = describeEntry(section, entry);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}

// ---------------------------------------------------------------------------
// The edit log
// ---------------------------------------------------------------------------

/**
 * One row per edited part: editing the same entry twice updates its row and
 * moves it last rather than adding a second one. The log exists so that a
 * discard or a re-run can say exactly what it is about to throw away.
 *
 * `append: true` opts out of that replacement. A removal is the only thing
 * that uses it: it is not an edit to a surviving entry, so it has no index to
 * be keyed on, and two removals in the same section must be two rows. Without
 * this they would both land at `{ section, index: null }` and the second would
 * silently replace the first -- a destructive-action log that under-reports.
 */
export function recordManualEdit(edits, edit) {
  if (!isPlainObject(edit)) return asArray(edits);
  const row = { section: edit.section, index: edit.index ?? null, label: asString(edit.label) };
  const rows = asArray(edits).filter(isPlainObject);
  if (edit.append === true) return [...rows, row];
  const kept = rows.filter((e) => !(e.section === row.section && e.index === row.index));
  return [...kept, row];
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

/**
 * Stable identity for one editable block. List sections are addressed by
 * index, plus the NEW_ENTRY_INDEX sentinel for the add form.
 */
export function draftKey(section, index) {
  return LIST_SECTIONS.includes(section) ? `${section}:${index}` : section;
}

/** Whether `section`/`index` names a block that can hold a draft at all. */
export function isDraftAddress(section, index) {
  if (!EDITABLE_SECTIONS.includes(section)) return false;
  if (!LIST_SECTIONS.includes(section)) return index === null || index === undefined;
  return isNewEntryIndex(index) || (Number.isInteger(index) && index >= 0);
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
  // The add form's "saved value" is the blank it opens with. So a draft that
  // is still blank is not offered back, and one with anything typed in it is.
  if (isNewEntryIndex(index)) return newEntryDraft(section);
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
 * `only`, when given, restricts the result to drafts whose `value` is one of
 * those objects. The editor freezes that set at mount to mean "the drafts that
 * were already in the session when this page loaded", which is what
 * "recovered" actually means. It is a set of VALUES rather than of addresses
 * on purpose: a removal reindexes pending drafts, so an address frozen at
 * mount would afterwards name the wrong entry, while the value object is
 * carried across the reindex unchanged.
 *
 * @returns {{ section: string, index: number | 'new' | null, key: string, label: string, value: unknown }[]}
 */
export function recoverableDrafts(drafts, tailored, only) {
  const out = [];
  for (const draft of asArray(drafts)) {
    if (!isPlainObject(draft)) continue;
    const { section, value } = draft;
    if (only && !only.has(value)) continue;
    const index = draft.index ?? null;
    const committed = committedDraft(section, index, tailored);
    if (committed === undefined || same(committed, value)) continue;
    const label =
      index === null
        ? SECTION_LABELS[section]
        : isNewEntryIndex(index)
          ? `${SECTION_LABELS[section]}: a new entry`
          : `${SECTION_LABELS[section]}: ${describeEntry(section, asArray(asObject(tailored)[section])[index])}`;
    out.push({ section, index, key: draftKey(section, index), label, value });
  }
  return out;
}
