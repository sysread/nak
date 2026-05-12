/**
 * Wiki-recall entrypoint - third sibling of `memory_recall` and
 * `conversation_recall`, one layer up. The main chat model calls this
 * when a user turn would benefit from context out of the user's wiki
 * (encyclopedic articles ABOUT topics in their life: projects, people,
 * places, ongoing experiments) rather than from loose memory facts or
 * prior conversation summaries. We spin up a WikiRecallAgent on the
 * recall tier, which reads the live thread, runs one or more
 * `wiki_search` passes, and returns either the empty signal or a
 * short first-person note.
 *
 * Why a tool rather than an implicit pre-pass: same reasoning as the
 * other recall tools - cheap chitchat turns shouldn't pay the recall
 * tax, and the main model is better positioned than a heuristic to
 * judge when reaching into the wiki is worthwhile. The topic hint
 * lets the main model say "look for articles about X" explicitly
 * when it already knows what to seed the search on.
 *
 * Toolbox scoping: lives in the main chat's TOOLS list but is NOT in
 * `memoryToolbox`, `recallToolbox`, `conversationRecallToolbox`, or
 * `wikiRecallToolbox` - the recall agents themselves must not recurse
 * into another recall pass, and the reflection / wiki agents have no
 * business pulling in another recall layer. Main-chat only.
 *
 * Schema lives in `./wiki_recall.schema.ts`.
 */
import type { ToolDef } from './types';
import { createLogger } from '../logger.svelte';
import { wikiRecallSchema } from './wiki_recall.schema';

const log = createLogger('wiki-recall-agent');

export const wikiRecall: ToolDef = {
  ...wikiRecallSchema,
  async execute(args, ctx) {
    const topic =
      typeof args.topic === 'string' && args.topic.trim().length > 0
        ? args.topic.trim()
        : null;

    // Breadcrumb matches the other recall agents - having consistent
    // log prefixes lets the log drawer be eyeballed for "something is
    // happening on a recall right now" without remembering distinct
    // tags per surface.
    log.info(`picked up thread ${ctx.threadId}`);

    const { WikiRecallAgent } = await import('../agents/wiki_recall/agent');
    const agent = new WikiRecallAgent(ctx.venice, ctx.supabase);
    const result = await agent.run({
      input: { threadId: ctx.threadId, topic },
      userId: ctx.userId,
      threadId: ctx.threadId,
      signal: ctx.signal,
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
        log.debug(`thread ${ctx.threadId} note`, result.output.note.note);
      }
    }

    return result.output.note;
  },
};
