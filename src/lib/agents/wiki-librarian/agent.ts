/**
 * Wiki librarian agent. Reads the full alphabetical list of the
 * user's wiki articles, builds a compact prompt with title + excerpt
 * for each, and runs `runHeadlessToolLoop` against the
 * `wikiLibrarianToolbox` (wiki_search + wiki_update + wiki_delete +
 * conversation_search). Side effects from those tool calls ARE the
 * output; the model's final text is discarded.
 *
 * No per-thread claim, no entry_date, no terminal-message slicing -
 * the librarian operates on the wiki as a whole, on a separate
 * cadence from the per-conversation wiki agent. Cross-device
 * coordination comes from the lease coordinator + the atomic
 * `claim_wiki_librarian_run` RPC the loop checks before instantiating
 * the agent.
 *
 * Pure logic - no leases, no claims, no lifecycle. Those live in
 * `./loop.ts` and `./worker.ts`. Same separation as the per-
 * conversation wiki agent.
 */
import type { Agent, AgentRunRequest, AgentRunResult } from '../types';
import type { SupabaseService } from '../../supabase';
import type { VeniceClient, VeniceMessage } from '../../venice';
import { wikiLibrarianToolbox } from '../../tools/wiki_librarian_toolbox';
import { runHeadlessToolLoop } from '../../tools/run';
import { agentModel } from '../../models';
import { createLogger } from '../../logger.svelte';
import { buildWikiLibrarianPrompt } from './prompt';
import {
  LIBRARIAN_EXCERPT_CHARS,
  type WikiLibrarianInput,
  type WikiLibrarianOutput,
} from './types';

const log = createLogger('wiki-librarian-worker');

/**
 * Render the librarian's snapshot of articles into the bullet list
 * the prompt embeds. Each row is "Title - excerpt" so the model can
 * scan vertically. Title fences with backticks so a title containing
 * stray punctuation reads cleanly.
 */
function renderArticleList(
  articles: WikiLibrarianInput['articles']
): string {
  if (articles.length === 0) return '(the wiki is currently empty)';
  return articles
    .map((a) => {
      const excerpt = a.excerpt
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, LIBRARIAN_EXCERPT_CHARS);
      return `- \`${a.title}\` - ${excerpt || '(empty body)'}`;
    })
    .join('\n');
}

export class WikiLibrarianAgent
  implements Agent<WikiLibrarianInput, WikiLibrarianOutput>
{
  readonly name = 'wiki-librarian';
  readonly model: string;
  readonly toolbox = wikiLibrarianToolbox;

  constructor(
    private venice: VeniceClient,
    private supabase: SupabaseService,
    /**
     * Optional model override. Defaults to the registry's
     * `wikiLibrarian` slot (currently deepseek-v4-flash). Useful
     * for tests.
     */
    modelId?: string
  ) {
    this.model = modelId ?? agentModel('wikiLibrarian').id;
  }

  async run(
    req: AgentRunRequest<WikiLibrarianInput>
  ): Promise<AgentRunResult<WikiLibrarianOutput>> {
    const signal = req.signal ?? new AbortController().signal;
    const articles = req.input.articles;

    if (signal.aborted) {
      return {
        output: { finalText: '', articleCount: 0 },
        toolCalls: 0,
        stoppedReason: 'aborted',
      };
    }

    try {
      const articleList = renderArticleList(articles);
      const promptText = buildWikiLibrarianPrompt({ articleList });

      log.info(
        `librarian reviewing ${articles.length} article(s)`
      );

      const messages: VeniceMessage[] = [
        { role: 'system', content: promptText },
      ];

      const result = await runHeadlessToolLoop({
        venice: this.venice,
        model: this.model,
        messages,
        toolbox: this.toolbox,
        toolCtx: {
          supabase: this.supabase,
          venice: this.venice,
          userId: req.userId,
          // The librarian is not thread-scoped. We pass the empty
          // string here to satisfy the ToolContext shape; the wiki
          // tools and conversation_search both ignore threadId
          // (they're scoped by RLS on user_id, not by thread).
          threadId: '',
        },
        signal,
        reasoningEffort: 'low',
      });

      return {
        output: {
          finalText: result.finalText,
          articleCount: articles.length,
        },
        toolCalls: result.toolCalls,
        stoppedReason: signal.aborted ? 'aborted' : 'done',
      };
    } catch (err) {
      return {
        output: { finalText: '', articleCount: articles.length },
        toolCalls: 0,
        stoppedReason: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
