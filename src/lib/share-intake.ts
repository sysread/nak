/**
 * Chat-side consumption of Web Share Target payloads.
 *
 * Called from Chat.svelte's onMount: drains anything the service
 * worker stashed in `share-store`, flattens it into a single string
 * the composer can take, and returns that string to the caller.
 *
 * Policy:
 *   - Text-like files (based on MIME prefix OR a small allow-list of
 *     extensions) are inlined in full so shared code snippets / text
 *     excerpts become part of the prompt the model sees.
 *   - Binary files (images, audio, PDFs, etc.) are described by
 *     name/type/size rather than dropped. Nak's composer today is
 *     text-only — dropping the raw bytes into the prompt would
 *     corrupt the message, and silently skipping them would hide
 *     the fact that the share happened. A visible "[shared file:
 *     foo.png, image/png, 132 KB]" line lets the user annotate or
 *     strip it before sending.
 *   - Title / text / url fields are normalized: some apps repeat
 *     the URL inside the text field (or vice versa), so we dedupe
 *     before concatenating.
 *
 * The function is tolerant of empty payloads: `consumePendingShares`
 * resolves to `[]` on the common case (no share queued) and this
 * helper returns `''` so callers can short-circuit.
 */

import { consumePendingShares, type SharedFile, type SharedPayload } from './share-store';

/**
 * Cap on inlined text-file size. 256 KB is enough for a long README
 * or a sizable source file without risking a megabyte paste that
 * silently exceeds the model's context window — oversized files are
 * described rather than inlined and the user can choose to re-share
 * a smaller excerpt.
 */
const INLINE_TEXT_LIMIT_BYTES = 256 * 1024;

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'xml',
  'yaml',
  'yml',
  'toml',
  'ini',
  'log',
  'html',
  'htm',
  'css',
  'js',
  'mjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'sh',
  'bash',
  'zsh',
  'fish',
  'sql',
  'svelte',
  'vue',
  'php',
]);

/**
 * Drain the pending-shares queue and flatten the result into a
 * composer-ready string. Returns `''` when nothing is queued.
 */
export async function drainSharesForComposer(): Promise<string> {
  const payloads = await consumePendingShares();
  return formatSharesForComposer(payloads);
}

/**
 * Pure formatter split out from `drainSharesForComposer` so tests
 * don't have to stub IndexedDB. Callers that already have payloads
 * in hand (e.g. a dev-tools debug shim) can also use this directly.
 */
export async function formatSharesForComposer(
  payloads: SharedPayload[]
): Promise<string> {
  if (!payloads.length) return '';
  const chunks: string[] = [];
  for (const payload of payloads) {
    const piece = await formatPayload(payload);
    if (piece) chunks.push(piece);
  }
  return chunks.join('\n\n---\n\n');
}

async function formatPayload(payload: SharedPayload): Promise<string> {
  const lines: string[] = [];

  const title = payload.title.trim();
  const text = payload.text.trim();
  const url = payload.url.trim();

  if (title) lines.push(title);
  if (text) lines.push(text);
  // Suppress the URL when it's already in the text — many Android
  // apps duplicate the link across both fields and we'd otherwise
  // paste it twice.
  if (url && !text.includes(url)) lines.push(url);

  for (const file of payload.files) {
    const rendered = await renderFile(file);
    if (rendered) lines.push(rendered);
  }

  return lines.join('\n\n');
}

async function renderFile(file: SharedFile): Promise<string> {
  const sizeLabel = formatBytes(file.blob.size);
  const header = `[shared file: ${file.name || '(unnamed)'}${file.type ? `, ${file.type}` : ''}, ${sizeLabel}]`;

  if (!isTextLike(file)) return header;
  if (file.blob.size > INLINE_TEXT_LIMIT_BYTES) {
    return `${header}\n(too large to inline — ${sizeLabel} exceeds ${formatBytes(INLINE_TEXT_LIMIT_BYTES)})`;
  }

  try {
    const text = await readBlobAsText(file.blob);
    // Trim trailing whitespace so the fence doesn't end with a
    // dangling blank line, but preserve leading whitespace — some
    // code files legitimately start with blank lines or BOM.
    const body = text.replace(/\s+$/, '');
    const fence = pickFence(body);
    const lang = languageFromName(file.name);
    return `${header}\n${fence}${lang}\n${body}\n${fence}`;
  } catch {
    // Reading the blob rejecting here is extremely rare (basically
    // only on a detached buffer) — fall back to the header-only
    // form so the user at least sees the file was shared.
    return header;
  }
}

/**
 * Read a Blob as UTF-8 text. Modern browsers expose `Blob.prototype.text`
 * directly; we prefer that when available. Older browsers and the jsdom
 * environment used by the unit tests don't implement it, so we fall back
 * to `FileReader.readAsText`, which has been around essentially forever.
 */
function readBlobAsText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => resolve(String(reader.result ?? ''));
    reader.onerror = (): void => reject(reader.error);
    reader.readAsText(blob);
  });
}

function isTextLike(file: SharedFile): boolean {
  const type = file.type.toLowerCase();
  if (type.startsWith('text/')) return true;
  // Some browsers / OSes hand us `application/json`,
  // `application/xml`, etc. for files the user would absolutely
  // expect to paste as text. Whitelist the common ones.
  if (
    type === 'application/json' ||
    type === 'application/xml' ||
    type === 'application/x-yaml' ||
    type === 'application/yaml' ||
    type === 'application/javascript' ||
    type === 'application/typescript'
  ) {
    return true;
  }
  const ext = extensionOf(file.name);
  return ext !== null && TEXT_EXTENSIONS.has(ext);
}

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Pick a code-fence length long enough that no run of backticks in
 * the file's own contents closes it prematurely. Starts at three and
 * grows if the content contains that run length.
 */
function pickFence(body: string): string {
  let len = 3;
  while (body.includes('`'.repeat(len))) len += 1;
  return '`'.repeat(len);
}

function languageFromName(name: string): string {
  const ext = extensionOf(name);
  if (!ext) return '';
  // Small translation layer for cases where the extension is not
  // the same as highlight.js's language id. Everything else passes
  // through as-is and highlight.js either recognizes it or falls
  // back to plain rendering.
  switch (ext) {
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'yml':
      return 'yaml';
    default:
      return ext;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
