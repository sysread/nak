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
 * conversation_search rides along read-only in the reflection and
 * memory-librarian toolboxes with this generic description (the wiki
 * librarian pins its own article-flavored variant). Ported from the
 * browser src/lib/tools/conversation_search.schema.ts.
 */
export const CONVERSATION_SEARCH_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'conversation_search',
    description:
      "Semantic search over the user's prior conversations (threads) " +
      'by title + summary. Returns {id, title, summary, updated_at, ' +
      'archived, match_kind, similarity?}[]. summary is auto-generated ' +
      'after the first terminal assistant turn (null on brand-new ' +
      'threads). Archived threads are included; weigh the archived flag ' +
      'lower if freshness matters. Embedding match runs alongside an ' +
      'exact title substring match; exact hits sort first.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language query. Required.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Max results (default 20, max 100).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

/**
 * The four memory-graph maintenance wires shared by reflection and
 * the memory librarians (rem, deep-sleep). All are verbatim ports of
 * the browser src/lib/tools/*.schema.ts files - the same generic
 * descriptions every browser toolbox shipped.
 */
export const MEMORY_RELATE_MAX_NOTE_CHARS = 500;

export const MEMORY_INVALIDATE_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'memory_invalidate',
    description:
      'Mark a memory as contradicted/outdated, halving its confidence ' +
      'so it stops surfacing in search. Repeated invalidation hides it ' +
      "entirely; the row isn't hard-deleted, so memory_update / " +
      'memory_create can restore confidence later. Returns ' +
      '{id, confidence} post-decay.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'UUID of the memory.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
};

export const MEMORY_DOUBT_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'memory_doubt',
    description:
      "Multiply a memory's confidence by 0.7 when the current exchange " +
      'weakens it without fully contradicting it (no floor; below 0.05 ' +
      'the memory hides from search but is recoverable). For outright ' +
      'contradictions prefer memory_update with corrected text or ' +
      'memory_invalidate. Returns {id, confidence} post-doubt.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'UUID of the memory.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
};

export const MEMORY_RELATE_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'memory_relate',
    description:
      'Link two memories with a directed edge (supports / contradicts / ' +
      'generalises / specialises). Optional note (up to ' +
      `${MEMORY_RELATE_MAX_NOTE_CHARS} chars) records the rationale. ` +
      'Relations surface next to their source memory in retrieval. ' +
      'Self-loops rejected; duplicate edges (same from/to/kind) collapse ' +
      'to no-op. Returns {id, kind}.',
    parameters: {
      type: 'object',
      properties: {
        from_id: {
          type: 'string',
          description: 'UUID of the source memory (edge originates here).',
        },
        to_id: {
          type: 'string',
          description: 'UUID of the target memory (edge points here).',
        },
        kind: {
          type: 'string',
          enum: ['supports', 'contradicts', 'generalises', 'specialises'],
          description:
            'supports = target reinforces source; contradicts = target ' +
            'disagrees; generalises = target is broader; specialises = ' +
            'target is narrower.',
        },
        note: {
          type: 'string',
          maxLength: MEMORY_RELATE_MAX_NOTE_CHARS,
          description: 'Optional rationale for the link.',
        },
      },
      required: ['from_id', 'to_id', 'kind'],
      additionalProperties: false,
    },
  },
};

export const MEMORY_UNRELATE_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'memory_unrelate',
    description:
      'Remove a directed edge between two memories. Hard-delete; no ' +
      "soft version. id is the relation row's UUID (not a memory id) - " +
      'surfaced when the relation appears in search. Returns ' +
      '{deleted: true}.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'UUID of the relation row (NOT a memory id).',
        },
      },
      required: ['id'],
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
 * whole slice. The tightest window among this helper's consumers is
 * 256k (mistral-small for summary / thread_topics; reflection and wiki
 * run deepseek-v4-flash, wider at 1M). The day-gated queues plus that
 * 256k floor make an over-budget thread a rare corner; if it ever
 * bites, trimming is a separate follow-up, not a silent divergence
 * here.
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
