/**
 * Unit coverage for the unified completion-status primitive: the tail
 * classifier (classifyTail), the error copy table, and the holistic
 * status arbiter (selectCompletionStatus). Pure functions - no runes,
 * no DOM - tested via plain vitest. These tests are the contract for
 * the "exactly one what-went-wrong card" guarantee the chat screen
 * relies on.
 */
import { describe, it, expect } from 'vitest';
import type { Message } from '../src/lib/supabase';
import {
  classifyTail,
  isReasoningOnlyStall,
  isCutOffPartialText,
  selectCompletionStatus,
  copyForErrorKind,
  parseLastError,
} from '../src/lib/ui/completion-status';
import type { CompletionErrorKind } from '../src/lib/ui/completion-status';
import { RECOVERY_MARKER } from '../src/lib/conversation-recovery';
import { ASK_USER_PENDING_FLAG } from '../src/lib/ask-user';

function msg(over: Partial<Message>): Message {
  return {
    id: 'm1',
    thread_id: 't1',
    role: 'assistant',
    content: '',
    created_at: '2024-01-01T00:00:00Z',
    ...over,
  } as Message;
}

function userMsg(): Message {
  return msg({ id: 'u1', role: 'user', content: 'hello' });
}

function pendingSentinel(): Message {
  return msg({
    id: 'sentinel',
    role: 'tool',
    tool_call_id: 'ask',
    content: JSON.stringify({
      [ASK_USER_PENDING_FLAG]: true,
      question: 'q',
      options: [{ label: 'a', description: 'b' }],
    }),
  });
}

function toolRow(): Message {
  return msg({ id: 'tool1', role: 'tool', tool_call_id: 'c1' });
}

function toolCallRow(): Message {
  return msg({
    id: 'callrow',
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } },
    ],
  });
}

function recoveryRow(): Message {
  return msg({ id: 'healed', content: 'recovered\n' + RECOVERY_MARKER });
}

describe('classifyTail', () => {
  it('classifies an empty list as settled', () => {
    expect(classifyTail([])).toEqual({ kind: 'settled' });
  });

  it('classifies a complete assistant reply as settled', () => {
    const done = msg({ id: 'a1', content: 'done' });
    expect(classifyTail([userMsg(), done]).kind).toBe('settled');
  });

  it('classifies a raw pending ask_user sentinel as suspended', () => {
    const v = classifyTail([userMsg(), pendingSentinel()]);
    expect(v.kind).toBe('suspended');
  });

  it('classifies an aborted assistant tail as deliberate-stop', () => {
    const v = classifyTail([
      userMsg(),
      msg({ id: 'ab', content: 'partial', status: 'aborted' }),
    ]);
    expect(v.kind).toBe('deliberate-stop');
  });

  it('classifies a draft user tail as draft-pending', () => {
    const draft = msg({ id: 'd1', role: 'user', status: 'draft' });
    expect(classifyTail([draft]).kind).toBe('draft-pending');
  });

  it('classifies a non-draft user tail as unanswered', () => {
    expect(classifyTail([userMsg()]).kind).toBe('unanswered');
  });

  it('classifies a raw tool tail as interrupted-round', () => {
    const v = classifyTail([userMsg(), toolRow()]);
    expect(v.kind).toBe('interrupted-round');
  });

  it('classifies an assistant-with-tool_calls tail as interrupted-round', () => {
    const v = classifyTail([userMsg(), toolCallRow()]);
    expect(v.kind).toBe('interrupted-round');
  });

  it('classifies a healed tail as interrupted-round, not settled', () => {
    // The regression the unification fixed: the recovery synthesizer
    // appends a recovery assistant after an interrupted tool round; the
    // tail must still read as incomplete rather than silently settled.
    const v = classifyTail([userMsg(), toolRow(), recoveryRow()]);
    expect(v.kind).toBe('interrupted-round');
  });

  it('classifies a healed tail over a pending ask_user sentinel as suspended', () => {
    // The recovery walk heals a pending-sentinel tail with a synthetic
    // assistant; an open question is never a cut-off turn.
    const v = classifyTail([userMsg(), pendingSentinel(), recoveryRow()]);
    expect(v.kind).toBe('suspended');
  });

  it('classifies a reasoning-only stall as stalled', () => {
    const v = classifyTail([
      userMsg(),
      msg({ id: 'stall', content: '', reasoning: 'thinking' }),
    ]);
    expect(v.kind).toBe('stalled');
  });

  it('classifies a partial-text cutoff as cut-off', () => {
    const v = classifyTail([
      userMsg(),
      msg({ id: 'cut', status: 'error', content: 'Half a sentence' }),
    ]);
    expect(v.kind).toBe('cut-off');
  });
});

describe('isReasoningOnlyStall and isCutOffPartialText', () => {
  it('stall requires reasoning, no content, no tool calls, not aborted', () => {
    expect(isReasoningOnlyStall(msg({ content: '', reasoning: 'hmm' }))).toBe(true);
    expect(isReasoningOnlyStall(msg({ content: '   ', reasoning: 'hmm' }))).toBe(true);
    expect(isReasoningOnlyStall(msg({ content: 'answer', reasoning: 'hmm' }))).toBe(false);
    expect(isReasoningOnlyStall(msg({ content: '', reasoning: '' }))).toBe(false);
    expect(
      isReasoningOnlyStall(msg({ content: '', status: 'aborted', reasoning: 'hmm' }))
    ).toBe(false);
  });

  it('cutoff requires status error and visible content', () => {
    expect(isCutOffPartialText(msg({ status: 'error', content: 'half' }))).toBe(true);
    expect(isCutOffPartialText(msg({ status: 'error', content: '' }))).toBe(false);
    expect(isCutOffPartialText(msg({ status: 'complete', content: 'full' }))).toBe(false);
    expect(isCutOffPartialText(msg({ status: 'aborted', content: 'stopped' }))).toBe(false);
  });
});

describe('selectCompletionStatus', () => {
  it('renders nothing while a turn is pending', () => {
    expect(
      selectCompletionStatus({ messages: [userMsg()], turnPending: true, liveError: { kind: 'rate_limit' }, lastError: null, draft: null })
    ).toBeNull();
  });

  it('prefers the live error over the persisted envelope', () => {
    const sel = selectCompletionStatus({
      messages: [userMsg(), toolRow()],
      turnPending: false,
      liveError: { kind: 'rate_limit' },
      lastError: { kind: 'internal', message: 'x', retryable: true },
      draft: null,
    });
    expect(sel?.source).toBe('live-error');
    expect(sel?.status.title).toBe('Rate limited');
  });

  it('falls back to the persisted error when no live error is set', () => {
    const sel = selectCompletionStatus({
      messages: [userMsg(), msg({ id: 'cut', status: 'error', content: 'half' })],
      turnPending: false,
      liveError: null,
      lastError: { kind: 'rate_limit', message: 'overloaded', retryable: true },
      draft: null,
    });
    expect(sel?.source).toBe('persisted-error');
    expect(sel?.status.title).toBe('Rate limited');
    expect(sel?.status.retry?.kind).toBe('replace');
  });

  it('omits the retry button when the tail is settled', () => {
    const sel = selectCompletionStatus({
      messages: [userMsg(), msg({ id: 'a', content: 'complete answer' })],
      turnPending: false,
      liveError: { kind: 'internal', detail: 'boom' },
      lastError: null,
      draft: null,
    });
    expect(sel?.status.retry).toBeUndefined();
  });

  it('derives a replace intent when the tail is a dead row under a live error', () => {
    const sel = selectCompletionStatus({
      messages: [userMsg(), msg({ id: 'cut', status: 'error', content: 'half' })],
      turnPending: false,
      liveError: { kind: 'rate_limit' },
      lastError: null,
      draft: null,
    });
    expect(sel?.status.retry?.kind).toBe('replace');
  });

  it('gives a stalled tail card a replace intent', () => {
    const stall = msg({ id: 'stall', content: '', reasoning: 'hmm' });
    const sel = selectCompletionStatus({
      messages: [userMsg(), stall],
      turnPending: false,
      liveError: null,
      lastError: null,
      draft: null,
    });
    expect(sel?.source).toBe('tail');
    expect(sel?.status.retry).toEqual({ kind: 'replace', deleteId: 'stall' });
  });

  it('shows the cut-off card for a partial tail with no last_error', () => {
    const cut = msg({ id: 'cut', status: 'error', content: 'half' });
    const sel = selectCompletionStatus({
      messages: [userMsg(), cut],
      turnPending: false,
      liveError: null,
      lastError: null,
      draft: null,
    });
    expect(sel?.source).toBe('tail');
    expect(sel?.status.title).toBe('Response cut off');
    expect(sel?.status.retry).toEqual({ kind: 'replace', deleteId: 'cut' });
  });

  it('shows the interrupted-draft card for a user tail with a matching draft', () => {
    const sel = selectCompletionStatus({
      messages: [userMsg()],
      turnPending: false,
      liveError: null,
      lastError: null,
      draft: { userMessageId: 'u1', threadId: 't1' },
    });
    expect(sel?.source).toBe('interrupted-draft');
    expect(sel?.status.discard).toBe(true);
    expect(sel?.status.retry?.kind).toBe('draft');
  });

  it('ignores a draft that does not anchor the tail row', () => {
    const sel = selectCompletionStatus({
      messages: [userMsg(), msg({ id: 'a', content: 'reply' })],
      turnPending: false,
      liveError: null,
      lastError: null,
      draft: { userMessageId: 'u1', threadId: 't1' },
    });
    expect(sel).toBeNull();
  });

  it('serves the persisted round_limit error with a continue intent over a tool tail', () => {
    const sel = selectCompletionStatus({
      messages: [userMsg(), toolRow()],
      turnPending: false,
      liveError: null,
      lastError: { kind: 'round_limit', message: '', retryable: true },
      draft: null,
    });
    expect(sel?.source).toBe('persisted-error');
    expect(sel?.status.title).toBe('Hit the round limit');
    expect(sel?.status.retry?.kind).toBe('continue');
  });
});

describe('copyForErrorKind', () => {
  const kinds: CompletionErrorKind[] = [
    'auth',
    'rate_limit',
    'http',
    'network',
    'parse',
    'truncated',
    'internal',
    'round_limit',
    'wall_timeout',
    'tool_dispatch',
    'commit_conflict',
    'guard_exhausted',
  ];

  it('gives every kind a title and advice', () => {
    for (const kind of kinds) {
      const copy = copyForErrorKind(kind);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.advice.length).toBeGreaterThan(0);
    }
  });

  it('gives internal errors the generic low-detail title', () => {
    expect(copyForErrorKind('internal').title).toBe('Something went wrong');
  });
});

describe('parseLastError', () => {
  it('parses a valid envelope', () => {
    const parsed = parseLastError({
      kind: 'rate_limit',
      message: 'busy',
      retryable: true,
      occurred_at: '2026-01-01T00:00:00Z',
    });
    expect(parsed?.kind).toBe('rate_limit');
    expect(parsed?.retryable).toBe(true);
  });

  it('reads null for a non-envelope value', () => {
    expect(parseLastError('nope')).toBeNull();
    expect(parseLastError({ kind: 'bogus' })).toBeNull();
  });

  it('defaults retryable to true for a shape missing the flag', () => {
    expect(parseLastError({ kind: 'internal' })?.retryable).toBe(true);
  });
});
