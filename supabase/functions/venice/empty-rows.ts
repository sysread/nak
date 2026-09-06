// Empty assistant-row sweep for the streaming chat turn.
//
// An assistant row with no content, no tool calls, and no reasoning
// carries nothing the transcript can show or the model can read. The
// browser still renders it as a bare card (footer only), and it goes
// out on the wire as an empty assistant turn on every replay. No
// write path is supposed to leave one behind, so finding one is a
// bug signal - the sweep logs each hit at warn so the drawer shows
// it rather than the deletion hiding a regression.
//
// The one historical producer: the ask_user suspend path used to
// park the turn's streaming placeholder (already blanked at the
// round boundary) under status='suspended_for_ask_user', and the
// resumed invocation created its own row instead of reusing it.
// Older threads still carry those rows; the sweep clears them on the
// thread's next completed turn.
//
// Runs from getStreamingResponse after the terminal commit, before
// END, so the END event can carry the pruned ids and the browser
// drops the rows from its local transcript without a refetch (the
// messages realtime subscription has no DELETE handler, and the
// messages table has no replica identity index, so a DELETE would
// not reach the browser through realtime anyway).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { EdgeLogger } from '../_shared/edge-log.ts';

/** The columns the sweep reads to decide emptiness. */
export interface SweepCandidate {
  id: string;
  role: string;
  status: string | null;
  content: string;
  tool_calls: unknown;
  reasoning: string | null;
}

/**
 * True when the row is a persisted assistant row that carries nothing:
 * no visible text, no tool calls, no reasoning. Pure - the DB-facing
 * caller below feeds it candidate rows.
 *
 * `keepId` is the current turn's own terminal row. It is excluded by
 * id rather than by shape because it is the one row whose emptiness
 * is NOT this sweep's business - the round-limit guard and the
 * commit RPC own what it looks like.
 *
 * Exclusions, each a row that is empty on the content column but
 * still load-bearing:
 *   - status='streaming': another invocation's in-flight placeholder
 *     (the exchange claim makes this unlikely, but the row would be
 *     filled in moments).
 *   - tool_calls non-empty: a tool-round row. Its content is empty by
 *     design; the calls ARE the payload.
 *   - reasoning non-empty: a cut-off partial the error path preserved
 *     so the user can inspect why the turn died. Content-empty,
 *     reasoning-only rows are deliberate.
 * Aborted rows never reach the empty branch: the interrupted marker
 * is written even when nothing streamed.
 */
export function isEmptyAssistantRow(
  row: SweepCandidate,
  keepId: string | null,
): boolean {
  if (row.id === keepId) return false;
  if (row.role !== 'assistant') return false;
  if (row.status === 'streaming') return false;
  if (row.content.trim().length > 0) return false;
  if (Array.isArray(row.tool_calls) && row.tool_calls.length > 0) return false;
  if (typeof row.reasoning === 'string' && row.reasoning.trim().length > 0) {
    return false;
  }
  return true;
}

/**
 * Find and delete every empty assistant row on the thread except
 * `keepId`. Returns the ids actually deleted so the caller can put
 * them on the END event. Best-effort throughout: a failed select
 * returns an empty list, and rows are deleted one at a time so a
 * single row a foreign key refuses to release (a fork anchor, for
 * one) cannot block the rest of the sweep.
 */
export async function pruneEmptyAssistantRows(
  admin: SupabaseClient,
  threadId: string,
  keepId: string | null,
  log: EdgeLogger,
  runId: string,
): Promise<string[]> {
  // The query narrows on content = '' (the shape every known empty row
  // has); the predicate re-checks emptiness plus the exclusions the
  // client library can't express cleanly against jsonb.
  const { data, error } = await admin
    .from('messages')
    .select('id, role, status, content, tool_calls, reasoning')
    .eq('thread_id', threadId)
    .eq('role', 'assistant')
    .eq('content', '');
  if (error) {
    log.error(`${runId} empty-row sweep select failed: ${error.message}`);
    return [];
  }
  const candidates = (data ?? []) as SweepCandidate[];
  const pruned: string[] = [];
  for (const row of candidates) {
    if (!isEmptyAssistantRow(row, keepId)) continue;
    const { error: delError } = await admin
      .from('messages')
      .delete()
      .eq('id', row.id);
    if (delError) {
      log.error(
        `${runId} empty-row sweep could not delete ${row.id} (status=${row.status ?? 'null'}): ${delError.message}`,
      );
      continue;
    }
    // warn, not info: an empty assistant row means some write path
    // regressed. The drawer line is the only place that shows.
    log.warn(
      `${runId} pruned empty assistant row ${row.id} (status=${row.status ?? 'null'}) - no write path should leave one behind`,
    );
    pruned.push(row.id);
  }
  return pruned;
}
