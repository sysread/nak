/**
 * Unit tests for the stream-transport's subscribe-with-retry wrapper -
 * the join-rescue loop that turns a dead realtime join (TIMED_OUT,
 * CHANNEL_ERROR, or a queued-join hang) into a bounded retry with a
 * fresh socket instead of a hard exchange failure.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { VeniceError } from '../src/lib/venice';
import { __test } from '../src/lib/chat/stream-transport';

const { subscribeStreamWithRetry } = __test;

type SubscribeStatus =
  | 'SUBSCRIBED'
  | 'TIMED_OUT'
  | 'CHANNEL_ERROR'
  | 'CLOSED';

interface FakeChannelSpec {
  status?: SubscribeStatus;
  /** Script the subscribe callback to never fire (queued-join hang). */
  neverFire?: boolean;
}

interface ProbeHooks {
  disconnect?: ReturnType<typeof vi.fn<() => Promise<'ok'>>>;
  connect?: ReturnType<typeof vi.fn>;
}

interface Probe {
  client: SupabaseClient;
  channels: { unsubscribe: ReturnType<typeof vi.fn> }[];
}

const PROBE_OPTS = { probeInFlight: async () => ({ kind: 'settled' as const }) };

/** One fake channel per attempt, driven by the script in order. */
function makeProbe(
  script: FakeChannelSpec[],
  hooks?: ProbeHooks,
): Probe {
  const channels: { unsubscribe: ReturnType<typeof vi.fn> }[] = [];
  const specs = [...script];
  const client = {
    channel: () => {
      const spec = specs.shift() ?? { status: 'SUBSCRIBED' };
      const channel = {
        on: () => channel,
        subscribe: (cb: (status: string) => void) => {
          if (spec.neverFire) return channel;
          cb(spec.status ?? 'SUBSCRIBED');
          return channel;
        },
        unsubscribe: vi.fn(async () => 'ok'),
      };
      channels.push(channel);
      return channel;
    },
    realtime: {
      disconnect: hooks?.disconnect ?? vi.fn(async () => 'ok'),
      connect: hooks?.connect ?? vi.fn(() => {}),
    },
  } as unknown as SupabaseClient;
  return { client, channels };
}

describe('subscribeStreamWithRetry', () => {
  it('returns the first attempt when the join succeeds', async () => {
    const probe = makeProbe([{ status: 'SUBSCRIBED' }]);
    const sub = await subscribeStreamWithRetry(
      probe.client,
      'stream:x',
      PROBE_OPTS,
    );
    expect(probe.channels.length).toBe(1);
    expect(sub.drain).toBeTypeOf('function');
  });

  it('retries once on TIMED_OUT with a socket nudge and succeeds', async () => {
    const disconnect = vi.fn(async () => 'ok' as const);
    const connect = vi.fn();
    const probe = makeProbe(
      [{ status: 'TIMED_OUT' }, { status: 'SUBSCRIBED' }],
      { disconnect, connect },
    );
    const sub = await subscribeStreamWithRetry(
      probe.client,
      'stream:t',
      PROBE_OPTS,
    );
    expect(probe.channels.length).toBe(2);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(sub.drain).toBeTypeOf('function');
  });

  it('tears down the failed attempt before retrying', async () => {
    const probe = makeProbe([
      { status: 'TIMED_OUT' },
      { status: 'SUBSCRIBED' },
    ]);
    await subscribeStreamWithRetry(probe.client, 'stream:t', PROBE_OPTS);
    // Only the failed attempt is unsubscribed; the working one stays.
    expect(probe.channels[0].unsubscribe).toHaveBeenCalledTimes(1);
    expect(probe.channels[1].unsubscribe).not.toHaveBeenCalled();
  });

  it('throws a kind-network VeniceError after both attempts fail', async () => {
    const probe = makeProbe([
      { status: 'TIMED_OUT' },
      { status: 'CHANNEL_ERROR' },
    ]);
    const err: unknown = await subscribeStreamWithRetry(
      probe.client,
      'stream:t',
      PROBE_OPTS,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VeniceError);
    expect((err as VeniceError).kind).toBe('network');
    expect((err as Error).message).toContain('CHANNEL_ERROR');
  });

  it('rescues a hanging join via the attempt bound', async () => {
    // Attempt 1 never fires any status (join queued on a dead socket);
    // attempt 2 subscribes cleanly. The bound must convert the hang
    // into a retry instead of waiting forever.
    const probe = makeProbe([
      { neverFire: true },
      { status: 'SUBSCRIBED' },
    ]);
    const sub = await subscribeStreamWithRetry(
      probe.client,
      'stream:t',
      PROBE_OPTS,
      50,
    );
    expect(probe.channels.length).toBe(2);
    expect(sub.drain).toBeTypeOf('function');
  });

  it('gives up after the bound exhausts both attempts', async () => {
    const probe = makeProbe([{ neverFire: true }, { neverFire: true }]);
    const err: unknown = await subscribeStreamWithRetry(
      probe.client,
      'stream:t',
      PROBE_OPTS,
      50,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VeniceError);
    expect((err as VeniceError).kind).toBe('network');
    expect(probe.channels.length).toBe(2);
  });
});

interface FakeChannelSpec {
  status?: SubscribeStatus;
  neverFire?: boolean;
}
