/**
 * Main-chat surface for delegating wiki maintenance to the librarian
 * sub-agent. Thin wrapper over `runManually` in
 * `../agents/wiki-librarian/runner.svelte.ts` - the same entry point
 * the Wiki top-bar's manual-run strip uses, so the model and the user
 * reach the same code path and share the same in-flight guard
 * (`wikiLibrarianRunner.manualBusy`). A second run started while the
 * first is in flight returns a structured error rather than racing
 * two librarian passes against the wiki.
 *
 * Why a tool rather than a free-floating recommendation: the librarian
 * is a multi-round agent that can take meaningful time (reading the
 * full article list, calling wiki_search / wiki_update / wiki_delete
 * inside its own loop), so the main model needs to await its
 * completion to report what changed. Returning `summary` (the
 * librarian's own 1-2 sentence operator note) plus counters lets the
 * caller tell the user "the librarian merged X and Y, left Z alone"
 * without needing to re-list the wiki and diff.
 *
 * Profile pull: `runManually` requires the user's name and location
 * for the librarian's prompt. We fetch them from settings here rather
 * than widening ToolContext, since the cost is one row read and the
 * tool already pays an order-of-magnitude longer agent run.
 *
 * Toolbox scoping: lives in the gated `wiki` toolbox, not always-on.
 * The librarian writes (it can create, update, delete articles), and
 * the project rule is that write paths gate behind a user-or-model
 * toggle so an autonomous turn cannot scribble over user data without
 * intent.
 */
import type { ToolDef } from './types';
import { runManually } from '../agents/wiki-librarian/runner.svelte';
import { createLogger } from '../logger.svelte';
import { wikiLibrarianSchema } from './wiki_librarian.schema';

const log = createLogger('wiki-librarian-tool');

export const wikiLibrarian: ToolDef = {
  ...wikiLibrarianSchema,
  async execute(args, ctx) {
    const instructions =
      typeof args.instructions === 'string' ? args.instructions.trim() : '';
    if (instructions.length === 0) {
      // Throw so chat-loop folds this into a structured tool-result
      // error the model can read on the next round and retry with a
      // non-empty instruction string. Matches research_docs's empty-
      // argument convention.
      throw new Error('wiki_librarian requires a non-empty `instructions` argument');
    }

    // The librarian's prompt embeds the user's name and location when
    // either is set. Empty strings are the documented "skip the
    // profile block" sentinel - buildProfile inside runManually
    // handles the trim+null collapse.
    const settings = await ctx.supabase.getSettings();
    const userName = settings.userName ?? '';
    const userLocation = settings.userLocation ?? '';

    log.info(
      `dispatching librarian: "${instructions.slice(0, 80)}${instructions.length > 80 ? '...' : ''}"`
    );

    const result = await runManually({
      supabase: ctx.supabase,
      venice: ctx.venice,
      userId: ctx.userId,
      userName,
      userLocation,
      customInstructions: instructions,
      signal: ctx.signal,
    });

    if (result.kind === 'error') {
      // Surface the librarian's error string through chat-loop's
      // encodeToolContent so the calling model can adapt. Common cases:
      // a concurrent manual run from the Wiki panel ("already in
      // flight"), or a sub-agent failure inside the librarian's loop.
      throw new Error(
        result.error ?? 'wiki_librarian: run failed without an error message'
      );
    }

    return {
      summary: result.finalText,
      articleCount: result.articleCount,
      toolCalls: result.toolCalls,
    };
  },
};
