// Reflection agent (function-side port of src/lib/agents/reflection/).
//
// Reflection turns a finished conversation into long-term memory: it
// reads the thread, then uses the agent-only memory toolbox (soft-decay,
// never hard-delete) to create/update/invalidate memories about the
// user. The model's final text is discarded - the memory_* side effects
// ARE the output.
//
// Drive shape - the hourly cron sweep is the ONLY driver. Each tick
// drains the day-gated queue one thread at a time (claim -> reflect ->
// claim the next) until the queue is empty, the per-tick cap is hit,
// or the tick's time budget runs out; the next hourly tick resumes.
// The sweep claim only offers a thread whose newest message lands on a
// PRIOR calendar day in the owner's timezone and that carries >= 2
// user messages. The day-gate exists because memory_recall has no
// per-conversation source attribution: a memory derived from a
// half-finished thought must not ride straight back into the same
// conversation that produced it. Reflection deliberately does NOT ride
// the chat turn's waitUntil tail the way curation and samskara do:
// memory formation gets a fixed, predictable cadence (edit or retry a
// conversation any time before the next hourly tick after midnight and
// reflection only ever sees the corrected thread), and the queue
// drains for dormant users at the same rate as active ones.
//
// No lease coordinator, and no global singleton guard. The claim RPC's
// atomic per-thread claim+TTL IS the mutual exclusion: two overlapping
// ticks that both call claim simply get two different threads (or one
// gets none). Within a tick the drain loop is strictly sequential, so
// at most one reflection agent per tick is writing to the memory store
// at a time - which is what keeps near-simultaneous duplicate writes
// unlikely without any cross-invocation coordination.

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
import { MAX_MEMORY_DATA_CHARS } from '../tools/_memory_data_budget.ts';
import { memorySave } from '../tools/memory_save.ts';
import { memoryInvalidate } from '../tools/memory_invalidate.ts';
import { memoryReaffirm } from '../tools/memory_reaffirm.ts';
import { memoryDoubt } from '../tools/memory_doubt.ts';
import { memoryRelate } from '../tools/memory_relate.ts';
import { memoryUnrelate } from '../tools/memory_unrelate.ts';
import { followupList } from '../tools/followup_list.ts';
import { followupSave } from '../tools/followup_save.ts';
import { followupClose } from '../tools/followup_close.ts';
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
import { REFLECTION_MODEL } from '../../_shared/agent-models.ts';

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
// limits. (200 / 80 are the same numbers those tools enforce on execute;
// the data cap is single-sourced from _memory_data_budget.ts.)
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

// Deliberately narrower than the chat canonical
// (src/lib/tools/memory_save.schema.ts): the reflection toolbox does
// not expose the direct confidence set. A background agent moving
// confidence only through the graded levers
// (reaffirm/doubt/invalidate) cannot systematically inflate the store;
// the direct set is reserved for the chat model acting on an explicit
// user instruction. id is always required here - reflection edits
// existing memories; wholesale invention is the librarian's job, and
// fresh saves of near-duplicates are guarded by the workflow text
// below.
const MEMORY_SAVE_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'memory_save',
    description:
      'Save a memory: update an existing one by id. Only id ' +
      'is required. Provide at least one of label or data to change; any ' +
      'field you omit is left unchanged ' +
      `(data capped at ${MAX_MEMORY_DATA_CHARS} chars, and never ` +
      'longer than the body you are replacing - a refine tightens or holds ' +
      'steady, it does not accrete). Optional message is a one-line, ' +
      'commit-style summary of what changed and why, which lands in the ' +
      'memory changelog the user reviews; omit it to auto-derive one from ' +
      'the label. This tool does NOT change confidence - use ' +
      'memory_reaffirm or memory_doubt for that. Returns the updated row.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Required. UUID of the memory (from memory_search).',
        },
        label: { type: 'string', minLength: 1, maxLength: MAX_MEMORY_LABEL_CHARS },
        data: { type: 'string', minLength: 1, maxLength: MAX_MEMORY_DATA_CHARS },
        message: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_MEMORY_CHANGELOG_MESSAGE_CHARS,
          description:
            'Optional. One-line, commit-style summary of what changed and ' +
            'why; lands in the memory changelog. Omit to auto-derive from ' +
            'the label.',
        },
      },
      required: ['id'],
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




// ---------------------------------------------------------------------------
// Wire schemas for the follow-up verbs. Reflection is the ONLY
// background agent with follow-up tools (docs/dev/followups.md,
// "single background writer") - it is the settled-thread backstop for
// both capture and resolution, so it carries list (dedup evidence),
// create, update (reschedule), and close. No dismiss: dismissal is the
// user's veto, expressed live in chat, never inferred from a
// transcript. Caps mirror _shared/followups.ts.
// ---------------------------------------------------------------------------

const MAX_FOLLOWUP_QUESTION_CHARS = 200;
const MAX_FOLLOWUP_CONTEXT_CHARS = 500;
const MAX_FOLLOWUP_RESOLUTION_CHARS = 500;

const FOLLOWUP_LIST_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'followup_list',
    description:
      'List saved follow-ups: open questions to ask the user later ' +
      '(with ids and relevant_after dates) plus recently closed ones ' +
      'with their resolutions. ALWAYS call this before a follow-up save ' +
      '- a question already open, answered, or dismissed must not be ' +
      'created again.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

const FOLLOWUP_SAVE_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'followup_save',
    description:
      'Save a follow-up: a question whose outcome is unknown and worth ' +
      'asking the user in a future conversation ("Ask how the lasagna ' +
      'turned out"). Omit id to create one; pass id (from followup_list) ' +
      'to revise or reschedule an open follow-up when the conversation ' +
      'shows the plan MOVED rather than resolved - a string relevant_after ' +
      'reschedules, null clears the date. Provide at least one of ' +
      'question, context, or relevant_when revising. Only open ' +
      'follow-ups can be revised.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'Required when revising. From followup_list. Omit to create.',
        },
        question: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_FOLLOWUP_QUESTION_CHARS,
          description:
            'Required on create. First-person prompt to the future self.',
        },
        context: {
          type: 'string',
          maxLength: MAX_FOLLOWUP_CONTEXT_CHARS,
          description: 'One or two lines of seeding context.',
        },
        relevant_after: {
          type: ['string', 'null'],
          description:
            'Optional ISO date/timestamp just AFTER the event; omit when ' +
            'no date is known. On revise: a string reschedules, null ' +
            'clears the date.',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
};

const FOLLOWUP_CLOSE_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'followup_close',
    description:
      'Mark an open follow-up answered when the conversation contains ' +
      'its outcome. resolution is a one-line record of the answer.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Required. From followup_list.' },
        resolution: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_FOLLOWUP_RESOLUTION_CHARS,
          description: 'Required. One line on what the answer was.',
        },
      },
      required: ['id', 'resolution'],
      additionalProperties: false,
    },
  },
};

// Reflection's user-turn instruction. Runs server-side only - the
// browser no longer carries a reflection prompt module. The em-dashes
// below are grandfathered from the browser-era original; they're
// invisible to the model, so they stay rather than churn the literal.
// New lines use ASCII per the repo default.
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

Write memories timeless. A memory is read back weeks or months later
and must read true THEN, not just today. The store records when it
learned each fact on its own, so:

- Don't anchor a memory to the moment you wrote it. No "this
  conversation", "this session", "today", or "just now", and no date
  whose only job is to stamp when you learned the fact. State the fact
  itself - "the user reduced besan to 25g and it worked", not "BESAN
  UPDATE (this session): reduced besan to 25g". Keep a date only when
  it is part of the fact (an event, a deadline, a milestone).
- Don't narrate yourself or the exchange. Write a fact about the user,
  not a log of this turn - "the user double-checks claims against
  primary sources" not "EVIDENCE-CHECKING PROTOCOL EXERCISED this
  conversation: I had to verify my claim". Drop "what I got wrong",
  "I had to", "this validates".

Workflow for each memory you consider writing:

1. Call memory_search with a related query FIRST. Check whether a
   similar memory already exists.
2. If one exists and your new insight is a refinement, call
   memory_save on it (with its id) rather than creating a
   near-duplicate. The edit form only rewrites the wording - it does
   NOT change confidence. If the exchange genuinely corroborates the
   memory, call memory_reaffirm to nudge its confidence up.
3. If a new insight contradicts an existing memory, call
   memory_invalidate on the stale one. This doesn't delete it, it
   halves its confidence so search stops surfacing it. Repeated
   invalidation hides it entirely. Recoverable if you re-learn the
   fact later.
4. Only create (memory_save without an id) when nothing close
   exists.

Be conservative. Fewer high-signal memories beat many low-signal
ones. Don't record the obvious ("the user asked a question"),
ephemeral details that only matter for one conversation, or
anything that reads like a summary of what was already said.

Separately from memories, maintain the FOLLOW-UPS - the open
questions saved for future conversations, whose outcomes are not
yet known. Call followup_list once, then reconcile it against this
conversation:

- If the conversation contains the OUTCOME of an open follow-up
  (the user reported how it went, asked or unprompted), call
  followup_close with a one-line resolution. If the outcome is
  worth remembering long-term, also record it through the memory
  workflow above - the resolution line is an audit stamp, not a
  memory.
- If a plan behind an open follow-up MOVED (postponed, rescheduled,
  reshaped), call followup_save with that follow-up's id - new
  relevant_after, reworded question if needed. A moved plan is not a
  new follow-up.
- If the user shared a NEW plan or upcoming event with a real "how
  did it go" horizon they clearly care about, and no matching
  follow-up is open OR already answered/dismissed in the list, call
  followup_save without an id. When a date is known, set relevant_after just
  after it; with no date, omit it. The already-answered check
  matters: you may be reading an old conversation whose plan was
  resolved elsewhere since - a resolved plan must not get a fresh
  follow-up.
- Be conservative here too. One or two genuine open loops beat a
  backlog of nags; skip plans mentioned in passing.

When you have nothing more to write, reply with a single word. The
word is discarded — only the tool calls matter.`;

function buildReflectionToolbox(): Toolbox {
  return {
    name: 'reflection',
    tools: [
      asAgentTool(memorySearch, MEMORY_SEARCH_WIRE_SCHEMA),
      asAgentTool(memorySave, MEMORY_SAVE_WIRE_SCHEMA),
      asAgentTool(memoryInvalidate, MEMORY_INVALIDATE_WIRE_SCHEMA),
      asAgentTool(memoryReaffirm, MEMORY_REAFFIRM_WIRE_SCHEMA),
      asAgentTool(memoryDoubt, MEMORY_DOUBT_WIRE_SCHEMA),
      asAgentTool(memoryRelate, MEMORY_RELATE_WIRE_SCHEMA),
      asAgentTool(memoryUnrelate, MEMORY_UNRELATE_WIRE_SCHEMA),
      asAgentTool(followupList, FOLLOWUP_LIST_WIRE_SCHEMA),
      asAgentTool(followupSave, FOLLOWUP_SAVE_WIRE_SCHEMA),
      asAgentTool(followupClose, FOLLOWUP_CLOSE_WIRE_SCHEMA),
    ],
  };
}

/** Outcome of one claim+reflect cycle inside a sweep tick's drain loop. */
interface ReflectionCycleResult {
  outcome: 'no-thread' | 'empty-slice' | 'reflected' | 'claim-lost' | 'error';
  threadId?: string;
  toolCalls?: number;
}

/**
 * The run half of one drain cycle: the caller already holds the
 * per-thread claim; this reflects the thread and marks it done.
 * Throws on infrastructure failure - the cycle wrapper owns the
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
        // The model's default reasoning effort is high; this task needs a
        // light pass at most, and an unpinned effort burns latency and
        // output budget on long inputs (see CLAUDE.md, Venice sub-completions).
        reasoningEffort: 'low',
        messages: convo,
        toolbox: buildReflectionToolbox(),
        baseCtx,
        apiKey,
        // No outer turn to cancel - reflection runs in a cron tick,
        // never on a user-visible path. A never-aborting signal lets
        // runHeadlessAgent run to its own maxRounds backstop.
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
 * Per-tick thread cap for the sweep's drain loop. Bounds one tick's
 * worst-case Venice spend; a backlog deeper than the cap drains
 * across successive hourly ticks. Sequential on purpose - one
 * reflection agent writing to the memory store at a time keeps
 * near-simultaneous duplicate writes unlikely.
 */
const REFLECTION_SWEEP_MAX_THREADS = 5;

/**
 * Wall-clock cutoff for claiming ANOTHER thread within one tick. The
 * hosted edge runtime kills an isolate at roughly 400s (see
 * DEEP_SLEEP_BUDGET_MS in deep_sleep.ts for the fuller story), so a
 * loop that kept claiming until empty would compound several long
 * reflections into a guaranteed mid-flight death. Stopping new claims
 * at 180s leaves a reflection claimed at the cutoff over 200s to
 * finish - most do. One that doesn't dies exactly as it would have
 * under a single-claim tick, and the attempt cap (3 claims per
 * terminal message) keeps such a thread from wedging the queue.
 */
const REFLECTION_SWEEP_BUDGET_MS = 180_000;

/** What one sweep tick did, and why its drain loop stopped. */
export interface ReflectionSweepSummary {
  reflected: number;
  claimLost: number;
  emptySlice: number;
  stoppedBy: 'empty-queue' | 'cap' | 'budget' | 'error';
}

/**
 * One cron tick: drain the reflection queue across ALL users, one
 * thread at a time - claim the most-overdue eligible thread, reflect
 * it, claim the next - until the queue is empty, the per-tick cap is
 * hit, or the time budget is spent. The hourly schedule resumes the
 * drain. This is reflection's ONLY driver (see the file preamble for
 * why it does not ride the chat turn's tail). Non-throwing: cycle
 * failures are folded into the summary, and an `error` cycle stops
 * the loop rather than hot-looping a broken dependency.
 */
export async function runReflectionSweepTick(
  adminClient: SupabaseClient,
): Promise<ReflectionSweepSummary> {
  const startedAt = Date.now();
  const summary: ReflectionSweepSummary = {
    reflected: 0,
    claimLost: 0,
    emptySlice: 0,
    stoppedBy: 'cap',
  };
  for (let i = 0; i < REFLECTION_SWEEP_MAX_THREADS; i++) {
    // The first cycle always runs regardless of the budget - a tick
    // must make at least one unit of progress, same guarantee the
    // old single-claim tick gave.
    if (i > 0 && Date.now() - startedAt > REFLECTION_SWEEP_BUDGET_MS) {
      summary.stoppedBy = 'budget';
      return summary;
    }
    const cycle = await sweepClaimAndReflectOnce(adminClient);
    switch (cycle.outcome) {
      case 'no-thread':
        summary.stoppedBy = 'empty-queue';
        return summary;
      case 'error':
        summary.stoppedBy = 'error';
        return summary;
      case 'reflected':
        summary.reflected += 1;
        break;
      case 'claim-lost':
        // Another tick's claim outlived ours mid-run; the queue may
        // still hold more work, so keep draining.
        summary.claimLost += 1;
        break;
      case 'empty-slice':
        summary.emptySlice += 1;
        break;
    }
  }
  return summary;
}

/**
 * One drain cycle: claim the most-overdue reflection-eligible thread
 * across all users and reflect it. Non-throwing; every failure path
 * folds into an `error` result for the loop to act on.
 */
async function sweepClaimAndReflectOnce(
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
export const __test = { buildReflectionToolbox, REFLECTION_PROMPT };
