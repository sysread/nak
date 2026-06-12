// Reflection agent (function-side port of src/lib/agents/reflection/).
//
// Reflection turns a finished conversation into long-term memory: it
// reads the thread, then uses the agent-only memory toolbox (soft-decay,
// never hard-delete) to create/update/invalidate memories about the
// user. The model's final text is discarded - the memory_* side effects
// ARE the output.
//
// Drive shape - it drains OLDER threads, not "this" one. This module is
// fired from getStreamingResponse's terminal tail (via edgeWaitUntil)
// once per completed chat turn, but it does NOT reflect the thread that
// just finished. claim_next_thread_for_reflection only claims a thread
// whose newest message lands on a PRIOR calendar day in the user's
// timezone and that carries >= 2 user messages. So each turn-completion
// opportunistically drains ONE reflection-eligible thread from the
// existing day-gated queue. The day-gate exists because memory_recall
// has no per-conversation source attribution: a memory derived from a
// half-finished thought must not ride straight back into the same
// conversation that produced it. Faithful to the browser supervisor's
// behaviour (same queue, same gate); only the driver changed from a
// supervisor poll to a chat-activity piggyback.
//
// No lease coordinator. The browser ran reflection under a
// LeaseCoordinator so that only one of several open tabs/devices drove
// the supervisor at a time. Server-side that coordination is moot: the
// claim RPC's atomic per-thread claim+TTL IS the mutual exclusion. Two
// concurrent edge invocations that both call claim simply get two
// different threads (or one gets none) - more reflection throughput, not
// a correctness problem. So this module claims with a fresh per-call
// holder id and skips the lease machinery entirely.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger } from '../../_shared/edge-log.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import {
  asAgentTool,
  loadThreadSliceUpTo,
  MEMORY_DOUBT_WIRE_SCHEMA,
  MEMORY_INVALIDATE_WIRE_SCHEMA,
  MEMORY_RELATE_WIRE_SCHEMA,
  MEMORY_SEARCH_WIRE_SCHEMA,
  MEMORY_UNRELATE_WIRE_SCHEMA,
} from './_agent_tools.ts';
import { memorySearch } from '../tools/memory_search.ts';
import { memoryCreate } from '../tools/memory_create.ts';
import { memoryUpdate } from '../tools/memory_update.ts';
import { memoryInvalidate } from '../tools/memory_invalidate.ts';
import { memoryReaffirm } from '../tools/memory_reaffirm.ts';
import { memoryDoubt } from '../tools/memory_doubt.ts';
import { memoryRelate } from '../tools/memory_relate.ts';
import { memoryUnrelate } from '../tools/memory_unrelate.ts';
import {
  runHeadlessAgent,
  type AgentTool,
  type AgentToolContext,
  type Toolbox,
} from './_run.ts';
import {
  messageToVenice,
  type VeniceWireMessage,
} from './_recall_helpers.ts';

// Mirror of agentModel('reflection').id in src/lib/models/index.ts.
// AGENT_MODELS is a static role->model map, NOT one of the per-user
// configurable tiers, so the browser path resolved this same constant -
// hardcoding it here stays faithful after the cutover.
const REFLECTION_MODEL = 'tencent-hy3-preview';

// 600s matches the other fleets' claim TTLs (wiki, librarian). The
// browser-era 120s looked generous but a substantial thread's
// reflection (several Venice round-trips plus memory tool calls)
// routinely outlives it - and a run that outlives its claim ALWAYS
// finishes claim-lost, so the thread re-reflects every cycle and
// never marks. The TTL must comfortably exceed the slowest plausible
// run; the only cost of a long TTL is how late a crashed run's
// thread becomes claimable again.
const REFLECTION_CLAIM_TTL_SECONDS = 600;

// Schema caps mirror supabase/functions/venice/tools/memory_*.ts so the
// wire schemas the agent's model sees match the server-side validators'
// limits. (8000 / 200 / 80 are the same numbers those tools enforce on
// execute.)
const MAX_MEMORY_DATA_CHARS = 8000;
const MAX_MEMORY_CHANGELOG_MESSAGE_CHARS = 200;
const MAX_MEMORY_LABEL_CHARS = 80;

// ---------------------------------------------------------------------------
// Wire schemas for the reflection-only third of the memory toolbox.
// Ported from the browser src/lib/tools/memory_*.schema.ts so the
// reflection model gets the same tool contracts regardless of which
// path drove it. The invalidate/doubt/relate/unrelate wires live in
// _agent_tools.ts (the memory librarians share them); create/update/
// reaffirm stay here because reflection is the only agent allowed to
// generate or bump - "librarian collapses, reflection generates."
// This is the soft-decay set: memory_invalidate (halve confidence)
// stands in for memory_delete (hard erase) so a background agent can
// never destroy a memory row on its own authority.
// ---------------------------------------------------------------------------

const MEMORY_CREATE_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'memory_create',
    description:
      'Save a new memory. Three required fields: label (short handle, ' +
      `1-${MAX_MEMORY_LABEL_CHARS} chars), data (the full content, max ` +
      `${MAX_MEMORY_DATA_CHARS} chars - split if longer), and message (a ` +
      'one-line, commit-style summary of what you saved and why, which ' +
      'lands in the memory changelog the user reviews). Optional ' +
      'confidence (1.0..10.0, default 1.0) marks a memory as already-' +
      'corroborated; raise above default only with converging evidence ' +
      'in the current exchange. Returns the created memory row.',
    parameters: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_MEMORY_LABEL_CHARS,
          description: 'Required. Short name for the memory.',
        },
        data: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_MEMORY_DATA_CHARS,
          description: `Required. Full content (max ${MAX_MEMORY_DATA_CHARS} chars).`,
        },
        message: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_MEMORY_CHANGELOG_MESSAGE_CHARS,
          description:
            'Required. One-line, commit-style summary of what this memory ' +
            'captures and why you saved it. Lands in the memory changelog.',
        },
        confidence: {
          type: 'number',
          minimum: 1.0,
          maximum: 10.0,
          description:
            'Optional initial confidence (1.0..10.0, default 1.0). ' +
            'Raise only with converging evidence in the current exchange.',
        },
      },
      required: ['label', 'data', 'message'],
      additionalProperties: false,
    },
  },
};

const MEMORY_UPDATE_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'memory_update',
    description:
      'Update a memory by id (use memory_search to find the id). Two ' +
      'required fields: id, and message (a one-line, commit-style summary ' +
      'of what changed and why, which lands in the memory changelog the ' +
      'user reviews). Then provide at least one of label or data to ' +
      `change (data capped at ${MAX_MEMORY_DATA_CHARS} chars); omit ` +
      'either to leave it unchanged. Returns the updated row.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Required. UUID of the memory (from memory_search).',
        },
        message: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_MEMORY_CHANGELOG_MESSAGE_CHARS,
          description:
            'Required. One-line, commit-style summary of what changed and ' +
            'why. Lands in the memory changelog.',
        },
        label: { type: 'string', minLength: 1, maxLength: MAX_MEMORY_LABEL_CHARS },
        data: { type: 'string', minLength: 1, maxLength: MAX_MEMORY_DATA_CHARS },
      },
      required: ['id', 'message'],
      additionalProperties: false,
    },
  },
};


const MEMORY_REAFFIRM_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'memory_reaffirm',
    description:
      "Add 0.5 to a memory's confidence (capped at 10.0) when the " +
      'current exchange corroborates it or you just used it ' +
      'successfully. Returns {id, confidence} post-bump.',
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




// Reflection's user-turn instruction. Verbatim port of REFLECTION_PROMPT
// in src/lib/agents/reflection/prompt.ts so the model gets identical
// guidance whichever path triggered it. ASCII em-dashes in the browser
// original are preserved here to keep the two literals diff-identical;
// this is the one place the repo's ASCII-only rule yields to "the prompt
// text must match the browser byte-for-byte." (Smart punctuation in a
// prompt is invisible to the model and harmless; a drift between the two
// copies during the migration window is the real risk.)
const REFLECTION_PROMPT = `You've just finished the conversation above. Now step out of that
role. You're not talking to the user anymore — nobody will read this
reply. Your job is to update long-term memory based on what
happened, using the memory tools below.

Think about:

- **Facts about the user** — name, work, tools, projects, preferences,
  constraints. Concrete, reusable information.
- **Personality signals** — pay special attention here. How they
  communicate (terse vs expansive, formal vs casual, blunt vs
  hedged), the tone they use and the tone they want back, their sense
  of humor, what they value, and what frustrates or delights them.
  This is who they are, not just what they asked for.
- **Reactions to you** — pay special attention here too. How did they
  respond to your answers AND to your tone? Did they push back, agree,
  redirect, go quiet, warm up, or get short with you? Did a particular
  phrasing, level of detail, or register land well or badly? When a
  response visibly worked or visibly missed, capture what about it did
  — that is the highest-signal data about what works with this person.
- **Self-guidance** — short notes to your future self, in the voice
  of a coach. "This user prefers terse answers." "Don't assume
  they want code examples without asking." "They appreciate when
  you name the tradeoff rather than defaulting to a recommendation."
  "Match their dry tone — eager cheerfulness reads as noise to them."

The personality and reaction signals are the easiest to overlook and
the most valuable to get right — fact extraction is the floor, not the
goal. A future turn improves more from knowing how this person likes
to be talked to than from another stored fact.

Workflow for each memory you consider writing:

1. Call memory_search with a related query FIRST. Check whether a
   similar memory already exists.
2. If one exists and your new insight is a refinement, call
   memory_update on it (which also bumps confidence — corroborated
   memories rank higher). Don't create a near-duplicate.
3. If a new insight contradicts an existing memory, call
   memory_invalidate on the stale one. This doesn't delete it, it
   halves its confidence so search stops surfacing it. Repeated
   invalidation hides it entirely. Recoverable if you re-learn the
   fact later.
4. Only call memory_create when nothing close exists.

Be conservative. Fewer high-signal memories beat many low-signal
ones. Don't record the obvious ("the user asked a question"),
ephemeral details that only matter for one conversation, or
anything that reads like a summary of what was already said.

When you have nothing more to write, reply with a single word. The
word is discarded — only the tool calls matter.`;

function buildReflectionToolbox(): Toolbox {
  return {
    name: 'reflection',
    tools: [
      asAgentTool(memorySearch, MEMORY_SEARCH_WIRE_SCHEMA),
      asAgentTool(memoryCreate, MEMORY_CREATE_WIRE_SCHEMA),
      asAgentTool(memoryUpdate, MEMORY_UPDATE_WIRE_SCHEMA),
      asAgentTool(memoryInvalidate, MEMORY_INVALIDATE_WIRE_SCHEMA),
      asAgentTool(memoryReaffirm, MEMORY_REAFFIRM_WIRE_SCHEMA),
      asAgentTool(memoryDoubt, MEMORY_DOUBT_WIRE_SCHEMA),
      asAgentTool(memoryRelate, MEMORY_RELATE_WIRE_SCHEMA),
      asAgentTool(memoryUnrelate, MEMORY_UNRELATE_WIRE_SCHEMA),
    ],
  };
}

/**
 * Resolve the user's display timezone for the day-gate. Stored in
 * profiles.settings.displayTimezone (Settings -> AI -> About you).
 * Falls back to UTC, matching the claim RPC's own p_timezone default.
 */
async function loadDisplayTimezone(
  adminClient: SupabaseClient,
  userId: string,
): Promise<string> {
  const { data, error } = await adminClient
    .from('profiles')
    .select('settings')
    .eq('user_id', userId)
    .maybeSingle<{ settings: Record<string, unknown> | null }>();
  if (error || !data?.settings) return 'UTC';
  const tz = data.settings.displayTimezone;
  return typeof tz === 'string' && tz.length > 0 ? tz : 'UTC';
}

/** Outcome of one reflectOneThread cycle, for the caller's diagnostic log. */
export interface ReflectionCycleResult {
  outcome: 'no-thread' | 'empty-slice' | 'reflected' | 'claim-lost' | 'error';
  threadId?: string;
  toolCalls?: number;
}

/**
 * Run one reflection cycle for `userId`: claim the oldest day-gate-
 * eligible thread, reflect on it, mark it done. A no-op when the queue
 * is empty. Best-effort and NON-throwing by contract - the caller fires
 * this from a chat turn's background tail and must not let a reflection
 * failure touch the turn's recorded outcome, so every failure path is
 * caught here, logged, and folded into an `error` result. Progress is
 * logged through an edge logger so the browser Logs drawer sees the
 * cycle even though it runs server-side; flush() at the end guarantees
 * the final line lands before the waitUntil tail tears down.
 */
export async function reflectOneThread(
  adminClient: SupabaseClient,
  userId: string,
): Promise<ReflectionCycleResult> {
  const log = createEdgeLogger(userId, 'reflection');
  try {
    const timezone = await loadDisplayTimezone(adminClient, userId);
    // Fresh holder per call - see the no-lease rationale in the file
    // preamble. The claim+mark pair share this one holder; nothing else
    // needs to recognise it.
    const holderId = crypto.randomUUID();

    // Claim atomically. p_user_id is the b-strict escape hatch: the
    // service-role admin client has no auth.uid(), so the RPC scopes to
    // the thread owner via coalesce(p_user_id, auth.uid()).
    const { data: claimRows, error: claimErr } = await adminClient.rpc(
      'claim_next_thread_for_reflection',
      {
        p_holder_id: holderId,
        p_ttl_seconds: REFLECTION_CLAIM_TTL_SECONDS,
        p_timezone: timezone,
        p_user_id: userId,
      },
    );
    if (claimErr) {
      throw new Error(`claim_next_thread_for_reflection failed: ${claimErr.message}`);
    }
    const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
    if (!claim || typeof claim.thread_id !== 'string') {
      // Routine: the day-gated queue is empty on most turns. trace tier
      // so it's available when actively watching but stays out of the
      // default drawer view.
      log.trace('no reflection-eligible thread to drain this turn');
      return { outcome: 'no-thread' };
    }
    const threadId = claim.thread_id as string;
    const terminalMsgId = claim.terminal_msg_id as string;
    return await reflectClaimedThread(
      adminClient,
      userId,
      log,
      threadId,
      terminalMsgId,
      holderId,
    );
  } catch (err) {
    log.error(
      'reflection cycle failed',
      err instanceof Error ? err : new Error(String(err)),
    );
    return { outcome: 'error' };
  } finally {
    // Flush before the waitUntil tail settles so the outcome line (the
    // one worth seeing) isn't dropped as an un-awaited broadcast.
    await log.flush();
  }
}

/**
 * The run half shared by both reflection drivers (the chat-turn tail
 * and the cron catch-up sweep): the caller already holds the
 * per-thread claim; this reflects the thread and marks it done.
 * Throws on infrastructure failure - each driver owns its own
 * catch/log/flush posture.
 */
async function reflectClaimedThread(
  adminClient: SupabaseClient,
  userId: string,
  log: ReturnType<typeof createEdgeLogger>,
  threadId: string,
  terminalMsgId: string,
  holderId: string,
): Promise<ReflectionCycleResult> {
  log.info(`picked up thread ${threadId} @ msg ${terminalMsgId}`);

  const slice = await loadThreadSliceUpTo(adminClient, threadId, terminalMsgId);

  // Pathological empty thread: mark it done so the queue advances
  // rather than re-claiming the same row forever. Skip the Venice
  // round-trip.
  if (slice.length > 0) {
    const apiKey = await readVeniceKey(adminClient);
    if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

    const convo: VeniceWireMessage[] = slice.map(messageToVenice);
    // Reflection instruction as the final user turn - the "switch
    // modes" idiom. The model sees the whole prior conversation in its
    // native shape and reads this as "now do this different task."
    convo.push({ role: 'user', content: REFLECTION_PROMPT });

    const baseCtx: Omit<AgentToolContext, 'signal' | 'depth'> = {
      adminClient,
      userId,
      threadId,
    };

    const result = await runHeadlessAgent(
      {
        model: REFLECTION_MODEL,
        messages: convo,
        toolbox: buildReflectionToolbox(),
        baseCtx,
        apiKey,
        // Hy3 defaults to high reasoning_effort. Cap it at 'low' here:
        // reflection runs a multi-round memory-write loop and the final
        // text is discarded, so a short grounding pass is enough - high-
        // effort CoT on every round would multiply token cost for no
        // gain in the tool-call decisions that ARE the output.
        reasoningEffort: 'low',
        // No outer turn to cancel - reflection runs in a background
        // tail or a cron tick, after any user-visible work already
        // shipped. A never-aborting signal lets runHeadlessAgent run
        // to its own maxRounds backstop.
        signal: new AbortController().signal,
      },
      // parentDepth 0: reflection is a top-level agent (depth 1), same
      // as the main chat's tool-dispatched agents.
      0,
    );

    // Mark only after the agent finished. A false return means the
    // claim expired or was stolen mid-run (claim-lost): any memory
    // writes the agent already made stay - they're owned by the user,
    // not the claim - and the next cycle re-reflects, finding its own
    // writes via memory_search rather than duplicating.
    const marked = await markReflected(adminClient, threadId, holderId, terminalMsgId, userId);
    if (marked) {
      log.info(
        `finished thread ${threadId} (${result.toolCalls} tool calls over ${slice.length} messages)`,
      );
    } else {
      log.warn(
        `claim lost on thread ${threadId} - another run took over mid-reflection; any memories already written stay`,
      );
    }
    return {
      outcome: marked ? 'reflected' : 'claim-lost',
      threadId,
      toolCalls: result.toolCalls,
    };
  }

  const marked = await markReflected(adminClient, threadId, holderId, terminalMsgId, userId);
  log.debug(`thread ${threadId} had no messages to reflect on; marked to advance the queue`);
  return { outcome: marked ? 'empty-slice' : 'claim-lost', threadId };
}

/**
 * One cron catch-up tick: claim the most-overdue reflection-eligible
 * thread across ALL users and reflect on it. The chat-turn tail is
 * reflection's primary driver but only fires when its owner
 * converses; this sweep drains queues the tail can't reach. One
 * thread per tick - the hourly schedule resumes the drain, matching
 * the other fleets' pacing. Double-driving with the tail is safe:
 * the per-thread claim columns are the mutual exclusion, so
 * whichever driver claims first wins. Non-throwing, same contract
 * as reflectOneThread.
 */
export async function runReflectionSweepTick(
  adminClient: SupabaseClient,
): Promise<ReflectionCycleResult> {
  const holderId = crypto.randomUUID();
  let claim: { thread_id?: unknown; terminal_msg_id?: unknown; user_id?: unknown } | null;
  try {
    const { data, error } = await adminClient.rpc(
      'claim_next_thread_for_reflection_sweep',
      { p_holder_id: holderId, p_ttl_seconds: REFLECTION_CLAIM_TTL_SECONDS },
    );
    if (error) {
      throw new Error(`claim_next_thread_for_reflection_sweep failed: ${error.message}`);
    }
    claim = Array.isArray(data) ? data[0] : data;
  } catch (err) {
    console.error(
      '[reflection-sweep] claim failed:',
      err instanceof Error ? err.message : String(err),
    );
    return { outcome: 'error' };
  }
  if (!claim || typeof claim.thread_id !== 'string' || typeof claim.user_id !== 'string') {
    return { outcome: 'no-thread' };
  }

  // The logger exists only from here - a claim is what tells us WHOSE
  // drawer the lines belong in.
  const log = createEdgeLogger(claim.user_id, 'reflection');
  try {
    return await reflectClaimedThread(
      adminClient,
      claim.user_id,
      log,
      claim.thread_id,
      claim.terminal_msg_id as string,
      holderId,
    );
  } catch (err) {
    log.error(
      'reflection sweep cycle failed',
      err instanceof Error ? err : new Error(String(err)),
    );
    return { outcome: 'error' };
  } finally {
    await log.flush();
  }
}

async function markReflected(
  adminClient: SupabaseClient,
  threadId: string,
  holderId: string,
  terminalMsgId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await adminClient.rpc('mark_thread_reflected_if_claimed', {
    p_thread_id: threadId,
    p_holder_id: holderId,
    p_msg_id: terminalMsgId,
    p_user_id: userId,
  });
  if (error) {
    throw new Error(`mark_thread_reflected_if_claimed failed: ${error.message}`);
  }
  return data === true;
}

// Test-only surface. The toolbox composition (soft-decay set, no
// memory_delete, no ask_user) is a safety invariant - background agents
// must never hard-delete or reach for a UI tool - so it gets its own
// assertion in supabase/functions/tests/reflection.test.ts.
export const __test = { buildReflectionToolbox };
