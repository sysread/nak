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
  /**
   * Body length on either side of this change, so the history panel can
   * show how much the edit grew or shrank the memory.
   *
   * Semantics the schema depends on: 0 means known-empty (a create has
   * nothing before it, a delete nothing after), while omitting the field
   * leaves NULL, meaning unknown. Only pass undefined when the size
   * genuinely could not be determined - a null here is indistinguishable
   * from a pre-feature row in the UI.
   *
   * `chars_before` is always THIS memory's prior length, including for a
   * consolidation (where the entry lands on the survivor). Not
   * survivor+loser combined: per-kind semantics would make these columns
   * double-count when summed across rows.
   */
  chars_before?: number;
  chars_after?: number;
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
    // Omitted sizes ride as NULL ("unknown"), which is distinct from 0
    // ("known empty") - see the column comments in schema.sql.
    chars_before: entry.chars_before ?? null,
    chars_after: entry.chars_after ?? null,
  });
  if (error) throw new Error(`createMemoryChangelogEntry failed: ${error.message}`);
}
