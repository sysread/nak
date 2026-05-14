/**
 * The context-recall pipeline. Sibling of the intuition pipeline,
 * fired on the same trigger machinery (cold-start, mid-turn title
 * change, mood-band shift, stale fuse) but doing different work:
 *
 *   1. Fan out the three recall agents in parallel:
 *        - RecallAgent             (memories          / memory_search)
 *        - ConversationRecallAgent (prior threads     / conversation_search)
 *        - WikiRecallAgent         (wiki articles     / wiki_search)
 *      Each agent reads the live thread, runs its own dedicated
 *      search rounds against its own table, and returns a structured
 *      first-person note (or the empty signal).
 *   2. Stitch their notes into a single short paragraph that the
 *      chat-loop injects as a synthetic <think> assistant turn.
 *
 * Why a pipeline instead of a tool the main model calls: topic-
 * boundary recall is reflexive, not a per-turn decision. The
 * trigger evaluator (shared with intuition) already knows when a
 * topic boundary lands; routing context recall through that
 * evaluator removes one prompt instruction the main model would
 * otherwise have to remember and a tool round-trip on every cold-
 * start / title shift / stale-fuse fire.
 *
 * Per-layer recall tools (memory_recall, conversation_recall,
 * wiki_recall) and the umbrella `context` tool remain available as
 * explicit lookup surfaces - the model uses those when it wants a
 * targeted on-demand pull rather than the topic-relevance projection
 * the pipeline produces reflexively. The umbrella tool reuses
 * `runRecallFanOut` + `stitchRecallNotes` below so both paths walk
 * the same assembly logic.
 *
 * Why stitch (not synthesize): the three child agents already emit
 * first-person notes in the same voice with the same character cap.
 * A stitch is a literal concat with layer hinge words; an LLM-based
 * synthesizer would add latency and cost without earning its keep
 * unless the four notes overlap or contradict in ways a stitch
 * can't resolve - which we'd rather see actually happen before
 * paying for an extra model hop.
 *
 * Failure model:
 *   - Each child runs in its own try/catch; one child failing does
 *     not abort the others. The stitch operates on whichever children
 *     returned a real note.
 *   - If every child fails OR returns the empty signal, the pipeline
 *     still returns a payload - with `note: ''` - so the trigger
 *     evaluator's same-round debounce holds. Caching the negative
 *     result is the whole point of writing the empty case at all.
 *   - A signal abort returns null (no payload written). Caller leaves
 *     the prior cache in place. Same posture as the intuition pipeline.
 */
import type { VeniceClient } from '../venice';
import type { SupabaseService } from '../supabase';
// Recall agent classes are dynamic-imported below inside
// `runRecallFanOut`. Keeping them out of this module's static graph
// is what lets the four agent chunks stay out of the main bundle -
// Rollup's mixed-import rule means a single static importer anywhere
// on the main-graph path collapses the split into a no-op, even if
// every direct caller (the four recall tools) is already dynamic.
// `RecallNote` is a type-only import; it carries no runtime cost
// and doesn't pull the agent module into the static graph.
import type { RecallNote } from '../agents/recall/agent';
import type { IntuitionTrigger } from '../intuition/types';
import { createLogger } from '../logger.svelte';
import type { ContextRecallPayload } from './types';

const log = createLogger('context-recall');

/**
 * One layer of the recall fan-out. The order of layers in any
 * `RecallFanOutResult` array determines which one "wins" the
 * unprefixed slot in the stitched paragraph (the first non-empty
 * note is emitted verbatim; subsequent non-empty notes get their
 * layer hinge prepended).
 */
export type RecallLayer = 'memory' | 'conversation' | 'wiki';

/**
 * Per-layer hinge words. The first non-empty note in the stitch is
 * emitted verbatim (anchor); each subsequent non-empty note gets its
 * hinge prepended so the consuming model can tell which kind of
 * context each clause carries.
 *
 * Hinges are short on purpose - any longer and the assembled note
 * starts to feel like the model writing about itself rather than
 * thinking. They are also deliberately distinct in framing:
 *
 *   - memory       no hinge; memory anchors on standing facts and is
 *                  written in first person ("I remember the user
 *                  prefers..."). When memory is the only non-empty
 *                  note, this reads as the model's own recollection
 *                  without further scaffolding.
 *
 *   - conversation "From earlier conversations,". The conversation
 *                  child writes notes anchored on prior threads
 *                  ("last time this came up, we landed on X"); without
 *                  the hinge, a memory + conversation concatenation
 *                  reads as one undifferentiated recollection.
 *
 *   - wiki         "From the wiki,". The wiki child writes notes
 *                  about encyclopedic articles ABOUT the user's life
 *                  (projects, people, places). Distinct hinge so the
 *                  consuming model treats the clause as "what we have
 *                  written down about X" rather than "what we talked
 *                  about with X."
 */
export const RECALL_HINGES: Record<RecallLayer, string> = {
  memory: '',
  conversation: 'From earlier conversations,',
  wiki: 'From the wiki,',
};

/**
 * Output of `runRecallFanOut`. Keyed by layer rather than positional
 * so future layers (or a reordered priority) don't silently change
 * callers' behaviour.
 */
export interface RecallFanOutResult {
  memory: RecallNote;
  conversation: RecallNote;
  wiki: RecallNote;
}

/**
 * Stitch the three recall-agent notes into a single first-person
 * paragraph. Exported for unit testing and for the umbrella `context`
 * tool, which uses the same assembly logic to produce its on-demand
 * tool result.
 *
 * Rules:
 *   - All notes empty                 -> empty string. Caller writes
 *                                        this as the cached negative
 *                                        result.
 *   - Exactly one non-empty note      -> that note verbatim, no hinge.
 *                                        Whichever layer it is, the
 *                                        note's own first-person voice
 *                                        carries the framing.
 *   - Two or more non-empty notes     -> walked in layer order
 *                                        (memory, conversation, wiki).
 *                                        The first non-empty is
 *                                        emitted verbatim; each
 *                                        subsequent non-empty gets its
 *                                        layer hinge prepended with a
 *                                        space separator.
 *
 * The walk order is fixed: memory leads when present because it is
 * the densest layer of standing facts; conversation and wiki follow
 * with their hinges. If memory is empty and conversation is the
 * first non-empty, conversation goes verbatim (no hinge) and
 * subsequent layers follow with theirs - the unprefixed slot is
 * always the first non-empty in layer order.
 *
 * Whitespace-only notes are treated as empty for the cross-product
 * so a child that emits a stray space-padded note does not corrupt
 * the stitch.
 */
export function stitchRecallNotes(result: RecallFanOutResult): string {
  const orderedLayers: RecallLayer[] = [
    'memory',
    'conversation',
    'wiki',
  ];

  const cleaned: { layer: RecallLayer; text: string }[] = [];
  for (const layer of orderedLayers) {
    const note = result[layer];
    if (note.kind !== 'note') continue;
    const text = note.note.trim();
    if (text.length === 0) continue;
    cleaned.push({ layer, text });
  }

  if (cleaned.length === 0) return '';

  // First non-empty goes verbatim regardless of which layer it is -
  // the unprefixed slot is "whichever layer carried the anchor for
  // this stitch." Subsequent non-empties get their layer hinge.
  let out = cleaned[0].text;
  for (let i = 1; i < cleaned.length; i++) {
    const { layer, text } = cleaned[i];
    const hinge = RECALL_HINGES[layer];
    // A hinge of '' (the memory case) only happens at i === 0 in
    // practice because memory is first in the layer order. If memory
    // ever moves and a non-leading hinge is empty, we still emit a
    // bare concatenation rather than an invisible join.
    out = hinge.length > 0 ? `${out} ${hinge} ${text}` : `${out} ${text}`;
  }
  return out;
}

/**
 * Common inputs for the parallel recall fan-out. Shared between the
 * pipeline (which adds cache / trigger / mood metadata around the
 * fan-out) and the umbrella `context` tool (which uses just the
 * fan-out + stitch).
 */
export interface RecallFanOutInputs {
  venice: VeniceClient;
  supabase: SupabaseService;
  /** Thread we're recalling for. Every child reads messages by id via
   *  supabase.listMessages - callers do not hand them a history array
   *  the way the intuition pipeline does. */
  threadId: string;
  /** Signed-in user id. Forwarded to every child's tool context. */
  userId: string;
  signal: AbortSignal;
  /** Optional agent depth, forwarded to every child so
   *  runHeadlessToolLoop's MAX_AGENT_DEPTH check sees the right base.
   *  Undefined here is treated as 0 by the children. */
  depth?: number;
  /** Optional topic hint. The pipeline does not pass one (the agents
   *  infer from the live thread); the umbrella `context` tool may
   *  pass one through when the main model called it with an explicit
   *  topic. Only the conversation and wiki agents consume the topic
   *  - the memory child has no topic field by contract (its prompt is
   *  keyed on the conversation itself, not an injected phrase). */
  topic?: string | null;
}

/**
 * Run the three recall agents in parallel and return their notes
 * keyed by layer. Each child already collapses its own errors to
 * `{kind:'none'}`, so a single failed agent does not reject this
 * Promise.all - it surfaces as the empty signal for that layer.
 *
 * Exported so the umbrella `context` tool (src/lib/tools/context.ts)
 * can use the same fan-out without round-tripping through cache /
 * trigger metadata it does not need.
 */
export async function runRecallFanOut(
  inputs: RecallFanOutInputs
): Promise<RecallFanOutResult> {
  const { venice, supabase, threadId, userId, signal, depth, topic } = inputs;

  // Fire all three agent-module fetches in parallel so the
  // chunk-load cost is one network round-trip rather than three.
  // Each module sits in its own lazy chunk; the dynamic imports
  // are what keep them out of the main bundle.
  const [
    { RecallAgent },
    { ConversationRecallAgent },
    { WikiRecallAgent },
  ] = await Promise.all([
    import('../agents/recall/agent'),
    import('../agents/conversation_recall/agent'),
    import('../agents/wiki_recall/agent'),
  ]);

  const memoryAgent = new RecallAgent(venice, supabase);
  const conversationAgent = new ConversationRecallAgent(venice, supabase);
  const wikiAgent = new WikiRecallAgent(venice, supabase);

  const cleanTopic =
    typeof topic === 'string' && topic.trim().length > 0
      ? topic.trim()
      : null;

  const [memoryResult, conversationResult, wikiResult] =
    await Promise.all([
      memoryAgent.run({
        input: { threadId },
        userId,
        threadId,
        signal,
        depth,
      }),
      conversationAgent.run({
        input: { threadId, topic: cleanTopic },
        userId,
        threadId,
        signal,
        depth,
      }),
      wikiAgent.run({
        input: { threadId, topic: cleanTopic },
        userId,
        threadId,
        signal,
        depth,
      }),
    ]);

  return {
    memory: memoryResult.output.note,
    conversation: conversationResult.output.note,
    wiki: wikiResult.output.note,
  };
}

export interface RunContextRecallInputs {
  venice: VeniceClient;
  supabase: SupabaseService;
  /** Thread we're recalling for. */
  threadId: string;
  /** Signed-in user id. */
  userId: string;
  signal: AbortSignal;
  /** Round id (= count of user messages in history) at run time.
   *  Same value across all chat-loop iterations of one user turn. */
  round: number;
  /** Mood snapshot at run time, or null when no mood is available
   *  (cold start, mood-clear thread). */
  mood: { band: number; column: 'confident' | 'tentative' } | null;
  /** Why this run was scheduled. Persisted on the payload for
   *  observability. */
  trigger: IntuitionTrigger;
  /** Optional agent depth, forwarded to every child. */
  depth?: number;
}

/**
 * Run the full pipeline. Returns the cache-ready payload (which may
 * carry an empty note - that's a legitimate cached state representing
 * "nothing to recall this round"), or null if the run was aborted
 * before the fan-out completed. Caller is responsible for persisting
 * the payload to the thread row - see ./cache.ts.
 */
export async function runContextRecallPipeline(
  inputs: RunContextRecallInputs
): Promise<ContextRecallPayload | null> {
  const {
    venice,
    supabase,
    threadId,
    userId,
    signal,
    round,
    mood,
    trigger,
    depth,
  } = inputs;
  const startedAt = Date.now();
  log.info('pipeline starting', { trigger, round });

  if (signal.aborted) return null;

  const fanOut = await runRecallFanOut({
    venice,
    supabase,
    threadId,
    userId,
    signal,
    depth,
  });

  if (signal.aborted) return null;

  const note = stitchRecallNotes(fanOut);

  const payload: ContextRecallPayload = {
    v: 1,
    note,
    computed_at_round: round,
    computed_at_band: mood?.band ?? null,
    computed_at_column: mood?.column ?? null,
    computed_at_at: Date.now(),
    trigger,
  };

  // Mirrors the intuition pipeline's "complete" log line. The three
  // child kinds tell a debugging eye which layers carried signal on
  // a given thread - useful for "why is wiki recall always silent
  // here?" investigations without per-tool timing instrumentation.
  log.info('pipeline complete', {
    trigger,
    round,
    memoryKind: fanOut.memory.kind,
    conversationKind: fanOut.conversation.kind,
    wikiKind: fanOut.wiki.kind,
    noteLength: note.length,
    elapsedMs: Date.now() - startedAt,
  });
  return payload;
}
