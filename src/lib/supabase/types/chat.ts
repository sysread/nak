/**
 * Chat-domain row types: threads (+ pagination cursors, search/summary
 * projections), messages, and message attachments. Re-exported through
 * `../../supabase.ts` so consumers keep importing from `$lib/supabase`.
 */
import {
  isThinkingLevel,
  isVerbosity,
  type ThinkingLevel,
  type Verbosity,
} from '../../models';
import type { Citation, TokenUsage } from '../../venice';
import type { OpenAIToolCall } from '../../tools/types';

// Re-exported so consumers that pull `Message` (and its `citations`) from
// this layer don't also need to import from venice.ts just to type a row.
export type { Citation };

// --- appended verbatim from the original supabase.ts type block ---
export interface Thread {
  id: string;
  user_id: string;
  title: string;
  /**
   * Per-thread model-profile pin: the id of a ModelProfile in
   * `profiles.settings.modelProfiles`. Null/absent means track the
   * user's default profile. Rows written before the profile system may
   * still carry a legacy tier name ('smart' | 'balanced' | 'fast');
   * resolution treats any id with no matching profile - legacy or
   * deleted - as the default profile (see resolveModelProfile in
   * ./models), so old rows degrade gracefully without a migration.
   */
  model: string | null;
  /**
   * Per-thread thinking-level override. Holds 'off' as well as
   * low/medium/high - 'off' resolves to disable_thinking on the wire,
   * the others to reasoning_effort (see ThinkingLevel / thinkingToWire
   * in ./models). Null/absent means fall through to the profile's
   * default. Only consulted on reasoning-capable models; the composer
   * picker is hidden when the resolved model can't reason. The column
   * is still named reasoning_effort for storage-compat - no migration
   * needed since it was already plain text with no CHECK.
   */
  reasoning_effort: ThinkingLevel | null;
  /**
   * Per-thread text.verbosity override. Null/absent means use the
   * profile's default. Surfaced unconditionally in the composer —
   * unlike reasoning_effort we don't gate on a model-capability
   * flag; providers that don't recognize the knob silently ignore
   * it rather than 400.
   */
  verbosity: Verbosity | null;
  /**
   * Names of gated toolboxes active on this thread. Flipped by the
   * `toggle_toolbox` meta-tool (LLM-driven) or the composer toolbox
   * popover (user-driven). The always_on toolbox is implicit and is
   * never represented here. Unknown names are dropped by both
   * writers; an empty array means "only the always_on set." See
   * `GATED_TOOLBOX_NAMES` in src/lib/tools/index.ts for the
   * canonical name list.
   */
  toolboxes_enabled: string[];
  /**
   * Soft-hide flag. Archived threads still load — they just render under
   * the drawer's collapsed "Archive" section and lock out the composer.
   * Flipped by the archive / restore row actions; restore also bumps
   * updated_at so the thread jumps to the top of the Chats list.
   */
  archived: boolean;
  /**
   * True once the user has explicitly renamed the thread (via the title
   * input, or by materializing a draft with an explicit title). The chat
   * loop reads this to suppress the title-note / `update_title`
   * instruction in the system prompt — once the user has committed to a
   * title, the model never sees the prompt that would let it clobber
   * their choice. Defaults to false; flipped true by the manual rename
   * path and never reset by the auto-title flow.
   */
  title_manually_set: boolean;
  created_at: string;
  updated_at: string;
  /**
   * Cached intuition payload for this thread. Holds the perception, the
   * five drive reactions, the synthesised internal-monologue, and the
   * round/mood snapshot the cache was written against. Refreshed
   * synchronously by the chat-loop on title-tool fires and on mood-band
   * shifts; reused as-is between refreshes so the perception + 5 drives
   * + synthesis pipeline doesn't run on every chitchat turn. Null on
   * threads that haven't accumulated a refresh yet (cold start).
   *
   * The payload shape is defined in src/lib/intuition/types.ts and
   * coerced from jsonb on read; we deliberately keep this column
   * loosely-typed at the row layer (just `unknown`) so the intuition
   * module owns the parse, the same way other jsonb columns do.
   */
  intuition_payload: unknown;
  /**
   * Cached context-recall payload for this thread. Holds the stitched
   * first-person note assembled from the memory-recall and conversation-
   * recall agents, plus the round/mood snapshot the cache was written
   * against. Refreshed by the chat-loop on the same triggers as
   * intuition (cold-start, mid-turn title shift, mood-band shift,
   * stale fuse) and reused as-is between fires. Null on cold-start
   * threads.
   *
   * The payload shape is defined in src/lib/context-recall/types.ts and
   * coerced from jsonb on read; the column is `unknown` here so the
   * context-recall module owns the parse, same posture as intuition.
   */
  context_recall_payload: unknown;
  /**
   * Topic tags assigned by the server-side topics agent
   * (supabase/functions/venice/agents/thread_topics.ts). Flat list;
   * the drawer's topic-filter dropdown uses these to narrow the
   * conversation list by `topics &&` predicate. Empty array means
   * "untagged" - either the agent hasn't
   * reached this thread yet, or it ran and chose to emit no topics.
   * The UI treats the two cases the same: filterable as "(untagged)".
   */
  topics: string[];
  /**
   * Cross-device "this device is producing the response right now"
   * claim. Stamped by `acquire_thread_response_claim` at the start of
   * a chat turn, refreshed by `heartbeat_thread_response_claim`,
   * cleared by `release_thread_response_claim`. Observer devices read
   * these via the regular threads realtime subscription and use them
   * to render a "responding on another device" indicator + disable
   * their composer. Null on idle threads.
   *
   * See `acquire_thread_response_claim` and friends in
   * `supabase/schema.sql`, plus `ThreadClaimCoordinator` in
   * `src/lib/exchange/thread-claim-coordinator.ts`.
   */
  response_holder_id: string | null;
  response_claim_expires_at: string | null;
  /**
   * Server-side "a streaming turn is running against this thread"
   * stamp, written by the venice /stream orchestrator at turn entry
   * (before the priming stage) and cleared at terminal. Exists because
   * the streaming assistant row is only created at the first content
   * delta, so a page refresh during priming (or a long reasoning-only
   * stretch) would otherwise find nothing to reconnect to. The chat
   * screen uses it to arm the reconnect poll and to suppress the
   * "response was interrupted / cut off" recovery banners while the
   * turn is still alive server-side. See streamLikelyInFlight in
   * src/lib/ui/stream-inflight.ts for the freshness rule.
   */
  stream_started_at: string | null;
  /**
   * Most recent unrecoverable error against this thread. Written by
   * the streaming function on any terminalKind='error' path; cleared
   * by commit_assistant_message on the happy commit. Browser keys the
   * error card off this column being non-null. Shape is the
   * LastErrorPayload from `_shared/error-translate.ts`:
   * `{kind, message, retryable, occurred_at}`. Loosely typed here so
   * the renderer owns the parse - a row predating the column reads
   * as null, and a drifting jsonb shape that doesn't match the
   * expected envelope falls through to a generic "Error" card rather
   * than crashing the screen.
   */
  last_error: unknown;
  /**
   * App-local flag: true when this thread exists only in memory (the user
   * clicked "new thread" but hasn't sent a message or renamed it yet).
   * Drafts are never sent to Supabase — they materialize on first save.
   */
  isDraft?: boolean;
}

/**
 * One file attached to a user message (or a model-generated image). The
 * original bytes live in the private `attachments` Storage bucket,
 * pointed at by `storage_path`; the row carries only metadata + the
 * extracted text. Liveness is keyed on `storage_path`:
 *   * live:    storage_path !== null  (object in the bucket)
 *   * expired: storage_path === null  (object deleted by the expiry
 *              sweep, or a legacy pre-bucket row). `extracted_text`
 *              survives the transition so the message list stays
 *              meaningful.
 * Bytes are never loaded into the row on read; the UI fetches a signed
 * URL on demand (see SupabaseService.createAttachmentSignedUrls) and the
 * vision wire hands Venice a signed URL directly.
 */
export interface Attachment {
  id: string;
  message_id: string;
  /** Stable in-message render order. Sparse; assigned at insert time. */
  position: number;
  filename: string;
  /** MIME type captured at upload time. Drives icon selection and vision inlining. */
  mime_type: string;
  /** Byte count of the original file — preserved across expiration. */
  size_bytes: number;
  /**
   * Object key in the `attachments` bucket
   * (`<user_id>/<attachment_id>/<filename>`), or `null` once the object
   * has been deleted (a manual delete from the Artifacts tab, or a legacy
   * pre-bucket row). Non-null iff the attachment is live.
   */
  storage_path: string | null;
  /**
   * Text extracted by Venice's /augment/text-parser at upload time for
   * non-image files. Stays populated after expiration — the value the
   * model saw outlives the original object.
   */
  extracted_text: string | null;
  /** Timestamp at which the object was deleted (manual delete); null when live. */
  expired_at: string | null;
  created_at: string;
}

/**
 * Fields callers supply when inserting a new attachment. `data_base64` is
 * the SOURCE bytes to upload to the bucket - `addAttachments` uploads it
 * and stores the resulting `storage_path`; it is never written to a
 * column.
 */
export interface NewAttachment {
  position: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
  data_base64: string;
  extracted_text: string | null;
}

/**
 * One row in the Artifacts tab - a live attachment projected with its
 * owning conversation's title, so the management list can show "which
 * chat is this file in" and link back to it. Only live attachments
 * (non-null `storage_path`) are listed; deleting one marks it expired and
 * drops it from the listing. No bytes, no `extracted_text` - the row
 * carries just what the list renders plus the signed-URL inputs.
 */
export interface ArtifactListRow {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  /** Always non-null here (the listing filters to live rows). */
  storage_path: string;
  created_at: string;
  thread_id: string;
  thread_title: string;
}

/**
 * Lightweight projection of a thread's attachments for the per-turn
 * `<thread_attachments>` system block. Carries only what the block
 * formatter and the model need (filename + categorisation flags) - no
 * `data` payload, no `extracted_text` payload, so the wire stays small
 * even on conversations with many file attachments.
 */
export interface ThreadAttachmentSummary {
  filename: string;
  mime_type: string;
  /** Image MIME types route through the analyze_image tool branch in the block. */
  is_image: boolean;
  /** True when the binary has been deleted (a manual Artifacts-tab delete). */
  expired: boolean;
  /** Insert timestamp, used by the block formatter for stable ordering. */
  created_at: string;
}

export interface Message {
  id: string;
  thread_id: string;
  /**
   * OpenAI message roles. `'tool'` rows carry a tool-result (`content` is
   * the stringified return value) and always pair to an assistant row
   * via `tool_call_id`. Every other role works as before.
   */
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  created_at: string;
  /**
   * Files the user attached to this message. Only populated on user
   * rows, and only after `listMessages` has co-fetched the attachment
   * table — the base `messages` SELECT doesn't include this. Null
   * means "we haven't loaded attachments for this row yet"; an empty
   * array means "we loaded and there are none." Realtime INSERTs
   * arrive without attachments attached; the subscriber is
   * responsible for hydrating them via `listAttachmentsByMessageIds`.
   */
  attachments?: Attachment[] | null;
  /**
   * When the assistant emitted tool calls, this holds the raw array in
   * the OpenAI shape: `[{id, type, function: {name, arguments}}]`.
   * Arguments is a JSON-encoded string as the API provides it — don't
   * re-stringify on read.
   */
  tool_calls?: OpenAIToolCall[] | null;
  /** On role='tool' rows, the call id this result answers. */
  tool_call_id?: string | null;
  /** On role='tool' rows, the name of the tool that was invoked. */
  name?: string | null;
  /**
   * Concrete Venice model id that produced this assistant row (e.g.
   * 'kimi-k2-5'). Captured at send-time rather than derived from the
   * tier, so the row stays truthful across later tier re-targeting.
   * Null on user/system/tool rows and on assistant rows written before
   * this column existed.
   */
  model?: string | null;
  /**
   * OpenAI-shaped token usage for the turn that produced this assistant
   * row. Drives the context-window indicator on the message card. Null
   * when the provider didn't report usage (older rows; rate-limited
   * streams that got cut before the epilogue).
   */
  usage?: TokenUsage | null;
  /**
   * Chain-of-thought text emitted by reasoning-capable models on
   * `delta.reasoning_content`. Null when the model didn't produce any,
   * and on older rows written before the column existed. Rendered in
   * a collapsible panel at the top of the message bubble — the panel
   * starts closed on replay; it auto-opens then animates shut while
   * the live response is streaming in.
   */
  reasoning?: string | null;
  /**
   * Venice-sourced web citations for this assistant turn, in the shape
   * Venice returns on `venice_parameters.web_search_citations`. The
   * inline `^N^` superscripts in `content` are 1-based indexes into
   * this array. Null on older rows and on turns that didn't touch the
   * web-search augmentation.
   */
  citations?: Citation[] | null;
  /**
   * Set to true on rows that `listMessages` synthesized in memory to
   * repair an interrupted-exchange shape (see
   * `lib/conversation-recovery.ts`). Synthetic rows ride through the
   * wire projection like any other row but have no DB id yet — the
   * chat-loop's send path persists them ahead of the next user turn,
   * after which subsequent reads see the healed shape and the
   * synthesizer no-ops. Never written to the DB.
   */
  synthetic?: boolean;
  /**
   * Lifecycle state of an assistant row written by the streaming-root
   * edge function. Null on user/system/tool rows and on assistant rows
   * written before the column existed. The streaming function INSERTs
   * the row with `'streaming'` at first content delta and UPDATEs the
   * status to a terminal value (`'complete' | 'aborted' | 'error' |
   * 'suspended_for_ask_user'`) when the round chain settles. The
   * browser subscriber filters `'streaming'` rows out of `appendMessage`
   * so an in-flight row never paints as an empty bubble alongside the
   * live streaming buffer.
   */
  status?:
    | 'streaming'
    | 'complete'
    | 'aborted'
    | 'error'
    | 'suspended_for_ask_user'
    | null;
  /**
   * Second-thoughts self-review verdict, written by the reviewer agent
   * (supabase/functions/venice/agents/second_thoughts.ts) from the
   * streaming function's completed-turn tail onto the terminal
   * assistant row. Arrives on the messages UPDATE realtime echo a beat
   * after the reply commits. Loosely typed here (jsonb passthrough) so
   * the UI module owns the parse - a drifting or absent shape coerces
   * to "no verdict" in src/lib/ui/second-thoughts.ts rather than
   * crashing the card. Null on non-assistant rows, on rows written
   * before the column existed, and on turns where the reviewer was
   * disabled or errored.
   */
  second_thoughts?: unknown;
}

/**
 * Composite cursor for thread pagination. `updated_at` is the primary
 * sort key, `id` is the tie-break — collisions on `updated_at` are
 * rare but non-zero under a realtime burst (two bumps in the same
 * millisecond), and without the id tie-break a page boundary would
 * drop or duplicate the colliding row.
 */
export interface ThreadCursor {
  updated_at: string;
  id: string;
}

export interface ThreadPage {
  rows: Thread[];
  /**
   * `null` when the query has been drained (no more rows). Any truthy
   * value should be passed straight back as `cursor` on the next call
   * — the caller shouldn't synthesise cursors themselves.
   */
  nextCursor: ThreadCursor | null;
}

/**
 * One merged search hit. `kind` tags where the hit came from so the
 * UI can render an indicator badge; `similarity` is only set for
 * semantic hits (cosine similarity in [−1, 1], generally ~0.3–0.9
 * for meaningful matches on bge-m3). The merge ordering guarantees
 * every 'exact' appears before every 'semantic', satisfying the
 * product requirement that exact matches outrank semantic ones.
 */
export interface ThreadSearchHit {
  thread: Thread;
  kind: 'exact' | 'semantic';
  similarity?: number;
}

/**
 * Narrow projection of a thread row used by `listThreadSummariesByIds`
 * and the `conversation_search` tool. Carries the fields the LLM needs
 * to judge relevance — title + the summary agent's 2–3 sentence topical
 * summary — plus just enough metadata (archived, updated_at) to order
 * and weigh results. `summary` is nullable because the summary worker
 * runs asynchronously after the first terminal assistant turn; a brand-
 * new thread may have an embedding (populated from title alone) but no
 * summary yet.
 */
export interface ThreadSummaryRow {
  id: string;
  title: string;
  summary: string | null;
  archived: boolean;
  updated_at: string;
}

/** Default page size for Older and Archived buckets. */
export const DEFAULT_THREAD_PAGE_SIZE = 25;

/**
 * Recent-bucket cutoff. 3 days = roughly the "still actively working
 * on it" window for most users — anything newer is something they're
 * likely to want one click away at the top of the drawer, anything
 * older is reference material and lives behind infinite-scroll.
 */
export const RECENT_THREAD_CUTOFF_MS = 3 * 24 * 60 * 60 * 1000;


/**
 * Coerce the raw row from Supabase. The `model` column is `text` without a
 * CHECK constraint holding a model-profile id; any non-empty string passes
 * through (resolution maps unknown ids - deleted profiles, legacy tier
 * names - to the default profile), non-strings scrub to null.
 * `toolboxes_enabled` defaults to an empty array if the column is missing
 * (older row before the migration, or a coerce on a freshly-minted draft)
 * and non-string elements inside the array are filtered out so a drifting
 * row can never poison the UI's `.includes()` checks.
 */
export function coerceThread(row: Record<string, unknown>): Thread {
  const model = typeof row.model === 'string' && row.model.length > 0 ? row.model : null;
  const reasoning_effort = isThinkingLevel(row.reasoning_effort)
    ? row.reasoning_effort
    : null;
  const verbosity = isVerbosity(row.verbosity) ? row.verbosity : null;
  const toolboxes_enabled = Array.isArray(row.toolboxes_enabled)
    ? row.toolboxes_enabled.filter((v): v is string => typeof v === 'string')
    : [];
  // Drift-tolerant: a row predating the topics column (or one a drift-
  // injected non-array got into) shows up as "untagged" rather than
  // crashing the drawer. The save path is parameterised through the
  // RPC so non-string elements can't reach here from us; the filter is
  // a belt-and-suspenders against an out-of-band write.
  const topics = Array.isArray(row.topics)
    ? row.topics.filter((v): v is string => typeof v === 'string')
    : [];
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    title: String(row.title ?? ''),
    model,
    reasoning_effort,
    verbosity,
    toolboxes_enabled,
    archived: row.archived === true,
    title_manually_set: row.title_manually_set === true,
    // Pass jsonb through unchanged. The intuition module owns the
    // parse/coerce - see coerceIntuitionPayload in
    // src/lib/intuition/types.ts. A drifting row that doesn't match the
    // expected shape is coerced to "no cache" there and the edge
    // function recomputes on the next trigger.
    intuition_payload: row.intuition_payload ?? null,
    // Same posture as intuition_payload: pass jsonb through unchanged.
    // The context-recall module owns the parse/coerce - see
    // coerceContextRecallPayload in src/lib/context-recall/types.ts. A
    // drifting row that doesn't match the expected shape is coerced to
    // "no cache" there and the edge function recomputes on the next
    // trigger.
    context_recall_payload: row.context_recall_payload ?? null,
    topics,
    // Cross-device response-claim columns. Pass through unchanged so
    // an observer device that reads a row mid-stream sees the claim
    // immediately. A non-string holder is treated as null (drift-
    // tolerant), and an expires_at without a holder is also treated
    // as cleared since the holder is the authoritative half of the
    // pair.
    response_holder_id:
      typeof row.response_holder_id === 'string' && row.response_holder_id.length > 0
        ? row.response_holder_id
        : null,
    response_claim_expires_at:
      typeof row.response_holder_id === 'string' && row.response_holder_id.length > 0
        ? typeof row.response_claim_expires_at === 'string'
          ? row.response_claim_expires_at
          : null
        : null,
    // Drift-tolerant: a row predating the column (or a non-string
    // value) reads as "no turn in flight", which just means the
    // reconnect poll doesn't arm - the old behavior.
    stream_started_at:
      typeof row.stream_started_at === 'string' ? row.stream_started_at : null,
    // Pass jsonb through unchanged. The error-card renderer owns the
    // parse - a row predating the column reads as null, and a drifted
    // shape that doesn't match the expected `{kind, message, ...}`
    // envelope falls through to a generic "Error" card. Same posture
    // as intuition_payload / context_recall_payload above.
    last_error: row.last_error ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/**
 * Map a `message_attachments` row (which may carry a joined `messages`
 * object from a thread-scoped lookup) to an Attachment, ignoring any
 * extra join columns.
 */
export function coerceAttachmentRow(raw: Record<string, unknown>): Attachment {
  return {
    id: String(raw.id),
    message_id: String(raw.message_id),
    position: typeof raw.position === 'number' ? raw.position : Number(raw.position ?? 0),
    filename: typeof raw.filename === 'string' ? raw.filename : '',
    mime_type: typeof raw.mime_type === 'string' ? raw.mime_type : '',
    size_bytes: typeof raw.size_bytes === 'number' ? raw.size_bytes : Number(raw.size_bytes ?? 0),
    storage_path: typeof raw.storage_path === 'string' ? raw.storage_path : null,
    extracted_text: typeof raw.extracted_text === 'string' ? raw.extracted_text : null,
    expired_at: typeof raw.expired_at === 'string' ? raw.expired_at : null,
    created_at: String(raw.created_at ?? ''),
  };
}
