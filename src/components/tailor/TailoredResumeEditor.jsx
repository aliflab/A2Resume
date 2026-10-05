import { useEffect, useId, useState } from 'react';

import { ACTIONS, useApp } from '../../context/AppContext.jsx';
import Icon from '../Icon.jsx';
import Spinner from '../ui/Spinner.jsx';
import {
  certificationHeading,
  contactParts,
  educationHeading,
  metaLine,
  normalizeResumeForExport,
  roleHeading,
  skillLine,
} from '../../services/resumeExport.js';
import {
  DRAFT_AUTOSAVE_MS,
  NEW_ENTRY_INDEX,
  SECTION_LABELS,
  describeEntry,
  draftKey,
  entryBlockKeys,
  insertsAtTop,
  isBlankEntryDraft,
  newEntryDraft,
  recoverableDrafts,
  toDraft,
  toggleCurrentlyWorking,
} from '../../services/tailoredEdits.js';

/**
 * The hand-editing surface for the tailored resume on step 3.
 *
 * Each part -- the header, the summary, the skills, and every single
 * experience, project, education and certification entry -- is its own block
 * with its own Edit / Save / Cancel. Opening a block copies the stored value
 * into a local draft (tailoredEdits.toDraft), and Save dispatches
 * UPDATE_TAILORED_SECTION for that part only. Cancel just drops the draft.
 *
 * Read-only views are built with Export's own normaliser and line builders, so
 * what a block shows is what the PDF and the plain-text copy will print.
 *
 * An open block's unsaved content is autosaved to the session on a debounce
 * (DRAFT_AUTOSAVE_MS after typing stops), so a crash or a reload does not
 * throw it away. It is stored as `draftEdits`, kept apart from the resume
 * itself: it is never printed, never scored, and never merged until Save.
 * On load a draft that differs from what is saved reopens its block, labelled
 * as recovered and unsaved, with a control to throw it away instead. Saving,
 * cancelling, a new tailoring pass and a new Input run all end a draft.
 *
 * Whole entries can be added and removed as well as edited. Both change the
 * length of a list section, and that has two consequences this file has to
 * carry:
 *
 * - Blocks are keyed on what the entry says (`entryBlockKeys`), not on its
 *   index. With index keys, removing entry 0 would re-render entry 1 under
 *   key 0 and React would hand it the removed block's component state --
 *   including an open editor holding the removed entry's draft.
 * - The set of recovered drafts is frozen at mount by VALUE, not by address,
 *   because the reducer reindexes pending drafts on a removal. A frozen
 *   address would afterwards name a different entry.
 *
 * Removing is confirmed inline, by name, in the block itself -- the same
 * pattern as "Start over" and the tailoring discard, and never window.confirm.
 * It only takes the entry out of the tailored copy; `state.resume` is
 * untouched, so discarding the pass brings it back.
 *
 * Where an add lands is per section (`ENTRY_INSERT_AT`): experience and
 * education insert at the top, because both are read newest-first; projects and
 * certifications append. An insert at the top moves every later index, so the
 * reducer shifts the same two row sets a removal shifts -- which is also why
 * the frozen-by-value rule above is not specific to removals. The add form is
 * an ordinary block with the section's own edit form in it, so it autosaves and
 * recovers like every other one.
 */
export default function TailoredResumeEditor({ resume }) {
  const { state, dispatch } = useApp();
  const save = (section, index) => (value) =>
    dispatch({ type: ACTIONS.UPDATE_TAILORED_SECTION, payload: { section, index, value } });
  const add = (section) => (value) => dispatch({ type: ACTIONS.ADD_TAILORED_ENTRY, payload: { section, value } });
  const removeEntry = (section, index) => () =>
    dispatch({ type: ACTIONS.REMOVE_TAILORED_ENTRY, payload: { section, index } });

  // Frozen at mount on purpose. These are the drafts that were already in the
  // session when this page loaded, which is exactly what "recovered from
  // before the reload" means. Recomputing it would make every block the user
  // opens and types in claim to be recovered a second and a half later.
  //
  // Frozen as the draft VALUES, not their addresses: removing an entry
  // reindexes every pending draft above it, so an address frozen at mount
  // would point at the wrong entry afterwards. The value objects are carried
  // through the reindex unchanged, so identity survives it.
  const [seeds] = useState(() => new Set(recoverableDrafts(state.draftEdits, resume).map((d) => d.value)));

  // Re-derived each render from the live drafts, restricted to those seeds, so
  // the banner shrinks as they are saved or discarded rather than lingering as
  // a claim about the past -- and so a reindexed draft is still found.
  const outstanding = recoverableDrafts(state.draftEdits, resume, seeds);
  const recovered = new Map(outstanding.map((d) => [d.key, d]));
  const draftOf = (section, index = null) => recovered.get(draftKey(section, index))?.value;

  const normalised = normalizeResumeForExport(resume);
  const list = (section) => (Array.isArray(resume?.[section]) ? resume[section] : []);

  return (
    <>
      {outstanding.length > 0 && (
        <p className="notice notice--warn editor-recovered">
          <strong>Unsaved {outstanding.length === 1 ? 'draft' : 'drafts'} recovered.</strong> You were editing{' '}
          {outstanding.map((d) => d.label).join(', ')} when the page last closed. {outstanding.length === 1 ? 'It is' : 'They are'}{' '}
          reopened below and <strong>not saved yet</strong> -- Save to keep {outstanding.length === 1 ? 'it' : 'them'}, or discard to
          go back to the last saved version.
        </p>
      )}

      <section className="card editor-card">
        <h2>Your tailored resume</h2>
        <p className="muted editor-card__intro">
          Open any part to change it. Saving updates the resume Export uses straight away. Blank lines and links
          without a URL are removed when you save.
        </p>

        <EditableBlock
          section="header"
          recovered={draftOf('header')}
          title={SECTION_LABELS.header}
          editLabel="Edit header"
          makeDraft={() => toDraft('header', resume)}
          Form={HeaderForm}
          onSave={save('header')}
        >
          {normalised.name || contactParts(normalised).length > 0 ? (
            <>
              {normalised.name && <p className="edit-block__strong">{normalised.name}</p>}
              {contactParts(normalised).length > 0 && <p>{contactParts(normalised).join(' | ')}</p>}
            </>
          ) : (
            <EmptyView />
          )}
        </EditableBlock>

        <EditableBlock
          section="summary"
          recovered={draftOf('summary')}
          title={SECTION_LABELS.summary}
          editLabel="Edit summary"
          makeDraft={() => toDraft('summary', resume?.summary)}
          Form={SummaryForm}
          onSave={save('summary')}
        >
          {normalised.summary ? <p>{normalised.summary}</p> : <EmptyView />}
        </EditableBlock>

        <EditableBlock
          section="skills"
          recovered={draftOf('skills')}
          title={SECTION_LABELS.skills}
          editLabel="Edit skills"
          makeDraft={() => toDraft('skills', resume?.skills)}
          Form={SkillsForm}
          onSave={save('skills')}
        >
          {normalised.skills.length > 0 ? (
            <ul>
              {normalised.skills.map((group, i) => (
                <li key={`${group.category}-${i}`}>{skillLine(group)}</li>
              ))}
            </ul>
          ) : (
            <EmptyView />
          )}
        </EditableBlock>
      </section>

      {[
        ['experience', ExperienceForm, ExperienceView],
        ['projects', ProjectForm, ProjectView],
        ['education', EducationForm, EducationView],
        ['certifications', CertificationForm, CertificationView],
      ].map(([section, Form, View]) => (
        <EntrySection
          key={section}
          section={section}
          entries={list(section)}
          save={save}
          add={add}
          removeEntry={removeEntry}
          draftOf={draftOf}
          Form={Form}
          View={View}
        />
      ))}
    </>
  );
}

/**
 * What one entry of each section is called. Spelled out rather than derived
 * from the section name: stripping the plural gives "a experience", and
 * "education" has no singular that reads as one item at all.
 *
 * `noun` is what the aria-labels and per-entry controls use ("Remove
 * experience 2"); `one` is the article-and-noun phrase for prose.
 */
const ENTRY_NOUNS = {
  experience: { noun: 'experience', one: 'an experience entry' },
  projects: { noun: 'project', one: 'a project' },
  education: { noun: 'education', one: 'an education entry' },
  certifications: { noun: 'certification', one: 'a certification' },
};

/**
 * One card per list section: one block per entry, plus one block for adding a
 * new one. Entries are addressed by index for dispatch, but keyed for React on
 * what they say -- see entryBlockKeys.
 */
function EntrySection({ section, entries, save, add, removeEntry, draftOf, Form, View }) {
  const { noun, one } = ENTRY_NOUNS[section];
  const keys = entryBlockKeys(section, entries);
  return (
    <section className="card editor-card">
      <h2>{SECTION_LABELS[section]}</h2>
      {entries.length === 0 ? (
        <p className="muted editor-card__empty">
          Your resume has no {SECTION_LABELS[section].toLowerCase()} entries.
        </p>
      ) : (
        entries.map((entry, index) => (
          <EditableBlock
            key={keys[index]}
            section={section}
            index={index}
            recovered={draftOf(section, index)}
            title={describeEntry(section, entry)}
            editLabel={`Edit ${noun} ${index + 1}`}
            makeDraft={() => toDraft(section, entry)}
            Form={Form}
            onSave={save(section, index)}
            onRemove={removeEntry(section, index)}
            removeLabel={`Remove ${noun} ${index + 1}`}
          >
            <View entry={normalizeResumeForExport({ [section]: [entry] })[section][0]} />
          </EditableBlock>
        ))
      )}

      <EditableBlock
        variant="add"
        section={section}
        index={NEW_ENTRY_INDEX}
        recovered={draftOf(section, NEW_ENTRY_INDEX)}
        title={`Add ${one}`}
        editLabel={`Add ${noun}`}
        openLabel="Add"
        saveLabel={`Add ${one}`}
        makeDraft={() => newEntryDraft(section)}
        canSave={(draft) => !isBlankEntryDraft(section, draft)}
        Form={Form}
        onSave={add(section)}
      >
        <p className="muted">
          Written by hand, not by the AI pass.{' '}
          {insertsAtTop(section)
            ? 'It goes first in this section, where the most recent one belongs. There is no reordering here yet, so putting it anywhere else means retyping the entries around it.'
            : 'It goes last in this section — there is no reordering here yet.'}
        </p>
      </EditableBlock>
    </section>
  );
}

function EditableBlock({
  section,
  index = null,
  title,
  editLabel,
  openLabel = 'Edit',
  saveLabel = 'Save',
  variant,
  makeDraft,
  canSave,
  Form,
  onSave,
  onRemove,
  removeLabel,
  recovered,
  children,
}) {
  const { state, dispatch } = useApp();
  // A recovered draft opens the block straight away: the content is the point,
  // and hiding it behind an Edit click would look like it had been lost.
  const [draft, setDraft] = useState(() => (recovered === undefined ? null : recovered));
  const [fromRecovery, setFromRecovery] = useState(recovered !== undefined);
  // Removing is a real destruction of content the user may not have typed
  // here, so it asks first, inline and by name. Local state: one block's
  // question is nobody else's business, and it must not survive a remount.
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const editing = draft !== null;

  // Autosave. The cleanup cancels the pending write whenever the draft changes
  // again or the block closes, so a save or a cancel one keystroke before the
  // timer fires can never be followed by the draft landing anyway.
  useEffect(() => {
    if (draft === null) return undefined;
    const timer = setTimeout(() => {
      dispatch({ type: ACTIONS.SET_DRAFT_EDIT, payload: { section, index, value: draft } });
    }, DRAFT_AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [draft, dispatch, section, index]);

  const close = () => {
    setDraft(null);
    setFromRecovery(false);
  };

  // Cancel and "discard draft" are the same act: an explicit "I do not want
  // this". Keeping a cancelled draft recoverable would mean Cancel did not
  // cancel, and it would reappear on the next load.
  const discard = () => {
    dispatch({ type: ACTIONS.DISCARD_DRAFT_EDIT, payload: { section, index } });
    close();
  };

  // Autosave feedback, derived rather than tracked: nothing until the draft
  // differs from what the block opened with, then "Saving draft…" until the
  // debounced SET_DRAFT_EDIT has stored this exact value, then "Draft saved".
  const draftState = (() => {
    if (!editing) return null;
    const json = JSON.stringify(draft);
    if (json === JSON.stringify(makeDraft())) return null;
    const stored = (Array.isArray(state.draftEdits) ? state.draftEdits : []).find(
      (d) => d && d.section === section && (d.index ?? null) === (index ?? null)
    );
    return stored && JSON.stringify(stored.value) === json ? 'saved' : 'saving';
  })();

  return (
    <div className={`edit-block${editing ? ' edit-block--editing' : ''}${variant === 'add' ? ' edit-block--add' : ''}`}>
      <div className="edit-block__head">
        <h3>{title}</h3>
        {draftState && (
          <span className={`draft-status draft-status--${draftState}`}>
            {draftState === 'saving' ? <Spinner /> : <Icon name="check" size={13} />}
            {draftState === 'saving' ? 'Saving draft…' : 'Draft saved'}
          </span>
        )}
        <div className="edit-block__actions">
          {!editing && (
            <button type="button" onClick={() => setDraft(makeDraft())} aria-label={editLabel}>
              {openLabel}
            </button>
          )}
          {onRemove && !confirmingRemove && (
            <button
              type="button"
              className="button--danger"
              onClick={() => setConfirmingRemove(true)}
              aria-label={removeLabel ?? `Remove ${title}`}
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {confirmingRemove && (
        <div className="notice notice--warn edit-block__confirm" role="alert">
          <p>
            <strong>Remove {title}?</strong>
          </p>
          <p>
            It is taken out of your tailored resume, so it will not be in the PDF or the plain text, and your ATS
            score is recalculated without it
            {editing ? ', and the unsaved changes open in this block go with it' : ''}. Your original resume from step
            1 is not changed — discarding the whole tailoring pass brings this entry back.
          </p>
          <p className="actions">
            <button
              type="button"
              className="button button--danger"
              onClick={() => {
                setConfirmingRemove(false);
                close();
                onRemove();
              }}
            >
              Yes, remove it
            </button>
            <button type="button" className="button" onClick={() => setConfirmingRemove(false)}>
              Keep it
            </button>
          </p>
        </div>
      )}

      {editing ? (
        <div className="editor">
          {fromRecovery && (
            <p className="notice notice--warn edit-block__draft">
              <span>
                <strong>Unsaved draft.</strong> Recovered from before the page reloaded -- this is not your last saved version.
              </span>
              <button type="button" onClick={discard} aria-label={`Discard ${title} draft`}>
                Discard draft and use the last saved version
              </button>
            </p>
          )}
          <Form draft={draft} setDraft={setDraft} />
          <div className="actions">
            <button
              type="button"
              className="button button--primary"
              disabled={canSave ? !canSave(draft) : false}
              onClick={() => {
                onSave(draft);
                close();
              }}
            >
              {saveLabel}
            </button>
            <button type="button" onClick={discard}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="edit-block__view">{children}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read-only views -- built from Export's normalised shape
// ---------------------------------------------------------------------------

function EmptyView() {
  return <p className="muted edit-block__empty">Nothing here. Export leaves this out.</p>;
}

function BulletList({ items }) {
  if (items.length === 0) return null;
  return (
    <ul>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

function LinkListView({ links }) {
  if (links.length === 0) return null;
  return (
    <ul className="edit-block__links">
      {links.map((link, i) => (
        <li key={i}>
          {link.label && <span className="muted">{link.label}: </span>}
          {link.url}
        </li>
      ))}
    </ul>
  );
}

function ExperienceView({ entry }) {
  if (!entry) return <EmptyView />;
  return (
    <>
      {roleHeading(entry) && <p className="edit-block__strong">{roleHeading(entry)}</p>}
      {metaLine(entry) && <p className="muted">{metaLine(entry)}</p>}
      <BulletList items={entry.bullets} />
      <LinkListView links={entry.links} />
    </>
  );
}

function ProjectView({ entry }) {
  if (!entry) return <EmptyView />;
  return (
    <>
      {entry.description && <p>{entry.description}</p>}
      <BulletList items={entry.bullets} />
      <LinkListView links={entry.links} />
    </>
  );
}

function EducationView({ entry }) {
  if (!entry) return <EmptyView />;
  return (
    <>
      {educationHeading(entry) && <p className="edit-block__strong">{educationHeading(entry)}</p>}
      {metaLine(entry) && <p className="muted">{metaLine(entry)}</p>}
      <BulletList items={entry.details} />
    </>
  );
}

function CertificationView({ entry }) {
  if (!entry) return <EmptyView />;
  return (
    <>
      <p>{certificationHeading(entry)}</p>
      {entry.url && <p className="muted">{entry.url}</p>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

function Field({ label, name, value, onChange, type = 'text', multiline = false, rows = 3, disabled, placeholder }) {
  const id = useId();
  return (
    <div className="editor-field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {multiline ? (
        <textarea id={id} name={name} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      ) : (
        <input
          id={id}
          name={name}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
        />
      )}
    </div>
  );
}

/** Bullets or education details: edit, add, remove. */
function LinesEditor({ label, itemName, items, onChange }) {
  return (
    <fieldset className="editor-fieldset">
      <legend className="field-label">{label}</legend>
      {items.length === 0 && <p className="muted">None.</p>}
      <ol className="editor-list">
        {items.map((item, i) => (
          <li key={i} className="editor-list__item">
            <textarea
              aria-label={`${itemName} ${i + 1}`}
              rows={2}
              value={item}
              onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={`Remove ${itemName} ${i + 1}`}>
              Remove
            </button>
          </li>
        ))}
      </ol>
      <button type="button" className="editor-add" onClick={() => onChange([...items, ''])}>
        Add {itemName}
      </button>
    </fieldset>
  );
}

/** `{ label, url }[]` -- the shape the parser gives contact.customLinks and every entry's links. */
function LinksEditor({ label = 'Links', links, onChange }) {
  const update = (i, key, value) => onChange(links.map((link, j) => (j === i ? { ...link, [key]: value } : link)));
  return (
    <fieldset className="editor-fieldset">
      <legend className="field-label">{label}</legend>
      {links.length === 0 && <p className="muted">No links.</p>}
      <ul className="editor-list">
        {links.map((link, i) => (
          <li key={i} className="editor-link">
            <input
              type="text"
              aria-label={`Link ${i + 1} label`}
              placeholder="Label, e.g. GitHub"
              value={link.label}
              onChange={(e) => update(i, 'label', e.target.value)}
              autoComplete="off"
            />
            <input
              type="url"
              aria-label={`Link ${i + 1} URL`}
              placeholder="https://"
              value={link.url}
              onChange={(e) => update(i, 'url', e.target.value)}
              autoComplete="off"
            />
            <button type="button" onClick={() => onChange(links.filter((_, j) => j !== i))} aria-label={`Remove link ${i + 1}`}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="editor-add" onClick={() => onChange([...links, { label: '', url: '' }])}>
        Add link
      </button>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

const setter = (draft, setDraft) => (key) => (value) => setDraft({ ...draft, [key]: value });

function HeaderForm({ draft, setDraft }) {
  const set = setter(draft, setDraft);
  return (
    <>
      <Field label="Name" name="name" value={draft.name} onChange={set('name')} />
      <div className="editor-grid">
        <Field label="Email" name="email" type="email" value={draft.email} onChange={set('email')} />
        <Field label="Phone" name="phone" type="tel" value={draft.phone} onChange={set('phone')} />
        <Field label="Location" name="location" value={draft.location} onChange={set('location')} />
      </div>
      <LinksEditor links={draft.customLinks} onChange={set('customLinks')} />
    </>
  );
}

function SummaryForm({ draft, setDraft }) {
  return <Field label="Summary" name="summary" multiline rows={5} value={draft} onChange={setDraft} />;
}

/**
 * Add, remove and recategorise. Moving a skill appends it to the chosen
 * category; categories left empty are dropped on save.
 */
function SkillsForm({ draft, setDraft }) {
  const names = draft.map((group, i) => group.category.trim() || `Untitled category ${i + 1}`);
  return (
    <>
      {draft.length === 0 && <p className="muted">No skills yet. Add a category to start.</p>}
      {draft.map((group, index) => (
        <SkillGroupEditor key={index} groups={draft} index={index} names={names} onChange={setDraft} />
      ))}
      <button
        type="button"
        className="editor-add"
        onClick={() => setDraft([...draft, { category: '', skills: [] }])}
      >
        Add category
      </button>
    </>
  );
}

function SkillGroupEditor({ groups, index, names, onChange }) {
  const [newSkill, setNewSkill] = useState('');
  const group = groups[index];
  const has = (g, skill) => g.skills.some((s) => s.toLowerCase() === skill.toLowerCase());

  const withGroup = (i, next) => groups.map((g, j) => (j === i ? next : g));

  const add = () => {
    const skill = newSkill.trim();
    if (!skill) return;
    if (!has(group, skill)) onChange(withGroup(index, { ...group, skills: [...group.skills, skill] }));
    setNewSkill('');
  };

  const remove = (si) => onChange(withGroup(index, { ...group, skills: group.skills.filter((_, j) => j !== si) }));

  const move = (si, target) => {
    if (target === index) return;
    const skill = group.skills[si];
    onChange(
      groups.map((g, j) => {
        if (j === index) return { ...g, skills: g.skills.filter((_, k) => k !== si) };
        if (j === target) return has(g, skill) ? g : { ...g, skills: [...g.skills, skill] };
        return g;
      })
    );
  };

  return (
    <fieldset className="editor-skill-group">
      <legend className="visually-hidden">{names[index]}</legend>
      <div className="row">
        <Field
          label="Category"
          name={`category-${index}`}
          value={group.category}
          onChange={(value) => onChange(withGroup(index, { ...group, category: value }))}
          placeholder="e.g. Languages"
        />
        <button
          type="button"
          className="editor-skill-group__remove"
          onClick={() => onChange(groups.filter((_, j) => j !== index))}
          aria-label={`Remove category ${names[index]}`}
        >
          Remove category
        </button>
      </div>

      {group.skills.length === 0 ? (
        <p className="muted">No skills in this category. It is removed when you save unless you add one.</p>
      ) : (
        <ul className="editor-list">
          {group.skills.map((skill, si) => (
            <li key={`${skill}-${si}`} className="editor-skill">
              <span className="editor-skill__name">{skill}</span>
              <select aria-label={`Category for ${skill}`} value={index} onChange={(e) => move(si, Number(e.target.value))}>
                {names.map((name, gi) => (
                  <option key={gi} value={gi}>
                    {name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => remove(si)} aria-label={`Remove skill ${skill}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="row editor-add">
        <input
          type="text"
          aria-label={`New skill in ${names[index]}`}
          placeholder="Add a skill"
          value={newSkill}
          onChange={(e) => setNewSkill(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          autoComplete="off"
        />
        <button type="button" onClick={add} disabled={!newSkill.trim()}>
          Add skill
        </button>
      </div>
    </fieldset>
  );
}

function ExperienceForm({ draft, setDraft }) {
  const set = setter(draft, setDraft);
  // The end date the checkbox cleared, so unchecking puts it back.
  const [stash, setStash] = useState('');
  const current = draft.isCurrentlyWorking;

  return (
    <>
      <div className="editor-grid">
        <Field label="Job title" name="title" value={draft.title} onChange={set('title')} />
        <Field label="Company" name="company" value={draft.company} onChange={set('company')} />
        <Field label="Location" name="location" value={draft.location} onChange={set('location')} />
      </div>
      <div className="editor-grid">
        <Field label="Start date" name="startDate" value={draft.startDate} onChange={set('startDate')} placeholder="e.g. Jan 2021" />
        <Field
          label="End date"
          name="endDate"
          value={current ? '' : draft.endDate}
          onChange={set('endDate')}
          disabled={current}
          placeholder={current ? 'Present' : 'e.g. Mar 2024'}
        />
      </div>
      <label className="editor-check">
        <input
          type="checkbox"
          name="isCurrentlyWorking"
          checked={current}
          onChange={(e) => {
            const next = toggleCurrentlyWorking(draft, e.target.checked, stash);
            setDraft(next.draft);
            setStash(next.stash);
          }}
        />
        I currently work here
      </label>
      <p className="muted">
        Dates print exactly as typed. A current role prints &ldquo;Present&rdquo; as its end date.
      </p>
      <LinesEditor label="Bullets" itemName="bullet" items={draft.bullets} onChange={set('bullets')} />
      <LinksEditor links={draft.links} onChange={set('links')} />
    </>
  );
}

function ProjectForm({ draft, setDraft }) {
  const set = setter(draft, setDraft);
  return (
    <>
      <Field label="Project name" name="name" value={draft.name} onChange={set('name')} />
      <Field label="Description" name="description" multiline rows={3} value={draft.description} onChange={set('description')} />
      <LinesEditor label="Bullets" itemName="bullet" items={draft.bullets} onChange={set('bullets')} />
      <LinksEditor links={draft.links} onChange={set('links')} />
    </>
  );
}

function EducationForm({ draft, setDraft }) {
  const set = setter(draft, setDraft);
  return (
    <>
      <div className="editor-grid">
        <Field label="Institution" name="institution" value={draft.institution} onChange={set('institution')} />
        <Field label="Degree" name="degree" value={draft.degree} onChange={set('degree')} />
        <Field label="Field of study" name="field" value={draft.field} onChange={set('field')} />
      </div>
      <div className="editor-grid">
        <Field label="Location" name="location" value={draft.location} onChange={set('location')} />
        <Field label="Start date" name="startDate" value={draft.startDate} onChange={set('startDate')} />
        <Field label="End date" name="endDate" value={draft.endDate} onChange={set('endDate')} />
      </div>
      <LinesEditor label="Details" itemName="detail" items={draft.details} onChange={set('details')} />
    </>
  );
}

/**
 * A certification carries one `url`, not a list -- that is the parser's shape
 * (RESUME_SCHEMA), and Export prints exactly that one url. So its link is
 * added, edited and removed as a single optional field.
 */
function CertificationForm({ draft, setDraft }) {
  const set = setter(draft, setDraft);
  const [showLink, setShowLink] = useState(Boolean(draft.url));
  return (
    <>
      <div className="editor-grid">
        <Field label="Name" name="name" value={draft.name} onChange={set('name')} />
        <Field label="Issuer" name="issuer" value={draft.issuer} onChange={set('issuer')} />
        <Field label="Date" name="date" value={draft.date} onChange={set('date')} />
      </div>
      {showLink ? (
        <div className="row editor-cert-link">
          <Field label="Link" name="url" type="url" value={draft.url} onChange={set('url')} placeholder="https://" />
          <button
            type="button"
            onClick={() => {
              setDraft({ ...draft, url: '' });
              setShowLink(false);
            }}
            aria-label="Remove link"
          >
            Remove link
          </button>
        </div>
      ) : (
        <button type="button" className="editor-add" onClick={() => setShowLink(true)}>
          Add link
        </button>
      )}
    </>
  );
}
