// Shared toolbox for the two memory-librarian agents (rem and
// deep-sleep). Both passes get the SAME surface - the difference
// between them is the seed-selection strategy upstream
// (co-occurrence batches for rem, similarity neighborhoods for
// deep-sleep), not the tool kit. Runs server-side only; the browser no
// longer carries a librarian toolbox.
//
// Shape contract vs reflection's toolbox (the other write-capable
// memory toolbox):
//
//   - memory_consolidate is the librarian's two-row content-write
//     primitive: it adopts max-confidence semantics on a merge and runs
//     a single atomic step over the four-table sequence (memories,
//     memory_conversation, memory_relations, the loser's confidence).
//     Reflection doesn't see this tool.
//
//   - memory_reshape is the librarian's one-row content-hygiene
//     primitive: rewrite a row's FRAMING (label/data) without changing
//     its facts or confidence, so encoding-time poison heals over time.
//     Distinct from memory_update by contract - it reframes, it does not
//     refine or generate.
//
//   - memory_update is ABSENT. That is reflection's / the main chat's
//     "refine a fact" verb. The librarian neither generates nor freely
//     rewrites facts; memory_reshape covers the one rewrite it is
//     allowed (framing only), so memory_update's broader contract stays
//     out.
//
//   - memory_create is ABSENT. Reinforces "librarian collapses,
//     reflection generates." No invention.
//
//   - memory_reaffirm is ABSENT. Confidence-up is a per-turn
//     volitional signal from the main chat / reflection, not the
//     librarian's role - the librarian sees the store globally and
//     would systematically inflate if it reaffirmed liberally.
//
//   - memory_invalidate, memory_doubt are PRESENT. Soft-delete and
//     gentle decay - both legitimate for "this is contradicted /
//     stale" decisions the librarian makes from cross-row evidence.
//
//   - memory_relate, memory_unrelate are PRESENT. The librarian's
//     primary graph-shaping primitives. Rem in particular treats
//     graph hygiene as a first-class operation.
//
//   - conversation_search is PRESENT for fact-checking. Same
//     rationale as the wiki librarian's inclusion.
//
//   - memory_recall is ABSENT (recursion guard, same as the other
//     memory toolboxes); memory_delete is ABSENT (background agents
//     never hard-delete).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentTool, Toolbox } from './_run.ts';
import {
  asAgentTool,
  CONVERSATION_SEARCH_WIRE_SCHEMA,
  MEMORY_DOUBT_WIRE_SCHEMA,
  MEMORY_INVALIDATE_WIRE_SCHEMA,
  MEMORY_RELATE_WIRE_SCHEMA,
  MEMORY_SEARCH_WIRE_SCHEMA,
  MEMORY_UNRELATE_WIRE_SCHEMA,
} from './_agent_tools.ts';
import { memorySearch } from '../tools/memory_search.ts';
import { memoryConsolidate } from '../tools/memory_consolidate.ts';
import { memoryReshape } from '../tools/memory_reshape.ts';
import { memoryInvalidate } from '../tools/memory_invalidate.ts';
import { memoryDoubt } from '../tools/memory_doubt.ts';
import { memoryRelate } from '../tools/memory_relate.ts';
import { memoryUnrelate } from '../tools/memory_unrelate.ts';
import { conversationSearch } from '../tools/conversation_search.ts';

// Mirror of MAX_MEMORY_DATA_CHARS in src/lib/memories.ts - the same
// cap tools/memory_consolidate.ts enforces on execute, surfaced in
// the wire schema so the model sees the limit up front.
const MAX_MEMORY_DATA_CHARS = 8000;

// Ported from the browser src/lib/tools/memory_consolidate.schema.ts.
// Librarian-only: not in reflection's toolbox and not dispatchable
// from the main chat (consolidation is a cross-row decision the
// per-turn agents shouldn't be making).
const MEMORY_CONSOLIDATE_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'memory_consolidate',
    description:
      'Collapse two memories that turned out to encode the same fact. ' +
      'The survivor keeps the supplied label and data and adopts the ' +
      'STRONGER of the two confidence values (no bump - consolidation ' +
      'preserves existing evidence rather than manufacturing new). The ' +
      "loser's confidence is halved (soft-delete via the standard " +
      'invalidate semantic; recoverable). Any memory_conversation rows ' +
      'and memory_relations edges pointing at the loser are redirected ' +
      'to the survivor, with self-loops and duplicates dropped. Use ' +
      'this only when you are confident the two rows are the same ' +
      'fact - prefer memory_relate (supports/specialises/etc.) when ' +
      'they are merely adjacent. Returns ' +
      '{survivor_id, confidence}.',
    parameters: {
      type: 'object',
      properties: {
        survivor_id: {
          type: 'string',
          description:
            'UUID of the memory that should remain (with the consolidated wording).',
        },
        loser_id: {
          type: 'string',
          description:
            'UUID of the memory to soft-delete in favor of the survivor.',
        },
        label: {
          type: 'string',
          minLength: 1,
          maxLength: 80,
          description:
            'Consolidated short name for the survivor. May reuse the survivor or loser label, ' +
            'or be a new wording that better captures both rows.',
        },
        data: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_MEMORY_DATA_CHARS,
          description:
            `Consolidated body for the survivor (max ${MAX_MEMORY_DATA_CHARS} chars). ` +
            'May combine details from both rows; should not introduce facts ' +
            'absent from both originals.',
        },
      },
      required: ['survivor_id', 'loser_id', 'label', 'data'],
      additionalProperties: false,
    },
  },
};

// memory_reshape: the librarian's narrow content-hygiene primitive.
// Rewrites a row's FRAMING (label/data) without changing its facts or
// confidence, so encoding-time poison the reflection writer baked into
// older rows ("this conversation", session narration, write-time dates)
// can heal over time instead of relying on read-time laundering forever.
// Distinct from memory_consolidate (which collapses two rows) and from
// reflection's memory_update (which generates / refines facts); see
// memory_reshape.ts for the contract.
const MEMORY_RESHAPE_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'memory_reshape',
    description:
      "Rewrite ONE memory's framing without changing the facts it " +
      'encodes. Use this ONLY to clean encoding-time poison: first-person ' +
      "session narration (\"I had to verify...\", \"PROTOCOL EXERCISED\"), " +
      '"this conversation" / "this session" / "today" phrasing, and dates ' +
      'that say WHEN the memory was written (NOT dates that are part of a ' +
      'fact). Rewrite into a timeless statement of the same facts: ' +
      'preserve every number, name, decision, metric, and fact-bearing ' +
      'date exactly; do not add, drop, or alter any fact; do not touch ' +
      "confidence. The row's real created_at already records when it was " +
      'learned. Supply the cleaned label and/or data plus a one-line ' +
      'message for the changelog. Returns the updated row.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'UUID of the memory to reshape.',
        },
        label: {
          type: 'string',
          minLength: 1,
          maxLength: 80,
          description:
            'Cleaned short name (omit to leave the label unchanged).',
        },
        data: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_MEMORY_DATA_CHARS,
          description:
            `Cleaned body, same facts, no write-time framing (max ${MAX_MEMORY_DATA_CHARS} ` +
            'chars; omit to leave the body unchanged). Provide at least one ' +
            'of label or data.',
        },
        message: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description:
            'One-line, commit-style note of what framing you cleaned. ' +
            'Lands in the memory changelog the user reviews.',
        },
      },
      required: ['id', 'message'],
      additionalProperties: false,
    },
  },
};

export function buildMemoryLibrarianToolbox(): Toolbox {
  return {
    name: 'memory-librarian',
    tools: [
      asAgentTool(memorySearch, MEMORY_SEARCH_WIRE_SCHEMA),
      asAgentTool(memoryConsolidate, MEMORY_CONSOLIDATE_WIRE_SCHEMA),
      asAgentTool(memoryReshape, MEMORY_RESHAPE_WIRE_SCHEMA),
      asAgentTool(memoryInvalidate, MEMORY_INVALIDATE_WIRE_SCHEMA),
      asAgentTool(memoryDoubt, MEMORY_DOUBT_WIRE_SCHEMA),
      asAgentTool(memoryRelate, MEMORY_RELATE_WIRE_SCHEMA),
      asAgentTool(memoryUnrelate, MEMORY_UNRELATE_WIRE_SCHEMA),
      asAgentTool(conversationSearch, CONVERSATION_SEARCH_WIRE_SCHEMA),
    ],
  };
}

// ---------------------------------------------------------------------------
// Shared in-flight guard. ONE guard for both passes on purpose: rem
// and deep-sleep reason over the same memory rows, and two agents
// consolidating the same neighborhood concurrently would make
// conflicting decisions. The server-side successor to the browser
// workers' shared 'memory-librarian' lease partition, now also
// covering the manual-run routes the browser only guarded per-tab.
// ---------------------------------------------------------------------------

/**
 * Guard TTL. Generous enough to cover a full librarian pass (several
 * Venice round-trips per conversation/neighborhood); a crashed run's
 * guard lapses rather than wedging both librarians forever.
 */
const MEMORY_LIBRARIAN_INFLIGHT_TTL_SECONDS = 600;

export async function claimMemoryLibrarianInflight(
  adminClient: SupabaseClient,
  userId: string,
  holderId: string,
): Promise<boolean> {
  const { data, error } = await adminClient.rpc('claim_memory_librarian_inflight', {
    p_holder_id: holderId,
    p_ttl_seconds: MEMORY_LIBRARIAN_INFLIGHT_TTL_SECONDS,
    p_user_id: userId,
  });
  if (error) throw new Error(`claim_memory_librarian_inflight failed: ${error.message}`);
  return data === true;
}

export async function releaseMemoryLibrarianInflight(
  adminClient: SupabaseClient,
  userId: string,
  holderId: string,
): Promise<void> {
  const { error } = await adminClient.rpc('release_memory_librarian_inflight', {
    p_holder_id: holderId,
    p_user_id: userId,
  });
  // Best-effort: a failed release leaves the TTL to sweep the guard.
  if (error) {
    console.error(
      `[memory-librarian] release_memory_librarian_inflight failed: ${error.message}`,
    );
  }
}
