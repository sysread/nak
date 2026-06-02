/**
 * Unit coverage for the conversation_get tool - the conversation-layer
 * counterpart to wiki_get. Verifies the not-found shape, the found
 * shape (title/summary/transcript), that tool-call and empty rows are
 * dropped from the transcript, and that a long thread is windowed to
 * the most recent messages with truncated:true.
 */
import { describe, it, expect, vi } from 'vitest';
import { conversationGet } from '../src/lib/tools/conversation_get';
import { alwaysOnToolbox, type ToolContext } from '../src/lib/tools';
import type {
  SupabaseService,
  Message,
  ThreadSummaryRow,
} from '../src/lib/supabase';

function ctxFor(svc: SupabaseService): ToolContext {
  return {
    supabase: svc,
    userId: 'u-1',
    threadId: 't-current',
    signal: new AbortController().signal,
  };
}

function summary(overrides: Partial<ThreadSummaryRow> = {}): ThreadSummaryRow {
  return {
    id: 'c1',
    title: 'Parser pipeline design',
    summary: 'We landed on a streaming parser.',
    archived: false,
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function msg(role: Message['role'], content: string, n: number): Message {
  return {
    id: `m-${n}`,
    thread_id: 'c1',
    role,
    content,
    created_at: String(n),
  } as Message;
}

function svc(opts: {
  summaries?: ThreadSummaryRow[];
  messages?: Message[];
}): SupabaseService {
  return {
    listThreadSummariesByIds: vi.fn(async () => opts.summaries ?? []),
    listMessages: vi.fn(async () => opts.messages ?? []),
  } as unknown as SupabaseService;
}

describe('conversation_get', () => {
  it('is registered in the always-on toolbox', () => {
    expect(alwaysOnToolbox.tools.map((t) => t.name)).toContain('conversation_get');
  });

  it('throws when called without an id', async () => {
    await expect(
      conversationGet.execute({}, ctxFor(svc({})))
    ).rejects.toThrow(/id is required/);
  });

  it('returns {found:false} when the id is unknown or not the user\'s', async () => {
    const result = await conversationGet.execute(
      { id: 'missing' },
      ctxFor(svc({ summaries: [] }))
    );
    expect(result).toEqual({ found: false });
  });

  it('returns title, summary, and the transcript when found', async () => {
    const service = svc({
      summaries: [summary()],
      messages: [
        msg('user', 'how should we structure the parser?', 1),
        msg('assistant', 'a streaming design fits best', 2),
      ],
    });
    const result = (await conversationGet.execute(
      { id: 'c1' },
      ctxFor(service)
    )) as { found: true; conversation: Record<string, unknown> };

    expect(result.found).toBe(true);
    expect(result.conversation).toMatchObject({
      id: 'c1',
      title: 'Parser pipeline design',
      summary: 'We landed on a streaming parser.',
      archived: false,
      truncated: false,
      messages: [
        { role: 'user', content: 'how should we structure the parser?' },
        { role: 'assistant', content: 'a streaming design fits best' },
      ],
    });
  });

  it('drops tool-call rows and empty assistant rows from the transcript', async () => {
    const service = svc({
      summaries: [summary()],
      messages: [
        msg('user', 'do the search', 1),
        msg('assistant', '', 2), // tool_calls-only row
        msg('tool', '{"result":"..."}', 3), // tool result row
        msg('assistant', 'here is what I found', 4),
      ],
    });
    const result = (await conversationGet.execute(
      { id: 'c1' },
      ctxFor(service)
    )) as { found: true; conversation: { messages: unknown[] } };

    expect(result.conversation.messages).toEqual([
      { role: 'user', content: 'do the search' },
      { role: 'assistant', content: 'here is what I found' },
    ]);
  });

  it('windows a long thread to the most recent messages with truncated:true', async () => {
    // Each message ~2000 chars; the 12000-char budget keeps only the
    // most recent handful, dropping the oldest.
    const big = 'x'.repeat(2000);
    const messages: Message[] = Array.from({ length: 12 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', `${i}-${big}`, i)
    );
    const service = svc({ summaries: [summary()], messages });
    const result = (await conversationGet.execute(
      { id: 'c1' },
      ctxFor(service)
    )) as { found: true; conversation: { truncated: boolean; messages: { content: string }[] } };

    expect(result.conversation.truncated).toBe(true);
    expect(result.conversation.messages.length).toBeLessThan(12);
    // The most recent message survived; the oldest did not.
    const contents = result.conversation.messages.map((m) => m.content);
    expect(contents.some((c) => c.startsWith('11-'))).toBe(true);
    expect(contents.some((c) => c.startsWith('0-'))).toBe(false);
  });
});
