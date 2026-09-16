/**
 * Manual verification for the Tailor hand editor. Not imported by the app and
 * not in the build.
 *
 *   const t = await import('/src/services/__manual__/tailorEditor.manual.js');
 *
 *   t.testOffline();          // ASSERTIONS, no DOM, no key, no network (also runs under Node)
 *   await t.testReducer();    // appReducer: the action, the edit log, what clears it (browser only)
 *
 * Live checks against the real Tailor page. They edit the FIRST experience
 * entry of whatever session is loaded, through the real inputs and buttons,
 * so run them on test data:
 *
 *   await t.liveEditBullet();      // on /tailor: rewrites bullet 1, saves, checks store + storage
 *   // reload the page (F5)
 *   (await import('/src/services/__manual__/tailorEditor.manual.js')).verifyBulletSurvived();
 *   // open /export
 *   (await import('/src/services/__manual__/tailorEditor.manual.js')).verifyExportShowsBullet();
 *
 *   await t.liveLinkRoundTrip();   // on /tailor: add a link to experience 1, save, remove it, save
 *   await t.liveToggleCurrent();   // on /tailor: current on -> "Present"; off -> the end date returns
 *
 * Draft autosave. A real reload sits between the first two, so they run as a
 * sequence. They type into the SUMMARY block and restore it at the end:
 *
 *   t.testDraftsOffline();                 // ASSERTIONS, no DOM (also runs under Node)
 *   await t.liveTypeDraft();               // on /tailor: opens Summary, types, waits for the autosave
 *   // reload the page (F5), still on /tailor
 *   (await import('/src/services/__manual__/tailorEditor.manual.js')).verifyDraftRecovered();
 *   await t.liveDiscardRecoveredDraft();   // discard, and Cancel, both fall back to the saved version
 *   await t.liveDraftClearedByNewPass();   // a landed pass clears a stale draft (stubbed, no AI call)
 *
 * Draft autosave. These type into the SUMMARY block and need a real reload
 * between the two halves, so they are run in pairs:
 *
 *   await t.liveTypeDraft();       // on /tailor: opens Summary, types, waits for the autosave
 *   // reload the page (F5), still on /tailor
 *   (await import('/src/services/__manual__/tailorEditor.manual.js')).verifyDraftRecovered();
 *   await t.liveDiscardRecoveredDraft();   // then: falls back to the last saved version
 *   await t.liveDraftClearedByNewPass();   // a completed pass clears a stale draft (stubbed pass, no AI call)
 *
 * Live checks read the store through window.a2resumeDev (dev builds only) and
 * never print resume content beyond the test's own marker text.
 */

import {
  DRAFT_AUTOSAVE_MS,
  applyTailoredEdit,
  committedDraft,
  describeManualEdits,
  draftKey,
  dropPendingDraft,
  isDraftAddress,
  putPendingDraft,
  recordManualEdit,
  recoverableDrafts,
  toDraft,
  toggleCurrentlyWorking,
} from '../tailoredEdits.js';
import { formatDateRange, generatePlainText, normalizeResumeForExport, selectExportSource } from '../resumeExport.js';
import { SESSION_STORAGE_NAME, loadSession, saveSession } from '../sessionPersistence.js';

const RAW_KEY = `a2resume:${SESSION_STORAGE_NAME}`;
const BULLET_KEY = '__a2resume_editor_bullet';

let failed = 0;
const check = (label, pass, detail) => {
  if (pass) console.log('  PASS', label);
  else {
    failed += 1;
    console.error('  FAIL', label, detail ?? '');
  }
  return pass;
};
const exportText = (resume) => generatePlainText(normalizeResumeForExport(resume));

/**
 * The shape mergeNonDestructiveResume returns, plus the two awkward cases
 * it produces: a restored entry with fields missing, and a parse that wrote
 * "Present" into endDate.
 */
function sample() {
  return {
    name: 'Jane Doe',
    contact: { email: 'jane@example.com', phone: '+44 20 7946 0000', location: 'London', customLinks: [{ label: 'GitHub', url: 'https://github.com/jane' }] },
    summary: 'Backend engineer.',
    skills: [
      { category: 'Languages', skills: ['Go', 'Python'] },
      { category: 'Infrastructure', skills: ['Kubernetes'] },
    ],
    experience: [
      { title: 'Senior Engineer', company: 'Acme', location: 'London', startDate: 'Jan 2020', endDate: 'Present', isCurrentlyWorking: true,
        bullets: ['Migrated 40 services to Kubernetes.', 'Cut p99 latency by 35%.'], links: [] },
      { title: 'Engineer', company: 'Beta', startDate: 'Jun 2016', endDate: 'Dec 2019', bullets: ['Built a reporting API.'] }, // restored verbatim: no location, no links
    ],
    projects: [{ name: 'Tracer', description: 'Tracing library.', bullets: [], links: [{ label: 'Repo', url: 'https://github.com/jane/tracer' }] }],
    education: [{ institution: 'University of Leeds', degree: 'BSc', field: 'Computer Science', location: '', startDate: '2012', endDate: '2015', details: [] }],
    certifications: [{ name: 'AWS Solutions Architect', issuer: 'AWS', date: '2022', url: '' }],
  };
}

// ---------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------

/** @returns {boolean} */
export function testOffline() {
  failed = 0;
  console.group('tailorEditor - offline assertions');
  try {
    const base = sample();
    const frozen = JSON.stringify(base);

    // --- bullets ---------------------------------------------------------
    const draft = toDraft('experience', base.experience[0]);
    check('draft of a "Present" role: flag on, end date empty', draft.isCurrentlyWorking === true && draft.endDate === '', draft);

    let r = applyTailoredEdit(base, { section: 'experience', index: 0, value: { ...draft, bullets: ['  Led the migration of 40 services to Kubernetes.  ', '', draft.bullets[1]] } });
    check('bullet edit applies to that entry only', r && r.resume.experience[0].bullets[0] === 'Led the migration of 40 services to Kubernetes.' && r.resume.experience[1] === base.experience[1], r?.resume.experience);
    check('blank bullet dropped, text trimmed', r && r.resume.experience[0].bullets.length === 2);
    check('input resume not mutated', JSON.stringify(base) === frozen);
    check('edit described for the log', r?.edit.section === 'experience' && r.edit.index === 0 && r.edit.label === 'Experience: Senior Engineer — Acme', r?.edit);
    check('untouched sections are the same objects', r && r.resume.skills === base.skills && r.resume.education === base.education);

    // --- export flow --------------------------------------------------------
    const edited = r.resume;
    check('Export selects the edited tailored resume', selectExportSource({ resume: base, tailoredResume: edited }).raw === edited);
    const text = exportText(edited);
    check('Export plain text carries the edited bullet', text.includes('- Led the migration of 40 services to Kubernetes.') && !text.includes('- Migrated 40 services'), text);

    // --- no-op saves --------------------------------------------------------
    for (const [section, index, value] of [
      ['experience', 0, toDraft('experience', base.experience[0])],
      ['experience', 1, toDraft('experience', base.experience[1])], // restored entry lacking fields
      ['header', undefined, toDraft('header', base)],
      ['summary', undefined, toDraft('summary', base.summary)],
      ['skills', undefined, toDraft('skills', base.skills)],
      ['certifications', 0, toDraft('certifications', base.certifications[0])],
    ]) {
      check(`unchanged save of ${section}${index === undefined ? '' : ` ${index}`} is a no-op`, applyTailoredEdit(base, { section, index, value }) === null);
    }

    // --- links: experience -------------------------------------------------
    const withLink = applyTailoredEdit(base, {
      section: 'experience',
      index: 1,
      value: { ...toDraft('experience', base.experience[1]), links: [{ label: ' Case study ', url: ' https://beta.example/case ' }, { label: 'no url', url: '  ' }] },
    });
    check('experience link added, trimmed; url-less link dropped', withLink && JSON.stringify(withLink.resume.experience[1].links) === JSON.stringify([{ label: 'Case study', url: 'https://beta.example/case' }]), withLink?.resume.experience[1]);
    check('Export prints the added experience link', exportText(withLink.resume).includes('https://beta.example/case'));
    const removedLink = applyTailoredEdit(withLink.resume, { section: 'experience', index: 1, value: { ...toDraft('experience', withLink.resume.experience[1]), links: [] } });
    check('experience link removed', removedLink && removedLink.resume.experience[1].links.length === 0 && !exportText(removedLink.resume).includes('beta.example'));

    // --- links: header, project, certification ------------------------------
    const header = applyTailoredEdit(base, { section: 'header', value: { ...toDraft('header', base), customLinks: [...toDraft('header', base).customLinks, { label: 'Site', url: 'https://jane.dev' }] } });
    check('header link added, other contact fields kept', header && header.resume.contact.customLinks.length === 2 && header.resume.contact.email === 'jane@example.com');
    const headerGone = applyTailoredEdit(header.resume, { section: 'header', value: { ...toDraft('header', header.resume), customLinks: [] } });
    check('header links removed', headerGone && headerGone.resume.contact.customLinks.length === 0);
    const project = applyTailoredEdit(base, { section: 'projects', index: 0, value: { ...toDraft('projects', base.projects[0]), links: [{ label: 'Repo', url: 'https://gitlab.com/jane/tracer' }] } });
    check('project link edited', project && project.resume.projects[0].links[0].url === 'https://gitlab.com/jane/tracer');
    const cert = applyTailoredEdit(base, { section: 'certifications', index: 0, value: { ...toDraft('certifications', base.certifications[0]), url: 'https://aws.example/verify/1' } });
    check('certification link added and exported', cert && cert.resume.certifications[0].url === 'https://aws.example/verify/1' && exportText(cert.resume).includes('https://aws.example/verify/1'));
    const certGone = applyTailoredEdit(cert.resume, { section: 'certifications', index: 0, value: { ...toDraft('certifications', cert.resume.certifications[0]), url: '' } });
    check('certification link removed', certGone && certGone.resume.certifications[0].url === '');

    // --- isCurrentlyWorking --------------------------------------------------
    const past = toDraft('experience', base.experience[1]);
    let t = toggleCurrentlyWorking(past, true, '');
    check('toggle on: flag set, end date cleared, old date stashed', t.draft.isCurrentlyWorking === true && t.draft.endDate === '' && t.stash === 'Dec 2019', t);
    const on = applyTailoredEdit(base, { section: 'experience', index: 1, value: t.draft });
    check('saved current role prints "Present"', on && on.resume.experience[1].isCurrentlyWorking === true && on.resume.experience[1].endDate === '' && formatDateRange(on.resume.experience[1].startDate, on.resume.experience[1].endDate, true) === 'Jun 2016 – Present', on?.resume.experience[1]);
    t = toggleCurrentlyWorking(t.draft, false, t.stash);
    check('toggle off: the stashed end date comes back', t.draft.isCurrentlyWorking === false && t.draft.endDate === 'Dec 2019', t);
    t = toggleCurrentlyWorking(toDraft('experience', base.experience[0]), false, '');
    check('toggle off with nothing stashed: end date empty, not "Present"', t.draft.endDate === '' && t.draft.isCurrentlyWorking === false);
    const ended = applyTailoredEdit(base, { section: 'experience', index: 0, value: { ...t.draft, endDate: 'Mar 2024' } });
    check('ending a current role saves flag off with the typed date', ended && ended.resume.experience[0].isCurrentlyWorking === false && exportText(ended.resume).includes('Jan 2020 – Mar 2024'));
    const typedPresent = applyTailoredEdit(base, { section: 'experience', index: 1, value: { ...past, endDate: 'present' } });
    check('typing "present" as the end date sets the flag instead', typedPresent && typedPresent.resume.experience[1].isCurrentlyWorking === true && typedPresent.resume.experience[1].endDate === '');
    const checkedWithDate = applyTailoredEdit(base, { section: 'experience', index: 1, value: { ...past, isCurrentlyWorking: true } });
    check('a current role never keeps a stale end date', checkedWithDate && checkedWithDate.resume.experience[1].endDate === '');

    // --- skills ----------------------------------------------------------
    const skillsDraft = toDraft('skills', base.skills);
    const moved = [
      { category: 'Languages', skills: ['Go'] },
      { category: 'Infrastructure', skills: ['Kubernetes', 'Python'] }, // Python recategorised
      { category: 'infrastructure', skills: ['Terraform', 'kubernetes'] }, // same category, different case, duplicate skill
      { category: 'Empty', skills: [] },
    ];
    const skills = applyTailoredEdit(base, { section: 'skills', value: moved });
    check(
      'skills: recategorised, same-name categories merged, duplicates and empty categories dropped',
      skills && JSON.stringify(skills.resume.skills) === JSON.stringify([{ category: 'Languages', skills: ['Go'] }, { category: 'Infrastructure', skills: ['Kubernetes', 'Python', 'Terraform'] }]),
      skills?.resume.skills
    );
    const removedSkill = applyTailoredEdit(base, { section: 'skills', value: [{ ...skillsDraft[0], skills: ['Go'] }, skillsDraft[1]] });
    check('skills: a removed skill is gone from Export', removedSkill && !exportText(removedSkill.resume).includes('Python'));

    // --- invalid payloads -------------------------------------------------
    for (const [label, tailored, payload] of [
      ['no tailored resume', null, { section: 'summary', value: 'x' }],
      ['unknown section', base, { section: 'name', value: 'x' }],
      ['index out of range', base, { section: 'experience', index: 9, value: past }],
      ['missing index', base, { section: 'experience', value: past }],
      ['entry value not an object (cannot blank an entry)', base, { section: 'experience', index: 0, value: null }],
      ['skills not an array', base, { section: 'skills', value: 'Go' }],
      ['summary not a string', base, { section: 'summary', value: { text: 'x' } }],
      ['payload missing', base, undefined],
    ]) {
      let out;
      try {
        out = applyTailoredEdit(tailored, payload);
      } catch (err) {
        out = err;
      }
      check(`rejected without a throw: ${label}`, out === null, out);
    }

    // --- edit log ---------------------------------------------------------
    let log = recordManualEdit(null, r.edit);
    log = recordManualEdit(log, { section: 'summary', index: null, label: 'Summary' });
    log = recordManualEdit(log, { ...r.edit, label: 'Experience: Staff Engineer — Acme' });
    check('edit log: one row per part, latest label, re-edited part moves last', JSON.stringify(describeManualEdits(log)) === JSON.stringify(['Summary', 'Experience: Staff Engineer — Acme']), log);
    check('edit log: tolerates garbage from storage', JSON.stringify(describeManualEdits([null, 5, { label: 3 }, { label: '  ' }, { label: 'Skills' }])) === JSON.stringify(['Skills']));

    // --- persistence: nothing special --------------------------------------
    if (typeof localStorage !== 'undefined') {
      const backup = localStorage.getItem(RAW_KEY);
      try {
        const state = { resumeText: 'x', resume: base, tailoredResume: edited, tailorManualEdits: log, changesLog: [], sources: {}, settings: {} };
        saveSession(state);
        const loaded = loadSession().state;
        check('persistence: edited tailored resume round-trips exactly', JSON.stringify(loaded.tailoredResume) === JSON.stringify(edited));
        check('persistence: edit log round-trips', JSON.stringify(loaded.tailorManualEdits) === JSON.stringify(log));
        localStorage.setItem(RAW_KEY, JSON.stringify({ version: 1, state: { resumeText: 'x', tailoredResume: edited, tailorManualEdits: 'bad' } }));
        const bad = loadSession();
        check('persistence: a corrupt edit log is dropped on its own', !('tailorManualEdits' in bad.state) && bad.state.tailoredResume && bad.dropped.includes('tailorManualEdits'), bad);
      } finally {
        if (backup === null) localStorage.removeItem(RAW_KEY);
        else localStorage.setItem(RAW_KEY, backup);
      }
    }
  } finally {
    console.log(failed ? `${failed} FAILED` : 'all passed');
    console.groupEnd();
  }
  return failed === 0;
}

/** The action itself, and every path that must clear the edit log. Browser only (imports a .jsx module). */
export function testDraftsOffline() {
  failed = 0;
  console.group('tailorEditor - pending drafts (offline)');
  const r = sample();

  check('addresses: a list section needs an index, a single section must not have one',
    isDraftAddress('experience', 0) && isDraftAddress('summary', null) && !isDraftAddress('summary', 0) && !isDraftAddress('experience', null) && !isDraftAddress('nonsense', null));
  check('keys are stable and distinguish entries', draftKey('summary', null) === 'summary' && draftKey('experience', 1) === 'experience:1');

  // put / drop
  const d1 = putPendingDraft(null, { section: 'summary', value: 'half a sentence' });
  check('put: first draft creates the list', Array.isArray(d1) && d1.length === 1 && d1[0].index === null);
  const d2 = putPendingDraft(d1, { section: 'summary', value: 'half a sentence, continued' });
  check('put: the same block is replaced, not appended', d2.length === 1 && d2[0].value.endsWith('continued'));
  check('put: an identical value returns the SAME array, so no state change and no write', putPendingDraft(d2, { section: 'summary', value: d2[0].value }) === d2);
  const d3 = putPendingDraft(d2, { section: 'experience', index: 0, value: toDraft('experience', r.experience[0]) });
  check('put: a second block is appended (several can be open at once)', d3.length === 2);
  check('put: a bad address changes nothing, same reference', putPendingDraft(d3, { section: 'summary', index: 4, value: 'x' }) === d3);
  check('drop: removes only that block', dropPendingDraft(d3, 'summary').length === 1);
  check('drop: nothing to drop returns the argument itself, null included', dropPendingDraft(d3, 'education', 0) === d3 && dropPendingDraft(null, 'summary') === null);

  // committedDraft / recoverableDrafts
  check('committed: the saved value of a block, as a draft', committedDraft('summary', null, r) === r.summary);
  check('committed: an index past the end of the list is not a block', committedDraft('experience', 9, r) === undefined);
  const same = putPendingDraft(null, { section: 'summary', value: r.summary });
  check('recoverable: a draft equal to the saved value is NOT offered back', recoverableDrafts(same, r).length === 0);
  const diff = putPendingDraft(null, { section: 'summary', value: `${r.summary} And one more clause.` });
  const rec = recoverableDrafts(diff, r);
  check('recoverable: a draft that differs IS offered back, with a label', rec.length === 1 && rec[0].key === 'summary' && rec[0].label === 'Summary');
  check('recoverable: a draft against a block that no longer exists is dropped', recoverableDrafts(putPendingDraft(null, { section: 'experience', index: 9, value: {} }), r).length === 0);
  check('recoverable: junk rows are skipped, not thrown on', recoverableDrafts([null, 'x', { section: 'nope' }, ...diff], r).length === 1);
  check('recoverable: tolerates a missing resume', recoverableDrafts(diff, null).length === 0);
  check('the autosave delay is a real number the live tests can wait on', Number.isFinite(DRAFT_AUTOSAVE_MS) && DRAFT_AUTOSAVE_MS >= 1000 && DRAFT_AUTOSAVE_MS <= 2000);

  console.log(failed ? `${failed} FAILED` : 'all passed');
  console.groupEnd();
  return failed === 0;
}

export async function testReducer() {
  failed = 0;
  const { appReducer, initialState, ACTIONS } = await import('../../context/AppContext.jsx');
  console.group('tailorEditor - reducer');
  try {
    const base = sample();
    const start = { ...initialState, resume: base, parsedJD: {}, tailoredResume: base, changesLog: [], tailorCorrections: [] };
    const update = (state, payload) => appReducer(state, { type: ACTIONS.UPDATE_TAILORED_SECTION, payload });

    let s = update(start, { section: 'summary', value: 'Staff backend engineer.' });
    check('UPDATE_TAILORED_SECTION writes tailoredResume only', s.tailoredResume.summary === 'Staff backend engineer.' && s.resume === base && s.resume.summary === 'Backend engineer.');
    check('and records the edit', JSON.stringify(describeManualEdits(s.tailorManualEdits)) === JSON.stringify(['Summary']));
    check('a no-op edit returns the same state object', update(s, { section: 'summary', value: 'Staff backend engineer.' }) === s);
    check('no tailored resume: ignored', update({ ...start, tailoredResume: null }, { section: 'summary', value: 'x' }).tailoredResume === null);

    check('CLEAR_TAILORING clears the edit log', appReducer(s, { type: ACTIONS.CLEAR_TAILORING }).tailorManualEdits === null);
    check('CLEAR_ANALYSIS clears the edit log', appReducer(s, { type: ACTIONS.CLEAR_ANALYSIS }).tailorManualEdits === null);
    check('a new pass (SET_TAILORED_RESUME) clears the edit log', appReducer(s, { type: ACTIONS.SET_TAILORED_RESUME, payload: { resume: base, changesLog: [], parsedJD: s.parsedJD } }).tailorManualEdits === null);
    const merged = appReducer(s, { type: ACTIONS.MERGE_INFERRED_SKILLS, payload: ['Terraform'] });
    check('approving an inferred skill keeps hand edits and is not logged as one', merged.tailoredResume.summary === 'Staff backend engineer.' && merged.tailorManualEdits.length === 1);
  } finally {
    console.log(failed ? `${failed} FAILED` : 'all passed');
    console.groupEnd();
  }
  return failed === 0;
}

// ---------------------------------------------------------------------------
// Live, against the real Tailor page
// ---------------------------------------------------------------------------

function liveState() {
  const handle = window.a2resumeDev;
  if (!handle || typeof handle.getState !== 'function') throw new Error('window.a2resumeDev is missing. Run this against the dev server.');
  return handle.getState();
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/** Set a React-controlled input the way typing does. */
function setValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const buttonByText = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);

async function openFirstExperience() {
  const button = document.querySelector('button[aria-label="Edit experience 1"]');
  if (!button) throw new Error('No "Edit experience 1" button. Open /tailor on a session with a tailoring pass and at least one role.');
  const block = button.closest('.edit-block');
  button.click();
  await waitFor(() => block.querySelector('.editor'), 'editor to open');
  return block;
}

async function saveBlock(block) {
  buttonByText(block, 'Save').click();
  await waitFor(() => !block.querySelector('.editor'), 'editor to close');
}

function storedTailored() {
  return JSON.parse(localStorage.getItem(RAW_KEY) || 'null')?.state?.tailoredResume ?? null;
}

export async function liveEditBullet() {
  failed = 0;
  console.group('tailorEditor - live: edit a bullet');
  try {
    const block = await openFirstExperience();
    let field = block.querySelector('textarea[aria-label="bullet 1"]');
    if (!field) {
      buttonByText(block, 'Add bullet').click();
      field = await waitFor(() => block.querySelector('textarea[aria-label="bullet 1"]'), 'a bullet field');
    }
    const marker = `Hand-edited bullet ${Date.now().toString(36)}`;
    setValue(field, marker);
    await saveBlock(block);

    const state = liveState();
    check('store: bullet 1 of experience 1 is the edit', state.tailoredResume?.experience?.[0]?.bullets?.[0] === marker);
    check('store: edit log names experience 1', (state.tailorManualEdits ?? []).some((e) => e.section === 'experience' && e.index === 0));
    check('storage: the saved session already carries it', storedTailored()?.experience?.[0]?.bullets?.[0] === marker);
    check('page: the read-only view shows it', block.innerText.includes(marker));
    sessionStorage.setItem(BULLET_KEY, marker);
    console.log('now reload and run verifyBulletSurvived()');
  } finally {
    console.log(failed ? `${failed} FAILED` : 'all passed');
    console.groupEnd();
  }
  return failed === 0;
}

export function verifyBulletSurvived() {
  failed = 0;
  const marker = sessionStorage.getItem(BULLET_KEY);
  if (!marker) throw new Error('Run liveEditBullet() first.');
  console.group('tailorEditor - live: after reload');
  try {
    const state = liveState();
    check('store after reload: the edited bullet is there', state.tailoredResume?.experience?.[0]?.bullets?.[0] === marker);
    check('store after reload: the edit log survived', (state.tailorManualEdits ?? []).some((e) => e.section === 'experience' && e.index === 0));
    if (location.pathname === '/tailor') check('page after reload: the view shows it', document.body.innerText.includes(marker));
    console.log('now open /export and run verifyExportShowsBullet()');
  } finally {
    console.log(failed ? `${failed} FAILED` : 'all passed');
    console.groupEnd();
  }
  return failed === 0;
}

export function verifyExportShowsBullet() {
  failed = 0;
  const marker = sessionStorage.getItem(BULLET_KEY);
  if (!marker) throw new Error('Run liveEditBullet() first.');
  console.group('tailorEditor - live: Export');
  try {
    const state = liveState();
    const { raw, source } = selectExportSource(state);
    check('Export source is the tailored resume', source === 'tailored');
    check('Export plain text (computed) has the edit', exportText(raw).includes(`- ${marker}`));
    const textarea = document.querySelector('#export-plain-text');
    if (textarea) check('Export page textarea has the edit', textarea.value.includes(`- ${marker}`));
    else console.warn('Not on /export: only the computed text was checked.');
  } finally {
    console.log(failed ? `${failed} FAILED` : 'all passed');
    console.groupEnd();
  }
  return failed === 0;
}

export async function liveLinkRoundTrip() {
  failed = 0;
  console.group('tailorEditor - live: add and remove an experience link');
  try {
    const url = `https://example.com/case-${Date.now().toString(36)}`;
    let block = await openFirstExperience();
    const before = block.querySelectorAll('input[aria-label$=" URL"]').length;
    buttonByText(block, 'Add link').click();
    const n = before + 1;
    await waitFor(() => block.querySelector(`input[aria-label="Link ${n} URL"]`), 'new link row');
    setValue(block.querySelector(`input[aria-label="Link ${n} label"]`), 'Case study');
    setValue(block.querySelector(`input[aria-label="Link ${n} URL"]`), url);
    await saveBlock(block);

    let links = liveState().tailoredResume?.experience?.[0]?.links ?? [];
    check('added: store has the link with its label', links.some((l) => l.url === url && l.label === 'Case study'), links);
    check('added: Export text prints it', exportText(liveState().tailoredResume).includes(url));
    check('added: stored session has it', (storedTailored()?.experience?.[0]?.links ?? []).some((l) => l.url === url));

    block = await openFirstExperience();
    const rows = [...block.querySelectorAll('input[aria-label$=" URL"]')];
    const at = rows.findIndex((input) => input.value === url);
    check('removed: the link row is in the form', at !== -1);
    block.querySelector(`button[aria-label="Remove link ${at + 1}"]`).click();
    await waitFor(() => ![...block.querySelectorAll('input[aria-label$=" URL"]')].some((input) => input.value === url), 'row removed');
    await saveBlock(block);

    links = liveState().tailoredResume?.experience?.[0]?.links ?? [];
    check('removed: store no longer has it', !links.some((l) => l.url === url), links);
    check('removed: Export text no longer prints it', !exportText(liveState().tailoredResume).includes(url));
    check('removed: other links left alone', links.length === before);
  } finally {
    console.log(failed ? `${failed} FAILED` : 'all passed');
    console.groupEnd();
  }
  return failed === 0;
}

export async function liveToggleCurrent() {
  failed = 0;
  console.group('tailorEditor - live: toggle isCurrentlyWorking');
  try {
    const endInput = (block) => block.querySelector('input[name="endDate"]');
    const checkbox = (block) => block.querySelector('input[name="isCurrentlyWorking"]');

    // Start from a role that has ended, with a known end date.
    let block = await openFirstExperience();
    if (checkbox(block).checked) {
      checkbox(block).click();
      await waitFor(() => !checkbox(block).checked, 'unchecked');
    }
    setValue(endInput(block), 'Dec 2023');
    await saveBlock(block);
    let entry = liveState().tailoredResume.experience[0];
    check('setup: saved as ended in Dec 2023', entry.isCurrentlyWorking === false && entry.endDate === 'Dec 2023', entry);

    block = await openFirstExperience();
    checkbox(block).click();
    await waitFor(() => checkbox(block).checked, 'checked');
    check('checked: End date is disabled and empty, placeholder "Present"', endInput(block).disabled && endInput(block).value === '' && endInput(block).placeholder === 'Present');
    checkbox(block).click();
    await waitFor(() => !checkbox(block).checked, 'unchecked again');
    check('unchecked in the same edit: Dec 2023 comes back', !endInput(block).disabled && endInput(block).value === 'Dec 2023');
    checkbox(block).click();
    await waitFor(() => checkbox(block).checked, 'checked again');
    await saveBlock(block);

    entry = liveState().tailoredResume.experience[0];
    check('saved current: flag on, no end date stored', entry.isCurrentlyWorking === true && entry.endDate === '', entry);
    check('saved current: Export prints "– Present"', exportText(liveState().tailoredResume).includes(`${entry.startDate} – Present`));
    check('saved current: the view shows "Present"', block.innerText.includes('Present'));

    block = await openFirstExperience();
    checkbox(block).click();
    await waitFor(() => !checkbox(block).checked, 'unchecked');
    check('reopened and unchecked: End date empty (nothing stashed from a stored current role)', endInput(block).value === '');
    setValue(endInput(block), 'Mar 2024');
    await saveBlock(block);
    entry = liveState().tailoredResume.experience[0];
    check('saved ended: flag off, Mar 2024', entry.isCurrentlyWorking === false && entry.endDate === 'Mar 2024', entry);
    check('saved ended: Export prints the range', exportText(liveState().tailoredResume).includes(`${entry.startDate} – Mar 2024`));
  } finally {
    console.log(failed ? `${failed} FAILED` : 'all passed');
    console.groupEnd();
  }
  return failed === 0;
}

// ---------------------------------------------------------------------------
// Draft autosave, live. These type into the SUMMARY block of whatever session
// is loaded, so run them on test data. liveDiscardRecoveredDraft() puts the
// summary back the way it found it.
// ---------------------------------------------------------------------------

const DRAFT_KEY = '__a2resume_editor_draft';
const draftMemo = () => JSON.parse(sessionStorage.getItem(DRAFT_KEY) || '{}');
const rememberDraft = (patch) => sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draftMemo(), ...patch }));

const storedDrafts = () => JSON.parse(localStorage.getItem(RAW_KEY) || 'null')?.state?.draftEdits ?? null;
const pendingDrafts = () => liveState().draftEdits;
const waitForAutosave = () => waitFor(() => pendingDrafts(), 'the autosave to fire', DRAFT_AUTOSAVE_MS + 4000);

async function openSummary() {
  const button = document.querySelector('button[aria-label="Edit summary"]');
  if (!button) throw new Error('No "Edit summary" button. Open /tailor on a session with a tailoring pass.');
  const block = button.closest('.edit-block');
  button.click();
  await waitFor(() => block.querySelector('textarea[name="summary"]'), 'summary field');
  return block;
}

function finishDraft(next) {
  console.log(failed ? `${failed} FAILED` : 'all passed');
  console.groupEnd();
  if (next) console.log(next);
  return failed === 0;
}

/** Step 1: open Summary, type, wait for the debounce, DO NOT save. Then reload. */
export async function liveTypeDraft() {
  failed = 0;
  console.group('tailorEditor - live draft 1: type, autosave, do not save');
  try {
    const saved = liveState().tailoredResume?.summary ?? '';
    const block = await openSummary();
    const field = block.querySelector('textarea[name="summary"]');
    const typed = `${field.value.trim()} DRAFT-MARKER-${Date.now()}`.trim();
    rememberDraft({ saved, typed });

    check('before typing: nothing pending in the store or in storage', pendingDrafts() === null && storedDrafts() === null);
    setValue(field, typed);
    check('immediately after typing: still nothing written (it is debounced)', pendingDrafts() === null);

    await waitForAutosave();
    const pending = pendingDrafts();
    check('the draft reached the store', pending.length === 1 && pending[0].section === 'summary' && pending[0].value === typed);
    check('the draft reached storage, inside the ONE session entry', storedDrafts()?.[0]?.value === typed);
    check('the saved resume is untouched: a draft is not a save', liveState().tailoredResume.summary === saved);
    check('no hand edit was logged for an unsaved draft', !(liveState().tailorManualEdits ?? []).some((e) => e.section === 'summary'));
    console.log(`typed ${typed.length} chars; the saved summary is still ${saved.length} chars`);
  } catch (err) {
    check(err.message, false);
  }
  return finishDraft('Now RELOAD the page (F5), stay on /tailor, then run verifyDraftRecovered().');
}

/** Step 2, after a real reload: the draft came back, reopened and marked unsaved. */
export function verifyDraftRecovered() {
  failed = 0;
  console.group('tailorEditor - live draft 2: recovered after a reload');
  try {
    const { typed, saved } = draftMemo();
    if (typeof typed !== 'string') throw new Error('Run liveTypeDraft() first, then reload.');

    check('the draft survived the reload in the store', pendingDrafts()?.[0]?.value === typed);
    check('the resume is still the last SAVED version, not the draft', liveState().tailoredResume.summary === saved);

    const block = document.querySelector('button[aria-label="Discard Summary draft"]')?.closest('.edit-block');
    check('the Summary block reopened by itself', Boolean(block) && Boolean(block.querySelector('.editor')));
    check('the field holds the draft, not the saved text', block?.querySelector('textarea[name="summary"]')?.value === typed);

    const notice = block?.querySelector('.edit-block__draft');
    check(
      'the block says it is an unsaved recovered draft',
      Boolean(notice) && /unsaved draft/i.test(notice.innerText) && /not your last saved version/i.test(notice.innerText),
      notice?.innerText
    );
    check('there is a control to throw it away', Boolean(buttonByText(notice, 'Discard draft and use the last saved version')));

    const banner = document.querySelector('.editor-recovered');
    check('the page also says so above the editor, naming the part', Boolean(banner) && banner.innerText.includes('Summary') && /not saved yet/i.test(banner.innerText), banner?.innerText);
  } catch (err) {
    check(err.message, false);
  }
  return finishDraft('Next: await liveDiscardRecoveredDraft() to check the fallback path.');
}

/** Step 3: discard the recovered draft; the block falls back to the saved version. Cancel too. */
export async function liveDiscardRecoveredDraft() {
  failed = 0;
  console.group('tailorEditor - live draft 3: discard falls back to the saved version');
  try {
    const { typed, saved } = draftMemo();
    const block = document.querySelector('button[aria-label="Discard Summary draft"]')?.closest('.edit-block');
    if (!block) throw new Error('No recovered Summary draft on screen. Run liveTypeDraft(), reload, then this.');
    check('precondition: the draft is pending', pendingDrafts()?.[0]?.value === typed);

    buttonByText(block, 'Discard draft and use the last saved version').click();
    await waitFor(() => !block.querySelector('.editor'), 'the editor to close');

    check('the pending draft is gone from the store', pendingDrafts() === null);
    check('and gone from storage, not left stale', storedDrafts() === null);
    check('the resume is the last SAVED version', liveState().tailoredResume.summary === saved);
    check('the block shows the saved text again', block.innerText.includes(saved.slice(0, 40)));
    check('the page banner is gone', !document.querySelector('.editor-recovered'));
    check('the draft marker is nowhere on the page', !document.body.innerText.includes('DRAFT-MARKER'));

    // Cancel is the same explicit "no", and must not leave a draft behind.
    const reopened = await openSummary();
    setValue(reopened.querySelector('textarea[name="summary"]'), `${saved} CANCEL-MARKER`);
    await waitForAutosave();
    check('a fresh draft autosaved', pendingDrafts()?.[0]?.value.includes('CANCEL-MARKER'));
    buttonByText(reopened, 'Cancel').click();
    await waitFor(() => !reopened.querySelector('.editor'), 'the editor to close');
    check('Cancel discards the stored draft too, so it cannot come back', pendingDrafts() === null && storedDrafts() === null);
    check('Cancel left the saved resume alone', liveState().tailoredResume.summary === saved);
  } catch (err) {
    check(err.message, false);
  }
  return finishDraft('Next: await liveDraftClearedByNewPass().');
}

/**
 * Step 4: a completed tailoring pass clears a stale pending draft rather than
 * trying to reconcile it.
 *
 * The pass is stubbed through the dev dispatch handle -- the very same
 * SET_TAILORED_RESUME payload Tailor.run dispatches, stamped with the live
 * parsedJD -- so it needs no key and makes no AI call. What is under test is
 * what the reducer does with the draft, not what the model writes.
 */
export async function liveDraftClearedByNewPass() {
  failed = 0;
  console.group('tailorEditor - live draft 4: a new pass clears a stale draft');
  try {
    const { ACTIONS } = await import('../../context/AppContext.jsx');
    const dispatch = window.a2resumeDev?.dispatch;
    if (typeof dispatch !== 'function') throw new Error('window.a2resumeDev.dispatch is missing. Run this against the dev server.');
    const before = liveState();
    if (!before.tailoredResume) throw new Error('Open /tailor on a session with a tailoring pass.');

    const block = await openSummary();
    setValue(block.querySelector('textarea[name="summary"]'), `${before.tailoredResume.summary} STALE-DRAFT-MARKER`);
    await waitForAutosave();
    check('a draft is pending against the current pass', pendingDrafts()?.[0]?.value.includes('STALE-DRAFT-MARKER'));

    const replacement = { ...before.tailoredResume, summary: 'A completely rewritten summary from the new tailoring pass.' };
    dispatch({
      type: ACTIONS.SET_TAILORED_RESUME,
      payload: { resume: replacement, changesLog: [], corrections: [], parsedJD: before.parsedJD },
    });
    await waitFor(() => liveState().tailoredResume?.summary === replacement.summary, 'the new pass to land');

    check('the stale draft is gone from the store', pendingDrafts() === null);
    check('and gone from storage', storedDrafts() === null);
    check('it did not resurrect against the new pass', !liveState().tailoredResume.summary.includes('STALE-DRAFT-MARKER'));
    check('no block reopened claiming a recovered draft', !document.querySelector('.edit-block__draft'));
    check('no recovery banner appeared', !document.querySelector('.editor-recovered'));
    check('the hand-edit log was cleared with the pass, as before', liveState().tailorManualEdits === null);

    // Put the summary back so the session is left as it was found.
    dispatch({
      type: ACTIONS.SET_TAILORED_RESUME,
      payload: { resume: before.tailoredResume, changesLog: before.changesLog ?? [], corrections: before.tailorCorrections ?? [], parsedJD: before.parsedJD },
    });
    await waitFor(() => liveState().tailoredResume?.summary === before.tailoredResume.summary, 'the original summary to return');
    check('the original tailored summary was restored', liveState().tailoredResume.summary === before.tailoredResume.summary);
  } catch (err) {
    check(err.message, false);
  }
  return finishDraft('Done. The draft runners leave no pending draft behind.');
}

export default {
  testOffline,
  testDraftsOffline,
  testReducer,
  liveEditBullet,
  verifyBulletSurvived,
  verifyExportShowsBullet,
  liveLinkRoundTrip,
  liveToggleCurrent,
  liveTypeDraft,
  verifyDraftRecovered,
  liveDiscardRecoveredDraft,
  liveDraftClearedByNewPass,
};
