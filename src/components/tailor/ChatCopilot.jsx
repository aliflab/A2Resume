import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';

import { ACTIONS, useApp } from '../../context/AppContext.jsx';
import { getApiKey, getKeyPresence } from '../../services/apiKeyService.js';
import { AiError, PROVIDER_LABELS, SUPPORTED_PROVIDERS } from '../../services/aiService.js';
import { MAX_CHAT_MESSAGE_LENGTH, OVERRIDE_REASONS, classifyChatIntent, isEditCommand } from '../../services/chatIntentClassifier.js';
import {
  CHAT_PROVIDER_VERIFICATION,
  answerChatMessage,
  checkProposalApplicable,
  defaultChatProvider,
  isBareConfirmation,
  isChatVerifiedProvider,
  proposeChatEdit,
} from '../../services/chatCopilot.js';
import { describeError } from '../../utils/errorMessages.js';

/**
 * The resume chat on Tailor. Questions get answers; edit commands get a
 * PROPOSAL, shown as a before/after, that changes nothing until Approve.
 *
 * Approve dispatches the hand editor's own actions (UPDATE_TAILORED_SECTION /
 * REMOVE_TAILORED_ENTRY) with `origin: 'chat'`, after chatCopilot's
 * checkProposalApplicable has re-checked the proposal against the resume as it
 * is at that moment. Reject dispatches nothing. Every rule about what a
 * proposal may contain lives in chatCopilot.js, not here.
 *
 * HISTORY. The conversation is page-local state: it lasts while Tailor is open
 * and is not saved to the session (a reload or leaving the page clears it).
 * It is shown, and the answer call sees the last few turns, but the classifier
 * and the edit proposer see ONLY the message just sent. A "yes, do it" is
 * therefore judged on its own, comes back ambiguous, and changes nothing; the
 * reply says to name the change. An answer that recommends a change can offer
 * that change as a self-contained sentence, which only fills the input box --
 * sending it is a new message that is classified from scratch.
 *
 * PROVIDERS. Chat starts on Claude when a key for it exists and on nothing
 * otherwise. Any provider with a key can be picked, but one that is not in
 * CHAT_PROVIDER_VERIFICATION shows a warning that stays on screen while it is
 * selected, needs an explicit "I understand" before the first message, and
 * marks every reply it produces as coming from an unverified provider.
 */

function safePresence() {
  try {
    return getKeyPresence();
  } catch {
    return {};
  }
}

const label = (provider) => PROVIDER_LABELS[provider] ?? provider;

const STAGE_TEXT = {
  classify: 'Reading your message...',
  propose: 'Drafting a proposed change...',
  answer: 'Answering...',
};

export default function ChatCopilot({ openBlocks }) {
  const { state, dispatch } = useApp();
  const inputId = useId();
  const inputRef = useRef(null);
  const nextId = useRef(1);

  const presence = safePresence();
  const available = SUPPORTED_PROVIDERS.filter((id) => presence[id]);
  const [chosen, setChosen] = useState(null);
  // Derived, not synced by an effect (same as InputPage): a key removed in
  // Settings cannot leave the chat pointing at a provider with no key.
  const provider = chosen && presence[chosen] ? chosen : defaultChatProvider(presence);
  const verified = provider ? isChatVerifiedProvider(provider) : false;
  const [acknowledged, setAcknowledged] = useState(() => new Set());
  const canSend = Boolean(provider) && (verified || acknowledged.has(provider));

  const [turns, setTurns] = useState([]);
  const [input, setInput] = useState('');
  const [stage, setStage] = useState(null);

  const tailored = state.tailoredResume;

  const push = (turn) => {
    const id = nextId.current++;
    setTurns((t) => [...t, { ...turn, id }]);
    return id;
  };
  const patch = (id, fields) => setTurns((t) => t.map((turn) => (turn.id === id ? { ...turn, ...fields } : turn)));

  const send = async (event) => {
      event?.preventDefault();
      const message = input;
      if (!message.trim() || stage || !canSend) return;
      const apiKey = getApiKey(provider);
      const meta = { provider, verified: isChatVerifiedProvider(provider) };
      // History for the ANSWER call only: text of earlier turns, never their
      // classification, and never handed to the classifier or the proposer.
      const history = turns.map((t) => ({ role: t.role, text: t.text ?? t.summary ?? '' })).filter((t) => t.text);

      push({ role: 'user', text: message });
      setInput('');
      try {
        if (!apiKey) throw new AiError('auth', `No API key stored for ${label(provider)}.`, { provider });

        setStage('classify');
        const intent = await classifyChatIntent(message, { provider, apiKey });

        if (isEditCommand(intent)) {
          setStage('propose');
          const result = await proposeChatEdit(intent, message, { tailored, original: state.resume, provider, apiKey });
          if (result.status === 'proposed') {
            push({
              role: 'assistant',
              kind: 'proposal',
              intent,
              proposal: result.proposal,
              decision: 'pending',
              summary: `Proposed a change to ${result.proposal.label}: ${result.proposal.explanation}`,
              ...meta,
            });
          } else {
            push({ role: 'assistant', kind: 'declined', intent, text: result.detail, ...meta });
          }
          return;
        }

        if (intent.category === 'ambiguous' && isBareConfirmation(message)) {
          push({ role: 'assistant', kind: 'confirmation', intent, ...meta });
          return;
        }

        setStage('answer');
        const answer = await answerChatMessage(message, {
          resume: tailored,
          parsedJD: state.parsedJD,
          gapAnalysis: state.gapAnalysis,
          history,
          provider,
          apiKey,
        });
        push({ role: 'assistant', kind: 'answer', intent, text: answer.answer, suggestion: answer.suggestedInstruction, ...meta });
      } catch (err) {
        // A failed call is not a classification and changes nothing.
        push({ role: 'assistant', kind: 'error', error: describeError(err, { provider }), ...meta });
      } finally {
        setStage(null);
      }
  };

  const approve = (turn) => {
    // Re-checked at the click, not trusted from the render: the resume may
    // have changed between the two.
    const check = checkProposalApplicable(turn.proposal, { tailored: state.tailoredResume, draftEdits: state.draftEdits, openBlocks });
    if (!check.ok) return;
    const { action } = turn.proposal;
    if (action.type === 'remove') {
      dispatch({ type: ACTIONS.REMOVE_TAILORED_ENTRY, payload: { ...action.payload, origin: 'chat' } });
    } else {
      dispatch({ type: ACTIONS.UPDATE_TAILORED_SECTION, payload: { ...action.payload, origin: 'chat' } });
    }
    patch(turn.id, { decision: 'approved' });
  };

  const reject = (turn) => patch(turn.id, { decision: 'rejected' });

  const useSuggestion = (text) => {
    setInput(text);
    inputRef.current?.focus();
  };

  return (
    <section className="card chat" aria-labelledby={`${inputId}-title`}>
      <h2 id={`${inputId}-title`}>Ask about your resume, or ask for a change</h2>
      <p className="muted">
        Questions are answered and change nothing. A request to change something is only ever{' '}
        <strong>proposed</strong>: you see exactly what would change, and nothing happens to your resume unless you
        press Approve. Each message is judged on its own, so say the whole change each time — &ldquo;yes, do
        it&rdquo; on its own is not treated as an edit.
      </p>

      <ProviderPicker
        available={available}
        provider={provider}
        onChange={setChosen}
        acknowledged={acknowledged}
        onAcknowledge={(id) => setAcknowledged((s) => new Set(s).add(id))}
      />

      {turns.length > 0 && (
        <ol className="chat__log" aria-live="polite">
          {turns.map((turn) =>
            turn.role === 'user' ? (
              <li key={turn.id} className="chat__turn chat__turn--user">
                <span className="chat__who">You</span>
                <p>{turn.text}</p>
              </li>
            ) : (
              <AssistantTurn
                key={turn.id}
                turn={turn}
                applicability={
                  turn.kind === 'proposal' && turn.decision === 'pending'
                    ? checkProposalApplicable(turn.proposal, { tailored, draftEdits: state.draftEdits, openBlocks })
                    : null
                }
                onApprove={() => approve(turn)}
                onReject={() => reject(turn)}
                onUseSuggestion={useSuggestion}
              />
            )
          )}
        </ol>
      )}

      <form className="chat__form" onSubmit={send}>
        <label htmlFor={inputId} className="visually-hidden">
          Message
        </label>
        <textarea
          id={inputId}
          ref={inputRef}
          rows={2}
          value={input}
          maxLength={MAX_CHAT_MESSAGE_LENGTH}
          placeholder={'e.g. "Why is my score low?" or "Add Kubernetes to my skills"'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) send(e);
          }}
          disabled={!canSend}
        />
        <p className="actions">
          <button type="submit" className="button button--primary" disabled={!canSend || !input.trim() || Boolean(stage)}>
            {stage ? STAGE_TEXT[stage] : 'Send'}
          </button>
        </p>
      </form>
    </section>
  );
}

function ProviderPicker({ available, provider, onChange, acknowledged, onAcknowledge }) {
  const id = useId();
  if (available.length === 0) {
    return (
      <p className="inline-status inline-status--error">
        Chat needs an AI provider. <Link to="/settings">Add a key in Settings</Link> — Claude is the one verified for
        chat edits.
      </p>
    );
  }
  const verified = provider ? isChatVerifiedProvider(provider) : false;
  const verifiedNames = Object.keys(CHAT_PROVIDER_VERIFICATION).map(label).join(', ');
  return (
    <div className="chat__provider">
      <p>
        <label htmlFor={id}>Provider for chat </label>
        <select id={id} value={provider ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          {!provider && <option value="">Choose a provider</option>}
          {available.map((p) => (
            <option key={p} value={p}>
              {label(p)}
              {isChatVerifiedProvider(p) ? ' (verified for chat)' : ' (not verified for chat)'}
            </option>
          ))}
        </select>
      </p>
      {!provider && (
        <p className="inline-status inline-status--warn">
          No key for {verifiedNames}, the provider verified for chat edits. You can choose another provider above,
          with a warning.
        </p>
      )}
      {provider && !verified && (
        <div className="notice notice--warn chat__unverified" role="alert">
          <p>
            <strong>{label(provider)} is not verified for chat edits.</strong>
          </p>
          <p>
            Deciding whether a message is a question or an instruction to change your resume was tested live on{' '}
            {verifiedNames} with 39 deliberately tricky messages, with no unsafe results. {label(provider)} has not
            been through that test, so its reliability for chat-based edits has not been confirmed the way{' '}
            {verifiedNames}&rsquo;s has. Every change still waits for your approval, but read each proposal closely.
          </p>
          {!acknowledged.has(provider) && (
            <p>
              <label>
                <input type="checkbox" onChange={(e) => e.target.checked && onAcknowledge(provider)} /> I understand —
                use {label(provider)} for chat anyway
              </label>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function IntentLine({ intent }) {
  if (!intent) return null;
  const words = { question: 'Question', edit_command: 'Edit command', ambiguous: 'Ambiguous' };
  return (
    <p className="chat__intent">
      <span className={`badge chat__category chat__category--${intent.category}`}>{words[intent.category]}</span>{' '}
      <span className="muted">
        {intent.confidence} confidence — {intent.reasoning}
        {intent.overrides?.length > 0 && <> (safety rule: {intent.overrides.map((o) => OVERRIDE_REASONS[o] ?? o).join(' ')})</>}
      </span>
    </p>
  );
}

function AssistantTurn({ turn, applicability, onApprove, onReject, onUseSuggestion }) {
  return (
    <li className={`chat__turn chat__turn--assistant chat__turn--${turn.kind}`}>
      <span className="chat__who">
        {label(turn.provider)}
        {!turn.verified && <span className="badge chat__unverified-badge">not verified for chat</span>}
      </span>
      <IntentLine intent={turn.intent} />

      {turn.kind === 'answer' && (
        <>
          <p className="chat__text">{turn.text}</p>
          {turn.intent?.category === 'ambiguous' && (
            <p className="inline-status inline-status--warn">
              Not treated as an edit, so nothing was changed. If you want a change, send a message that says exactly
              what to change.
            </p>
          )}
          {turn.suggestion && (
            <p className="chat__suggestion">
              <span className="muted">Suggested change: &ldquo;{turn.suggestion}&rdquo;</span>{' '}
              <button type="button" onClick={() => onUseSuggestion(turn.suggestion)}>
                Put this in the message box
              </button>
            </p>
          )}
          <p className="chat__nochange muted">Nothing in your resume was changed.</p>
        </>
      )}

      {turn.kind === 'confirmation' && (
        <p className="inline-status inline-status--warn">
          Nothing was changed. This chat does not carry earlier messages into edits, so a reply like this cannot say
          which change you mean. Send the change itself, for example &ldquo;Rewrite my summary to mention
          Kubernetes&rdquo;{' '}— or use &ldquo;Put this in the message box&rdquo; under an earlier answer.
        </p>
      )}

      {turn.kind === 'declined' && (
        <p className="inline-status inline-status--warn">No change proposed: {turn.text} Nothing was changed.</p>
      )}

      {turn.kind === 'error' && (
        <p className="inline-status inline-status--error">
          {turn.error.message} Nothing was changed. {turn.error.isAuth && <Link to="/settings">Open Settings</Link>}
        </p>
      )}

      {turn.kind === 'proposal' && (
        <ProposalCard turn={turn} applicability={applicability} onApprove={onApprove} onReject={onReject} />
      )}
    </li>
  );
}

function ProposalCard({ turn, applicability, onApprove, onReject }) {
  const p = turn.proposal;
  return (
    <div className="chat__proposal">
      <p>
        <strong>
          Proposed: {p.operation === 'remove' ? 'remove' : 'change'} {p.label}
        </strong>
        {p.explanation && <span className="muted"> — {p.explanation}</span>}
      </p>

      {p.operation === 'remove' ? (
        <p className="change__before">
          <span className="change__label">Removed from your tailored resume</span>
          {p.diff.flatMap((d) => d.before).join(' · ')}
        </p>
      ) : (
        <ul className="chat__diff">
          {p.diff.map((d) => (
            <li key={d.field}>
              <span className="badge">{d.field}</span>
              <div className="change__before">
                <span className="change__label">Before</span>
                {d.before.length > 0 ? d.before.map((line, i) => <p key={i}>{line}</p>) : <em>(empty)</em>}
              </div>
              <div className="change__after">
                <span className="change__label">After</span>
                {d.after.length > 0 ? d.after.map((line, i) => <p key={i}>{line}</p>) : <em>(empty)</em>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {p.losses.length > 0 && <p className="inline-status inline-status--warn">This removes: {p.losses.join('; ')}.</p>}
      {p.warnings.map((w) => (
        <p key={w} className="inline-status inline-status--warn">
          {w}
        </p>
      ))}

      {turn.decision === 'pending' && (
        <>
          <p className="muted">
            Nothing has changed yet. Approving applies exactly this to your tailored resume, logs it as an edit, and
            rescores. Your original resume from step 1 is not touched.
          </p>
          {applicability && !applicability.ok && (
            <p className="inline-status inline-status--warn" role="status">
              {applicability.reason}
            </p>
          )}
          <p className="actions">
            <button type="button" className="button button--primary" onClick={onApprove} disabled={!applicability?.ok}>
              Approve this change
            </button>
            <button type="button" className="button" onClick={onReject}>
              Reject
            </button>
          </p>
        </>
      )}
      {turn.decision === 'approved' && (
        <p className="inline-status inline-status--ok">Approved and applied. It is listed with your edits above.</p>
      )}
      {turn.decision === 'rejected' && <p className="inline-status">Rejected. Nothing was changed.</p>}
    </div>
  );
}
