/**
 * Chat-side consumption of Web Share Target payloads.
 *
 * Called from Chat.svelte's onMount: drains anything the service
 * worker stashed in `share-store`, splits it into a text part and a
 * list of Files, and hands both back. Chat.svelte appends the text
 * to the composer and pushes each File through `addAttachment()` -
 * the same entry point the picker, drag-drop, and paste handlers
 * use. That means a shared image lands as an image chip on the
 * composer (downscaled and base64-encoded, ready for vision models),
 * a shared PDF runs through Venice's text-parser, and so on, rather
 * than dropping a useless `[shared file: foo.png, image/png, 132 KB]`
 * placeholder into the prompt.
 *
 * Policy:
 *   - Title / text / url fields are normalized into the text part.
 *     Some apps repeat the URL inside the text field (or vice versa),
 *     so we dedupe before concatenating.
 *   - Small text-like files (text/* MIME, a small allow-list of
 *     application/* MIMEs, or a code/markup extension; AND <= 256 KB)
 *     are inlined in full inside a fenced code block. Shared code
 *     snippets and text excerpts are usually short and reading them
 *     in-line in the prompt is what the user expects.
 *   - Everything else - binary files (images, audio, PDFs), oversized
 *     text files, or a text file whose bytes failed to decode - is
 *     emitted as a File on the `files` array so the composer's
 *     attachment pipeline handles it. That pipeline enforces the
 *     per-file / per-message size caps and surfaces errors on the
 *     preview chip, identical to any other attach pathway.
 *
 * The function is tolerant of empty payloads: `consumePendingShares`
 * resolves to `[]` on the common case (no share queued) and this
 * helper returns `{ text: '', files: [] }` so callers can merge
 * without null-guards.
 */

import { consumePendingShares, type SharedFile, type SharedPayload } from './share-store';

/**
 * Cap on inlined text-file size. 256 KB is enough for a long README
 * or a sizable source file without risking a megabyte paste that
 * silently exceeds the model's context window. Anything larger is
 * routed through the attachment pipeline instead, which runs the
 * file through Venice text extraction and enforces the
 * MAX_ATTACHMENT_BYTES / MAX_MESSAGE_AGGREGATE_BYTES caps.
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
 * Result shape produced by both the IDB-draining entry point and the
 * pure formatter below. `text` is what the composer textarea should
 * receive (empty string when nothing textual came through); `files`
 * is the list of File objects the caller should feed into the
 * composer's `addAttachment()` one at a time so the sequential
 * aggregate-size check works the same way it does for picker /
 * drag-drop inputs.
 */
export interface DrainedShares {
  text: string;
  files: File[];
}

/**
 * Drain the pending-shares queue and split the result into composer
 * text + a list of attachment-ready Files. Returns empty fields when
 * nothing is queued.
 */
export async function drainSharesForComposer(): Promise<DrainedShares> {
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
): Promise<DrainedShares> {
  if (!payloads.length) return { text: '', files: [] };
  const chunks: string[] = [];
  const files: File[] = [];
  for (const payload of payloads) {
    const piece = await formatPayload(payload);
    if (piece.text) chunks.push(piece.text);
    files.push(...piece.files);
  }
  return { text: chunks.join('\n\n---\n\n'), files };
}

async function formatPayload(payload: SharedPayload): Promise<DrainedShares> {
  const lines: string[] = [];
  const files: File[] = [];

  const title = payload.title.trim();
  const text = payload.text.trim();
  const url = payload.url.trim();

  if (title) lines.push(title);
  if (text) lines.push(text);
  // Suppress the URL when it's already in the text - many Android
  // apps duplicate the link across both fields and we'd otherwise
  // paste it twice.
  if (url && !text.includes(url)) lines.push(url);

  for (const shared of payload.files) {
    const handled = await handleFile(shared);
    if (handled.kind === 'inline') {
      lines.push(handled.text);
    } else {
      files.push(handled.file);
    }
  }

  return { text: lines.join('\n\n'), files };
}

type HandledFile =
  | { kind: 'inline'; text: string }
  | { kind: 'attachment'; file: File };

async function handleFile(shared: SharedFile): Promise<HandledFile> {
  if (isTextLike(shared) && shared.blob.size <= INLINE_TEXT_LIMIT_BYTES) {
    try {
      const raw = await readBlobAsText(shared.blob);
      // Trim trailing whitespace so the fence doesn't end with a
      // dangling blank line, but preserve leading whitespace - some
      // code files legitimately start with blank lines or BOM.
      const body = raw.replace(/\s+$/, '');
      const fence = pickFence(body);
      const lang = languageFromName(shared.name);
      const header = fileHeader(shared);
      return {
        kind: 'inline',
        text: `${header}\n${fence}${lang}\n${body}\n${fence}`,
      };
    } catch {
      // Reading the blob rejecting here is rare (basically only on a
      // detached buffer). Fall through to the attachment path so the
      // user at least gets a chip they can see and remove.
    }
  }
  return { kind: 'attachment', file: toFile(shared) };
}

function fileHeader(file: SharedFile): string {
  const sizeLabel = formatBytes(file.blob.size);
  return `[shared file: ${file.name || '(unnamed)'}${file.type ? `, ${file.type}` : ''}, ${sizeLabel}]`;
}

/**
 * Wrap a SharedFile's Blob in a real File so `addAttachment(file: File)`
 * accepts it. The share-store schema types the payload as Blob for
 * portability, but some browsers preserve the original File object
 * across the IDB round-trip - pass it through in that case rather
 * than rewrapping and losing lastModified.
 */
function toFile(shared: SharedFile): File {
  if (shared.blob instanceof File) return shared.blob;
  const name = shared.name || 'shared-file';
  const type = shared.type || shared.blob.type || 'application/octet-stream';
  return new File([shared.blob], name, { type });
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
