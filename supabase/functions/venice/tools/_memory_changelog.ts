// Best-effort changelog append for memory write tools. Mirrors
// SupabaseService.createMemoryChangelogEntry: same input shape, same
// silent return on empty fields, same throw-on-DB-error contract.
// Tools call this in a try/catch and swallow the error so a missed
// changelog row cannot fail a successful memory mutation.
//
// Auth: b-strict. memory_changelog.user_id direct match; service
// role bypasses RLS so the userId on the insert is the only check.

import type { SupabaseClient } from '@supabase/supabase-js';

export type MemoryChangelogKind = 'create' | 'update' | 'delete';

export interface MemoryChangelogEntry {
  memory_id: string | null;
  kind: MemoryChangelogKind;
  label_at_change: string;
  message: string;
}

export async function appendMemoryChangelog(
  adminClient: SupabaseClient,
  userId: string,
  entry: MemoryChangelogEntry,
): Promise<void> {
  const label = entry.label_at_change.trim();
  const message = entry.message.trim();
  if (label.length === 0 || message.length === 0) return;
  // RLS OFF: filter by userId. memory_changelog.user_id stamps
  // ownership at insert; service-role would otherwise let a rogue
  // ctx insert a row for someone else.
  const { error } = await adminClient.from('memory_changelog').insert({
    user_id: userId,
    memory_id: entry.memory_id,
    kind: entry.kind,
    label_at_change: label,
    message,
  });
  if (error) throw new Error(`createMemoryChangelogEntry failed: ${error.message}`);
}
