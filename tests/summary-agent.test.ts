/**
 * Coverage for the summary agent's logic layer. Mirrors
 * `reflection-agent.test.ts` — the worker scaffold is exercised
 * elsewhere; these tests pin the pure behaviour: slicing the
 * conversation at `terminalMsgId`, producing a trimmed summary, and
 * returning the right stopped-reason under abort / empty-thread /
 * model-refusal conditions.
 */
import { describe, it, expect, vi } from 'vitest';
import { SummaryAgent } from '../src/lib/agents/summary/agent';
import type { SupabaseService, Message } from '../src/lib/supabase';
import type { VeniceClient } from '../src/lib/venice';

function msg(id: string, role: Message['role'], content: string): Message {
  return {
    id,
    thread_id: 't-1',
    role,
    content,
    created_at: new Date().toISOString(),
  };
}

function mockVeniceWithText(text: string) {
  return {
    async *streamChat() {
      // Emit the text in two fragments so the test exercises the
      // delta-accumulation path rather than a single-chunk shortcut.
      const half = Math.ceil(text.length / 2);
      yield { type: 'text' as const, delta: text.slice(0, half) };
      yield { type: 'text' as const, delta: text.slice(half) };
    },
  } as unknown as VeniceClient;
}

function mockSupabaseWithMessages(messages: Message[]) {
  return {
    listMessages: vi.fn(async (_threadId: string) => messages),
  } as unknown as SupabaseService;
}

describe('SummaryAgent', () => {
  it('stops with "aborted" when the caller\'s signal is already aborted', async () => {
    const supabase = mockSupabaseWithMessages([]);
    const venice = mockVeniceWithText('');
    const agent = new SummaryAgent(venice, supabase, 'fast-model');
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

  it('returns done with an empty summary for an empty thread (no Venice call)', async () => {
    const supabase = mockSupabaseWithMessages([]);
    const venice = mockVeniceWithText('should not fire');
    const spy = vi.spyOn(venice, 'streamChat');
    const agent = new SummaryAgent(venice, supabase, 'fast-model');
    const result = await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'm-1' },
      userId: 'u-1',
    });
    expect(result.stoppedReason).toBe('done');
    expect(result.output.summary).toBe('');
    expect(result.output.inputMessageCount).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('slices at terminalMsgId so mid-run user additions queue for the next cycle', async () => {
    const messages = [
      msg('m-1', 'user', 'question'),
      msg('m-2', 'assistant', 'answer'),
      msg('m-3', 'user', 'follow-up — added after the claim'),
    ];
    const supabase = mockSupabaseWithMessages(messages);
    const venice = mockVeniceWithText('A short summary of the exchange.');
    const agent = new SummaryAgent(venice, supabase, 'fast-model');
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
    const supabase = mockSupabaseWithMessages([
      msg('m-1', 'user', 'hi'),
      msg('m-2', 'assistant', 'hello'),
    ]);
    const venice = mockVeniceWithText('  "A terse summary."\n');
    const agent = new SummaryAgent(venice, supabase, 'fast-model');
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
    const supabase = mockSupabaseWithMessages([
      msg('m-1', 'user', 'hi'),
      msg('m-2', 'assistant', 'hello'),
    ]);
    const venice = mockVeniceWithText('    \n\n  ');
    const agent = new SummaryAgent(venice, supabase, 'fast-model');
    const result = await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'm-2' },
      userId: 'u-1',
    });
    expect(result.stoppedReason).toBe('done');
    expect(result.output.summary).toBe('');
  });

  it('surfaces errors thrown inside the Venice stream as stoppedReason=error', async () => {
    const supabase = mockSupabaseWithMessages([
      msg('m-1', 'user', 'hi'),
      msg('m-2', 'assistant', 'hello'),
    ]);
    const venice = {
      async *streamChat() {
        throw new Error('venice exploded');
      },
    } as unknown as VeniceClient;
    const agent = new SummaryAgent(venice, supabase, 'fast-model');
    const result = await agent.run({
      input: { threadId: 't-1', terminalMsgId: 'm-2' },
      userId: 'u-1',
    });
    expect(result.stoppedReason).toBe('error');
    expect(result.error).toBe('venice exploded');
  });
});
