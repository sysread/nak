/**
 * EmbeddingSource adapter for the `threads` table. Feeds the drawer's
 * search feature: the background worker embeds `title + summary` so
 * `search_threads_by_embedding` has a vector to rank against when the
 * user types a query.
 *
 * The summary itself is written by a separate agent
 * (`src/lib/agents/summary/*`) — two workers, two stages. Keeping them
 * separate lets the summary be regenerated without re-embedding and
 * vice versa, and the trigger on `threads` nulls `embedding` whenever
 * `title` or `summary` changes so the worker naturally re-picks the
 * row up on its next poll.
 *
 * See `../types.ts` for the interface contract and the
 * polymorphic-code-not-polymorphic-data rationale.
 */
import type { SupabaseService } from '../../supabase';
import type { EmbeddingSource, PendingItem } from '../types';

/**
 * Hard cap on the combined `title + summary` length fed to Venice.
 * Summaries are 2–3 sentences by design (see the summary agent's
 * prompt), so 2000 chars is comfortably beyond the worst-case. bge-m3's
 * ~512-token limit (~2–4k chars) is the actual ceiling; we truncate
 * defensively so a runaway summary can't loop the worker on a row
 * Venice rejects.
 */
export const MAX_THREAD_EMBED_INPUT_CHARS = 2000;

/**
 * Compose the string Venice embeds for a thread. Title first — it's
 * the user's own mental index, and when the summary is still null
 * (the summary worker hasn't caught up yet) the title alone is a
 * valid if weaker signal. Double-newline separator matches the
 * memories adapter for consistency; bge-m3 treats it as a soft
 * boundary rather than smearing the two parts together.
 *
 * Exported for direct unit testing — the null-summary branch is the
 * load-bearing one (new thread, summary worker hasn't run yet) and
 * worth a dedicated test.
 */
export function buildThreadEmbedInput(title: string, summary: string | null): string {
  const combined = summary ? `${title}\n\n${summary}` : title;
  return combined.length > MAX_THREAD_EMBED_INPUT_CHARS
    ? combined.slice(0, MAX_THREAD_EMBED_INPUT_CHARS)
    : combined;
}

export function createThreadsSource(supabase: SupabaseService): EmbeddingSource {
  return {
    name: 'threads',
    async claimNext(holderId: string, ttlSeconds: number): Promise<PendingItem | null> {
      const row = await supabase.claimNextPendingThreadForEmbedding(holderId, ttlSeconds);
      if (!row) return null;
      return { id: row.id, input: buildThreadEmbedInput(row.title, row.summary) };
    },
    async save(
      id: string,
      holderId: string,
      embedding: number[],
      model: string
    ): Promise<boolean> {
      return supabase.saveThreadEmbedding(id, holderId, embedding, model);
    },
  };
}
