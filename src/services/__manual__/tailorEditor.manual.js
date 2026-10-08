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
 * Adding and removing whole entries. The offline half runs anywhere; the
 * reducer half needs a JSX-capable loader, so run it in the browser:
 *
 *   t.testEntriesOffline();        // ASSERTIONS, no DOM (also runs under Node)
 *   await t.testEntriesReducer();  // appReducer + hydrate: the score, the drafts,
 *                                  // and the "can anything resurrect a removal?" sweep
 *
 * Live, through the real buttons. These MUTATE the loaded session's experience
 * and certifications, with real reloads between the steps, so run them on test
 * data:
 *
 *   await t.liveAddExperience();   // on /tailor: add an entry, check store + Export + score
 *   // reload (F5)
 *   (await import('...')).verifyAddedEntrySurvived();
 *   await t.liveAddAroundDraft();  // insert at the top around a draft and a log row
 *   // reload (F5)
 *   (await import('...')).verifyInsertDraftSurvived();  // also cleans up after itself
 *   await t.liveRemoveEntry();     // "Keep it", then confirm; checks the score falls back
 *   // reload (F5)
 *   (await import('...')).verifyRemovalSurvived();
 *   await t.liveRemoveEntryWithDraft();  // a draft on one entry while another is removed
 *   // reload (F5)
 *   (await import('...')).verifyDraftDidNotResurrect();
 *   await t.liveEmptySection();    // every certification removed
 *   // open /export
 *   (await import('...')).verifyExportAfterEmptying();
 *   // back on /tailor
 *   (await import('...')).restoreEmptiedSection();
 *
 * Live checks read the store through window.a2resumeDev (dev builds only) and
 * never print resume content beyond the test's own marker text.
 */

import {
  DRAFT_AUTOSAVE_MS,
  ENTRY_INSERT_AT,
  LIST_SECTIONS,
  NEW_ENTRY_INDEX,
  applyChangeEdit,
  applyTailoredEdit,
  applyTailoredEntryAdd,
  applyTailoredEntryRemoval,
  changeEditPayload,
  committedDraft,
  currentChangeText,
  describeEntry,
  describeManualEdits,
  draftKey,
  dropPendingDraft,
  entryBlockKeys,
  entryInsertIndex,
  insertsAtTop,
  isBlankEntryDraft,
  isDraftAddress,
  locateChange,
  newEntryDraft,
  splitSkillLine,
  putPendingDraft,
  recordManualEdit,
  recoverableDrafts,
  reindexRowsAfterInsertion,
  reindexRowsAfterRemoval,
  toDraft,
  toggleCurrentlyWorking,
} from '../tailoredEdits.js';
import {
  formatDateRange,
  generatePlainText,
  hasExportableContent,
  normalizeResumeForExport,
  sectionHasContent,
  selectExportSource,
} from '../resumeExport.js';
import { mergeNonDestructiveResume } from '../resumeTailor.js';
import { analyzeCompetencyGaps } from '../gapAnalyzer.js';
import { calculateATSScore } from '../atsScorer.js';
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
const hasExportable = (resume) => hasExportableContent(normalizeResumeForExport(resume));

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

/**
 * Adding and removing whole entries. Pure: no DOM, no key, no network, so this
 * also runs under Node.
 *
 * Four things here are the point, and each is written as the failure it
 * prevents rather than as the behaviour it asserts:
 * - index drift on a removal reattaching a pending draft to the wrong entry,
 * - the same drift on an INSERTION at the top, which is where experience and
 *   education now add entries (ENTRY_INSERT_AT),
 * - mergeNonDestructiveResume resurrecting a deliberate removal,
 * - a section emptied to zero entries breaking Export instead of disappearing.
 */
export function testEntriesOffline() {
  failed = 0;
  console.group('tailorEditor - add and remove entries (offline)');
  try {
    const base = sample();
    const frozen = JSON.stringify(base);

    // --- the blank draft ---------------------------------------------------
    const blank = newEntryDraft('experience');
    check(
      'a new-entry draft has exactly the keys the edit form already renders',
      JSON.stringify(Object.keys(blank)) === JSON.stringify(Object.keys(toDraft('experience', base.experience[0]))),
      Object.keys(blank)
    );
    check('a new-entry draft starts blank, and not "currently working"', blank.title === '' && blank.bullets.length === 0 && blank.isCurrentlyWorking === false);
    check('no blank draft for a section that has no entries', newEntryDraft('summary') === null && newEntryDraft('nonsense') === null);
    check('blankness is detected for every list section', ['experience', 'projects', 'education', 'certifications'].every((sec) => isBlankEntryDraft(sec, newEntryDraft(sec))));
    check('blankness is detected for junk and for a typed draft', isBlankEntryDraft('experience', null) && isBlankEntryDraft('nonsense', blank) && !isBlankEntryDraft('experience', { ...blank, title: 'Contractor' }));

    // --- add ---------------------------------------------------------------
    check('add: an entirely blank entry is refused', applyTailoredEntryAdd(base, { section: 'experience', value: blank }) === null);
    const added = applyTailoredEntryAdd(base, {
      section: 'experience',
      value: {
        ...blank,
        title: 'Platform Engineer',
        company: 'Nimbus Data',
        location: 'Remote',
        startDate: 'Feb 2024',
        isCurrentlyWorking: true,
        bullets: ['  Ran the Terraform migration for 12 accounts.  ', '', 'Cut deploy time from 40 to 6 minutes.'],
        links: [{ label: 'Case study', url: ' https://nimbus.example/case ' }, { label: 'dead', url: '  ' }],
      },
    });
    check('add: experience inserts FIRST, where the most recent role belongs', added && added.resume.experience.length === 3 && added.index === 0, added && { length: added.resume.experience.length, index: added.index });
    check('add: every existing entry is the SAME object, just one slot later', added && added.resume.experience[1] === base.experience[0] && added.resume.experience[2] === base.experience[1]);
    check('add: other sections untouched, input not mutated', added && added.resume.projects === base.projects && JSON.stringify(base) === frozen);
    const fresh = added.resume.experience[0];
    check('add: committed like a save -- trimmed, blank bullet gone, url-less link gone', fresh.bullets.length === 2 && fresh.bullets[0] === 'Ran the Terraform migration for 12 accounts.' && fresh.links.length === 1 && fresh.links[0].url === 'https://nimbus.example/case', fresh);
    check('add: a current role stores the flag, not an end date', fresh.isCurrentlyWorking === true && fresh.endDate === '');
    const addedText = exportText(added.resume);
    check('add: Export prints the new entry, its bullets and its link', addedText.includes('Platform Engineer — Nimbus Data') && addedText.includes('- Cut deploy time from 40 to 6 minutes.') && addedText.includes('https://nimbus.example/case') && addedText.includes('Feb 2024 – Present'));
    check('add: Export prints it ABOVE the roles it was inserted before', addedText.indexOf('Platform Engineer — Nimbus Data') < addedText.indexOf('Senior Engineer — Acme'), addedText.slice(addedText.indexOf('EXPERIENCE'), addedText.indexOf('EXPERIENCE') + 160));
    check('add: logged as a hand edit at the index it actually occupies', added.edit.section === 'experience' && added.edit.index === 0 && added.edit.label === 'Experience: Platform Engineer — Nimbus Data (added by hand)', added.edit);
    for (const [label, payload] of [
      ['unknown section', { section: 'summary', value: blank }],
      ['value not an object', { section: 'experience', value: 'Platform Engineer' }],
      ['payload missing', undefined],
    ]) {
      let out;
      try {
        out = applyTailoredEntryAdd(base, payload);
      } catch (err) {
        out = err;
      }
      check(`add rejected without a throw: ${label}`, out === null, out);
    }
    check('add: works for every list section', ['projects', 'education', 'certifications'].every((sec) => {
      const value = { ...newEntryDraft(sec), name: 'X', institution: 'X', degree: 'X' };
      const r = applyTailoredEntryAdd(base, { section: sec, value });
      return r && r.resume[sec].length === base[sec].length + 1;
    }));

    // --- the insertion point, per section ----------------------------------
    // Experience and education are read newest-first, so a hand-added entry
    // goes at the top. Projects and certifications have no such convention and
    // append, which is also the position that moves no index at all.
    check('insertion point: experience and education at the top, projects and certifications at the end',
      insertsAtTop('experience') && insertsAtTop('education') && !insertsAtTop('projects') && !insertsAtTop('certifications'));
    check('insertion point: every list section declares one, and nothing else does',
      LIST_SECTIONS.every((sec) => ['top', 'end'].includes(ENTRY_INSERT_AT[sec])) &&
      Object.keys(ENTRY_INSERT_AT).every((sec) => LIST_SECTIONS.includes(sec)), ENTRY_INSERT_AT);
    check('insertion point: entryInsertIndex agrees with it, and an append is the old length',
      entryInsertIndex('experience', 3) === 0 && entryInsertIndex('education', 3) === 0 && entryInsertIndex('projects', 3) === 3 && entryInsertIndex('certifications', 0) === 0);
    check('insertion point: an "end" section still appends, and moves no existing entry', (() => {
      const r = applyTailoredEntryAdd(base, { section: 'projects', value: { ...newEntryDraft('projects'), name: 'Later project' } });
      return r.index === 1 && r.resume.projects[0] === base.projects[0] && r.resume.projects[1].name === 'Later project';
    })());
    check('insertion point: education inserts first too', (() => {
      const r = applyTailoredEntryAdd(base, { section: 'education', value: { ...newEntryDraft('education'), institution: 'Open University', degree: 'MSc' } });
      return r.index === 0 && r.resume.education[0].institution === 'Open University' && r.resume.education[1] === base.education[0];
    })());
    check('insertion point: adding to an EMPTY section is index 0 either way', (() => {
      const bare = { ...base, experience: [], projects: [] };
      const top = applyTailoredEntryAdd(bare, { section: 'experience', value: { ...blank, title: 'Only role' } });
      const end = applyTailoredEntryAdd(bare, { section: 'projects', value: { ...newEntryDraft('projects'), name: 'Only project' } });
      return top.index === 0 && end.index === 0 && top.resume.experience.length === 1 && end.resume.projects.length === 1;
    })());

    // --- remove ------------------------------------------------------------
    check('remove: an index out of range, a missing index and an unknown section are all refused',
      applyTailoredEntryRemoval(base, { section: 'experience', index: 9 }) === null &&
      applyTailoredEntryRemoval(base, { section: 'experience' }) === null &&
      applyTailoredEntryRemoval(base, { section: 'summary', index: 0 }) === null &&
      applyTailoredEntryRemoval(null, { section: 'experience', index: 0 }) === null);

    const gone = applyTailoredEntryRemoval(base, { section: 'experience', index: 0 });
    check('remove: that entry only, the other kept as the SAME object', gone && gone.resume.experience.length === 1 && gone.resume.experience[0] === base.experience[1], gone && gone.resume.experience);
    check('remove: other sections untouched, input not mutated', gone && gone.resume.education === base.education && JSON.stringify(base) === frozen);
    check('remove: Export no longer prints it', !exportText(gone.resume).includes('Senior Engineer — Acme') && !exportText(gone.resume).includes('Cut p99 latency'));
    check('remove: Export still prints the survivor', exportText(gone.resume).includes('Engineer — Beta'));
    check('remove: logged with a null index and append, so it keys on nothing that can shift', gone.edit.index === null && gone.edit.append === true && gone.edit.label === 'Experience: Senior Engineer — Acme (removed by hand)', gone.edit);

    // Two removals are two rows. A removal replacing the previous one would be
    // a destructive-action log that under-reports.
    const both = applyTailoredEntryRemoval(gone.resume, { section: 'experience', index: 0 });
    const log2 = recordManualEdit(recordManualEdit(null, gone.edit), both.edit);
    check('remove: two removals in one section are two log rows', log2.length === 2 && JSON.stringify(describeManualEdits(log2)) === JSON.stringify(['Experience: Senior Engineer — Acme (removed by hand)', 'Experience: Engineer — Beta (removed by hand)']), log2);
    check('remove: a normal edit row is still replaced, not duplicated', recordManualEdit(recordManualEdit(null, { section: 'summary', index: null, label: 'Summary' }), { section: 'summary', index: null, label: 'Summary' }).length === 1);
    check('remove: a removal row does not wipe an edit row for the same section', recordManualEdit(log2, { section: 'experience', index: 0, label: 'Experience: X' }).length === 3);

    // --- a section emptied to zero ----------------------------------------
    check('empty: the section is an empty array, not missing', Array.isArray(both.resume.experience) && both.resume.experience.length === 0);
    const emptyNorm = normalizeResumeForExport(both.resume);
    check('empty: the normaliser yields an empty array, no throw', Array.isArray(emptyNorm.experience) && emptyNorm.experience.length === 0);
    check('empty: sectionHasContent says no, so the PDF omits the section', sectionHasContent(emptyNorm, 'experience') === false);
    const emptyText = exportText(both.resume);
    check('empty: the plain text has no EXPERIENCE heading at all', !emptyText.includes('EXPERIENCE'), emptyText.slice(0, 120));
    check('empty: the other sections still print', emptyText.includes('EDUCATION') && emptyText.includes('SKILLS') && emptyText.includes('Tracer'));
    check('empty: there is still exportable content, so Export does not show its empty state', hasExportable(both.resume) === true);
    let stripped = { ...both.resume, summary: '', name: '' };
    for (const sec of ['projects', 'education', 'certifications', 'skills']) stripped = { ...stripped, [sec]: [] };
    check('empty: a resume emptied of everything printable falls to the Export empty state instead of a blank PDF', hasExportable(stripped) === false);

    // --- reindexing ---------------------------------------------------------
    const four = { ...base, experience: [base.experience[0], base.experience[1], { title: 'Intern', company: 'Gamma', bullets: ['Wrote a script.'] }, { title: 'Junior', company: 'Delta', bullets: ['Fixed tickets.'] }] };
    const rows = [
      { section: 'experience', index: 0, label: 'exp0' },
      { section: 'experience', index: 1, label: 'exp1' },
      { section: 'experience', index: 2, label: 'exp2' },
      { section: 'experience', index: 3, label: 'exp3' },
      { section: 'projects', index: 1, label: 'proj1' },
      { section: 'summary', index: null, label: 'summary' },
      { section: 'experience', index: NEW_ENTRY_INDEX, label: 'new' },
      'junk from storage',
    ];
    const moved = reindexRowsAfterRemoval(rows, 'experience', 1);
    check('reindex: the removed index is dropped', !moved.some((r) => r.label === 'exp1'));
    check('reindex: rows above it move down one', moved.find((r) => r.label === 'exp2').index === 1 && moved.find((r) => r.label === 'exp3').index === 2);
    check('reindex: rows below it do not move', moved.find((r) => r.label === 'exp0').index === 0);
    check('reindex: another section, a null index, the new-entry sentinel and junk are untouched',
      moved.find((r) => r.label === 'proj1').index === 1 && moved.find((r) => r.label === 'summary').index === null && moved.find((r) => r.label === 'new').index === NEW_ENTRY_INDEX && moved.includes('junk from storage'));
    check('reindex: no change returns the argument itself, null included', reindexRowsAfterRemoval(rows, 'education', 0) === rows && reindexRowsAfterRemoval(null, 'experience', 0) === null && reindexRowsAfterRemoval(rows, 'experience', 'x') === rows);
    check('reindex: the draft value object is carried across unchanged, which is what the editor freezes on',
      (() => {
        const value = { title: 'typed' };
        const out = reindexRowsAfterRemoval([{ section: 'experience', index: 2, value }], 'experience', 1);
        return out[0].value === value && out[0].index === 1;
      })());

    // THE DRIFT BUG, end to end. A pending draft against experience 2, then
    // experience 1 is removed. Without the reindex the draft resolves to the
    // entry that shifted into slot 2 -- a different role -- and is offered
    // back under that role's name with this role's text in the form.
    const draftValue = { ...toDraft('experience', four.experience[2]), bullets: ['Wrote a script that became the deploy tool.'] };
    const drafts = putPendingDraft(null, { section: 'experience', index: 2, value: draftValue });
    const shortened = applyTailoredEntryRemoval(four, { section: 'experience', index: 1 }).resume;
    const unmigrated = recoverableDrafts(drafts, shortened);
    check('drift (proof the bug is real): WITHOUT reindexing, the draft is offered back under the wrong entry', unmigrated.length === 1 && unmigrated[0].label === 'Experience: Junior — Delta', unmigrated[0] && unmigrated[0].label);
    const migrated = recoverableDrafts(reindexRowsAfterRemoval(drafts, 'experience', 1), shortened);
    check('drift (fixed): WITH reindexing, it is offered back under its own entry', migrated.length === 1 && migrated[0].label === 'Experience: Intern — Gamma' && migrated[0].value === draftValue, migrated[0] && migrated[0].label);
    const removedItsOwn = recoverableDrafts(reindexRowsAfterRemoval(drafts, 'experience', 2), applyTailoredEntryRemoval(four, { section: 'experience', index: 2 }).resume);
    check('drift: removing the entry a draft belongs to drops that draft, it is not reattached', removedItsOwn.length === 0, removedItsOwn);

    // --- reindexing the other way: an insertion ----------------------------
    const pushed = reindexRowsAfterInsertion(rows, 'experience', 0);
    check('insert-reindex: every row in the section moves up one', pushed.find((r) => r.label === 'exp0').index === 1 && pushed.find((r) => r.label === 'exp3').index === 4);
    check('insert-reindex: nothing is dropped -- an insertion destroys no entry', pushed.filter((r) => typeof r === 'object' && r.section === 'experience' && Number.isInteger(r.index)).length === 4);
    check('insert-reindex: the row AT the insertion point is the displaced one, so it moves', reindexRowsAfterInsertion(rows, 'experience', 2).find((r) => r.label === 'exp2').index === 3);
    check('insert-reindex: rows below the insertion point do not move', reindexRowsAfterInsertion(rows, 'experience', 2).find((r) => r.label === 'exp1').index === 1);
    check('insert-reindex: another section, a null index, the new-entry sentinel and junk are untouched',
      pushed.find((r) => r.label === 'proj1').index === 1 && pushed.find((r) => r.label === 'summary').index === null && pushed.find((r) => r.label === 'new').index === NEW_ENTRY_INDEX && pushed.includes('junk from storage'));
    check('insert-reindex: an APPEND moves nothing, so it returns the argument itself',
      reindexRowsAfterInsertion(rows, 'experience', 4) === rows && reindexRowsAfterInsertion(rows, 'projects', 2) === rows);
    check('insert-reindex: no change returns the argument itself, null included',
      reindexRowsAfterInsertion(rows, 'education', 0) === rows && reindexRowsAfterInsertion(null, 'experience', 0) === null && reindexRowsAfterInsertion(rows, 'experience', 'x') === rows);
    check('insert-reindex: the draft value object is carried across unchanged, which is what the editor freezes on',
      (() => {
        const value = { title: 'typed' };
        const out = reindexRowsAfterInsertion([{ section: 'experience', index: 1, value }], 'experience', 0);
        return out[0].value === value && out[0].index === 2;
      })());

    // THE DRIFT BUG ON AN INSERTION, end to end, and its fix. A pending draft
    // against experience 0, then a new entry inserted at 0. Without the shift
    // the draft resolves to the brand-new entry -- a different role -- and is
    // offered back under its name with this role's text in the form.
    const headDraftValue = { ...toDraft('experience', four.experience[0]), bullets: ['Rewrote the migration tooling.'] };
    const headDrafts = putPendingDraft(null, { section: 'experience', index: 0, value: headDraftValue });
    const inserted = applyTailoredEntryAdd(four, { section: 'experience', value: { ...blank, title: 'Platform Engineer', company: 'Nimbus Data' } });
    const notShifted = recoverableDrafts(headDrafts, inserted.resume);
    check('insert drift (proof the bug is real): WITHOUT shifting, the draft is offered back under the NEW entry', notShifted.length === 1 && notShifted[0].label === 'Experience: Platform Engineer — Nimbus Data', notShifted[0] && notShifted[0].label);
    const shifted = recoverableDrafts(reindexRowsAfterInsertion(headDrafts, 'experience', inserted.index), inserted.resume);
    check('insert drift (fixed): WITH shifting, it is offered back under its own entry', shifted.length === 1 && shifted[0].label === 'Experience: Senior Engineer — Acme' && shifted[0].value === headDraftValue, shifted[0] && shifted[0].label);
    check('insert drift: the edit log shifts the same way, so a logged edit keeps naming its own entry', (() => {
      const log = recordManualEdit(null, { section: 'experience', index: 0, label: 'Experience: Senior Engineer — Acme' });
      const moved2 = reindexRowsAfterInsertion(log, 'experience', inserted.index);
      // The new entry's own row is recorded AFTER the shift, exactly as the
      // reducer does it, so it cannot replace the row that used to hold index 0.
      const full = recordManualEdit(moved2, inserted.edit);
      return moved2[0].index === 1 && full.length === 2 && full.some((e) => e.index === 0 && /Nimbus Data/.test(e.label));
    })());

    // --- the new-entry draft address ---------------------------------------
    check('new-entry address: valid for a list section, not for a single one', isDraftAddress('experience', NEW_ENTRY_INDEX) && !isDraftAddress('summary', NEW_ENTRY_INDEX));
    check('new-entry address: its own key, distinct from every index', draftKey('experience', NEW_ENTRY_INDEX) === 'experience:new' && draftKey('experience', 0) === 'experience:0');
    check('new-entry address: its committed value is the blank the form opens with', JSON.stringify(committedDraft('experience', NEW_ENTRY_INDEX, base)) === JSON.stringify(newEntryDraft('experience')));
    const blankPending = putPendingDraft(null, { section: 'experience', index: NEW_ENTRY_INDEX, value: newEntryDraft('experience') });
    check('new-entry draft: still blank, so it is not offered back', recoverableDrafts(blankPending, base).length === 0);
    const typedPending = putPendingDraft(null, { section: 'experience', index: NEW_ENTRY_INDEX, value: { ...blank, title: 'Contractor' } });
    const typedRec = recoverableDrafts(typedPending, base);
    check('new-entry draft: typed in, so it IS offered back, labelled as a new entry', typedRec.length === 1 && typedRec[0].label === 'Experience: a new entry' && typedRec[0].key === 'experience:new', typedRec[0]);
    check('new-entry draft: dropped by address like any other', dropPendingDraft(typedPending, 'experience', NEW_ENTRY_INDEX).length === 0);

    // --- the `only` filter the editor freezes on ---------------------------
    const two = putPendingDraft(putPendingDraft(null, { section: 'summary', value: 'a recovered one' }), { section: 'experience', index: 0, value: { ...toDraft('experience', base.experience[0]), title: 'typed since' } });
    const onlyFirst = recoverableDrafts(two, base, new Set([two[0].value]));
    check('seeds: restricting to one draft value returns only that one', onlyFirst.length === 1 && onlyFirst[0].section === 'summary', onlyFirst);
    check('seeds: an empty set returns nothing; no set returns everything', recoverableDrafts(two, base, new Set()).length === 0 && recoverableDrafts(two, base).length === 2);

    // --- React keys ---------------------------------------------------------
    const keys = entryBlockKeys('experience', four.experience);
    check('keys: one per entry, derived from what the entry says', keys.length === 4 && keys[0] === 'Senior Engineer — Acme', keys);
    check('keys: stable across the removal of a different entry', JSON.stringify(entryBlockKeys('experience', shortened.experience)) === JSON.stringify([keys[0], keys[2], keys[3]]), entryBlockKeys('experience', shortened.experience));
    const dupes = entryBlockKeys('experience', [four.experience[0], four.experience[0], {}, {}]);
    check('keys: identical entries are still distinct blocks', new Set(dupes).size === 4, dupes);

    // --- POINT 3: mergeNonDestructiveResume and a deliberate removal --------
    // The merge exists to restore entries the MODEL dropped, so it treats a
    // missing entry as an accident. Fed a hand-edited resume it would undo the
    // user's decision. This asserts the hazard is real, so that the closure --
    // it is never called with state.tailoredResume as its second argument --
    // is a checked fact rather than an assumption. The reducer half of this is
    // testEntriesReducer().
    const remerged = mergeNonDestructiveResume(base, gone.resume);
    check(
      'merge hazard is real: fed a resume with an entry removed by hand, the merge restores it',
      remerged.resume.experience.length === 2 && remerged.resume.experience.some((e) => e.company === 'Acme'),
      remerged.resume.experience.map((e) => e.company)
    );
    check('merge hazard: and reports it as a correction, believing it was an accident', remerged.corrections.some((c) => /restor/i.test(String(c.detail))), remerged.corrections);
    check('merge on a FRESH pass still restores a model-dropped entry, which is its job', mergeNonDestructiveResume(base, { ...base, experience: [base.experience[0]] }).resume.experience.length === 2);

    // --- persistence: nothing special needed --------------------------------
    if (typeof localStorage !== 'undefined') {
      const backup = localStorage.getItem(RAW_KEY);
      try {
        const state = {
          resumeText: 'x',
          resume: base,
          tailoredResume: both.resume,
          tailorManualEdits: log2,
          draftEdits: typedPending,
          changesLog: [],
          sources: {},
          settings: {},
        };
        saveSession(state);
        const loaded = loadSession().state;
        check('persistence: an emptied section round-trips as an empty array', Array.isArray(loaded.tailoredResume.experience) && loaded.tailoredResume.experience.length === 0);
        check('persistence: the tailored resume round-trips exactly', JSON.stringify(loaded.tailoredResume) === JSON.stringify(both.resume));
        check('persistence: the removal rows round-trip', JSON.stringify(loaded.tailorManualEdits) === JSON.stringify(log2));
        check('persistence: a new-entry draft round-trips with its sentinel index', loaded.draftEdits && loaded.draftEdits[0] && loaded.draftEdits[0].index === NEW_ENTRY_INDEX, loaded.draftEdits);
      } finally {
        if (backup === null) localStorage.removeItem(RAW_KEY);
        else localStorage.setItem(RAW_KEY, backup);
      }
    }
  } catch (err) {
    check(`threw: ${err.message}`, false, err);
  } finally {
    console.log(failed ? `${failed} FAILED` : 'all passed');
    console.groupEnd();
  }
  return failed === 0;
}

/**
 * "What the AI changed" edits: finding a change's text in the tailored resume,
 * and committing an edit to exactly that line through applyTailoredEdit.
 * Pure, so it also runs under Node.
 *
 * @returns {boolean}
 */
export function testChangeEditsOffline() {
  failed = 0;
  console.group('tailorEditor - AI change edits (offline)');
  try {
    const base = sample();
    const loc = (change) => locateChange(base, change);

    check('summary: found by its text', (() => {
      const l = loc({ section: 'summary', after: 'Backend engineer.' });
      return l && l.section === 'summary' && l.index === null && l.text === 'Backend engineer.' && l.exact === true;
    })());
    check('experience bullet: found with case and spacing folded', (() => {
      const l = loc({ section: 'Work Experience', target: 'Acme', after: '  cut P99 latency   by 35%. ' });
      return l && l.section === 'experience' && l.index === 0 && l.field === 'bullets' && l.line === 1;
    })());
    check('project description: found', (() => {
      const l = loc({ section: 'projects', target: 'Tracer', after: 'Tracing library.' });
      return l && l.section === 'projects' && l.index === 0 && l.field === 'description' && l.line === null;
    })());
    check('education detail: found', (() => {
      const r = { ...base, education: [{ ...base.education[0], details: ['First-class honours.'] }] };
      const l = locateChange(r, { section: 'education', after: 'First-class honours.' });
      return l && l.section === 'education' && l.field === 'details' && l.line === 0;
    })());
    check('skill: found inside its category', (() => {
      const l = loc({ section: 'skills', after: 'Kubernetes' });
      return l && l.section === 'skills' && l.field === 1 && l.line === 0;
    })());
    check('a mislabelled section still finds the text elsewhere', loc({ section: 'summary', after: 'Built a reporting API.' })?.index === 1);
    check('target first: the same bullet in two roles resolves to the named one', (() => {
      const twin = { ...base, experience: [base.experience[0], { ...base.experience[1], bullets: ['Migrated 40 services to Kubernetes.'] }] };
      return locateChange(twin, { section: 'experience', target: 'Beta', after: 'Migrated 40 services to Kubernetes.' })?.index === 1
        && locateChange(twin, { section: 'experience', target: 'Acme', after: 'Migrated 40 services to Kubernetes.' })?.index === 0;
    })());
    check('no match: null', loc({ section: 'experience', after: 'Text that is nowhere.' }) === null);
    check('empty after: null', loc({ section: 'summary', after: '' }) === null);
    check('junk input: null, no throw', locateChange(null, {}) === null && locateChange(base, null) === null && locateChange(base, 'x') === null);
    check('currentChangeText prefers a non-blank edit', currentChangeText({ after: 'A', edited: 'B' }) === 'B' && currentChangeText({ after: 'A', edited: '  ' }) === 'A');

    const payload = changeEditPayload(base, loc({ section: 'experience', target: 'Acme', after: 'Cut p99 latency by 35%.' }), 'Cut p99 latency by 35% with gRPC.');
    const applied = applyTailoredEdit(base, payload);
    check('the payload changes that bullet and nothing else', (() => {
      const e = applied.resume.experience;
      return e[0].bullets[1] === 'Cut p99 latency by 35% with gRPC.' && e[0].bullets[0] === base.experience[0].bullets[0]
        && e[0].company === 'Acme' && e[0].isCurrentlyWorking === true && e[1] === base.experience[1] && applied.resume.summary === base.summary;
    })());

    const log = [
      { section: 'summary', target: '', before: 'Engineer.', after: 'Backend engineer.', reason: 'r' },
      { section: 'experience', target: 'Acme', before: 'Cut latency.', after: 'Cut p99 latency by 35%.', reason: 'r' },
    ];
    const first = applyChangeEdit(base, log, { changeIndex: 1, text: '  Cut p99 latency by 35% using Go.  ' });
    check('applyChangeEdit: writes the line, trimmed', first?.resume.experience[0].bullets[1] === 'Cut p99 latency by 35% using Go.');
    check('applyChangeEdit: records edited, keeps the AI after', first?.changesLog[1].edited === 'Cut p99 latency by 35% using Go.' && first.changesLog[1].after === 'Cut p99 latency by 35%.' && first.changesLog[0] === log[0]);
    check('applyChangeEdit: returns a normal edit-log row', first?.edit.section === 'experience' && first.edit.index === 0 && first.edit.label.includes('Acme'));
    const second = first && applyChangeEdit(first.resume, first.changesLog, { changeIndex: 1, text: 'Cut p99 latency by 35% using Go and gRPC.' });
    check('a second edit is found through `edited`', second?.resume.experience[0].bullets[1] === 'Cut p99 latency by 35% using Go and gRPC.');
    check('blank text is refused (it would delete the bullet)', applyChangeEdit(base, log, { changeIndex: 1, text: '   ' }) === null);
    check('unchanged text is a no-op', applyChangeEdit(base, log, { changeIndex: 0, text: 'Backend engineer.' }) === null);
    check('a bad index or a lost change is refused', applyChangeEdit(base, log, { changeIndex: 5, text: 'x' }) === null
      && applyChangeEdit(base, [{ section: 'experience', after: 'gone' }], { changeIndex: 0, text: 'x' }) === null
      && applyChangeEdit(base, log, { changeIndex: '1', text: 'x' }) === null);
    check('a skill edit renames that skill only', (() => {
      const out = applyChangeEdit(base, [{ section: 'skills', after: 'Python' }], { changeIndex: 0, text: 'Python 3' });
      return out && JSON.stringify(out.resume.skills) === JSON.stringify([{ category: 'Languages', skills: ['Go', 'Python 3'] }, { category: 'Infrastructure', skills: ['Kubernetes'] }]);
    })());

    // The log is the model's account of its edit, not a copy of it.
    const bigger = {
      ...base,
      summary: 'Backend engineer with eight years building Go services at scale.',
      experience: [
        { ...base.experience[0], bullets: ['Migrated 40 services to Kubernetes \u2014 with zero downtime.', 'Cut p99 latency by 35% across the payments platform using gRPC.'] },
        base.experience[1],
      ],
      skills: [...base.skills, { category: 'Cloud', skills: ['AWS (EC2, S3)', 'GCP', 'Terraform'] }],
    };
    check('punctuation and dashes are ignored', (() => {
      const l = locateChange(bigger, { section: 'experience', target: 'Acme', after: 'Migrated 40 services to Kubernetes - with zero downtime' });
      return l && l.index === 0 && l.line === 0 && l.exact === true;
    })());
    check('a reworded log line finds the close bullet, and opens on the real text', (() => {
      const l = locateChange(bigger, { section: 'experience', target: 'Acme', after: 'Cut p99 latency by 35% across the payments platform with gRPC.' });
      return l && l.line === 1 && l.exact === false && l.text === bigger.experience[0].bullets[1];
    })());
    check('the merge restored the original: found through before', (() => {
      const l = locateChange(base, { section: 'experience', target: 'Beta', before: 'Built a reporting API.', after: 'Designed and shipped a reporting API in Go for finance.' });
      return l && l.index === 1 && l.line === 0 && l.text === 'Built a reporting API.';
    })());
    check('once edited by hand, before is not a fallback', locateChange(base, { section: 'experience', before: 'Built a reporting API.', after: 'x y z w', edited: 'Something else entirely here now.' }) === null);
    check('a summary change always finds the one summary', (() => {
      const l = locateChange(bigger, { section: 'Professional Summary', after: 'Completely different summary text the model reported.' });
      return l && l.section === 'summary' && l.exact === false && l.text === bigger.summary;
    })());
    check('different lines are not close matches', locateChange(bigger, { section: 'experience', after: 'Organised the office summer party for forty people.' }) === null);
    check('short lines match exactly or not at all', locateChange(bigger, { section: 'skills', after: 'Go SDK' }) === null);
    check('a skills category line is found as one line', (() => {
      const l = locateChange(bigger, { section: 'Technical Expertise', after: 'Cloud: AWS (EC2, S3), GCP, Terraform' });
      return l && l.section === 'skills' && l.field === 2 && l.line === null;
    })());
    check('editing a category line splits it back into skills, brackets kept', (() => {
      const out = applyChangeEdit(bigger, [{ section: 'skills', after: 'AWS (EC2, S3), GCP, Terraform' }], { changeIndex: 0, text: 'Cloud: AWS (EC2, S3, EKS), GCP, Terraform, Pulumi' });
      return out && JSON.stringify(out.resume.skills[2]) === JSON.stringify({ category: 'Cloud', skills: ['AWS (EC2, S3, EKS)', 'GCP', 'Terraform', 'Pulumi'] }) && JSON.stringify(out.resume.skills[0]) === JSON.stringify(bigger.skills[0]);
    })());
    check('splitSkillLine keeps a colon that is not the category', JSON.stringify(splitSkillLine('Vue: 3, React', 'Frameworks')) === JSON.stringify(['Vue: 3', 'React']));
    check('a close-match edit writes that bullet only', (() => {
      const out = applyChangeEdit(bigger, [{ section: 'experience', target: 'Acme', after: 'Cut p99 latency by 35% across the payments platform with gRPC.' }], { changeIndex: 0, text: 'Cut p99 latency by 35% with gRPC.' });
      return out && out.resume.experience[0].bullets[1] === 'Cut p99 latency by 35% with gRPC.' && out.resume.experience[0].bullets[0] === bigger.experience[0].bullets[0];
    })());
  } catch (err) {
    check(`threw: ${err.message}`, false, err);
  } finally {
    console.log(failed ? `${failed} FAILED` : 'all passed');
    console.groupEnd();
  }
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

    // EDIT_AI_CHANGE: a hand edit made from the AI change list.
    const withLog = { ...start, changesLog: [{ section: 'experience', target: 'Acme', before: 'Moved services.', after: 'Migrated 40 services to Kubernetes.', reason: 'r' }] };
    const changed = appReducer(withLog, { type: ACTIONS.EDIT_AI_CHANGE, payload: { changeIndex: 0, text: 'Migrated 40 services to Kubernetes with Terraform.' } });
    check('EDIT_AI_CHANGE writes tailoredResume only', changed.tailoredResume.experience[0].bullets[0] === 'Migrated 40 services to Kubernetes with Terraform.' && changed.resume === base);
    check('EDIT_AI_CHANGE records edited and logs a hand edit', changed.changesLog[0].edited === 'Migrated 40 services to Kubernetes with Terraform.' && describeManualEdits(changed.tailorManualEdits).length === 1);
    check('EDIT_AI_CHANGE: blank text returns the same state', appReducer(withLog, { type: ACTIONS.EDIT_AI_CHANGE, payload: { changeIndex: 0, text: '' } }) === withLog);
    check('EDIT_AI_CHANGE: no tailored resume returns the same state', (() => {
      const none = { ...withLog, tailoredResume: null };
      return appReducer(none, { type: ACTIONS.EDIT_AI_CHANGE, payload: { changeIndex: 0, text: 'x' } }) === none;
    })());
  } finally {
    console.log(failed ? `${failed} FAILED` : 'all passed');
    console.groupEnd();
  }
  return failed === 0;
}

/**
 * The two new actions through the real reducer, and the two questions that
 * cannot be answered by looking at either function alone:
 *
 * POINT 3 -- can anything short of a fresh AI pass put a removed entry back?
 * testEntriesOffline proves mergeNonDestructiveResume WOULD restore it if it
 * were ever handed a hand-edited resume. This sweeps every action in ACTIONS
 * plus a save/reload round trip through `hydrate` and asserts the entry stays
 * gone, so the answer is checked rather than reasoned about.
 *
 * POINT 4 -- does the score follow? Removing an entry takes its keywords out
 * of the resume, so it must rescore in the same transition, like a hand edit.
 *
 * Browser or Node; it imports AppContext.jsx, so under Node it needs a loader
 * that can read JSX -- in practice run it in the browser console.
 */
export async function testEntriesReducer() {
  failed = 0;
  const { appReducer, initialState, hydrate, ACTIONS, RESCORING_ACTIONS } = await import('../../context/AppContext.jsx');
  const { selectCurrentResume } = await import('../currentResume.js');

  console.group('tailorEditor - add and remove entries (reducer)');
  const backup = typeof localStorage !== 'undefined' ? localStorage.getItem(RAW_KEY) : null;
  try {
    const jd = {
      jobTitle: 'Senior Backend Engineer',
      atsKeywords: { high: ['Go', 'Kubernetes', 'Terraform'], medium: ['PostgreSQL', 'observability'], low: ['Kafka'] },
      requiredSkills: [],
      preferredSkills: [],
    };
    // The entry that will be removed has to be the ONLY place "Kubernetes"
    // occurs, or the score cannot be expected to move when it goes. The
    // fixture declares Kubernetes as a skill too, so that is stripped here and
    // the exclusivity is asserted below rather than assumed.
    const base = sample();
    base.skills = [{ category: 'Languages', skills: ['Go', 'Python'] }];
    const start = appReducer(
      { ...initialState, resume: base, parsedJD: jd, tailoredResume: base, changesLog: [], tailorCorrections: [] },
      { type: ACTIONS.SET_STATUS, status: 'done' }
    );
    const scored = appReducer(start, { type: ACTIONS.UPDATE_TAILORED_SECTION, payload: { section: 'summary', value: 'Backend engineer with Go and PostgreSQL experience.' } });
    const expected = (state) => {
      const { raw } = selectCurrentResume(state);
      if (!raw) return null;
      const gap = analyzeCompetencyGaps(raw, state.parsedJD);
      return calculateATSScore(raw, state.parsedJD, gap);
    };
    const consistent = (state) =>
      JSON.stringify(state.atsScore) === JSON.stringify(expected(state)) &&
      (state.atsScore == null || state.atsScore.gapAnalysis === state.gapAnalysis);
    check('setup: the current score matches the tailored resume', consistent(scored) && typeof scored.atsScore.total === 'number', scored.atsScore && scored.atsScore.total);

    // --- point 4: add ------------------------------------------------------
    const added = appReducer(scored, {
      type: ACTIONS.ADD_TAILORED_ENTRY,
      payload: {
        section: 'experience',
        value: {
          ...newEntryDraft('experience'),
          title: 'Platform Engineer',
          company: 'Nimbus Data',
          startDate: 'Feb 2024',
          isCurrentlyWorking: true,
          bullets: ['Ran the Terraform migration for 12 AWS accounts, cutting provisioning from 3 days to 20 minutes.'],
        },
      },
    });
    check('add: the entry is in the tailored resume', added.tailoredResume.experience.length === scored.tailoredResume.experience.length + 1);
    check('add: experience inserted it FIRST, and pushed the previous first role down one', added.tailoredResume.experience[0].company === 'Nimbus Data' && added.tailoredResume.experience[1] === scored.tailoredResume.experience[0], added.tailoredResume.experience.map((e) => e.company));
    check('add: the ORIGINAL resume is untouched -- a hand add is not a re-parse', added.resume === scored.resume && added.resume.experience.length === base.experience.length);
    check('add: it is logged as a hand edit', describeManualEdits(added.tailorManualEdits).some((l) => l.includes('Nimbus Data')), describeManualEdits(added.tailorManualEdits));
    check('add: RESCORING -- the score is recomputed in the same transition', added.atsScore !== scored.atsScore && consistent(added));
    check('add: and the new keyword actually moved, so this is a real rescore', added.atsScore.total !== scored.atsScore.total, { before: scored.atsScore.total, after: added.atsScore.total });
    const terraformBefore = (scored.gapAnalysis.missing ?? []).some((k) => k.keyword === 'Terraform');
    const terraformAfter = (added.gapAnalysis.matched ?? []).some((k) => k.keyword === 'Terraform');
    check('add: "Terraform" moved from missing to matched because of the added entry', terraformBefore && terraformAfter, { terraformBefore, terraformAfter });
    check('add: a blank payload changes nothing at all', appReducer(added, { type: ACTIONS.ADD_TAILORED_ENTRY, payload: { section: 'experience', value: newEntryDraft('experience') } }) === added);
    check('add: no tailoring pass means nothing to add to', appReducer({ ...added, tailoredResume: null }, { type: ACTIONS.ADD_TAILORED_ENTRY, payload: { section: 'experience', value: { ...newEntryDraft('experience'), title: 'X' } } }).tailoredResume === null);

    // THE INSERTION SHIFT, through the reducer. Same class of check as the
    // removal one below: an insert at the top moves every index in the section,
    // so a pending draft and an edit-log row addressed by index must move with
    // it or they end up naming the wrong entry.
    check('add at the top: a pending draft and a log row both follow their own entry', (() => {
      const owner = describeEntry('experience', scored.tailoredResume.experience[0]);
      const seeded = {
        ...scored,
        draftEdits: [
          { section: 'experience', index: 0, value: { ...toDraft('experience', scored.tailoredResume.experience[0]), title: 'DRAFT ON THE OLD FIRST ENTRY' } },
          { section: 'summary', index: null, value: 'a draft on another block' },
        ],
        tailorManualEdits: [{ section: 'experience', index: 0, label: `Experience: ${owner}` }],
      };
      const out = appReducer(seeded, { type: ACTIONS.ADD_TAILORED_ENTRY, payload: { section: 'experience', value: { ...newEntryDraft('experience'), title: 'Platform Engineer', company: 'Nimbus Data' } } });
      const draft = out.draftEdits.find((d) => d.value && d.value.title === 'DRAFT ON THE OLD FIRST ENTRY');
      const rec = recoverableDrafts(out.draftEdits, out.tailoredResume).find((d) => d.value === draft.value);
      const oldRow = out.tailorManualEdits.find((e) => e.label === `Experience: ${owner}`);
      const addRow = out.tailorManualEdits.find((e) => /Nimbus Data/.test(e.label));
      return (
        draft.index === 1 &&
        rec.label === `Experience: ${owner}` &&               // its own entry, not the new one
        out.draftEdits.some((d) => d.section === 'summary' && d.index === null) &&
        oldRow.index === 1 &&                                 // the log row moved too
        addRow.index === 0 &&                                 // and the add's own row took slot 0
        out.tailorManualEdits.length === 2                    // without replacing the displaced row
      );
    })());
    check('add at the END does not shift anything: the rows are the very same array', (() => {
      const log = [{ section: 'projects', index: 0, label: 'Projects: Tracer' }];
      const drafts = [{ section: 'projects', index: 0, value: { ...toDraft('projects', scored.tailoredResume.projects[0]), name: 'TYPED' } }];
      const out = appReducer({ ...scored, draftEdits: drafts, tailorManualEdits: log }, { type: ACTIONS.ADD_TAILORED_ENTRY, payload: { section: 'projects', value: { ...newEntryDraft('projects'), name: 'Later project' } } });
      return out.draftEdits === drafts && out.tailorManualEdits.length === 2 && out.tailorManualEdits[0] === log[0] && out.tailoredResume.projects.at(-1).name === 'Later project';
    })());

    // --- point 4: remove ---------------------------------------------------
    const k8sBefore = (added.gapAnalysis.matched ?? []).some((key) => key.keyword === 'Kubernetes');
    // Addressed by search, not by a literal 0: the add above inserted at the
    // top, so the Acme role is no longer the first entry. A hard-coded index
    // here would quietly remove the entry that was just added instead.
    const acmeAt = added.tailoredResume.experience.findIndex((e) => e.company === 'Acme');
    const withoutAcme = { ...added.tailoredResume, experience: added.tailoredResume.experience.filter((_, i) => i !== acmeAt) };
    check('setup: "Kubernetes" is matched, and the Acme entry is the only place in the whole resume that says it',
      k8sBefore && acmeAt > 0 && !JSON.stringify(withoutAcme).toLowerCase().includes('kubernetes'), { k8sBefore, acmeAt });
    const removed = appReducer(added, { type: ACTIONS.REMOVE_TAILORED_ENTRY, payload: { section: 'experience', index: acmeAt } });
    check('remove: the entry is gone from the tailored resume', !removed.tailoredResume.experience.some((e) => e.company === 'Acme'), removed.tailoredResume.experience.map((e) => e.company));
    check('remove: the ORIGINAL resume still has it, which is what a discard restores', removed.resume === added.resume && removed.resume.experience.some((e) => e.company === 'Acme'));
    check('remove: RESCORING -- the score is recomputed in the same transition', removed.atsScore !== added.atsScore && consistent(removed));
    check('remove: the score went DOWN, because the resume really lost keywords', removed.atsScore.total < added.atsScore.total, { before: added.atsScore.total, after: removed.atsScore.total });
    check('remove: "Kubernetes" fell out of matched', !(removed.gapAnalysis.matched ?? []).some((key) => key.keyword === 'Kubernetes'));
    check('remove: the baseline from step 1 is NOT touched -- before/after still reads against the original', removed.originalAtsScore === added.originalAtsScore);
    check('remove: it is logged, naming the entry', describeManualEdits(removed.tailorManualEdits).some((l) => l === 'Experience: Senior Engineer — Acme (removed by hand)'), describeManualEdits(removed.tailorManualEdits));
    check('remove: an out-of-range index changes nothing at all', appReducer(removed, { type: ACTIONS.REMOVE_TAILORED_ENTRY, payload: { section: 'experience', index: 99 } }) === removed);
    check('remove: a malformed payload changes nothing at all', appReducer(removed, { type: ACTIONS.REMOVE_TAILORED_ENTRY, payload: null }) === removed);
    check('remove: no tailoring pass means nothing to remove', appReducer({ ...removed, tailoredResume: null }, { type: ACTIONS.REMOVE_TAILORED_ENTRY, payload: { section: 'experience', index: 0 } }).tailoredResume === null);
    check('RESCORING_ACTIONS names both new actions', RESCORING_ACTIONS.includes('ADD_TAILORED_ENTRY') && RESCORING_ACTIONS.includes('REMOVE_TAILORED_ENTRY'));

    // --- point 5: drafts through the reducer -------------------------------
    const withDrafts = [
      { section: 'experience', index: 0, value: { ...toDraft('experience', added.tailoredResume.experience[0]), title: 'DRAFT ON THE ONE BEING REMOVED' } },
      { section: 'experience', index: 2, value: { ...toDraft('experience', added.tailoredResume.experience[2]), title: 'DRAFT ON A LATER ENTRY' } },
      { section: 'summary', index: null, value: 'a draft on another block' },
    ];
    const drafted = { ...added, draftEdits: withDrafts };
    const afterRemoval = appReducer(drafted, { type: ACTIONS.REMOVE_TAILORED_ENTRY, payload: { section: 'experience', index: 0 } });
    check('drafts: the removed entry\'s own draft is dropped', !afterRemoval.draftEdits.some((d) => d.value && d.value.title === 'DRAFT ON THE ONE BEING REMOVED'), afterRemoval.draftEdits);
    const laterDraft = afterRemoval.draftEdits.find((d) => d.value && d.value.title === 'DRAFT ON A LATER ENTRY');
    check('drafts: a later entry\'s draft moved down with its entry', laterDraft && laterDraft.index === 1, laterDraft && laterDraft.index);
    check('drafts: another block\'s draft is untouched', afterRemoval.draftEdits.some((d) => d.section === 'summary' && d.index === null));
    check('drafts: and the moved draft still resolves to ITS OWN entry, not the neighbour', (() => {
      const rec = recoverableDrafts(afterRemoval.draftEdits, afterRemoval.tailoredResume);
      const row = rec.find((d) => d.value && d.value.title === 'DRAFT ON A LATER ENTRY');
      return Boolean(row) && row.label === `Experience: ${describeEntry('experience', afterRemoval.tailoredResume.experience[1])}`;
    })(), recoverableDrafts(afterRemoval.draftEdits, afterRemoval.tailoredResume).map((d) => d.label));
    check('drafts: a pending draft still does not move the score', JSON.stringify(drafted.atsScore) === JSON.stringify(added.atsScore));
    check('drafts: removing the last remaining draft empties the slot to null, not []', (() => {
      const one = { ...added, draftEdits: [withDrafts[0]] };
      return appReducer(one, { type: ACTIONS.REMOVE_TAILORED_ENTRY, payload: { section: 'experience', index: 0 } }).draftEdits === null;
    })());
    check('drafts: an add spends the new-entry form\'s draft and leaves every other alone', (() => {
      const pending = [{ section: 'experience', index: NEW_ENTRY_INDEX, value: { ...newEntryDraft('experience'), title: 'Contractor' } }, withDrafts[2]];
      const out = appReducer({ ...added, draftEdits: pending }, { type: ACTIONS.ADD_TAILORED_ENTRY, payload: { section: 'experience', value: { ...newEntryDraft('experience'), title: 'Contractor', company: 'Self' } } });
      return out.draftEdits.length === 1 && out.draftEdits[0].section === 'summary' && out.tailoredResume.experience.some((e) => e.company === 'Self');
    })());

    // --- point 3: nothing short of a fresh pass brings it back -------------
    const CLEARS_TAILORING = ['RESET', 'SET_TAILORED_RESUME', 'CLEAR_TAILORING', 'CLEAR_ANALYSIS'];
    const payloads = {
      RESET: undefined,
      SET_RESUME_TEXT: 'x',
      SET_RESUME: removed.resume,
      SET_JOB_DESCRIPTION: 'x',
      SET_PARSED_JD: removed.parsedJD,
      SET_GAP_ANALYSIS: removed.gapAnalysis,
      SET_ATS_SCORE: removed.atsScore,
      SET_TAILORED_RESUME: { resume: base, changesLog: [], corrections: [], parsedJD: removed.parsedJD },
      CLEAR_TAILORING: undefined,
      UPDATE_TAILORED_SECTION: { section: 'summary', value: 'A different summary entirely.' },
      ADD_TAILORED_ENTRY: { section: 'projects', value: { ...newEntryDraft('projects'), name: 'Another project' } },
      REMOVE_TAILORED_ENTRY: { section: 'certifications', index: 0 },
      EDIT_AI_CHANGE: { changeIndex: 0, text: 'Edited from the change list.' },
      SET_DRAFT_EDIT: { section: 'summary', value: 'typed but not saved' },
      DISCARD_DRAFT_EDIT: { section: 'summary' },
      // Neither the cover letter nor the Match batch touches the tailored
      // resume, so each must leave a hand removal exactly as it found it.
      SET_COVER_LETTER: { body: ['Dear X,', 'Hello.', 'Bye,'].join('\n\n'), tone: 'warm', length: 'short' },
      UPDATE_COVER_LETTER: { body: ['Dear X,', 'Edited.', 'Bye,'].join('\n\n'), tone: 'warm', length: 'short' },
      CLEAR_COVER_LETTER: undefined,
      SET_MATCH_POSTINGS: [{ id: 'p1', label: '', text: 'A posting.', url: '', source: 'paste', status: 'pending', error: null }],
      SET_MATCH_RESULTS: { results: [{ id: 'p1', label: 'A posting', jd: null, score: null, gap: null, error: { message: 'x' } }], resumeFingerprint: 'x', ranAt: '2026-09-23T00:00:00.000Z', provider: 'claude', completed: 0, failed: 1, aborted: false },
      REMOVE_MATCH_RESULT: { id: 'p1' },
      CLEAR_MATCH_RESULTS: undefined,
      CLEAR_MATCH: undefined,
      SET_SOURCES: { provider: 'claude' },
      SET_SETTINGS: { provider: 'claude' },
      DISMISS_SESSION_NOTICE: undefined,
      SET_STATUS: 'idle',
      SET_STAGE: null,
      SET_ERROR: null,
      MERGE_INFERRED_SKILLS: ['Kubernetes', 'Airflow'],
      CLEAR_ANALYSIS: undefined,
    };
    for (const name of Object.keys(ACTIONS)) {
      if (!(name in payloads)) {
        check(`${name}: has a resurrection case (add one to payloads when adding an action)`, false);
        continue;
      }
      const after = appReducer(removed, { type: ACTIONS[name], payload: payloads[name] });
      if (CLEARS_TAILORING.includes(name)) {
        // These four are the fresh-pass and start-over paths. They do not
        // "restore" the entry into a hand-edited resume: they throw the whole
        // hand-edited copy away, which is the designed behaviour.
        const wantsFreshPass = name === 'SET_TAILORED_RESUME';
        check(
          `${name}: replaces the whole tailored copy rather than patching the removal back into it`,
          wantsFreshPass ? after.tailoredResume === base && after.tailorManualEdits === null : after.tailoredResume === null,
          { tailoredResume: after.tailoredResume && after.tailoredResume.experience.map((e) => e.company), log: after.tailorManualEdits }
        );
        continue;
      }
      const back = (after.tailoredResume && after.tailoredResume.experience || []).some((e) => e && e.company === 'Acme');
      check(`${name}: the removed entry is STILL gone`, !back, after.tailoredResume && after.tailoredResume.experience.map((e) => e.company));
      check(`${name}: score still matches the current resume`, consistent(after), { total: after.atsScore && after.atsScore.total });
    }
    check('MERGE_INFERRED_SKILLS: approving a skill the removed entry demonstrated adds the SKILL, not the entry', (() => {
      const out = appReducer(removed, { type: ACTIONS.MERGE_INFERRED_SKILLS, payload: ['Kubernetes'] });
      return !out.tailoredResume.experience.some((e) => e.company === 'Acme');
    })());
    check('SET_TAILORED_RESUME: a FRESH pass from the original DOES bring it back, which is the designed behaviour', (() => {
      const cleared = appReducer(removed, { type: ACTIONS.CLEAR_TAILORING });
      const fresh = appReducer(cleared, { type: ACTIONS.SET_TAILORED_RESUME, payload: { resume: base, changesLog: [], corrections: [], parsedJD: cleared.parsedJD } });
      return fresh.tailoredResume.experience.some((e) => e.company === 'Acme') && fresh.tailorManualEdits === null;
    })());

    // A reload. This is the path most likely to hide a resurrection, because
    // hydrate rescores and recovers a baseline from `state.resume` -- which
    // still holds the removed entry.
    if (typeof localStorage !== 'undefined') {
      // The state to round-trip has to hold BOTH a hand add and a hand
      // removal of an ORIGINAL entry, since `state.resume` is what hydrate
      // recovers a baseline from and Acme is the entry still in there. The
      // add above inserted at the TOP, so `afterRemoval` (index 0, the
      // drafts case) dropped the new entry rather than Acme -- this removes
      // Acme instead, keeping the drafts so their reindexing round-trips too.
      const roundTrip = appReducer(drafted, { type: ACTIONS.REMOVE_TAILORED_ENTRY, payload: { section: 'experience', index: acmeAt } });
      saveSession(roundTrip);
      const rehydrated = hydrate(initialState);
      check('reload: the removed entry is still gone after a real save/load/hydrate round trip', !rehydrated.tailoredResume.experience.some((e) => e.company === 'Acme'), rehydrated.tailoredResume.experience.map((e) => e.company));
      check('reload: the added entry survived too, still first', rehydrated.tailoredResume.experience[0].company === 'Nimbus Data', rehydrated.tailoredResume.experience.map((e) => e.company));
      check('reload: the reindexed draft came back at its migrated index', (rehydrated.draftEdits || []).some((d) => d.value && d.value.title === 'DRAFT ON A LATER ENTRY' && d.index === 1), rehydrated.draftEdits);
      check('reload: the score still matches the shortened resume', consistent(rehydrated));
      check('reload: hydrate\'s baseline recovery reads state.resume and does NOT write it into the tailored copy', rehydrated.resume.experience.some((e) => e.company === 'Acme') && rehydrated.tailoredResume.experience.length === roundTrip.tailoredResume.experience.length);
      check('reload: the removal log row survived', describeManualEdits(rehydrated.tailorManualEdits).some((l) => l.includes('(removed by hand)')));
    } else {
      console.warn('  (skipped the reload round trip: no localStorage)');
    }
  } catch (err) {
    check(`threw: ${err.message}`, false, err);
  } finally {
    if (typeof localStorage !== 'undefined') {
      if (backup === null) localStorage.removeItem(RAW_KEY);
      else localStorage.setItem(RAW_KEY, backup);
    }
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

/**
 * The score in the live store, against the score the current resume actually
 * deserves. The reducer recomputes inside the transition, so this must hold
 * after every dispatch -- it is the same invariant pipeline.manual.js asserts,
 * checked here on a real session.
 */
function consistentLive(state) {
  const gap = analyzeCompetencyGaps(selectExportSource(state).raw, state.parsedJD);
  const score = calculateATSScore(selectExportSource(state).raw, state.parsedJD, gap);
  return JSON.stringify(state.atsScore) === JSON.stringify(score) && state.atsScore?.gapAnalysis === state.gapAnalysis;
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
// Adding and removing entries, live, through the real buttons.
//
// These MUTATE the loaded session's experience and certifications sections, so
// run them on test data. liveEmptySection() puts back what it removed; the add
// and remove runners deliberately do not, because what they leave behind is
// what the reload checks look at.
// ---------------------------------------------------------------------------

const ENTRY_KEY = '__a2resume_editor_entry';
const entryMemo = () => JSON.parse(sessionStorage.getItem(ENTRY_KEY) || '{}');
const rememberEntry = (patch) => sessionStorage.setItem(ENTRY_KEY, JSON.stringify({ ...entryMemo(), ...patch }));

const storedState = () => JSON.parse(localStorage.getItem(RAW_KEY) || 'null')?.state ?? null;
const experienceOf = (resume) => (Array.isArray(resume?.experience) ? resume.experience : []);

/** Open a section's "add a new entry" block and return it. */
async function openAddBlock(section, noun) {
  const button = document.querySelector(`button[aria-label="Add ${noun}"]`);
  if (!button) throw new Error(`No "Add ${noun}" button. Open /tailor on a session with a tailoring pass.`);
  const block = button.closest('.edit-block');
  button.click();
  await waitFor(() => block.querySelector('.editor'), `the add-${section} form to open`);
  return block;
}

/**
 * Click Remove on one entry's block, answer the confirmation, and return what
 * the confirmation said. `answer` is 'confirm' or 'keep'.
 */
async function removeEntryBlock(noun, position, answer) {
  const button = document.querySelector(`button[aria-label="Remove ${noun} ${position}"]`);
  if (!button) throw new Error(`No "Remove ${noun} ${position}" button on the page.`);
  const block = button.closest('.edit-block');
  button.click();
  const confirm = await waitFor(() => block.querySelector('.edit-block__confirm'), 'the remove confirmation');
  const text = confirm.innerText;
  buttonByText(confirm, answer === 'confirm' ? 'Yes, remove it' : 'Keep it').click();
  if (answer === 'keep') await waitFor(() => !block.querySelector('.edit-block__confirm'), 'the confirmation to close');
  return { text, block };
}

/** Step 1: add a real experience entry through the form. Then reload. */
export async function liveAddExperience() {
  failed = 0;
  console.group('tailorEditor - live entries 1: add an experience entry');
  try {
    const before = liveState();
    if (!before.tailoredResume) throw new Error('Open /tailor on a session with a tailoring pass.');
    const stamp = Date.now().toString(36);
    const company = `Nimbus Data ${stamp}`;
    const bullet = `Ran the Terraform migration for 12 AWS accounts, cutting provisioning from 3 days to 20 minutes. [${stamp}]`;
    rememberEntry({ company, bullet, countBefore: experienceOf(before.tailoredResume).length, scoreBefore: before.atsScore?.total ?? null });

    const block = await openAddBlock('experience', 'experience');
    const save = buttonByText(block, 'Add an experience entry');
    check('the add button is disabled while the form is blank', Boolean(save) && save.disabled === true);

    setValue(block.querySelector('input[name="title"]'), 'Platform Engineer');
    setValue(block.querySelector('input[name="company"]'), company);
    setValue(block.querySelector('input[name="startDate"]'), 'Feb 2024');
    block.querySelector('input[name="isCurrentlyWorking"]').click();
    buttonByText(block, 'Add bullet').click();
    const field = await waitFor(() => block.querySelector('textarea[aria-label="bullet 1"]'), 'a bullet field');
    setValue(field, bullet);
    check('the add button is enabled once something is typed', !buttonByText(block, 'Add an experience entry').disabled);

    buttonByText(block, 'Add an experience entry').click();
    await waitFor(() => experienceOf(liveState().tailoredResume).some((e) => e.company === company), 'the entry to land');

    const after = liveState();
    const entry = experienceOf(after.tailoredResume)[0];
    check('store: inserted FIRST in the section, where the most recent role belongs', entry.company === company && entry.title === 'Platform Engineer', experienceOf(after.tailoredResume).map((e) => e.company));
    check('store: the roles that were already there kept their order, one slot later', experienceOf(after.tailoredResume).slice(1).every((e, i) => e === experienceOf(before.tailoredResume)[i]));
    check('store: the current role saved the flag, not an end date', entry.isCurrentlyWorking === true && entry.endDate === '');
    check('store: the bullet is there, trimmed', entry.bullets[0] === bullet);
    check('store: the ORIGINAL resume is untouched', !experienceOf(after.resume).some((e) => e.company === company));
    check('store: logged as a hand edit naming the entry', describeManualEdits(after.tailorManualEdits).some((l) => l.includes(company)), describeManualEdits(after.tailorManualEdits));
    check('store: the add form draft is not left behind', !(after.draftEdits ?? []).some((d) => d.index === NEW_ENTRY_INDEX));
    check('storage: the saved session already carries it', experienceOf(storedState()?.tailoredResume).some((e) => e.company === company));
    check('Export: the plain text prints the entry, its dates and its bullet', (() => {
      const text = exportText(selectExportSource(after).raw);
      return text.includes(`Platform Engineer — ${company}`) && text.includes('Feb 2024 – Present') && text.includes(`- ${bullet}`);
    })());
    check('Export: it prints FIRST in the experience section, above the role that used to lead it', (() => {
      const text = exportText(selectExportSource(after).raw);
      const previous = experienceOf(before.tailoredResume)[0];
      if (!previous?.company) return true; // nothing was above it to be above
      return text.indexOf(company) < text.indexOf(previous.company);
    })());
    check('page: the new block is the FIRST experience block on screen', (() => {
      const first = document.querySelector('button[aria-label="Edit experience 1"]');
      return Boolean(first) && first.closest('.edit-block').innerText.includes(company);
    })());
    check('SCORE: recomputed, and it moved', after.atsScore !== before.atsScore && after.atsScore.total !== before.atsScore.total, { before: before.atsScore?.total, after: after.atsScore?.total });
    check('SCORE: the baseline from step 1 did not move', after.originalAtsScore === before.originalAtsScore);
    check('page: the new block is on screen and closed', document.body.innerText.includes(company) && !block.querySelector('.editor'));
    console.log(`added "${company}"; score ${before.atsScore?.total} -> ${after.atsScore?.total}`);
  } catch (err) {
    check(err.message, false, err);
  }
  return finishDraft('Now RELOAD (F5), stay on /tailor, then run verifyAddedEntrySurvived().');
}

/** Step 2, after a real reload. */
export function verifyAddedEntrySurvived() {
  failed = 0;
  console.group('tailorEditor - live entries 2: the added entry after a reload');
  try {
    const { company, bullet, countBefore } = entryMemo();
    if (!company) throw new Error('Run liveAddExperience() first.');
    const state = liveState();
    const entry = experienceOf(state.tailoredResume).find((e) => e.company === company);
    check('store after reload: the entry is there', Boolean(entry), experienceOf(state.tailoredResume).map((e) => e.company));
    check('store after reload: still FIRST in the section', experienceOf(state.tailoredResume)[0]?.company === company, experienceOf(state.tailoredResume).map((e) => e.company));
    check('store after reload: with its bullet', entry?.bullets?.[0] === bullet);
    check('store after reload: the section is one longer than before', experienceOf(state.tailoredResume).length === countBefore + 1);
    check('store after reload: the hand-edit log survived', describeManualEdits(state.tailorManualEdits).some((l) => l.includes(company)));
    check('Export after reload: still printed', exportText(selectExportSource(state).raw).includes(`- ${bullet}`));
    check('Export after reload: still printed in the top position', (() => {
      const text = exportText(selectExportSource(state).raw);
      const second = experienceOf(state.tailoredResume)[1];
      if (!second?.company) return true;
      return text.indexOf(company) < text.indexOf(second.company);
    })());
    if (location.pathname === '/tailor') check('page after reload: the block is on screen', document.body.innerText.includes(company));
    rememberEntry({ scoreAfterAdd: state.atsScore?.total ?? null });
  } catch (err) {
    check(err.message, false, err);
  }
  return finishDraft('Next: await liveAddAroundDraft() -- the insertion half of the index-drift check.');
}

/**
 * The INSERTION half of the index-drift check, live, and the mirror of
 * liveRemoveEntryWithDraft.
 *
 * Experience inserts at the top, so a new entry moves every existing index in
 * the section up one. Two things in the store are addressed by one: a pending
 * draft and an edit-log row. Both must follow their own entry. If they do not,
 * the draft is offered back under the brand-new entry's name with the old
 * entry's text in the form, and Save writes one role's content over another's.
 *
 * This edits and drafts against the FIRST experience entry of whatever session
 * is loaded, and leaves an extra entry and a pending draft behind for
 * verifyInsertDraftSurvived() to check and then clean up. Run it on test data.
 */
export async function liveAddAroundDraft() {
  failed = 0;
  console.group('tailorEditor - live entries 2b: inserting at the top around a draft and a log row');
  try {
    const before = liveState();
    const list = experienceOf(before.tailoredResume);
    if (list.length < 1) throw new Error('Needs at least one experience entry in the loaded session.');
    const owner = describeEntry('experience', list[0]);
    const stamp = Date.now().toString(36);
    const savedMarker = `Saved bullet on the old first entry [${stamp}]`;
    const draftMarker = `DRAFT-ON-THE-OLD-FIRST-ENTRY-${stamp}`;
    const company = `Insert Probe ${stamp}`;

    // A SAVED edit on experience 1, so there is a log row at index 0 to move.
    let block = await openFirstExperience();
    let field = block.querySelector('textarea[aria-label="bullet 1"]');
    if (!field) {
      buttonByText(block, 'Add bullet').click();
      field = await waitFor(() => block.querySelector('textarea[aria-label="bullet 1"]'), 'a bullet field');
    }
    setValue(field, savedMarker);
    await saveBlock(block);
    check('setup: the edit is logged against experience index 0', (liveState().tailorManualEdits ?? []).some((e) => e.section === 'experience' && e.index === 0), liveState().tailorManualEdits);

    // An UNSAVED draft on the same entry, autosaved to the session.
    block = await openFirstExperience();
    setValue(block.querySelector('textarea[aria-label="bullet 1"]'), draftMarker);
    await waitForAutosave();
    let pending = pendingDrafts().find((d) => JSON.stringify(d.value).includes(draftMarker));
    check('setup: the draft autosaved against experience index 0', Boolean(pending) && pending.index === 0, pending?.index);

    // Now insert a new entry at the top. Everything in the section moves up one.
    const addBlock = await openAddBlock('experience', 'experience');
    setValue(addBlock.querySelector('input[name="title"]'), 'Platform Engineer');
    setValue(addBlock.querySelector('input[name="company"]'), company);
    setValue(addBlock.querySelector('input[name="startDate"]'), 'Mar 2026');
    buttonByText(addBlock, 'Add an experience entry').click();
    await waitFor(() => experienceOf(liveState().tailoredResume)[0]?.company === company, 'the new entry to land first');

    const after = liveState();
    check('the new entry is at index 0 and the old first entry is at 1', describeEntry('experience', experienceOf(after.tailoredResume)[1]) === owner, experienceOf(after.tailoredResume).map((e) => e.company));
    pending = pendingDrafts().find((d) => JSON.stringify(d.value).includes(draftMarker));
    check('the pending draft followed its entry UP one index', Boolean(pending) && pending.index === 1, pending?.index);
    check('the draft is still the SAME value object -- nothing was rewritten', JSON.stringify(pending.value).includes(draftMarker));
    const row = recoverableDrafts(pendingDrafts(), after.tailoredResume).find((d) => JSON.stringify(d.value).includes(draftMarker));
    check('and it resolves to ITS OWN entry, not the new one that took its slot', Boolean(row) && row.label === `Experience: ${owner}`, { got: row?.label, expected: `Experience: ${owner}` });
    check('the edit-log row for the old first entry moved up one too', (after.tailorManualEdits ?? []).some((e) => e.section === 'experience' && e.index === 1), after.tailorManualEdits);
    check('the add got its own log row at index 0, without replacing the displaced one', (after.tailorManualEdits ?? []).some((e) => e.section === 'experience' && e.index === 0 && e.label.includes(company)), after.tailorManualEdits);
    check('the saved bullet is still on the entry that owns it, not on the new one', experienceOf(after.tailoredResume)[1].bullets[0] === savedMarker && !(experienceOf(after.tailoredResume)[0].bullets ?? []).includes(savedMarker));
    check('the unsaved draft did not leak into the resume', !JSON.stringify(after.tailoredResume).includes(draftMarker));
    check('storage agrees with the store', JSON.stringify(storedState()?.draftEdits) === JSON.stringify(pendingDrafts()));
    check('SCORE: recomputed in the same transition', consistentLive(after));
    check('page: the block still open with the draft in it is under ITS OWN heading', (() => {
      const open = [...document.querySelectorAll('.edit-block')].find((b) => b.querySelector('textarea')?.value === draftMarker);
      return Boolean(open) && open.innerText.includes(owner.split(' — ')[0]) && !open.innerText.includes(company);
    })());
    rememberEntry({ insertCompany: company, insertDraftMarker: draftMarker, insertSavedMarker: savedMarker, insertOwner: owner });
  } catch (err) {
    check(err.message, false, err);
  }
  return finishDraft('Now RELOAD (F5), stay on /tailor, then run verifyInsertDraftSurvived().');
}

/**
 * Step 2c, after a real reload: the shifted draft and log row are still right,
 * then put the session back -- discard the draft and remove the probe entry.
 */
export async function verifyInsertDraftSurvived() {
  failed = 0;
  console.group('tailorEditor - live entries 2c: the shifted draft after a reload');
  try {
    const { insertCompany, insertDraftMarker, insertSavedMarker, insertOwner } = entryMemo();
    if (!insertCompany) throw new Error('Run liveAddAroundDraft() first.');
    const state = liveState();
    const list = experienceOf(state.tailoredResume);
    check('store after reload: the new entry is still first', list[0]?.company === insertCompany, list.map((e) => e.company));
    check('store after reload: the saved bullet is still on its own entry at index 1', list[1]?.bullets?.[0] === insertSavedMarker);
    const pending = (state.draftEdits ?? []).find((d) => JSON.stringify(d.value).includes(insertDraftMarker));
    check('store after reload: the draft is still addressed to index 1', Boolean(pending) && pending.index === 1, pending?.index);
    const row = recoverableDrafts(state.draftEdits, state.tailoredResume).find((d) => JSON.stringify(d.value).includes(insertDraftMarker));
    check('after reload: it is offered back under ITS OWN entry', Boolean(row) && row.label === `Experience: ${insertOwner}`, { got: row?.label, expected: `Experience: ${insertOwner}` });
    check('after reload: the recovery banner names that entry, not the new one', (() => {
      const banner = document.querySelector('.editor-recovered');
      return Boolean(banner) && banner.innerText.includes(insertOwner) && !banner.innerText.includes(insertCompany);
    })(), document.querySelector('.editor-recovered')?.innerText);
    check('after reload: the draft still has not leaked into the resume', !JSON.stringify(state.tailoredResume).includes(insertDraftMarker));

    // Put the session back: throw the draft away, then remove the probe entry.
    const draftBlock = [...document.querySelectorAll('.edit-block')].find((b) => b.querySelector('textarea')?.value === insertDraftMarker);
    if (draftBlock) {
      buttonByText(draftBlock, 'Discard draft and use the last saved version').click();
      await waitFor(() => !draftBlock.querySelector('.editor'), 'the recovered block to close');
    }
    const at = experienceOf(liveState().tailoredResume).findIndex((e) => e.company === insertCompany);
    if (at !== -1) {
      await removeEntryBlock('experience', at + 1, 'confirm');
      await waitFor(() => !experienceOf(liveState().tailoredResume).some((e) => e.company === insertCompany), 'the probe entry to go');
    }
    const restored = liveState();
    check('cleanup: the draft is gone from the store and from storage', !JSON.stringify(restored.draftEdits ?? null).includes(insertDraftMarker) && !JSON.stringify(storedState()?.draftEdits ?? null).includes(insertDraftMarker));
    check('cleanup: the probe entry is gone and the owning entry is back at index 0', experienceOf(restored.tailoredResume)[0]?.bullets?.[0] === insertSavedMarker, experienceOf(restored.tailoredResume).map((e) => e.company));
    check('cleanup: the log row followed it back down to index 0', (restored.tailorManualEdits ?? []).some((e) => e.section === 'experience' && e.index === 0), restored.tailorManualEdits);
  } catch (err) {
    check(err.message, false, err);
  }
  return finishDraft('Next: await liveRemoveEntry() -- it removes the entry from step 1.');
}

/** Step 3: remove that entry through the confirmation. Both answers. */
export async function liveRemoveEntry() {
  failed = 0;
  console.group('tailorEditor - live entries 3: remove with confirmation');
  try {
    const { company } = entryMemo();
    if (!company) throw new Error('Run liveAddExperience() first.');
    const before = liveState();
    const list = experienceOf(before.tailoredResume);
    const at = list.findIndex((e) => e.company === company);
    if (at === -1) throw new Error(`"${company}" is not in the loaded session. Run liveAddExperience() again.`);
    const heading = `Platform Engineer — ${company}`;

    // "Keep it" first: a confirmation that changes something when declined is
    // worse than no confirmation at all.
    const kept = await removeEntryBlock('experience', at + 1, 'keep');
    check('the confirmation names the specific entry', kept.text.includes(`Remove ${heading}?`), kept.text.split('\n')[0]);
    check('the confirmation says the score is recalculated and the original is safe', /score is recalculated/i.test(kept.text) && /original resume from step 1 is not changed/i.test(kept.text));
    check('"Keep it" removes nothing', experienceOf(liveState().tailoredResume).length === list.length && liveState().tailoredResume === before.tailoredResume);
    check('"Keep it" leaves the score alone', liveState().atsScore === before.atsScore);

    await removeEntryBlock('experience', at + 1, 'confirm');
    await waitFor(() => !experienceOf(liveState().tailoredResume).some((e) => e.company === company), 'the entry to go');

    const after = liveState();
    check('store: the entry is gone', !experienceOf(after.tailoredResume).some((e) => e.company === company), experienceOf(after.tailoredResume).map((e) => e.company));
    check('store: only that one went', experienceOf(after.tailoredResume).length === list.length - 1);
    check('store: the ORIGINAL resume is untouched', after.resume === before.resume);
    check('store: logged as a removal, naming the entry', describeManualEdits(after.tailorManualEdits).some((l) => l === `Experience: ${heading} (removed by hand)`), describeManualEdits(after.tailorManualEdits));
    check('storage: the saved session no longer has it', !experienceOf(storedState()?.tailoredResume).some((e) => e.company === company));
    check('Export: the plain text no longer prints it', !exportText(selectExportSource(after).raw).includes(company));
    check('SCORE: recomputed, and it went back down', after.atsScore !== before.atsScore && after.atsScore.total < before.atsScore.total, { before: before.atsScore?.total, after: after.atsScore?.total });
    check('SCORE: the baseline from step 1 still did not move', after.originalAtsScore === before.originalAtsScore);
    // The whole-page text is NOT the right check: the hand-edit log at the top
    // of Tailor names what was removed, on purpose, so the company string is
    // still on the page and should be. What must be gone is the block.
    check('page: no editor block is headed with it any more', ![...document.querySelectorAll('.edit-block h3')].some((h) => h.textContent.includes(company)), [...document.querySelectorAll('.edit-block h3')].map((h) => h.textContent));
    check('page: but the hand-edit log does still say it was removed', document.querySelector('.tailor__edits')?.innerText.includes('(removed by hand)') === true, document.querySelector('.tailor__edits')?.innerText);
    check('page: no confirmation is left open anywhere', !document.querySelector('.edit-block__confirm'));
    console.log(`removed "${company}"; score ${before.atsScore?.total} -> ${after.atsScore?.total}`);
  } catch (err) {
    check(err.message, false, err);
  }
  return finishDraft('Now RELOAD (F5), stay on /tailor, then run verifyRemovalSurvived().');
}

/** Step 4, after a real reload: a removal is not undone by anything. */
export function verifyRemovalSurvived() {
  failed = 0;
  console.group('tailorEditor - live entries 4: the removal after a reload');
  try {
    const { company, countBefore } = entryMemo();
    if (!company) throw new Error('Run liveAddExperience() first.');
    const state = liveState();
    check('store after reload: the entry has NOT come back', !experienceOf(state.tailoredResume).some((e) => e.company === company), experienceOf(state.tailoredResume).map((e) => e.company));
    check('store after reload: the section is back to its original length', experienceOf(state.tailoredResume).length === countBefore);
    check('store after reload: hydrate rescored, and did not restore from state.resume', !experienceOf(state.tailoredResume).some((e) => e.company === company));
    check('store after reload: the removal row is in the log', describeManualEdits(state.tailorManualEdits).some((l) => l.includes('(removed by hand)')), describeManualEdits(state.tailorManualEdits));
    check('Export after reload: still not printed', !exportText(selectExportSource(state).raw).includes(company));
    if (location.pathname === '/tailor') {
      check('page after reload: no editor block is headed with it', ![...document.querySelectorAll('.edit-block h3')].some((h) => h.textContent.includes(company)));
    }
  } catch (err) {
    check(err.message, false, err);
  }
  return finishDraft('Next: await liveRemoveEntryWithDraft().');
}

/**
 * Point 5, live: a pending draft on one entry while a DIFFERENT, earlier entry
 * is removed. The draft has to follow its own entry, not stay on the slot
 * number and reattach to the neighbour that moved into it.
 *
 * Needs at least two experience entries. It types into the LAST one, removes
 * the first, and then removes the one holding the draft -- so it ends with two
 * entries gone. Run it on test data.
 */
export async function liveRemoveEntryWithDraft() {
  failed = 0;
  console.group('tailorEditor - live entries 5: removing around a pending draft');
  try {
    const before = liveState();
    const list = experienceOf(before.tailoredResume);
    if (list.length < 2) throw new Error('Needs at least two experience entries in the loaded session.');
    const last = list.length - 1;
    const owner = describeEntry('experience', list[last]);
    const firstCompany = list[0].company;
    const marker = `DRAFT-ON-LAST-ENTRY-${Date.now().toString(36)}`;

    // Type into the last entry and let it autosave, WITHOUT saving.
    const button = document.querySelector(`button[aria-label="Edit experience ${last + 1}"]`);
    if (!button) throw new Error(`No "Edit experience ${last + 1}" button.`);
    const block = button.closest('.edit-block');
    button.click();
    await waitFor(() => block.querySelector('.editor'), 'the editor to open');
    let field = block.querySelector('textarea[aria-label="bullet 1"]');
    if (!field) {
      buttonByText(block, 'Add bullet').click();
      field = await waitFor(() => block.querySelector('textarea[aria-label="bullet 1"]'), 'a bullet field');
    }
    setValue(field, marker);
    await waitForAutosave();
    let pending = pendingDrafts().find((d) => d.section === 'experience' && JSON.stringify(d.value).includes(marker));
    check(`the draft autosaved against experience index ${last}`, Boolean(pending) && pending.index === last, pending?.index);

    // Remove the FIRST entry. Every later index moves down one.
    await removeEntryBlock('experience', 1, 'confirm');
    await waitFor(() => !experienceOf(liveState().tailoredResume).some((e) => e.company === firstCompany), 'the first entry to go');

    pending = pendingDrafts().find((d) => JSON.stringify(d.value).includes(marker));
    check('the draft followed its entry down one index', Boolean(pending) && pending.index === last - 1, pending?.index);
    check('the draft is still the SAME value object -- nothing was rewritten', JSON.stringify(pending.value).includes(marker));
    const resolved = recoverableDrafts(pendingDrafts(), liveState().tailoredResume);
    const row = resolved.find((d) => JSON.stringify(d.value).includes(marker));
    check('and it resolves to ITS OWN entry, not the neighbour that shifted into its old slot', Boolean(row) && row.label === `Experience: ${owner}`, { got: row?.label, expected: `Experience: ${owner}` });
    check('the unsaved draft did not leak into the resume', !JSON.stringify(liveState().tailoredResume).includes(marker));
    check('storage agrees with the store', JSON.stringify(storedState()?.draftEdits) === JSON.stringify(pendingDrafts()));

    // Now remove the entry the draft belongs to. Its draft must die with it.
    const nowAt = experienceOf(liveState().tailoredResume).findIndex((e) => describeEntry('experience', e) === owner);
    await removeEntryBlock('experience', nowAt + 1, 'confirm');
    await waitFor(() => !experienceOf(liveState().tailoredResume).some((e) => describeEntry('experience', e) === owner), 'the owning entry to go');

    check('the draft is gone from the store', !(pendingDrafts() ?? []).some((d) => JSON.stringify(d.value).includes(marker)), pendingDrafts());
    check('the draft is gone from storage, not left to be misread on the next load', !JSON.stringify(storedState()?.draftEdits ?? null).includes(marker));
    check('no block is claiming a recovered draft', !document.querySelector('.edit-block__draft'));
    check('no recovery banner appeared', !document.querySelector('.editor-recovered'));
    rememberEntry({ draftMarker: marker });
    console.log('now reload and run verifyDraftDidNotResurrect()');
  } catch (err) {
    check(err.message, false, err);
  }
  return finishDraft('Now RELOAD (F5) and run verifyDraftDidNotResurrect().');
}

/** Step 6, after a real reload: the orphaned draft is nowhere. */
export function verifyDraftDidNotResurrect() {
  failed = 0;
  console.group('tailorEditor - live entries 6: the orphaned draft after a reload');
  try {
    const { draftMarker } = entryMemo();
    if (!draftMarker) throw new Error('Run liveRemoveEntryWithDraft() first.');
    const state = liveState();
    check('the draft is not in the store', !JSON.stringify(state.draftEdits ?? null).includes(draftMarker), state.draftEdits);
    check('the draft is not in the resume', !JSON.stringify(state.tailoredResume).includes(draftMarker));
    check('nothing reopened claiming a recovered draft', !document.querySelector('.edit-block__draft') && !document.querySelector('.editor-recovered'));
    check('the marker is nowhere on the page', !document.body.innerText.includes(draftMarker));
  } catch (err) {
    check(err.message, false, err);
  }
  return finishDraft('Next: await liveEmptySection() to take a whole section to zero.');
}

/**
 * Point 6, live: remove EVERY entry in one section and check Export still
 * renders it as absent rather than breaking. Certifications, because it is the
 * smallest section and the one most likely to be short.
 *
 * It records what it removes and adds it back at the end, so the session is
 * left as it was found apart from entry order.
 */
export async function liveEmptySection() {
  failed = 0;
  console.group('tailorEditor - live entries 7: a section taken to zero');
  try {
    const before = liveState();
    const original = Array.isArray(before.tailoredResume?.certifications) ? before.tailoredResume.certifications : [];
    if (original.length === 0) throw new Error('The loaded session has no certifications to remove.');
    rememberEntry({ certs: original, certScoreBefore: before.atsScore?.total ?? null });

    for (let i = 0; i < original.length; i += 1) {
      // Always remove the first one, so the confirmation is always "1".
      await removeEntryBlock('certification', 1, 'confirm');
      const expected = original.length - i - 1;
      await waitFor(() => (liveState().tailoredResume.certifications ?? []).length === expected, `${expected} certifications left`);
    }

    const after = liveState();
    check('store: the section is an empty array, not missing and not null', Array.isArray(after.tailoredResume.certifications) && after.tailoredResume.certifications.length === 0, after.tailoredResume.certifications);
    check('storage: the same', Array.isArray(storedState()?.tailoredResume?.certifications) && storedState().tailoredResume.certifications.length === 0);
    check('store: one log row per removal', describeManualEdits(after.tailorManualEdits).filter((l) => l.startsWith('Certifications:') && l.includes('(removed')).length === original.length, describeManualEdits(after.tailorManualEdits));
    const norm = normalizeResumeForExport(selectExportSource(after).raw);
    check('Export: the normaliser gives an empty array, no throw', Array.isArray(norm.certifications) && norm.certifications.length === 0);
    check('Export: sectionHasContent says no, so the PDF omits the section', sectionHasContent(norm, 'certifications') === false);
    const text = exportText(selectExportSource(after).raw);
    check('Export: the plain text has no CERTIFICATIONS heading', !text.includes('CERTIFICATIONS'));
    check('Export: every other section still prints', ['EXPERIENCE', 'SKILLS', 'EDUCATION'].filter((h) => text.includes(h)).length >= 2, text.slice(0, 200));
    check('Export: there is still exportable content, so it will not show the empty state', hasExportable(selectExportSource(after).raw) === true);
    check('page: the editor shows the section empty state, not a broken block', (() => {
      const heads = [...document.querySelectorAll('.editor-card h2')].find((h) => h.textContent.trim() === 'Certifications');
      return Boolean(heads) && heads.closest('.editor-card').innerText.includes('Your resume has no certifications entries');
    })());
    check('page: the add block is still there, so the section can be refilled', Boolean(document.querySelector('button[aria-label="Add certification"]')));
    // A VALUE check, not an identity check. rescoreCurrentResume deliberately
    // hands back the same object when the recomputed score is equal (its
    // equalTo short-circuit), and certifications that name no JD keyword move
    // no sub-score -- so `after.atsScore !== before.atsScore` failed on a
    // correct rescore. consistentLive compares the stored score with a fresh
    // recompute of the current resume, which is what "recomputed" means: a
    // skipped rescore would leave a stale value and still fail it.
    check('SCORE: matches a fresh recompute of the resume without them', consistentLive(after), {
      before: before.atsScore?.total,
      after: after.atsScore?.total,
      objectReused: after.atsScore === before.atsScore,
    });
    console.log('Now open /export and run verifyExportAfterEmptying(). Then come back and run restoreEmptiedSection().');
  } catch (err) {
    check(err.message, false, err);
  }
  return finishDraft('Open /export, run verifyExportAfterEmptying(), then restoreEmptiedSection().');
}

/** Point 6, on /export: the real page, the real preview. */
export function verifyExportAfterEmptying() {
  failed = 0;
  console.group('tailorEditor - live entries 8: /export with an emptied section');
  try {
    const { certs } = entryMemo();
    if (!Array.isArray(certs)) throw new Error('Run liveEmptySection() first.');
    if (location.pathname !== '/export') throw new Error('Open /export first.');
    const state = liveState();
    check('the page is not showing its empty state', !document.body.innerText.includes('Nothing to export yet'), document.body.innerText.slice(0, 80));
    const textarea = document.querySelector('#export-plain-text');
    check('the plain-text copy is on the page', Boolean(textarea));
    check('it has no CERTIFICATIONS heading', Boolean(textarea) && !textarea.value.includes('CERTIFICATIONS'));
    check('it still has the other sections', Boolean(textarea) && textarea.value.includes('EXPERIENCE'));
    check('none of the removed certifications is named anywhere on the page', certs.every((c) => !c.name || !document.body.innerText.includes(c.name)), certs.map((c) => c.name));
    check('the PDF error boundary did not trip', !document.body.innerText.includes('The preview could not be built') && !document.body.innerText.includes('preview failed'), null);
    check('the store still says the section is empty', (state.tailoredResume.certifications ?? []).length === 0);
    console.log('Preview rendered? Look at the page. Then go back to /tailor and run restoreEmptiedSection().');
  } catch (err) {
    check(err.message, false, err);
  }
  return finishDraft('Back on /tailor: await restoreEmptiedSection().');
}

/** Puts back what liveEmptySection() removed, through the same add action. */
export async function restoreEmptiedSection() {
  failed = 0;
  console.group('tailorEditor - live entries 9: restore the emptied section');
  try {
    const { certs } = entryMemo();
    if (!Array.isArray(certs)) throw new Error('Run liveEmptySection() first.');
    const { ACTIONS } = await import('../../context/AppContext.jsx');
    const dispatch = window.a2resumeDev?.dispatch;
    if (typeof dispatch !== 'function') throw new Error('window.a2resumeDev.dispatch is missing. Run this against the dev server.');
    for (const cert of certs) {
      dispatch({ type: ACTIONS.ADD_TAILORED_ENTRY, payload: { section: 'certifications', value: toDraft('certifications', cert) } });
    }
    await waitFor(() => (liveState().tailoredResume.certifications ?? []).length === certs.length, 'the certifications to come back');
    check('all of them are back', (liveState().tailoredResume.certifications ?? []).length === certs.length);
    check('with the same content', JSON.stringify(liveState().tailoredResume.certifications.map((c) => c.name)) === JSON.stringify(certs.map((c) => c.name)));
  } catch (err) {
    check(err.message, false, err);
  }
  return finishDraft('Done.');
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
  testEntriesOffline,
  testChangeEditsOffline,
  testReducer,
  testEntriesReducer,
  liveEditBullet,
  verifyBulletSurvived,
  verifyExportShowsBullet,
  liveLinkRoundTrip,
  liveToggleCurrent,
  liveTypeDraft,
  verifyDraftRecovered,
  liveDiscardRecoveredDraft,
  liveDraftClearedByNewPass,
  liveAddExperience,
  verifyAddedEntrySurvived,
  liveAddAroundDraft,
  verifyInsertDraftSurvived,
  liveRemoveEntry,
  verifyRemovalSurvived,
  liveRemoveEntryWithDraft,
  verifyDraftDidNotResurrect,
  liveEmptySection,
  verifyExportAfterEmptying,
  restoreEmptiedSection,
};
