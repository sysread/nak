/**
 * Tests for streamChatWithGuards - the generic output-guard retry
 * wrapper. Drives it directly (via the __test hook) with a fake Venice
 * client whose streamChat yields a configurable event list per call, so
 * the buffering / discard / re-roll / cap behavior is exercised without
 * a full runChatLoop fixture.
 */
import { describe, it, expect, vi } from 'vitest';
import { __test } from '../src/lib/chat-loop';
import { specialTokenLeakGuard, GuardExhaustedError } from '../src/lib/stream-guards';
import type {
  VeniceClient,
  ChatRequest,
  StreamEvent,
} from '../src/lib/venice';

const { streamChatWithGuards } = __test;

/**
 * Fake Venice whose streamChat yields the next configured event list on
 * each call (one list per attempt). Records the temperature seen on
 * each call so retry-temperature behavior can be asserted.
 */
function fakeVenice(perAttempt: StreamEvent[][]): {
  venice: VeniceClient;
  temps: (number | undefined)[];
  calls: () => number;
} {
  let i = 0;
  const temps: (number | undefined)[] = [];
  const venice = {
    async *streamChat(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
      temps.push(req.temperature);
      const events = perAttempt[Math.min(i, perAttempt.length - 1)];
      i += 1;
      for (const ev of events) yield ev;
    },
  } as unknown as VeniceClient;
  return { venice, temps, calls: () => i };
}

function req(): ChatRequest {
  return { model: 'deepseek-v4-flash', messages: [], signal: new AbortController().signal };
}

async function collect(
  gen: AsyncGenerator<StreamEvent, void, void>
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const text = (delta: string): StreamEvent => ({ type: 'text', delta });

describe('streamChatWithGuards', () => {
  it('passes a healthy first attempt straight through with no retry', async () => {
    const { venice, calls } = fakeVenice([[text('Hello '), text('world')]]);
    const onGuardRetry = vi.fn();
    const out = await collect(
      streamChatWithGuards(venice, req(), { onGuardRetry }, [specialTokenLeakGuard()])
    );
    expect(out).toEqual([text('Hello '), text('world')]);
    expect(onGuardRetry).not.toHaveBeenCalled();
    expect(calls()).toBe(1);
  });

  it('discards a leak attempt, re-rolls, and bumps the temperature', async () => {
    const { venice, temps } = fakeVenice([
      [text('<｜begin▁of▁sentence｜>')], // leak: opens with the token
      [text('Real answer')],
    ]);
    const onGuardRetry = vi.fn();
    const out = await collect(
      streamChatWithGuards(venice, req(), { onGuardRetry }, [specialTokenLeakGuard()])
    );
    expect(out).toEqual([text('Real answer')]);
    expect(onGuardRetry).toHaveBeenCalledTimes(1);
    expect(onGuardRetry).toHaveBeenCalledWith({ guard: 'special-token-leak', attempt: 1 });
    // First attempt at the caller's (unset) temperature; the re-roll
    // forced to the schedule's first step.
    expect(temps[0]).toBeUndefined();
    expect(temps[1]).toBe(0.8);
  });

  it('keeps an empty completion rather than re-rolling it', async () => {
    // Without a server-side stop, an empty completion is not a leak -
    // it passes through untouched.
    const { venice, calls } = fakeVenice([[], [text('unreached')]]);
    const onGuardRetry = vi.fn();
    const out = await collect(
      streamChatWithGuards(venice, req(), { onGuardRetry }, [specialTokenLeakGuard()])
    );
    expect(out).toEqual([]);
    expect(onGuardRetry).not.toHaveBeenCalled();
    expect(calls()).toBe(1);
  });

  it('discards a leak that streamed as text without forwarding the junk', async () => {
    const { venice } = fakeVenice([
      [text('<｜begin▁of▁sentence｜>'), text('package main')], // leak streamed through
      [text('The real reply')],
    ]);
    const onGuardRetry = vi.fn();
    const out = await collect(
      streamChatWithGuards(venice, req(), { onGuardRetry }, [specialTokenLeakGuard()])
    );
    expect(out).toEqual([text('The real reply')]);
    // The leaked Go preamble must never reach the consumer.
    expect(out.some((e) => e.type === 'text' && e.delta.includes('package main'))).toBe(false);
    expect(onGuardRetry).toHaveBeenCalledTimes(1);
  });

  it('reassembles a leak prefix split across deltas', async () => {
    const { venice } = fakeVenice([
      [text('<'), text('｜begin｜'), text(' junk')], // "<" then the wide pipe
      [text('ok')],
    ]);
    const out = await collect(
      streamChatWithGuards(venice, req(), {}, [specialTokenLeakGuard()])
    );
    expect(out).toEqual([text('ok')]);
  });

  it('throws GuardExhaustedError after the retry cap', async () => {
    // Every attempt leaks (opens with the token). 1 initial + 2 retries
    // = 3 attempts, then exhaustion.
    const { venice, calls } = fakeVenice([[text('<｜begin▁of▁sentence｜>')]]);
    const onGuardRetry = vi.fn();
    await expect(
      collect(streamChatWithGuards(venice, req(), { onGuardRetry }, [specialTokenLeakGuard()]))
    ).rejects.toBeInstanceOf(GuardExhaustedError);
    expect(onGuardRetry).toHaveBeenCalledTimes(2);
    expect(calls()).toBe(3);
  });

  it('is a transparent pass-through when no guards are armed', async () => {
    const { venice, calls } = fakeVenice([[], [text('should not be reached')]]);
    const onGuardRetry = vi.fn();
    // Empty completion + no guards: forwarded as-is (empty), no retry.
    const out = await collect(streamChatWithGuards(venice, req(), { onGuardRetry }, []));
    expect(out).toEqual([]);
    expect(onGuardRetry).not.toHaveBeenCalled();
    expect(calls()).toBe(1);
  });
});
