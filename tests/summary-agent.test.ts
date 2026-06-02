/**
 * Coverage for the summary agent's logic layer. Mirrors
 * `reflection-agent.test.ts` — the worker scaffold is exercised
 * elsewhere; these tests pin the pure behaviour: slicing the
 * conversation at `terminalMsgId`, producing a trimmed summary, and
 * returning the right stopped-reason under abort / empty-thread /
 * model-refusal conditions.
 *
 * The chat-completion seam is `SupabaseService.complete` (the
 * venice/complete edge function). Tests script the per-round
 * completion through the supabase fixture; there's no separate Venice
 * handle after the supervisor-fleet sweep.
 */
import { describe, it, expect, vi } from 'vitest';
import { SummaryAgent } from '../src/lib/agents/summary/agent';
import type { SupabaseService, Message } from '../src/lib/supabase';

function msg(id: string, role: Message['role'], content: string): Message {
  return {
    id,
    thread_id: 't-1',
    role,
    content,
    created_at: new Date().toISOString(),
  };
}

function mockSupabase(
  messages: Message[],
  completeText?: string | (() => Promise<never>)
): {
  svc: SupabaseService;
  complete: ReturnType<typeof vi.fn>;
} {
  const complete = vi.fn(async () => {
    if (typeof completeText === 'function') {
      return completeText();
    }
    return {
      text: completeText ?? '',
      reasoning: '',
      toolCalls: [],
      usage: null,
      citations: [],
      finishReason: 'stop',
    };
  });
  return {
    svc: {
      listMessages: vi.fn(async (_threadId: string) => messages),
      complete,
    } as unknown as SupabaseService,
    complete,
  };
}

describe('SummaryAgent', () => {
  it('stops with "aborted" when the caller\'s signal is already aborted', async () => {
    const { svc } = mockSupabase([], '');
    const agent = new SummaryAgent(svc, 'fast-model');
    const ctl = new AbortController();
    ctl.abort();
    const result = await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'm-1' },
      userId: 'u-1',
      signal: ctl.signal,
    });
    expect(result.stoppedReason).toBe('aborted');
    expect(result.output.summary).toBe('');
  });

  it('returns done with an empty summary for an empty thread (no completion call)', async () => {
    const { svc, complete } = mockSupabase([], 'should not fire');
    const agent = new SummaryAgent(svc, 'fast-model');
    const result = await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'm-1' },
      userId: 'u-1',
    });
    expect(result.stoppedReason).toBe('done');
    expect(result.output.summary).toBe('');
    expect(result.output.inputMessageCount).toBe(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it('slices at terminalMsgId so mid-run user additions queue for the next cycle', async () => {
    const messages = [
      msg('m-1', 'user', 'question'),
      msg('m-2', 'assistant', 'answer'),
      msg('m-3', 'user', 'follow-up — added after the claim'),
    ];
    const { svc } = mockSupabase(messages, 'A short summary of the exchange.');
    const agent = new SummaryAgent(svc, 'fast-model');
    const result = await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'm-2' },
      userId: 'u-1',
    });
    expect(result.stoppedReason).toBe('done');
    // 2 messages fed in — m-3 didn't make it into the condensed history.
    expect(result.output.inputMessageCount).toBe(2);
    expect(result.output.summary).toBe('A short summary of the exchange.');
  });

  it('trims surrounding quotes and whitespace the model sometimes emits', async () => {
    const { svc } = mockSupabase(
      [msg('m-1', 'user', 'hi'), msg('m-2', 'assistant', 'hello')],
      '  "A terse summary."\n'
    );
    const agent = new SummaryAgent(svc, 'fast-model');
    const result = await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'm-2' },
      userId: 'u-1',
    });
    expect(result.output.summary).toBe('A terse summary.');
  });

  it('returns an empty summary when the model produces only whitespace', async () => {
    // The loop's empty-summary branch is what skips the save for this
    // case — the agent itself just returns "" and lets the caller
    // decide. Pinning the shape here so the contract stays stable.
    const { svc } = mockSupabase(
      [msg('m-1', 'user', 'hi'), msg('m-2', 'assistant', 'hello')],
      '    \n\n  '
    );
    const agent = new SummaryAgent(svc, 'fast-model');
    const result = await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'm-2' },
      userId: 'u-1',
    });
    expect(result.stoppedReason).toBe('done');
    expect(result.output.summary).toBe('');
  });

  it('surfaces errors thrown by supabase.complete as stoppedReason=error', async () => {
    const { svc } = mockSupabase(
      [msg('m-1', 'user', 'hi'), msg('m-2', 'assistant', 'hello')],
      async () => {
        throw new Error('venice exploded');
      }
    );
    const agent = new SummaryAgent(svc, 'fast-model');
    const result = await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'm-2' },
      userId: 'u-1',
    });
    expect(result.stoppedReason).toBe('error');
    expect(result.error).toBe('venice exploded');
  });
});
