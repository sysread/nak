// Helper: read the project-global shared Venice API key from
// app_config via the admin client. Mirrors readVeniceKey in
// venice/index.ts so tools can call Venice in-process without
// importing through the route handler.
//
// Returns null when the row is unseeded; the caller decides whether
// to throw, degrade, or fall back. Most search-family tools fall back
// to ILIKE on null and let the model see the degraded result.

import type { SupabaseClient } from '@supabase/supabase-js';
import { coercePriceCaps, type ModelPriceCaps } from '../../_shared/price-cap.ts';

export async function readVeniceKey(admin: SupabaseClient): Promise<string | null> {
  const { data, error } = await admin
    .from('app_config')
    .select('venice_api_key')
    .eq('id', true)
    .maybeSingle();
  if (error || !data) return null;
  const key = (data as { venice_api_key?: string | null }).venice_api_key;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/**
 * Read the project-global model price caps from app_config. Mirrors
 * readPriceCaps in venice/index.ts (the same deliberate duplication as
 * readVeniceKey above) so tools can enforce the cap in-process without
 * importing through the route handler. An error or unseeded row coerces to
 * all-null caps (no ceiling).
 */
export async function readPriceCaps(admin: SupabaseClient): Promise<ModelPriceCaps> {
  const { data } = await admin
    .from('app_config')
    .select('max_input_usd_per_m, max_output_usd_per_m, max_image_usd')
    .eq('id', true)
    .maybeSingle();
  return coercePriceCaps(data ?? {});
}
