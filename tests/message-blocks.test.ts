/**
 * Coverage for the chat transcript's render-plan fold
 * (src/lib/ui/message-blocks.ts). Pure functions - plain vitest, no
 * mount, no harness. The recovery-row filtering cases are the load-
 * bearing ones: synthesizeRecoveryMessages keeps the wire shape valid
 * by inserting marker rows, and the builder must hide BOTH the
 * synthetic (in-memory) and persisted shapes from the user without
 * touching any legitimate row.
 */
import { describe, it, expect } from 'vitest';
import type { Message } from '../src/lib/supabase';
import type { OpenAIToolCall } from '../src/lib/tools';
import {
  buildMessageBlocks,
  findOpeningUserMessageIdForTail,
} from '../src/lib/ui/message-blocks';
import { RECOVERY_MARKER } from '../src/lib/conversation-recovery';
import {
  ASK_USER_PENDING_FLAG,
  ASK_USER_ANSWERED_FLAG,
} from '../src/lib/ask-user';

let seq = 0;
function msg(over: Partial<Message>): Message {
  seq += 1;
  return {
    id: `m${seq}`,
    thread_id: 't1',
    role: 'assistant',
    content: '',
    created_at: '2024-01-01T00:00:00Z',
    ...over,
  } as Message;
}

function call(id: string, name: string, args: string = '{}'): OpenAIToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

const ASK_ARGS = JSON.stringify({
  question: 'Which one?',
  options: [
    { label: 'A', description: 'first' },
    { label: 'B', description: 'second' },
  ],
});

const PENDING_CONTENT = JSON.stringify({
  [ASK_USER_PENDING_FLAG]: true,
  question: 'Which one?',
  options: [
    { label: 'A', description: 'first' },
    { label: 'B', description: 'second' },
  ],
});

describe('buildMessageBlocks - plain rows', () => {
  it('passes user and assistant text rows through in order', () => {
    const u = msg({ id: 'u1', role: 'user', content: 'hi' });
    const a = msg({ id: 'a1', content: 'hello' });
    expect(buildMessageBlocks([u, a])).toEqual([
      { kind: 'plain', message: u },
      { kind: 'plain', message: a },
    ]);
  });

  it('returns an empty plan for an empty transcript', () => {
    expect(buildMessageBlocks([])).toEqual([]);
  });
});

describe('buildMessageBlocks - tool folding', () => {
  it('folds tool-result rows under their assistant parent as one tool-group', () => {
    const a = msg({
      id: 'a1',
      content: '',
      tool_calls: [call('c1', 'web_search'), call('c2', 'memory_recall')],
    });
    const r1 = msg({ id: 'r1', role: 'tool', tool_call_id: 'c1', content: '{"ok":1}' });
    const r2 = msg({ id: 'r2', role: 'tool', tool_call_id: 'c2', content: '{"ok":2}' });
    const blocks = buildMessageBlocks([a, r1, r2]);
    expect(blocks).toHaveLength(1);
    const group = blocks[0];
    if (group.kind !== 'tool-group') throw new Error('expected tool-group');
    expect(group.assistant.tool_calls).toHaveLength(2);
    expect(group.resultsByCallId).toEqual({ c1: r1, c2: r2 });
  });

  it('emits a tool-group with no results for an orphaned tool round (results never landed)', () => {
    const a = msg({ id: 'a1', tool_calls: [call('c1', 'web_search')] });
    const blocks = buildMessageBlocks([a]);
    expect(blocks).toHaveLength(1);
    const group = blocks[0];
    if (group.kind !== 'tool-group') throw new Error('expected tool-group');
    expect(group.resultsByCallId).toEqual({});
  });

  it('never emits a standalone block for a tool row, even without a parent', () => {
    const orphan = msg({ id: 'r1', role: 'tool', tool_call_id: 'c9', content: '{}' });
    expect(buildMessageBlocks([orphan])).toEqual([]);
  });

  it('does not mutate the store-owned assistant row when narrowing tool_calls', () => {
    const calls = [call('c1', 'update_title', '{"title":"T"}'), call('c2', 'web_search')];
    const a = msg({ id: 'a1', tool_calls: calls });
    const blocks = buildMessageBlocks([a]);
    // The original row keeps both calls; the narrowed copy drops the
    // hidden update_title one.
    expect(a.tool_calls).toHaveLength(2);
    const group = blocks.find((b) => b.kind === 'tool-group');
    if (!group || group.kind !== 'tool-group') throw new Error('expected tool-group');
    expect(group.assistant.tool_calls).toEqual([calls[1]]);
  });
});

describe('buildMessageBlocks - recovery-row hiding', () => {
  it('hides a synthetic recovery assistant row (marker in content)', () => {
    const u = msg({ id: 'u1', role: 'user', content: 'hi' });
    const recovery = msg({
      id: 'recovery-a-1',
      content: `*(The previous response was interrupted before I finished. Picking up from here.)*\n\n${RECOVERY_MARKER}`,
    });
    expect(buildMessageBlocks([u, recovery])).toEqual([
      { kind: 'plain', message: u },
    ]);
  });

  it('hides a persisted recovery row the same way (substring test covers both shapes)', () => {
    // A persisted recovery row is a normal DB row whose content still
    // carries the marker - no synthetic flag to key on.
    const persisted = msg({ id: 'db-row', content: `note ${RECOVERY_MARKER}` });
    expect(buildMessageBlocks([persisted])).toEqual([]);
  });

  it('hides a recovery row regardless of role', () => {
    const u = msg({ id: 'u1', role: 'user', content: `hi ${RECOVERY_MARKER}` });
    expect(buildMessageBlocks([u])).toEqual([]);
  });

  it('keeps legitimate rows that do not carry the marker', () => {
    const a = msg({ id: 'a1', content: 'a normal reply about recovery' });
    expect(buildMessageBlocks([a])).toHaveLength(1);
  });

  it('hides a recovery row without disturbing the blocks around it', () => {
    const u = msg({ id: 'u1', role: 'user', content: 'go' });
    const a = msg({ id: 'a1', tool_calls: [call('c1', 'web_search')] });
    const r = msg({ id: 'r1', role: 'tool', tool_call_id: 'c1', content: '{"e":1}' });
    const recovery = msg({ id: 'rec', content: `x ${RECOVERY_MARKER}` });
    const u2 = msg({ id: 'u2', role: 'user', content: 'next' });
    const kinds = buildMessageBlocks([u, a, r, recovery, u2]).map((b) => b.kind);
    expect(kinds).toEqual(['plain', 'tool-group', 'plain']);
  });
});

describe('buildMessageBlocks - draft-row hiding', () => {
  it('hides a draft user row at the tail', () => {
    const u = msg({ id: 'u1', role: 'user', content: 'hi' });
    const a = msg({ id: 'a1', content: 'hello' });
    const draft = msg({ id: 'd1', role: 'user', content: 'edited text', status: 'draft' });
    expect(buildMessageBlocks([u, a, draft])).toEqual([
      { kind: 'plain', message: u },
      { kind: 'plain', message: a },
    ]);
  });

  it('hides a draft row without disturbing the blocks around it', () => {
    const u = msg({ id: 'u1', role: 'user', content: 'go' });
    const a = msg({ id: 'a1', content: 'reply' });
    const draft = msg({ id: 'd1', role: 'user', content: 'pending edit', status: 'draft' });
    const u2 = msg({ id: 'u2', role: 'user', content: 'after' });
    // A draft should always be the last row (the invariant), but the
    // filter should still work if a draft appears mid-conversation.
    const kinds = buildMessageBlocks([u, a, draft, u2]).map((b) => b.kind);
    expect(kinds).toEqual(['plain', 'plain', 'plain']);
  });

  it('keeps a normal user row with status=null', () => {
    const u = msg({ id: 'u1', role: 'user', content: 'hi', status: null });
    expect(buildMessageBlocks([u])).toHaveLength(1);
  });

  it('hides a draft even when the content is empty', () => {
    const draft = msg({ id: 'd1', role: 'user', content: '', status: 'draft' });
    expect(buildMessageBlocks([draft])).toEqual([]);
  });
});

describe('buildMessageBlocks - hidden tools', () => {
  it('drops an all-hidden turn with no body entirely', () => {
    const a = msg({
      id: 'a1',
      content: '',
      tool_calls: [call('c1', 'update_title', '{"title":""}')],
    });
    expect(buildMessageBlocks([a])).toEqual([]);
  });

  it('demotes an all-hidden turn with body text to a plain block', () => {
    const a = msg({
      id: 'a1',
      content: 'renamed it for you',
      tool_calls: [call('c1', 'update_title', '{"title":"New"}')],
    });
    const kinds = buildMessageBlocks([a]).map((b) => b.kind);
    expect(kinds).toEqual(['plain', 'rename']);
  });

  it('renders visible calls in a tool-group while filtering the hidden siblings', () => {
    const a = msg({
      id: 'a1',
      tool_calls: [
        call('c1', 'update_title', '{"title":"New"}'),
        call('c2', 'web_search'),
      ],
    });
    const blocks = buildMessageBlocks([a]);
    expect(blocks.map((b) => b.kind)).toEqual(['tool-group', 'rename']);
    const group = blocks[0];
    if (group.kind !== 'tool-group') throw new Error('expected tool-group');
    expect(group.assistant.tool_calls?.map((c) => c.function.name)).toEqual([
      'web_search',
    ]);
  });

  it('does NOT hide toggle_toolbox - it renders as a normal tool card', () => {
    const a = msg({ id: 'a1', tool_calls: [call('c1', 'toggle_toolbox')] });
    expect(buildMessageBlocks([a]).map((b) => b.kind)).toEqual(['tool-group']);
  });
});

describe('buildMessageBlocks - rename blocks', () => {
  it('prefers the persisted tool-result title over the call args', () => {
    const a = msg({
      id: 'a1',
      tool_calls: [call('c1', 'update_title', '{"title":"From Args"}')],
    });
    const r = msg({
      id: 'r1',
      role: 'tool',
      tool_call_id: 'c1',
      content: '{"title":"From Result"}',
    });
    const blocks = buildMessageBlocks([a, r]);
    expect(blocks).toEqual([
      { kind: 'rename', key: 'c1', assistantId: 'a1', title: 'From Result' },
    ]);
  });

  it('falls back to the call args when the result has not landed', () => {
    const a = msg({
      id: 'a1',
      tool_calls: [call('c1', 'update_title', '{"title":"From Args"}')],
    });
    const [block] = buildMessageBlocks([a]);
    if (block.kind !== 'rename') throw new Error('expected rename');
    expect(block.title).toBe('From Args');
  });

  it('falls back to the call args when the result is malformed or empty', () => {
    const a = msg({
      id: 'a1',
      tool_calls: [call('c1', 'update_title', '{"title":"From Args"}')],
    });
    const junk = msg({ id: 'r1', role: 'tool', tool_call_id: 'c1', content: 'not json' });
    const empty = msg({
      id: 'r2',
      role: 'tool',
      tool_call_id: 'c1',
      content: '{"title":"   "}',
    });
    for (const result of [junk, empty]) {
      const [block] = buildMessageBlocks([a, result]);
      if (block.kind !== 'rename') throw new Error('expected rename');
      expect(block.title).toBe('From Args');
    }
  });

  it('skips the rename block entirely when neither source yields a title', () => {
    const a = msg({
      id: 'a1',
      tool_calls: [call('c1', 'update_title', 'not json either')],
    });
    expect(buildMessageBlocks([a])).toEqual([]);
  });
});

describe('buildMessageBlocks - generated-image blocks', () => {
  it('emits one image card per successful generate_image call, after the tool-group', () => {
    const a = msg({ id: 'a1', tool_calls: [call('c1', 'generate_image')] });
    const r = msg({
      id: 'r1',
      role: 'tool',
      tool_call_id: 'c1',
      content: JSON.stringify({ filename: 'pic.webp', width: 16, height: 9 }),
    });
    const blocks = buildMessageBlocks([a, r]);
    expect(blocks.map((b) => b.kind)).toEqual(['tool-group', 'generated-image']);
    const img = blocks[1];
    if (img.kind !== 'generated-image') throw new Error('expected image block');
    expect(img).toEqual({
      kind: 'generated-image',
      key: 'c1',
      assistantId: 'a1',
      filename: 'pic.webp',
      aspectRatio: '16 / 9',
    });
  });

  it('skips the card for a failed or still-in-flight generation', () => {
    const a = msg({ id: 'a1', tool_calls: [call('c1', 'generate_image')] });
    const failed = msg({
      id: 'r1',
      role: 'tool',
      tool_call_id: 'c1',
      content: '{"error":"nope"}',
    });
    expect(buildMessageBlocks([a, failed]).map((b) => b.kind)).toEqual(['tool-group']);
    expect(buildMessageBlocks([a]).map((b) => b.kind)).toEqual(['tool-group']);
  });
});

describe('buildMessageBlocks - ask-user blocks', () => {
  function askTurn(resultContent: string | null): Message[] {
    const a = msg({ id: 'a1', tool_calls: [call('c1', 'ask_user', ASK_ARGS)] });
    if (resultContent === null) return [a];
    const r = msg({ id: 'r1', role: 'tool', tool_call_id: 'c1', content: resultContent });
    return [a, r];
  }

  it('renders a pending card from the persisted sentinel', () => {
    const blocks = buildMessageBlocks(askTurn(PENDING_CONTENT));
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block.kind !== 'ask-user') throw new Error('expected ask-user');
    expect(block.state).toBe('pending');
    expect(block.question).toBe('Which one?');
    expect(block.options).toHaveLength(2);
    expect(block.answeredContent).toBeNull();
  });

  it('renders an answered card for option and free_form answers', () => {
    for (const via of ['option', 'free_form']) {
      const answered = JSON.stringify({
        [ASK_USER_ANSWERED_FLAG]: true,
        answer: 'A',
        via,
      });
      const [block] = buildMessageBlocks(askTurn(answered));
      if (block.kind !== 'ask-user') throw new Error('expected ask-user');
      expect(block.state).toBe('answered');
      expect(block.answeredContent?.answer).toBe('A');
      // The question survives from the call args - the answer
      // envelope doesn't echo it.
      expect(block.question).toBe('Which one?');
    }
  });

  it('renders an abandoned card for every abandonment via', () => {
    for (const via of [
      'abandoned_on_refresh',
      'abandoned_on_new_send',
      'cancelled_by_sibling_ask_user',
    ]) {
      const abandoned = JSON.stringify({
        [ASK_USER_ANSWERED_FLAG]: true,
        answer: null,
        via,
      });
      const [block] = buildMessageBlocks(askTurn(abandoned));
      if (block.kind !== 'ask-user') throw new Error('expected ask-user');
      expect(block.state).toBe('abandoned');
    }
  });

  it('skips the card while the result row has not persisted yet', () => {
    // Sub-second window between assistant-row write and tool-row
    // write: a card with no backing row would target a non-existent
    // tool_call_id on submit.
    expect(buildMessageBlocks(askTurn(null))).toEqual([]);
  });

  it('skips the card when the call args are unusable', () => {
    const a = msg({ id: 'a1', tool_calls: [call('c1', 'ask_user', 'garbage')] });
    const r = msg({ id: 'r1', role: 'tool', tool_call_id: 'c1', content: PENDING_CONTENT });
    expect(buildMessageBlocks([a, r])).toEqual([]);
  });
});

describe('findOpeningUserMessageIdForTail', () => {
  it('returns the most recent user message id', () => {
    const rows = [
      msg({ id: 'u1', role: 'user' }),
      msg({ id: 'a1' }),
      msg({ id: 'u2', role: 'user' }),
      msg({ id: 'r1', role: 'tool', tool_call_id: 'c1' }),
    ];
    expect(findOpeningUserMessageIdForTail(rows)).toBe('u2');
  });

  it('returns null for a transcript with no user rows', () => {
    expect(findOpeningUserMessageIdForTail([])).toBeNull();
    expect(findOpeningUserMessageIdForTail([msg({ id: 'a1' })])).toBeNull();
  });
});
