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
import { RecallAgent } from '../agents/recall/agent';
import { createLogger } from '../logger.svelte';

const log = createLogger('recall-agent');

export const memoryRecall: ToolDef = {
  name: 'memory_recall',
  description:
    'Pull in any long-term memories that are relevant to the current ' +
    "conversation but aren't already mentioned. Takes no arguments — " +
    "it reads the live thread on its own and returns either " +
    '`{kind:"none"}` (nothing worth injecting) or `{kind:"note", ' +
    'note:"<first-person paragraph>"}` you should treat as your own ' +
    'recollection and fold into your next reply.' +
    '\n\n' +
    'STRONGLY PREFER THIS over `memory_search` whenever you just want ' +
    'context about the user to answer better. `memory_search` is for ' +
    'when the user has explicitly asked you to find, edit, or remove a ' +
    'specific memory — i.e. when you need the memory id to hand to ' +
    '`memory_update`, `memory_delete`, or `memory_invalidate`. For ' +
    'every other "let me check what I remember" moment, call ' +
    '`memory_recall` instead: it runs a dedicated recall pass for you, ' +
    'skips memories already visible in the conversation, and returns a ' +
    "pre-digested note instead of a raw result list.",
  shortDescription: 'recall memories relevant to this thread',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async execute(_args, ctx) {
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
      }
    }

    // Hand the structured note back as the tool result. The chat-
    // loop JSON-encodes whatever we return here into the tool-result
    // message body, so the main model reads a parsed object on the
    // next round — matching what the recall prompt promised to emit.
    return result.output.note;
  },
};
