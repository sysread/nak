/**
 * Agent-only tool: upsert today's automatic journal entry. Called by
 * the journaling agent (src/lib/agents/journal/) after it has read
 * the thread's messages plus today's existing automatic entry and
 * decided what the consolidated entry should look like.
 *
 * NOT exposed in the main chat toolbox - only the background
 * journaling worker reaches for this. User-authored entries go
 * through the Reflections UI, which calls `createUserJournalEntry` /
 * `updateJournalEntry` directly.
 *
 * The underlying Supabase RPC handles the on-conflict merge for
 * `(user_id, entry_date, source='automatic')` so the agent doesn't
 * have to decide "create vs update" - it just names what the entry
 * should be right now and the RPC reconciles.
 */
import type { ToolDef } from './types';

/** Hard cap on the entry's Markdown body. Mirrors MAX_MEMORY_DATA_CHARS's rationale. */
export const MAX_JOURNAL_CONTENT_CHARS = 16000;

export const journalUpsert: ToolDef = {
  name: 'journal_upsert',
  description:
    "Create or update today's automatic journal entry for the user. " +
    "`entry_date` is required (YYYY-MM-DD in the user's local timezone; " +
    'you were told today above). `content` is Markdown. Optional: ' +
    '`topics` (short free-text chips), `mood` (single dominant tone), ' +
    '`people` (first names mentioned), `source_thread_ids` (thread UUIDs ' +
    "you derived the content from - these accumulate across your runs). " +
    'Merging: this tool upserts, so call it once per cycle with the ' +
    "consolidated view; the RPC unions source_thread_ids with whatever's " +
    'already stored.',
  shortDescription: "save today's automatic entry",
  parameters: {
    type: 'object',
    properties: {
      entry_date: {
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        description: "ISO date (YYYY-MM-DD) in the user's local timezone.",
      },
      content: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_JOURNAL_CONTENT_CHARS,
        description: `Full Markdown body (max ${MAX_JOURNAL_CONTENT_CHARS} chars).`,
      },
      topics: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 64 },
        maxItems: 24,
        description: 'Short free-text topic chips (<= 24).',
      },
      mood: {
        type: 'string',
        maxLength: 64,
        description: 'Single dominant mood/tone for the day.',
      },
      people: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 64 },
        maxItems: 24,
        description: 'First names / identifiers of people mentioned (<= 24).',
      },
      source_thread_ids: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 32,
        description:
          'Thread UUIDs this entry was derived from (<= 32). Accumulated ' +
          'across worker cycles; pass the ids you saw this run.',
      },
    },
    required: ['entry_date', 'content'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const entryDate = typeof args.entry_date === 'string' ? args.entry_date : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
      throw new Error('entry_date must match YYYY-MM-DD');
    }
    const content = typeof args.content === 'string' ? args.content.trim() : '';
    if (!content) throw new Error('content is required');
    if (content.length > MAX_JOURNAL_CONTENT_CHARS) {
      throw new Error(
        `content exceeds ${MAX_JOURNAL_CONTENT_CHARS}-char limit (got ${content.length})`
      );
    }
    const topics = Array.isArray(args.topics)
      ? (args.topics as unknown[]).filter(
          (t): t is string => typeof t === 'string' && t.length > 0
        )
      : [];
    const mood = typeof args.mood === 'string' && args.mood.length > 0 ? args.mood : null;
    const people = Array.isArray(args.people)
      ? (args.people as unknown[]).filter(
          (p): p is string => typeof p === 'string' && p.length > 0
        )
      : [];
    const sourceThreadIds = Array.isArray(args.source_thread_ids)
      ? (args.source_thread_ids as unknown[]).filter(
          (s): s is string => typeof s === 'string' && s.length > 0
        )
      : [];
    const row = await ctx.supabase.upsertJournalAutomaticEntry({
      entryDate,
      content,
      topics,
      mood,
      people,
      sourceThreadIds,
    });
    // Project down to a compact result for the model - the full
    // `source_thread_ids` list is useful for debugging but noise for
    // the LLM after the upsert settled.
    return {
      id: row.id,
      entry_date: row.entry_date,
      source: row.source,
      updated_at: row.updated_at,
      source_thread_count: row.source_thread_ids.length,
    };
  },
};
