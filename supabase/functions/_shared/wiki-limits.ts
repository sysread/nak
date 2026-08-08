/**
 * Wiki char-limit constants for the edge function side.
 * Mirrors the four limits in src/lib/wiki.ts. Consolidated here
 * so the wiki tools (tools/wiki_create.ts, wiki_update.ts,
 * wiki_delete.ts), the record helpers (tools/_record_helpers.ts),
 * the wiki agent (agents/wiki.ts), the wiki_records agent
 * (agents/wiki_records.ts), and the embed input composer
 * (_shared/embed-input.ts) all reference one source instead of
 * maintaining independent copies.
 *
 * The browser-side src/lib/wiki.ts remains the canonical source.
 * A parity test comparing the values would close the remaining
 * cross-runtime gap.
 */

export const MAX_WIKI_TITLE_CHARS = 200;
export const MAX_WIKI_CONTENT_CHARS = 16000;
export const MAX_WIKI_RECORD_CONTENT_CHARS = 8000;
export const MAX_WIKI_CHANGELOG_MESSAGE_CHARS = 200;
