/**
 * The context-recall pipeline. Sibling of the intuition pipeline,
 * fired on the same trigger machinery (cold-start, mid-turn title
 * change, mood-band shift, stale fuse) but doing different work:
 *
 *   1. Fan out RecallAgent and ConversationRecallAgent in parallel.
 *      The two agents read the live thread, run their own dedicated
 *      search rounds (memory_search and conversation_search
 *      respectively), and each return a structured first-person note
 *      or the empty signal.
 *   2. Stitch their notes into a single short paragraph that the
 *      chat-loop injects as a synthetic <think> assistant turn.
 *
 * Why a pipeline instead of a tool the main model calls: topic-
 * boundary recall is reflexive, not a per-turn decision. The
 * trigger evaluator (shared with intuition) already knows when a
 * topic boundary lands; routing context recall through that
 * evaluator removes one prompt instruction the main model would
 * otherwise have to remember and a tool round-trip on every cold-
 * start / title shift / stale-fuse fire. The individual recall tools
 * stay available as escape hatches for "the user just asked me to
 * look something up specifically".
 *
 * Why stitch (not synthesize): the two child agents already emit
 * first-person notes in the same voice with the same character cap.
 * A stitch is a literal concat with framing words; an LLM-based
 * synthesizer would add latency and cost without earning its keep
 * unless the two notes overlap or contradict in ways a stitch
 * can't resolve - which we'd rather see actually happen before
 * paying for an extra model hop.
 *
 * Failure model:
 *   - Each child runs in its own try/catch; one child failing does
 *     not abort the other. The stitch operates on whichever children
 *     returned a real note.
 *   - If both children fail OR both return the empty signal, the
 *     pipeline still returns a payload - with `note: ''` - so the
 *     trigger evaluator's same-round debounce holds. Caching the
 *     negative result is the whole point of writing the empty case
 *     at all.
 *   - A signal abort returns null (no payload written). Caller leaves
 *     the prior cache in place. Same posture as the intuition pipeline.
 */
import type { VeniceClient } from '../venice';
import type { SupabaseService } from '../supabase';
import { RecallAgent } from '../agents/recall/agent';
import { ConversationRecallAgent } from '../agents/conversation_recall/agent';
import type { RecallNote } from '../agents/recall/agent';
import type { IntuitionTrigger } from '../intuition/types';
import { createLogger } from '../logger.svelte';
import type { ContextRecallPayload } from './types';

const log = createLogger('context-recall');

/**
 * Stitch two recall-agent notes into a single first-person paragraph.
 * Exported for unit testing.
 *
 * Cases:
 *   - Both `kind: 'none'`     -> empty string. Caller writes this as
 *                                the cached negative result.
 *   - Only memory note        -> memory note verbatim.
 *   - Only conversation note  -> conversation note verbatim.
 *   - Both notes present      -> memory note + " " + conversation
 *                                note, with a thin framing prefix on
 *                                the conversation half so the model
 *                                reads them as two distinct lines of
 *                                recollection rather than a run-on.
 *
 * The framing prefix ("From earlier conversations,") is deliberate -
 * the conversation-recall child writes notes anchored on prior
 * threads ("Last time this came up, we landed on X"), but the
 * memory-recall child's notes are anchored on standing facts
 * ("I remember the user prefers Y"). Without a hinge word the
 * concatenation reads as one undifferentiated recollection; with
 * the hinge, the model can tell which kind of context each clause
 * is. Cheap clarity.
 */
export function stitchRecallNotes(
  memoryNote: RecallNote,
  conversationNote: RecallNote
): string {
  const memoryText =
    memoryNote.kind === 'note' ? memoryNote.note.trim() : '';
  const conversationText =
    conversationNote.kind === 'note' ? conversationNote.note.trim() : '';

  if (memoryText.length === 0 && conversationText.length === 0) return '';
  if (conversationText.length === 0) return memoryText;
  if (memoryText.length === 0) return conversationText;

  // Both present: memory first (standing facts), then a hinge into
  // the conversation half. The hinge phrase is short on purpose -
  // any longer and it would feel like the model writing about itself
  // rather than thinking. We also avoid lowercasing the conversation
  // note's first letter; the child agents emit first-person sentences
  // that may legitimately start with "I" or a proper noun.
  return `${memoryText} From earlier conversations, ${conversationText}`;
}

export interface RunContextRecallInputs {
  venice: VeniceClient;
  supabase: SupabaseService;
  /** Thread we're recalling for. Both children read messages by id
   *  via supabase.listMessages - the pipeline does not hand them a
   *  history array the way the intuition pipeline does. */
  threadId: string;
  /** Signed-in user id. Forwarded to both children's tool contexts. */
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
  /** Optional agent depth, forwarded to both children so
   *  runHeadlessToolLoop's MAX_AGENT_DEPTH check sees the right base.
   *  Undefined here is treated as 0 by the children. */
  depth?: number;
}

/**
 * Run the full pipeline. Returns the cache-ready payload (which may
 * carry an empty note - that's a legitimate cached state representing
 * "nothing to recall this round"), or null if the run was aborted
 * before either child completed. Caller is responsible for persisting
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

  const memoryAgent = new RecallAgent(venice, supabase);
  const conversationAgent = new ConversationRecallAgent(venice, supabase);

  // Parallel fan-out. Each agent already collapses its own errors to
  // `{kind:'none'}` so a child failure won't reject this Promise.all -
  // it just shows up as an empty signal we stitch over. The intuition
  // pipeline likewise tolerates partial drive failures; same posture.
  const [memoryResult, conversationResult] = await Promise.all([
    memoryAgent.run({
      input: { threadId },
      userId,
      threadId,
      signal,
      depth,
    }),
    conversationAgent.run({
      input: { threadId, topic: null },
      userId,
      threadId,
      signal,
      depth,
    }),
  ]);

  if (signal.aborted) return null;

  const note = stitchRecallNotes(
    memoryResult.output.note,
    conversationResult.output.note
  );

  const payload: ContextRecallPayload = {
    v: 1,
    note,
    computed_at_round: round,
    computed_at_band: mood?.band ?? null,
    computed_at_column: mood?.column ?? null,
    computed_at_at: Date.now(),
    trigger,
  };

  // Mirrors the intuition pipeline's "complete" log line. The two
  // child kinds tell a debugging eye whether memory or conversation
  // is the silent half on a given thread.
  log.info('pipeline complete', {
    trigger,
    round,
    memoryKind: memoryResult.output.note.kind,
    conversationKind: conversationResult.output.note.kind,
    noteLength: note.length,
    elapsedMs: Date.now() - startedAt,
  });
  return payload;
}
