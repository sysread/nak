/**
 * Unit coverage for the `ask_user` tool.
 *
 * Three surfaces under test:
 *
 *   - The tool sits in the main chat catalog (model sees it) and is
 *     absent from agent-only toolboxes (the background wiki /
 *     memory-librarian agents have no UI to render to, so they must
 *     not be able to reach for it).
 *   - `execute()` validates arguments and returns the pending sentinel
 *     shape the chat-loop's suspend path expects.
 *   - The content-parse helpers round-trip both sentinel and answered
 *     payloads cleanly, and reject malformed or unrelated content.
 *
 * Higher-level integration (suspend, persist, resume) is covered in
 * chat-loop.test.ts; the goal here is the tool surface itself.
 */
import { describe, it, expect } from 'vitest';
import {
  TOOLS,
  type ToolDef,
} from '../src/lib/tools';
import {
  parseAskUserContent,
  parseAskUserCallArgs,
  findPendingAskUserRow,
  buildAskUserAnswerContent,
  ASK_USER_PENDING_FLAG,
  ASK_USER_ANSWERED_FLAG,
} from '../src/lib/ask-user';
import { askUserSchema } from '../src/lib/tools/ask_user.schema';
import type { Message } from '../src/lib/supabase';

describe('ask_user — registry scoping', () => {
  it('is present in the main chat TOOLS list', () => {
    expect(TOOLS.map((t: ToolDef) => t.name)).toContain('ask_user');
  });

  // The agent-only exclusion (background agents have no UI surface to
  // render a clarifying question to) is asserted server-side where the
  // agent toolboxes live now: supabase/functions/tests/
  // {reflection,wiki,wiki_librarian,memory_librarian}.test.ts.

  it('schema declares question and options as required', () => {
    expect(askUserSchema.parameters.required).toContain('question');
    expect(askUserSchema.parameters.required).toContain('options');
  });
});

describe('ask_user — content parser', () => {
  it('parses a pending sentinel', () => {
    const content = JSON.stringify({
      [ASK_USER_PENDING_FLAG]: true,
      question: 'what?',
      options: [{ label: 'A', description: 'a' }],
    });
    const parsed = parseAskUserContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed && ASK_USER_PENDING_FLAG in parsed).toBe(true);
  });

  it('parses an answered envelope and preserves option_index', () => {
    const content = buildAskUserAnswerContent('B', 'option', 1);
    const parsed = parseAskUserContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed && ASK_USER_ANSWERED_FLAG in parsed).toBe(true);
    if (parsed && ASK_USER_ANSWERED_FLAG in parsed) {
      expect(parsed.answer).toBe('B');
      expect(parsed.via).toBe('option');
      expect(parsed.option_index).toBe(1);
    }
  });

  it('parses abandoned-on-refresh shape with null answer', () => {
    const content = buildAskUserAnswerContent(null, 'abandoned_on_refresh');
    const parsed = parseAskUserContent(content);
    expect(parsed).not.toBeNull();
    if (parsed && ASK_USER_ANSWERED_FLAG in parsed) {
      expect(parsed.answer).toBeNull();
      expect(parsed.via).toBe('abandoned_on_refresh');
    }
  });

  it('returns null on unrelated tool result JSON', () => {
    // A regular tool result like memory_search's row array should not
    // sniff as an ask_user surface.
    expect(parseAskUserContent(JSON.stringify({ rows: [] }))).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(parseAskUserContent('{not json')).toBeNull();
    expect(parseAskUserContent('null')).toBeNull();
    expect(parseAskUserContent('"a string"')).toBeNull();
  });

  it('rejects a sentinel with no options', () => {
    const content = JSON.stringify({
      [ASK_USER_PENDING_FLAG]: true,
      question: 'no options',
      options: [],
    });
    expect(parseAskUserContent(content)).toBeNull();
  });
});

describe('ask_user — call-args parser (transcript render gate)', () => {
  it('parses and trims a well-formed call', () => {
    const raw = JSON.stringify({
      question: '  Which one?  ',
      options: [
        { label: ' A ', description: ' first ' },
        { label: 'B', description: 'second' },
      ],
    });
    expect(parseAskUserCallArgs(raw)).toEqual({
      question: 'Which one?',
      options: [
        { label: 'A', description: 'first' },
        { label: 'B', description: 'second' },
      ],
    });
  });

  it('drops junk option entries but keeps the valid ones', () => {
    const raw = JSON.stringify({
      question: 'Q',
      options: [
        null,
        { label: 'A' },
        { label: '  ', description: 'blank label' },
        { label: 'B', description: 'ok' },
      ],
    });
    expect(parseAskUserCallArgs(raw)?.options).toEqual([{ label: 'B', description: 'ok' }]);
  });

  it('returns null when the args are unusable (unlike the lenient in-flight extractor)', () => {
    expect(parseAskUserCallArgs('not json')).toBeNull();
    expect(parseAskUserCallArgs('')).toBeNull();
    expect(parseAskUserCallArgs(JSON.stringify({ options: [] }))).toBeNull();
    expect(
      parseAskUserCallArgs(JSON.stringify({ question: 'Q', options: [] }))
    ).toBeNull();
  });
});

describe('ask_user — pending-row lookup', () => {
  function toolRow(over: Partial<Message>): Message {
    return {
      id: 'r1',
      thread_id: 't1',
      role: 'tool',
      content: '',
      created_at: '2024-01-01T00:00:00Z',
      tool_call_id: 'c1',
      ...over,
    } as Message;
  }
  const pendingContent = JSON.stringify({
    [ASK_USER_PENDING_FLAG]: true,
    question: 'which?',
    options: [{ label: 'A', description: 'a' }],
  });

  it('finds the pending sentinel row and projects its call id + question', () => {
    const pending = toolRow({ id: 'r2', tool_call_id: 'c2', content: pendingContent });
    const rows: Message[] = [
      toolRow({ id: 'r1', content: '{"unrelated":true}' }),
      pending,
    ];
    expect(findPendingAskUserRow(rows)).toEqual({
      row: pending,
      toolCallId: 'c2',
      question: 'which?',
    });
  });

  it('ignores answered sentinels and non-tool rows', () => {
    const rows: Message[] = [
      toolRow({ id: 'r1', content: buildAskUserAnswerContent('A', 'option', 0) }),
      toolRow({ id: 'u1', role: 'user', content: pendingContent, tool_call_id: null }),
    ];
    expect(findPendingAskUserRow(rows)).toBeNull();
    expect(findPendingAskUserRow([])).toBeNull();
  });
});
