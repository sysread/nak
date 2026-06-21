/**
 * Wiki manual-edit agent: the per-article "Ask agent to update" flow
 * on Wiki.svelte. One Venice completion, response_format pinned to
 * JSON, no tool loop. Returns a structured preview the UI displays
 * before persisting via `supabase.updateWikiArticle`.
 *
 * This file used to also house the autonomous wiki agent (the
 * background flow that reads settled threads and maintains the wiki
 * through the wiki_* tools). That flow now runs server-side in the
 * venice edge function - the cron-driven sweep plus the Skipped
 * panel's /wiki-retry route; see
 * supabase/functions/venice/agents/wiki.ts. The manual flow stays
 * browser-side as the intentional exception after that move because
 * it is a single no-tool completion with a user-interactive preview,
 * the same category as the other no-tool agents.
 */
import type { SupabaseService, WikiRecord } from '../../supabase';
import type { VeniceMessage, ResponseFormat } from '../../venice';
import { agentModel } from '../../models';
import { createLogger } from '../../logger.svelte';
import { buildWikiManualPrompt, type WikiUserProfile } from './prompt';

const log = createLogger('wiki-manual');

/**
 * Pin response_format=json_object so the model's reply parses as the
 * ManualDecision shape below.
 */
const WIKI_MANUAL_RESPONSE_FORMAT: ResponseFormat = { type: 'json_object' };

/**
 * A proposed change to one of the article's dated records, validated
 * and normalised from the model's JSON before it reaches the preview.
 * Discriminated by `op` so the UI renders each kind distinctly and the
 * Accept handler dispatches to the matching `createWikiRecord` /
 * `updateWikiRecord` / `deleteWikiRecord` call. `update` / `delete`
 * always carry an `id` the parser has confirmed belongs to a record
 * the model was actually shown - a hallucinated id never survives to
 * the preview.
 */
export type RecordOp =
  | { op: 'create'; date: string; content: string; tags: string[] }
  | { op: 'update'; id: string; date?: string; content?: string; tags?: string[] }
  | { op: 'delete'; id: string };

/**
 * Result shape for `updateOne()`. Discriminated union so the UI can
 * tell "model produced changes to preview" apart from "model decided
 * no change is warranted" without sniffing strings. Genuine errors
 * (parse failure, abort, network) still throw.
 *
 * The preview variant carries the would-be final `title`/`content`
 * (equal to the current article when the body is unchanged - a
 * records-only edit is a valid preview), the proposed `recordOps`, and
 * `reason` (the agent's one-line summary of what it changed and why) so
 * the UI can render it next to the preview AND pass it through as the
 * wiki-changelog message on Accept. The agent has the most context for
 * that summary - prompting the user a second time for "describe the
 * edit you just asked for" would be busywork.
 *
 * `noop` is returned only when NOTHING changed: body identical to the
 * current article AND no record operations.
 */
export type WikiUpdateOneResult =
  | {
      kind: 'preview';
      title: string;
      content: string;
      reason: string;
      recordOps: RecordOp[];
    }
  | { kind: 'noop'; reason: string };

/**
 * Parsed shape the manual path expects. `action` describes the BODY
 * only ("update" = title/content changed, "noop" = body untouched);
 * `records` is independent and may carry operations even on a "noop"
 * (the user asked only to log or fix a record). All fields are
 * tolerated-optional; the parser fills sane defaults.
 */
interface ManualDecision {
  action: 'update' | 'noop';
  title: string | null;
  content: string | null;
  reason: string | null;
  records: RecordOp[];
}

// How many of the article's records to list in the prompt, and how
// much of each record's body to include. The manual flow operates on a
// single article, so the record set is usually small - but an article
// with a long, dense journey could otherwise blow the prompt, so we
// cap both dimensions and tell the model when the listing was trimmed.
// The model echoes back the FULL new body for any record it updates, so
// a truncated excerpt risks dropping detail on an edit; 800 chars keeps
// all but the longest records whole.
const MANUAL_RECORDS_LISTED_MAX = 100;
const MANUAL_RECORD_EXCERPT_CHARS = 800;

/** Coerce a model-supplied tag array into clean, deduped strings. */
function coerceTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const trimmed = t.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Normalise the model's `records` array into validated RecordOps.
 * Tolerant by construction: a malformed entry, an unknown op, or an
 * `update`/`delete` referencing an id the model was not shown is
 * dropped rather than failing the whole decision - one bad op should
 * not cost the user the rest of a good edit. `knownIds` is the set of
 * record ids actually listed in the prompt, so a hallucinated id can
 * never reach the preview, and thus never reach a DB write.
 */
function parseRecordOps(raw: unknown, knownIds: ReadonlySet<string>): RecordOp[] {
  if (!Array.isArray(raw)) return [];
  const ops: RecordOp[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.op === 'create') {
      const date = typeof e.date === 'string' ? e.date.trim() : '';
      const content = typeof e.content === 'string' ? e.content : '';
      if (date.length === 0 || content.trim().length === 0) continue;
      ops.push({ op: 'create', date, content, tags: coerceTags(e.tags) });
    } else if (e.op === 'update') {
      const id = typeof e.id === 'string' ? e.id : '';
      if (!knownIds.has(id)) continue;
      const patch: Extract<RecordOp, { op: 'update' }> = { op: 'update', id };
      if (typeof e.date === 'string' && e.date.trim().length > 0) patch.date = e.date.trim();
      if (typeof e.content === 'string' && e.content.trim().length > 0) patch.content = e.content;
      if (Array.isArray(e.tags)) patch.tags = coerceTags(e.tags);
      // An update that changes nothing is dropped - it would be a no-op
      // DB write the user cannot meaningfully preview or accept.
      if (patch.date === undefined && patch.content === undefined && patch.tags === undefined) {
        continue;
      }
      ops.push(patch);
    } else if (e.op === 'delete') {
      const id = typeof e.id === 'string' ? e.id : '';
      if (!knownIds.has(id)) continue;
      ops.push({ op: 'delete', id });
    }
  }
  return ops;
}

/**
 * Parse the manual-agent's final-text JSON. Tolerant of a markdown
 * fence wrapping the body - some training data carries the fence even
 * when response_format=json_object is set, and stripping it here is
 * cheaper than re-prompting. `knownIds` scopes record `update`/`delete`
 * ops to records the model was actually shown.
 */
function parseManualDecision(
  text: string,
  knownIds: ReadonlySet<string>
): ManualDecision | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const payload = fence ? fence[1] : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const actionRaw = obj.action;
  const action: 'update' | 'noop' =
    actionRaw === 'update' || actionRaw === 'noop' ? actionRaw : 'noop';
  const title = typeof obj.title === 'string' ? obj.title.trim() : null;
  const content = typeof obj.content === 'string' ? obj.content : null;
  const reason =
    typeof obj.reason === 'string' && obj.reason.trim().length > 0
      ? obj.reason.trim()
      : null;
  const records = parseRecordOps(obj.records, knownIds);
  return { action, title, content, reason, records };
}

/**
 * Render the article's current records for the prompt's user turn so
 * the model can reference them by id (to update or delete) and avoid
 * duplicating an event already on file. Each line leads with the id the
 * model must echo back. Capped per MANUAL_RECORDS_LISTED_MAX /
 * MANUAL_RECORD_EXCERPT_CHARS; a trailing note names any overflow so
 * the model knows the listing is partial.
 */
function renderRecordsForPrompt(records: readonly WikiRecord[]): string {
  if (records.length === 0) return 'This article has no records yet.';
  const shown = records.slice(0, MANUAL_RECORDS_LISTED_MAX);
  const lines = ['Existing records for this article (most recent first):', ''];
  for (const r of shown) {
    const body =
      r.content.length > MANUAL_RECORD_EXCERPT_CHARS
        ? `${r.content.slice(0, MANUAL_RECORD_EXCERPT_CHARS)} [...]`
        : r.content;
    const tags = r.tags.length > 0 ? ` (tags: ${r.tags.join(', ')})` : '';
    lines.push(`- [id: ${r.id}] ${r.date}${tags}: ${body}`);
  }
  if (records.length > shown.length) {
    lines.push('', `(+${records.length - shown.length} older record(s) not shown.)`);
  }
  return lines.join('\n');
}

export class WikiAgent {
  readonly model: string;
  /**
   * User profile (Settings -> AI -> About you) for the prompt's
   * "About the user" block. Null (or both fields empty) suppresses
   * the block entirely.
   */
  private userProfile: WikiUserProfile | null = null;

  constructor(
    private supabase: SupabaseService,
    /**
     * Optional model override. Defaults to the registry's `wiki`
     * slot (currently deepseek-v4-flash). Useful for tests.
     */
    modelId?: string,
    /** Initial user profile; null keeps the "About the user" block off. */
    userProfile?: WikiUserProfile | null
  ) {
    this.model = modelId ?? agentModel('wiki').id;
    this.userProfile = userProfile ?? null;
  }

  /**
   * User-initiated "ask agent to update this article" flow. Runs on
   * the main thread, single completion, structured-JSON output. Does
   * NOT write to the DB - the caller (Wiki.svelte) shows a preview of
   * the body edit AND every proposed record operation, then persists
   * (article via `updateWikiArticle`, records via the `*WikiRecord`
   * methods) on Accept.
   *
   * `currentRecords` is the article's existing records, listed in the
   * prompt so the model can reference them by id (to update/delete) and
   * dedup before proposing a create. Record `update`/`delete` ops whose
   * id is not in this set are dropped by the parser - the model never
   * gets to act on a record the user didn't see.
   *
   * Throws on parse failure, abort, or network error so the UI can
   * offer a retry. A clean "the instructions don't require a change"
   * decision (body unchanged AND no record ops) returns `kind: 'noop'`
   * (not a throw) so the UI can show the reason without an error banner.
   */
  async updateOne(args: {
    articleId: string;
    currentTitle: string;
    currentContent: string;
    currentRecords?: readonly WikiRecord[];
    userInstructions: string;
    signal?: AbortSignal;
  }): Promise<WikiUpdateOneResult> {
    const signal = args.signal ?? new AbortController().signal;
    if (signal.aborted) throw new Error('Update aborted before start.');
    const instructions = args.userInstructions.trim();
    if (instructions.length === 0) {
      throw new Error('Instructions are required.');
    }
    const currentRecords = args.currentRecords ?? [];

    // The model sees the article first (via the system prompt is the
    // contract) and then the user's instructions as a user turn. The
    // user-content block restates the article AND its records so the
    // model has the exact baseline text to preserve and the record ids
    // it must echo back to update or delete one.
    const userTurn = [
      'Article to edit:',
      '',
      `Title: ${args.currentTitle}`,
      '',
      'Content:',
      args.currentContent,
      '',
      '---',
      '',
      'Records:',
      renderRecordsForPrompt(currentRecords),
      '',
      '---',
      '',
      'Instructions:',
      instructions,
    ].join('\n');

    const convo: VeniceMessage[] = [
      {
        role: 'system',
        content: buildWikiManualPrompt({ userProfile: this.userProfile }),
      },
      { role: 'user', content: userTurn },
    ];

    log.info(
      `manual update on article ${args.articleId} ` +
        `(${args.currentContent.length} chars in, ${currentRecords.length} records, ` +
        `${instructions.length} chars instructions)`
    );

    const completion = await this.supabase.complete({
      model: this.model,
      messages: convo,
      signal,
      responseFormat: WIKI_MANUAL_RESPONSE_FORMAT,
      reasoningEffort: 'low',
    });
    if (signal.aborted) throw new Error('Update aborted mid-stream.');

    const knownIds = new Set(currentRecords.map((r) => r.id));
    const decision = parseManualDecision(completion.text, knownIds);
    if (decision === null) {
      throw new Error(
        "The model returned a response we couldn't parse. Try again."
      );
    }

    // `action` governs the BODY only; on a "noop" the body stays as-is
    // regardless of any title/content the model echoed back. An empty
    // content on an "update" falls back to the current body rather than
    // throwing - it never wipes the article, and dropping the whole
    // decision would also discard any valid record ops alongside it.
    let finalTitle = args.currentTitle;
    let finalContent = args.currentContent;
    if (decision.action === 'update') {
      finalTitle =
        decision.title && decision.title.length > 0
          ? decision.title
          : args.currentTitle;
      finalContent =
        decision.content && decision.content.length > 0
          ? decision.content
          : args.currentContent;
    }

    const bodyChanged =
      finalTitle !== args.currentTitle || finalContent !== args.currentContent;
    const recordOps = decision.records;
    if (!bodyChanged && recordOps.length === 0) {
      return { kind: 'noop', reason: decision.reason ?? 'No change applied.' };
    }

    // Older / non-conforming completions may omit `reason`. Fall back to
    // a snippet of the user's instructions so the changelog row still
    // carries SOMETHING useful rather than forcing a retry over a
    // missing field.
    const reason =
      decision.reason && decision.reason.length > 0
        ? decision.reason
        : `Manual edit: ${instructions.slice(0, 140)}`;
    return {
      kind: 'preview',
      title: finalTitle,
      content: finalContent,
      reason,
      recordOps,
    };
  }
}

// Test-only surface. The JSON parser and record-op validation carry the
// load-bearing logic - hallucinated-id rejection, the body-vs-records
// noop detection, the per-op normalisation - so they are exercised
// directly in tests/wiki-manual.test.ts without a Venice round-trip.
export const __test = {
  parseManualDecision,
  parseRecordOps,
  renderRecordsForPrompt,
};
