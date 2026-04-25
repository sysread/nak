/**
 * EmbeddingSource adapter for the `journal_entries` table. Lets the
 * background embeddings worker populate the `embedding` column on new
 * and edited entries so `journal_search` can do semantic search.
 *
 * Thin wrapper over two SupabaseService RPCs (`claimNextPendingJournalEntry`
 * and `saveJournalEntryEmbedding`) plus a string-builder helper. Same
 * shape as `./memories.ts`; the generic loop in `../loop.ts` drives
 * every source the worker registers.
 */
import type { SupabaseService } from '../../supabase';
import type { EmbeddingSource, PendingItem } from '../types';
import { MAX_JOURNAL_CONTENT_CHARS } from '../../agents/journal/types';

/**
 * Compose the text Venice actually embeds. We lead with topics + mood
 * (short high-signal strings) and a date stamp so a query like
 * "anxious about work last week" matches both semantic load and
 * temporal framing, then append the body. Double-newline between
 * blocks gives the embedding model a soft boundary so label-ish
 * strings don't smear into paragraphs.
 *
 * Defensive truncation mirrors the memories adapter: the tool
 * boundary already caps content, but historical rows or direct DB
 * writes might not have, and silent truncation here keeps the worker
 * from looping forever on a too-long row Venice rejects.
 *
 * Exported for direct unit testing.
 */
export function buildJournalEmbedInput(
  entryDate: string,
  content: string,
  topics: readonly string[],
  mood: string | null
): string {
  const head: string[] = [entryDate];
  if (topics.length > 0) head.push(topics.join(' | '));
  if (mood) head.push(`mood: ${mood}`);
  const body =
    content.length > MAX_JOURNAL_CONTENT_CHARS
      ? content.slice(0, MAX_JOURNAL_CONTENT_CHARS)
      : content;
  return `${head.join('\n')}\n\n${body}`;
}

export function createJournalSource(supabase: SupabaseService): EmbeddingSource {
  return {
    name: 'journal',
    async claimNext(holderId: string, ttlSeconds: number): Promise<PendingItem | null> {
      const row = await supabase.claimNextPendingJournalEntry(holderId, ttlSeconds);
      if (!row) return null;
      return {
        id: row.id,
        input: buildJournalEmbedInput(row.entry_date, row.content, row.topics, row.mood),
      };
    },
    async save(
      id: string,
      holderId: string,
      embedding: number[],
      model: string
    ): Promise<boolean> {
      return supabase.saveJournalEntryEmbedding(id, holderId, embedding, model);
    },
  };
}
