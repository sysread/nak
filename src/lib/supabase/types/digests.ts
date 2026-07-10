/**
 * Row types + coercers for the conversation_digests table (the daily
 * conversation recaps the digest sweep agent writes; see
 * docs/dev/conversation-digest.md). The threads column is JSONB from
 * the wire, so every field is defensively coerced - a malformed entry
 * degrades to a skipped row rather than a render crash.
 */

/** One conversation's snapshot inside a daily digest. */
export interface DigestThreadEntry {
  /**
   * The source thread's id. The panel deep-links through it; the
   * thread may have been deleted since the digest was written, in
   * which case the link lands on an empty transcript (the title
   * snapshot below keeps the digest itself readable).
   */
  thread_id: string;
  title: string;
  summary: string;
}

/** One (user, local calendar day) digest row. */
export interface ConversationDigest {
  id: string;
  /** Plain YYYY-MM-DD date in the USER'S timezone, not a UTC bucket. */
  digest_date: string;
  summary: string;
  threads: DigestThreadEntry[];
  created_at: string;
}

function coerceDigestThreadEntry(raw: unknown): DigestThreadEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.thread_id !== 'string' || r.thread_id.length === 0) return null;
  return {
    thread_id: r.thread_id,
    title: typeof r.title === 'string' && r.title.length > 0 ? r.title : 'Untitled',
    summary: typeof r.summary === 'string' ? r.summary : '',
  };
}

export function coerceConversationDigest(
  raw: Record<string, unknown>
): ConversationDigest | null {
  const id = raw.id;
  const digestDate = raw.digest_date;
  if (typeof id !== 'string' || typeof digestDate !== 'string') return null;
  const threadsRaw = Array.isArray(raw.threads) ? raw.threads : [];
  const threads: DigestThreadEntry[] = [];
  for (const t of threadsRaw) {
    const entry = coerceDigestThreadEntry(t);
    if (entry) threads.push(entry);
  }
  return {
    id,
    digest_date: digestDate,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    threads,
    created_at: String(raw.created_at ?? ''),
  };
}
