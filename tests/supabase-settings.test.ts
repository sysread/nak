/**
 * Contract tests for the activeSessions write queue in
 * src/lib/supabase/settings.ts. The map is one top-level settings
 * key, so overlapping read-modify-write cycles converge
 * last-write-wins and a rapid tap's mark vanishes; the queue makes
 * each client's mutations strictly ordered so every mutate closure
 * sees every earlier write.
 *
 * The stub client gates the profiles read and the merge RPC on
 * deferreds the test resolves in a chosen order, and keeps a
 * server-side blob that applies each write's `activeSessions` - so
 * "the second mutate sees the first's write" is asserted against a
 * simulated server, not a mock's imagination. Gate availability is
 * polled with vi.waitFor: each mutation starts on a microtask after
 * the previous chain link settles, so gate timing must not be
 * assumed synchronous with the enqueue.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  updateActiveSessions,
} from '../src/lib/supabase/settings';
import type { UserSettings } from '../src/lib/supabase/types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface ReadGate extends Deferred<{ data: unknown; error: null }> {
  at: number;
}

interface WriteGate extends Deferred<{ data: unknown; error: null }> {
  at: number;
  set: Record<string, unknown>;
}

/**
 * Stub client whose profiles read and merge RPC are deferred gates.
 * `serverBlob` is the simulated profiles row: resolving a read gate
 * hands it to getSettings; resolving a write gate applies that
 * write's p_set.activeSessions to it, like the real RPC's merge
 * (the RPC returns the post-merge settings BLOB directly and
 * shallow-merges each top-level key wholesale).
 */
function makeStubClient() {
  let seq = 0;
  const readGates: ReadGate[] = [];
  const writeGates: WriteGate[] = [];
  let serverBlob: { settings?: Record<string, unknown> } = {};

  const client = {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { user: { id: 'u-1' } } },
        error: null,
      })),
    },
    from: vi.fn(() => {
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.maybeSingle = () => {
        const gate = { ...deferred<{ data: unknown; error: null }>(), at: ++seq };
        readGates.push(gate);
        return gate.promise;
      };
      return builder;
    }),
    rpc: vi.fn(
      (_name: string, args: { p_set: Record<string, unknown> }) => {
        const gate = {
          ...deferred<{ data: unknown; error: null }>(),
          at: ++seq,
          set: args.p_set,
        };
        writeGates.push(gate);
        return gate.promise;
      }
    ),
  } as unknown as SupabaseClient;

  function resolveRead(value: { activeSessions?: Record<string, unknown> }) {
    const gate = readGates.shift();
    if (!gate) throw new Error('no pending read');
    gate.resolve({ data: { settings: value }, error: null });
  }

  function resolveWrite(merge = true) {
    const gate = writeGates.shift();
    if (!gate) throw new Error('no pending write');
    const set = gate.set.activeSessions as Record<string, unknown> | undefined;
    if (merge && set) {
      serverBlob = { settings: { ...serverBlob.settings, activeSessions: set } };
    }
    gate.resolve({ data: serverBlob.settings, error: null });
  }

  return { client, readGates, writeGates, resolveRead, resolveWrite, serverBlob: () => serverBlob };
}

function session(startedAt = '2026-11-17T00:00:00Z', used: string[] = []) {
  return { startedAt, used };
}

describe('updateActiveSessions write queue', () => {
  it('serializes concurrent mutations: the second read fires only after the first write lands', async () => {
    const stub = makeStubClient();
    const seen: Array<Record<string, unknown>> = [];

    const call1 = updateActiveSessions(stub.client, (sessions) => {
      seen.push({ ...sessions });
      return { ...sessions, 'cooking:a': session('2026-11-17T01:00:00Z', ['0:flour']) };
    });
    const call2 = updateActiveSessions(stub.client, (sessions) => {
      seen.push({ ...sessions });
      return { ...sessions, 'cooking:b': session('2026-11-17T02:00:00Z', ['1:butter']) };
    });

    // Both mutations enqueued; only the first read is in flight.
    await vi.waitFor(() => expect(stub.readGates).toHaveLength(1));
    expect(stub.writeGates).toHaveLength(0);
    stub.resolveRead({});

    // The first write is in flight; the second read must NOT have
    // started while it is pending.
    await vi.waitFor(() => expect(stub.writeGates).toHaveLength(1));
    expect(stub.readGates).toHaveLength(0);
    stub.resolveWrite();

    // The chain advanced: the second read runs after the first write.
    await vi.waitFor(() => expect(stub.readGates).toHaveLength(1));
    stub.resolveRead(stub.serverBlob().settings ?? {});
    await vi.waitFor(() => expect(stub.writeGates).toHaveLength(1));
    stub.resolveWrite();

    const [r1, r2] = await Promise.all([call1, call2]);
    expect(Object.keys(r1.activeSessions ?? {})).toEqual(['cooking:a']);
    // The second mutate saw the first's write: its result carries both.
    expect(Object.keys(r2.activeSessions ?? {}).sort()).toEqual(['cooking:a', 'cooking:b']);
    expect(seen[1]['cooking:a']).toBeDefined();
  });

  it('a failed mutation rejects its caller and does not block the next', async () => {
    const stub = makeStubClient();

    const failing = updateActiveSessions(stub.client, () => ({}));
    const following = updateActiveSessions(stub.client, () => ({
      cooking: session(),
    }));

    await vi.waitFor(() => expect(stub.readGates).toHaveLength(1));
    stub.resolveRead({});
    await vi.waitFor(() => expect(stub.writeGates).toHaveLength(1));
    // Shift the doomed gate off before rejecting it, so the array
    // only holds live gates for the availability checks below.
    stub.writeGates.shift()!.reject(new Error('network gone'));

    await expect(failing).rejects.toThrow('network gone');

    // The chain advanced: the second mutation reads and writes.
    await vi.waitFor(() => expect(stub.readGates).toHaveLength(1));
    stub.resolveRead({});
    await vi.waitFor(() => expect(stub.writeGates).toHaveLength(1));
    stub.resolveWrite();
    const result = await following;
    expect(Object.keys(result.activeSessions ?? {})).toEqual(['cooking']);
  });

  it('a never-settling mutation times out at the injected bound and the chain advances', async () => {
    const stub = makeStubClient();

    // The hung mutation's read never resolves; its own timeout
    // rejects the caller while the stuck read gate stays queued
    // behind it in the array.
    const hung = updateActiveSessions(
      stub.client,
      () => ({}),
      { timeoutMs: 25 }
    );
    const following = updateActiveSessions(stub.client, () => ({
      cooking: session(),
    }));

    await expect(hung).rejects.toThrow('timed out');

    // The chain advanced: a second read fired despite the stuck one.
    // Discard the hung read gate - it never settles by design.
    await vi.waitFor(() => expect(stub.readGates).toHaveLength(2));
    stub.readGates.shift();
    stub.resolveRead({});
    await vi.waitFor(() => expect(stub.writeGates).toHaveLength(1));
    stub.resolveWrite();
    const result = await following;
    expect(result.activeSessions).toBeDefined();
  });

  it('passes the post-merge blob back as the caller\'s result', async () => {
    const stub = makeStubClient();
    const call = updateActiveSessions(stub.client, (sessions) => ({
      ...sessions,
      shopping: session('2026-11-17T03:00:00Z'),
    }));

    await vi.waitFor(() => expect(stub.readGates).toHaveLength(1));
    stub.resolveRead({});
    await vi.waitFor(() => expect(stub.writeGates).toHaveLength(1));
    stub.resolveWrite();
    const result: UserSettings = await call;
    expect(result.activeSessions?.shopping).toBeDefined();
  });
});
