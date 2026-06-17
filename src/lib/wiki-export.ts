/**
 * Wiki export: a single record or a whole article + its records, as
 * Markdown. Record/article bodies are already authored in Markdown, so
 * export just prepends a small front-matter header and (for the article
 * bundle) packs everything into a ZIP.
 *
 * The Markdown builders (buildRecordMarkdown / buildArticleMarkdown) are
 * pure and unit-tested; the download + zip functions touch the DOM and
 * fflate and run browser-only. fflate is a tiny, tree-shakeable zlib
 * implementation - no Node Buffer dependency, works in the browser and
 * the service worker.
 */
import { zipSync, strToU8 } from 'fflate';
import type { WikiArticle, WikiRecord } from './supabase';
import { recordExportFilename } from './ui/wiki-records';

/**
 * One record as a standalone Markdown document: a small YAML-ish front-
 * matter block (date, tags) followed by the record's Markdown body. The
 * body is emitted verbatim - it is already Markdown.
 */
export function buildRecordMarkdown(record: WikiRecord): string {
  const lines: string[] = ['---', `date: ${record.date}`];
  if (record.tags.length > 0) {
    lines.push(`tags: [${record.tags.join(', ')}]`);
  }
  lines.push('---', '', record.content.trimEnd(), '');
  return lines.join('\n');
}

/**
 * The article body as Markdown, with an H1 title prepended when the body
 * does not already open with one. Most article bodies are written
 * without a leading title (the UI renders the title from the row), so
 * the export adds it for a self-contained file.
 */
export function buildArticleMarkdown(article: WikiArticle): string {
  const body = article.content.trimEnd();
  if (/^#\s/.test(body)) return body + '\n';
  return `# ${article.title}\n\n${body}\n`;
}

/** Trigger a browser download of a text blob. Browser-only. */
function downloadText(filename: string, text: string, mime = 'text/markdown'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Download one record as `yyyy-mm-dd-<slug>.md`. */
export function downloadRecordMarkdown(record: WikiRecord): void {
  downloadText(recordExportFilename(record), buildRecordMarkdown(record));
}

/**
 * Slugify an article title for the ZIP filename. Mirrors the record
 * slug rules (lowercase, alphanumerics + hyphens) but operates on the
 * title rather than the body.
 */
export function articleSlug(article: Pick<WikiArticle, 'id' | 'title'>): string {
  const base = article.title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base || article.id.slice(0, 8);
}

/**
 * Build the in-memory ZIP for an article + its records:
 *   article.md
 *   records/yyyy-mm-dd-<slug>.md   (one per record)
 *
 * Pure (returns the zipped bytes); the download wrapper below triggers
 * the browser save. Duplicate record filenames (two records that slug
 * identically on the same date) get a numeric suffix so none are
 * silently dropped from the archive.
 */
export function buildArticleZip(
  article: WikiArticle,
  records: readonly WikiRecord[],
): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'article.md': strToU8(buildArticleMarkdown(article)),
  };
  const used = new Set<string>(['article.md']);
  for (const record of records) {
    let name = `records/${recordExportFilename(record)}`;
    if (used.has(name)) {
      // Disambiguate collisions with a numeric suffix before the
      // extension so every record lands in the archive.
      const stem = name.replace(/\.md$/, '');
      let i = 2;
      while (used.has(`${stem}-${i}.md`)) i += 1;
      name = `${stem}-${i}.md`;
    }
    used.add(name);
    files[name] = strToU8(buildRecordMarkdown(record));
  }
  return zipSync(files);
}

/** Download an article + records as a ZIP. Browser-only. */
export function downloadArticleZip(
  article: WikiArticle,
  records: readonly WikiRecord[],
): void {
  const bytes = buildArticleZip(article, records);
  // Slice into a fresh ArrayBuffer-backed view so the Blob constructor
  // gets a plain Uint8Array regardless of fflate's internal buffer.
  const blob = new Blob([bytes.slice()], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${articleSlug(article)}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
