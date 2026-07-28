// Shared length budget for memory `data` writes.
//
// Owns the one rule every content-write path shares: a rewrite may not
// make a memory body longer than it already is, and no write may push a
// body past MAX_MEMORY_DATA_CHARS. Used by memory_update,
// memory_reshape, and memory_consolidate.
//
// Why this exists as a rule rather than a flat ceiling:
//
// Memory bodies ride inline into the context-recall smoothing prompt -
// CONTEXT_MEMORY_LIMIT rows, verbatim, on the live turn's critical path
// (see priming/context-recall.ts). Measured against a real store, that
// prompt carried ~19k chars of memory bodies per recall while the p75
// body was only ~2286 chars. The gap came from a ratchet: the rewrite
// verbs run on a cadence (the rem / deep-sleep librarians visit rows
// repeatedly, reflection refines them per turn), and an LLM asked to
// "refine" or "clean up" a body reliably hands back something slightly
// longer. Nothing bounded the compounding, so bodies climbed - rows that
// had been rewritten averaged 3341 chars against 1441 for rows only ever
// created - and the confidence boost in search_memories_by_embedding
// then selected exactly those inflated rows into the recall gather.
// Capping the ROW COUNT (which the gather already did) does nothing
// about this; the bytes are what cost.
//
// The budget is `max(MAX_MEMORY_DATA_CHARS, current length)` rather than
// a flat ceiling so a legacy row written under the old 8000-char cap is
// never wedged: it can still be reframed or refined at its current size,
// it just can't grow. Condensing those rows back under the ceiling is
// the librarians' job (their prompts ask for it), not something a
// validation error should force in one shot - memory_reshape's contract
// forbids dropping facts, so a hard truncation would put the tool in
// conflict with itself.

import { type SupabaseClient } from '@supabase/supabase-js';

// Mirror of MAX_MEMORY_DATA_CHARS in src/lib/memories.ts. That module
// carries the rationale for the number itself.
export const MAX_MEMORY_DATA_CHARS = 2500;

// Where "over budget" becomes "worth a rewrite on its own". Twice the
// budget rather than a hand-picked number: a row that has doubled the
// ceiling is carrying enough restatement to be worth the pass, and the
// boundary moves with the budget if that is ever retuned.
const CONDENSE_THRESHOLD_CHARS = MAX_MEMORY_DATA_CHARS * 2;

/**
 * How much shrinking pressure a stored body deserves.
 *
 *   'ok'       - at or under budget. Leave it alone. Most of the store
 *                lives here and a short memory is not a problem to fix.
 *   'trim'     - over budget, but not by much. Worth tightening if a
 *                rewrite is already happening; not worth one on its own.
 *   'condense' - at least double the budget. This row is a live recall
 *                cost every time it surfaces, and is worth a rewrite for
 *                its own sake.
 *
 * The tiering exists because the shrink signal has to be graded. A flat
 * "shorten long memories" instruction pushes the librarian to rewrite
 * 1200-char rows that were never a problem, spending model calls and
 * risking fact loss for nothing.
 */
export type MemoryLengthTier = 'ok' | 'trim' | 'condense';

export function memoryLengthTier(length: number): MemoryLengthTier {
  if (length <= MAX_MEMORY_DATA_CHARS) return 'ok';
  if (length <= CONDENSE_THRESHOLD_CHARS) return 'trim';
  return 'condense';
}

/**
 * The per-row note the librarians read, or null for a row that is fine
 * as it stands. Null is the common case and is load-bearing: absence of
 * a note is how "this row is within budget, do not spend a rewrite on
 * it" gets communicated, without annotating hundreds of healthy rows.
 *
 * Both messages state the length explicitly. The librarian cannot judge
 * a character count by eye - `memory_search` returns bodies, not sizes -
 * so a prompt that says "shorten rows over 2500 chars" without supplying
 * the number asks the model to do something it is bad at.
 *
 * Both also repeat the no-fact-loss rule. Shrinking pressure applied to
 * a row whose every sentence carries a distinct fact would otherwise
 * push the model to drop facts to satisfy the hint - directly against
 * memory_reshape's own contract.
 */
export function memoryLengthHint(length: number): string | null {
  const tier = memoryLengthTier(length);
  if (tier === 'ok') return null;
  const over = `${length} chars, over the ${MAX_MEMORY_DATA_CHARS}-char budget`;
  if (tier === 'trim') {
    return (
      `${over}. If you are reshaping this row anyway, tighten it under the ` +
      'budget while you are here: cut restatement, narration, and hedging ' +
      'filler. Never drop a fact to hit the number. Not worth a rewrite on ' +
      'its own.'
    );
  }
  return (
    `${over} - more than double it. This body is replayed verbatim into ` +
    'recall prompts at full length every time it surfaces, so condensing it ' +
    'is worth a rewrite for its own sake. Rewrite it tighter with every ' +
    'fact, number, name, and date intact. If every sentence really does ' +
    'carry a distinct fact, leave it long and move on - losing facts is ' +
    'worse than the size.'
  );
}

/**
 * Current `data` length of each id that exists and belongs to the user.
 * Missing ids are simply absent from the map - the caller treats them as
 * contributing no headroom, which lands on the flat ceiling.
 *
 * RLS is OFF on the admin client, so the user scope is an explicit
 * user_id filter.
 */
async function readDataLengths(
  adminClient: SupabaseClient,
  userId: string,
  ids: readonly string[],
): Promise<number[]> {
  if (ids.length === 0) return [];
  const { data, error } = await adminClient
    .from('memories')
    .select('data')
    .in('id', [...ids])
    .eq('user_id', userId);
  // A read failure falls back to the flat ceiling rather than failing the
  // write outright. That errs toward the smaller prompt and still hands
  // the agent an actionable message; the alternative (skip the check)
  // would let the ratchet through on exactly the flaky path.
  if (error) return [];
  return ((data ?? []) as Array<{ data: string | null }>).map(
    (r) => r.data?.length ?? 0,
  );
}

/**
 * Validate a proposed `data` body against the budget the referenced rows
 * allow. Returns an agent-readable error string, or null when the write
 * is within budget.
 *
 * `ids` are the rows whose existing length grants headroom: the row being
 * rewritten for update / reshape, and both merge inputs for consolidate
 * (a merge of two duplicates has no business being longer than the longer
 * input).
 */
export async function memoryDataBudgetError(
  adminClient: SupabaseClient,
  userId: string,
  ids: readonly string[],
  newData: string,
): Promise<string | null> {
  if (newData.length <= MAX_MEMORY_DATA_CHARS) return null;
  const existing = await readDataLengths(adminClient, userId, ids);
  const budget = Math.max(MAX_MEMORY_DATA_CHARS, ...existing);
  if (newData.length <= budget) return null;
  return (
    `data is ${newData.length} chars, over the ${budget}-char budget for this write. ` +
    'Memory bodies are replayed verbatim into every recall prompt, so a rewrite ' +
    'must condense or hold steady, never grow. Tighten the wording and keep the facts.'
  );
}
