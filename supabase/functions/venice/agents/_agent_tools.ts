// Shared plumbing for composing per-agent toolboxes out of registered
// server-side ToolDefs. The headless agents (reflection, wiki) each
// pin their own wire schemas - the tool contracts their model sees -
// but wrap the SAME registered execute() implementations, so agent
// writes stay byte-identical to the chat-side tools. This module
// holds the adapter plus the wire schemas and helpers more than one
// agent needs; agent-specific schemas stay in their agent's file.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolDef } from '../performToolCall.ts';
import type { AgentTool } from './_run.ts';
import type { StoredMessage } from './_recall_helpers.ts';

/**
 * Wrap a registered server-side ToolDef as an AgentTool for an agent
 * toolbox. The ToolDef's execute() already does the real DB work
 * scoped to ctx.userId; we just adapt the AgentToolContext shape
 * (which carries the same fields) and pin the wire schema the model
 * sees. Calling into the registered impl rather than re-implementing
 * keeps agent writes byte-identical to the chat-side tools.
 */
export function asAgentTool(tool: ToolDef, wire: AgentTool['wire']): AgentTool {
  return {
    name: tool.name,
    wire,
    execute: (args, agentCtx) =>
      tool.execute(args, {
        adminClient: agentCtx.adminClient,
        userId: agentCtx.userId,
        threadId: agentCtx.threadId,
        signal: agentCtx.signal,
        depth: agentCtx.depth,
      }),
  };
}

/**
 * memory_search rides along read-only in more than one agent toolbox
 * (reflection writes memories, the wiki agent grounds articles in
 * them), so its wire schema lives here rather than in either agent's
 * file. Ported from the browser src/lib/tools/memory_search.schema.ts.
 */
export const MEMORY_SEARCH_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'memory_search',
    description:
      "Semantic search over the user's saved memories. Returns " +
      '{id, label, data, confidence, confidence_tag, updated_at, ' +
      'relations}[]. Empty query lists everything. Use this FIRST, ' +
      'before writing, to find an existing memory to update instead of ' +
      'creating a near-duplicate.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Natural-language query. Embedding match (paraphrases work). Empty/omitted lists all.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Max results (default 20, max 100).',
        },
      },
      additionalProperties: false,
    },
  },
};

/**
 * Load a thread's messages and slice at a claimed terminal message.
 * Unlike the recall helpers' loadThreadSlice (which trims back to the
 * last user turn), the background agents want everything UP TO AND
 * INCLUDING the terminal assistant message the claim was made
 * against. Slicing at terminalMsgId means a user who raced more turns
 * in between claim and fetch doesn't change what the agent processes -
 * the extra turns queue the thread for the next cycle instead.
 *
 * No char-budget trim: matches the browser agents, which sent the
 * whole slice. The day-gated queues + deepseek-v4-flash's 256k window
 * make an over-budget thread a rare corner; if it ever bites, trimming
 * is a separate follow-up, not a silent divergence introduced here.
 */
export async function loadThreadSliceUpTo(
  adminClient: SupabaseClient,
  threadId: string,
  terminalMsgId: string,
): Promise<StoredMessage[]> {
  const { data, error } = await adminClient
    .from('messages')
    .select('id, role, content, tool_calls, tool_call_id, name')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listMessages failed: ${error.message}`);
  const all = (data ?? []) as StoredMessage[];
  const idx = all.findIndex((m) => m.id === terminalMsgId);
  return idx >= 0 ? all.slice(0, idx + 1) : all;
}
