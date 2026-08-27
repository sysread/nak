// feature-rejections -----------------------------------------------------
//
// Reads and writes for the model_feature_rejections table: the
// persistent memory of optional wire fields a model's backend rejects
// ("Extra inputs are not permitted, field: 'X'" strict validation,
// plus the "Reasoning is mandatory" refusal of disable_thinking).
// The feature value is a wire PATH: a bare top-level key ('text') or
// one dotted level ('venice_parameters.disable_thinking').
// Discovery happens in getStreamingCompletion's strip-and-retry
// fallback; the orchestrator (getStreamingResponse) records each
// discovery here and, at turn start, strips already-known rejections
// from the request body so the failing round-trip is paid once ever
// per model+feature. The browser reads the same table (see
// src/lib/supabase/settings.ts) to disable matching controls in
// Settings -> Model profiles.
//
// Both DB helpers are best-effort and never throw: a read failure
// degrades to "nothing known rejected" (the strip-and-retry fallback
// still recovers the turn, just with one extra round-trip), and a
// write failure only means the next turn re-discovers. Neither is
// worth failing a turn over.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DROPPABLE_WIRE_FIELDS,
  deleteWireField,
  hasWireField,
} from './getStreamingCompletion.ts';

/**
 * Fetch the set of wire fields known to be rejected by `modelId`'s
 * backend. Empty set on any error or when nothing is recorded.
 */
export async function fetchRejectedFeatures(
  client: SupabaseClient,
  modelId: string,
): Promise<ReadonlySet<string>> {
  try {
    const { data, error } = await client
      .from('model_feature_rejections')
      .select('feature')
      .eq('model_id', modelId);
    if (error || !Array.isArray(data)) return new Set();
    return new Set(
      data
        .map((r) => (r as { feature?: unknown }).feature)
        .filter((f): f is string => typeof f === 'string'),
    );
  } catch {
    // Fail open: an unreachable table must not block the turn - the
    // completion layer's strip-and-retry still recovers at runtime.
    return new Set();
  }
}

/**
 * Record a runtime-discovered rejection. Idempotent: the (model_id,
 * feature) primary key makes a repeat discovery a no-op upsert.
 */
export async function recordRejectedFeature(
  client: SupabaseClient,
  modelId: string,
  feature: string,
): Promise<void> {
  try {
    const { error } = await client
      .from('model_feature_rejections')
      .upsert(
        { model_id: modelId, feature },
        { onConflict: 'model_id,feature', ignoreDuplicates: true },
      );
    if (error) {
      console.log(
        `[feature-rejections] failed to record ${modelId}/${feature}: ${error.message}`,
      );
    }
  } catch (err) {
    // Best-effort: a lost write only costs one re-discovery round-trip
    // on some future turn.
    console.log(
      `[feature-rejections] failed to record ${modelId}/${feature}: ${(err as Error).message}`,
    );
  }
}

/**
 * Delete recorded-rejected features from a request body, in place.
 * Gated on DROPPABLE_WIRE_FIELDS so a stray or hand-inserted DB row
 * can never strip a semantic field (tools, messages, ...) - the table
 * is trusted for advisory knobs only. Returns the field names actually
 * removed (for logging).
 */
export function stripRejectedFeatures(
  body: Record<string, unknown>,
  rejected: ReadonlySet<string>,
): string[] {
  const stripped: string[] = [];
  for (const field of rejected) {
    if (DROPPABLE_WIRE_FIELDS.has(field) && hasWireField(body, field)) {
      deleteWireField(body, field);
      stripped.push(field);
    }
  }
  return stripped;
}
