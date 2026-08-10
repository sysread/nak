// Stream-lifecycle probe extracted from the main router (index.ts).
//
// resolveStreamContext does three things:
//   1. Thread ownership gate (userId match against the thread row).
//   2. In-flight row probe: is there a 'streaming' status message
//      on this thread? If so, return its envelope so the caller can
//      short-circuit a duplicate completion or answer a reconnect.
//   3. Stale-row janitor: a 'streaming' row or stream_started_at
//      stamp well past the wall-deadline ceiling is an orphan from
//      a function that died ungracefully. Transition it to 'error'
//      and write a user-facing explanation onto threads.last_error.
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
 * Shared front half of both stream handlers: thread ownership, the
 * channel name, and the in-flight probe (with its stale-row
 * janitor). Returns a Response on any early exit; otherwise the
 * resolved context plus `inFlight` - the envelope of an existing
 * stream when one is running, null when the thread is quiet. Both
 * callers branch on `inFlight` rather than re-probing, so the
 * duplicate-completion guard and the reconnect answer stay one
 * code path.
 */
export async function resolveStreamContext(
  req: Request,
  threadId: string,
  ctx: StreamProbeCtx,
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
    .select('user_id, stream_started_at')
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

  // In-flight probe: is there a streaming row on this thread? The
  // same answer drives same-device-reload, cross-device ape-mode,
  // and the explicit reconnect route. Surfacing the existing
  // envelope short-circuits a duplicate completion.
  const { data: streamingRow } = await admin
    .from('messages')
    .select('id, content, created_at')
    .eq('thread_id', threadId)
    .eq('status', 'streaming')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let inFlight: StreamEnvelope | null = null;
  if (streamingRow) {
    const row = streamingRow as {
      id: string;
      content?: string | null;
      created_at: string;
    };
    // Stale-row janitor. The orchestrator's WALL_DEADLINE_MS is 380s
    // and its finally block transitions the row to 'error' on
    // wall-timeout, so a healthy stream lives at most ~7 minutes. A
    // row still in 'streaming' status well past that ceiling is
    // orphaned: the function died ungracefully (container kill,
    // EdgeRuntime.waitUntil terminated by tab close before terminal
    // commit, hard crash) without finalising the row. Returning its
    // channel envelope would have the browser subscribe to a topic
    // no publisher feeds - the throbber stays up forever, the Stop
    // button shows on a stream that isn't running. Transition the
    // row to 'error', write a user-facing explanation onto
    // threads.last_error, and return noStreamInFlight so the
    // browser's reconnect path treats it as "nothing to observe."
    // STALE_THRESHOLD is twice the wall deadline to leave headroom
    // for a long generation that legitimately stretches past the
    // soft ceiling - false positives waste a turn; false negatives
    // hang the UI, and we'd rather take the wasted turn.
    const STALE_THRESHOLD_MS = 2 * 380_000; // 760 seconds (~12.7 min)
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    if (ageMs > STALE_THRESHOLD_MS) {
      // Best-effort cleanup. If either UPDATE fails we still report
      // no stream in flight - leaving the row in 'streaming' is the
      // worst case but the next reconnect will retry the same
      // janitor pass.
      try {
        await admin
          .from('messages')
          .update({ status: 'error' })
          .eq('id', row.id);
      } catch {
        // Swallowed by design - see jsdoc.
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
              occurred_at: new Date().toISOString(),
            },
          })
          .eq('id', threadId);
      } catch {
        // Swallowed by design - see jsdoc.
      }
      // inFlight stays null: the janitored row no longer counts as a
      // running stream.
    } else {
      inFlight = {
        channelName,
        assistantRowId: row.id,
        completedSoFar: row.content ?? '',
      };
    }
  }

  const probeLog = createEdgeLogger(userId, 'stream');

  // Pre-row in-flight signal. The orchestrator stamps
  // threads.stream_started_at at turn entry - BEFORE the priming stage
  // and before any assistant row exists (the streaming row is only
  // created at the first content delta). Without this branch a probe
  // that lands during priming, or during a long reasoning-only stretch,
  // reports noStreamInFlight and a reconnecting browser gives up on a
  // turn that is still running. Same staleness posture as the row
  // janitor above: a stamp well past the wall-deadline ceiling means
  // the function died before its finally could clear it, so treat it
  // as quiet and best-effort clear the residue (otherwise fresh sends
  // would keep short-circuiting into a channel no publisher feeds).
  if (!inFlight) {
    const startedAtRaw = (thread as { stream_started_at?: string | null })
      .stream_started_at;
    if (typeof startedAtRaw === 'string') {
      const STALE_THRESHOLD_MS = 2 * 380_000; // mirrors the row janitor
      const ageMs = Date.now() - new Date(startedAtRaw).getTime();
      // A slightly-negative age (clock skew between isolates) still
      // counts as fresh; only a stamp past the ceiling is residue.
      if (Number.isFinite(ageMs) && ageMs <= STALE_THRESHOLD_MS) {
        inFlight = {
          channelName,
          assistantRowId: null,
          completedSoFar: '',
        };
      } else {
        try {
          await admin
            .from('threads')
            .update({ stream_started_at: null })
            .eq('id', threadId);
        } catch {
          // Best-effort - the next probe retries the same sweep.
        }
      }
    }
  }

  // Probe-verdict breadcrumb for the Logs drawer (source: stream).
  // Fires on every /stream call - fresh sends and the reconnect
  // poll's ~2.5s probes alike - so a refresh-during-pregame session
  // can be reconstructed after the fact: what the probe saw
  // (streaming row / stamp / neither) and what it answered. Debug
  // tier: drawer-only, never mirrors to the console.
  probeLog.debug(
    `in-flight probe thread=${threadId}` +
      ` streamingRow=${streamingRow ? (streamingRow as { id: string }).id : 'none'}` +
      ` stamp=${
        (thread as { stream_started_at?: string | null }).stream_started_at ?? 'null'
      }` +
      ` verdict=${inFlight ? (inFlight.assistantRowId ? 'in-flight(row)' : 'in-flight(pregame)') : 'quiet'}`,
  );

  return { userId, admin, channelName, inFlight };
}
