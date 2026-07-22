/**
 * Conversation transcript export: pure builders that turn a thread and
 * its message rows into a self-contained Markdown document plus the
 * filename it downloads as. The browser-only download step lives in
 * src/lib/download.ts; the Chat screen wires the two together from the
 * top-bar button and the thread row menu.
 */
import type { Message, Thread } from '../supabase';

/**
 * Slugify the thread title for the download filename. Mirrors the wiki
 * export slug rules (lowercase, alphanumerics + hyphens, capped at 60
 * chars); an untitled or all-symbol title falls back to a short id
 * prefix so the file never downloads as just ".md".
 */
export function transcriptExportFilename(
  thread: Pick<Thread, 'id' | 'title'>,
): string {
  const base = thread.title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return `${base || thread.id.slice(0, 8)}.md`;
}

/**
 * Whether the top-bar export button should be actionable: there must be
 * a persisted current thread (drafts have no rows to export), it must
 * have at least one message, and the transcript must actually be on
 * screen (the daily digest panel replaces it while open).
 */
export function canExportTranscript(
  thread: Pick<Thread, 'isDraft'> | null,
  digestOpen: boolean,
  messageCount: number,
): boolean {
  return thread !== null && !thread.isDraft && !digestOpen && messageCount > 0;
}

/** Speaker headings for the two roles the transcript keeps. */
const ROLE_LABELS: Record<'user' | 'assistant', string> = {
  user: 'User',
  assistant: 'Assistant',
};

/**
 * Format an ISO timestamp as `yyyy-mm-dd hh:mm` in the viewer's local
 * timezone. Manual padding rather than toLocaleString so the output is
 * stable across runtimes and locales (and therefore testable).
 */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * The conversation as a Markdown document: an H1 title, a Created
 * metadata line, then one `## User - <timestamp>` / `## Assistant -
 * <timestamp>` section per visible turn. System and tool rows are
 * plumbing, not conversation, and are dropped - as are assistant rows
 * whose content is empty (pure tool-call rows). Message bodies are
 * emitted verbatim; the app authors them in Markdown already. User
 * attachments are noted by filename so the transcript records that a
 * file was part of the turn even though the bytes stay behind.
 */
export function buildTranscriptMarkdown(
  thread: Pick<Thread, 'title' | 'created_at'>,
  messages: readonly Message[],
): string {
  const lines: string[] = [
    `# ${thread.title.trim() || 'Untitled conversation'}`,
    '',
    `Created: ${formatTimestamp(thread.created_at)}`,
    '',
  ];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const body = m.content.trim();
    if (!body) continue;
    lines.push(`## ${ROLE_LABELS[m.role]} - ${formatTimestamp(m.created_at)}`, '');
    const names = (m.attachments ?? []).map((a) => a.filename).filter(Boolean);
    if (names.length > 0) {
      lines.push(`*Attachments: ${names.join(', ')}*`, '');
    }
    lines.push(body, '');
  }
  return lines.join('\n');
}
