/**
 * Journal-recall entrypoint - fourth sibling of memory_recall,
 * conversation_recall, and wiki_recall, one layer up. The main chat
 * model calls this when a user turn would benefit from context out
 * of the user's daily journal (reflective dated entries) rather than
 * from loose memory facts, prior conversation summaries, or wiki
 * articles. We spin up a JournalRecallAgent on the recall tier,
 * which reads the live thread, runs one or more `journal_search`
 * passes, and returns either the empty signal or a short first-person
 * note.
 *
 * Why a tool rather than an implicit pre-pass: same reasoning as the
 * other recall tools - cheap chitchat turns shouldn't pay the recall
 * tax, and the main model is better positioned than a heuristic to
 * judge when reaching into the journal is worthwhile. The journal in
 * particular is the WRONG surface for operational turns and the
 * RIGHT surface for reflective ones; we want the main model judging
 * that boundary, not a heuristic.
 *
 * Toolbox scoping: lives in the main chat's TOOLS list but is NOT
 * in any of the agent-only toolboxes - the recall agents themselves
 * must not recurse into another recall pass, and reflection / wiki
 * agents have no business pulling in another recall layer. Main-chat
 * only.
 *
 * Schema lives in `./journal_recall.schema.ts`.
 */
import type { ToolDef } from './types';
import { JournalRecallAgent } from '../agents/journal_recall/agent';
import { createLogger } from '../logger.svelte';
import { journalRecallSchema } from './journal_recall.schema';

const log = createLogger('journal-recall-agent');

export const journalRecall: ToolDef = {
  ...journalRecallSchema,
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

    const agent = new JournalRecallAgent(ctx.venice, ctx.supabase);
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
