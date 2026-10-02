/**
 * Manual checks for chatCopilot.js. Not imported by the app, not in the build.
 *
 *   const t = await import('/src/services/__manual__/chatCopilot.manual.js');
 *   await t.testChatCopilotOffline();   // no key, no network; also runs under Node
 *   await t.testChatReducer();          // appReducer: approval goes through the hand-edit actions (browser only)
 *
 * Offline proves the code guard: what is refused, what a proposal may and may
 * not contain, the approval-time re-check, and that nothing calls the model
 * for a message that is not a settled edit command. It cannot measure how well
 * any model proposes edits -- that is the live check, on the Tailor page.
 */

import { settleChatIntent } from '../chatIntentClassifier.js';
import {
  CHAT_PROVIDER_VERIFICATION,
  asksForRemoval,
  buildEditableBlocks,
  checkProposalApplicable,
  defaultChatProvider,
  isBareConfirmation,
  isChatEditProposal,
  isChatVerifiedProvider,
  proposeChatEdit,
  settleChatEdit,
} from '../chatCopilot.js';

export const SAMPLE_TAILORED = {
  name: 'Jane Doe',
  contact: { email: 'jane@example.com', phone: '', location: 'Sydney', customLinks: [{ label: 'GitHub', url: 'https://github.com/janedoe' }] },
  summary: 'Backend engineer with 6 years in payments.',
  skills: [{ category: 'Languages', skills: ['Go', 'Python'] }],
  experience: [
    {
      title: 'Senior Engineer',
      company: 'Acme Payments',
      location: 'Sydney',
      startDate: '2021',
      endDate: '',
      isCurrentlyWorking: true,
      bullets: ['Built the settlement service handling 2M transactions a day.', 'Mentored 3 engineers.'],
      links: [{ label: 'Talk', url: 'https://example.com/talk' }],
    },
    {
      title: 'Engineer',
      company: 'Springdale',
      location: 'Melbourne',
      startDate: '2018',
      endDate: '2021',
      isCurrentlyWorking: false,
      bullets: ['Maintained the billing system.'],
      links: [],
    },
  ],
  projects: [],
  education: [{ institution: 'UNSW', degree: 'BSc', field: 'Computer Science', location: '', startDate: '2014', endDate: '2017', details: [] }],
  certifications: [],
};

const editIntent = () =>
  settleChatIntent({ category: 'edit_command', confidence: 'high', reasoning: 'r', hasQuestion: false, hasEditInstruction: true });

function runner() {
  const rows = [];
  const check = (name, ok, detail = '') => rows.push({ name, ok: Boolean(ok), detail: String(detail) });
  const report = (title) => {
    const failed = rows.filter((r) => !r.ok);
    console.log(`${title}: ${rows.length - failed.length}/${rows.length} passed`);
    for (const r of failed) console.log(`  FAIL ${r.name} ${r.detail}`);
    return { passed: rows.length - failed.length, total: rows.length, failed };
  };
  return { check, report };
}

export async function testChatCopilotOffline() {
  const { check, report } = runner();
  const t = SAMPLE_TAILORED;
  const exp0 = buildEditableBlocks(t).find((b) => b.id === 'experience:0').value;

  // --- providers ----------------------------------------------------------
  check('only claude is verified', JSON.stringify(Object.keys(CHAT_PROVIDER_VERIFICATION)) === '["claude"]');
  for (const p of ['deepseek', 'gemini', 'openai', 'kimi']) check(`${p} unverified`, !isChatVerifiedProvider(p));
  check('default is claude when keyed', defaultChatProvider({ claude: true, gemini: true }) === 'claude');
  check('no default without a claude key', defaultChatProvider({ gemini: true, openai: true }) === null);

  // --- confirmations and removal words ------------------------------------
  for (const m of ['yes', 'Yes, do it', 'do it', 'ok', 'go ahead!', 'sounds good, thanks', 'the second one', 'make it so']) {
    check(`bare confirmation: ${m}`, isBareConfirmation(m));
  }
  for (const m of ['yes, add Kubernetes to skills', 'do it for the summary too', 'why?']) check(`not bare: ${m}`, !isBareConfirmation(m));
  check('removal word', asksForRemoval('Delete the Springdale role.') && !asksForRemoval('add Kubernetes to skills'));

  // --- the proposer refuses before any call --------------------------------
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('fetch must not be called');
  };
  try {
    const nonEdits = [
      null,
      undefined,
      settleChatIntent({ category: 'ambiguous', confidence: 'low', reasoning: 'r' }),
      settleChatIntent({ category: 'question', confidence: 'high', reasoning: 'r' }),
      { category: 'edit_command', confidence: 'high', reasoning: 'r', hasEditInstruction: true },
      { ...editIntent() },
      JSON.parse(JSON.stringify(editIntent())),
    ];
    for (const [i, intent] of nonEdits.entries()) {
      const r = await proposeChatEdit(intent, 'Delete the Springdale role.', { tailored: t, provider: 'claude', apiKey: 'x' });
      check(`non-edit #${i} declined without a call`, r.status === 'declined' && r.reason === 'not_an_edit');
    }
    check('zero fetches for non-edits', calls === 0, calls);
  } finally {
    globalThis.fetch = realFetch;
  }

  // --- settle rules --------------------------------------------------------
  const settle = (raw, message) => settleChatEdit(raw, { tailored: t, message });
  check('unreadable', settle(null, 'x').reason === 'unreadable');
  check('bad operation', settle({ operation: 'rewrite' }, 'x').reason === 'unreadable');
  check('model declined passes its reason', settle({ operation: 'none', explanation: 'which bullet?' }, 'x').detail === 'which bullet?');
  check('unknown block', settle({ operation: 'update', blockId: 'experience:9', newContentJson: '{}' }, 'x').reason === 'unknown_block');
  check('remove summary refused', settle({ operation: 'remove', blockId: 'summary' }, 'remove my summary').reason === 'remove_not_entry');
  check(
    'remove without asking refused',
    settle({ operation: 'remove', blockId: 'experience:1' }, 'make the Springdale role shorter').reason === 'remove_not_asked'
  );
  const removal = settle({ operation: 'remove', blockId: 'experience:1', explanation: 'Removed Springdale.' }, 'Delete the Springdale role.');
  check('remove proposed', removal.status === 'proposed' && removal.proposal.action.type === 'remove' && removal.proposal.index === 1);
  check('proposal is branded', isChatEditProposal(removal.proposal) && !isChatEditProposal({ ...removal.proposal }));
  check('bad json', settle({ operation: 'update', blockId: 'experience:0', newContentJson: '{nope' }, 'x').reason === 'bad_content');
  check('wrong shape for skills', settle({ operation: 'update', blockId: 'skills', newContentJson: '"Go"' }, 'x').reason === 'bad_content');
  check(
    'no-op refused',
    settle({ operation: 'update', blockId: 'experience:0', newContentJson: JSON.stringify(exp0) }, 'x').reason === 'no_change'
  );

  // Omitted keys keep their value: the model leaving out `links` must not delete them.
  const partial = settle(
    { operation: 'update', blockId: 'experience:0', newContentJson: JSON.stringify({ title: 'Staff Engineer' }), explanation: 'Retitled.' },
    'Change my Acme title to Staff Engineer'
  );
  check('partial content proposed', partial.status === 'proposed', partial.detail);
  check('omitted links kept', partial.proposal?.after.links.length === 1 && partial.proposal?.after.bullets.length === 2);
  check('diff names only the title', JSON.stringify(partial.proposal?.diff.map((d) => d.field)) === '["title"]', JSON.stringify(partial.proposal?.diff));

  // Shrinking without being asked is refused; with a removal word it is shown, with the loss named.
  const dropBullet = { operation: 'update', blockId: 'experience:0', newContentJson: JSON.stringify({ ...exp0, bullets: [exp0.bullets[0]] }) };
  check('unrequested bullet loss refused', settle(dropBullet, 'Make the Acme bullets punchier').reason === 'unrequested_loss');
  const asked = settle(dropBullet, 'Remove the mentoring bullet from Acme');
  check('requested bullet loss proposed with loss named', asked.status === 'proposed' && asked.proposal.losses.length === 1, JSON.stringify(asked.proposal?.losses));
  check(
    'skill dropped while adding refused',
    settle({ operation: 'update', blockId: 'skills', newContentJson: JSON.stringify([{ category: 'Languages', skills: ['Go', 'Kubernetes'] }]) }, 'add Kubernetes to skills')
      .reason === 'unrequested_loss'
  );
  const addSkill = settle(
    { operation: 'update', blockId: 'skills', newContentJson: JSON.stringify([{ category: 'Languages', skills: ['Go', 'Python', 'Kubernetes'] }]) },
    'add Kubernetes to skills'
  );
  check('skill add proposed', addSkill.status === 'proposed' && addSkill.proposal.losses.length === 0);
  check('emptying a field refused', settle({ operation: 'update', blockId: 'experience:0', newContentJson: JSON.stringify({ location: '' }) }, 'fix the Acme role').reason === 'unrequested_loss');

  // Invented numbers are flagged, numbers from the message are not.
  const invented = settle(
    { operation: 'update', blockId: 'summary', newContentJson: JSON.stringify('Backend engineer with 6 years in payments, cutting costs 40%.') },
    'Rewrite my summary to mention cost savings'
  );
  check('invented number warned', invented.proposal?.warnings.length === 1 && invented.proposal.warnings[0].includes('40'));
  const supplied = settle(
    { operation: 'update', blockId: 'summary', newContentJson: JSON.stringify('Backend engineer with 6 years in payments, cutting costs 40%.') },
    'Add to my summary that I cut costs by 40%'
  );
  check('supplied number not warned', supplied.proposal?.warnings.length === 0);
  check('bare-text summary accepted', settle({ operation: 'update', blockId: 'summary', newContentJson: 'Plain text summary.' }, 'x').status === 'proposed');

  // --- approval-time re-check -----------------------------------------------
  const p = partial.proposal;
  check('applicable as proposed', checkProposalApplicable(p, { tailored: t }).ok);
  check('raw object not applicable', !checkProposalApplicable({ ...p }, { tailored: t }).ok);
  const edited = { ...t, experience: t.experience.map((e, i) => (i === 0 ? { ...e, bullets: ['Different.'] } : e)) };
  check('block changed since -> refused', !checkProposalApplicable(p, { tailored: edited }).ok);
  const shifted = { ...t, experience: [{ title: 'New', company: 'NewCo', bullets: [] }, ...t.experience] };
  check('index drift (top insert) -> refused', !checkProposalApplicable(p, { tailored: shifted }).ok);
  const removedFirst = { ...t, experience: t.experience.slice(1) };
  check('index drift (removal) -> refused', !checkProposalApplicable(removal.proposal, { tailored: removedFirst }).ok);
  check('open block -> refused', !checkProposalApplicable(p, { tailored: t, openBlocks: new Set(['experience:0']) }).ok);
  check('other open block -> fine', checkProposalApplicable(p, { tailored: t, openBlocks: new Set(['experience:1']) }).ok);
  check(
    'pending draft -> refused',
    !checkProposalApplicable(p, { tailored: t, draftEdits: [{ section: 'experience', index: 0, value: {} }] }).ok
  );
  check('no tailored -> refused', !checkProposalApplicable(p, { tailored: null }).ok);

  return report('chatCopilot offline');
}

/**
 * Browser only (AppContext is JSX). Approval goes through the hand editor's
 * own actions: the change lands, the edit log names it "(via chat)", the score
 * is recomputed, a pending draft elsewhere survives, and nothing else moves.
 */
export async function testChatReducer() {
  const { check, report } = runner();
  const { appReducer, initialState, ACTIONS } = await import('../../context/AppContext.jsx');
  const t = SAMPLE_TAILORED;
  const base = {
    ...initialState,
    resume: t,
    parsedJD: { jobTitle: 'Engineer', atsKeywords: { high: ['Kubernetes'], medium: [], low: [] } },
    tailoredResume: t,
    draftEdits: [{ section: 'summary', index: null, value: 'typing...' }],
  };

  const add = settleChatEdit(
    { operation: 'update', blockId: 'skills', newContentJson: JSON.stringify([{ category: 'Languages', skills: ['Go', 'Python', 'Kubernetes'] }]) },
    { tailored: t, message: 'add Kubernetes to skills' }
  ).proposal;
  const s1 = appReducer(base, { type: ACTIONS.UPDATE_TAILORED_SECTION, payload: { ...add.action.payload, origin: 'chat' } });
  check('skill landed', JSON.stringify(s1.tailoredResume.skills[0].skills) === '["Go","Python","Kubernetes"]');
  check('original untouched', s1.resume === t);
  check('logged via chat', s1.tailorManualEdits?.[0]?.label === 'Skills (via chat)', JSON.stringify(s1.tailorManualEdits));
  check('other draft survives', s1.draftEdits?.length === 1 && s1.draftEdits[0].section === 'summary');
  check('rescored', s1.atsScore !== null && s1.gapAnalysis?.matched?.some((k) => k.keyword === 'Kubernetes'));
  check('experience unchanged', s1.tailoredResume.experience === t.experience);

  const rm = settleChatEdit({ operation: 'remove', blockId: 'experience:1' }, { tailored: t, message: 'Delete the Springdale role.' }).proposal;
  const s2 = appReducer(s1, { type: ACTIONS.REMOVE_TAILORED_ENTRY, payload: { ...rm.action.payload, origin: 'chat' } });
  check('entry removed', s2.tailoredResume.experience.length === 1 && s2.tailoredResume.experience[0].company === 'Acme Payments');
  check('removal logged via chat', s2.tailorManualEdits.at(-1).label.endsWith('(removed by hand) (via chat)'));
  const hand = appReducer(base, { type: ACTIONS.UPDATE_TAILORED_SECTION, payload: add.action.payload });
  check('hand edit label unchanged', hand.tailorManualEdits?.[0]?.label === 'Skills');

  return report('chatCopilot reducer');
}
