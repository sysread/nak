/**
 * Supabase client wrapper — owns auth, threads, messages, and per-user
 * settings. Every call from the UI that touches the user's Supabase
 * project goes through SupabaseService.
 *
 * Security posture: we connect with the project's public **anon key**,
 * not a service-role key. Row-Level Security (see `supabase/schema.sql`)
 * is the actual boundary — the anon key only works for the signed-in
 * user's own rows. The service-role key never reaches the browser; it's
 * used by `mise run setup` locally to seed the main user and then
 * discarded.
 *
 * Consumed by `state.svelte.ts` (which instantiates a SupabaseService
 * on unlock), `Chat.svelte` (threads + messages), and `Settings.svelte`
 * (keys rotation, settings, theme).
 */
import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import type { AppConfig } from './config';
import {
  isModelTier,
  isReasoningEffort,
  isVerbosity,
  type ModelTier,
  type ReasoningEffort,
  type Verbosity,
} from './models';
import { isAccent, isColorMode, type Accent, type ColorMode } from './theme';
import { isLogLevel, createLogger, type LogLevel } from './logger.svelte';

const log = createLogger('supabase');
import type { OpenAIToolCall } from './tools/types';
import type { Citation, TokenUsage } from './venice';
import { synthesizeRecoveryMessages } from './conversation-recovery';

// Re-exported so consumers that already pull Message from this module
// don't also need to import from venice.ts just to type a row.
export type { Citation };

export interface Thread {
  id: string;
  user_id: string;
  title: string;
  /** Per-thread model tier override. Null/absent means use user default. */
  model: ModelTier | null;
  /**
   * Per-thread reasoning-effort override. Null/absent means use the
   * user default. Only consulted on reasoning-capable models; the
   * composer dropdown is hidden (and the field cleared on re-point)
   * when the resolved model can't reason.
   */
  reasoning_effort: ReasoningEffort | null;
  /**
   * Per-thread text.verbosity override. Null/absent means use the
   * user default. Surfaced unconditionally in the composer —
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
   * App-local flag: true when this thread exists only in memory (the user
   * clicked "new thread" but hasn't sent a message or renamed it yet).
   * Drafts are never sent to Supabase — they materialize on first save.
   */
  isDraft?: boolean;
}

/**
 * Coerce the raw row from Supabase. The `model` column is `text` without a
 * CHECK constraint, so scrub unexpected values to null. `toolboxes_enabled`
 * defaults to an empty array if the column is missing (older row before
 * the migration, or a coerce on a freshly-minted draft) and non-string
 * elements inside the array are filtered out so a drifting row can never
 * poison the UI's `.includes()` checks.
 */
function coerceThread(row: Record<string, unknown>): Thread {
  const model = isModelTier(row.model) ? row.model : null;
  const reasoning_effort = isReasoningEffort(row.reasoning_effort)
    ? row.reasoning_effort
    : null;
  const verbosity = isVerbosity(row.verbosity) ? row.verbosity : null;
  const toolboxes_enabled = Array.isArray(row.toolboxes_enabled)
    ? row.toolboxes_enabled.filter((v): v is string => typeof v === 'string')
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
    // parse/coerce - see src/lib/intuition/cache.ts. A drifting row
    // that doesn't match the expected shape is treated as "no cache"
    // there and a fresh refresh runs on the next trigger.
    intuition_payload: row.intuition_payload ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/**
 * A saved memory — label + free-form data, per-user. The `embedding` column
 * exists on the table but we deliberately don't ship it to the client
 * (1024 floats is a lot of bytes for a list view). The embed-on-write
 * path will populate it server-side or via a dedicated client method.
 *
 * `confidence` is the volitional-memory layer's trust scalar. Default 1.0
 * on create, capped at 10.0. The reflection agent's `memory_invalidate`
 * halves it; the chat-side `memory_reaffirm` / `memory_doubt` tools
 * nudge it (+0.5 and ×0.7 respectively). Below 0.05 the memory hides
 * from search (soft-delete). The field is required everywhere `Memory`
 * rides because the Memories UI and opening-recall both format a
 * qualitative tag from it - see MEMORY_CONFIDENCE_* in src/lib/memories.ts.
 */
export interface Memory {
  id: string;
  label: string;
  data: string;
  confidence: number;
  created_at: string;
  updated_at: string;
}

/**
 * A directed edge between two memories in the volitional-memory graph.
 * The LLM draws these via the memory_relate tool; the user can add and
 * remove them in the Memories UI. Retrieval traverses outbound edges
 * one hop deep so the LLM sees linked context alongside a match.
 *
 * `to_label` / `to_data` / `to_confidence` are the target memory's
 * display fields, joined in by `get_memory_relations` so consumers can
 * render the edge inline without a second round-trip.
 */
export interface MemoryRelation {
  id: string;
  from_memory_id: string;
  to_memory_id: string;
  kind: 'supports' | 'contradicts' | 'generalises' | 'specialises';
  note: string | null;
  created_at: string;
  to_label: string;
  to_data: string;
  to_confidence: number;
}

/**
/**
 * One file attached to a user message. Binary lives in `data_base64`
 * as a base64 string — stored directly in a `text` column on the DB
 * side (see the note on `message_attachments.data` in schema.sql
 * explaining why not bytea). Null `data_base64` + non-null
 * `expired_at` is the "reclaimed" state produced by the
 * attachment_expiry worker; `extracted_text` survives that
 * transition on purpose so the message list stays
 * meaningful.
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
   * Base64-encoded file bytes, or `null` after the attachment_expiry
   * worker has reclaimed the row. Non-null iff the attachment is live.
   */
  data_base64: string | null;
  /**
   * Text extracted by Venice's /augment/text-parser at upload time for
   * non-image files. Stays populated after expiration — the value the
   * model saw outlives the original blob.
   */
  extracted_text: string | null;
  /** Timestamp at which `data` was nulled by the expiry worker; null when live. */
  expired_at: string | null;
  created_at: string;
}

/** Fields callers supply when inserting a new attachment row. */
export interface NewAttachment {
  position: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
  data_base64: string;
  extracted_text: string | null;
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
  /** True when the binary has been reclaimed by the expiry worker. */
  expired: boolean;
  /** Insert timestamp, used by the block formatter for stable ordering. */
  created_at: string;
}

/**
 * A saved recipe. The authoritative representation is `cooklang`, the
 * full raw Cooklang source string — structure (ingredients, cookware,
 * timers, metadata) is re-derived on read by `src/lib/cooklang.ts`.
 * Keeping the source as the source of truth means a future spec tweak
 * doesn't invalidate stored rows.
 *
 * `source` and `source_url` are both nullable. A recipe the model fetched
 * from a URL will carry both; a recipe the user typed by hand may have
 * neither.
 */
export interface Recipe {
  id: string;
  title: string;
  source: string | null;
  source_url: string | null;
  cooklang: string;
  /**
   * User-set rating, 1-5 stars. `null` means unrated; cleared rows
   * round-trip back as null so "never rated" stays distinguishable
   * from a hypothetical zero (which the schema rejects).
   */
  rating: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * One immutable snapshot in a recipe's history. Every create and every
 * update writes one row via the `recipe_create_with_version` /
 * `recipe_update_with_version` RPCs. The latest row by `created_at`
 * always matches the parent `recipes` row by content; older rows are
 * the trail of past states the user can browse and revert to.
 *
 * `change_message` is required - the UI Edit form and the LLM
 * `recipe_save` / `recipe_update` tools all force a non-empty value
 * before the RPC is called.
 */
export interface RecipeVersion {
  id: string;
  recipe_id: string;
  title: string;
  source: string | null;
  source_url: string | null;
  cooklang: string;
  /** Snapshot of the parent recipe's rating at save time. */
  rating: number | null;
  change_message: string;
  created_at: string;
}

/**
 * One photo on a recipe, with full bytes. Loaded by the detail pane and
 * the edit form for thumbnail rendering and lightbox open. The bytes
 * are base64 (`data:` URI ready); `mime_type` and `size_bytes` come
 * from the source `recipe_images` row.
 *
 * `position` is the link table's `position` field on the recipe's
 * latest version - lower numbers render first in the strip. `label`
 * is the optional caption rendered below the thumbnail and beside
 * the lightbox image; null means "no caption", and empty strings
 * round-trip as null (the DB normalises whitespace-only labels to
 * null on write).
 */
export interface RecipePhoto {
  id: string;
  position: number;
  mime_type: string;
  size_bytes: number;
  data_base64: string;
  label: string | null;
}

/**
 * Lightweight projection of the same photo without the bytes. Returned
 * by the photo-mutation RPCs and embedded in tool returns the LLM sees,
 * so the LLM can chain attach/remove/reorder operations against
 * specific photo IDs without paying the base64 cost on every tool
 * round-trip.
 */
export interface RecipePhotoMeta {
  id: string;
  position: number;
  label: string | null;
}

/**
 * One ordered (image_id, label) pair as sent on the wire to the
 * versioned create/update/attach RPCs. Used so callers express photo
 * sets as a single ordered list rather than two parallel arrays they
 * have to keep in sync.
 */
export interface RecipePhotoInput {
  id: string;
  label: string | null;
}

/**
 * Flatten `RecipePhotoInput[]` into the parallel arrays the
 * versioned recipe RPCs accept on the wire. Empty/whitespace labels
 * round-trip as null (the DB also normalises them server-side; we
 * mirror the rule here so the wire payload is honest about which
 * photos have a caption and which don't). Returns `null` for the
 * label array when no photo carries a label - lets the RPC skip the
 * label parameter path entirely on the common "no captions yet"
 * shape rather than threading a vector of nulls.
 */
function splitPhotoInputs(photos: RecipePhotoInput[]): {
  imageIds: string[];
  imageLabels: (string | null)[] | null;
} {
  const imageIds = photos.map((p) => p.id);
  const labels = photos.map((p) => {
    if (p.label === null || p.label === undefined) return null;
    const trimmed = p.label.trim();
    return trimmed.length === 0 ? null : trimmed;
  });
  const imageLabels = labels.some((l) => l !== null) ? labels : null;
  return { imageIds, imageLabels };
}

/**
 * One journal-entry row. The Journal feature lets a date have any
 * number of entries; the UI groups them by `entry_date` and assembles
 * a compound day view per click.
 *
 * Each automatic entry pins to one source `thread_id`; per-thread
 * uniqueness is enforced by a partial-unique index in the schema, so
 * the worker re-running on a thread extends the existing entry rather
 * than creating duplicates. User entries leave `thread_id` null - they
 * aren't tied to any specific conversation.
 *
 * `thread_title` rides on rows produced by `listJournalEntries` and
 * `getJournalEntriesForDate` (PostgREST embedded select); null on
 * rows that came back from a path without the embed (the upsert
 * RPC's RETURNING list, e.g.) and on rows whose source thread was
 * deleted (the FK is `on delete set null`).
 *
 * `similarity` is attached on rows that came out of the semantic-
 * search RPC - undefined on direct reads.
 */
export type JournalSource = 'automatic' | 'user';

export interface JournalEntry {
  id: string;
  entry_date: string;
  source: JournalSource;
  content: string;
  topics: string[];
  mood: string | null;
  people: string[];
  thread_id: string | null;
  thread_title: string | null;
  /**
   * Source thread's start timestamp (ISO 8601). Embedded from
   * `threads.created_at` on read paths that include the thread join;
   * null on rows whose thread was deleted (FK on delete set null) or
   * whose source path didn't fetch the embed (the upsert RPC return,
   * the semantic-search RPC). Used by the daily-view UI to order
   * multiple automatic entries on the same date by the time the
   * underlying conversation actually started.
   */
  thread_created_at: string | null;
  /**
   * Set the first time the user marks an automatic entry as appropriate
   * (the "ham" button in the journal modal). Idempotency marker for the
   * spam-filter training path - the UI hides the button once non-null,
   * the supabase service rejects ham training that would double-count.
   * Always null on user-source entries (the button only shows on
   * automatic ones) and on rows fetched via search RPCs that don't
   * project the column.
   */
  ham_marked_at: string | null;
  created_at: string;
  updated_at: string;
  /** Populated only by `searchJournalEntriesByEmbedding`. */
  similarity?: number;
}

function coerceJournalEntry(raw: Record<string, unknown>): JournalEntry {
  const source: JournalSource =
    raw.source === 'automatic' || raw.source === 'user' ? raw.source : 'user';
  const topics = Array.isArray(raw.topics)
    ? (raw.topics as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];
  const people = Array.isArray(raw.people)
    ? (raw.people as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  const threadId =
    typeof raw.thread_id === 'string' && raw.thread_id.length > 0
      ? raw.thread_id
      : null;
  // PostgREST embedded select shapes the joined row as
  // `thread: { title, created_at } | null`. The nested object
  // disappears when the referenced thread was deleted (FK
  // `on delete set null` nulls thread_id, the embed has nothing to
  // attach to). Coerce to flat `thread_title` / `thread_created_at`
  // fields so the UI doesn't have to know about the nesting shape.
  const threadEmbed = raw.thread;
  const threadObj =
    threadEmbed && typeof threadEmbed === 'object' && !Array.isArray(threadEmbed)
      ? (threadEmbed as Record<string, unknown>)
      : null;
  const threadTitle =
    threadObj && typeof threadObj.title === 'string' && threadObj.title.length > 0
      ? (threadObj.title as string)
      : null;
  const threadCreatedAt =
    threadObj && typeof threadObj.created_at === 'string' && threadObj.created_at.length > 0
      ? (threadObj.created_at as string)
      : null;
  return {
    id: String(raw.id),
    entry_date: String(raw.entry_date),
    source,
    content: typeof raw.content === 'string' ? raw.content : '',
    topics,
    mood: typeof raw.mood === 'string' ? raw.mood : null,
    people,
    thread_id: threadId,
    thread_title: threadTitle,
    thread_created_at: threadCreatedAt,
    ham_marked_at:
      typeof raw.ham_marked_at === 'string' && raw.ham_marked_at.length > 0
        ? (raw.ham_marked_at as string)
        : null,
    created_at: String(raw.created_at ?? raw.updated_at ?? ''),
    updated_at: String(raw.updated_at ?? raw.created_at ?? ''),
    similarity:
      typeof raw.similarity === 'number' ? (raw.similarity as number) : undefined,
  };
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
}

export class SupabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseError';
  }
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
 * Per-user preferences persisted on `profiles.settings` (jsonb). Keeps
 * prefs that should follow the account across browsers — API keys and
 * the master-password KDF remain per-device by design.
 */
export interface UserSettings {
  defaultModel?: ModelTier;
  /**
   * User-level reasoning-effort default, used on reasoning-capable
   * models when the thread hasn't overridden it. Absent means fall
   * back to {@link DEFAULT_REASONING_EFFORT} in code (`low`) so an
   * empty settings jsonb still produces sane behavior.
   */
  defaultReasoningEffort?: ReasoningEffort;
  /**
   * User-level text.verbosity default, used when the thread hasn't
   * overridden it. Absent means fall back to {@link DEFAULT_VERBOSITY}
   * in code (`medium`) so an empty settings jsonb still produces sane
   * behavior.
   */
  defaultVerbosity?: Verbosity;
  colorMode?: ColorMode;
  accent?: Accent;
  /** Library of named system prompts the user can toggle per-thread. */
  systemPrompts?: SystemPrompt[];
  /**
   * Minimum level the Logs drawer should show by default. Absent
   * means "show everything" (the lowest tier, `debug`) — falling back
   * to DEFAULT_LOG_LEVEL in state.svelte.ts. The drawer seeds its own
   * filter from this value at open time; within-session overrides via
   * the drawer's dropdown are not persisted.
   */
  defaultLogLevel?: LogLevel;
  /**
   * Opt-in: ask the model to sprinkle light Markdown emphasis (bold
   * on terms, italics on phrases) through its replies so the user
   * can skim the save-points. Chat-loop appends a short instruction
   * block to the per-turn system-prompt appendix when this is true.
   * Absent / false leaves the prompt untouched. Named after the
   * "bionic reading" visual style the feature is modelled on, even
   * though this is semantic emphasis rather than mechanical prefix
   * bolding.
   */
  emphasisMarkdown?: boolean;
  /**
   * Opt-in: when a chat completion finishes in a thread the user isn't
   * currently viewing, surface it via an OS notification (if the tab is
   * hidden and permission was granted) or an in-app unread dot on the
   * sidebar row. Default off because enabling it triggers the browser's
   * permission prompt - the user has to ask for the feature explicitly.
   */
  notifyOnComplete?: boolean;
  /**
   * Journal feature: when true, the background journaling
   * agent processes threads as they accrue terminal assistant messages
   * and writes/updates today's automatic entry. Absent/true is the
   * default-on semantics decided with the user - a brand-new account
   * opts in automatically, and the setting only has to be present when
   * the user explicitly disables. False means the manager does not
   * start the worker at unlock time (and stops it when flipped
   * mid-session). User-authored entries are unaffected by this flag.
   */
  journalAutomaticEnabled?: boolean;
  /**
   * IANA timezone name used by the journaling feature to bucket
   * entries into per-day rows. "America/New_York", "Europe/London",
   * etc. Seeded on first Settings visit from
   * `Intl.DateTimeFormat().resolvedOptions().timeZone`; user can
   * override from the Journal settings pane. Absent means "fall
   * back to the browser's current zone at read time"; callers must
   * handle `undefined` rather than assume a server default so a user
   * roaming across time zones never silently lands entries on the
   * wrong day.
   */
  journalTimezone?: string;
  /**
   * Free-form display name the user wants the model to address them
   * by. Optional - absent / empty string means "no name supplied,
   * the model has nothing to reach for." When present, chat-loop
   * folds it into the per-turn system-prompt appendix as a short
   * "User profile" block so every reply this turn sees the name. No
   * format imposed: a first name, a nickname, "they/them" pronouns,
   * a self-description, all valid. Capped at USER_PROFILE_FIELD_MAX
   * to keep a corrupt blob from ballooning the prompt.
   */
  userName?: string;
  /**
   * Free-form location the user wants the model to know about -
   * city, region, country, "rural Vermont", "currently roaming in
   * Asia", whatever they want to share. Same opt-in semantics and
   * length cap as userName. Used so weather/timezone/cultural-
   * context questions land grounded rather than the model guessing
   * or asking back. Not derived from IP or geolocation - we never
   * try to detect this; the user supplies it explicitly in
   * Settings or leaves it blank.
   */
  userLocation?: string;
}

/**
 * Length ceiling applied to free-form user-profile string fields
 * (`userName`, `userLocation`) at the coercer + updater boundary.
 * Defensive cap so a corrupt blob can't balloon the per-turn
 * system prompt. 200 characters is generous enough for a
 * descriptive entry ("Brooklyn, NY - born in Lagos, partial to
 * Pacific timezones") without being a foothold for prompt-stuffing.
 */
export const USER_PROFILE_FIELD_MAX = 200;

/**
 * A named system prompt. `enabledByDefault` is the "ride along on every new
 * conversation" flag; per-thread enablement lives in component state (it
 * isn't persisted — see the note on Chat.svelte). Ids are client-generated
 * UUIDs so new prompts can be created offline and referenced immediately.
 */
export interface SystemPrompt {
  id: string;
  name: string;
  body: string;
  enabledByDefault: boolean;
}

function coerceSystemPrompt(raw: unknown): SystemPrompt | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && r.id.length > 0 ? r.id : null;
  const name = typeof r.name === 'string' ? r.name : null;
  const body = typeof r.body === 'string' ? r.body : null;
  const enabledByDefault = r.enabledByDefault === true;
  if (id === null || name === null || body === null) return null;
  return { id, name, body, enabledByDefault };
}

/**
 * Scrub an unknown jsonb blob from Supabase into a well-typed UserSettings.
 * Drops unknown / malformed fields silently so a bad value written by an
 * older build can't break the app.
 */
export function coerceSettings(raw: unknown): UserSettings {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: UserSettings = {};
  if (isModelTier(r.defaultModel)) out.defaultModel = r.defaultModel;
  if (isReasoningEffort(r.defaultReasoningEffort)) {
    out.defaultReasoningEffort = r.defaultReasoningEffort;
  }
  if (isVerbosity(r.defaultVerbosity)) out.defaultVerbosity = r.defaultVerbosity;
  if (isColorMode(r.colorMode)) out.colorMode = r.colorMode;
  if (isAccent(r.accent)) out.accent = r.accent;
  if (Array.isArray(r.systemPrompts)) {
    const prompts: SystemPrompt[] = [];
    for (const item of r.systemPrompts) {
      const p = coerceSystemPrompt(item);
      if (p) prompts.push(p);
    }
    if (prompts.length > 0) out.systemPrompts = prompts;
  }
  if (isLogLevel(r.defaultLogLevel)) out.defaultLogLevel = r.defaultLogLevel;
  if (typeof r.emphasisMarkdown === 'boolean') {
    out.emphasisMarkdown = r.emphasisMarkdown;
  }
  if (typeof r.notifyOnComplete === 'boolean') {
    out.notifyOnComplete = r.notifyOnComplete;
  }
  if (typeof r.journalAutomaticEnabled === 'boolean') {
    out.journalAutomaticEnabled = r.journalAutomaticEnabled;
  }
  if (
    typeof r.journalTimezone === 'string' &&
    r.journalTimezone.length > 0 &&
    r.journalTimezone.length < 128
  ) {
    // Character set loose on purpose - IANA zones are
    // `Continent/City` plus aliases, and we don't want to re-implement
    // the zone list client-side. The 128-char ceiling is a defensive
    // cap so a malformed blob can't balloon.
    out.journalTimezone = r.journalTimezone;
  }
  // userName / userLocation: free-form opt-in profile strings. Empty
  // string is treated as absent so the prompt builder doesn't have to
  // distinguish "user typed nothing" from "field never set" - either
  // way the appendix block stays out. Length-capped to keep a corrupt
  // blob from ballooning the per-turn prompt.
  if (
    typeof r.userName === 'string' &&
    r.userName.length > 0 &&
    r.userName.length <= USER_PROFILE_FIELD_MAX
  ) {
    out.userName = r.userName;
  }
  if (
    typeof r.userLocation === 'string' &&
    r.userLocation.length > 0 &&
    r.userLocation.length <= USER_PROFILE_FIELD_MAX
  ) {
    out.userLocation = r.userLocation;
  }
  return out;
}

export class SupabaseService {
  readonly client: SupabaseClient;

  /**
   * `opts.client` is the dependency-injection hatch used by the
   * embeddings Web Worker (src/lib/embeddings/worker.ts). The worker
   * builds its own `SupabaseClient` with `persistSession: false` + a
   * manually-pinned session, because workers have no localStorage and
   * shouldn't fight the main-thread client for the session store. The
   * default path (no `opts`) preserves the original main-thread behavior.
   */
  constructor(
    config: Pick<AppConfig, 'supabaseUrl' | 'supabaseAnonKey'>,
    opts: { client?: SupabaseClient } = {}
  ) {
    this.client =
      opts.client ??
      createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
      });
  }

  async getSession(): Promise<Session | null> {
    const { data, error } = await this.client.auth.getSession();
    if (error) throw new SupabaseError(error.message);
    return data.session;
  }

  onAuthChange(cb: (session: Session | null) => void): () => void {
    const { data } = this.client.auth.onAuthStateChange((_event, session) => {
      cb(session);
    });
    return () => data.subscription.unsubscribe();
  }

  async signUp(email: string, password: string): Promise<Session | null> {
    const { data, error } = await this.client.auth.signUp({ email, password });
    if (error) throw new SupabaseError(error.message);
    return data.session;
  }

  async signIn(email: string, password: string): Promise<Session> {
    const { data, error } = await this.client.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw new SupabaseError(error.message);
    if (!data.session) throw new SupabaseError('Sign-in returned no session.');
    return data.session;
  }

  async signOut(): Promise<void> {
    const { error } = await this.client.auth.signOut();
    if (error) throw new SupabaseError(error.message);
  }

  async getSettings(): Promise<UserSettings> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data, error } = await this.client
      .from('profiles')
      .select('settings')
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    return coerceSettings((data as { settings?: unknown } | null)?.settings);
  }

  /**
   * Merge a partial settings patch into the profiles.settings jsonb. Does a
   * read-then-write — fine for a single-user app but not safe under
   * concurrent writes from multiple tabs. If multi-tab concurrency ever
   * becomes real (e.g. two open browsers both flipping theme), move this
   * to a Postgres `jsonb_set` call so each field updates atomically.
   */
  async updateSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const current = await this.getSettings();
    // Scrub: only allow known keys through, and validate each.
    const merged: UserSettings = { ...current };
    if ('defaultModel' in patch) {
      if (patch.defaultModel === undefined) delete merged.defaultModel;
      else if (isModelTier(patch.defaultModel)) merged.defaultModel = patch.defaultModel;
    }
    if ('defaultReasoningEffort' in patch) {
      if (patch.defaultReasoningEffort === undefined) {
        delete merged.defaultReasoningEffort;
      } else if (isReasoningEffort(patch.defaultReasoningEffort)) {
        merged.defaultReasoningEffort = patch.defaultReasoningEffort;
      }
    }
    if ('defaultVerbosity' in patch) {
      if (patch.defaultVerbosity === undefined) {
        delete merged.defaultVerbosity;
      } else if (isVerbosity(patch.defaultVerbosity)) {
        merged.defaultVerbosity = patch.defaultVerbosity;
      }
    }
    if ('colorMode' in patch) {
      if (patch.colorMode === undefined) delete merged.colorMode;
      else if (isColorMode(patch.colorMode)) merged.colorMode = patch.colorMode;
    }
    if ('accent' in patch) {
      if (patch.accent === undefined) delete merged.accent;
      else if (isAccent(patch.accent)) merged.accent = patch.accent;
    }
    if ('systemPrompts' in patch) {
      if (patch.systemPrompts === undefined) delete merged.systemPrompts;
      else if (Array.isArray(patch.systemPrompts)) {
        // Run each prompt through the coercer so the stored shape is
        // always well-formed, regardless of caller sloppiness.
        const cleaned = patch.systemPrompts
          .map((p) => coerceSystemPrompt(p))
          .filter((p): p is SystemPrompt => p !== null);
        merged.systemPrompts = cleaned;
      }
    }
    if ('defaultLogLevel' in patch) {
      if (patch.defaultLogLevel === undefined) delete merged.defaultLogLevel;
      else if (isLogLevel(patch.defaultLogLevel)) {
        merged.defaultLogLevel = patch.defaultLogLevel;
      }
    }
    if ('emphasisMarkdown' in patch) {
      if (patch.emphasisMarkdown === undefined) delete merged.emphasisMarkdown;
      else if (typeof patch.emphasisMarkdown === 'boolean') {
        merged.emphasisMarkdown = patch.emphasisMarkdown;
      }
    }
    if ('notifyOnComplete' in patch) {
      if (patch.notifyOnComplete === undefined) delete merged.notifyOnComplete;
      else if (typeof patch.notifyOnComplete === 'boolean') {
        merged.notifyOnComplete = patch.notifyOnComplete;
      }
    }
    if ('journalAutomaticEnabled' in patch) {
      if (patch.journalAutomaticEnabled === undefined) {
        delete merged.journalAutomaticEnabled;
      } else if (typeof patch.journalAutomaticEnabled === 'boolean') {
        merged.journalAutomaticEnabled = patch.journalAutomaticEnabled;
      }
    }
    if ('journalTimezone' in patch) {
      if (patch.journalTimezone === undefined) delete merged.journalTimezone;
      else if (
        typeof patch.journalTimezone === 'string' &&
        patch.journalTimezone.length > 0 &&
        patch.journalTimezone.length < 128
      ) {
        merged.journalTimezone = patch.journalTimezone;
      }
    }
    // Profile strings: an empty string from the patch means "clear
    // it" (the user blanked the input and hit save), so we delete
    // the merged key rather than persist `''`. coerceSettings drops
    // empty strings on read too, but persisting the absence keeps
    // the stored blob compact.
    if ('userName' in patch) {
      if (
        patch.userName === undefined ||
        (typeof patch.userName === 'string' && patch.userName.length === 0)
      ) {
        delete merged.userName;
      } else if (
        typeof patch.userName === 'string' &&
        patch.userName.length <= USER_PROFILE_FIELD_MAX
      ) {
        merged.userName = patch.userName;
      }
    }
    if ('userLocation' in patch) {
      if (
        patch.userLocation === undefined ||
        (typeof patch.userLocation === 'string' && patch.userLocation.length === 0)
      ) {
        delete merged.userLocation;
      } else if (
        typeof patch.userLocation === 'string' &&
        patch.userLocation.length <= USER_PROFILE_FIELD_MAX
      ) {
        merged.userLocation = patch.userLocation;
      }
    }
    const { error } = await this.client
      .from('profiles')
      .update({ settings: merged })
      .eq('user_id', session.user.id);
    if (error) throw new SupabaseError(error.message);
    return merged;
  }

  /**
   * One page of threads. `nextCursor === null` means the query has been
   * fully drained; any truthy value is what the caller should pass as
   * `cursor` to fetch the next page.
   */
  async listRecentThreads(cutoff: string): Promise<Thread[]> {
    // Everything touched within the "active" window — hardcoded by the
    // caller so the boundary doesn't drift second-to-second and flip
    // threads at the edge between Recent and Older as seconds tick by.
    // Two-column ordering mirrors listOlderThreads so a thread the
    // user just updated doesn't hop position when it transitions.
    const { data, error } = await this.client
      .from('threads')
      .select('*')
      .eq('archived', false)
      .gte('updated_at', cutoff)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(500);
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceThread(row as Record<string, unknown>));
  }

  async listOlderThreads(opts: {
    cutoff: string;
    cursor: ThreadCursor | null;
    pageSize?: number;
  }): Promise<ThreadPage> {
    return this.pageThreads({
      archived: false,
      cutoff: opts.cutoff,
      cursor: opts.cursor,
      pageSize: opts.pageSize ?? DEFAULT_THREAD_PAGE_SIZE,
    });
  }

  async listArchivedThreads(opts: {
    cursor: ThreadCursor | null;
    pageSize?: number;
  }): Promise<ThreadPage> {
    return this.pageThreads({
      archived: true,
      cutoff: null,
      cursor: opts.cursor,
      pageSize: opts.pageSize ?? DEFAULT_THREAD_PAGE_SIZE,
    });
  }

  /**
   * One-shot "window" fetch: every thread in `bucket` from the head of
   * the list down to (and including) `target`. Used when the user
   * clicks a search result that lives past the currently-loaded
   * pagination cursor — we need to materialise enough of the list to
   * put a DOM node at the target so `scrollIntoView` has something to
   * aim at.
   *
   * Returning rows in the same ordering the bucket uses lets the
   * caller merge without re-sorting. The archived bucket has no
   * cutoff; the older bucket only window-fetches within the "before
   * the cutoff" range (a Recent-bucket target should already be in
   * memory — recent is eager-loaded).
   */
  async listThreadsSince(opts: {
    target: ThreadCursor;
    archived: boolean;
    cutoff: string | null;
  }): Promise<Thread[]> {
    let q = this.client
      .from('threads')
      .select('*')
      .eq('archived', opts.archived)
      .gte('updated_at', opts.target.updated_at)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false });
    if (opts.cutoff) q = q.lt('updated_at', opts.cutoff);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceThread(row as Record<string, unknown>));
  }

  private async pageThreads(opts: {
    archived: boolean;
    cutoff: string | null;
    cursor: ThreadCursor | null;
    pageSize: number;
  }): Promise<ThreadPage> {
    // Fetch pageSize+1 rows so we can derive hasMore without a second
    // count query — if the server returned pageSize+1 rows we know at
    // least one page remains, otherwise we're at the tail.
    let q = this.client
      .from('threads')
      .select('*')
      .eq('archived', opts.archived)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(opts.pageSize + 1);
    if (opts.cutoff) q = q.lt('updated_at', opts.cutoff);
    if (opts.cursor) {
      // Composite cursor: (updated_at, id) strictly-less-than the
      // cursor, with id tie-break. PostgREST doesn't have row-value
      // comparison sugar, so spell it as
      // `updated_at < c.updated_at OR (updated_at = c.updated_at AND id < c.id)`.
      const c = opts.cursor;
      q = q.or(
        `updated_at.lt.${c.updated_at},and(updated_at.eq.${c.updated_at},id.lt.${c.id})`
      );
    }
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []).map((row) => coerceThread(row as Record<string, unknown>));
    const hasMore = rows.length > opts.pageSize;
    const page = hasMore ? rows.slice(0, opts.pageSize) : rows;
    const last = page[page.length - 1];
    const nextCursor: ThreadCursor | null =
      hasMore && last ? { updated_at: last.updated_at, id: last.id } : null;
    return { rows: page, nextCursor };
  }

  /**
   * Merged exact + semantic search across all the user's threads.
   *
   * Exact hits are ILIKE matches against `title` (substring, case-
   * insensitive) — same escape pattern as `searchMemories`. Semantic
   * hits come from the `search_threads_by_embedding` RPC against
   * `title + summary` embeddings populated by the background workers.
   * Both queries run in parallel; the merge puts every exact hit
   * before every semantic hit, deduping by id on the way through so a
   * thread can't appear twice.
   *
   * `queryEmbedding` may be null — callers that couldn't produce an
   * embedding (Venice error, offline) still get useful exact-match
   * results instead of an empty list. Archived threads are included
   * in both halves; the UI greys them.
   */
  async searchThreads(opts: {
    query: string;
    queryEmbedding: number[] | null;
    limit?: number;
  }): Promise<ThreadSearchHit[]> {
    const query = opts.query.trim();
    if (query.length === 0) return [];
    const limit = opts.limit ?? 50;

    const safe = query.replace(/([,()])/g, '\\$1');
    const pattern = `%${safe}%`;
    const exactPromise = this.client
      .from('threads')
      .select('*')
      .ilike('title', pattern)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);

    const semanticPromise = opts.queryEmbedding
      ? this.client.rpc('search_threads_by_embedding', {
          query_embedding: opts.queryEmbedding,
          match_limit: limit,
        })
      : Promise.resolve({ data: [] as unknown[], error: null });

    const [exactRes, semRes] = await Promise.all([exactPromise, semanticPromise]);
    if (exactRes.error) throw new SupabaseError(exactRes.error.message);
    // A semantic failure shouldn't kill the whole search — fall back to
    // exact-only. Mirrors how memory_search falls back when Venice is
    // unreachable.
    const semanticRows =
      semRes.error !== null
        ? []
        : ((semRes.data ?? []) as {
            id: string;
            title: string;
            archived: boolean;
            updated_at: string;
            similarity: number;
          }[]);

    const exactThreads = (exactRes.data ?? []).map((row) =>
      coerceThread(row as Record<string, unknown>)
    );

    const out: ThreadSearchHit[] = [];
    const seen = new Set<string>();
    for (const t of exactThreads) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({ thread: t, kind: 'exact' });
      if (out.length >= limit) return out;
    }
    for (const row of semanticRows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      // The RPC projection gives us enough for the row UI; fields the
      // result list doesn't render are stubbed so downstream code that
      // wants a full Thread still gets a valid shape.
      out.push({
        thread: {
          id: row.id,
          user_id: '',
          title: row.title,
          model: null,
          reasoning_effort: null,
          verbosity: null,
          toolboxes_enabled: [],
          archived: row.archived,
          title_manually_set: false,
          intuition_payload: null,
          created_at: row.updated_at,
          updated_at: row.updated_at,
        },
        kind: 'semantic',
        similarity: row.similarity,
      });
      if (out.length >= limit) return out;
    }
    return out;
  }

  /**
   * Batch-fetch a tool-facing projection of thread rows by id,
   * preserving the caller's id ordering. Used to hydrate the
   * `summary` column onto results of `searchThreads` — the
   * `search_threads_by_embedding` RPC returns only the columns the
   * drawer UI needs (id, title, archived, updated_at, similarity), so
   * the model-facing `conversation_search` tool has to round-trip for
   * the summary. Deliberately a narrow projection rather than a
   * `Thread[]` - the tool result set doesn't need user_id /
   * toolboxes_enabled / model / reasoning_effort, and surfacing those
   * on tool results would be noise the LLM then has to filter.
   *
   * `.in('id', ids)` returns rows in the server's natural order, not
   * the caller's requested order — we re-sort against the input so
   * callers that already sorted their ids upstream (by similarity, by
   * merge order) keep that sort.
   */
  async listThreadSummariesByIds(ids: readonly string[]): Promise<ThreadSummaryRow[]> {
    if (ids.length === 0) return [];
    const { data, error } = await this.client
      .from('threads')
      .select('id, title, summary, archived, updated_at')
      .in('id', ids as string[]);
    if (error) throw new SupabaseError(error.message);
    const rows = ((data ?? []) as {
      id: unknown;
      title: unknown;
      summary: unknown;
      archived: unknown;
      updated_at: unknown;
    }[]).map(
      (row): ThreadSummaryRow => ({
        id: String(row.id),
        title: String(row.title ?? ''),
        summary: typeof row.summary === 'string' ? row.summary : null,
        archived: row.archived === true,
        updated_at: String(row.updated_at),
      })
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: ThreadSummaryRow[] = [];
    for (const id of ids) {
      const r = byId.get(id);
      if (r) out.push(r);
    }
    return out;
  }

  async createThread(
    title: string,
    model: ModelTier | null = null,
    reasoningEffort: ReasoningEffort | null = null,
    verbosity: Verbosity | null = null,
    titleManuallySet = false
  ): Promise<Thread> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data, error } = await this.client
      .from('threads')
      .insert({
        title,
        user_id: session.user.id,
        model,
        reasoning_effort: reasoningEffort,
        verbosity,
        title_manually_set: titleManuallySet,
      })
      .select()
      .single();
    if (error) throw new SupabaseError(error.message);
    return coerceThread(data as Record<string, unknown>);
  }

  /**
   * Rename a thread. The `manuallySet` flag is the signal that separates
   * the two callers:
   *
   *   - `false` (default): the `update_title` tool path. Writes the title
   *     but leaves `title_manually_set` alone — so a model-initiated
   *     rename is still considered "up for revision" on a future topic
   *     shift.
   *   - `true`: the user's title input / commitRename. Writes the title
   *     AND flips the sticky flag so the chat loop will stop feeding the
   *     rename instruction to the model. Once the user has picked a
   *     title, that choice wins permanently.
   *
   * Explicitly a single method rather than two (renameThread /
   * renameThreadManually) so there's one RPC round-trip per rename
   * regardless of path.
   */
  async renameThread(
    threadId: string,
    title: string,
    opts: { manuallySet?: boolean } = {}
  ): Promise<void> {
    const patch: Record<string, unknown> = {
      title,
      updated_at: new Date().toISOString(),
    };
    if (opts.manuallySet === true) {
      patch.title_manually_set = true;
    }
    const { error } = await this.client
      .from('threads')
      .update(patch)
      .eq('id', threadId);
    if (error) throw new SupabaseError(error.message);
  }

  async setThreadModel(threadId: string, model: ModelTier | null): Promise<void> {
    const { error } = await this.client
      .from('threads')
      .update({ model, updated_at: new Date().toISOString() })
      .eq('id', threadId);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Pin the reasoning-effort level for this thread, or clear the override
   * (null) so the thread tracks the user default. Doesn't touch
   * updated_at - flipping reasoning shouldn't promote the thread to the
   * top of the sidebar, same rationale as setThreadToolboxesEnabled.
   */
  async setThreadReasoningEffort(
    threadId: string,
    reasoningEffort: ReasoningEffort | null
  ): Promise<void> {
    const { error } = await this.client
      .from('threads')
      .update({ reasoning_effort: reasoningEffort })
      .eq('id', threadId);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Pin the text.verbosity level for this thread, or clear the override
   * (null) so the thread tracks the user default. Same discipline as
   * setThreadReasoningEffort — no updated_at bump because flipping
   * verbosity shouldn't promote the thread to the top of the sidebar.
   */
  async setThreadVerbosity(
    threadId: string,
    verbosity: Verbosity | null
  ): Promise<void> {
    const { error } = await this.client
      .from('threads')
      .update({ verbosity })
      .eq('id', threadId);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Persist the cached intuition payload for this thread. Pass `null`
   * to clear (used by tests; the chat-loop only ever writes a fresh
   * payload). Doesn't bump updated_at - intuition is internal state
   * that shouldn't promote the thread to the top of the sidebar, same
   * discipline as the toolbox / verbosity / reasoning-effort setters.
   *
   * Loose typing on `payload`: the column is jsonb and the intuition
   * module owns the canonical shape (see
   * src/lib/intuition/types.ts#IntuitionPayload). Routing the parse
   * through there means a future shape change touches one file rather
   * than every Supabase call site.
   */
  async setThreadIntuitionPayload(
    threadId: string,
    payload: unknown
  ): Promise<void> {
    const { error } = await this.client
      .from('threads')
      .update({ intuition_payload: payload })
      .eq('id', threadId);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Replace the thread's set of enabled gated toolboxes. Called from
   * the `toggle_toolbox` meta-tool (LLM path) and from the composer
   * toolbox popover (user path). The array is the new set; any
   * toolbox not listed is disabled. Doesn't touch updated_at - a
   * toolbox flip shouldn't promote the thread to the top of the
   * sidebar. Caller is responsible for pre-filtering to the known
   * toolbox names (this method writes whatever it's given - the
   * validation lives with the callers who know the valid name list).
   */
  async setThreadToolboxesEnabled(
    threadId: string,
    enabled: readonly string[]
  ): Promise<void> {
    const { error } = await this.client
      .from('threads')
      .update({ toolboxes_enabled: enabled })
      .eq('id', threadId);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Flip the thread's archived flag. Unlike setThreadToolboxesEnabled /
   * setThreadReasoningEffort, this one DOES bump updated_at - both
   * directions want the thread promoted to the top of whichever section
   * (Chats or Archive) it lands in, so the user immediately sees where
   * it went.
   */
  async setThreadArchived(threadId: string, archived: boolean): Promise<void> {
    const { error } = await this.client
      .from('threads')
      .update({ archived, updated_at: new Date().toISOString() })
      .eq('id', threadId);
    if (error) throw new SupabaseError(error.message);
  }

  async deleteThread(threadId: string): Promise<void> {
    const { error } = await this.client.from('threads').delete().eq('id', threadId);
    if (error) throw new SupabaseError(error.message);
  }

  // memories -------------------------------------------------------------
  //
  // RLS on the memories table scopes every query to the signed-in user's
  // own rows, so these methods don't need to filter by user_id on
  // select/update/delete. Inserts do need to set user_id explicitly (RLS
  // checks with_check against the row, and there's no default).

  /**
   * Case-insensitive substring search over `label || data`. Empty query
   * lists all memories (most-recent first). Results are capped at `limit`
   * so a runaway LLM can't blow up context with a giant memory dump.
   */
  async searchMemories(query: string, limit: number): Promise<Memory[]> {
    let q = this.client
      .from('memories')
      .select('id, label, data, confidence, created_at, updated_at')
      .order('updated_at', { ascending: false })
      .limit(limit);
    if (query && query.length > 0) {
      // Escape the PostgREST "or" filter's reserved chars — commas and
      // parentheses would otherwise break the `.or(…)` grammar. ILIKE's
      // `%` and `_` are intentional wildcards, so we wrap the whole
      // query in `%` to match anywhere in the field.
      const safe = query.replace(/([,()])/g, '\\$1');
      const pattern = `%${safe}%`;
      q = q.or(`label.ilike.${pattern},data.ilike.${pattern}`);
    }
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as Memory[];
  }

  /**
   * Insert a new memory. `confidence` is optional; omitting it defers to
   * the schema default (1.0). The volitional-memory tools pass it
   * explicitly when the LLM marks a memory as already-corroborated at
   * birth; the Memories.svelte create flow and the reflection agent
   * leave it unset.
   */
  async createMemory(
    label: string,
    data: string,
    confidence?: number
  ): Promise<Memory> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const payload: {
      user_id: string;
      label: string;
      data: string;
      confidence?: number;
    } = { user_id: session.user.id, label, data };
    if (confidence !== undefined) payload.confidence = confidence;
    const { data: row, error } = await this.client
      .from('memories')
      .insert(payload)
      .select('id, label, data, confidence, created_at, updated_at')
      .single();
    if (error) throw new SupabaseError(error.message);
    return row as Memory;
  }

  /**
   * Partial update. Caller guarantees at least one of label/data is set;
   * the tool-side code enforces that contract. We bump updated_at on
   * every write so memory_search orders by freshness.
   */
  async updateMemory(
    id: string,
    patch: { label?: string; data?: string }
  ): Promise<Memory> {
    const { data: row, error } = await this.client
      .from('memories')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, label, data, confidence, created_at, updated_at')
      .single();
    if (error) throw new SupabaseError(error.message);
    return row as Memory;
  }

  async deleteMemory(id: string): Promise<void> {
    const { error } = await this.client.from('memories').delete().eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  // recipes --------------------------------------------------------------
  //
  // Same RLS posture as memories: every query is scoped to the signed-in
  // user automatically; only inserts need an explicit user_id because the
  // with_check policy has no default to fall back on. No embedding
  // pipeline — the cookbook stays small enough that ILIKE on `title`
  // is cheap, and the model doesn't need semantic search to find a
  // recipe it just wrote.

  /**
   * List recipes, optionally filtered by a case-insensitive `title`
   * substring. Capped at `limit` to keep the recipe_list tool result
   * small (one recipe's cooklang can be several kilobytes; a runaway
   * list would blow the context budget).
   *
   * `sort` defaults to 'updated' (most-recently-edited first). 'rating'
   * orders by stars descending with `nulls last`, then falls back to
   * `updated_at desc` so unrated rows still show in a stable order at
   * the bottom and ties among same-rated rows resolve to the most
   * recently touched.
   */
  async listRecipes(
    query: string,
    limit: number,
    sort: 'updated' | 'rating' = 'updated'
  ): Promise<Recipe[]> {
    let q = this.client
      .from('recipes')
      .select(
        'id, title, source, source_url, cooklang, rating, created_at, updated_at'
      )
      .limit(limit);
    if (sort === 'rating') {
      q = q
        .order('rating', { ascending: false, nullsFirst: false })
        .order('updated_at', { ascending: false });
    } else {
      q = q.order('updated_at', { ascending: false });
    }
    if (query && query.length > 0) {
      // Same escaping rationale as searchMemories: PostgREST's `.or(…)`
      // grammar treats commas and parens specially, so an unfiltered
      // user-typed query would break the filter. ILIKE's `%` / `_`
      // remain wildcards by design.
      const safe = query.replace(/([,()])/g, '\\$1');
      q = q.ilike('title', `%${safe}%`);
    }
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as Recipe[];
  }

  async getRecipe(id: string): Promise<Recipe | null> {
    const { data, error } = await this.client
      .from('recipes')
      .select(
        'id, title, source, source_url, cooklang, rating, created_at, updated_at'
      )
      .eq('id', id)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    return (data as Recipe | null) ?? null;
  }

  /**
   * Create a recipe and snapshot the initial state into
   * `recipe_versions` atomically via the
   * `recipe_create_with_version` RPC. `changeMessage` is required —
   * it appears in the History panel as the description of the
   * initial save (e.g. "Imported from NYT Cooking", "Created by
   * hand"). `photos` is the ordered list of `(image_id, label)`
   * pairs to link to the new version (empty by default for a
   * recipe with no photos). A null/blank label means "no caption".
   */
  async createRecipe(
    title: string,
    cooklang: string,
    source: string | null,
    sourceUrl: string | null,
    rating: number | null,
    changeMessage: string,
    photos: RecipePhotoInput[] = []
  ): Promise<Recipe> {
    if (!changeMessage || changeMessage.trim().length === 0) {
      throw new SupabaseError('changeMessage is required');
    }
    if (rating !== null && (rating < 1 || rating > 5 || !Number.isInteger(rating))) {
      throw new SupabaseError('rating must be an integer between 1 and 5');
    }
    const { imageIds, imageLabels } = splitPhotoInputs(photos);
    const { data, error } = await this.client.rpc(
      'recipe_create_with_version',
      {
        p_title: title,
        p_cooklang: cooklang,
        p_source: source,
        p_source_url: sourceUrl,
        p_rating: rating,
        p_image_ids: imageIds,
        p_image_labels: imageLabels,
        p_change_message: changeMessage.trim(),
      }
    );
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as Recipe[];
    if (rows.length === 0) {
      throw new SupabaseError('create returned no row');
    }
    return rows[0]!;
  }

  /**
   * Partial update. Caller guarantees at least one field in `patch`
   * is set - enforced by the recipe_update tool and the Cookbook
   * Edit pane before this method runs. Goes through
   * `recipe_update_with_version` so the prior state is snapshotted
   * into `recipe_versions` in the same transaction. `changeMessage`
   * is required and lands on the new version row.
   *
   * The boolean-flag pairs (`p_set_*` + value) preserve the
   * "absent leaves field unchanged; explicit null clears" semantics
   * across the wire: TypeScript's `'field' in patch` distinguishes
   * the two cases, but the Postgres parameter list cannot.
   *
   * `photos` follows the same pattern: omit to inherit the previous
   * version's photo set (and labels) unchanged; pass an array
   * (possibly empty) to set the new version's photo set explicitly.
   * Each entry is `{id, label}`; a null/blank label is "no caption".
   * Bulk editor saves include it; tool-driven scalar edits omit it.
   */
  async updateRecipe(
    id: string,
    patch: {
      title?: string;
      cooklang?: string;
      source?: string | null;
      source_url?: string | null;
      rating?: number | null;
      photos?: RecipePhotoInput[];
    },
    changeMessage: string
  ): Promise<Recipe> {
    if (!changeMessage || changeMessage.trim().length === 0) {
      throw new SupabaseError('changeMessage is required');
    }
    if (
      'rating' in patch &&
      patch.rating !== null &&
      patch.rating !== undefined &&
      (patch.rating < 1 || patch.rating > 5 || !Number.isInteger(patch.rating))
    ) {
      throw new SupabaseError('rating must be an integer between 1 and 5');
    }
    const photoSplit =
      'photos' in patch ? splitPhotoInputs(patch.photos ?? []) : null;
    const { data, error } = await this.client.rpc(
      'recipe_update_with_version',
      {
        p_id: id,
        p_set_title: 'title' in patch,
        p_title: patch.title ?? null,
        p_set_cooklang: 'cooklang' in patch,
        p_cooklang: patch.cooklang ?? null,
        p_set_source: 'source' in patch,
        p_source: patch.source ?? null,
        p_set_source_url: 'source_url' in patch,
        p_source_url: patch.source_url ?? null,
        p_set_rating: 'rating' in patch,
        p_rating: patch.rating ?? null,
        p_set_image_ids: photoSplit !== null,
        p_image_ids: photoSplit?.imageIds ?? null,
        p_image_labels: photoSplit?.imageLabels ?? null,
        p_change_message: changeMessage.trim(),
      }
    );
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as Recipe[];
    if (rows.length === 0) {
      throw new SupabaseError('update returned no row');
    }
    return rows[0]!;
  }

  async deleteRecipe(id: string): Promise<void> {
    const { error } = await this.client.from('recipes').delete().eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * List a recipe's full version history, newest first. Cold path —
   * called only when the History panel opens, never as part of the
   * recipe-list bulk fetch.
   */
  async listRecipeVersions(recipeId: string): Promise<RecipeVersion[]> {
    const { data, error } = await this.client
      .from('recipe_versions')
      .select(
        'id, recipe_id, title, source, source_url, cooklang, rating, change_message, created_at'
      )
      .eq('recipe_id', recipeId)
      .order('created_at', { ascending: false });
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as RecipeVersion[];
  }

  async getRecipeVersion(versionId: string): Promise<RecipeVersion | null> {
    const { data, error } = await this.client
      .from('recipe_versions')
      .select(
        'id, recipe_id, title, source, source_url, cooklang, rating, change_message, created_at'
      )
      .eq('id', versionId)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    return (data as RecipeVersion | null) ?? null;
  }

  /**
   * Roll a recipe back to the content of an earlier version. Implemented
   * as a normal update whose patch is the chosen version's snapshot —
   * the revert itself becomes a new version row, so a misclick is
   * recoverable too. Throws if the version belongs to a different
   * recipe (defense against stale UI state passing the wrong id).
   *
   * Photos round-trip through the snapshot too: we read the version's
   * link rows (image ids + labels in display order) and pass them
   * into `photos` on the update patch. Revert restores the exact
   * photo set, order, and captions that were on the recipe at the
   * moment that version was saved.
   */
  async revertRecipe(
    recipeId: string,
    versionId: string,
    changeMessage: string
  ): Promise<Recipe> {
    const v = await this.getRecipeVersion(versionId);
    if (!v) throw new SupabaseError('version not found');
    if (v.recipe_id !== recipeId) {
      throw new SupabaseError('version belongs to a different recipe');
    }
    const photos = await this.listRecipeVersionPhotoInputs(versionId);
    return this.updateRecipe(
      recipeId,
      {
        title: v.title,
        cooklang: v.cooklang,
        source: v.source,
        source_url: v.source_url,
        rating: v.rating,
        photos,
      },
      changeMessage
    );
  }

  // recipe photos --------------------------------------------------------
  //
  // Photos live in two tables: `recipe_images` holds the deduped bytes
  // (one row per (user_id, sha256)), `recipe_version_images` links them
  // to recipe versions. The "current" photo set for a recipe is the
  // links on the recipe's most-recent version. See `supabase/schema.sql`
  // for the full design rationale.

  /**
   * Insert an image into the user's photo library, or return the id of
   * an existing row when the bytes hash matches one already present.
   * Server-side dedup is per-user via the `(user_id, sha256)` unique
   * constraint, so two users uploading the same image each get their
   * own row; the same user uploading the same image twice gets the
   * existing id.
   *
   * Both upload paths converge on this method: the editor's file picker
   * runs after `maybeDownscaleImage`, and the LLM's
   * `recipe_photos_attach` tool runs after copying bytes out of a
   * conversation attachment. Two callers, one dedup contract.
   */
  async upsertRecipeImage(
    sha256: string,
    mimeType: string,
    sizeBytes: number,
    dataBase64: string
  ): Promise<string> {
    const { data, error } = await this.client.rpc('recipe_image_upsert', {
      p_sha256: sha256,
      p_mime_type: mimeType,
      p_size_bytes: sizeBytes,
      p_data: dataBase64,
    });
    if (error) throw new SupabaseError(error.message);
    if (typeof data !== 'string') {
      throw new SupabaseError('image upsert returned no id');
    }
    return data;
  }

  /**
   * Fetch the photos currently linked to a recipe, with bytes, in
   * display order. "Currently linked" = on the latest version row.
   * Used by the detail pane and the edit form for thumb rendering.
   *
   * Implemented as a single embedded-select query: pull the latest
   * version row and dive into its link table and the image table in
   * one round-trip. Returns an empty array when the recipe has no
   * photos (or when the recipe has no version row, which shouldn't
   * happen post-versioning rollout but degrades gracefully).
   */
  async listRecipePhotos(recipeId: string): Promise<RecipePhoto[]> {
    const { data, error } = await this.client
      .from('recipe_versions')
      .select(
        'id, recipe_version_images(position, label, recipe_images(id, mime_type, size_bytes, data))'
      )
      .eq('recipe_id', recipeId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    if (!data) return [];
    // PostgREST returns embedded relations as arrays at the type
    // level, even for many-to-one FKs that are guaranteed-single at
    // runtime. The cast through `unknown` is the documented escape
    // hatch for "we know the shape better than the generic types
    // do." Runtime branches below cope with both shapes (single
    // object or single-element array) so we're not making a
    // brittle bet on PostgREST's serialisation mode.
    type ImageEmbed = {
      id: string;
      mime_type: string;
      size_bytes: number;
      data: string;
    };
    type LinkRow = {
      position: number;
      label: string | null;
      recipe_images: ImageEmbed | ImageEmbed[] | null;
    };
    const links = (data as unknown as { recipe_version_images?: LinkRow[] | null })
      .recipe_version_images;
    if (!Array.isArray(links)) return [];
    const photos: RecipePhoto[] = [];
    for (const l of links) {
      const img = Array.isArray(l.recipe_images)
        ? l.recipe_images[0]
        : l.recipe_images;
      if (!img) continue;
      photos.push({
        id: img.id,
        position: l.position,
        mime_type: img.mime_type,
        size_bytes: img.size_bytes,
        data_base64: img.data,
        label: l.label ?? null,
      });
    }
    photos.sort((a, b) => a.position - b.position);
    return photos;
  }

  /**
   * Fetch just the image IDs and labels (in order) on a given
   * version. Used by `revertRecipe` to round-trip the photo set
   * without paying for the bytes - the bytes already exist in
   * `recipe_images`, all we need for the revert is the ordered list
   * of `(id, label)` pairs to link onto the new version.
   */
  async listRecipeVersionPhotoInputs(
    versionId: string
  ): Promise<RecipePhotoInput[]> {
    const { data, error } = await this.client
      .from('recipe_version_images')
      .select('image_id, position, label')
      .eq('recipe_version_id', versionId)
      .order('position', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    return (
      (data ?? []) as Array<{ image_id: string; label: string | null }>
    ).map((r) => ({ id: r.image_id, label: r.label ?? null }));
  }

  /**
   * Lightweight (no bytes) projection of the current photo set for a
   * recipe. Used in tool returns so the LLM sees `photos: [{id,
   * position}]` it can chain into a follow-up attach/remove/reorder
   * call. Calls the same embedded-select shape as `listRecipePhotos`
   * but skips the `data` column to keep the wire payload small.
   */
  async listRecipePhotoMeta(recipeId: string): Promise<RecipePhotoMeta[]> {
    const { data, error } = await this.client
      .from('recipe_versions')
      .select('id, recipe_version_images(position, image_id, label)')
      .eq('recipe_id', recipeId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    if (!data) return [];
    type LinkRow = {
      position: number;
      image_id: string;
      label: string | null;
    };
    const links = (data as { recipe_version_images?: LinkRow[] | null })
      .recipe_version_images;
    if (!Array.isArray(links)) return [];
    return links
      .map((l) => ({
        id: l.image_id,
        position: l.position,
        label: l.label ?? null,
      }))
      .sort((a, b) => a.position - b.position);
  }

  /**
   * Append photos to a recipe's current set. Creates a new version row
   * with the post-mutation link list. Returns the new full ordered
   * link list as `[{id, position}]` so callers (especially LLM tools)
   * can echo it back to the model without a follow-up read.
   *
   * Duplicate IDs (an image already on the recipe) are silently
   * skipped server-side - attaching the same photo twice is a no-op,
   * not an error, so the LLM doesn't have to dedupe before calling.
   */
  async attachRecipePhotos(
    recipeId: string,
    photos: RecipePhotoInput[],
    changeMessage: string
  ): Promise<RecipePhotoMeta[]> {
    const { imageIds, imageLabels } = splitPhotoInputs(photos);
    const { data, error } = await this.client.rpc('recipe_attach_photos', {
      p_recipe_id: recipeId,
      p_image_ids: imageIds,
      p_image_labels: imageLabels,
      p_change_message: changeMessage.trim(),
    });
    if (error) throw new SupabaseError(error.message);
    return (
      (data ?? []) as Array<{
        image_id: string;
        position: number;
        label: string | null;
      }>
    ).map((r) => ({
      id: r.image_id,
      position: r.position,
      label: r.label ?? null,
    }));
  }

  /**
   * Remove photos from a recipe's current set by id. Throws when an
   * id isn't currently linked, naming the offenders so the caller
   * can re-issue with the right set.
   */
  async removeRecipePhotos(
    recipeId: string,
    imageIds: string[],
    changeMessage: string
  ): Promise<RecipePhotoMeta[]> {
    const { data, error } = await this.client.rpc('recipe_remove_photos', {
      p_recipe_id: recipeId,
      p_image_ids: imageIds,
      p_change_message: changeMessage.trim(),
    });
    if (error) throw new SupabaseError(error.message);
    return (
      (data ?? []) as Array<{
        image_id: string;
        position: number;
        label: string | null;
      }>
    ).map((r) => ({
      id: r.image_id,
      position: r.position,
      label: r.label ?? null,
    }));
  }

  /**
   * Set a recipe's photo order to exactly the given id sequence. The
   * array must be a permutation of the current set - missing or
   * extra ids fail loudly server-side.
   */
  async reorderRecipePhotos(
    recipeId: string,
    imageIds: string[],
    changeMessage: string
  ): Promise<RecipePhotoMeta[]> {
    const { data, error } = await this.client.rpc('recipe_reorder_photos', {
      p_recipe_id: recipeId,
      p_image_ids: imageIds,
      p_change_message: changeMessage.trim(),
    });
    if (error) throw new SupabaseError(error.message);
    return (
      (data ?? []) as Array<{
        image_id: string;
        position: number;
        label: string | null;
      }>
    ).map((r) => ({
      id: r.image_id,
      position: r.position,
      label: r.label ?? null,
    }));
  }

  /**
   * Update the labels (captions) on photos that are already linked
   * to a recipe. `photos` is the list of `(id, label)` pairs to
   * change; photos not named keep their existing labels. A null /
   * blank label clears the caption. Creates a new version row so a
   * label edit shows in the History panel like every other change.
   */
  async setRecipePhotoLabels(
    recipeId: string,
    photos: RecipePhotoInput[],
    changeMessage: string
  ): Promise<RecipePhotoMeta[]> {
    if (photos.length === 0) {
      throw new SupabaseError('photos must contain at least one entry');
    }
    // Force the parallel arrays - the RPC requires both. Empty/blank
    // labels survive as nulls in the wire payload (not the elided
    // path splitPhotoInputs takes for "no labels at all"), since the
    // contract here is "set this photo's label to whatever I sent,
    // even if that's null."
    const imageIds = photos.map((p) => p.id);
    const imageLabels = photos.map((p) => {
      if (p.label === null || p.label === undefined) return null;
      const trimmed = p.label.trim();
      return trimmed.length === 0 ? null : trimmed;
    });
    const { data, error } = await this.client.rpc('recipe_set_photo_labels', {
      p_recipe_id: recipeId,
      p_image_ids: imageIds,
      p_image_labels: imageLabels,
      p_change_message: changeMessage.trim(),
    });
    if (error) throw new SupabaseError(error.message);
    return (
      (data ?? []) as Array<{
        image_id: string;
        position: number;
        label: string | null;
      }>
    ).map((r) => ({
      id: r.image_id,
      position: r.position,
      label: r.label ?? null,
    }));
  }

  // journal_entries (Journal) ---------------------------------------
  //
  // User-scoped via RLS. Every read filters to the signed-in user; every
  // write either goes through the upsert RPC (automatic rows) or
  // explicit user-id tagging on direct inserts (user rows).

  /**
   * List journal entries newest-day-first. Pulls a bounded window;
   * callers that want full history should paginate via `from`/`to`
   * filters on `entry_date`. Used by the Journal list view and
   * export.
   *
   * Embeds the source thread's `title` via PostgREST's relation
   * resolution so the daily view can render a centered conversation
   * title above each automatic entry without a second round trip.
   * Embed shape lands on `raw.thread = {title} | null`; the coercer
   * flattens it to `thread_title`. The embed evaluates to null when
   * the source thread was deleted (FK is `on delete set null`), so
   * `coerceJournalEntry` tolerates either path.
   */
  async listJournalEntries(opts: {
    limit?: number;
    from?: string;
    to?: string;
  } = {}): Promise<JournalEntry[]> {
    let q = this.client
      .from('journal_entries')
      .select(
        'id, entry_date, source, content, topics, mood, people, thread_id, ham_marked_at, created_at, updated_at, thread:threads(title, created_at)'
      )
      .order('entry_date', { ascending: false })
      .order('source', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(opts.limit ?? 500);
    if (opts.from) q = q.gte('entry_date', opts.from);
    if (opts.to) q = q.lte('entry_date', opts.to);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceJournalEntry(row as Record<string, unknown>));
  }

  /**
   * Look up all entries for a specific day. With per-thread automatic
   * entries the result can have any number of rows: at most one user
   * row plus one automatic row per conversation that started that
   * day. Used by the Journal daily view (which assembles them into a
   * compound display) and by chat-loop's "today's journal" appendix.
   * Embeds `thread.title` for the same reason `listJournalEntries`
   * does.
   */
  async getJournalEntriesForDate(entryDate: string): Promise<JournalEntry[]> {
    const { data, error } = await this.client
      .from('journal_entries')
      .select(
        'id, entry_date, source, content, topics, mood, people, thread_id, ham_marked_at, created_at, updated_at, thread:threads(title, created_at)'
      )
      .eq('entry_date', entryDate)
      .order('source', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceJournalEntry(row as Record<string, unknown>));
  }

  /**
   * Atomic upsert + thread-pointer-advance for the journaling
   * worker. The schema RPC runs both in a single Postgres
   * transaction so the entry's existence and the thread's
   * pointer-advance can't disagree:
   *
   *   - Successful return: entry is in the DB AND
   *     `last_journaled_msg_id` advanced to `msgId`.
   *   - Throw: entry was rolled back AND pointer didn't advance.
   *
   * Throws on claim-lost (the schema function raises an exception
   * when the claim TTL expired or another holder took over). The
   * worker logs the failure and returns the cycle as 'error', and
   * the thread stays in the queue for the next cycle - the next
   * holder will redo the work.
   */
  async upsertJournalEntryAndMarkThread(args: {
    threadId: string;
    holderId: string;
    msgId: string;
    entryDate: string;
    content: string;
    topics: string[];
    mood: string | null;
    people: string[];
  }): Promise<JournalEntry> {
    const { data, error } = await this.client.rpc(
      'upsert_journal_entry_and_mark_thread',
      {
        p_thread_id: args.threadId,
        p_holder_id: args.holderId,
        p_msg_id: args.msgId,
        p_entry_date: args.entryDate,
        p_content: args.content,
        p_topics: args.topics,
        p_mood: args.mood,
        p_people: args.people,
      }
    );
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    if (rows.length === 0) throw new SupabaseError('Atomic upsert returned no row.');
    return coerceJournalEntry(rows[0]);
  }

  /**
   * Look up the automatic entry the worker has previously written for
   * this thread, if any. Returns null when the thread doesn't have an
   * entry yet (first cycle for the thread, or the user deleted the
   * prior entry and the thread was re-included after the exclude was
   * cleared). The agent passes the result into `buildJournalPrompt`
   * so the model extends the existing narrative rather than starting
   * from scratch.
   */
  async getJournalEntryForThread(threadId: string): Promise<JournalEntry | null> {
    const { data, error } = await this.client
      .from('journal_entries')
      .select(
        'id, entry_date, source, content, topics, mood, people, thread_id, ham_marked_at, created_at, updated_at, thread:threads(title, created_at)'
      )
      .eq('thread_id', threadId)
      .eq('source', 'automatic')
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    if (!data) return null;
    return coerceJournalEntry(data as Record<string, unknown>);
  }

  /**
   * Create a user-sourced entry for the given date. Multiple per day
   * are allowed at the schema level, but the UI's compose flow keeps
   * to one (edits the existing one when present); this method is the
   * write path for both new and additional user entries.
   */
  async createUserJournalEntry(args: {
    entryDate: string;
    content: string;
    topics: string[];
    mood: string | null;
    people: string[];
  }): Promise<JournalEntry> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data, error } = await this.client
      .from('journal_entries')
      .insert({
        user_id: session.user.id,
        entry_date: args.entryDate,
        source: 'user',
        content: args.content,
        topics: args.topics,
        mood: args.mood,
        people: args.people,
      })
      .select(
        'id, entry_date, source, content, topics, mood, people, thread_id, ham_marked_at, created_at, updated_at, thread:threads(title, created_at)'
      )
      .single();
    if (error) throw new SupabaseError(error.message);
    return coerceJournalEntry(data as Record<string, unknown>);
  }

  /**
   * Patch an entry's content/topics/mood/people. Used on user-sourced
   * rows by the compose-form Edit flow, and on automatic rows by the
   * Regenerate flow when the user accepts a proposed replacement.
   * RLS allows the user to update either source; thread/source/date
   * columns are intentionally not patchable here (a regenerated
   * automatic entry stays pinned to its original thread and day).
   * Bumps updated_at; the trigger on the table nulls the embedding
   * if content/topics/mood changed so the worker re-embeds.
   */
  async updateJournalEntry(
    id: string,
    patch: {
      content?: string;
      topics?: string[];
      mood?: string | null;
      people?: string[];
    }
  ): Promise<JournalEntry> {
    const { data, error } = await this.client
      .from('journal_entries')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select(
        'id, entry_date, source, content, topics, mood, people, thread_id, ham_marked_at, created_at, updated_at, thread:threads(title, created_at)'
      )
      .single();
    if (error) throw new SupabaseError(error.message);
    return coerceJournalEntry(data as Record<string, unknown>);
  }

  /**
   * Delete a journal entry by id. If the caller passes non-empty
   * `excludeThreadIds`, those threads are upserted into
   * journal_thread_excludes in the same round so the worker doesn't
   * regenerate the entry from the same conversation. Caller builds
   * the list from the entry's own `thread_id` (singular, post-restructure)
   * before deleting; the row disappears as part of this call so we
   * read-then-delete in the tool layer rather than inside Supabase.
   */
  async deleteJournalEntry(
    id: string,
    excludeThreadIds: readonly string[] = []
  ): Promise<void> {
    const { error } = await this.client.from('journal_entries').delete().eq('id', id);
    if (error) throw new SupabaseError(error.message);
    if (excludeThreadIds.length === 0) return;
    const session = await this.getSession();
    if (!session) return; // best-effort on cleanup
    const rows = excludeThreadIds.map((threadId) => ({
      user_id: session.user.id,
      thread_id: threadId,
    }));
    // onConflict ignore so idempotent re-calls are no-ops.
    const { error: err2 } = await this.client
      .from('journal_thread_excludes')
      .upsert(rows, { onConflict: 'user_id,thread_id', ignoreDuplicates: true });
    if (err2) throw new SupabaseError(err2.message);
  }

  /**
   * Stamp `ham_marked_at = now()` on an automatic entry. The UI guards
   * the call (button hidden when the column is already non-null) but
   * we re-check the predicate in the WHERE clause so a double-click
   * race or a stale tab can't double-train. Returns the updated entry,
   * or null when the row was already marked or doesn't exist - the
   * caller skips training in that case.
   */
  async markJournalEntryHam(id: string): Promise<JournalEntry | null> {
    const nowIso = new Date().toISOString();
    const { data, error } = await this.client
      .from('journal_entries')
      .update({ ham_marked_at: nowIso })
      .eq('id', id)
      .is('ham_marked_at', null)
      .select(
        'id, entry_date, source, content, topics, mood, people, thread_id, ham_marked_at, created_at, updated_at, thread:threads(title, created_at)'
      )
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    if (!data) return null;
    return coerceJournalEntry(data as Record<string, unknown>);
  }

  /**
   * Train the per-user spam filter. Tokens are expected pre-stemmed
   * and lowercased (see `tokenizeConversation` in
   * src/lib/agents/journal/spam_filter.ts). The RPC bumps token
   * counts and the per-user totals row in one transaction.
   */
  async trainJournalSpam(
    tokens: readonly string[],
    label: 'ham' | 'spam'
  ): Promise<void> {
    const { error } = await this.client.rpc('train_journal_spam', {
      p_tokens: tokens as string[],
      p_label: label,
    });
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Reverse a previous `trainJournalSpam` call. Used when the user
   * deletes an automatic entry they had previously marked as ham:
   * we rescind the ham vote before training spam, so the
   * conversation's tokens don't end up double-counted (one row in
   * each class). Counts and totals floor at zero - calling this
   * with no prior train is a no-op rather than an underflow.
   */
  async untrainJournalSpam(
    tokens: readonly string[],
    label: 'ham' | 'spam'
  ): Promise<void> {
    const { error } = await this.client.rpc('untrain_journal_spam', {
      p_tokens: tokens as string[],
      p_label: label,
    });
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Read the per-user totals (number of conversations labeled ham vs
   * spam). Used as the cold-start gate in the worker - the score is
   * suppressed entirely while either total is below threshold so the
   * LLM doesn't try to interpret a noisy posterior.
   */
  async getJournalSpamStats(): Promise<{ hamTotal: number; spamTotal: number }> {
    const { data, error } = await this.client.rpc('get_journal_spam_stats');
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    if (rows.length === 0) return { hamTotal: 0, spamTotal: 0 };
    const r = rows[0];
    return {
      hamTotal: typeof r.ham_total === 'number' ? r.ham_total : 0,
      spamTotal: typeof r.spam_total === 'number' ? r.spam_total : 0,
    };
  }

  /**
   * Look up token rows for scoring. Returns one row per token that
   * exists in the user's vocabulary; tokens never seen are silently
   * dropped (the Naive Bayes formula treats them as no-evidence).
   * The RPC also returns the user's totals replicated on every row;
   * callers that need totals separately should use
   * `getJournalSpamStats` instead - this method strips them.
   */
  async scoreJournalSpamTokens(
    tokens: readonly string[]
  ): Promise<{ token: string; hamCount: number; spamCount: number }[]> {
    if (tokens.length === 0) return [];
    const { data, error } = await this.client.rpc('score_journal_spam', {
      p_tokens: tokens as string[],
    });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    return rows.map((r) => ({
      token: String(r.token ?? ''),
      hamCount: typeof r.ham_count === 'number' ? r.ham_count : 0,
      spamCount: typeof r.spam_count === 'number' ? r.spam_count : 0,
    }));
  }

  /**
   * Semantic + substring search over journal entries. Parallels
   * `searchMemoriesSemantic` in src/lib/memories.ts but lives here on
   * the service so the reflection-side toolbox can reuse it without
   * hauling in the memories helper's ILIKE-fallback contract.
   *
   * `queryEmbedding` may be null - callers without Venice get ILIKE
   * results only. Merges vector hits first (RPC), then unembedded
   * ILIKE hits, deduped by id. Empty `query` returns most-recent-first
   * without embedding.
   */
  async searchJournalEntries(opts: {
    query: string;
    queryEmbedding: number[] | null;
    limit?: number;
  }): Promise<JournalEntry[]> {
    const query = opts.query.trim();
    const limit = opts.limit ?? 20;
    if (query.length === 0) return this.listJournalEntries({ limit });

    const safe = query.replace(/([,()])/g, '\\$1');
    const pattern = `%${safe}%`;

    const ilikePromise = this.client
      .from('journal_entries')
      .select(
        'id, entry_date, source, content, topics, mood, people, thread_id, ham_marked_at, created_at, updated_at, thread:threads(title, created_at)'
      )
      .or(`content.ilike.${pattern},mood.ilike.${pattern}`)
      .order('entry_date', { ascending: false })
      .limit(limit);

    const semanticPromise = opts.queryEmbedding
      ? this.client.rpc('search_journal_entries_by_embedding', {
          query_embedding: opts.queryEmbedding,
          match_limit: limit,
        })
      : Promise.resolve({ data: [] as unknown[], error: null });

    const [ilikeRes, semRes] = await Promise.all([ilikePromise, semanticPromise]);
    if (ilikeRes.error) throw new SupabaseError(ilikeRes.error.message);
    const ilikeRows = (ilikeRes.data ?? []).map((row) =>
      coerceJournalEntry(row as Record<string, unknown>)
    );
    const semanticRows =
      semRes.error !== null
        ? []
        : ((semRes.data ?? []) as unknown[]).map((row) =>
            coerceJournalEntry(row as Record<string, unknown>)
          );

    const out: JournalEntry[] = [];
    const seen = new Set<string>();
    // Semantic first - a meaning match ranks above a substring match.
    for (const e of semanticRows) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
      if (out.length >= limit) return out;
    }
    for (const e of ilikeRows) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
      if (out.length >= limit) return out;
    }
    return out;
  }

  // Journal background pipeline ------------------------------------------

  /**
   * Claim the oldest thread that needs journaling. Returns null when
   * the queue is empty. Mirrors `claimNextThreadForReflection` but for
   * the journal worker's partition.
   */
  async claimNextThreadForJournal(
    holderId: string,
    ttlSeconds: number,
    timezone: string | null
  ): Promise<{
    threadId: string;
    terminalMsgId: string;
    /** Thread title at claim time. Null when the auto-titler hasn't filled it in yet. */
    title: string | null;
    /**
     * Conversation start timestamp (ISO 8601 string from PostgREST).
     * The worker converts this to a YYYY-MM-DD key in the user's IANA
     * timezone via `dateInZone` and uses it as the entry_date - so an
     * automatic entry lands on the day the conversation actually
     * happened on, not the day the worker is processing it.
     */
    threadCreatedAt: string;
  } | null> {
    const { data, error } = await this.client.rpc('claim_next_thread_for_journal', {
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
      // The RPC has a UTC default for graceful degradation against
      // an old client bundle, but PostgREST doesn't fall back to
      // SQL defaults on an explicit null - `at time zone null`
      // returns null, which would make every candidate row fall
      // out of the WHERE. Coerce null to 'UTC' here so the gate
      // still buckets on a real zone. Settings -> normalizeTimezone
      // makes this null path rare in practice.
      p_timezone: timezone ?? 'UTC',
    });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      thread_id: string;
      terminal_msg_id: string;
      title: string | null;
      thread_created_at: string;
    }[];
    if (rows.length === 0) return null;
    return {
      threadId: rows[0].thread_id,
      terminalMsgId: rows[0].terminal_msg_id,
      title: rows[0].title ?? null,
      threadCreatedAt: rows[0].thread_created_at,
    };
  }

  async markThreadJournaledIfClaimed(
    threadId: string,
    holderId: string,
    msgId: string
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('mark_thread_journaled_if_claimed', {
      p_thread_id: threadId,
      p_holder_id: holderId,
      p_msg_id: msgId,
    });
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  async claimNextPendingJournalEntry(
    holderId: string,
    ttlSeconds: number
  ): Promise<
    | {
        id: string;
        entry_date: string;
        content: string;
        topics: string[];
        mood: string | null;
      }
    | null
  > {
    const { data, error } = await this.client.rpc('claim_next_pending_journal_entry', {
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      id: string;
      entry_date: string;
      content: string;
      topics: string[] | null;
      mood: string | null;
    }[];
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      entry_date: row.entry_date,
      content: row.content,
      topics: Array.isArray(row.topics) ? row.topics : [],
      mood: row.mood,
    };
  }

  async saveJournalEntryEmbedding(
    id: string,
    holderId: string,
    embedding: number[],
    model: string
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc(
      'save_journal_entry_embedding_if_claimed',
      {
        p_id: id,
        p_holder_id: holderId,
        p_embedding: embedding,
        p_embedding_model: model,
      }
    );
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  // Background-worker pipeline --------------------------------------------
  //
  // Methods in this block drive the background workers in
  // `src/lib/embeddings/*` and, later, `src/lib/agents/*`. RLS scopes
  // every query to the current user automatically — workers receive a
  // session-scoped SupabaseService and never need to know the user id.
  //
  // Cross-device coordination has two layers:
  //
  //   1. A singleton lease per user per worker kind (`worker_leases`)
  //      enforces that at most one worker of a given kind runs at a
  //      time across all the user's tabs and devices.
  //      acquireWorkerLease / heartbeatWorkerLease / releaseWorkerLease
  //      drive it. The `workerKind` argument partitions the lease:
  //      'embedding' and 'reflection' hold independently so both can
  //      run concurrently. Duplicate Venice charges would otherwise be
  //      the default for anyone with a laptop + phone both unlocked.
  //
  //   2. A per-row claim covers the lease-handover race: a row the
  //      previous lease holder was mid-processing shouldn't be instantly
  //      grabbed by the new holder. For embeddings that's
  //      (`embedding_claim_holder`, `embedding_claim_expires`) columns
  //      on `memories`; for reflection it's a parallel pair on `threads`.
  //      The claim keeps the row reserved until TTL expires (long
  //      enough for the old device's in-flight network call to
  //      definitely have returned or timed out).
  //
  // Everything flows through SECURITY INVOKER RPCs in the schema so the
  // atomic bits (on-conflict upsert, FOR UPDATE SKIP LOCKED, save-if-
  // claim-still-ours) run in a single round trip each.

  /**
   * Try to take the singleton lease for a given worker kind. Returns
   * true iff we hold it after the call. Safe to call at any interval —
   * the RPC is idempotent (harmless if we already hold it, harmless if
   * someone else does and theirs hasn't expired).
   */
  async acquireWorkerLease(
    workerKind: string,
    holderId: string,
    ttlSeconds: number
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('acquire_worker_lease', {
      p_worker_kind: workerKind,
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /**
   * Extend our lease for a given worker kind. Returns false if the
   * lease has already been taken over by someone else — in that case
   * the worker must stop processing immediately; continuing would risk
   * a double-work race with the new holder.
   */
  async heartbeatWorkerLease(
    workerKind: string,
    holderId: string,
    ttlSeconds: number
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('heartbeat_worker_lease', {
      p_worker_kind: workerKind,
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /**
   * Release our lease for a given worker kind explicitly on graceful
   * shutdown (stop message, app lock, sign-out). Idempotent — no-op
   * when we don't actually hold it. Lets another device take over
   * instantly instead of waiting for the TTL to elapse.
   */
  async releaseWorkerLease(workerKind: string, holderId: string): Promise<void> {
    const { error } = await this.client.rpc('release_worker_lease', {
      p_worker_kind: workerKind,
      p_holder_id: holderId,
    });
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Atomically claim the next memory awaiting an embedding and stamp
   * our holder + claim-expiry onto it. Returns null when the queue is
   * empty (or every pending row is already claimed by a still-unexpired
   * holder — which shouldn't happen under the lease invariant, but the
   * query handles it correctly regardless).
   */
  async claimNextPendingMemory(
    holderId: string,
    ttlSeconds: number
  ): Promise<{ id: string; label: string; data: string } | null> {
    const { data, error } = await this.client.rpc('claim_next_pending_memory', {
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as { id: string; label: string; data: string }[];
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Save an embedding IF our claim is still valid — the SQL function
   * guards on `embedding_claim_holder = $me AND embedding_claim_expires
   * > now()`. Returns false when the row was edited (trigger nulled our
   * claim), the claim expired and was retaken, or the row was deleted.
   * Callers treat a false as "skip, loop to next row"; it is not an
   * error condition.
   */
  async saveMemoryEmbedding(
    id: string,
    holderId: string,
    embedding: number[],
    model: string
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('save_memory_embedding_if_claimed', {
      p_id: id,
      p_holder_id: holderId,
      p_embedding: embedding,
      p_embedding_model: model,
    });
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /**
   * Atomically claim the oldest thread in need of reflection. Returns
   * null when no thread qualifies (already-reflected, under the token
   * threshold, or currently claimed by another device). The returned
   * `terminalMsgId` is the specific assistant message we should
   * reflect up to; we pass it back to `markThreadReflectedIfClaimed`
   * after a successful run so a race where the user adds more turns
   * mid-reflection simply queues the thread for the next cycle.
   */
  async claimNextThreadForReflection(
    holderId: string,
    ttlSeconds: number
  ): Promise<{ threadId: string; terminalMsgId: string } | null> {
    const { data, error } = await this.client.rpc('claim_next_thread_for_reflection', {
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as { thread_id: string; terminal_msg_id: string }[];
    if (rows.length === 0) return null;
    const row = rows[0];
    return { threadId: row.thread_id, terminalMsgId: row.terminal_msg_id };
  }

  /**
   * Stamp `last_reflected_msg_id` IF our claim is still valid. Returns
   * false when the claim expired or another device took over. Callers
   * treat false as "skip, loop to next"; any memory writes the agent
   * made during the run stay, because memories are owned by the user,
   * not the claim — re-reflection on the same thread just finds them
   * via memory_search and memory_update rather than duplicate.
   */
  async markThreadReflectedIfClaimed(
    threadId: string,
    holderId: string,
    msgId: string
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('mark_thread_reflected_if_claimed', {
      p_thread_id: threadId,
      p_holder_id: holderId,
      p_msg_id: msgId,
    });
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /**
   * Atomically claim the oldest thread that hasn't been summarised
   * through its latest terminal assistant message. Returns null when
   * nothing qualifies. The returned `terminalMsgId` is the specific
   * message we should summarise up to — passed back to
   * `saveThreadSummaryIfClaimed` so a race where the user adds more
   * turns mid-summary simply queues the thread for the next cycle.
   */
  async claimNextThreadForSummary(
    holderId: string,
    ttlSeconds: number
  ): Promise<{ threadId: string; terminalMsgId: string } | null> {
    const { data, error } = await this.client.rpc('claim_next_thread_for_summary', {
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as { thread_id: string; terminal_msg_id: string }[];
    if (rows.length === 0) return null;
    const row = rows[0];
    return { threadId: row.thread_id, terminalMsgId: row.terminal_msg_id };
  }

  /**
   * Save the generated summary IF our claim is still valid. The RPC
   * guards on holder + TTL + user_id. A false return means the claim
   * expired or another device took over — caller drops the work.
   */
  async saveThreadSummaryIfClaimed(
    threadId: string,
    holderId: string,
    summary: string,
    msgId: string
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('save_thread_summary_if_claimed', {
      p_thread_id: threadId,
      p_holder_id: holderId,
      p_summary: summary,
      p_msg_id: msgId,
    });
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /**
   * Claim the next thread awaiting a title+summary embedding. Same
   * shape as `claimNextPendingMemory` but against threads. Rows with
   * the placeholder title AND no summary yet are deliberately skipped
   * — they haven't settled yet and embedding empty-ish text would
   * waste a Venice call.
   */
  async claimNextPendingThreadForEmbedding(
    holderId: string,
    ttlSeconds: number
  ): Promise<{ id: string; title: string; summary: string | null } | null> {
    const { data, error } = await this.client.rpc(
      'claim_next_pending_thread_for_embedding',
      { p_holder_id: holderId, p_ttl_seconds: ttlSeconds }
    );
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as { id: string; title: string; summary: string | null }[];
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Save a thread embedding IF our claim is still valid. False = the
   * row was edited or re-claimed; caller skips and loops. Never throws
   * on a race, only on a network / SQL error.
   */
  async saveThreadEmbedding(
    id: string,
    holderId: string,
    embedding: number[],
    model: string
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('save_thread_embedding_if_claimed', {
      p_id: id,
      p_holder_id: holderId,
      p_embedding: embedding,
      p_embedding_model: model,
    });
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /**
   * Halve a memory's confidence — the reflection agent's `memory_invalidate`
   * soft-delete path. Returns the new confidence (the server-side value
   * after the update). A memory hit many times falls below the 0.05
   * search-hide floor without hard-deleting, keeping it recoverable if
   * the agent re-learns the fact. Not gated on RLS beyond the
   * `user_id = auth.uid()` check inside the RPC.
   */
  async decayMemoryConfidence(id: string): Promise<number | null> {
    const { data, error } = await this.client.rpc('decay_memory_confidence', {
      p_id: id,
    });
    if (error) throw new SupabaseError(error.message);
    return typeof data === 'number' ? data : null;
  }

  /**
   * Bump a memory's confidence by 1.0, capped at 10.0. The cap prevents
   * a runaway agent from saturating the log boost; the bump itself is
   * what the reflection agent calls after a corroborating
   * `memory_update` so repeatedly-confirmed memories surface ahead of
   * single-sighting ones in search.
   */
  async bumpMemoryConfidence(id: string): Promise<number | null> {
    const { data, error } = await this.client.rpc('bump_memory_confidence', {
      p_id: id,
    });
    if (error) throw new SupabaseError(error.message);
    return typeof data === 'number' ? data : null;
  }

  /**
   * Chat-side reaffirm: +0.5 capped at 10.0. Gentler than the reflection
   * agent's bump (+1.0) because it fires mid-turn on a single exchange
   * rather than on settled evidence across a conversation. Returns the
   * post-adjustment value so the tool result can echo it to the LLM.
   */
  async reaffirmMemoryConfidence(id: string): Promise<number | null> {
    const { data, error } = await this.client.rpc(
      'reaffirm_memory_confidence',
      { p_id: id }
    );
    if (error) throw new SupabaseError(error.message);
    return typeof data === 'number' ? data : null;
  }

  /**
   * Chat-side doubt: ×0.7 with no floor. Gentler than the reflection
   * agent's decay (×0.5). Five doubts from 1.0 lands around 0.168
   * ([shaky] tag territory) without crashing below the 0.05 search-hide
   * floor in one hit.
   */
  async doubtMemoryConfidence(id: string): Promise<number | null> {
    const { data, error } = await this.client.rpc('doubt_memory_confidence', {
      p_id: id,
    });
    if (error) throw new SupabaseError(error.message);
    return typeof data === 'number' ? data : null;
  }

  /**
   * Cosine-similarity search via the `search_memories_by_embedding` RPC.
   * The RPC enforces `user_id = auth.uid()` in addition to RLS and hides
   * the `embedding` column from the response — 2048 floats per row is a
   * lot to ship back just to throw away. Confidence rides the row so
   * consumers can format the qualitative tag without a second round-trip.
   */
  async searchMemoriesByEmbedding(
    queryEmbedding: number[],
    limit: number
  ): Promise<Memory[]> {
    const { data, error } = await this.client.rpc('search_memories_by_embedding', {
      query_embedding: queryEmbedding,
      match_limit: limit,
    });
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as Memory[];
  }

  /**
   * Scored variant of `searchMemoriesByEmbedding`. Same ranking
   * formula, but returns the boosted similarity score per row so the
   * caller can threshold in application code. Used by the opening-
   * turn memory-recall priming in chat-loop.ts — the main
   * `memory_search` path continues to use the unscored RPC.
   */
  async searchMemoriesByEmbeddingScored(
    queryEmbedding: number[],
    limit: number
  ): Promise<
    Array<{
      id: string;
      label: string;
      data: string;
      confidence: number;
      similarity: number;
    }>
  > {
    const { data, error } = await this.client.rpc(
      'search_memories_by_embedding_scored',
      {
        query_embedding: queryEmbedding,
        match_limit: limit,
      }
    );
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as Array<{
      id: string;
      label: string;
      data: string;
      confidence: number;
      similarity: number;
    }>;
  }

  /**
   * Insert a new edge in the memory-relations graph. The unique
   * constraint on (user_id, from_memory_id, to_memory_id, kind) means a
   * repeated call for the same edge raises; the tool-side handler maps
   * that to a friendlier "already exists" payload. Self-loops are
   * rejected at the tool boundary, not here.
   */
  async createMemoryRelation(
    fromId: string,
    toId: string,
    kind: MemoryRelation['kind'],
    note: string | null
  ): Promise<{ id: string; kind: MemoryRelation['kind'] }> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data, error } = await this.client
      .from('memory_relations')
      .insert({
        user_id: session.user.id,
        from_memory_id: fromId,
        to_memory_id: toId,
        kind,
        note,
      })
      .select('id, kind')
      .single();
    if (error) throw new SupabaseError(error.message);
    return data as { id: string; kind: MemoryRelation['kind'] };
  }

  /**
   * Delete a single relation by id. RLS scopes the delete to the
   * signed-in user's own rows; a wrong id (or another user's edge) is
   * silently a no-op, matching the rest of the CRUD surface here.
   */
  async deleteMemoryRelation(id: string): Promise<void> {
    const { error } = await this.client
      .from('memory_relations')
      .delete()
      .eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Outbound edges for a batch of memory ids, joined to the target
   * memory's display fields. Used by opening-recall (bounded traversal),
   * the memory_search tool (graph context alongside hits), and
   * Memories.svelte (per-row edge panel). Returns an empty array if
   * `ids` is empty so callers can skip a conditional.
   */
  async listMemoryRelationsFor(ids: string[]): Promise<MemoryRelation[]> {
    if (ids.length === 0) return [];
    const { data, error } = await this.client.rpc('get_memory_relations', {
      p_ids: ids,
    });
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as MemoryRelation[];
  }

  /**
   * ILIKE fallback, scoped to rows the worker hasn't embedded yet. Used
   * by `memory_search` to fill in results for just-created memories —
   * without this, a memory the user wrote seconds ago would be invisible
   * until the worker catches up.
   */
  async searchUnembeddedMemoriesByText(
    query: string,
    limit: number
  ): Promise<Memory[]> {
    if (!query || query.length === 0) return [];
    const safe = query.replace(/([,()])/g, '\\$1');
    const pattern = `%${safe}%`;
    const { data, error } = await this.client
      .from('memories')
      .select('id, label, data, confidence, created_at, updated_at')
      .is('embedding', null)
      .or(`label.ilike.${pattern},data.ilike.${pattern}`)
      .order('updated_at', { ascending: false })
      .limit(limit);
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as Memory[];
  }

  async listMessages(threadId: string): Promise<Message[]> {
    const { data, error } = await this.client
      .from('messages')
      .select('*')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    const messages = (data ?? []) as Message[];
    // Hydrate attachments in a second query keyed by message id. Keeps
    // the base SELECT cheap (no large base64 payloads on the wire for
    // rows without attachments, which is the common case) and lets
    // the realtime subscribe path reuse the same hydration helper
    // later.
    const userMessageIds = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.id);
    if (userMessageIds.length > 0) {
      const attachmentsByMessageId = await this.listAttachmentsByMessageIds(userMessageIds);
      for (const m of messages) {
        m.attachments = attachmentsByMessageId.get(m.id) ?? [];
      }
    } else {
      for (const m of messages) {
        if (m.role === 'user') m.attachments = [];
      }
    }
    // Repair an interrupted-exchange tail in memory so every reader -
    // chat UI, summary worker, journal worker, reflection worker,
    // recall agents, samskara worker - sees a wire-format-valid
    // sequence. The synthesized rows ride through the wire projection
    // like normal rows; the chat-loop's send path persists them ahead
    // of the next user turn so the DB heals on revisit. See
    // lib/conversation-recovery.ts for the cases handled.
    return synthesizeRecoveryMessages(messages);
  }

  /**
   * Fetch every attachment belonging to the given user-message ids, in
   * one round trip. Returns a map keyed by `message_id` so the caller
   * can hang the array straight onto each message. Ordered by
   * `position` within each bucket so the message renderer doesn't have
   * to re-sort.
   *
   * Used by `listMessages` for the initial load and by the realtime
   * subscription path when a user row arrives with attachments.
   */
  async listAttachmentsByMessageIds(
    messageIds: string[]
  ): Promise<Map<string, Attachment[]>> {
    const result = new Map<string, Attachment[]>();
    if (messageIds.length === 0) return result;
    // `data` is the large column. It's a plain text column holding a
    // base64-encoded file body (see schema.sql's message_attachments
    // block for why not bytea). We rename it to `data_base64` in the
    // TS shape so consumers of the Attachment type can't mistake it
    // for raw bytes.
    const { data, error } = await this.client
      .from('message_attachments')
      .select(
        'id, message_id, position, filename, mime_type, size_bytes, data, extracted_text, expired_at, created_at'
      )
      .in('message_id', messageIds)
      .order('position', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    for (const row of (data ?? []) as Array<
      Omit<Attachment, 'data_base64'> & { data: string | null }
    >) {
      const existing = result.get(row.message_id) ?? [];
      const attachment: Attachment = {
        id: row.id,
        message_id: row.message_id,
        position: row.position,
        filename: row.filename,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        data_base64: row.data,
        extracted_text: row.extracted_text,
        expired_at: row.expired_at,
        created_at: row.created_at,
      };
      existing.push(attachment);
      result.set(row.message_id, existing);
    }
    return result;
  }

  /**
   * Bulk-insert attachments for a just-written user message. Writes
   * rows in the given order; `position` is caller-supplied so the
   * render order matches the order the user picked them in.
   *
   * Returns the hydrated rows (including generated ids and
   * timestamps) so the caller can append them to the in-memory
   * message without a follow-up fetch.
   */
  async addAttachments(
    messageId: string,
    rows: NewAttachment[]
  ): Promise<Attachment[]> {
    if (rows.length === 0) return [];
    const payload = rows.map((r) => ({
      message_id: messageId,
      position: r.position,
      filename: r.filename,
      mime_type: r.mime_type,
      size_bytes: r.size_bytes,
      // The DB column is plain `text` — the base64 string rides
      // through PostgREST unchanged on both write and read. See the
      // note on `message_attachments.data` in schema.sql for why
      // this isn't a bytea column.
      data: r.data_base64,
      extracted_text: r.extracted_text,
    }));
    const { data, error } = await this.client
      .from('message_attachments')
      .insert(payload)
      .select(
        'id, message_id, position, filename, mime_type, size_bytes, data, extracted_text, expired_at, created_at'
      );
    if (error) throw new SupabaseError(error.message);
    return ((data ?? []) as Array<
      Omit<Attachment, 'data_base64'> & { data: string | null }
    >).map((row) => ({
      id: row.id,
      message_id: row.message_id,
      position: row.position,
      filename: row.filename,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      data_base64: row.data,
      extracted_text: row.extracted_text,
      expired_at: row.expired_at,
      created_at: row.created_at,
    }));
  }

  /**
   * Find the most recent image attachment in this thread whose filename
   * matches exactly. Returns the row regardless of expiry state - the
   * caller distinguishes "not found" (null return) from "expired"
   * (`data_base64 === null` on the returned row) and produces the right
   * diagnostic for the model.
   *
   * Why thread-scoped instead of message-scoped: the analyze_image tool
   * needs to reach images attached on prior turns of the same conversation,
   * not just the user message that opened the current turn. The earlier
   * design passed only the current message's attachments into ToolContext,
   * which left the model unable to re-analyze an image once the user sent
   * any follow-up message. RLS on `message_attachments` already scopes
   * access to the signed-in user via the via-parent-of-parent chain
   * (attachment -> message -> thread -> user_id), so the join here adds
   * thread filtering without weakening the security model.
   */
  async findImageByFilenameInThread(
    threadId: string,
    filename: string
  ): Promise<Attachment | null> {
    const { data, error } = await this.client
      .from('message_attachments')
      .select(
        'id, message_id, position, filename, mime_type, size_bytes, data, extracted_text, expired_at, created_at, messages!inner(thread_id)'
      )
      .eq('messages.thread_id', threadId)
      .eq('filename', filename)
      .like('mime_type', 'image/%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    if (!data) return null;
    const row = data as Omit<Attachment, 'data_base64'> & { data: string | null };
    return {
      id: row.id,
      message_id: row.message_id,
      position: row.position,
      filename: row.filename,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      data_base64: row.data,
      extracted_text: row.extracted_text,
      expired_at: row.expired_at,
      created_at: row.created_at,
    };
  }

  /**
   * Lightweight summary of every attachment in a thread, used to render
   * the `<thread_attachments>` system block in chat-loop. Deliberately
   * omits the `data` and `extracted_text` columns because both are
   * potentially huge (base64-encoded file bodies, full document text)
   * and the block only needs filenames + categorisation.
   *
   * Live vs expired is read off `expired_at` rather than `data is null`
   * - the schema guarantees those two states are equivalent (see the
   * comment block on `message_attachments` in `schema.sql`), and
   * checking `expired_at` lets us skip projecting the heavy `data`
   * column entirely.
   */
  async listAttachmentSummariesForThread(
    threadId: string
  ): Promise<ThreadAttachmentSummary[]> {
    const { data, error } = await this.client
      .from('message_attachments')
      .select(
        'filename, mime_type, expired_at, created_at, messages!inner(thread_id)'
      )
      .eq('messages.thread_id', threadId)
      .order('created_at', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    return ((data ?? []) as Array<{
      filename: string;
      mime_type: string;
      expired_at: string | null;
      created_at: string;
    }>).map((row) => ({
      filename: row.filename,
      mime_type: row.mime_type,
      is_image: row.mime_type.startsWith('image/'),
      expired: row.expired_at !== null,
      created_at: row.created_at,
    }));
  }

  /**
   * Run one pass of the attachment expiry sweep via the
   * `expire_old_attachments` RPC. Returns the number of rows the
   * server nulled on this call. The worker drains the backlog by
   * calling repeatedly while the count is > 0.
   */
  async expireOldAttachments(days: number): Promise<number> {
    const { data, error } = await this.client.rpc('expire_old_attachments', {
      p_days: days,
    });
    if (error) throw new SupabaseError(error.message);
    return typeof data === 'number' ? data : 0;
  }

  /**
   * Insert one message row and touch the thread's updated_at in a
   * follow-up call. The two writes aren't in a transaction — if the
   * second call fails, we've still saved the message and the thread
   * just keeps its old ordering timestamp until the next activity.
   * That's intentional: losing the message would be a bigger regression
   * than a briefly stale sort order.
   *
   * The optional OpenAI-shape fields let assistant-with-tool-calls and
   * tool-result rows round-trip faithfully. `tool_calls` applies to
   * assistant rows that invoked tools; `tool_call_id` and `name` apply
   * to role='tool' rows pairing the assistant call to its result.
   */
  async addMessage(
    threadId: string,
    role: Message['role'],
    content: string,
    opts: {
      tool_calls?: OpenAIToolCall[] | null;
      tool_call_id?: string | null;
      name?: string | null;
      /** Concrete Venice model id that produced this assistant row. */
      model?: string | null;
      /** Token-usage object returned by the provider for this turn. */
      usage?: TokenUsage | null;
      /** Chain-of-thought text; null when the model didn't produce any. */
      reasoning?: string | null;
      /** Venice web-search citations for this turn. */
      citations?: Citation[] | null;
    } = {}
  ): Promise<Message> {
    // Trim outer whitespace at the write boundary. LLM responses
    // sometimes land with a leading newline or indent (often from
    // Venice's SSE parser peeling the reasoning channel off the
    // content stream), which the markdown renderer interprets as a
    // code-indent and sets the whole reply at a blockquote offset.
    // User inputs occasionally carry trailing blank lines from
    // mobile autocomplete or paste. Trimming at insert keeps the DB
    // canonical; the Markdown component trims at render too so
    // existing rows benefit without a backfill.
    const trimmedContent = content.trim();
    const row: Record<string, unknown> = { thread_id: threadId, role, content: trimmedContent };
    if (opts.tool_calls !== undefined) row.tool_calls = opts.tool_calls;
    if (opts.tool_call_id !== undefined) row.tool_call_id = opts.tool_call_id;
    if (opts.name !== undefined) row.name = opts.name;
    if (opts.model !== undefined) row.model = opts.model;
    if (opts.usage !== undefined) row.usage = opts.usage;
    if (opts.reasoning !== undefined) row.reasoning = opts.reasoning;
    if (opts.citations !== undefined) row.citations = opts.citations;
    const { data, error } = await this.client
      .from('messages')
      .insert(row)
      .select()
      .single();
    if (error) throw new SupabaseError(error.message);
    await this.client
      .from('threads')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', threadId);
    return data as Message;
  }

  /**
   * Atomic terminal-assistant-message insert with conflict detection.
   * Routes through the `add_assistant_message` Postgres function which:
   *   1. Locks the thread row to prevent two devices from both committing.
   *   2. Checks for any user message created after p_user_message_id. If
   *      one exists the response was generated against a stale context and
   *      must not land - the function returns { conflict: true }.
   *   3. Inserts the assistant row and bumps threads.updated_at.
   *
   * Returns { conflict: true } when the check fires, or
   * { conflict: false, message } on success. The caller (chat-loop) treats
   * a conflict as a non-error early exit rather than throwing, so the UI
   * can show a focused "conversation changed on another device" prompt
   * instead of the generic error banner.
   *
   * Only used for terminal assistant rows (the final answer and
   * user-interrupted rows). Intermediate tool-calling rounds use the
   * regular addMessage path - they are same-device and same-context by
   * construction, so the conflict check would be noise.
   */
  async commitAssistantMessage(
    threadId: string,
    content: string,
    opts: {
      model?: string | null;
      usage?: TokenUsage | null;
      reasoning?: string | null;
      citations?: Citation[] | null;
    },
    userMessageId: string
  ): Promise<{ conflict: true } | { conflict: false; message: Message }> {
    const trimmed = content.trim();
    const { data, error } = await this.client.rpc('add_assistant_message', {
      p_thread_id:       threadId,
      p_user_message_id: userMessageId,
      p_content:         trimmed,
      p_model:           opts.model ?? null,
      p_usage:           opts.usage ?? null,
      p_reasoning:       opts.reasoning ?? null,
      p_citations:       opts.citations ?? null,
    });
    if (error) throw new SupabaseError(error.message);
    const result = data as { conflict: boolean; message?: unknown };
    if (result.conflict) return { conflict: true };
    return { conflict: false, message: result.message as Message };
  }

  /**
   * Hard-delete a contiguous batch of message rows. Used by the
   * regenerate-from-here flow: the rows for the discarded turn(s) stay
   * in the DB while the replacement is in flight (so a mid-stream
   * abort or error can un-grey them without data loss), then are
   * deleted in one shot once the new completion lands.
   *
   * `message_attachments` rows cascade via the FK's ON DELETE CASCADE
   * (schema.sql). `samskara_substrate` does NOT cascade by design - an
   * orphan substrate row still carries training signal for the
   * formation pipeline, so we leave it.
   *
   * No-op when `ids` is empty so callers don't have to guard.
   */
  async deleteMessages(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { error } = await this.client
      .from('messages')
      .delete()
      .in('id', ids);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Realtime: stream INSERTs for a single thread's messages. Keeps a
   * thread open on two devices in sync — when device A's chat-loop
   * commits a user / assistant / tool row, device B sees it land in
   * the transcript without a refresh. Filtering happens server-side
   * (`filter: thread_id=eq.<id>`), layered on top of RLS so a
   * compromised client can't just listen to other users' threads.
   *
   * The caller is responsible for deduping — the inserting device
   * also receives an echo of its own write, and a race can push the
   * echo ahead of the promise resolution for `addMessage`. Dedupe by
   * `Message.id` at the append site handles both orderings.
   */
  subscribeToMessages(
    threadId: string,
    onInsert: (msg: Message) => void
  ): () => void {
    const channel = this.client
      .channel(`messages:${threadId}`)
      .on(
        // `postgres_changes` is the realtime-js event shape for
        // replication-stream rows. Typed loose here — the supabase-js
        // generic is over a whole DB schema and we don't have one.
        'postgres_changes' as never,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `thread_id=eq.${threadId}`,
        },
        (payload: { new: Message }) => {
          // Defend the realtime channel: if onInsert throws, the
          // postgres_changes subscription dies silently (no error
          // surfaced anywhere) and the transcript stops receiving
          // echoes for this thread until the user re-selects it.
          // Log and swallow so subsequent echoes still arrive.
          try {
            onInsert(payload.new);
          } catch (err) {
            log.error('subscribeToMessages onInsert threw', err);
          }
        }
      )
      .subscribe();
    return () => {
      // removeChannel returns a promise but we don't care to await —
      // the caller is teardown path, and stray events after this
      // would be no-ops (the channel is detached). Fire-and-forget
      // matches the onAuthChange unsubscribe contract above.
      void this.client.removeChannel(channel);
    };
  }

  /**
   * Realtime: stream INSERT / UPDATE / DELETE on the current user's
   * threads. Keeps the sidebar in sync across devices — a rename on
   * phone reflects on desktop, a newly-created thread appears in the
   * list, and the `updated_at` bump that each message triggers
   * reorders the list newest-first without polling. RLS enforces the
   * user_id scoping; the filter here just narrows the wire traffic.
   *
   * DELETE payloads only carry the primary key (the default
   * `replica identity` — we don't need old-column values), so the
   * handler receives just the id.
   */
  subscribeToThreads(
    userId: string,
    handlers: {
      onInsert?: (thread: Thread) => void;
      onUpdate?: (thread: Thread) => void;
      onDelete?: (id: string) => void;
    }
  ): () => void {
    const channel = this.client
      .channel(`threads:${userId}`)
      .on(
        'postgres_changes' as never,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'threads',
          filter: `user_id=eq.${userId}`,
        },
        (payload: { new: Thread }) => {
          handlers.onInsert?.(payload.new);
        }
      )
      .on(
        'postgres_changes' as never,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'threads',
          filter: `user_id=eq.${userId}`,
        },
        (payload: { new: Thread }) => {
          handlers.onUpdate?.(payload.new);
        }
      )
      .on(
        'postgres_changes' as never,
        {
          event: 'DELETE',
          schema: 'public',
          table: 'threads',
          filter: `user_id=eq.${userId}`,
        },
        (payload: { old: { id: string } }) => {
          handlers.onDelete?.(payload.old.id);
        }
      )
      .subscribe();
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  // Samskara RPCs --------------------------------------------------------
  //
  // Thin wrappers over the SQL functions defined in the samskara
  // section of supabase/schema.sql. The sql functions own all the
  // RLS-aware bookkeeping (claim guards, cohort weighting, the
  // confidence formula); these methods just shape the arguments and
  // unwrap the response.
  //
  // The chat-loop side (fire/record/getCompoundSummary) is read-light
  // and called once per turn. The worker side
  // (claim/save/decay/compound-regen) is the formation pipeline; see
  // src/lib/agents/samskara/ for callers.

  /**
   * Top-K cosine fire over the user's samskaras. Ranks by
   * `cosine^1.3 * sqrt(health * confidence) * sample-size bonus` so
   * weak-but-relevant samskaras can break through against strong-but-
   * distant ones, while topical samskaras whose cosine is genuinely
   * low get pushed further down (the 1.3 power on cosine is a
   * relevance nudge, not a threshold). The caller computes `kMax` as
   * `ceil(K_BASE * log10(N + 10))` per the agreed log10 dampening on
   * priming volume.
   */
  async samskaraFireTopK(
    queryEmbedding: number[],
    kMax: number
  ): Promise<SamskaraFireRow[]> {
    const { data, error } = await this.client.rpc('samskara_fire_top_k', {
      p_query_embedding: queryEmbedding,
      p_k_max: kMax,
    });
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as SamskaraFireRow[];
  }

  /**
   * Persist the cohort fire log + bump per-samskara fire counters in
   * one round trip. `fires` is an array of `{samskaraId, score}`
   * objects; the RPC takes a jsonb wire shape so the caller doesn't
   * need to learn Postgres array literals.
   */
  async samskaraRecordFires(
    cohortId: string,
    threadId: string,
    fires: { samskaraId: string; score: number }[]
  ): Promise<void> {
    if (fires.length === 0) return;
    const payload = fires.map((f) => ({ samskara_id: f.samskaraId, score: f.score }));
    const { error } = await this.client.rpc('samskara_record_fires', {
      p_cohort_id: cohortId,
      p_thread_id: threadId,
      p_fires: payload,
    });
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Apply a cohort reaction across confirm / disconfirm / neutral
   * partitions. The RPC owns the cohort-aware reinforcement
   * weighting (+1/sqrt(N) per member rather than full +1) so cohorts
   * influence their members without dominating single-fire signal.
   */
  async samskaraApplyReaction(
    cohortId: string,
    confirmIds: string[],
    disconfirmIds: string[],
    neutralIds: string[]
  ): Promise<void> {
    const { error } = await this.client.rpc('samskara_apply_reaction', {
      p_cohort_id: cohortId,
      p_confirm_ids: confirmIds,
      p_disconfirm_ids: disconfirmIds,
      p_neutral_ids: neutralIds,
    });
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Insert the per-round substrate stub. The chat loop calls this at
   * end-of-round with the just-persisted message ids; the assimilator
   * worker phase fills in `situation`/`outcome`/`valence` later.
   */
  async samskaraRecordSubstrate(
    threadId: string,
    userMessageId: string,
    assistantMessageId: string | null
  ): Promise<string> {
    const { data, error } = await this.client.rpc('samskara_record_substrate', {
      p_thread_id: threadId,
      p_user_message_id: userMessageId,
      p_assistant_message_id: assistantMessageId,
    });
    if (error) throw new SupabaseError(error.message);
    return data as string;
  }

  /**
   * Read the cached compound summary row. NULL summary or absent row
   * is the cold-start case; chat-loop reader treats both as "no
   * compound block this turn." The caller decides any staleness
   * ceiling on `lastRegenAt` — kept here for future use.
   */
  async samskaraGetCompoundSummary(): Promise<{
    summary: string | null;
    lastRegenAt: string | null;
    samskaraCountAtRegen: number;
  } | null> {
    // samskara_count_at_regen is purely a diagnostics hook — the
    // getter the chat loop uses discards it, but the Samskara
    // diagnostics screen wants to show "summary covers N samskaras".
    // Cheap to return regardless; no reason to fork into two methods.
    const { data, error } = await this.client
      .from('samskara_compound_summary')
      .select('summary, last_regen_at, samskara_count_at_regen')
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    if (!data) return null;
    const row = data as {
      summary: string | null;
      last_regen_at: string | null;
      samskara_count_at_regen: number | null;
    };
    return {
      summary: row.summary,
      lastRegenAt: row.last_regen_at,
      samskaraCountAtRegen: row.samskara_count_at_regen ?? 0,
    };
  }

  /** Worker: claim the next substrate row needing assimilation. */
  async samskaraClaimNextAssimilate(
    holderId: string,
    ttlSeconds: number
  ): Promise<{
    id: string;
    threadId: string;
    userMessageId: string;
    assistantMessageId: string | null;
  } | null> {
    const { data, error } = await this.client.rpc('samskara_claim_next_assimilate', {
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      id: string;
      thread_id: string;
      user_message_id: string;
      assistant_message_id: string | null;
    }[];
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      threadId: row.thread_id,
      userMessageId: row.user_message_id,
      assistantMessageId: row.assistant_message_id,
    };
  }

  /** Worker: save assimilator output IF claim still ours. */
  async samskaraSaveAssimilation(
    id: string,
    holderId: string,
    situation: string,
    outcome: string | null,
    valence: number | null
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc(
      'samskara_save_assimilation_if_claimed',
      {
        p_id: id,
        p_holder_id: holderId,
        p_situation: situation,
        p_outcome: outcome,
        p_valence: valence,
      }
    );
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /** Worker: claim the next substrate row needing an embedding. */
  async samskaraClaimNextSubstrateEmbed(
    holderId: string,
    ttlSeconds: number
  ): Promise<{ id: string; situation: string; outcome: string | null } | null> {
    const { data, error } = await this.client.rpc(
      'samskara_claim_next_substrate_embed',
      { p_holder_id: holderId, p_ttl_seconds: ttlSeconds }
    );
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      id: string;
      situation: string;
      outcome: string | null;
    }[];
    return rows.length > 0 ? rows[0] : null;
  }

  /** Worker: save substrate embedding IF claim still ours. */
  async samskaraSaveSubstrateEmbedding(
    id: string,
    holderId: string,
    embedding: number[],
    model: string
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc(
      'samskara_save_substrate_embedding_if_claimed',
      {
        p_id: id,
        p_holder_id: holderId,
        p_embedding: embedding,
        p_embedding_model: model,
      }
    );
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /** Worker: run the decay pass. Returns count of rows changed. */
  async samskaraDecay(): Promise<number> {
    const { data, error } = await this.client.rpc('samskara_decay');
    if (error) throw new SupabaseError(error.message);
    return typeof data === 'number' ? data : 0;
  }

  /** Worker: should we regenerate the compound summary right now? */
  async samskaraShouldRegenCompound(): Promise<{
    shouldRegen: boolean;
    samskaraCount: number;
    lastRegenAt: string | null;
  }> {
    const { data, error } = await this.client.rpc('samskara_should_regen_compound');
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      should_regen: boolean;
      samskara_count: number;
      last_regen_at: string | null;
    }[];
    if (rows.length === 0) {
      return { shouldRegen: false, samskaraCount: 0, lastRegenAt: null };
    }
    const r = rows[0];
    return {
      shouldRegen: r.should_regen,
      samskaraCount: r.samskara_count,
      lastRegenAt: r.last_regen_at,
    };
  }

  /** Worker: claim the compound-regen slot. False = another device has it. */
  async samskaraClaimCompoundRegen(
    holderId: string,
    ttlSeconds: number
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('samskara_claim_compound_regen', {
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /** Worker: save the regenerated compound summary IF claim still ours. */
  async samskaraSaveCompoundSummary(
    holderId: string,
    summary: string,
    samskaraCount: number
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc(
      'samskara_save_compound_summary_if_claimed',
      {
        p_holder_id: holderId,
        p_summary: summary,
        p_samskara_count: samskaraCount,
      }
    );
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /**
   * Worker: read the substrate-pair candidates for the relator phase.
   * Returns recent embedded substrate rows ordered by created_at desc;
   * the relator phase finds nearest-neighbour pairs in JS rather than
   * via SQL because pgvector's `<=>` operator on a self-cross-join is
   * O(n^2) and the per-user substrate count stays small enough that
   * the JS pass is fine.
   */
  async samskaraRecentEmbeddedSubstrate(limit: number): Promise<SamskaraSubstrateRow[]> {
    const { data, error } = await this.client
      .from('samskara_substrate')
      .select('id, situation, outcome, valence, situation_embedding, created_at')
      .not('situation_embedding', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as SamskaraSubstrateRow[];
  }

  /**
   * Worker: find the nearest existing samskaras by cosine similarity
   * on `prediction_embedding`. Used by the mint-tier1 dedup guard to
   * avoid creating near-duplicate twins - the minter agent only sees
   * the immediate substrate sample and has no visibility into the
   * existing corpus, so without this check a rewording of "user
   * prefers ancient grains" lands as a separate samskara instead of
   * reinforcing the original.
   */
  async samskaraNearestByPrediction(
    embedding: number[],
    kMax: number
  ): Promise<{ id: string; cosine: number; tier: number }[]> {
    const { data, error } = await this.client.rpc(
      'samskara_nearest_by_prediction',
      {
        p_query_embedding: embedding,
        p_k_max: kMax,
      }
    );
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as { id: string; cosine: number; tier: number }[];
  }

  /**
   * Worker: reinforce an existing samskara on a dedup hit. Bumps
   * health by a small amount and appends substrate provenance rows
   * for the observations that prompted the re-statement. Returns
   * false when the id doesn't exist or isn't owned by the caller.
   * Confidence is NOT touched here - re-observing is a weak signal;
   * the real confidence swing stays with reaction-classify.
   */
  async samskaraReinforceExisting(
    samskaraId: string,
    substrateIds: string[],
    healthBump: number
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('samskara_reinforce_existing', {
      p_samskara_id: samskaraId,
      p_substrate_ids: substrateIds,
      p_health_bump: healthBump,
    });
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /**
   * Maintenance: collapse redundant tier-1 samskaras. Primary signal
   * is co-firing behaviour (two samskaras that reliably fire in the
   * same cohort are Hebbianly bound and merge into one); embedding
   * cosine acts as an anti-spurious-cofire floor. If the primary
   * pass leaves the tier-1 pool above `targetCount`, a safety-cap
   * second pass greedily merges by pure embedding similarity down
   * to the target. Returns the number of rows collapsed. Idempotent
   * - a second call after a clean pass returns 0. Safe to run while
   * the worker is live; a concurrent mint-tier1 can at worst
   * re-create a twin we just removed, which the next run collapses.
   *
   * Defaults mirror the RPC's own defaults; the worker phase calls
   * with all defaults, and the manual button in the diagnostics
   * modal does the same. Exposed as parameters so a future UI knob
   * (or a dev console) can dial aggressiveness without a schema
   * edit.
   */
  async samskaraCollapseByCofiring(opts?: {
    minCofires?: number;
    minCofireRatio?: number;
    cosineFloor?: number;
    targetCount?: number;
    capCosineFloor?: number;
    maxCollapses?: number;
  }): Promise<number> {
    const { data, error } = await this.client.rpc('samskara_collapse_by_cofiring', {
      p_min_cofires: opts?.minCofires ?? 3,
      p_min_cofire_ratio: opts?.minCofireRatio ?? 0.5,
      p_cosine_floor: opts?.cosineFloor ?? 0.7,
      p_target_count: opts?.targetCount ?? 150,
      p_cap_cosine_floor: opts?.capCosineFloor ?? 0.6,
      p_max_collapses: opts?.maxCollapses ?? 20,
    });
    if (error) throw new SupabaseError(error.message);
    return typeof data === 'number' ? data : 0;
  }

  /**
   * Worker: read all live samskaras ordered by ranked weight, for the
   * compound-summary regenerator. The caller passes a cap (computed
   * via log10 of total count) so the prose stays bounded as the
   * corpus grows.
   */
  async samskaraTopForSummary(limit: number): Promise<SamskaraSummaryRow[]> {
    const { data, error } = await this.client
      .from('samskaras')
      .select('id, tier, prediction, inner_voice, valence, confidence, health')
      .order('health', { ascending: false })
      .order('confidence', { ascending: false })
      .limit(limit);
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as SamskaraSummaryRow[];
  }

  // Diagnostics reads --------------------------------------------------
  //
  // These power the Samskara diagnostics screen (src/screens/Samskara.svelte).
  // They're pure selects against the user's own rows (RLS handles the
  // scoping) so they're safe to call from the main thread whenever the
  // user opens the diagnostics modal. None of them are on the chat-
  // loop hot path; they only run when a human asks to see them.

  /**
   * All substrate rows anchored to a thread, newest first. Used by the
   * diagnostics screen to narrate which turns the samskara pipeline
   * has seen for this conversation and where each row sits in the
   * assimilate -> embed lifecycle. Embedding column deliberately
   * omitted (2048 floats per row x N rows is a lot of wire traffic
   * for a human-readable panel).
   */
  async samskaraListSubstrateForThread(
    threadId: string
  ): Promise<SamskaraSubstrateDiagnosticRow[]> {
    const { data, error } = await this.client
      .from('samskara_substrate')
      .select(
        'id, user_message_id, assistant_message_id, situation, outcome, valence, embedding_model, created_at'
      )
      .eq('thread_id', threadId)
      .order('created_at', { ascending: false });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      id: string;
      user_message_id: string;
      assistant_message_id: string | null;
      situation: string | null;
      outcome: string | null;
      valence: number | null;
      embedding_model: string | null;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      userMessageId: r.user_message_id,
      assistantMessageId: r.assistant_message_id,
      situation: r.situation,
      outcome: r.outcome,
      valence: r.valence,
      embeddingModel: r.embedding_model,
      createdAt: r.created_at,
    }));
  }

  /**
   * Most recent fire's valence + tier + confidence for a thread, used
   * to seed the mood pill on conversation reopen so the user doesn't
   * have to wait for a fresh mint to see anything other than 💤.
   * Filters out fires whose joined samskara has a null valence (rare,
   * but the field is nullable until the assimilator lands a reading)
   * - returning null lets the caller fall back to the default
   * placeholder cleanly. Confidence falls back to 1 when the column
   * is null on legacy rows so the seed renders the confident column;
   * the alternative (rendering tentative for "unknown") would be a
   * worse default. `.limit(1)` keeps this cheap on threads with
   * hundreds of fires.
   */
  async samskaraGetLatestFireMood(
    threadId: string
  ): Promise<{ valence: number; tier: 1 | 2; confidence: number } | null> {
    // `samskaras!inner` collapses fires whose FK target was deleted
    // out of the result at the DB level, and the
    // `.not('samskaras.valence', 'is', null)` filter additionally
    // skips fires whose joined samskara hasn't had a valence
    // assimilated yet. Without the !inner, an orphaned fire could
    // come back with samskaras=null and burn the `.limit(1)` slot,
    // hiding a perfectly good fire one row below.
    const { data, error } = await this.client
      .from('samskara_fires')
      .select('samskaras!inner(valence, tier, confidence)')
      .eq('thread_id', threadId)
      .not('samskaras.valence', 'is', null)
      .order('fired_at', { ascending: false })
      .limit(1);
    if (error) throw new SupabaseError(error.message);
    interface EmbeddedMood {
      valence: number | null;
      tier: number;
      confidence: number | null;
    }
    const rows = (data ?? []) as unknown as {
      samskaras: EmbeddedMood | EmbeddedMood[] | null;
    }[];
    const row = rows[0];
    if (!row) return null;
    // supabase-js types the embed as an array even for N:1; runtime
    // is a single object when the FK resolves. Same shape-quirk
    // handled in samskaraListFiresForThread above.
    const joined = Array.isArray(row.samskaras)
      ? (row.samskaras[0] ?? null)
      : row.samskaras;
    if (!joined || joined.valence === null) return null;
    // Collapse any unexpected tier value to tier 1 so the consumer's
    // narrow union doesn't drift.
    const tier: 1 | 2 = joined.tier === 2 ? 2 : 1;
    return {
      valence: joined.valence,
      tier,
      confidence: joined.confidence ?? 1,
    };
  }

  /**
   * All fires anchored to a thread, newest first, with the joined
   * samskara payload so the diagnostics screen can render each cohort
   * without a follow-up round trip. Supabase embed syntax pulls the
   * FK'd row under `samskaras`. Grouping by cohort is left to the
   * renderer.
   */
  async samskaraListFiresForThread(
    threadId: string
  ): Promise<SamskaraFireDiagnosticRow[]> {
    const { data, error } = await this.client
      .from('samskara_fires')
      .select(
        'id, cohort_id, samskara_id, score, fired_at, was_confirmed, samskaras(tier, prediction, inner_voice, valence, confidence, health)'
      )
      .eq('thread_id', threadId)
      .order('fired_at', { ascending: false });
    if (error) throw new SupabaseError(error.message);
    // supabase-js types the embed as an array even for N:1 FK'd rows
    // at the type layer — at runtime it's a single object when the
    // relationship resolves to one row. Treat either shape uniformly
    // and pick the first match; null when the FK target was deleted.
    interface EmbeddedSamskara {
      tier: number;
      prediction: string;
      inner_voice: string | null;
      valence: number | null;
      confidence: number;
      health: number;
    }
    const rows = (data ?? []) as unknown as {
      id: string;
      cohort_id: string;
      samskara_id: string;
      score: number;
      fired_at: string;
      was_confirmed: boolean | null;
      samskaras: EmbeddedSamskara | EmbeddedSamskara[] | null;
    }[];
    return rows.map((r) => {
      const joined = Array.isArray(r.samskaras)
        ? (r.samskaras[0] ?? null)
        : r.samskaras;
      return {
        id: r.id,
        cohortId: r.cohort_id,
        samskaraId: r.samskara_id,
        score: r.score,
        firedAt: r.fired_at,
        wasConfirmed: r.was_confirmed,
        samskara: joined
          ? {
              tier: joined.tier,
              prediction: joined.prediction,
              innerVoice: joined.inner_voice,
              valence: joined.valence,
              confidence: joined.confidence,
              health: joined.health,
            }
          : null,
      };
    });
  }

  /**
   * Cluster a thread's fires by cosine similarity on their predictions,
   * scoped per-cohort. Used by the diagnostics modal to collapse a
   * 22-row cohort fire list down to a handful of themes the human
   * reader can scan. Returns the cluster_seq (1-based, restarts per
   * cohort) and cluster_size each fire belongs to; the renderer joins
   * back against the existing fires array by fire id.
   *
   * Threshold default 0.7 sits in BGE-M3's "topically similar" band -
   * paraphrases of the same idea typically land between 0.65 and 0.78.
   * MINT dedup uses 0.85 because that's "near-duplicate sentence";
   * for human-readable theme grouping a lower bar reads as "same idea
   * said differently." Modal exposes the threshold as a slider so the
   * caller can tune it live without a redeploy.
   */
  async samskaraClusterThreadFires(
    threadId: string,
    threshold = 0.7
  ): Promise<Map<string, { clusterSeq: number; clusterSize: number }>> {
    const { data, error } = await this.client.rpc(
      'samskara_cluster_thread_fires',
      { p_thread_id: threadId, p_threshold: threshold }
    );
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      fire_id: string;
      cluster_seq: number;
      cluster_size: number;
    }[];
    const map = new Map<string, { clusterSeq: number; clusterSize: number }>();
    for (const r of rows) {
      map.set(r.fire_id, {
        clusterSeq: r.cluster_seq,
        clusterSize: r.cluster_size,
      });
    }
    return map;
  }

  /**
   * Corpus-level counters for the diagnostics overview. Six head-only
   * count queries, awaited sequentially on purpose. Parallel Promise.all
   * here produced 6 concurrent auth-lock acquisitions in
   * `@supabase/gotrue-js`, which - stacked with the main-thread
   * refreshSettings and five worker clients on a cold-load path -
   * tripped the 5s lock timeout and failed every in-flight fetch.
   * Running sequentially takes ~300ms total warm, which is fine for a
   * diagnostics-only call. If this ever matters for UX, fold the six
   * counts into a single Postgres RPC instead.
   */
  async samskaraDiagnosticsCounts(threadId: string): Promise<{
    totalSamskaras: number;
    tier1Samskaras: number;
    tier2Samskaras: number;
    substrateInThread: number;
    firesInThread: number;
    associations: number;
  }> {
    const client = this.client;

    const totalR = await client
      .from('samskaras')
      .select('id', { count: 'exact', head: true });
    if (totalR.error) throw new SupabaseError(totalR.error.message);

    const t1R = await client
      .from('samskaras')
      .select('id', { count: 'exact', head: true })
      .eq('tier', 1);
    if (t1R.error) throw new SupabaseError(t1R.error.message);

    const t2R = await client
      .from('samskaras')
      .select('id', { count: 'exact', head: true })
      .eq('tier', 2);
    if (t2R.error) throw new SupabaseError(t2R.error.message);

    const subR = await client
      .from('samskara_substrate')
      .select('id', { count: 'exact', head: true })
      .eq('thread_id', threadId);
    if (subR.error) throw new SupabaseError(subR.error.message);

    const fireR = await client
      .from('samskara_fires')
      .select('id', { count: 'exact', head: true })
      .eq('thread_id', threadId);
    if (fireR.error) throw new SupabaseError(fireR.error.message);

    const assocR = await client
      .from('samskara_associations')
      .select('id', { count: 'exact', head: true });
    if (assocR.error) throw new SupabaseError(assocR.error.message);

    return {
      totalSamskaras: totalR.count ?? 0,
      tier1Samskaras: t1R.count ?? 0,
      tier2Samskaras: t2R.count ?? 0,
      substrateInThread: subR.count ?? 0,
      firesInThread: fireR.count ?? 0,
      associations: assocR.count ?? 0,
    };
  }
}

/**
 * Row shape returned by `samskara_fire_top_k`. The `score` column is
 * the ranked weight `cosine^1.3 * sqrt(health * confidence) *
 * sample-size bonus`; callers include it in the priming block so the
 * chat model can perceive the relative weight of each fired samskara.
 */
export interface SamskaraFireRow {
  id: string;
  prediction: string;
  inner_voice: string | null;
  valence: number | null;
  confidence: number;
  health: number;
  score: number;
}

/**
 * Substrate row shape for the relator phase. Includes the embedding
 * because the pair-discovery step needs to compute cosine in JS (see
 * samskaraRecentEmbeddedSubstrate above).
 */
export interface SamskaraSubstrateRow {
  id: string;
  situation: string;
  outcome: string | null;
  valence: number | null;
  situation_embedding: number[];
  created_at: string;
}

/**
 * Samskara row projection for the compound-summarizer agent. Avoids
 * shipping the 2048-dim embedding back just to throw it away.
 */
export interface SamskaraSummaryRow {
  id: string;
  tier: number;
  prediction: string;
  inner_voice: string | null;
  valence: number | null;
  confidence: number;
  health: number;
}

/**
 * Substrate row as shown in the diagnostics screen. Excludes the
 * embedding vector (too fat for a human-readable panel) and renames
 * to camelCase at the boundary so the component doesn't ship snake-
 * case identifiers into the UI.
 */
export interface SamskaraSubstrateDiagnosticRow {
  id: string;
  userMessageId: string;
  assistantMessageId: string | null;
  situation: string | null;
  outcome: string | null;
  valence: number | null;
  /** Set once the embedding has landed; also a de-facto "embedded?" flag. */
  embeddingModel: string | null;
  createdAt: string;
}

/**
 * Fire row with its joined samskara payload, for diagnostics
 * rendering. Grouping by `cohortId` is the renderer's job - the DB
 * query returns one row per (cohort_id, samskara_id) pair.
 */
export interface SamskaraFireDiagnosticRow {
  id: string;
  cohortId: string;
  samskaraId: string;
  score: number;
  firedAt: string;
  wasConfirmed: boolean | null;
  /** Null only when the samskara was deleted after the fire logged;
   *  the row keeps pointing to the now-orphaned id. */
  samskara: {
    tier: number;
    prediction: string;
    innerVoice: string | null;
    valence: number | null;
    confidence: number;
    health: number;
  } | null;
}
