/**
 * Unit coverage for the `ask_user` tool.
 *
 * Three surfaces under test:
 *
 *   - The tool sits in the main chat catalog (model sees it) and is
 *     absent from agent-only toolboxes (reflection / recall / wiki
 *     agents have no UI to render to, so they must not be able to
 *     reach for it).
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
  memoryToolbox,
  recallToolbox,
  conversationRecallToolbox,
  wikiRecallToolbox,
  type ToolContext,
  type ToolDef,
} from '../src/lib/tools';
import {
  askUser,
  parseAskUserContent,
  buildAskUserAnswerContent,
  ASK_USER_PENDING_FLAG,
  ASK_USER_ANSWERED_FLAG,
} from '../src/lib/tools/ask_user';
import { askUserSchema } from '../src/lib/tools/ask_user.schema';
import type { SupabaseService } from '../src/lib/supabase';

function emptyCtx(): ToolContext {
  return {
    supabase: {} as SupabaseService,
    userId: 'u-1',
    threadId: 't-1',
    signal: new AbortController().signal,
  };
}

describe('ask_user — registry scoping', () => {
  it('is present in the main chat TOOLS list', () => {
    expect(TOOLS.map((t: ToolDef) => t.name)).toContain('ask_user');
  });

  it('is absent from agent-only toolboxes', () => {
    // None of the sub-agents have a UI surface to render a clarifying
    // question to; ask_user must stay scoped to the main chat loop.
    expect(memoryToolbox.tools.map((t) => t.name)).not.toContain('ask_user');
    expect(recallToolbox.tools.map((t) => t.name)).not.toContain('ask_user');
    expect(conversationRecallToolbox.tools.map((t) => t.name)).not.toContain(
      'ask_user'
    );
    expect(wikiRecallToolbox.tools.map((t) => t.name)).not.toContain('ask_user');
  });

  it('schema declares question and options as required', () => {
    expect(askUserSchema.parameters.required).toContain('question');
    expect(askUserSchema.parameters.required).toContain('options');
  });
});

describe('ask_user — execute()', () => {
  it('returns the pending sentinel for a valid call', async () => {
    const out = (await askUser.execute(
      {
        question: 'philosophical or pop-culture?',
        options: [
          { label: 'Philosophical', description: 'A serious answer.' },
          { label: '42', description: 'The Hitchhiker reference.' },
        ],
      },
      emptyCtx()
    )) as Record<string, unknown>;
    expect(out[ASK_USER_PENDING_FLAG]).toBe(true);
    expect(out.question).toBe('philosophical or pop-culture?');
    expect(Array.isArray(out.options)).toBe(true);
    expect((out.options as unknown[]).length).toBe(2);
  });

  it('trims question and option fields', async () => {
    const out = (await askUser.execute(
      {
        question: '   what next?   ',
        options: [
          { label: '  A  ', description: '  first  ' },
          { label: 'B', description: 'second' },
        ],
      },
      emptyCtx()
    )) as { question: string; options: { label: string; description: string }[] };
    expect(out.question).toBe('what next?');
    expect(out.options[0].label).toBe('A');
    expect(out.options[0].description).toBe('first');
  });

  it('rejects an empty question', async () => {
    await expect(
      askUser.execute(
        {
          question: '   ',
          options: [
            { label: 'A', description: 'a' },
            { label: 'B', description: 'b' },
          ],
        },
        emptyCtx()
      )
    ).rejects.toThrow(/question is required/);
  });

  it('rejects fewer than two valid options', async () => {
    await expect(
      askUser.execute(
        { question: 'q', options: [{ label: 'only', description: 'one' }] },
        emptyCtx()
      )
    ).rejects.toThrow(/at least 2 options/);
  });

  it('drops options missing label or description before counting', async () => {
    await expect(
      askUser.execute(
        {
          question: 'q',
          options: [
            { label: 'A', description: '' },
            { label: '', description: 'b' },
            { label: 'C', description: 'c' },
          ],
        },
        emptyCtx()
      )
    ).rejects.toThrow(/at least 2 options/);
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
