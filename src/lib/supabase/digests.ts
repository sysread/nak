/**
 * Conversation-digest slice of the Supabase data layer: read-only
 * access to the conversation_digests table (one agent-written recap
 * per user per local calendar day). The browser never writes this
 * table - rows come exclusively from the digest sweep agent under the
 * service role (supabase/functions/venice/agents/digest.ts) - so this
 * slice is a single paged listing.
 *
 * Plain async functions taking the shared SupabaseClient first, same
 * shape as every other slice; the SupabaseService facade
 * (../supabase.ts) delegates one-for-one and UI code calls
 * `app.supabase.listConversationDigests()`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseError } from './error';
import type { ConversationDigest } from './types';
import { coerceConversationDigest } from './types';

/**
 * Paged listing of the daily digests, newest day first. `before` is
 * the exclusive digest_date cursor - pass the last entry's
 * digest_date from the prior page to fetch the next one. The
 * (user_id, digest_date desc) index makes each page a range scan;
 * the unique (user_id, digest_date) constraint makes the date a
 * collision-free cursor.
 */
export async function listConversationDigests(
  client: SupabaseClient,
  opts: {
    limit?: number;
    before?: string | null;
  } = {}
): Promise<ConversationDigest[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 30, 200));
  let q = client
    .from('conversation_digests')
    .select('id, digest_date, summary, threads, created_at')
    .order('digest_date', { ascending: false })
    .limit(limit);
  if (opts.before) q = q.lt('digest_date', opts.before);
  const { data, error } = await q;
  if (error) throw new SupabaseError(error.message);
  const out: ConversationDigest[] = [];
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const digest = coerceConversationDigest(row);
    if (digest) out.push(digest);
  }
  return out;
}
