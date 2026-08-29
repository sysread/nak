// Manual wiki agent (function-side port of src/lib/agents/wiki/).
//
// The per-article "Ask agent to update" flow on Wiki.svelte: the user
// opens one article, types instructions, and the agent proposes a body
// edit plus a set of dated-record operations. ONE non-streaming Venice
// completion pinned to response_format=json_object, no tool loop - the
// model returns the whole decision as a single JSON object, the route
// returns it as a preview, and the browser persists the article +
// records only when the user clicks Accept.
//
// Drive shape - one entry point:
//
//   - runWikiManualUpdate: the user path. The article's "Ask agent to
//     update" panel POSTs /wiki-manual-update with the user's JWT; the
//     route calls this with the gateway-validated user id. The article
//     and its records are read server-side (b-strict, explicit user_id
//     filter) rather than trusted from the client, so the agent always
//     operates on the persisted article. Non-throwing by contract:
//     parse failures and read errors come back as kind:'error' in the
//     result union (the browser turns that into a retry banner), the
//     same shape /wiki-retry uses.
//
// This used to run in the browser as WikiAgent.updateOne - the last
// agent LLM call that did. It moved here so every agent completion
// lives server-side and the manual prompt can share the autonomous
// agent's "About the user" block (./_wiki_profile.ts) instead of
// keeping a second copy in a different runtime.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createEdgeLogger } from '../../_shared/edge-log.ts';
import { readVeniceKey } from '../tools/_venice_key.ts';
import { RECORD_COLUMNS } from '../tools/_record_helpers.ts';
import { completeJsonObject } from './_curation_helpers.ts';
import type { VeniceWireMessage } from './_recall_helpers.ts';
import {
  loadWikiProfile,
  renderUserProfileBlock,
  type WikiUserProfile,
} from './_wiki_profile.ts';
import { WIKI_MANUAL_MODEL } from '../../_shared/agent-models.ts';

// Upper bound on the model's reply. A full-article rewrite echoes the
// entire body back (not a diff), and the body cap is 16000 chars
// (~5-6k tokens), plus the JSON envelope and any record edits - so the
// budget is generous. Too low truncates a large article mid-rewrite.
const MANUAL_MAX_COMPLETION_TOKENS = 16384;

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

/**
 * A proposed change to one of the article's dated records, validated
 * and normalised from the model's JSON before it reaches the preview.
 * Discriminated by `op` so the browser renders each kind distinctly and
 * its Accept handler dispatches to the matching createWikiRecord /
 * updateWikiRecord / deleteWikiRecord call. `update` / `delete` always
 * carry an `id` the parser has confirmed belongs to a record the model
 * was actually shown - a hallucinated id never survives to the preview.
 *
 * Mirror of the browser RecordOp in src/lib/supabase/types/wiki.ts.
 */
export type RecordOp =
  | { op: 'create'; date: string; content: string; tags: string[] }
  | { op: 'update'; id: string; date?: string; content?: string; tags?: string[] }
  | { op: 'delete'; id: string };

/**
 * Result of /wiki-manual-update. Discriminated union so the browser can
 * tell "model produced changes to preview" apart from "model decided no
 * change is warranted" apart from "something failed", without sniffing
 * strings.
 *
 * The `preview` variant carries the would-be final `title`/`content`
 * (equal to the current article when the body is unchanged - a
 * records-only edit is a valid preview), the proposed `recordOps`, and
 * `reason` (the agent's one-line summary) so the browser renders it next
 * to the preview AND passes it through as the wiki-changelog message on
 * Accept. `noop` is returned only when NOTHING changed: body identical
 * AND no record operations. `error` folds parse failures, read errors,
 * and transport failures into one application outcome the browser turns
 * into a retry banner. Mirror of WikiManualUpdateResult in
 * src/lib/supabase/types/wiki.ts.
 */
export type WikiManualUpdateResult =
  | {
      kind: 'preview';
      title: string;
      content: string;
      reason: string;
      recordOps: RecordOp[];
    }
  | { kind: 'noop'; reason: string }
  | { kind: 'error'; error: string };

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

/** The fields of a record the manual prompt needs to list one. */
interface ManualRecord {
  id: string;
  date: string;
  content: string;
  tags: string[];
}

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
  knownIds: ReadonlySet<string>,
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
function renderRecordsForPrompt(records: readonly ManualRecord[]): string {
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

/**
 * Manual-agent ("ask agent to update this article") system prompt.
 * Differs from the autonomous prompt in three ways:
 *   - Scope: ONE article, not the whole wiki.
 *   - Input: explicit user instructions, not a conversation to reason
 *     from.
 *   - Output shape: a single response_format=json_object completion, no
 *     tool calls. The body edit and any proposed record operations ride
 *     back in one JSON object; the route returns a preview; the browser
 *     persists (article + records) on Accept.
 *
 * The "do not discard facts" discipline is intentional and load-bearing
 * here too - "rewrite for tone" should keep facts; "fix the date in
 * paragraph 2" should patch only that.
 */
export function buildWikiManualPrompt(
  opts: { userProfile: WikiUserProfile | null } = { userProfile: null },
): string {
  const profileBlock = renderUserProfileBlock(opts.userProfile);
  const lines: string[] = [
    "You are editing one article in the user's personal wiki, in",
    'response to explicit instructions from them.',
  ];
  if (profileBlock.length > 0) {
    lines.push('', profileBlock);
  }
  return lines.join('\n') + '\n' + WIKI_MANUAL_BODY_LINES;
}

const WIKI_MANUAL_BODY_LINES = `
**Voice**: encyclopedic, third-person, present tense, neutral - the
same register as a Wikipedia lead paragraph. No first or second
person. Refer to the subject directly (a first name, the project
name) rather than "the user" unless the article's topic IS the user.

**Scope**: this wiki is about the user, not the world. Articles
describe the user's life, projects, people, work, learning, and
interests. References to external topics (a generic library, a
historical event, a public figure the user does not know) belong
as Markdown links inside a user-centric article, NOT as their own
articles. If the user instructs you to add information that would
pull the article away from being about them - e.g. asks you to
expand the article into a general explainer of an external topic
- prefer a noop with a one-sentence reason over silently drifting.

**Rules**:

- Do exactly what the user asks. Their instructions are the binding
  constraint.
- Do NOT discard existing facts unless the user explicitly asks for
  that fact to be removed or replaced. "Add" means add. "Fix" means
  patch the specified part, leaving the rest alone. "Rewrite for
  tone" means keep facts and only rewrite the prose.
- Preserve any existing date markers ("as of March 2026", "in
  late 2025") in the article verbatim. They are part of the
  historical record. If the user is adding a new fact, you may
  attach a date marker to it (use a recent month + year, or a
  marker the user supplies in their instructions). Do not strip
  dates from earlier statements when rewording.
- Do NOT fabricate. Any new fact must come from the user's
  instructions. If the instructions imply information you don't
  have, ask via the noop path (see below) rather than inventing.
- Title is editable but discouraged. Only rename when the user
  asks for it directly.

**Records**: besides its body, an article has a set of dated RECORDS -
the topic's JOURNEY (specific events: a bake, a doctor visit, a
milestone, an experiment). The BODY is the current state; RECORDS are
the dated history. This article's existing records, if any, are listed
in the instructions block below, each with an \`id\`. When the user's
instructions call for it, you may propose record changes ALONGSIDE the
body edit (or with no body edit at all):
  - **create** a record for a dated event the user wants logged;
  - **update** a record (by \`id\`) to fix or reword it;
  - **delete** a record (by \`id\`) that is a duplicate or that the
    user asks to remove.
Discipline: only propose record changes the user's instructions
actually call for - most article edits touch no records, so leave
\`records\` empty then. Never invent a record the user did not ask for.
Never \`update\` or \`delete\` a record whose \`id\` is not in the list
below. When you migrate a dated line OUT of the body into a record,
create the record AND remove the line from \`content\` in the same
response.

**Output**: a single JSON object with these fields:

  {
    "action": "update" | "noop",
    "title": <final title, possibly unchanged>,
    "content": <final article body, full text - not a diff>,
    "reason": <one-sentence string, required>,
    "records": [
      { "op": "create", "date": "YYYY-MM-DD", "content": "<markdown>", "tags": ["optional"] },
      { "op": "update", "id": "<id from the list below>", "content": "<new markdown>" },
      { "op": "delete", "id": "<id from the list below>" }
    ]
  }

\`action\` describes the BODY only: use "update" when you change the
title or body, "noop" when the body stays exactly as it is. \`records\`
is INDEPENDENT of \`action\` - it may carry operations even on a
"noop" (the user asked only to log or fix a record, with no body
change). Omit \`records\` or pass \`[]\` when no record changes are
needed. On an \`update\` op include the \`id\` plus only the fields you
are changing (\`date\`, \`content\`, and/or \`tags\`; \`tags\` replaces the
whole array).

Use \`action: "noop"\` WITH an empty \`records\` array only when the
instructions require no change at all ("looks fine", "no edits"), are
too ambiguous to act on without inventing facts, or ask for content
you cannot supply faithfully. Include \`reason\` either way so the UI
can show the user what happened.

On \`action: "update"\`, include the FULL final article in \`content\`,
not a diff or a patch. The UI will preview your output (body changes
and every record operation) and the user will accept or reject. The
\`reason\` field is a git-commit-style summary of WHAT you changed and
WHY ("Add Maya's new job at Bar per user instructions", "Log today's
bake as a record and trim it from the body"); when the user accepts
the preview it lands in the wiki changelog. One imperative line, under
~200 chars, plain text.`;

/** Defensive coercion of the tags column off a wiki_records read. */
function coerceRecordTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string');
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === 'string');
    } catch {
      // Legacy malformed tag payload - treat as untagged rather than
      // throwing in a read path.
    }
  }
  return [];
}

/**
 * User-initiated "ask agent to update this article" flow. Reads the
 * persisted article + its records (b-strict: explicit user_id filter,
 * the admin client bypasses RLS), runs ONE non-streaming JSON
 * completion, and returns a preview the browser persists on Accept. Does
 * NOT write anything itself.
 *
 * Non-throwing by contract: a missing article, an unparseable model
 * reply, or a transport failure all return kind:'error' so the route can
 * json() it and the browser can show a retry banner without sniffing
 * HTTP status codes.
 */
export async function runWikiManualUpdate(
  adminClient: SupabaseClient,
  userId: string,
  args: { articleId: string; instructions: string },
): Promise<WikiManualUpdateResult> {
  const log = createEdgeLogger(userId, 'wiki-manual');
  const articleId = args.articleId.trim();
  const instructions = args.instructions.trim();
  try {
    if (articleId.length === 0) return { kind: 'error', error: 'articleId is required.' };
    if (instructions.length === 0) {
      return { kind: 'error', error: 'Instructions are required.' };
    }

    const { data: article, error: articleErr } = await adminClient
      .from('wiki_articles')
      .select('id, title, content, favorite')
      .eq('user_id', userId)
      .eq('id', articleId)
      .maybeSingle<{ id: string; title: string; content: string; favorite?: boolean }>();
    if (articleErr) throw new Error(articleErr.message);
    if (!article) return { kind: 'error', error: 'Article not found.' };

    // Favorited articles are locked from agent edits. The user starred
    // the article to protect it - the manual update flow is agent-
    // driven even though the user triggers it, so the lock applies
    // here too. The user can still edit the article directly through
    // the UI (that path bypasses this agent and goes through RLS).
    if (article.favorite === true) {
      return {
        kind: 'error',
        error:
          'This article is favorited (locked) and cannot be edited by the agent. ' +
          'Remove the favorite star to enable agent edits, or edit the article directly.',
      };
    }

    const { data: recordRows, error: recordsErr } = await adminClient
      .from('wiki_records')
      .select(RECORD_COLUMNS)
      .eq('user_id', userId)
      .eq('article_id', articleId)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(MANUAL_RECORDS_LISTED_MAX);
    if (recordsErr) throw new Error(recordsErr.message);
    const records: ManualRecord[] = (recordRows ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: String(row.id),
        date: typeof row.date === 'string' ? row.date : '',
        content: typeof row.content === 'string' ? row.content : '',
        tags: coerceRecordTags(row.tags),
      };
    });

    const profile = await loadWikiProfile(adminClient, userId);

    // The model sees the article first (the system prompt is the
    // contract) and then the user's instructions as a user turn. The
    // user-content block restates the article AND its records so the
    // model has the exact baseline text to preserve and the record ids
    // it must echo back to update or delete one.
    const userTurn = [
      'Article to edit:',
      '',
      `Title: ${article.title}`,
      '',
      'Content:',
      article.content,
      '',
      '---',
      '',
      'Records:',
      renderRecordsForPrompt(records),
      '',
      '---',
      '',
      'Instructions:',
      instructions,
    ].join('\n');

    const messages: VeniceWireMessage[] = [
      { role: 'system', content: buildWikiManualPrompt({ userProfile: profile }) },
      { role: 'user', content: userTurn },
    ];

    log.info(
      `manual update on article ${articleId} ` +
        `(${article.content.length} chars in, ${records.length} records, ` +
        `${instructions.length} chars instructions)`,
    );

    const key = await readVeniceKey(adminClient);
    if (!key) return { kind: 'error', error: 'no Venice key configured (app_config unseeded)' };
    const text = await completeJsonObject({
      apiKey: key,
      model: WIKI_MANUAL_MODEL,
      messages,
      maxTokens: MANUAL_MAX_COMPLETION_TOKENS,
      reasoningEffort: 'low',
    });

    const knownIds = new Set(records.map((r) => r.id));
    const decision = parseManualDecision(text, knownIds);
    if (decision === null) {
      // The completion came back, but its body wasn't parseable JSON -
      // log it at debug so a "the model returned a response we couldn't
      // parse" retry banner has a server-side counterpart to correlate.
      log.debug('completion returned unparseable output; surfacing a retry error');
      return {
        kind: 'error',
        error: "The model returned a response we couldn't parse. Try again.",
      };
    }

    // `action` governs the BODY only; on a "noop" the body stays as-is
    // regardless of any title/content the model echoed back. An empty
    // content on an "update" falls back to the current body rather than
    // wiping the article, and dropping the whole decision would also
    // discard any valid record ops alongside it.
    let finalTitle = article.title;
    let finalContent = article.content;
    if (decision.action === 'update') {
      finalTitle =
        decision.title && decision.title.length > 0 ? decision.title : article.title;
      finalContent =
        decision.content && decision.content.length > 0
          ? decision.content
          : article.content;
    }

    const bodyChanged =
      finalTitle !== article.title || finalContent !== article.content;
    const recordOps = decision.records;
    if (!bodyChanged && recordOps.length === 0) {
      const reason = decision.reason ?? 'No change applied.';
      log.debug(`completion ok: noop (${reason})`);
      return { kind: 'noop', reason };
    }

    // Older / non-conforming completions may omit `reason`. Fall back to
    // a snippet of the user's instructions so the changelog row still
    // carries SOMETHING useful rather than forcing a retry.
    const reason =
      decision.reason && decision.reason.length > 0
        ? decision.reason
        : `Manual edit: ${instructions.slice(0, 140)}`;
    log.debug(
      `completion ok: preview (body ${bodyChanged ? 'changed' : 'unchanged'}, ` +
        `${recordOps.length} record op(s))`,
    );
    return { kind: 'preview', title: finalTitle, content: finalContent, reason, recordOps };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`manual update failed: ${msg}`);
    return { kind: 'error', error: msg };
  } finally {
    await log.flush();
  }
}

// Test-only surface. The JSON parser and record-op validation carry the
// load-bearing logic - hallucinated-id rejection, the body-vs-records
// noop detection, the per-op normalisation - so they are exercised
// directly in supabase/functions/tests/wiki_manual.test.ts without a
// Venice round-trip.
export const __test = {
  parseManualDecision,
  parseRecordOps,
  renderRecordsForPrompt,
  buildWikiManualPrompt,
};
