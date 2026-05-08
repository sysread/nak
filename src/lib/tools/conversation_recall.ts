/**
 * Conversation-recall entrypoint - sibling of `memory_recall`, one
 * layer up. The main chat model calls this when a user turn would
 * benefit from context out of a prior conversation (not just loose
 * memory facts); we spin up a ConversationRecallAgent on the fast
 * tier, which reads the live thread, runs one or more
 * `conversation_search` passes, and returns either the empty signal
 * or a short first-person note.
 *
 * Why a tool rather than an implicit pre-pass: same reasoning as
 * `memory_recall` - cheap chitchat turns shouldn't pay the recall
 * tax, and the main model is better positioned than a heuristic to
 * judge when reaching into prior threads is worthwhile. The topic
 * hint lets the main model say "look for conversations about X"
 * explicitly when it already knows what to seed the search on.
 *
 * Toolbox scoping: lives in the main chat's TOOLS list but is NOT in
 * `memoryToolbox`, `recallToolbox`, or
 * `conversationRecallToolbox` - the recall agents themselves must
 * not recurse into another recall pass, and the reflection agent has
 * no business pulling in prior conversations. Main-chat only.
 *
 * Schema lives in `./conversation_recall.schema.ts`.
 */
import type { ToolDef } from './types';
import { ConversationRecallAgent } from '../agents/conversation_recall/agent';
import { createLogger } from '../logger.svelte';
import { conversationRecallSchema } from './conversation_recall.schema';

const log = createLogger('conversation-recall-agent');

export const conversationRecall: ToolDef = {
  ...conversationRecallSchema,
  async execute(args, ctx) {
    const topic =
      typeof args.topic === 'string' && args.topic.trim().length > 0
        ? args.topic.trim()
        : null;

    // Breadcrumb matches `recall-agent` - the two recall agents run
    // the same shape of task, and having consistent log prefixes lets
    // the log drawer be eyeballed for "something is happening on a
    // recall right now" without remembering two distinct tags.
    log.info(`picked up thread ${ctx.threadId}`);

    const agent = new ConversationRecallAgent(ctx.venice, ctx.supabase);
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
