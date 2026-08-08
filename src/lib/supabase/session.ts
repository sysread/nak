/**
 * Unwrap the current Supabase auth session for a client. Shared by
 * the domain slice modules (./memories.ts, ./threads.ts, ...) that
 * need the signed-in user's id but cannot import the facade
 * (../supabase.ts imports the slices, so slices importing the
 * facade would create a cycle). This module sits alongside ./error.ts
 * and ./query-utils.ts as a cross-slice helper the slices can safely
 * reach for.
 *
 * Throws SupabaseError on an auth-layer failure so callers surface
 * data-layer errors consistently. Returns null when no session is
 * active - slices that require a user should throw their own
 * "not signed in" error after the null check.
 */
import type { SupabaseClient, Session } from '@supabase/supabase-js';
import { SupabaseError } from './error';

export async function getSession(
  client: SupabaseClient,
): Promise<Session | null> {
  const { data, error } = await client.auth.getSession();
  if (error) throw new SupabaseError(error.message);
  return data.session;
}
