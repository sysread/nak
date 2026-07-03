/**
 * UI-behavior primitives for the Memories detail panel. Pure
 * functions only - no runes, no Svelte imports, no DOM. The
 * companion `src/screens/Memories.svelte` composes these with its
 * own framework-native reactivity (the memoriesStore reads, the
 * supabase fetch orchestration, the $bindable top-bar triggers,
 * and the markup).
 *
 * Sibling modules split the memories browser by surface:
 * `memories-list.ts` owns the sidebar listing, `memory-changelog-
 * panel.ts` the changelog default surface, `memory-librarian.ts`
 * the manual-run strip. This module owns the decisions specific to
 * the one-card detail panel: which body surface renders, the
 * per-card action-status vocabulary, form validation, and the
 * card's display formatters.
 */

import {
  classifyMemoryConfidence,
  MAX_MEMORY_CHANGELOG_MESSAGE_CHARS,
  MAX_MEMORY_DATA_CHARS,
} from '$lib/memories';

// Label length is capped at 80 by the memory_create/update tool
// schemas; mirror it here so the UI rejects early instead of
// bouncing off a Supabase error. Data length is capped at
// MAX_MEMORY_DATA_CHARS (in $lib/memories).
export const MAX_LABEL_CHARS = 80;

// How many neighbours the "Similar memories" disclosure pulls. Small
// on purpose - the section is a quick lateral jump to closely-related
// memories, not a second search surface.
export const SIMILAR_MEMORIES_LIMIT = 10;

// Note length cap on a relation edge, mirroring the memory_relate
// tool schema so the picker rejects early instead of bouncing off
// the server.
export const MAX_RELATION_NOTE_CHARS = 500;

/**
 * The relation kinds a user can pick in the + Relate picker. Mirrors
 * the `memory_relations.kind` check constraint in schema.sql - the
 * picker offers exactly what the DB accepts.
 */
export const RELATION_KINDS = [
  'supports',
  'contradicts',
  'generalises',
  'specialises',
] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

// ---------------------------------------------------------------
// Per-card action status (Reaffirm / Doubt / confirmed Delete)
// ---------------------------------------------------------------

/**
 * Inline busy/feedback vocabulary for the per-card action buttons
 * (Reaffirm / Doubt / confirmed Delete). Without a visible
 * indicator, a click that didn't cross a confidence threshold looks
 * like the button silently no-op'd ("did it work? do I click
 * again?"). The panel always shows the user their click did
 * something: while a call is in flight the targeted button reads
 * "Reaffirming..." / "Doubting..." / "Deleting..." and the sibling
 * action buttons disable so a second mutation can't fire against
 * the same row mid-flight; on completion a brief success label
 * flashes and auto-clears, and errors surface inline in the same
 * slot. Edit and + Relate aren't covered because their visual
 * feedback is the form/picker mounting - no network round-trip to
 * cover.
 */
export type MemoryActionKind = 'reaffirm' | 'doubt' | 'delete';
export type MemoryActionStatus =
  | { kind: 'idle' }
  | { kind: 'busy'; action: MemoryActionKind; memoryId: string }
  | { kind: 'done'; action: MemoryActionKind; memoryId: string }
  | {
      kind: 'error';
      action: MemoryActionKind;
      memoryId: string;
      message: string;
    };

// Window the "done" pulse stays up before auto-clearing back to idle.
// Long enough to register as success, short enough that the user can
// click again immediately without waiting for it to fade.
export const ACTION_DONE_LINGER_MS = 1200;

/** Button caption for an action, swapping to the in-flight
 *  progressive form while the RPC is running. */
export function actionLabel(action: MemoryActionKind, busy: boolean): string {
  if (!busy) {
    if (action === 'reaffirm') return 'Reaffirm';
    if (action === 'doubt') return 'Doubt';
    return 'Delete';
  }
  if (action === 'reaffirm') return 'Reaffirming...';
  if (action === 'doubt') return 'Doubting...';
  return 'Deleting...';
}

/** Success-pulse caption, past tense of the action the user fired. */
function actionDoneLabel(action: MemoryActionKind): string {
  if (action === 'reaffirm') return 'Reaffirmed';
  if (action === 'doubt') return 'Doubted';
  return 'Deleted';
}

/** Error-slot prefix naming which action failed - the RPC message
 *  gets appended after it, so the user can tell a failed doubt from
 *  a failed delete without re-deriving it from context. */
function actionErrorPrefix(action: MemoryActionKind): string {
  if (action === 'reaffirm') return "Couldn't reaffirm";
  if (action === 'doubt') return "Couldn't doubt";
  return "Couldn't delete";
}

/**
 * True iff some action is currently mid-flight against the given
 * memory. Used by every action button on the card to grey itself
 * out (`disabled`) so the user can't stack mutations on the same
 * row. Cross-row disabling isn't needed - actions are per-row and
 * the panel only shows one card at a time today, but the predicate
 * is keyed by id so a future multi-card view stays correct.
 */
export function isAnyActionBusyFor(
  status: MemoryActionStatus,
  memoryId: string,
): boolean {
  return status.kind === 'busy' && status.memoryId === memoryId;
}

/** True iff this specific action is the one mid-flight on this
 *  memory - drives the busy caption and the `is-busy` styling on
 *  the one button doing work, distinct from its inert siblings. */
export function isActionBusyForRow(
  status: MemoryActionStatus,
  memoryId: string,
  action: MemoryActionKind,
): boolean {
  return (
    status.kind === 'busy' &&
    status.action === action &&
    status.memoryId === memoryId
  );
}

/**
 * True iff the status is the "done" pulse for exactly this action on
 * exactly this memory. The auto-clear timer uses this so it only
 * collapses the badge if it's still describing the same success - a
 * follow-up click that started a new action will have replaced the
 * status with a `busy` entry, and clobbering that would visually
 * swallow the in-flight call.
 */
export function isActionDoneFor(
  status: MemoryActionStatus,
  memoryId: string,
  action: MemoryActionKind,
): boolean {
  return (
    status.kind === 'done' &&
    status.memoryId === memoryId &&
    status.action === action
  );
}

/** True iff the status is a settled outcome (done or error) for this
 *  memory - the delete-confirm strip clears these on open so a
 *  leftover badge from a previous attempt doesn't read as the
 *  current attempt's result. */
export function isActionSettledFor(
  status: MemoryActionStatus,
  memoryId: string,
): boolean {
  return (
    (status.kind === 'done' || status.kind === 'error') &&
    status.memoryId === memoryId
  );
}

/**
 * The done/error pulse rendered in the card's actions row, or null
 * when the status is idle, busy, or concerns a different memory.
 * `className` matches the `.memory-action-state` modifier rules in
 * the panel's stylesheet: `action-ok` for the success flash, `error`
 * for the failure banner.
 */
export function memoryActionNotice(
  status: MemoryActionStatus,
  memoryId: string,
): { text: string; className: 'action-ok' | 'error' } | null {
  if (status.kind === 'done' && status.memoryId === memoryId) {
    return { text: `${actionDoneLabel(status.action)} ✓`, className: 'action-ok' };
  }
  if (status.kind === 'error' && status.memoryId === memoryId) {
    return {
      text: `${actionErrorPrefix(status.action)} - ${status.message}`,
      className: 'error',
    };
  }
  return null;
}

// ---------------------------------------------------------------
// Edit-form save state
// ---------------------------------------------------------------

/**
 * Three-state-plus save indicator for the inline edit form,
 * mirroring the pattern in Settings' system-prompts pane. The goal
 * is that the user never has to guess whether their edit is live -
 * every state transition is visible.
 */
export type MemorySaveState =
  | { kind: 'idle' }
  | { kind: 'dirty' } // draft differs from server row
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

/**
 * The status line rendered in the edit form's footer, or null when
 * there's nothing to report (idle). `className` matches the classes
 * the footer's stylesheet expects: informational states render
 * subtle, the saved flash adds the green `save-ok` cue, errors use
 * the global `.error` helper.
 */
export function saveStateNotice(
  state: MemorySaveState,
): { text: string; className: 'subtle' | 'subtle save-ok' | 'error' } | null {
  if (state.kind === 'dirty') {
    return { text: 'Unsaved changes', className: 'subtle' };
  }
  if (state.kind === 'saving') {
    return { text: 'Saving…', className: 'subtle' };
  }
  if (state.kind === 'saved') {
    return { text: 'Saved ✓', className: 'subtle save-ok' };
  }
  if (state.kind === 'error') {
    return { text: `Couldn't save - ${state.message}`, className: 'error' };
  }
  return null;
}

// ---------------------------------------------------------------
// Form validation
// ---------------------------------------------------------------

/**
 * Validate the required one-line changelog note that both the edit
 * and delete flows demand - the user's manual equivalent of the
 * `message` param the memory_update / memory_delete tools require
 * of the assistant. `context` picks the verb in the "add a message
 * first" nudge so the copy names the action the user is mid-way
 * through. Expects a pre-trimmed message (the caller trims because
 * it also sends the trimmed text to the RPC). Returns the error to
 * display, or null when the message passes.
 */
export function changelogMessageError(
  message: string,
  context: 'saving' | 'deleting',
): string | null {
  if (!message) {
    return `Add a one-line change message before ${
      context === 'saving' ? 'saving' : 'deleting'
    }.`;
  }
  if (message.length > MAX_MEMORY_CHANGELOG_MESSAGE_CHARS) {
    return `Change message must be ${MAX_MEMORY_CHANGELOG_MESSAGE_CHARS} chars or fewer.`;
  }
  return null;
}

/**
 * First validation error for the edit form's three fields, or null
 * when the draft is saveable. Check order matches the form's visual
 * order (label, data, message) so the reported error is always the
 * topmost offending field. Expects pre-trimmed label and message
 * (data is taken verbatim - trailing whitespace in a memory body is
 * the user's call).
 */
export function memoryEditError(
  label: string,
  data: string,
  message: string,
): string | null {
  if (!label) return 'Label is required.';
  if (label.length > MAX_LABEL_CHARS) {
    return `Label must be ${MAX_LABEL_CHARS} chars or fewer.`;
  }
  if (!data) return 'Data is required.';
  if (data.length > MAX_MEMORY_DATA_CHARS) {
    return `Data must be ${MAX_MEMORY_DATA_CHARS} chars or fewer.`;
  }
  return changelogMessageError(message, 'saving');
}

/** First validation error for the relation picker's optional note,
 *  or null. Expects a pre-trimmed note; empty is fine (the note is
 *  optional), only overlong notes are rejected. */
export function relationNoteError(note: string): string | null {
  if (note.length > MAX_RELATION_NOTE_CHARS) {
    return `Note must be ${MAX_RELATION_NOTE_CHARS} chars or fewer.`;
  }
  return null;
}

/**
 * Does this RPC failure mean the relation edge already exists?
 * Postgres surfaces a unique-constraint violation as message text,
 * not a structured code, by the time it reaches the browser client.
 * The panel treats it as success - the user gets the same outcome
 * they asked for.
 */
export function isDuplicateRelationError(message: string): boolean {
  return (
    message.includes('duplicate key value') ||
    message.includes('unique constraint')
  );
}

// ---------------------------------------------------------------
// Display formatters
// ---------------------------------------------------------------

/**
 * Human-friendly "N minutes ago" for the card's updated_at
 * timestamp. The samskara surfaces carry a similar helper with a
 * terser vocabulary ("5m ago"); this one keeps the panel's original
 * longhand units, so the two aren't shared. `now` is injectable so
 * tests can pin the clock; the component omits it.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
  const diffWk = Math.round(diffDay / 7);
  if (diffWk < 5) return `${diffWk} wk ago`;
  const diffMo = Math.round(diffDay / 30);
  if (diffMo < 12) return `${diffMo} mo ago`;
  const diffYr = Math.round(diffDay / 365);
  return `${diffYr} yr${diffYr === 1 ? '' : 's'} ago`;
}

/**
 * Hover-title for the confidence badge/chip. The default view shows
 * only the qualitative tag (or the quiet numeric chip); this keeps
 * the raw number reachable for curious users without cluttering the
 * card, and appends the tag name when one applies so the tooltip
 * reads the same on both renderings.
 */
export function confidenceTooltip(confidence: number): string {
  const tag = classifyMemoryConfidence(confidence);
  const base = `confidence ${confidence.toFixed(2)}`;
  return tag === null ? base : `${base} (${tag})`;
}

/**
 * Label for the quiet numeric chip shown when a memory's confidence
 * lands in the neutral band (no qualitative tag). The tilde marks
 * the value as a rough gauge rather than a precise score; one
 * decimal matches that reading.
 */
export function confidenceChipLabel(confidence: number): string {
  return `~${confidence.toFixed(1)}`;
}

// ---------------------------------------------------------------
// Panel body surface selection
// ---------------------------------------------------------------

/**
 * Empty-state copy for the panel when the result set is empty. Two
 * readings share the rendering: an active query that excluded
 * everything ("no matches"), and a cold account that has no
 * memories at all (the explainer pointing at the Help modal).
 * Parallel to `emptyMessage` in `memories-list.ts` - the sidebar's
 * copy is terser because it sits in a narrow column.
 */
export function panelEmptyMessage(query: string): string {
  const trimmed = query.trim();
  return trimmed.length > 0
    ? `No memories match "${trimmed}".`
    : 'Nothing here yet. Memories accumulate as you chat - see the Help modal\'s Memory page for details.';
}

/**
 * Which surface the panel body renders. Precedence, top to bottom:
 *
 *   - `librarian-strip-only`: a librarian confirm/progress strip is
 *     up and no selected memory card resolved. The changelog and
 *     every empty-state hint below would just compete with the
 *     button-triggered form for attention, so the strip is the whole
 *     content until dismissed. An actually-selected memory card is
 *     the one exception (it's content, not a hint) - it coexists
 *     with the strip and falls through to `card`.
 *   - `loading`: first fetch still in flight with nothing to show.
 *   - `empty`: fetch settled on zero rows (copy via
 *     `panelEmptyMessage`).
 *   - `changelog`: rows exist but no memory is selected - the
 *     changelog is the tab's default surface (parallel to Wiki).
 *   - `selection-missing`: the routed memory id didn't resolve
 *     against the active result set - most likely the user followed
 *     a sidebar link and then narrowed the search.
 *   - `card`: the selected memory's detail card.
 *
 * `selectedInResults` is the routed id resolved against the store's
 * results; `hasRoutedSelection` is whether an id is routed at all -
 * the two differ exactly in the `selection-missing` case.
 */
export type MemoriesBodySurface =
  | 'librarian-strip-only'
  | 'loading'
  | 'empty'
  | 'changelog'
  | 'selection-missing'
  | 'card';

export function memoriesBodySurface(view: {
  librarianStripVisible: boolean;
  selectedInResults: boolean;
  hasRoutedSelection: boolean;
  loading: boolean;
  resultCount: number;
}): MemoriesBodySurface {
  if (view.librarianStripVisible && !view.selectedInResults) {
    return 'librarian-strip-only';
  }
  if (view.loading && view.resultCount === 0) return 'loading';
  if (view.resultCount === 0) return 'empty';
  if (!view.hasRoutedSelection) return 'changelog';
  if (!view.selectedInResults) return 'selection-missing';
  return 'card';
}
