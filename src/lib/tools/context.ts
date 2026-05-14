/**
 * Umbrella `context` tool - the single point of entry for broad
 * lookups of persistent RAG about the user. Fans out the three
 * recall agents in parallel (memory, conversation, wiki) and
 * stitches their first-person notes into one paragraph the main
 * model reads as its own recollection.
 *
 * Why a tool rather than always-on injection: the chat-loop's
 * context-recall pipeline ALREADY auto-injects a stitched note on
 * topic boundaries (cold-start, title shift, mood shift, stale
 * fuse). That auto-injection is a topic-relevance projection - what
 * the three recall agents thought was worth surfacing for the live
 * conversation. The `context` tool is the explicit, model-driven
 * counterpart: when the main model wants to look up broad context
 * about the user (not just what's relevant to the current topic
 * boundary), it calls this tool with an optional topic hint and
 * gets the same kind of stitched paragraph synchronously.
 *
 * Why an umbrella rather than three separate tool calls: round-trips
 * compound. The three per-layer recall tools (memory_recall,
 * conversation_recall, wiki_recall) each fire one sub-agent and
 * wait. Calling all three in series is three sequential waits;
 * calling them in parallel is what this tool does internally
 * (`Promise.all` across the agents). The umbrella collapses three
 * round-trips at the main-model level into one tool result.
 *
 * The per-layer recall tools stay available as targeted drill-downs.
 * If the model has already used the umbrella and decided one layer
 * needs more specific exploration ("the wiki note hinted at an
 * article on X but didn't include the detail I need"), it can
 * follow up with the per-layer tool with a sharper topic hint.
 *
 * Toolbox scoping: lives in the main chat's TOOLS list. NOT
 * available in any of the agent-only toolboxes - background agents
 * have no business calling a three-way umbrella recall, and the
 * recall agents themselves must never recurse.
 *
 * Return shape mirrors the per-layer recall tools so the main model
 * can use the same handling pattern across them: either
 * `{kind:"none", reason?:"..."}` or `{kind:"note", note:"..."}`.
 * When every layer returns the empty signal, this tool returns the
 * empty signal with a synthesised reason naming all three layers'
 * silence; otherwise the stitched paragraph is the note.
 *
 * Schema lives in `./context.schema.ts`.
 */
import type { ToolDef } from './types';
import {
  runRecallFanOut,
  stitchRecallNotes,
} from '../context-recall/pipeline';
import type { RecallNote } from '../agents/recall/agent';
import { createLogger } from '../logger.svelte';
import { contextSchema } from './context.schema';

const log = createLogger('context-tool');

export const contextTool: ToolDef = {
  ...contextSchema,
  async execute(args, ctx): Promise<RecallNote> {
    const topic =
      typeof args.topic === 'string' && args.topic.trim().length > 0
        ? args.topic.trim()
        : null;

    // Breadcrumb matches the other recall agents - having consistent
    // log prefixes lets the log drawer be eyeballed for "something
    // is happening on a recall right now" without remembering
    // distinct tags per surface.
    log.info(`picked up thread ${ctx.threadId}`);
    const startedAt = Date.now();

    const fanOut = await runRecallFanOut({
      venice: ctx.venice,
      supabase: ctx.supabase,
      threadId: ctx.threadId,
      userId: ctx.userId,
      signal: ctx.signal,
      depth: ctx.depth,
      topic,
    });

    const noteText = stitchRecallNotes(fanOut);

    log.info(
      `finished thread ${ctx.threadId} ` +
        `(memory=${fanOut.memory.kind}, conversation=${fanOut.conversation.kind}, ` +
        `wiki=${fanOut.wiki.kind}, ` +
        `noteLength=${noteText.length}, elapsedMs=${Date.now() - startedAt})`
    );

    if (noteText.length === 0) {
      // Every layer returned the empty signal. Surface ALL three
      // reasons in one concatenated diagnostic so the main model
      // can tell whether "nothing relevant" was uniform across
      // surfaces or whether one layer is broken / always silent.
      const reasons: string[] = [];
      for (const [layer, note] of [
        ['memory', fanOut.memory],
        ['conversation', fanOut.conversation],
        ['wiki', fanOut.wiki],
      ] as const) {
        if (note.kind === 'none' && note.reason) {
          reasons.push(`${layer}: ${note.reason}`);
        }
      }
      const reason =
        reasons.length > 0
          ? reasons.join('; ')
          : 'every layer returned the empty signal';
      return { kind: 'none', reason };
    }

    return { kind: 'note', note: noteText };
  },
};
