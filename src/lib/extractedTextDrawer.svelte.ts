/**
 * Right-side drawer that shows the text Venice's text-parser extracted
 * from a document attachment. Used from `MessageAttachments.svelte` —
 * clicking the "Extracted text" button on an attachment row calls
 * `extractedTextDrawer.open({filename, text})`; the `<ExtractedTextDrawer />`
 * mount in `Chat.svelte` reads the rune and renders.
 *
 * A single global instance keeps the mount simple — the drawer is modal-
 * adjacent (only one open at a time is the sensible UX) and lives
 * outside the message list's rendering tree. An in-message inline
 * expansion was considered but rejected: long extracted text
 * (multi-page PDFs) would force a scroll battle with the transcript,
 * and the drawer gives the reader a full-height panel without
 * displacing anything.
 *
 * Rune-based singleton rather than a Svelte store so the consumer
 * reads `extractedTextDrawer.state` directly — no `$store` prefix, no
 * subscribe boilerplate, and it slots into runes-mode components
 * without the interop dance.
 */

export interface ExtractedTextDrawerPayload {
  filename: string;
  text: string;
}

interface DrawerState {
  /** When non-null, the drawer is open with this content. */
  payload: ExtractedTextDrawerPayload | null;
}

function createDrawer() {
  const state = $state<DrawerState>({ payload: null });

  return {
    get state(): DrawerState {
      return state;
    },
    open(payload: ExtractedTextDrawerPayload): void {
      state.payload = payload;
    },
    close(): void {
      state.payload = null;
    },
  };
}

export const extractedTextDrawer = createDrawer();
