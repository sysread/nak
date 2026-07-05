// Durable per-cycle audit trail for the wiki agents (the
// per-conversation article agent, the record-extraction agent, and the
// librarian). One row per COMPLETED cycle in public.wiki_agent_log,
// including no-op cycles - the reasoning column is the durable copy of
// the operator summary that otherwise lives only in the ephemeral log
// relay (in-app drawer, 24h edge logs).
//
// Best-effort BY CONTRACT: a cycle that did its real work must not fail
// because the audit insert did, so this helper swallows every error
// after a console line. Callers just await it with no try/catch.
//
// Auth: b-strict. The service-role client bypasses RLS, so the insert
// stamps user_id explicitly; there is no authenticated write path to
// this table (select-only RLS).

import type { SupabaseClient } from '@supabase/supabase-js';

export interface WikiAgentLogEntry {
  agent: 'wiki' | 'wiki-records' | 'wiki-librarian';
  /** What kicked the cycle off; mirrors the wiki_agent_log_trigger_check values. */
  triggerSource: 'scheduled' | 'retry' | 'manual' | 'chat';
  /** The processed conversation; omit for the librarian (wiki-wide, no thread). */
  threadId?: string | null;
  terminalMsgId?: string | null;
  toolCalls: number;
  /** The model's normalised operator summary ("(none)" when it said nothing). */
  reasoning: string;
}

export async function appendWikiAgentLog(
  adminClient: SupabaseClient,
  userId: string,
  entry: WikiAgentLogEntry,
): Promise<void> {
  try {
    const { error } = await adminClient.from('wiki_agent_log').insert({
      user_id: userId,
      agent: entry.agent,
      trigger_source: entry.triggerSource,
      thread_id: entry.threadId ?? null,
      terminal_msg_id: entry.terminalMsgId ?? null,
      tool_calls: entry.toolCalls,
      reasoning: entry.reasoning,
    });
    if (error) {
      console.error(`[wiki-agent-log] insert failed: ${error.message}`);
    }
  } catch (err) {
    console.error(
      `[wiki-agent-log] insert threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
