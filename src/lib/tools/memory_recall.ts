/**
 * Auto-recall entrypoint. The main chat model calls this when a user
 * turn might benefit from prior-conversation memories; we spin up a
 * RecallAgent on the fast tier, which reads the live thread, does its
 * own memory_search rounds, and returns either an empty signal or a
 * short first-person note. The tool surface is deliberately tiny —
 * no arguments — so the main model treats it as a reflex rather than
 * a heavyweight decision.
 *
 * Why a tool rather than an implicit pre-pass on every turn: cheap
 * turns (simple chitchat, "what time is it") shouldn't pay the
 * recall tax, and the model is better positioned than a heuristic
 * to judge when recall is worth the round-trip. The strongly-worded
 * description (below) is what keeps the model reaching for this
 * instead of memory_search when it's just trying to remember
 * context — memory_search still exists for explicit
 * "find-then-mutate" flows the user asks for directly.
 *
 * Toolbox scoping: `memory_recall` lives in the main chat's TOOLS
 * list but is explicitly NOT in `memoryToolbox` (which the
 * reflection agent uses) or `recallToolbox` (which the recall agent
 * itself uses). A reflection or recall agent invoking memory_recall
 * would be recursion for no reason, so the toolboxes exclude it at
 * the registry level rather than relying on prompt discipline.
 */
import type { ToolDef } from './types';
import { createLogger } from '../logger.svelte';
import { memoryRecallSchema } from './memory_recall.schema';

const log = createLogger('recall-agent');

export const memoryRecall: ToolDef = {
  ...memoryRecallSchema,
  async execute(_args, ctx) {
    // RecallAgent is dynamic-imported because it transitively pulls
    // `recallToolbox` and the memory_search / conversation_search
    // tools it dispatches to. memory_recall is always-on (it fires
    // on topic boundaries), but most chats don't reach for it on
    // the first turn - the chunk-fetch tax lands the first time
    // the model actually decides to recall. Subsequent calls hit
    // the module cache.
    const { RecallAgent } = await import('../agents/recall/agent');
    // Task pickup log — mirrors the breadcrumbs on the reflection /
    // embedding workers so the log drawer can surface "something is
    // happening" without us needing per-tool timing instrumentation.
    log.info(`picked up thread ${ctx.threadId}`);

    const agent = new RecallAgent(ctx.venice, ctx.supabase);
    const result = await agent.run({
      input: { threadId: ctx.threadId },
      userId: ctx.userId,
      threadId: ctx.threadId,
      signal: ctx.signal,
      // Forward our depth so the agent's tool loop bumps from the
      // right base when checking MAX_AGENT_DEPTH. Undefined here
      // (older callers / tests) is treated as 0 downstream.
      depth: ctx.depth,
    });

    if (result.stoppedReason === 'error') {
      log.debug(
        `thread ${ctx.threadId} errored`,
        result.error ?? '(no message)'
      );
    } else {
      log.info(
        `finished thread ${ctx.threadId} ` +
          `(kind=${result.output.note.kind}, ${result.toolCalls} tool calls ` +
          `over ${result.output.inputMessageCount} messages)`
      );
      if (result.output.note.kind === 'note') {
        log.debug(
          `thread ${ctx.threadId} note`,
          result.output.note.note
        );
      } else {
        // Mirror the `kind === 'note'` debug above for the empty
        // signal: surface the raw text the recall model emitted so a
        // "why did recall return nothing?" investigation can tell the
        // five collapse-to-none branches apart at a glance. An empty
        // string means the model emitted nothing (or there was no
        // user turn — the info line's "over 0 messages" disambiguates
        // that case); a `{"kind":"none"}` literal means the model
        // explicitly declined; anything else is a parse failure or
        // malformed-note shape (see parseRecallOutput in agent.ts).
        log.debug(
          `thread ${ctx.threadId} raw`,
          result.output.rawText
        );
      }
    }

    // Hand the structured note back as the tool result. The chat-
    // loop JSON-encodes whatever we return here into the tool-result
    // message body, so the main model reads a parsed object on the
    // next round — matching what the recall prompt promised to emit.
    return result.output.note;
  },
};
