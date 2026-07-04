/**
 * Framework-free UI primitives for the wiki manual-update preview
 * (the "Ask agent to update" flow in src/screens/Wiki.svelte). The
 * manual agent (server-side, /wiki-manual-update) returns a body edit
 * plus a list of proposed RecordOps; these pure functions turn each op
 * into the display-ready shape the preview renders, and pluralize the
 * change count. A React/Solid/Vue port would keep them verbatim. Tested
 * via vitest in tests/wiki-manual.test.ts.
 */

import type { RecordOp, WikiRecord } from '../supabase';
import { formatRecordDate } from './wiki-records';

/**
 * Display-ready projection of one proposed record operation. `content`
 * and `date`/`tags` are the values the user is reviewing: the PROPOSED
 * body for create/update, the EXISTING record's body for delete (so the
 * user can see what would be removed). Fields the op leaves unchanged on
 * an update fall back to the existing record so the preview shows the
 * record as it would stand, not just the patch.
 */
export interface RecordOpDisplay {
  kind: 'create' | 'update' | 'delete';
  /** Short action label for the preview chip. */
  label: string;
  /** Formatted event date, or '' when the existing record is unknown. */
  date: string;
  /** Markdown body to show: proposed (create/update) or existing (delete). */
  content: string;
  tags: string[];
}

const OP_LABEL: Record<RecordOp['op'], string> = {
  create: 'Add record',
  update: 'Edit record',
  delete: 'Delete record',
};

/**
 * Project a RecordOp into its preview shape. `byId` is a lookup over the
 * article's currently-loaded records, used to fill the existing values
 * an update leaves unchanged and to show what a delete would remove. A
 * delete or update whose id is missing from `byId` (should not happen -
 * the agent only emits ids it was shown) degrades to empty date/content
 * rather than throwing.
 */
export function describeRecordOp(
  op: RecordOp,
  byId: ReadonlyMap<string, WikiRecord>
): RecordOpDisplay {
  if (op.op === 'create') {
    return {
      kind: 'create',
      label: OP_LABEL.create,
      date: formatRecordDate(op.date),
      content: op.content,
      tags: op.tags,
    };
  }
  if (op.op === 'update') {
    const existing = byId.get(op.id);
    const date = op.date ?? existing?.date ?? '';
    return {
      kind: 'update',
      label: OP_LABEL.update,
      date: date ? formatRecordDate(date) : '',
      content: op.content ?? existing?.content ?? '',
      tags: op.tags ?? existing?.tags ?? [],
    };
  }
  // delete
  const existing = byId.get(op.id);
  return {
    kind: 'delete',
    label: OP_LABEL.delete,
    date: existing?.date ? formatRecordDate(existing.date) : '',
    content: existing?.content ?? '',
    tags: existing?.tags ?? [],
  };
}

/**
 * Project a whole RecordOp list into display rows for the preview,
 * resolving each op against the article's currently-loaded records.
 * The map build + walk lives here (not in the .svelte) so the component
 * just renders the returned rows.
 */
export function describeRecordOps(
  ops: readonly RecordOp[],
  records: readonly WikiRecord[]
): RecordOpDisplay[] {
  if (ops.length === 0) return [];
  const byId = new Map(records.map((r) => [r.id, r]));
  return ops.map((op) => describeRecordOp(op, byId));
}

/**
 * Headline for the proposed-record-changes section: "1 record change",
 * "3 record changes". Empty when there are none so the caller can drop
 * the whole section rather than render "0 record changes".
 */
export function recordOpsHeadline(count: number): string {
  if (count <= 0) return '';
  return `${count} record ${count === 1 ? 'change' : 'changes'}`;
}

// Display cap for a record op's markdown body in the preview list -
// enough to recognise the record, short enough that a batch of ops
// still scans as a list rather than a wall of text.
export const RECORD_OP_PREVIEW_CHARS = 160;

/**
 * Which parts of the article the agent's proposed edit actually
 * touches. `bodyChanged` (title OR content) is the load-bearing one:
 * it gates the article write, the fade-out, and the body changelog
 * row - a records-only edit writes no body changelog row (each
 * record write logs its own), so surfacing the agent's `reason` as
 * "Changelog entry:" on such a preview would promise a row that
 * never lands. Re-writing identical content would also mint a
 * spurious "update" changelog row, hence the write gate.
 */
export function previewChanges(
  preview: { title: string; content: string },
  article: { title: string; content: string },
): { titleChanged: boolean; contentChanged: boolean; bodyChanged: boolean } {
  const titleChanged = preview.title !== article.title;
  const contentChanged = preview.content !== article.content;
  return { titleChanged, contentChanged, bodyChanged: titleChanged || contentChanged };
}

/**
 * Validation error for the instructions box, or null when the run can
 * start. Expects pre-trimmed input (the caller trims because it also
 * sends the trimmed text to the agent). Only emptiness is rejected -
 * the agent copes with terse instructions, and the box is the whole
 * form, so one nudge line is all the validation the flow needs.
 */
export function manualInstructionsError(instructions: string): string | null {
  return instructions.length === 0
    ? 'Add some instructions for the agent first.'
    : null;
}

/**
 * Does this thrown message describe an intentional abort? Aborted
 * runs (the user clicked Cancel or the panel unmounted) shouldn't
 * render as red errors - the user caused them on purpose. Message
 * sniffing because AbortController rejections reach the catch as
 * plain Errors whose only abort marker is the message text.
 */
export function isAbortMessage(message: string): boolean {
  return /abort/i.test(message);
}
