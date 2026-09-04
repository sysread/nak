// Stream-lifecycle probe extracted from the main router (index.ts).
//
// resolveStreamContext does three things:
//   1. Thread ownership gate (userId match against the thread row).
//   2. Liveness verdict: is the thread's stream_heartbeat_at fresh?
//      The orchestrator refreshes it every few seconds while a turn
//      runs, so a fresh heartbeat means "alive" whether or not a
//      streaming row exists yet (the row is only created at the
//      first content delta; the heartbeat covers priming and long
//      reasoning-only stretches).
//   3. In-flight row probe: with a live heartbeat, return the
//      streaming row's envelope (or a pre-row envelope) so the caller
//      can short-circuit a duplicate completion or answer a reconnect.
//   4. Dead-turn janitor: a 'streaming' row whose heartbeat went
//      quiet is an orphan from a function that died ungracefully.
//      Transition it to 'error', write a user-facing explanation onto
//      threads.last_error, and clear the heartbeat residue.
//
// The router helpers (json, userIdFromJwt, requireAdmin) are passed
// in via StreamProbeCtx so this module does not reach back into the
// router.

import type { SupabaseClient } from '@supabase/supabase-js';
import { streamChannelName } from '../_shared/venice-stream.ts';
import { createEdgeLogger } from '../_shared/edge-log.ts';

/** Router helpers the probe needs. Passed in by the router. */
export interface StreamProbeCtx {
  json(body: unknown, status?: number): Response;
  userIdFromJwt(req: Request): string | null;
  requireAdmin(): SupabaseClient | Response;
}

export interface StreamEnvelope {
  channelName: string;
  /**
   * Existing assistant row id on a reconnect path; null on a fresh
   * stream (the orchestrator creates the row lazily at the first
   * content delta and the browser learns its id via the messages
   * realtime subscription). Tests can also see null for an explicit
   * reconnect-only request that found no in-flight stream.
   */
  assistantRowId: string | null;
  /** Empty string on fresh; the streaming row's content on reconnect. */
  completedSoFar: string;
  /**
   * Set true when the caller asked for reconnect-only and no in-
   * flight stream was found. Lets the browser distinguish "this
   * stream is already over - render terminal state from the row"
   * from "subscribe and wait." Absent on every other path.
   */
  noStreamInFlight?: true;
}

export type StreamContextResult =
  | Response
  | {
      userId: string;
      admin: SupabaseClient;
      channelName: string;
      inFlight: StreamEnvelope | null;
    };

/**
 * How long the orchestrator's heartbeat may go unrefreshed before the
 * turn is read as dead. The orchestrator beats every 15s
 * (HEARTBEAT_INTERVAL_MS in getStreamingResponse.ts), so this is four
 * missed beats - slack for a slow write or a briefly blocked event
 * loop, short enough that a hard-killed turn (the runtime's CPU-time
 * budget, a container loss - neither runs the finally) is buried
 * within about a minute. Mirrored by streamLikelyInFlight in
 * src/lib/ui/stream-inflight.ts and by nak_sweep_stale_streams in
 * supabase/schema.sql; change all three together.
 */
export const STALE_HEARTBEAT_MS = 60_000;

/**
 * True when a heartbeat stamp says the turn is plausibly still alive.
 * A slightly-future stamp (clock skew between isolates) still counts
 * as fresh; only a stamp past the ceiling - or no stamp at all - reads
 * as dead.
 */
export function heartbeatIsFresh(
  heartbeatAt: string | null | undefined,
  nowMs: number,
): boolean {
  if (typeof heartbeatAt !== 'string') return false;
  const ageMs = nowMs - new Date(heartbeatAt).getTime();
  return Number.isFinite(ageMs) && ageMs <= STALE_HEARTBEAT_MS;
}

/**
 * Shared front half of both stream handlers: thread ownership, the
 * channel name, and the in-flight probe (with its dead-turn
 * janitor). Returns a Response on any early exit; otherwise the
 * resolved context plus `inFlight` - the envelope of an existing
 * stream when one is running, null when the thread is quiet. Both
 * callers branch on `inFlight` rather than re-probing, so the
 * duplicate-completion guard and the reconnect answer stay one
 * code path.
 *
 * `nowMs` is injectable for tests; production passes nothing.
 */
export async function resolveStreamContext(
  req: Request,
  threadId: string,
  ctx: StreamProbeCtx,
  nowMs: number = Date.now(),
): Promise<StreamContextResult> {
  const userId = ctx.userIdFromJwt(req);
  if (!userId) {
    return ctx.json({ error: 'unauthenticated' }, 401);
  }

  const admin = ctx.requireAdmin();
  if (admin instanceof Response) return admin;

  // Ownership gate. The thread row's user_id is authoritative; we
  // never trust the body. Without this, a forged threadId in the
  // request would let a JWT-authenticated user kick a stream against
  // someone else's thread.
  const { data: thread, error: threadErr } = await admin
    .from('threads')
    .select('user_id, stream_heartbeat_at')
    .eq('id', threadId)
    .maybeSingle();
  if (threadErr) {
    return ctx.json({ error: `thread lookup failed: ${threadErr.message}` }, 502);
  }
  if (!thread || thread.user_id !== userId) {
    // Same error shape for missing-thread and wrong-owner so a
    // probe can't distinguish them.
    return ctx.json({ error: 'thread not found' }, 404);
  }

  const channelName = streamChannelName(threadId);

  const heartbeatAt = (thread as { stream_heartbeat_at?: string | null })
    .stream_heartbeat_at ?? null;
  const alive = heartbeatIsFresh(heartbeatAt, nowMs);

  // In-flight probe: is there a streaming row on this thread? The
  // same answer drives same-device-reload, cross-device ape-mode,
  // and the explicit reconnect route. Surfacing the existing
  // envelope short-circuits a duplicate completion.
  const { data: streamingRow } = await admin
    .from('messages')
    .select('id, content')
    .eq('thread_id', threadId)
    .eq('status', 'streaming')
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle();

  let inFlight: StreamEnvelope | null = null;
  if (streamingRow) {
    const row = streamingRow as { id: string; content?: string | null };
    if (alive) {
      inFlight = {
        channelName,
        assistantRowId: row.id,
        completedSoFar: row.content ?? '',
      };
    } else {
      // Dead-turn janitor. The orchestrator's finally transitions the
      // row to a terminal status and clears the heartbeat on every
      // path it survives to run - so a streaming row next to a stale
      // (or missing) heartbeat means the function died before its
      // finally: the edge runtime's CPU-time budget, a container
      // kill, waitUntil terminated by a hard crash. Returning its
      // channel envelope would have the browser subscribe to a topic
      // no publisher feeds - the throbber stays up forever, Stop
      // publishes a cancel nobody hears, and Regenerate attaches to
      // the corpse via the duplicate-send guard. Transition the row
      // to 'error', write a user-facing explanation onto
      // threads.last_error, clear the heartbeat, and report no stream
      // in flight so the browser renders terminal state from the row.
      //
      // Best-effort cleanup. If either UPDATE fails we still report
      // no stream in flight - leaving the row in 'streaming' is the
      // worst case, and the next probe (or the cron sweep) retries
      // the same janitor pass.
      try {
        await admin
          .from('messages')
          .update({ status: 'error' })
          .eq('id', row.id);
      } catch {
        // Swallowed by design - see above.
      }
      try {
        await admin
          .from('threads')
          .update({
            last_error: {
              kind: 'internal',
              message:
                "The previous response was lost mid-stream (the function ended before it could finalise the reply). Try again.",
              retryable: true,
              occurred_at: new Date(nowMs).toISOString(),
            },
            stream_heartbeat_at: null,
          })
          .eq('id', threadId);
      } catch {
        // Swallowed by design - see above.
      }
    }
  } else if (heartbeatAt !== null) {
    // Pre-row in-flight signal. The orchestrator stamps the heartbeat
    // at turn entry - BEFORE the priming stage and before any
    // assistant row exists (the streaming row is only created at the
    // first content delta). Without this branch a probe that lands
    // during priming, or during a long reasoning-only stretch,
    // reports noStreamInFlight and a reconnecting browser gives up on
    // a turn that is still running. A stale heartbeat with no row is
    // residue from a function that died between rounds; clear it so
    // fresh sends stop short-circuiting into a channel no publisher
    // feeds.
    if (alive) {
      inFlight = {
        channelName,
        assistantRowId: null,
        completedSoFar: '',
      };
    } else {
      try {
        await admin
          .from('threads')
          .update({ stream_heartbeat_at: null })
          .eq('id', threadId);
      } catch {
        // Best-effort - the next probe retries the same sweep.
      }
    }
  }

  const probeLog = createEdgeLogger(userId, 'stream');

  // Probe-verdict breadcrumb for the Logs drawer (source: stream).
  // Fires on every /stream call - fresh sends and the reconnect
  // poll's ~2.5s probes alike - so a refresh-during-pregame session
  // can be reconstructed after the fact: what the probe saw
  // (streaming row / heartbeat / neither) and what it answered. Debug
  // tier: drawer-only, never mirrors to the console.
  probeLog.debug(
    `in-flight probe thread=${threadId}` +
      ` streamingRow=${streamingRow ? (streamingRow as { id: string }).id : 'none'}` +
      ` heartbeat=${heartbeatAt ?? 'null'}` +
      ` verdict=${inFlight ? (inFlight.assistantRowId ? 'in-flight(row)' : 'in-flight(pregame)') : 'quiet'}`,
  );

  return { userId, admin, channelName, inFlight };
}
