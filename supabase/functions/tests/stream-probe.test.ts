// Guards for the /stream in-flight probe's liveness verdict
// (venice/stream-probe.ts). The verdict is what separates a running
// turn from one the edge runtime hard-killed: the streaming row and the
// Broadcast channel look identical in both cases, and only the
// orchestrator's heartbeat going quiet gives the death away. Fake
// admin client, no DB, no network.

import { assert, assertEquals } from 'jsr:@std/assert';
import { type SupabaseClient } from '@supabase/supabase-js';
import {
  heartbeatIsFresh,
  resolveStreamContext,
  STALE_HEARTBEAT_MS,
  type StreamProbeCtx,
} from '../venice/stream-probe.ts';

const NOW = Date.parse('2026-09-04T22:57:23Z');
const THREAD = 'db0cd530-a2e9-4e45-bbd6-ba8d78278576';
const USER = 'user-1';

interface Update {
  table: string;
  payload: Record<string, unknown>;
}

// Chainable fake admin client. The probe walks
// from('threads').select().eq().maybeSingle() and
// from('messages').select().eq().eq().order().limit().maybeSingle();
// the janitor walks from().update().eq() and awaits the builder. Each
// update payload is recorded with its table so a test can assert what
// the janitor wrote.
function makeAdmin(
  threadRow: Record<string, unknown> | null,
  streamingRow: Record<string, unknown> | null,
  updates: Update[],
): SupabaseClient {
  // deno-lint-ignore no-explicit-any
  const admin: any = {
    from: (table: string) => {
      // deno-lint-ignore no-explicit-any
      const builder: any = {
        select: () => builder,
        update: (payload: Record<string, unknown>) => {
          updates.push({ table, payload });
          return builder;
        },
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () =>
          Promise.resolve({
            data: table === 'threads' ? threadRow : streamingRow,
            error: null,
          }),
        then: (res: (v: { error: null }) => void) => res({ error: null }),
      };
      return builder;
    },
  };
  return admin as SupabaseClient;
}

function makeCtx(admin: SupabaseClient): StreamProbeCtx {
  return {
    json: (body, status) =>
      new Response(JSON.stringify(body), { status: status ?? 200 }),
    userIdFromJwt: () => USER,
    requireAdmin: () => admin,
  };
}

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

async function probe(
  threadRow: Record<string, unknown>,
  streamingRow: Record<string, unknown> | null,
) {
  const updates: Update[] = [];
  const admin = makeAdmin(threadRow, streamingRow, updates);
  const result = await resolveStreamContext(
    new Request('http://x/stream'),
    THREAD,
    makeCtx(admin),
    NOW,
  );
  assert(!(result instanceof Response), 'probe returned an early-exit Response');
  return { result, updates };
}

Deno.test('heartbeatIsFresh: null, stale, fresh, and skewed-future stamps', () => {
  assertEquals(heartbeatIsFresh(null, NOW), false);
  assertEquals(heartbeatIsFresh(undefined, NOW), false);
  assertEquals(heartbeatIsFresh('garbage', NOW), false);
  assertEquals(heartbeatIsFresh(iso(-STALE_HEARTBEAT_MS - 1), NOW), false);
  assertEquals(heartbeatIsFresh(iso(-STALE_HEARTBEAT_MS + 1), NOW), true);
  assertEquals(heartbeatIsFresh(iso(+10_000), NOW), true);
});

Deno.test('a streaming row with a fresh heartbeat is in flight (row envelope)', async () => {
  const { result, updates } = await probe(
    { user_id: USER, stream_heartbeat_at: iso(-5_000) },
    { id: 'row-1', content: 'so far' },
  );
  assertEquals(result.inFlight, {
    channelName: result.channelName,
    assistantRowId: 'row-1',
    completedSoFar: 'so far',
  });
  assertEquals(updates, []);
});

Deno.test('a streaming row with a stale heartbeat is buried: row -> error, last_error written, heartbeat cleared', async () => {
  // The incident shape: the runtime killed the function 4s after the
  // row was created; nothing ever ran the finally.
  const { result, updates } = await probe(
    { user_id: USER, stream_heartbeat_at: iso(-4 * 60_000) },
    { id: 'row-1', content: 'partial' },
  );
  assertEquals(result.inFlight, null);
  assertEquals(updates.length, 2);
  assertEquals(updates[0], { table: 'messages', payload: { status: 'error' } });
  assertEquals(updates[1].table, 'threads');
  assertEquals(updates[1].payload.stream_heartbeat_at, null);
  const lastError = updates[1].payload.last_error as Record<string, unknown>;
  assertEquals(lastError.kind, 'internal');
  assertEquals(lastError.retryable, true);
});

Deno.test('a streaming row with no heartbeat at all is buried too', async () => {
  // The orchestrator stamps before it ever creates a row, so a row
  // with a null heartbeat can only be residue.
  const { result, updates } = await probe(
    { user_id: USER, stream_heartbeat_at: null },
    { id: 'row-1', content: '' },
  );
  assertEquals(result.inFlight, null);
  assertEquals(updates[0], { table: 'messages', payload: { status: 'error' } });
});

Deno.test('no row + fresh heartbeat is the pregame in-flight envelope', async () => {
  const { result, updates } = await probe(
    { user_id: USER, stream_heartbeat_at: iso(-20_000) },
    null,
  );
  assertEquals(result.inFlight, {
    channelName: result.channelName,
    assistantRowId: null,
    completedSoFar: '',
  });
  assertEquals(updates, []);
});

Deno.test('no row + stale heartbeat is quiet and clears the residue', async () => {
  const { result, updates } = await probe(
    { user_id: USER, stream_heartbeat_at: iso(-STALE_HEARTBEAT_MS - 1_000) },
    null,
  );
  assertEquals(result.inFlight, null);
  assertEquals(updates, [
    { table: 'threads', payload: { stream_heartbeat_at: null } },
  ]);
});

Deno.test('no row + no heartbeat is quiet with nothing to clean', async () => {
  const { result, updates } = await probe(
    { user_id: USER, stream_heartbeat_at: null },
    null,
  );
  assertEquals(result.inFlight, null);
  assertEquals(updates, []);
});

Deno.test('a thread owned by someone else is not found', async () => {
  const admin = makeAdmin({ user_id: 'other', stream_heartbeat_at: iso(0) }, null, []);
  const result = await resolveStreamContext(
    new Request('http://x/stream'),
    THREAD,
    makeCtx(admin),
    NOW,
  );
  assert(result instanceof Response);
  assertEquals(result.status, 404);
});
