/**
 * Reflections export helpers. Two surfaces:
 *
 *   1. `downloadEntryMarkdown` - one-entry `.md` file via a Blob +
 *      hidden anchor click. No external dependency.
 *   2. `downloadFullArchive` - every entry zipped as
 *      `reflections/yyyy-mm-dd.md`, using jszip. Dynamic import so
 *      the library only lands on the main-bundle wire for users who
 *      actually reach for the feature.
 */
import type { JournalEntry, SupabaseService } from './supabase';

function formatEntryMarkdown(entry: JournalEntry): string {
  const tags: string[] = [];
  if (entry.topics.length > 0) tags.push(`topics: ${entry.topics.join(', ')}`);
  if (entry.mood) tags.push(`mood: ${entry.mood}`);
  if (entry.people.length > 0) tags.push(`people: ${entry.people.join(', ')}`);
  const sourceLabel = entry.source === 'automatic' ? 'Automatic' : 'User Entry';
  const lines: string[] = [
    `# ${entry.entry_date}`,
    '',
    `_Source: ${sourceLabel}_`,
    '',
  ];
  if (tags.length > 0) lines.push(`_${tags.join(' / ')}_`, '');
  lines.push(entry.content);
  return lines.join('\n') + '\n';
}

/**
 * Combine both sources for one day into a single Markdown blob. Used
 * by the ZIP export so each filename is one-file-per-day and the
 * user sees both cards inside without having to stitch two files
 * back together.
 */
function formatDayMarkdown(date: string, entries: JournalEntry[]): string {
  const automatic = entries.find((e) => e.source === 'automatic');
  const user = entries.find((e) => e.source === 'user');
  const out: string[] = [`# ${date}`, ''];
  if (automatic) {
    out.push('## Automatic');
    out.push('');
    const tags: string[] = [];
    if (automatic.topics.length > 0) tags.push(`topics: ${automatic.topics.join(', ')}`);
    if (automatic.mood) tags.push(`mood: ${automatic.mood}`);
    if (automatic.people.length > 0) tags.push(`people: ${automatic.people.join(', ')}`);
    if (tags.length > 0) out.push(`_${tags.join(' / ')}_`, '');
    out.push(automatic.content, '');
  }
  if (user) {
    out.push('## User Entry');
    out.push('');
    const tags: string[] = [];
    if (user.topics.length > 0) tags.push(`topics: ${user.topics.join(', ')}`);
    if (user.mood) tags.push(`mood: ${user.mood}`);
    if (user.people.length > 0) tags.push(`people: ${user.people.join(', ')}`);
    if (tags.length > 0) out.push(`_${tags.join(' / ')}_`, '');
    out.push(user.content, '');
  }
  return out.join('\n');
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function downloadEntryMarkdown(entry: JournalEntry): void {
  const md = formatEntryMarkdown(entry);
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const suffix = entry.source === 'user' ? 'user' : 'auto';
  triggerDownload(blob, `reflection-${entry.entry_date}-${suffix}.md`);
}

/**
 * Build and download a ZIP of every entry, organised as
 * `reflections/yyyy-mm-dd.md`. Loads jszip lazily.
 *
 * The export pulls up to 2000 entries - enough for ~5.5 years of
 * daily journaling. A user past that needs pagination; we'll cross
 * that bridge if anyone actually hits it.
 */
export async function downloadFullArchive(supabase: SupabaseService): Promise<void> {
  const entries = await supabase.listJournalEntries({ limit: 2000 });
  if (entries.length === 0) {
    throw new Error('No journal entries to export.');
  }
  // Group by date. An `entries` array sorted newest-first is fine
  // for the group pass.
  const byDate = new Map<string, JournalEntry[]>();
  for (const e of entries) {
    const bucket = byDate.get(e.entry_date);
    if (bucket) bucket.push(e);
    else byDate.set(e.entry_date, [e]);
  }
  // Dynamic import so jszip doesn't ride every bundle. jszip ships
  // as CommonJS with a default export; Vite resolves this to a
  // single import binding regardless.
  const mod = await import('jszip');
  const JSZip = (mod.default ?? mod) as typeof import('jszip');
  const zip = new JSZip();
  const folder = zip.folder('reflections') ?? zip;
  for (const [date, dayEntries] of byDate) {
    folder.file(`${date}.md`, formatDayMarkdown(date, dayEntries));
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const stamp = new Date().toISOString().slice(0, 10);
  triggerDownload(blob, `nak-reflections-${stamp}.zip`);
}

export { formatEntryMarkdown, formatDayMarkdown };
