// Memory-recall agent. Function-side port of src/lib/agents/recall/
// (agent.ts + prompt.ts) and the memory_recall tool wrapping it.
//
// Architectural rationale (mirrors the browser-side comments):
//
//   - Recall runs inline as a tool the main chat model calls when a
//     turn might benefit from prior-conversation memories. The agent
//     itself is read-only (memory_search only) so a bug in the recall
//     prompt can't scribble over long-term memory.
//   - The agent reads the live thread, trims back to the last user
//     turn (dropping any in-flight assistant tool_calls row the
//     streaming orchestrator just persisted on its way into the
//     memory_recall dispatch), appends the recall instruction as a
//     final user turn, and runs the headless tool-call loop.
//   - The model settles on a structured JSON response - either
//     `{kind:'none', reason}` or `{kind:'note', note}` - which we
//     parse and hand back as the tool result.
//
// Side effects:
//   - upserts (memory_id, conversation_id, last_seen_at) rows into
//     public.memory_conversation for every memory the agent's
//     memory_search calls returned. The rem librarian's 12h cycle
//     queries this table to find conversations with new co-occurrence
//     signal. Best-effort: a transient DB error doesn't fail recall.

import { createEdgeLogger } from '../../_shared/edge-log.ts';
import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { memorySearch } from '../tools/memory_search.ts';
import {
  runHeadlessAgent,
  type AgentTool,
  type AgentToolContext,
  type Toolbox,
} from './_run.ts';
import {
  loadThreadSlice,
  logPreview,
  messageToVenice,
  parseRecallOutput,
  type RecallNote,
  type VeniceWireMessage,
} from './_recall_helpers.ts';

const RECALL_MODEL = 'deepseek-v4-flash';

const MEMORY_SEARCH_WIRE_SCHEMA: AgentTool['wire'] = {
  type: 'function',
  function: {
    name: 'memory_search',
    description:
      "Semantic search over the user's saved memories. Returns " +
      '{id, label, data, confidence, confidence_tag, updated_at, ' +
      'relations}[]. confidence_tag is corroborated/hedged/shaky or ' +
      'null. relations carries outbound graph edges with the target ' +
      "memory's label/data inlined. Empty query lists everything.",
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

// User-turn instruction for the recall agent. Identical to the
// browser-side prompt; kept as one literal so the model gets the same
// guidance regardless of which path triggered the agent.
const RECALL_PROMPT =
  `You've just read the conversation above. Step out of the role of the
main assistant - this time, you're not replying to the user. Your job
is to recall memory context that helps the main model answer the
latest turn.

First, decide which mode you are in by reading the latest user turn:

  EXPLICIT recall: the user asked the main model directly what it
  remembers, what it knows about them, what their preferences are,
  what they told you about X, and similar meta-questions about
  memory itself. The user wants memories surfaced. Bar is LOW: the
  relevance test IS the question, so do not also filter on
  "materially relevant to the latest turn." Surface what you find.

  IMPLICIT recall: the user asked a regular question and the main
  model called recall hoping to find context that would help answer
  it. Bar is MODERATE: emit when memories add useful signal - facts,
  preferences, constraints, or calibration that would help the main
  model frame its answer. Drop notes that exactly duplicate what is
  already in-thread, but do not over-filter. A partial-signal note
  is usually better than empty; the main model decides what to lean
  on. Reach for kind:none only when searches genuinely returned
  nothing OR every hit is word-for-word what the conversation
  already establishes.

Two channels worth surfacing in either mode:

  (1) FACTS the main model would benefit from: standing memories
      about the user, prior decisions, preferences, constraints,
      relationships, ongoing projects. In EXPLICIT mode, surface
      any facts that match the question. In IMPLICIT mode, surface
      facts that touch the topic, the user-as-subject, or the
      framing the answer would benefit from.

  (2) CALIBRATION about what the user already knows or has worked
      on. If they are deep in this material, the main model should
      not re-explain the basics; if newly arriving, it should not
      assume jargon. Surface calibration that genuinely helps the
      main model frame the answer - even a soft "the user has been
      around X for a while" beats no calibration at all.

Workflow:

1. Pick the mode (above), then use \`memory_search\` - usually more
   than once, with different queries - to find candidates.
   IMPORTANT: do not stop after 2-3 near-synonym queries. If your
   first round comes back empty or thin, broaden the angles before
   concluding nothing is there. Productive angles to try when the
   literal topic comes back empty:
     - the user themselves ("about the user", their name, their
       work) - often surfaces a standing fact that frames the topic
     - an adjacent topic or generalisation (asked about spices ->
       try cuisines they cook, dietary patterns, foods they like)
     - the user-as-subject + the topic ("the user and X")
     - a constraint or preference that bounds the topic
   Three to five attempts across different angles is usually right.
   In EXPLICIT mode, broad queries are fine ("about the user",
   "preferences", whatever the user asked about).
2. Cross-check candidates against the conversation. EXPLICIT: do
   not filter (the user asked, surface it). IMPLICIT: drop facts
   the conversation already states word-for-word; keep facts that
   add detail, context, or calibration even if loosely connected.
3. Assimilate what is left into a short first-person paragraph in
   the main assistant's voice ("I remember that...", "I know from
   before that...") - your own note to your future self, NOT a
   third-person quotation. Blend FACTS and CALIBRATION when both
   have signal: one short sentence each. When the signal is light
   but real, emit it - a one-line calibration ("the user has been
   experimenting with Indian food for a couple of years") is a
   useful note.

Each memory carries a \`confidence_tag\` (corroborated / hedged /
shaky / null) and a \`relations\` list pointing at linked memories.
Use both: a [shaky] fact should be hedged in your note ("I have a
hazy sense that..."), a [corroborated] one stated more confidently,
and a relation pointing at a directly-relevant linked memory is
often a better pick than the hit itself.

Reply with JSON in one of exactly these two shapes:

- \`{"kind": "none", "reason": "<short diagnostic>"}\` only after you
  have broadened your queries past the literal topic and still come
  up empty - or every hit is exactly what the conversation already
  states. The \`reason\` is REQUIRED and is for diagnostics - keep it
  short and concrete and name the angles you tried ("searched topic
  X, adjacent Y, the user themselves; no memories returned hits",
  "all candidates duplicated in-thread facts word-for-word"). Vague
  reasons defeat the purpose, and so does giving up after one round
  of near-synonym queries.

- \`{"kind": "note", "note": "<short first-person paragraph>"}\` with
  the assimilated recall. Keep \`note\` under ~400 characters - one
  tight paragraph, not a bulleted list.

Do not emit any other keys. Do not wrap the JSON in prose or a code
fence.`;

/**
 * Run one recall pass against `ctx.threadId`. Returns the structured
 * note (RecallNote) plus diagnostic context. The caller is expected to
 * hand the note back to the main model as the memory_recall tool result.
 */
async function runRecall(ctx: ToolContext): Promise<RecallNote> {
  // Drawer logging. Recall runs mid-turn inside the chat tool dispatch,
  // so the run - and the finally-flush below - is bounded by the turn;
  // flushing here cannot stall anything past the response.
  const log = createEdgeLogger(ctx.userId, 'recall');
  try {
    const slice = await loadThreadSlice(ctx.adminClient, ctx.threadId);
    if (slice.length === 0) {
      return { kind: 'none', reason: 'thread has no user turn yet' };
    }

    // The slice ends at the user turn the agent is recalling for
    // (trimToLastUserTurn), so its tail is the input worth previewing.
    log.debug(
      `recall start: ${slice.length} message(s), ` +
        `latest user turn "${logPreview(slice[slice.length - 1].content ?? '')}"`,
    );

    const convo: VeniceWireMessage[] = slice.map(messageToVenice);
    // Recall instruction as the final user turn. Matches the reflection-
    // agent "switch modes" idiom.
    convo.push({ role: 'user', content: RECALL_PROMPT });

    // Recall-toolbox wrapper around memory_search. The wrapper records
    // every memory id memory_search returned so we can feed the rem
    // librarian's hint queue after the agent settles. Calls into the
    // already-registered ToolDef so we get the production search
    // behaviour without duplicating the query path.
    const recalledIds = new Set<string>();
    const recallMemorySearch: AgentTool = {
      name: 'memory_search',
      wire: MEMORY_SEARCH_WIRE_SCHEMA,
      async execute(args, agentCtx) {
        const result = await memorySearch.execute(args, {
          adminClient: agentCtx.adminClient,
          userId: agentCtx.userId,
          threadId: agentCtx.threadId,
          signal: agentCtx.signal,
          depth: agentCtx.depth,
        });
        if (Array.isArray(result)) {
          for (const m of result) {
            if (m && typeof m === 'object') {
              const id = (m as Record<string, unknown>).id;
              if (typeof id === 'string') recalledIds.add(id);
            }
          }
        }
        return result;
      },
    };

    const toolbox: Toolbox = {
      name: 'recall',
      tools: [recallMemorySearch],
    };

    const apiKey = await readVeniceKey(ctx.adminClient);
    if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

    const baseCtx: Omit<AgentToolContext, 'signal' | 'depth'> = {
      adminClient: ctx.adminClient,
      userId: ctx.userId,
      threadId: ctx.threadId,
    };

    const result = await runHeadlessAgent(
      {
        model: RECALL_MODEL,
        messages: convo,
        toolbox,
        baseCtx,
        apiKey,
        signal: ctx.signal,
      },
      ctx.depth ?? 0,
    );

    const note = parseRecallOutput(result.finalText);

    // Best-effort feed for the rem librarian. Surface upsert errors to
    // the log only (recall has already settled its answer; the hint
    // queue is advisory).
    if (recalledIds.size > 0) {
      const now = new Date().toISOString();
      const rows = Array.from(recalledIds).map((memory_id) => ({
        user_id: ctx.userId,
        memory_id,
        conversation_id: ctx.threadId,
        last_seen_at: now,
      }));
      // RLS OFF: explicit user_id stamped.
      const { error: upErr } = await ctx.adminClient
        .from('memory_conversation')
        .upsert(rows, { onConflict: 'memory_id,conversation_id' });
      if (upErr) {
        log.error(`memory_conversation upsert failed: ${upErr.message}`, upErr);
      }
    }

    log.info(
      `recall finished (${result.toolCalls} tool call(s), ` +
        `${recalledIds.size} memor${recalledIds.size === 1 ? 'y' : 'ies'} surfaced, ` +
        `outcome=${note.kind})`,
    );
    return note;
  } catch (err) {
    // Logging only - the failure still propagates to the tool
    // dispatcher unchanged; this line is the drawer-visible reason.
    log.error('recall failed', err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    await log.flush();
  }
}

export const memoryRecall: ToolDef = {
  name: 'memory_recall',
  async execute(_args: Record<string, unknown>, ctx: ToolContext) {
    return await runRecall(ctx);
  },
};

registerTool(memoryRecall);
