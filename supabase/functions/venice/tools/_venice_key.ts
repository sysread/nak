// Helper: read the project-global shared Venice API key from
// app_config via the admin client. Mirrors readVeniceKey in
// venice/index.ts so tools can call Venice in-process without
// importing through the route handler.
//
// Returns null when the row is unseeded; the caller decides whether
// to throw, degrade, or fall back. Most search-family tools fall back
// to ILIKE on null and let the model see the degraded result.

import type { SupabaseClient } from '@supabase/supabase-js';

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
