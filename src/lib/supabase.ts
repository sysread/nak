/**
 * Supabase client wrapper — owns auth, threads, messages, and per-user
 * settings. Every call from the UI that touches the user's Supabase
 * project goes through SupabaseService.
 *
 * Security posture: we connect with the project's public **publishable key**,
 * not a service-role key. Row-Level Security (see `supabase/schema.sql`)
 * is the actual boundary — the publishable key only works for the signed-in
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
  isThinkingLevel,
  isVerbosity,
  type ModelTier,
  type ReasoningEffort,
  type ThinkingLevel,
  type Verbosity,
} from './models';
import { isAccent, isColorMode, type Accent, type ColorMode } from './theme';
import { isLogLevel, createLogger, type LogLevel } from './logger.svelte';

const log = createLogger('supabase');
import type { OpenAIToolCall } from './tools/types';
import type {
  ChatCompletion,
  ChatRequest,
  Citation,
  EmbeddingRequest,
  EmbeddingResponse,
  ImageGenRequest,
  ImageGenResult,
  TokenUsage,
} from './venice';
import {
  buildChatBody,
  COMPLETE_CHAT_RATE_LIMIT_FALLBACK_WAIT_MS,
  COMPLETE_CHAT_RATE_LIMIT_MAX_ATTEMPTS,
  COMPLETE_CHAT_RATE_LIMIT_WAIT_CAP_MS,
  parseChatCompletion,
  sleepCancellable,
  VeniceError,
} from './venice';
import {
  collectUsagePages,
  type UsageRequestOptions,
  type UsageRow,
  type UsagePageRequest,
  type UsagePageResult,
} from './usage';
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
   * Per-thread thinking-level override. Holds 'off' as well as
   * low/medium/high - 'off' resolves to disable_thinking on the wire,
   * the others to reasoning_effort (see ThinkingLevel / thinkingToWire
   * in ./models). Null/absent means fall through to the tier/user
   * default. Only consulted on reasoning-capable models; the composer
   * picker is hidden (and the field cleared on re-point) when the
   * resolved model can't reason. The column is still named
   * reasoning_effort for storage-compat - no migration needed since it
   * was already plain text with no CHECK.
   */
  reasoning_effort: ThinkingLevel | null;
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
   * Topic tags assigned by the background topics worker
   * (src/lib/agents/topics/*). Flat list; the drawer's topic-filter
   * dropdown uses these to narrow the conversation list by `topics &&`
   * predicate. Empty array means "untagged" - either the worker hasn't
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
    // parse/coerce - see src/lib/intuition/cache.ts. A drifting row
    // that doesn't match the expected shape is treated as "no cache"
    // there and a fresh refresh runs on the next trigger.
    intuition_payload: row.intuition_payload ?? null,
    // Same posture as intuition_payload: pass jsonb through unchanged.
    // The context-recall module owns the parse/coerce - see
    // src/lib/context-recall/cache.ts. A drifting row that doesn't match
    // the expected shape is treated as "no cache" there and a fresh
    // refresh runs on the next trigger.
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
  /**
   * Topic tags written by the memory-topics worker
   * (src/lib/agents/memory_topics/*). Empty array means "untagged" -
   * either the worker hasn't reached the row yet, the agent ran and
   * chose to emit nothing, or the user just edited the row (the
   * `clear_memory_topics_on_change` trigger nulls last_topics_at on
   * content change and the next worker cycle re-tags). The
   * UNTAGGED_TOPIC_SENTINEL is a UI-only primitive and never lands
   * in this column.
   */
  topics: string[];
  created_at: string;
  updated_at: string;
}

/**
 * One row of the memory changelog: a single content-affecting mutation
 * (create / update / delete, plus librarian consolidations recorded as
 * an 'update' on the survivor) captured at the time of the change.
 * `memory_id` is null when the underlying memory has since been
 * hard-deleted (the FK uses ON DELETE SET NULL); `label_at_change` is
 * the snapshot taken at write time so the row still reads meaningfully
 * without a join. See the matching table + RLS in
 * `supabase/schema.sql:memory_changelog`. Parallel to WikiChangelogEntry.
 */
export type MemoryChangelogKind = 'create' | 'update' | 'delete';
export interface MemoryChangelogEntry {
  id: string;
  memory_id: string | null;
  kind: MemoryChangelogKind;
  label_at_change: string;
  message: string;
  created_at: string;
}

function coerceMemoryChangelogKind(raw: unknown): MemoryChangelogKind | null {
  if (raw === 'create' || raw === 'update' || raw === 'delete') return raw;
  return null;
}

function coerceMemoryChangelogEntry(
  raw: Record<string, unknown>
): MemoryChangelogEntry | null {
  const id = raw.id;
  const kind = coerceMemoryChangelogKind(raw.kind);
  if (typeof id !== 'string' || !kind) return null;
  const memoryIdRaw = raw.memory_id;
  return {
    id,
    memory_id:
      typeof memoryIdRaw === 'string' && memoryIdRaw.length > 0
        ? memoryIdRaw
        : null,
    kind,
    label_at_change:
      typeof raw.label_at_change === 'string' ? raw.label_at_change : '',
    message: typeof raw.message === 'string' ? raw.message : '',
    created_at: String(raw.created_at ?? ''),
  };
}

/**
 * A memory plus its match score, returned by `search_memories_similar`.
 * `similarity` is the boosted-cosine value the RPC ranks on (raw cosine
 * times the bounded confidence boost), so it's monotonic with the result
 * order and can edge slightly above 1.0 for a near-identical, highly-
 * corroborated neighbour. The extra field is harmless where a plain
 * `Memory` is expected, so these rows feed `upsertMemoryRow` directly.
 */
export interface SimilarMemory extends Memory {
  similarity: number;
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
   * (`<user_id>/<attachment_id>/<filename>`), or `null` once the expiry
   * sweep has deleted the object (or for a legacy pre-bucket row).
   * Non-null iff the attachment is live.
   */
  storage_path: string | null;
  /**
   * Text extracted by Venice's /augment/text-parser at upload time for
   * non-image files. Stays populated after expiration — the value the
   * model saw outlives the original object.
   */
  extracted_text: string | null;
  /** Timestamp at which the object was deleted by the expiry sweep; null when live. */
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
 * Decode a base64 string to raw bytes for a Storage upload. Kept local
 * (rather than importing from `attachments.ts`) because that module
 * imports types from here - the dependency must not become a cycle.
 */
// TTL for recipe-image display signed URLs. Generous (6h) so a recipe
// detail / lightbox kept open through a session keeps rendering; a
// longer-open pane re-resolves on reload.
const RECIPE_IMAGE_SIGNED_URL_TTL_SECONDS = 60 * 60 * 6;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Map a `message_attachments` row (which may carry a joined `messages`
 * object from a thread-scoped lookup) to an Attachment, ignoring any
 * extra join columns.
 */
function coerceAttachmentRow(raw: Record<string, unknown>): Attachment {
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
  /**
   * Workflow flag - true when the user has marked this recipe as one
   * they plan to make during the current grocery-shopping cycle. Drives
   * the "Upcoming" section at the top of the drawer listing. Not
   * versioned (toggling does not write a recipe_versions row) and does
   * not bump `updated_at` so the recency sort stays stable.
   */
  upcoming: boolean;
  /**
   * Long-lived bookmark for recipes the user loves and wants one
   * click away. Independent of `upcoming` - a recipe can be either,
   * both, or neither. Drives the "Favorites" section just below
   * Upcoming in the drawer listing. Same non-versioned, non-
   * `updated_at`-bumping semantics as `upcoming`.
   */
  favorite: boolean;
  /**
   * Topic tags written by the recipe-topics worker
   * (src/lib/agents/recipe_topics/*). Empty array means "untagged" -
   * either the worker hasn't reached the row, the agent ran and
   * chose to emit nothing, or the user just edited title/cooklang
   * (the `clear_recipe_topics_on_change` trigger nulls
   * `last_topics_at` on content change and the next worker cycle
   * re-tags). The UNTAGGED_TOPIC_SENTINEL is a UI-only primitive
   * and never lands in this column. Cap of 6 tags per row vs the
   * 4 used on threads/memories - recipes legitimately span more
   * dimensions (primary ingredients + cuisine + course + technique).
   */
  topics: string[];
  created_at: string;
  updated_at: string;
  /** Populated only by `search_recipes_by_embedding`. */
  similarity?: number;
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
 * One photo on a recipe, ready to render. Loaded by the detail pane and
 * the edit form for thumbnail rendering and lightbox open. `url` is a
 * display-ready source resolved by `listRecipePhotos`: a short-lived
 * signed URL into the `recipe-images` bucket, or - for a legacy row not
 * yet moved by the migrate button - a `data:` URI built from the base64
 * fallback. The component renders `url` directly and stays synchronous.
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
  url: string;
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
 * One topical article in the user's wiki. Flat list (no nesting), one
 * article per `(user_id, title)` (the schema enforces uniqueness so the
 * autonomous agent's `wiki_create` can fall through to `wiki_update` on
 * conflict). Articles are written in encyclopedic third-person prose
 * and are never auto-injected into the chat - the main LLM reaches
 * them only through the always-on `wiki_search` tool.
 */
export interface WikiArticle {
  id: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
  /** Populated only by `searchWikiArticlesByEmbedding`. */
  similarity?: number;
}

function coerceWikiArticle(raw: Record<string, unknown>): WikiArticle {
  return {
    id: String(raw.id),
    title: typeof raw.title === 'string' ? raw.title : '',
    content: typeof raw.content === 'string' ? raw.content : '',
    created_at: String(raw.created_at ?? raw.updated_at ?? ''),
    updated_at: String(raw.updated_at ?? raw.created_at ?? ''),
    similarity:
      typeof raw.similarity === 'number' ? (raw.similarity as number) : undefined,
  };
}

/**
 * One row of the bibliography shown beneath a wiki article: a thread
 * that contributed to the article, with the thread's title and the
 * timestamp this attribution was last refreshed (re-processing the
 * same thread bumps this rather than inserting a duplicate row).
 *
 * Surfaced via `listWikiArticleSources`; populated by the wiki tools
 * themselves when an article is created or updated (autonomous agent
 * attaches the current thread; librarian passes `source_thread_ids`
 * explicitly through the tool boundary).
 */
export interface WikiArticleSource {
  thread_id: string;
  /** May be null when the thread has been hard-deleted but the
   *  attribution row hasn't been cascade-cleaned yet. The UI renders
   *  a placeholder title in that window. */
  thread_title: string | null;
  first_processed_at: string;
  last_processed_at: string;
}

/**
 * One row of the See Also section beneath a wiki article. Returned
 * by the `find_related_wiki_articles` RPC, which uses the dynamic
 * similarity floor (the minimum cosine similarity between the target
 * article and its source conversations) to decide which candidates
 * clear the bar.
 */
export interface WikiArticleRelated {
  id: string;
  title: string;
  similarity: number;
}

/**
 * One row of the wiki changelog: a single create / update / delete
 * recorded at the time of the mutation. `article_id` is null when the
 * underlying article has since been deleted (the FK uses ON DELETE SET
 * NULL); `title_at_change` is the snapshot taken at write time so the
 * row still reads meaningfully without a join. See the matching table
 * + RLS in `supabase/schema.sql:wiki_changelog`.
 */
export type WikiChangelogKind = 'create' | 'update' | 'delete';
export interface WikiChangelogEntry {
  id: string;
  article_id: string | null;
  kind: WikiChangelogKind;
  title_at_change: string;
  message: string;
  created_at: string;
}

function coerceWikiChangelogKind(raw: unknown): WikiChangelogKind | null {
  if (raw === 'create' || raw === 'update' || raw === 'delete') return raw;
  return null;
}

function coerceWikiChangelogEntry(
  raw: Record<string, unknown>
): WikiChangelogEntry | null {
  const id = raw.id;
  const kind = coerceWikiChangelogKind(raw.kind);
  if (typeof id !== 'string' || !kind) return null;
  const articleIdRaw = raw.article_id;
  return {
    id,
    article_id:
      typeof articleIdRaw === 'string' && articleIdRaw.length > 0
        ? articleIdRaw
        : null,
    kind,
    title_at_change:
      typeof raw.title_at_change === 'string' ? raw.title_at_change : '',
    message: typeof raw.message === 'string' ? raw.message : '',
    created_at: String(raw.created_at ?? ''),
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

class SupabaseError extends Error {
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
 * Sentinel value the drawer's topic-filter dropdown uses to mean "rows
 * whose `topics` column is empty." It's not a real topic - the worker
 * never emits this string - but threading it through the selectedTopics
 * array lets the OR-of-checkboxes UI stay one shape (a list of strings)
 * instead of growing a second "untagged also?" boolean. The pageThreads
 * / search builders treat the sentinel specially and turn it into
 * `topics = '{}'` rather than an `&&` membership test.
 *
 * The leading "(" is illegal in any real topic (the worker prompt forbids
 * it and the agent's parse strips punctuation anyway), so the sentinel
 * can never collide with a model-emitted topic.
 */
export const UNTAGGED_TOPIC_SENTINEL = '(untagged)';

/**
 * One row of a topic-vocabulary listing: a topic name plus how many of
 * the user's items (threads / memories / recipes, depending on the RPC)
 * carry it. `count` is the number the topic dropdown shows in parens.
 */
export interface TopicCount {
  topic: string;
  count: number;
}

/**
 * Return shape of the three `list_user_*_topics` RPCs. `topics` is the
 * alphabetised real-topic vocabulary with per-topic corpus counts;
 * `untagged` is how many items have no topics at all (backs the
 * synthesised "(untagged)" dropdown row). Counts are corpus-wide on
 * purpose - the memory and thread lists are paginated/capped client-
 * side, so a client tally would undercount.
 */
export interface TopicVocabulary {
  topics: TopicCount[];
  untagged: number;
}

/**
 * Coerce the jsonb a `list_user_*_topics` RPC returns into a
 * `TopicVocabulary`. This is a system boundary (the Supabase wire), so
 * it validates rather than trusting the shape: a missing/garbage field
 * collapses to the empty vocabulary instead of throwing, keeping the
 * dropdown usable across a malformed response.
 */
function parseTopicVocabulary(data: unknown): TopicVocabulary {
  if (!data || typeof data !== 'object') return { topics: [], untagged: 0 };
  const obj = data as { topics?: unknown; untagged?: unknown };
  const topics = Array.isArray(obj.topics)
    ? obj.topics.flatMap((entry): TopicCount[] => {
        if (!entry || typeof entry !== 'object') return [];
        const { topic, count } = entry as { topic?: unknown; count?: unknown };
        if (typeof topic !== 'string') return [];
        return [{ topic, count: typeof count === 'number' ? count : 0 }];
      })
    : [];
  const untagged = typeof obj.untagged === 'number' ? obj.untagged : 0;
  return { topics, untagged };
}

/**
 * Split a selectedTopics list into the two predicates the query
 * builder needs: real topics for the `&&` overlap test, plus a
 * boolean for "also include rows with no topics at all". Centralised
 * so the three list paths (recent / older / archived) and the search
 * path stay in lockstep on the sentinel.
 */
function partitionSelectedTopics(selected: readonly string[]): {
  topics: string[];
  includeUntagged: boolean;
} {
  let includeUntagged = false;
  const topics: string[] = [];
  for (const t of selected) {
    if (t === UNTAGGED_TOPIC_SENTINEL) includeUntagged = true;
    else topics.push(t);
  }
  return { topics, includeUntagged };
}

/**
 * PostgREST `or(...)` clause matching the active topic filter. Returns
 * null when no filter is active (caller skips the predicate entirely),
 * or a string suitable for `.or()` otherwise. The two halves:
 *
 *   - "topics && {a,b}" — at least one of the selected real topics is
 *     in the row's array. PostgREST encodes array literals as
 *     {a,b,c}.
 *   - "topics.eq.{}" — the row has no topics at all (the
 *     "(untagged)" sentinel was selected).
 *
 * An OR of the two is the union the drawer's checkbox semantics
 * promise. When only one half is active we emit only that half, which
 * keeps the URL shorter and the query plan less branchy.
 *
 * `cs` (contains) vs `ov` (overlap): `ov` is the array-overlap
 * operator (`&&`) which is what we want for OR semantics across
 * multiple topics. `cs` would require ALL of the listed topics to be
 * present, which is AND semantics.
 */
function topicsFilterClause(selected: readonly string[]): string | null {
  if (selected.length === 0) return null;
  const { topics, includeUntagged } = partitionSelectedTopics(selected);
  const parts: string[] = [];
  if (topics.length > 0) {
    // PostgREST array literal: {a,b,c}. Topic strings are alphanumeric
    // by the agent prompt (no commas, no braces) so no escaping is
    // needed; if a stray punctuation char ever sneaks in, PostgREST's
    // own quoting would reject the query before it reached the DB
    // rather than mis-parse it.
    parts.push(`topics.ov.{${topics.join(',')}}`);
  }
  if (includeUntagged) {
    // Empty-array equality: a row whose topics column is `'{}'`. This
    // is what "untagged" means in the UI.
    parts.push('topics.eq.{}');
  }
  // Single predicate doesn't need an or() wrapper at the caller, but
  // the .or() builder accepts a single comma-free clause too.
  return parts.join(',');
}

/**
 * Build a double-quoted ILIKE pattern for a user-supplied substring query
 * that rides INSIDE a `.or('col.ilike.<pattern>,...')` (or `.and(…)`) logic
 * tree. Do NOT use it for a standalone `.ilike(col, value)` filter - see
 * `ilikeFilterPattern` for why the quoting is wrong there.
 *
 * PostgREST's `.or(…)` grammar treats commas as condition separators and
 * parens as grouping. An unquoted comma in the value (e.g. a chatty
 * recall query like "...simmering liquid, so they'll...") splits the
 * value into a second, malformed condition and the whole request fails
 * with "failed to parse logic tree". Backslash-escaping those chars does
 * NOT work - the parser does not honour the backslash, so the comma
 * still terminates the value - the only correct carrier is to wrap the
 * whole value in double quotes. Inside a quoted value a literal
 * double-quote or backslash must itself be backslash-escaped.
 *
 * The surrounding `%` are intentional substring wildcards and live
 * inside the quotes; ILIKE sees them after PostgREST strips the quotes
 * (quote-stripping only happens inside a logic tree). A `%` or `_` typed
 * by the user stays a wildcard, matching the prior behaviour.
 */
function ilikeLogicTreePattern(query: string): string {
  const escaped = query.replace(/(["\\])/g, '\\$1');
  return `"%${escaped}%"`;
}

/**
 * Build an ILIKE substring pattern for a STANDALONE `.ilike(col, value)`
 * filter. Plain `%query%`, no quoting, no escaping.
 *
 * supabase-js sends the value as its own URL-encoded query parameter, read
 * verbatim to the end of that parameter, so the comma/paren reserved-char
 * problem that forces quoting in a `.or(…)` logic tree simply does not
 * exist here. Crucially, PostgREST strips surrounding double quotes ONLY
 * inside a logic tree, not in a standalone horizontal filter - so reusing
 * the quoted `ilikeLogicTreePattern` here makes ILIKE hunt for literal
 * double-quote characters in the title, and a query like "Joy" stops
 * matching a recipe titled "Joy's Favorite Bread" (returns an empty list).
 * The `%`/`_` the user types stay wildcards by design.
 */
function ilikeFilterPattern(query: string): string {
  return `%${query}%`;
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
 * One page of an offset-paginated browse listing (recipes, memories,
 * wiki articles). `hasMore` is derived from a `pageSize + 1` probe -
 * the query asks for one extra row and the method strips it, so the
 * caller learns there's a next page without a second count query.
 *
 * Why offset and not the keyset cursors the thread drawer uses
 * (ThreadCursor / ThreadPage): threads bump their `updated_at`
 * constantly under the realtime feed, so a keyset cursor is the only
 * way to page them without dropping or duplicating a row that moved
 * across the boundary mid-scroll. The cookbook / memory / wiki lists
 * are personal, low-write collections that nobody is mutating while
 * you scroll them, so offset is safe - and it pages an arbitrary
 * ORDER BY (the recipe sort picker's rating-nulls-last and
 * alphabetical modes) without the composite-cursor predicate a keyset
 * scheme would need for each sort key.
 */
export interface OffsetPage<T> {
  rows: T[];
  hasMore: boolean;
}

/** Default page size for the offset-paginated browse listings. */
export const DEFAULT_LIST_PAGE_SIZE = 50;

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
/**
 * The project-global shared config row (the `app_config` table). One row
 * per Supabase project, readable by every authenticated member - distinct
 * from {@link UserSettings}, which is the per-user profiles.settings blob.
 * Seeded by `mise run supabase-init`; see
 * docs/dev/in-progress/venice-edge-functions/.
 */
export interface ServerConfig {
  /** Shared Venice API key, or null when app_config hasn't been seeded. */
  veniceApiKey: string | null;
}

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
   * IANA timezone the model sees when reasoning about "what time is
   * it for the user" in the per-turn metadata system message, and
   * the zone the wiki worker uses to bucket day-eligible threads.
   * "America/New_York", "Europe/London", etc. Seeded on first
   * Settings visit from
   * `Intl.DateTimeFormat().resolvedOptions().timeZone`; the user
   * overrides from Settings -> AI -> About you. Absent means "fall
   * back to the browser's current zone at read time"; callers must
   * handle `undefined` rather than assume a server default so a
   * user roaming across time zones never silently lands entries on
   * the wrong day.
   */
  displayTimezone?: string;
  /**
   * User wiki feature: when true, the background wiki agent processes
   * settled threads (one calendar day after the newest message in the
   * user's tz) and updates / creates encyclopedic articles about
   * topics the conversation surfaced. Default-on semantics: absent
   * means on; only present when the user has explicitly disabled.
   * False stops the manager from starting the worker at unlock and
   * stops it mid-session when flipped. Manual edits and the
   * per-article "ask agent to update" button are unaffected by this
   * flag.
   */
  wikiAutomaticEnabled?: boolean;
  /**
   * Wiki librarian: when true, a separate background agent runs every
   * ~12 hours, reads the full wiki, and consolidates duplicates +
   * fact-checks against conversation history. Independent of
   * `wikiAutomaticEnabled` so the user can disable per-conversation
   * autonomy while still getting periodic reorganisation, or vice
   * versa. Default-on like the other wiki toggle.
   */
  wikiLibrarianEnabled?: boolean;
  /**
   * Memory librarian: when true, the deep-sleep and rem background
   * agents run on their staggered 12h cadences, consolidating
   * cross-thread duplicate memories and populating the relations
   * graph. Independent of the wiki librarian; default-on like the
   * other librarian toggles. See src/lib/agents/deep-sleep and
   * src/lib/agents/rem.
   */
  memoryLibrarianEnabled?: boolean;
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
const USER_PROFILE_FIELD_MAX = 200;

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
  if (typeof r.wikiAutomaticEnabled === 'boolean') {
    out.wikiAutomaticEnabled = r.wikiAutomaticEnabled;
  }
  if (typeof r.wikiLibrarianEnabled === 'boolean') {
    out.wikiLibrarianEnabled = r.wikiLibrarianEnabled;
  }
  if (typeof r.memoryLibrarianEnabled === 'boolean') {
    out.memoryLibrarianEnabled = r.memoryLibrarianEnabled;
  }
  // displayTimezone is the canonical key. We also read the legacy
  // `journalTimezone` key so a profile written before the rename
  // lands keeps its setting on first read; the next updateSettings
  // call writes the new key and the legacy one falls out of the
  // blob naturally because nothing writes it any more.
  const tzCandidate =
    typeof r.displayTimezone === 'string' && r.displayTimezone.length > 0
      ? r.displayTimezone
      : typeof r.journalTimezone === 'string' && r.journalTimezone.length > 0
        ? r.journalTimezone
        : null;
  if (tzCandidate !== null && tzCandidate.length < 128) {
    // Character set loose on purpose - IANA zones are
    // `Continent/City` plus aliases, and we don't want to re-implement
    // the zone list client-side. The 128-char ceiling is a defensive
    // cap so a malformed blob can't balloon.
    out.displayTimezone = tzCandidate;
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

/**
 * Translate a supabase-js functions.invoke error (from any venice-function
 * route) into a VeniceError. A FunctionsHttpError carries the function's
 * Response on `.context`; we read the status and the function's normalized
 * { error } body off it so the caller surfaces the real failure and a 429 still
 * reads as rate_limit. Anything without a Response context (a relay or transport
 * failure) becomes a network error.
 */
async function veniceFunctionError(error: unknown): Promise<VeniceError> {
  const ctx = (error as { context?: unknown }).context;
  if (ctx instanceof Response) {
    let payload: { error?: string; kind?: string; retryAfterMs?: number | null } = {};
    try {
      payload = await ctx.clone().json();
    } catch {
      // Non-JSON error body - fall back to the status line.
    }
    const message = payload.error ?? `venice function request failed (HTTP ${ctx.status})`;
    const kind = ctx.status === 429 ? 'rate_limit' : 'http';
    // The /complete route relays Venice's Retry-After / x-ratelimit-reset-*
    // hint through the JSON body since the headers themselves don't survive
    // the functions.invoke round trip. Carry the parsed window onto the
    // VeniceError so the browser's retry loop can act on it.
    const retryAfterMs =
      typeof payload.retryAfterMs === 'number' ? payload.retryAfterMs : null;
    return new VeniceError(message, kind, ctx.status, retryAfterMs);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new VeniceError(`Network error contacting the venice function: ${message}`, 'network');
}

/**
 * A persistent reference document in the user's Library. Mirrors the
 * `public.documents` table. The original file lives in the `documents`
 * Storage bucket (pointed at by `storage_path`); `extracted_text` is the
 * Venice text-parser output that gets chunked + embedded for search.
 */
export interface Document {
  id: string;
  title: string;
  description: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string | null;
  extracted_text: string | null;
  extraction_status: 'pending' | 'done' | 'failed';
  extraction_error: string | null;
  created_at: string;
  updated_at: string;
}

function coerceDocument(raw: Record<string, unknown>): Document {
  const status = raw.extraction_status;
  return {
    id: String(raw.id),
    title: typeof raw.title === 'string' ? raw.title : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    filename: typeof raw.filename === 'string' ? raw.filename : '',
    mime_type: typeof raw.mime_type === 'string' ? raw.mime_type : '',
    size_bytes: typeof raw.size_bytes === 'number' ? raw.size_bytes : Number(raw.size_bytes ?? 0),
    storage_path: typeof raw.storage_path === 'string' ? raw.storage_path : null,
    extracted_text: typeof raw.extracted_text === 'string' ? raw.extracted_text : null,
    extraction_status:
      status === 'done' || status === 'failed' ? status : 'pending',
    extraction_error: typeof raw.extraction_error === 'string' ? raw.extraction_error : null,
    created_at: String(raw.created_at ?? raw.updated_at ?? ''),
    updated_at: String(raw.updated_at ?? raw.created_at ?? ''),
  };
}

/**
 * One hit from `grep_documents`: a matching line with its location and a few
 * lines of context on either side.
 */
export interface DocumentGrepHit {
  document_id: string;
  title: string;
  line_number: number;
  line_text: string;
  context_before: string[];
  context_after: string[];
}

function coerceDocumentGrepHit(raw: Record<string, unknown>): DocumentGrepHit {
  const toLines = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : String(x ?? ''))) : [];
  return {
    document_id: String(raw.document_id),
    title: typeof raw.title === 'string' ? raw.title : '',
    line_number: typeof raw.line_number === 'number' ? raw.line_number : Number(raw.line_number ?? 0),
    line_text: typeof raw.line_text === 'string' ? raw.line_text : '',
    context_before: toLines(raw.context_before),
    context_after: toLines(raw.context_after),
  };
}

/**
 * `document_stat` output: a document's metadata plus its total line count,
 * fetched without shipping the extracted text. Powers the `doc_get` tool.
 */
export interface DocumentStat {
  id: string;
  title: string;
  description: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  extraction_status: 'pending' | 'done' | 'failed';
  extraction_error: string | null;
  has_text: boolean;
  total_lines: number;
  created_at: string;
  updated_at: string;
}

function coerceDocumentStat(raw: Record<string, unknown>): DocumentStat {
  const status = raw.extraction_status;
  return {
    id: String(raw.id),
    title: typeof raw.title === 'string' ? raw.title : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    filename: typeof raw.filename === 'string' ? raw.filename : '',
    mime_type: typeof raw.mime_type === 'string' ? raw.mime_type : '',
    size_bytes: typeof raw.size_bytes === 'number' ? raw.size_bytes : Number(raw.size_bytes ?? 0),
    extraction_status: status === 'done' || status === 'failed' ? status : 'pending',
    extraction_error: typeof raw.extraction_error === 'string' ? raw.extraction_error : null,
    has_text: raw.has_text === true,
    total_lines: typeof raw.total_lines === 'number' ? raw.total_lines : Number(raw.total_lines ?? 0),
    created_at: String(raw.created_at ?? raw.updated_at ?? ''),
    updated_at: String(raw.updated_at ?? raw.created_at ?? ''),
  };
}

export class SupabaseService {
  readonly client: SupabaseClient;

  /**
   * `opts.client` is the dependency-injection hatch used by the background
   * worker fleet (the Web Workers under src/lib/agents/). Each worker builds
   * its own `SupabaseClient` with `persistSession: false` + a manually-pinned
   * session, because workers have no localStorage and shouldn't fight the
   * main-thread client for the session store. The default path (no `opts`)
   * preserves the original main-thread behavior.
   */
  constructor(
    config: Pick<AppConfig, 'supabaseUrl' | 'supabasePublishableKey'>,
    opts: { client?: SupabaseClient } = {}
  ) {
    this.client =
      opts.client ??
      createClient(config.supabaseUrl, config.supabasePublishableKey, {
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

  // Rotate the Supabase auth (login) password. Supabase's updateUser
  // endpoint does NOT require the current password - any holder of a
  // valid session token could otherwise rotate it. To match what users
  // expect from a "change password" form (and to block a stolen-tab
  // attack against an unlocked session), re-verify the current password
  // by re-signing in first. The re-signin issues a fresh session for
  // the same user, which is harmless.
  async changeAuthPassword(currentPassword: string, newPassword: string): Promise<void> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const email = session.user.email;
    if (!email) {
      throw new SupabaseError(
        'This account has no email on file, so the password cannot be changed here.',
      );
    }
    const reauth = await this.client.auth.signInWithPassword({
      email,
      password: currentPassword,
    });
    if (reauth.error) {
      throw new SupabaseError('Current password is incorrect.');
    }
    const { error } = await this.client.auth.updateUser({ password: newPassword });
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
   * Read the project-global shared config row (app_config). Returns null
   * when the row has not been seeded yet (mise run supabase-init). RLS lets
   * any authenticated member read it; see
   * docs/dev/in-progress/venice-edge-functions/. Distinct from getSettings,
   * which reads the per-user profiles.settings blob.
   */
  async getAppConfig(): Promise<ServerConfig | null> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data, error } = await this.client
      .from('app_config')
      .select('venice_api_key')
      .eq('id', true)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    if (!data) return null;
    const key = (data as { venice_api_key?: string | null }).venice_api_key;
    return { veniceApiKey: typeof key === 'string' && key.length > 0 ? key : null };
  }

  /**
   * Fetch Venice billing usage through the `venice` edge function. The browser
   * no longer holds a Venice key for this path - the function reads the shared
   * key server-side and proxies one page per call. The paging loop lives in
   * src/lib/usage.ts (not server-side) precisely so it can drive the Usage
   * pane's per-page progress indicator. The session JWT rides along on
   * functions.invoke and the gateway's verify_jwt gates the call; failures
   * surface as VeniceError so the pane renders the same error shape it always
   * has.
   */
  async fetchUsage(opts: UsageRequestOptions = {}): Promise<UsageRow[]> {
    return collectUsagePages((req) => this.fetchUsagePage(req), opts);
  }

  private async fetchUsagePage(req: UsagePageRequest): Promise<UsagePageResult> {
    const { data, error } = await this.client.functions.invoke('venice/usage', {
      body: req,
    });
    if (error) throw await veniceFunctionError(error);
    const body = (data ?? {}) as { data?: unknown; totalPages?: unknown };
    return {
      rows: Array.isArray(body.data) ? body.data : [],
      totalPages: typeof body.totalPages === 'number' ? body.totalPages : 1,
    };
  }

  /**
   * Generate an embedding through the venice edge function's /embed route,
   * replacing the browser's direct Venice call. The function reads the shared
   * key server-side; this keeps the same { model, input } request and
   * { data: [{ embedding }] } response shape the old VeniceClient.embed had, so
   * callers only swap the handle. Note: req.signal is not propagated -
   * functions.invoke has no abort hook - so a superseded search's embed is
   * discarded by the caller's own staleness guard rather than aborted; an embed
   * is a quick call, so the wasted request is cheap.
   */
  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const { data, error } = await this.client.functions.invoke('venice/embed', {
      body: { model: req.model, input: req.input },
    });
    if (error) throw await veniceFunctionError(error);
    return (data ?? { data: [] }) as EmbeddingResponse;
  }

  /**
   * Extract readable text from a user-uploaded file through the venice edge
   * function's /text-parser route. Routes around the CORS rejection that hits
   * any browser-direct call to Venice's /augment/text-parser (Venice CORS-
   * enables chat/image/embeddings, not text-parser - the user saw "Failed to
   * fetch" on every non-image attachment). The function holds the shared key
   * server-side; this method packages the file as multipart/form-data and
   * surfaces failures through the same VeniceError contract the call sites
   * already render. Returns the parsed text on success.
   *
   * functions.invoke handles FormData natively (it leaves Content-Type unset
   * so the runtime writes the multipart boundary), so the wire shape matches
   * what Venice's endpoint expects.
   */
  async extractText(file: Blob, filename: string): Promise<string> {
    const form = new FormData();
    form.append('file', file, filename);
    const { data, error } = await this.client.functions.invoke('venice/text-parser', {
      body: form,
    });
    if (error) throw await veniceFunctionError(error);
    const text = (data as { text?: unknown } | null)?.text;
    if (typeof text !== 'string') {
      throw new VeniceError(
        'Venice text-parser response did not contain a text field.',
        'parse'
      );
    }
    return text;
  }

  /**
   * Generate an image through the venice edge function's /image-generate
   * route. The function holds the shared key server-side and pins the
   * variants=1 / return_binary=false defaults so the response is a single
   * base64 image ready for the message_attachments row the chat-loop creates.
   *
   * The camel-cased ImageGenRequest shape is preserved on the wire; the Deno
   * helper does the snake_case translation Venice expects. req.signal is not
   * propagated (functions.invoke has no abort hook), so an aborted generation
   * still spends Venice credits - the chat-loop's tool-side handling treats
   * the discarded result the same as a model-side retry.
   */
  /**
   * Non-streaming chat completion through the venice edge function's
   * /complete route. The browser builds Venice's wire-shape body via
   * buildChatBody and forwards it; the function holds the shared key
   * server-side and relays Venice's response (or error) verbatim. The
   * 429 retry loop stays browser-side: completeChat sits behind tool
   * sub-calls and background agents with no UI feedback, so a
   * propagated 429 lands silently in a tool-result row or a swallowed
   * agent failure - being a bit patient here trades a few seconds of
   * latency for not burning a turn.
   *
   * Retry-After: Venice's hint travels through the function's 429
   * response body (retryAfterMs) since the underlying header does not
   * survive the functions.invoke round trip. Fallback when the hint is
   * absent: a log10-spaced 1s -> 5s schedule, hard-capped at 60s.
   * req.signal aborts both the in-flight invoke (when supabase-js
   * supports it) and the inter-attempt sleep.
   *
   * Streaming chat completion still talks to Venice directly from
   * src/lib/chat-loop.ts; the streaming attractor is the next driver-B
   * milestone.
   */
  async complete(req: ChatRequest): Promise<ChatCompletion> {
    const body = buildChatBody(req, false);
    let attempt = 0;
    while (true) {
      let payload: unknown;
      try {
        const { data, error } = await this.client.functions.invoke('venice/complete', {
          body,
        });
        if (error) throw await veniceFunctionError(error);
        payload = data;
      } catch (err) {
        if (!(err instanceof VeniceError)) throw err;
        const retriesExhausted = attempt >= COMPLETE_CHAT_RATE_LIMIT_MAX_ATTEMPTS - 1;
        if (
          err.kind !== 'rate_limit' ||
          retriesExhausted ||
          req.signal?.aborted === true
        ) {
          throw err;
        }
        const hint = err.retryAfterMs;
        const fallbackIdx = Math.min(
          attempt,
          COMPLETE_CHAT_RATE_LIMIT_FALLBACK_WAIT_MS.length - 1
        );
        const baseMs = hint ?? COMPLETE_CHAT_RATE_LIMIT_FALLBACK_WAIT_MS[fallbackIdx];
        const waitMs = Math.min(baseMs, COMPLETE_CHAT_RATE_LIMIT_WAIT_CAP_MS);
        log.info(
          `complete rate-limited (attempt ${attempt + 1}/${COMPLETE_CHAT_RATE_LIMIT_MAX_ATTEMPTS}); waiting ${waitMs}ms before retry`
        );
        const interrupted = await sleepCancellable(waitMs, req.signal);
        if (interrupted) {
          // Aborted during the sleep. Throw a spec-shaped AbortError so
          // callers' existing AbortError branches fire - same path a
          // mid-fetch abort would have taken.
          const abortErr = new Error('Aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        attempt += 1;
        continue;
      }
      return parseChatCompletion(payload);
    }
  }

  async generateImage(req: ImageGenRequest): Promise<ImageGenResult> {
    const { data, error } = await this.client.functions.invoke('venice/image-generate', {
      body: {
        model: req.model,
        prompt: req.prompt,
        negativePrompt: req.negativePrompt,
        stylePreset: req.stylePreset,
        width: req.width,
        height: req.height,
        seed: req.seed,
        steps: req.steps,
        cfgScale: req.cfgScale,
        safeMode: req.safeMode,
        hideWatermark: req.hideWatermark,
        format: req.format,
      },
    });
    if (error) throw await veniceFunctionError(error);
    const result = data as { imageBase64?: unknown; mimeType?: unknown } | null;
    const imageBase64 = result?.imageBase64;
    const mimeType = result?.mimeType;
    if (typeof imageBase64 !== 'string' || typeof mimeType !== 'string') {
      throw new VeniceError(
        'Venice image response did not contain image data.',
        'parse'
      );
    }
    return { imageBase64, mimeType };
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
    if ('wikiAutomaticEnabled' in patch) {
      if (patch.wikiAutomaticEnabled === undefined) {
        delete merged.wikiAutomaticEnabled;
      } else if (typeof patch.wikiAutomaticEnabled === 'boolean') {
        merged.wikiAutomaticEnabled = patch.wikiAutomaticEnabled;
      }
    }
    if ('wikiLibrarianEnabled' in patch) {
      if (patch.wikiLibrarianEnabled === undefined) {
        delete merged.wikiLibrarianEnabled;
      } else if (typeof patch.wikiLibrarianEnabled === 'boolean') {
        merged.wikiLibrarianEnabled = patch.wikiLibrarianEnabled;
      }
    }
    if ('memoryLibrarianEnabled' in patch) {
      if (patch.memoryLibrarianEnabled === undefined) {
        delete merged.memoryLibrarianEnabled;
      } else if (typeof patch.memoryLibrarianEnabled === 'boolean') {
        merged.memoryLibrarianEnabled = patch.memoryLibrarianEnabled;
      }
    }
    if ('displayTimezone' in patch) {
      if (patch.displayTimezone === undefined) delete merged.displayTimezone;
      else if (
        typeof patch.displayTimezone === 'string' &&
        patch.displayTimezone.length > 0 &&
        patch.displayTimezone.length < 128
      ) {
        merged.displayTimezone = patch.displayTimezone;
      }
      // Clear the legacy key in the same merge so a profile written
      // before the rename doesn't keep ghosting the old value
      // alongside the canonical one.
      delete (merged as { journalTimezone?: string }).journalTimezone;
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
  async listRecentThreads(
    cutoff: string,
    selectedTopics: readonly string[] = []
  ): Promise<Thread[]> {
    // Everything touched within the "active" window — hardcoded by the
    // caller so the boundary doesn't drift second-to-second and flip
    // threads at the edge between Recent and Older as seconds tick by.
    // Two-column ordering mirrors listOlderThreads so a thread the
    // user just updated doesn't hop position when it transitions.
    let q = this.client
      .from('threads')
      .select('*')
      .eq('archived', false)
      .gte('updated_at', cutoff)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(500);
    const topicsClause = topicsFilterClause(selectedTopics);
    if (topicsClause) q = q.or(topicsClause);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceThread(row as Record<string, unknown>));
  }

  async listOlderThreads(opts: {
    cutoff: string;
    cursor: ThreadCursor | null;
    pageSize?: number;
    selectedTopics?: readonly string[];
  }): Promise<ThreadPage> {
    return this.pageThreads({
      archived: false,
      cutoff: opts.cutoff,
      cursor: opts.cursor,
      pageSize: opts.pageSize ?? DEFAULT_THREAD_PAGE_SIZE,
      selectedTopics: opts.selectedTopics ?? [],
    });
  }

  async listArchivedThreads(opts: {
    cursor: ThreadCursor | null;
    pageSize?: number;
    selectedTopics?: readonly string[];
  }): Promise<ThreadPage> {
    return this.pageThreads({
      archived: true,
      cutoff: null,
      cursor: opts.cursor,
      pageSize: opts.pageSize ?? DEFAULT_THREAD_PAGE_SIZE,
      selectedTopics: opts.selectedTopics ?? [],
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
    selectedTopics?: readonly string[];
  }): Promise<Thread[]> {
    let q = this.client
      .from('threads')
      .select('*')
      .eq('archived', opts.archived)
      .gte('updated_at', opts.target.updated_at)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false });
    if (opts.cutoff) q = q.lt('updated_at', opts.cutoff);
    const topicsClause = topicsFilterClause(opts.selectedTopics ?? []);
    if (topicsClause) q = q.or(topicsClause);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceThread(row as Record<string, unknown>));
  }

  private async pageThreads(opts: {
    archived: boolean;
    cutoff: string | null;
    cursor: ThreadCursor | null;
    pageSize: number;
    selectedTopics: readonly string[];
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
    const topicsClause = topicsFilterClause(opts.selectedTopics);
    if (topicsClause) q = q.or(topicsClause);
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
    /**
     * When non-empty, search results are narrowed to the same topic
     * filter the drawer's date-sorted list uses. Exact (ILIKE) hits
     * are filtered server-side via the same `topicsFilterClause`
     * helper the list paths use; semantic hits come back from the
     * embedding RPC without topic columns, so we re-fetch the matched
     * rows and filter in memory rather than touching the RPC signature.
     * Matches the "topic filter constrains search too" UX decision -
     * see docs/dev/topics.md.
     */
    selectedTopics?: readonly string[];
  }): Promise<ThreadSearchHit[]> {
    const query = opts.query.trim();
    if (query.length === 0) return [];
    const limit = opts.limit ?? 50;
    const selectedTopics = opts.selectedTopics ?? [];
    const topicsClause = topicsFilterClause(selectedTopics);

    const pattern = ilikeFilterPattern(query);
    let exactQ = this.client
      .from('threads')
      .select('*')
      .ilike('title', pattern)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);
    if (topicsClause) exactQ = exactQ.or(topicsClause);
    const exactPromise = exactQ;

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

    // When a topic filter is active, narrow semantic hits to rows
    // matching the same predicate. The embedding RPC doesn't read
    // `topics`, so we do this client-side: fetch the matched rows'
    // topics columns by id, then drop any that don't satisfy the
    // filter. The fetch is one round trip with at most `limit` rows
    // so the overhead is small (and only paid when a filter is
    // active). When no filter is active we skip the round trip
    // entirely and the existing path runs unchanged.
    let allowedSemanticIds: Set<string> | null = null;
    if (selectedTopics.length > 0 && semanticRows.length > 0) {
      const ids = semanticRows.map((r) => r.id);
      const { topics: realTopics, includeUntagged } =
        partitionSelectedTopics(selectedTopics);
      const { data: topicRows, error: topicErr } = await this.client
        .from('threads')
        .select('id, topics')
        .in('id', ids);
      if (topicErr) throw new SupabaseError(topicErr.message);
      allowedSemanticIds = new Set<string>();
      const realSet = new Set(realTopics);
      for (const r of (topicRows ?? []) as { id: string; topics: unknown }[]) {
        const rowTopics = Array.isArray(r.topics)
          ? r.topics.filter((v): v is string => typeof v === 'string')
          : [];
        if (rowTopics.length === 0 && includeUntagged) {
          allowedSemanticIds.add(r.id);
          continue;
        }
        if (realSet.size > 0 && rowTopics.some((t) => realSet.has(t))) {
          allowedSemanticIds.add(r.id);
        }
      }
    }

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
      if (allowedSemanticIds && !allowedSemanticIds.has(row.id)) continue;
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
          context_recall_payload: null,
          topics: [],
          response_holder_id: null,
          response_claim_expires_at: null,
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
    reasoningEffort: ThinkingLevel | null = null,
    verbosity: Verbosity | null = null,
    titleManuallySet = false,
    toolboxesEnabled: string[] = []
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
        // Carries the draft's toolbox selections through to the
        // persisted row. The composer toolbox button is available
        // before a draft materializes, so a user may have enabled
        // toolboxes before the first send - without this passthrough
        // those flips would silently reset to [] on materialization.
        toolboxes_enabled: toolboxesEnabled,
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
    reasoningEffort: ThinkingLevel | null
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
   * Persist the cached context-recall payload. Sibling of
   * setThreadIntuitionPayload and shares its discipline: no
   * updated_at bump (subconscious priming shouldn't promote the
   * thread in the sidebar), loose typing because the canonical
   * shape lives in src/lib/context-recall/types.ts.
   */
  async setThreadContextRecallPayload(
    threadId: string,
    payload: unknown
  ): Promise<void> {
    const { error } = await this.client
      .from('threads')
      .update({ context_recall_payload: payload })
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
   *
   * `selectedTopics` narrows the result set to rows whose `topics`
   * column overlaps the selection (or is empty, if the UI-only
   * UNTAGGED_TOPIC_SENTINEL is included). Empty array means "no filter
   * active" - the LLM-facing memory_search tool passes nothing here
   * because the model has no topic-selection UI, so its calls keep the
   * pre-filter behaviour exactly.
   */
  async searchMemories(
    query: string,
    limit: number,
    selectedTopics: readonly string[] = []
  ): Promise<Memory[]> {
    let q = this.client
      .from('memories')
      .select('id, label, data, confidence, topics, created_at, updated_at')
      .order('updated_at', { ascending: false })
      .limit(limit);
    if (query && query.length > 0) {
      const pattern = ilikeLogicTreePattern(query);
      q = q.or(`label.ilike.${pattern},data.ilike.${pattern}`);
    }
    const topicsClause = topicsFilterClause(selectedTopics);
    if (topicsClause) q = q.or(topicsClause);
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
      .select('id, label, data, confidence, topics, created_at, updated_at')
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
      .select('id, label, data, confidence, topics, created_at, updated_at')
      .single();
    if (error) throw new SupabaseError(error.message);
    return row as Memory;
  }

  async deleteMemory(id: string): Promise<void> {
    const { error } = await this.client.from('memories').delete().eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Fetch a single memory by id, or null when it doesn't exist (or is
   * owned by another user - RLS filters those rows out, so a not-found
   * and a not-owned are indistinguishable here, which is the intended
   * privacy posture). Used by the changelog write paths that need a
   * `label_at_change` snapshot before a destructive mutation: the
   * delete tool (snapshot before the row is gone) and the consolidate
   * tool (snapshot the loser's label for the merge message).
   */
  async getMemoryById(id: string): Promise<Memory | null> {
    const { data, error } = await this.client
      .from('memories')
      .select('id, label, data, confidence, topics, created_at, updated_at')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    return (data as Memory | null) ?? null;
  }

  /**
   * Append a memory-changelog row. Called by every content-affecting
   * memory write path: the create/update/delete tools, the user's
   * direct edits in Memories.svelte, and the librarian's consolidate.
   * Throws on a failed insert so callers can decide whether to surface
   * or swallow it - the tool/UI paths currently swallow (the mutation
   * already landed; a missed changelog row is a smaller harm than a
   * confusing post-success error).
   *
   * `memory_id` is null for hard deletes (the memory is already gone by
   * the time this lands). For create/update/consolidate it points at
   * the live memory; if that memory is later deleted the FK cascades to
   * null but `label_at_change` keeps the row meaningful.
   */
  async createMemoryChangelogEntry(args: {
    memory_id: string | null;
    kind: MemoryChangelogKind;
    label_at_change: string;
    message: string;
  }): Promise<void> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const label = args.label_at_change.trim();
    const message = args.message.trim();
    if (label.length === 0 || message.length === 0) return;
    const { error } = await this.client.from('memory_changelog').insert({
      user_id: session.user.id,
      memory_id: args.memory_id,
      kind: args.kind,
      label_at_change: label,
      message,
    });
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Paged listing of the memory changelog, newest first. `before` is the
   * exclusive cursor in `created_at desc` order - pass the last entry's
   * `created_at` from the prior page to fetch the next one. The
   * (user_id, created_at desc) index makes this a range scan rather than
   * a sort, so the panel can lazy-load deep history cheaply.
   */
  async listMemoryChangelog(opts: {
    limit?: number;
    before?: string | null;
  } = {}): Promise<MemoryChangelogEntry[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    let q = this.client
      .from('memory_changelog')
      .select('id, memory_id, kind, label_at_change, message, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (opts.before) q = q.lt('created_at', opts.before);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    const out: MemoryChangelogEntry[] = [];
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const entry = coerceMemoryChangelogEntry(row);
      if (entry) out.push(entry);
    }
    return out;
  }

  /**
   * One offset page of the memory browse list (most-recent first).
   * Powers the sidebar's infinite scroll for the empty-query case;
   * an active search still goes through `searchMemories` (capped, not
   * paged) so relevance order stays intact. `id` is the final tiebreak
   * so rows colliding on `updated_at` keep a stable cross-page order.
   * `selectedTopics` is filtered server-side - a partial page must be
   * narrowed before it's sliced.
   */
  async listMemoriesPage(opts: {
    offset: number;
    pageSize: number;
    selectedTopics?: readonly string[];
  }): Promise<OffsetPage<Memory>> {
    let q = this.client
      .from('memories')
      .select('id, label, data, confidence, topics, created_at, updated_at')
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false });
    const topicsClause = topicsFilterClause(opts.selectedTopics ?? []);
    if (topicsClause) q = q.or(topicsClause);
    q = q.range(opts.offset, opts.offset + opts.pageSize);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as Memory[];
    const hasMore = rows.length > opts.pageSize;
    return { rows: hasMore ? rows.slice(0, opts.pageSize) : rows, hasMore };
  }

  // recipes --------------------------------------------------------------
  //
  // Same RLS posture as memories: every query is scoped to the signed-in
  // user automatically; only inserts need an explicit user_id because the
  // with_check policy has no default to fall back on.
  //
  // Embedding pipeline: the cookbook stays small enough that the LLM
  // tool path (`recipe_list`, `recipe_search`) gets by on ILIKE alone,
  // but the human-facing drawer search (`RecipeList.svelte`) wires
  // through the shared embeddings worker so a fuzzy query ("fluffy
  // potato side") can find a recipe by meaning rather than title
  // substring. Same claim/save/search RPC trio as the wiki source.

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
        'id, title, source, source_url, cooklang, rating, upcoming, favorite, topics, created_at, updated_at'
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
      q = q.ilike('title', ilikeFilterPattern(query));
    }
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as Recipe[];
  }

  /**
   * One offset page of the "All recipes" browse list. Powers the
   * sidebar's infinite scroll: the empty-query listing pages through
   * the whole cookbook instead of truncating at a fixed cap.
   *
   * `sort` matches the sidebar picker. Each mode ends with `id` as a
   * final tiebreak so rows that collide on the primary key (two
   * recipes with the same rating + updated_at) keep a stable order
   * across page boundaries - without it an offset window could drop or
   * repeat a colliding row.
   *
   * `selectedTopics` is applied server-side (the older client-side
   * filter only worked because the whole cookbook was in memory; a
   * partial page has to be filtered before it's sliced or the page
   * count would be wrong).
   */
  async listRecipesPage(opts: {
    offset: number;
    pageSize: number;
    sort: 'updated' | 'rating' | 'alphabetical';
    selectedTopics?: readonly string[];
  }): Promise<OffsetPage<Recipe>> {
    let q = this.client
      .from('recipes')
      .select(
        'id, title, source, source_url, cooklang, rating, upcoming, favorite, topics, created_at, updated_at'
      );
    if (opts.sort === 'rating') {
      q = q
        .order('rating', { ascending: false, nullsFirst: false })
        .order('updated_at', { ascending: false })
        .order('id', { ascending: false });
    } else if (opts.sort === 'alphabetical') {
      // Ordered by the column's collation rather than a JS
      // localeCompare so the server's page boundaries match what the
      // client renders - paginating an arbitrary client-side sort would
      // shuffle rows across the seam.
      // TODO: untitled drafts (empty title) sort to the head under a
      // raw `title ASC`, where the user expects them at the tail of an
      // A-Z list, and the collation's case/accent handling may diverge
      // from the dictionary order users expect. Both want a sort key
      // the offset window can page deterministically.
      q = q.order('title', { ascending: true }).order('id', { ascending: true });
    } else {
      q = q
        .order('updated_at', { ascending: false })
        .order('id', { ascending: false });
    }
    const topicsClause = topicsFilterClause(opts.selectedTopics ?? []);
    if (topicsClause) q = q.or(topicsClause);
    // Inclusive range: ask for pageSize + 1 rows so a full extra row
    // signals "another page exists" without a separate count query.
    q = q.range(opts.offset, opts.offset + opts.pageSize);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as Recipe[];
    const hasMore = rows.length > opts.pageSize;
    return { rows: hasMore ? rows.slice(0, opts.pageSize) : rows, hasMore };
  }

  /**
   * Every recipe flagged `upcoming` (the current grocery cycle).
   * Fetched whole rather than paged - the flagged subset is small and
   * the sidebar renders it as a complete bucket above the paginated
   * "All recipes" list, so a partial page would misrepresent it. The
   * topic filter stays client-side over this complete set.
   */
  async listUpcomingRecipes(): Promise<Recipe[]> {
    const { data, error } = await this.client
      .from('recipes')
      .select(
        'id, title, source, source_url, cooklang, rating, upcoming, favorite, topics, created_at, updated_at'
      )
      .eq('upcoming', true)
      .order('updated_at', { ascending: false });
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as Recipe[];
  }

  /** Every recipe flagged `favorite`. Same complete-bucket rationale as listUpcomingRecipes. */
  async listFavoriteRecipes(): Promise<Recipe[]> {
    const { data, error } = await this.client
      .from('recipes')
      .select(
        'id, title, source, source_url, cooklang, rating, upcoming, favorite, topics, created_at, updated_at'
      )
      .eq('favorite', true)
      .order('updated_at', { ascending: false });
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as Recipe[];
  }

  async getRecipe(id: string): Promise<Recipe | null> {
    const { data, error } = await this.client
      .from('recipes')
      .select(
        'id, title, source, source_url, cooklang, rating, upcoming, favorite, topics, created_at, updated_at'
      )
      .eq('id', id)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    return (data as Recipe | null) ?? null;
  }

  /**
   * Semantic + substring search over recipes. Same merge contract as
   * `searchWikiArticles`: vector hits first (RPC, ordered by cosine
   * similarity), then ILIKE hits the vector
   * pass missed, deduped by id and capped at `limit`. Empty `query`
   * falls back to `listRecipes` (most-recently-updated first) so
   * callers don't need to special-case the no-query branch.
   * `queryEmbedding` may be null - callers without Venice get ILIKE-
   * only results.
   *
   * The ILIKE side runs on title only; the semantic side has the
   * full `title + source + cooklang` blob folded into the embedding
   * by the worker, so a meaning match can reach ingredient or
   * technique text the title alone misses.
   */
  async searchRecipes(opts: {
    query: string;
    queryEmbedding: number[] | null;
    limit?: number;
  }): Promise<Recipe[]> {
    const query = opts.query.trim();
    const limit = opts.limit ?? 50;
    if (query.length === 0) return this.listRecipes('', limit);

    const pattern = ilikeFilterPattern(query);

    const ilikePromise = this.client
      .from('recipes')
      .select(
        'id, title, source, source_url, cooklang, rating, upcoming, favorite, topics, created_at, updated_at'
      )
      .ilike('title', pattern)
      .order('updated_at', { ascending: false })
      .limit(limit);

    const semanticPromise = opts.queryEmbedding
      ? this.client.rpc('search_recipes_by_embedding', {
          query_embedding: opts.queryEmbedding,
          match_limit: limit,
        })
      : Promise.resolve({ data: [] as unknown[], error: null });

    const [ilikeRes, semRes] = await Promise.all([ilikePromise, semanticPromise]);
    if (ilikeRes.error) throw new SupabaseError(ilikeRes.error.message);
    const ilikeRows = ((ilikeRes.data ?? []) as unknown[]) as Recipe[];
    const semanticRows: Recipe[] =
      semRes.error !== null ? [] : (((semRes.data ?? []) as unknown[]) as Recipe[]);

    const out: Recipe[] = [];
    const seen = new Set<string>();
    for (const r of semanticRows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      if (out.length >= limit) return out;
    }
    for (const r of ilikeRows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      if (out.length >= limit) return out;
    }
    return out;
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

  /**
   * Toggle the workflow `upcoming` flag. Direct table update on
   * purpose - upcoming is not recipe content, so it bypasses the
   * version-writing RPC. We intentionally do not touch `updated_at`
   * either: marking a recipe as upcoming should not bump it to the
   * top of the recency sort, because the user is bookmarking it for
   * a near-future cook, not editing it.
   */
  async setRecipeUpcoming(id: string, upcoming: boolean): Promise<void> {
    const { error } = await this.client
      .from('recipes')
      .update({ upcoming })
      .eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Toggle the `favorite` flag. Same non-versioned, non-`updated_at`-
   * bumping semantics as `setRecipeUpcoming` - favorite is a personal
   * bookmark, not recipe content, so it skips `recipe_versions` and
   * does not reshuffle the recency sort.
   */
  async setRecipeFavorite(id: string, favorite: boolean): Promise<void> {
    const { error } = await this.client
      .from('recipes')
      .update({ favorite })
      .eq('id', id);
    if (error) throw new SupabaseError(error.message);
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
    // Upload the bytes to the content-addressed key first (idempotent:
    // same sha -> same object, upsert:true), then record the row. The
    // object existing before the row means a reader never sees a row
    // pointing at a missing object.
    const storagePath = await this.uploadRecipeImageObject(sha256, dataBase64, mimeType);
    const { data, error } = await this.client.rpc('recipe_image_upsert', {
      p_sha256: sha256,
      p_mime_type: mimeType,
      p_size_bytes: sizeBytes,
      p_storage_path: storagePath,
    });
    if (error) throw new SupabaseError(error.message);
    if (typeof data !== 'string') {
      throw new SupabaseError('image upsert returned no id');
    }
    return data;
  }

  /**
   * Upload image bytes to the `recipe-images` bucket at the content-
   * addressed key `<user_id>/<sha256>`. Idempotent (upsert:true), so a
   * re-upload of the same image is a harmless overwrite. Returns the
   * object key. Shared by upsertRecipeImage and the one-time migrate.
   */
  async uploadRecipeImageObject(
    sha256: string,
    dataBase64: string,
    mimeType: string
  ): Promise<string> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const path = `${session.user.id}/${sha256}`;
    const { error } = await this.client.storage
      .from('recipe-images')
      .upload(path, base64ToBytes(dataBase64), { contentType: mimeType, upsert: true });
    if (error) throw new SupabaseError(error.message);
    return path;
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
        'id, recipe_version_images(position, label, recipe_images(id, mime_type, size_bytes, storage_path))'
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
      storage_path: string | null;
    };
    type LinkRow = {
      position: number;
      label: string | null;
      recipe_images: ImageEmbed | ImageEmbed[] | null;
    };
    const links = (data as unknown as { recipe_version_images?: LinkRow[] | null })
      .recipe_version_images;
    if (!Array.isArray(links)) return [];

    // Collect the rows first, then batch-resolve signed URLs for the
    // bucket objects in a single Storage call.
    const rows: Array<{ img: ImageEmbed; position: number; label: string | null }> = [];
    for (const l of links) {
      const img = Array.isArray(l.recipe_images) ? l.recipe_images[0] : l.recipe_images;
      if (!img) continue;
      rows.push({ img, position: l.position, label: l.label ?? null });
    }

    const paths = rows
      .map((r) => r.img.storage_path)
      .filter((p): p is string => typeof p === 'string');
    const signed = new Map<string, string>();
    if (paths.length > 0) {
      const { data: signedData, error: signErr } = await this.client.storage
        .from('recipe-images')
        .createSignedUrls(paths, RECIPE_IMAGE_SIGNED_URL_TTL_SECONDS);
      if (signErr) throw new SupabaseError(signErr.message);
      for (const entry of signedData ?? []) {
        if (entry.signedUrl && typeof entry.path === 'string') {
          signed.set(entry.path, entry.signedUrl);
        }
      }
    }

    const photos: RecipePhoto[] = [];
    for (const { img, position, label } of rows) {
      const url = (img.storage_path && signed.get(img.storage_path)) || '';
      if (!url) continue; // no bucket object (or signing failed) - skip
      photos.push({
        id: img.id,
        position,
        mime_type: img.mime_type,
        size_bytes: img.size_bytes,
        url,
        label,
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

  // User wiki -------------------------------------------------------------

  /**
   * Alphabetical listing of every wiki article for the current user.
   * Sort key is `lower(title)` so case differences ("Apple" vs
   * "apple") fold together. Limit defaults to 500, matching memories
   * - a single user is unlikely to author thousands of
   * encyclopedic articles, and pagination would complicate the
   * client-side store filtering pattern.
   */
  async listWikiArticles(opts: { limit?: number } = {}): Promise<WikiArticle[]> {
    const { data, error } = await this.client
      .from('wiki_articles')
      .select('id, title, content, created_at, updated_at')
      .order('title', { ascending: true })
      .limit(opts.limit ?? 500);
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceWikiArticle(row as Record<string, unknown>));
  }

  /**
   * One offset page of the wiki browse list, alphabetical by title.
   * Powers the sidebar's infinite scroll for the empty-query case; an
   * active search still goes through `searchWikiArticles` (capped, not
   * paged). `id` is the final tiebreak so articles colliding on title
   * keep a stable cross-page order.
   *
   * Ordering is the DB collation's `title ASC`, so the sidebar renders
   * server order verbatim rather than re-sorting with a JS
   * `localeCompare` - a client re-sort over a partial page would
   * disagree with the server's page boundaries and shuffle rows across
   * the seam mid-scroll.
   */
  async listWikiArticlesPage(opts: {
    offset: number;
    pageSize: number;
  }): Promise<OffsetPage<WikiArticle>> {
    const { data, error } = await this.client
      .from('wiki_articles')
      .select('id, title, content, created_at, updated_at')
      .order('title', { ascending: true })
      .order('id', { ascending: true })
      .range(opts.offset, opts.offset + opts.pageSize);
    if (error) throw new SupabaseError(error.message);
    const all = (data ?? []).map((row) =>
      coerceWikiArticle(row as Record<string, unknown>)
    );
    const hasMore = all.length > opts.pageSize;
    return { rows: hasMore ? all.slice(0, opts.pageSize) : all, hasMore };
  }

  async getWikiArticleById(id: string): Promise<WikiArticle | null> {
    const { data, error } = await this.client
      .from('wiki_articles')
      .select('id, title, content, created_at, updated_at')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    if (!data) return null;
    return coerceWikiArticle(data as Record<string, unknown>);
  }

  /**
   * Title-keyed lookup. The autonomous agent uses this to resolve a
   * candidate title to an existing article id when `wiki_create`
   * raised a unique-violation - the agent then calls `wiki_update`
   * against the resolved id.
   */
  async getWikiArticleByTitle(title: string): Promise<WikiArticle | null> {
    const { data, error } = await this.client
      .from('wiki_articles')
      .select('id, title, content, created_at, updated_at')
      .eq('title', title)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    if (!data) return null;
    return coerceWikiArticle(data as Record<string, unknown>);
  }

  async createWikiArticle(args: {
    title: string;
    content: string;
  }): Promise<WikiArticle> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data, error } = await this.client
      .from('wiki_articles')
      .insert({
        user_id: session.user.id,
        title: args.title,
        content: args.content,
      })
      .select('id, title, content, created_at, updated_at')
      .single();
    if (error) throw new SupabaseError(error.message);
    return coerceWikiArticle(data as Record<string, unknown>);
  }

  /**
   * Patch an article's title or content. RLS owner-scopes the update.
   * The schema trigger `clear_wiki_embedding_on_change` nulls the
   * embedding + claim columns when title or content changes so the
   * worker re-embeds on its next poll.
   */
  async updateWikiArticle(
    id: string,
    patch: { title?: string; content?: string }
  ): Promise<WikiArticle> {
    const { data, error } = await this.client
      .from('wiki_articles')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, title, content, created_at, updated_at')
      .single();
    if (error) throw new SupabaseError(error.message);
    return coerceWikiArticle(data as Record<string, unknown>);
  }

  async deleteWikiArticle(id: string): Promise<void> {
    const { error } = await this.client.from('wiki_articles').delete().eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  // Documents (Library) --------------------------------------------------
  //
  // Upload flow is two-phase on purpose: createDocument writes the metadata
  // row first (status 'pending', storage_path null), then the caller uploads
  // the binary to the bucket and calls setDocumentStoragePath, then extracts
  // text in the browser and calls setDocumentExtraction.
  // Splitting it this way means a row always exists for the UI to show a
  // "processing" placeholder, and a crash mid-upload leaves a recoverable
  // pending row rather than an orphaned bucket object.

  async createDocument(args: {
    title: string;
    description?: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<Document> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data, error } = await this.client
      .from('documents')
      .insert({
        user_id: session.user.id,
        title: args.title,
        description: args.description ?? '',
        filename: args.filename,
        mime_type: args.mimeType,
        size_bytes: args.sizeBytes,
      })
      .select(
        'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
      )
      .single();
    if (error) throw new SupabaseError(error.message);
    return coerceDocument(data as Record<string, unknown>);
  }

  async setDocumentStoragePath(id: string, storagePath: string): Promise<void> {
    const { error } = await this.client
      .from('documents')
      .update({ storage_path: storagePath })
      .eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Record the outcome of the browser-side text extraction. On success pass
   * the extracted text and status 'done'; on failure pass status 'failed' and
   * a trimmed error so the Library UI can explain why the doc isn't
   * searchable. The original file stays downloadable either way.
   */
  async setDocumentExtraction(
    id: string,
    result:
      | { status: 'done'; text: string }
      | { status: 'failed'; error: string }
  ): Promise<void> {
    const patch: Record<string, unknown> =
      result.status === 'done'
        ? { extraction_status: 'done', extracted_text: result.text, extraction_error: null }
        : { extraction_status: 'failed', extraction_error: result.error.slice(0, 500) };
    const { error } = await this.client.from('documents').update(patch).eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  async listDocuments(opts: { limit?: number } = {}): Promise<Document[]> {
    const { data, error } = await this.client
      .from('documents')
      .select(
        'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
      )
      .order('created_at', { ascending: false })
      .limit(opts.limit ?? 500);
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceDocument(row as Record<string, unknown>));
  }

  /**
   * One offset page of the Library list, newest first. Powers the drawer's
   * infinite scroll. `id` is the final tiebreak so docs sharing a created_at
   * keep a stable cross-page order.
   */
  async listDocumentsPage(opts: {
    offset: number;
    pageSize: number;
  }): Promise<OffsetPage<Document>> {
    const { data, error } = await this.client
      .from('documents')
      .select(
        'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
      )
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(opts.offset, opts.offset + opts.pageSize);
    if (error) throw new SupabaseError(error.message);
    const all = (data ?? []).map((row) => coerceDocument(row as Record<string, unknown>));
    const hasMore = all.length > opts.pageSize;
    return { rows: hasMore ? all.slice(0, opts.pageSize) : all, hasMore };
  }

  async getDocumentById(id: string): Promise<Document | null> {
    const { data, error } = await this.client
      .from('documents')
      .select(
        'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
      )
      .eq('id', id)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    if (!data) return null;
    return coerceDocument(data as Record<string, unknown>);
  }

  /**
   * Substring search over the user's documents for the Library drawer, newest
   * first. Matches the query against title, description, filename, and the
   * extracted body, so a document surfaces whether the user typed its name or a
   * phrase from inside it. This is the drawer's browse-by-keyword surface; the
   * chat model's precise in-document search is grep_documents (doc_grep).
   */
  async searchDocuments(opts: { query: string; limit?: number }): Promise<Document[]> {
    const query = opts.query.trim();
    if (query.length === 0) return [];
    const pattern = ilikeLogicTreePattern(query);
    const { data, error } = await this.client
      .from('documents')
      .select(
        'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
      )
      .or(
        `title.ilike.${pattern},description.ilike.${pattern},filename.ilike.${pattern},extracted_text.ilike.${pattern}`
      )
      .order('created_at', { ascending: false })
      .limit(opts.limit ?? 100);
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceDocument(row as Record<string, unknown>));
  }

  /**
   * Patch a document's user-editable metadata (title, description). The
   * extracted body is bound to the original file and is not editable here -
   * replacing content means re-uploading the file.
   */
  async updateDocument(
    id: string,
    patch: { title?: string; description?: string }
  ): Promise<Document> {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.title !== undefined) update.title = patch.title;
    if (patch.description !== undefined) update.description = patch.description;
    const { data, error } = await this.client
      .from('documents')
      .update(update)
      .eq('id', id)
      .select(
        'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
      )
      .single();
    if (error) throw new SupabaseError(error.message);
    return coerceDocument(data as Record<string, unknown>);
  }

  /**
   * Delete a document, its chunks (FK cascade), and its original file in the
   * bucket. The bucket object is removed first; if that fails we still throw
   * before deleting the row, so we never orphan a bucket object behind a
   * deleted row. A leftover row whose object is already gone is the safer
   * failure direction (the UI can retry the delete).
   */
  async deleteDocument(id: string): Promise<void> {
    const doc = await this.getDocumentById(id);
    if (doc?.storage_path) {
      const { error: rmErr } = await this.client.storage
        .from('documents')
        .remove([doc.storage_path]);
      if (rmErr) throw new SupabaseError(rmErr.message);
    }
    const { error } = await this.client.from('documents').delete().eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  // Documents Storage helpers --------------------------------------------

  /**
   * Upload an original file to the private `documents` bucket. The object key
   * convention `<user_id>/<document_id>/<filename>` is what the bucket RLS
   * policy keys on (top-level folder must equal auth.uid()).
   */
  async uploadDocumentFile(args: {
    documentId: string;
    filename: string;
    file: Blob;
    contentType: string;
  }): Promise<string> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const path = `${session.user.id}/${args.documentId}/${args.filename}`;
    const { error } = await this.client.storage
      .from('documents')
      .upload(path, args.file, { contentType: args.contentType, upsert: true });
    if (error) throw new SupabaseError(error.message);
    return path;
  }

  /**
   * Time-limited signed URL for downloading an original file. The bucket is
   * private, so this is the only way the browser surfaces the binary.
   */
  async createDocumentDownloadUrl(storagePath: string, expiresInSeconds = 300): Promise<string> {
    const { data, error } = await this.client.storage
      .from('documents')
      .createSignedUrl(storagePath, expiresInSeconds);
    if (error) throw new SupabaseError(error.message);
    return data.signedUrl;
  }

  // Documents grep / read helpers ----------------------------------------
  //
  // The deterministic grep-then-read pair the chat model uses on a document.
  // Both run server-side over documents.extracted_text (see grep_documents /
  // read_document_lines in schema.sql) so a multi-MB document's text never
  // crosses the wire - only matching snippets or the requested line range come
  // back.

  /**
   * Regex search over a document's text (or every document the user owns when
   * `documentId` is omitted), with line numbers and context. An invalid regex
   * surfaces as a SupabaseError the calling tool rephrases.
   */
  async grepDocument(opts: {
    pattern: string;
    documentId?: string | null;
    caseSensitive?: boolean;
    context?: number;
    maxMatches?: number;
  }): Promise<DocumentGrepHit[]> {
    const { data, error } = await this.client.rpc('grep_documents', {
      p_pattern: opts.pattern,
      p_document_id: opts.documentId ?? null,
      p_case_sensitive: opts.caseSensitive ?? false,
      p_context: opts.context ?? 2,
      p_max_matches: opts.maxMatches ?? 50,
    });
    if (error) throw new SupabaseError(error.message);
    return ((data ?? []) as unknown[]).map((row) =>
      coerceDocumentGrepHit(row as Record<string, unknown>)
    );
  }

  /**
   * Read a contiguous line range of a document, numbered, plus the document's
   * total line count. Empty `lines` means the range was out of bounds or the
   * document isn't the caller's (RLS); `totalLines` is 0 in that case.
   */
  async readDocumentLines(
    documentId: string,
    start: number,
    end: number
  ): Promise<{ lines: { line_number: number; content: string }[]; totalLines: number }> {
    const { data, error } = await this.client.rpc('read_document_lines', {
      p_document_id: documentId,
      p_start: start,
      p_end: end,
    });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    const lines = rows.map((r) => ({
      line_number: typeof r.line_number === 'number' ? r.line_number : Number(r.line_number ?? 0),
      content: typeof r.content === 'string' ? r.content : '',
    }));
    const totalLines = rows.length > 0 ? Number(rows[0].total_lines ?? 0) : 0;
    return { lines, totalLines };
  }

  /**
   * Metadata + total line count for one document, without fetching its text.
   * Returns null for an unknown id or one the caller doesn't own.
   */
  async getDocumentStat(id: string): Promise<DocumentStat | null> {
    const { data, error } = await this.client.rpc('document_stat', { p_document_id: id });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    if (rows.length === 0) return null;
    return coerceDocumentStat(rows[0]);
  }

  /**
   * Attribute one or more source conversations to a wiki article.
   * Upsert semantics on the composite (article_id, thread_id) primary
   * key: a thread already attributed gets its `last_processed_at`
   * bumped rather than producing a duplicate row.
   *
   * Called by the wiki tools after a successful create/update:
   *   - autonomous agent: passes its current threadId (singular).
   *   - librarian: passes the `source_thread_ids` parameter the
   *     model supplied, after filtering through `findExistingThreadIds`
   *     so a hallucinated id can't land.
   *
   * Empty / all-invalid input is a silent no-op (no round-trip).
   */
  async attachWikiArticleSources(
    articleId: string,
    threadIds: readonly string[]
  ): Promise<void> {
    if (threadIds.length === 0) return;
    const seen = new Set<string>();
    const rows: Array<{
      article_id: string;
      thread_id: string;
      last_processed_at: string;
    }> = [];
    const now = new Date().toISOString();
    for (const id of threadIds) {
      if (typeof id !== 'string' || id.length === 0) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({ article_id: articleId, thread_id: id, last_processed_at: now });
    }
    if (rows.length === 0) return;
    const { error } = await this.client
      .from('wiki_article_sources')
      .upsert(rows, { onConflict: 'article_id,thread_id' });
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Return the bibliography for one article: every thread that has
   * been attributed, joined with the thread's title, ordered by
   * `last_processed_at` ascending so the reader sees the article's
   * narrative of growth (oldest contributing conversation first).
   *
   * Threads hard-deleted out from under their attribution rows show
   * up with a null title until the cascade catches up; the UI handles
   * that with a placeholder.
   */
  async listWikiArticleSources(articleId: string): Promise<WikiArticleSource[]> {
    const { data, error } = await this.client
      .from('wiki_article_sources')
      .select('thread_id, first_processed_at, last_processed_at, threads(title)')
      .eq('article_id', articleId)
      .order('last_processed_at', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    const out: WikiArticleSource[] = [];
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const threadId = row.thread_id;
      if (typeof threadId !== 'string') continue;
      const thread = row.threads as { title?: unknown } | null;
      const title =
        thread && typeof thread.title === 'string' ? thread.title : null;
      out.push({
        thread_id: threadId,
        thread_title: title,
        first_processed_at: String(row.first_processed_at ?? ''),
        last_processed_at: String(row.last_processed_at ?? ''),
      });
    }
    return out;
  }

  /**
   * Batched source-thread lookup for a candidate set of article ids.
   * Returns a Map keyed by article id whose value is the set of thread
   * ids that fed that article. Articles with no rows in
   * `wiki_article_sources` are absent from the map (orphan articles -
   * never written from a recorded conversation).
   *
   * Powers the `wiki_search` sole-source exclusion (see ToolContext's
   * `wikiExcludeOwnThreadSoleSources`): the recall path needs to know
   * "is the current thread the ONLY source of this article?", which is
   * cheaper to answer against an in-memory map of all sources for the
   * returned candidates than as a per-article round-trip. Empty input
   * returns an empty Map without a round-trip.
   */
  async listSourceThreadIdsForArticles(
    articleIds: readonly string[]
  ): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    if (articleIds.length === 0) return out;
    const { data, error } = await this.client
      .from('wiki_article_sources')
      .select('article_id, thread_id')
      .in('article_id', [...articleIds]);
    if (error) throw new SupabaseError(error.message);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const articleId = row.article_id;
      const threadId = row.thread_id;
      if (typeof articleId !== 'string' || typeof threadId !== 'string') continue;
      const set = out.get(articleId);
      if (set) set.add(threadId);
      else out.set(articleId, new Set([threadId]));
    }
    return out;
  }

  /**
   * See Also for an article. Single RPC call; the floor calculation
   * (minimum cosine similarity between the article and its source
   * conversations) lives server-side so the client never has to fetch
   * raw embeddings.
   *
   * Returns an empty array when the article has no embedding yet (the
   * embeddings worker hasn't caught up after a content change),
   * when no other articles clear the floor, or when there are simply
   * no other articles. All three are honest "nothing to suggest".
   */
  async findRelatedWikiArticles(
    articleId: string,
    limit = 5
  ): Promise<WikiArticleRelated[]> {
    const { data, error } = await this.client.rpc('find_related_wiki_articles', {
      p_article_id: articleId,
      p_limit: limit,
    });
    if (error) throw new SupabaseError(error.message);
    const out: WikiArticleRelated[] = [];
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const id = row.id;
      const title = row.title;
      const similarity = row.similarity;
      if (typeof id !== 'string' || typeof title !== 'string') continue;
      out.push({
        id,
        title,
        similarity: typeof similarity === 'number' ? similarity : 0,
      });
    }
    return out;
  }

  /**
   * Append a wiki-changelog row. Called by every wiki write path: the
   * three tools (`wiki_create`/`wiki_update`/`wiki_delete`), the
   * librarian's same three tools, and the user's direct edits in
   * Wiki.svelte. Throws on a failed insert so callers can decide
   * whether to surface the error or swallow it - the tool path
   * currently swallows (the mutation already landed; a missed
   * changelog row is a smaller harm than a confusing post-success
   * error).
   *
   * `article_id` is null for deletes (the article is already gone by
   * the time this lands). For create/update it points at the live
   * article; if the article is later deleted the FK cascades to null
   * but `title_at_change` keeps the row meaningful.
   */
  async createWikiChangelogEntry(args: {
    article_id: string | null;
    kind: WikiChangelogKind;
    title_at_change: string;
    message: string;
  }): Promise<void> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const title = args.title_at_change.trim();
    const message = args.message.trim();
    if (title.length === 0 || message.length === 0) return;
    const { error } = await this.client.from('wiki_changelog').insert({
      user_id: session.user.id,
      article_id: args.article_id,
      kind: args.kind,
      title_at_change: title,
      message,
    });
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Paged listing of the wiki changelog, newest first. `before` is the
   * exclusive cursor in `created_at desc` order - pass the last entry's
   * `created_at` from the prior page to fetch the next one. The
   * (user_id, created_at desc) index makes this a one-row-per-page
   * range scan rather than a sort, so the modal can lazy-load deep
   * history cheaply.
   */
  async listWikiChangelog(opts: {
    limit?: number;
    before?: string | null;
  } = {}): Promise<WikiChangelogEntry[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    let q = this.client
      .from('wiki_changelog')
      .select('id, article_id, kind, title_at_change, message, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (opts.before) q = q.lt('created_at', opts.before);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    const out: WikiChangelogEntry[] = [];
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const entry = coerceWikiChangelogEntry(row);
      if (entry) out.push(entry);
    }
    return out;
  }

  /**
   * Nuke the wiki subsystem for the current user. Deletes every
   * `wiki_articles` row and nulls `last_wiki_processed_msg_id` + the
   * wiki claim columns on the user's threads so the per-conversation
   * agent re-evaluates from scratch. Wraps both statements in a single
   * server-side transaction (see `reset_wiki_data` in schema.sql) so
   * the articles and the per-thread pipeline state stay in lockstep.
   *
   * Callers (Settings -> Wiki -> Reset) MUST gate this behind an
   * explicit user confirmation - it's irreversible.
   */
  async resetWikiData(): Promise<void> {
    const { error } = await this.client.rpc('reset_wiki_data');
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Semantic + substring search over wiki articles. Vector hits first
   * (RPC), then unembedded ILIKE hits, deduped by id. Empty `query`
   * returns the alphabetical listing without embedding.
   * `queryEmbedding` may be null - callers without Venice get
   * ILIKE-only results.
   */
  async searchWikiArticles(opts: {
    query: string;
    queryEmbedding: number[] | null;
    limit?: number;
  }): Promise<WikiArticle[]> {
    const query = opts.query.trim();
    const limit = opts.limit ?? 20;
    if (query.length === 0) return this.listWikiArticles({ limit });

    const pattern = ilikeLogicTreePattern(query);

    const ilikePromise = this.client
      .from('wiki_articles')
      .select('id, title, content, created_at, updated_at')
      .or(`title.ilike.${pattern},content.ilike.${pattern}`)
      .order('title', { ascending: true })
      .limit(limit);

    const semanticPromise = opts.queryEmbedding
      ? this.client.rpc('search_wiki_articles_by_embedding', {
          query_embedding: opts.queryEmbedding,
          match_limit: limit,
        })
      : Promise.resolve({ data: [] as unknown[], error: null });

    const [ilikeRes, semRes] = await Promise.all([ilikePromise, semanticPromise]);
    if (ilikeRes.error) throw new SupabaseError(ilikeRes.error.message);
    const ilikeRows = (ilikeRes.data ?? []).map((row) =>
      coerceWikiArticle(row as Record<string, unknown>)
    );
    const semanticRows =
      semRes.error !== null
        ? []
        : ((semRes.data ?? []) as unknown[]).map((row) =>
            coerceWikiArticle(row as Record<string, unknown>)
          );

    const out: WikiArticle[] = [];
    const seen = new Set<string>();
    // Semantic first - meaning matches outrank substring matches.
    for (const a of semanticRows) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
      if (out.length >= limit) return out;
    }
    for (const a of ilikeRows) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
      if (out.length >= limit) return out;
    }
    return out;
  }

  // Wiki background pipeline ---------------------------------------------

  /**
   * Filter a candidate set of thread ids down to those that exist
   * for the current user (RLS-scoped). Used by the librarian's
   * `wiki_update` path to validate the `source_thread_ids` parameter
   * the model supplied - the constraint is "agents only attribute
   * thread ids they got from the runtime (their current thread, or
   * `conversation_search` results)", and this method is the defense
   * in depth that catches a hallucinated id at the tool boundary
   * before it lands in `wiki_article_sources`.
   *
   * Empty input returns an empty set without a round-trip.
   * Postgres errors propagate as SupabaseError.
   */
  async findExistingThreadIds(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const { data, error } = await this.client
      .from('threads')
      .select('id')
      .in('id', [...ids]);
    if (error) throw new SupabaseError(error.message);
    const out = new Set<string>();
    for (const row of data ?? []) {
      const id = (row as { id?: unknown }).id;
      if (typeof id === 'string') out.add(id);
    }
    return out;
  }

  /**
   * Claim the oldest thread eligible for the wiki agent.
   *   (1) The eligibility predicate gates on the newest message's
   *       calendar day in the user's tz being strictly before today
   *       (the "next-day" rule the spec asks for).
   *   (2) The lateral that finds the bucket key reads
   *       `messages.created_at` directly rather than
   *       `threads.updated_at`, so a future bump to threads.updated_at
   *       from an unrelated write can't shift the gate.
   * Returns null when the queue is empty.
   */
  async claimNextThreadForWiki(
    holderId: string,
    ttlSeconds: number,
    timezone: string | null
  ): Promise<{
    threadId: string;
    terminalMsgId: string;
    title: string | null;
    /** ISO 8601 timestamp of the newest message in the claimed thread. */
    newestMsgAt: string;
  } | null> {
    const { data, error } = await this.client.rpc('claim_next_thread_for_wiki', {
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
      // Null-coerce - PostgREST passes explicit nulls through, and
      // `at time zone null` returns null which would null out the
      // WHERE predicate.
      p_timezone: timezone ?? 'UTC',
    });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      thread_id: string;
      terminal_msg_id: string;
      title: string | null;
      newest_msg_at: string;
    }[];
    if (rows.length === 0) return null;
    return {
      threadId: rows[0].thread_id,
      terminalMsgId: rows[0].terminal_msg_id,
      title: rows[0].title ?? null,
      newestMsgAt: rows[0].newest_msg_at,
    };
  }

  /**
   * Advance `threads.last_wiki_processed_msg_id` to `msgId` IF our
   * claim is still ours. Returns false on claim-lost; caller drops
   * the cycle. Called unconditionally after every agent run so a
   * no-op cycle (agent decided no topic warranted a wiki update)
   * still advances the pointer past the terminal message.
   */
  async markThreadWikiProcessedIfClaimed(
    threadId: string,
    holderId: string,
    msgId: string
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc(
      'mark_thread_wiki_processed_if_claimed',
      {
        p_thread_id: threadId,
        p_holder_id: holderId,
        p_msg_id: msgId,
      }
    );
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /**
   * Record an agent failure against the claimed wiki thread. Atomic
   * increment + branch in SQL so a multi-device race can't double-
   * count or end up with a half-applied skip. See the function header
   * in schema.sql for the full state-transition table; the short
   * version is "increment under claim, then either release for retry
   * or advance the pointer to give up".
   *
   * - 'released': failure count below threshold; claim cleared so the
   *   next cycle re-claims promptly.
   * - 'skipped': failure count reached the threshold; pointer advanced
   *   to msgId, counter reset, claim cleared. Conversation rejoins the
   *   queue only when a new turn changes the terminal message.
   * - 'claim-lost': the claim was no longer ours (TTL lapsed or another
   *   device took over). Caller treats as a normal claim-lost.
   */
  async recordWikiFailureOrSkip(
    threadId: string,
    holderId: string,
    msgId: string,
    maxFailures: number,
    reason: string | null
  ): Promise<'released' | 'skipped' | 'claim-lost'> {
    const { data, error } = await this.client.rpc(
      'record_wiki_failure_or_skip',
      {
        p_thread_id: threadId,
        p_holder_id: holderId,
        p_msg_id: msgId,
        p_max_failures: maxFailures,
        p_reason: reason,
      }
    );
    if (error) throw new SupabaseError(error.message);
    if (data === 'released' || data === 'skipped' || data === 'claim-lost') {
      return data;
    }
    // Defensive: unrecognised return from the RPC. Treat as released
    // so the thread re-enters the queue rather than stays orphaned
    // under a stale claim.
    return 'released';
  }

  /**
   * List the user's wiki-skipped threads, most recent first. The
   * Wiki tab's Skipped panel renders this; a row drops off the list
   * automatically when the next successful wiki run on that thread
   * clears the skip marker (mark_thread_wiki_processed_if_claimed
   * nulls both columns in one update).
   */
  async listWikiSkippedThreads(): Promise<
    {
      threadId: string;
      title: string | null;
      lastSkipAt: string;
      lastSkipReason: string | null;
    }[]
  > {
    const { data, error } = await this.client.rpc('list_wiki_skipped_threads');
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      thread_id: string;
      title: string | null;
      last_skip_at: string;
      last_skip_reason: string | null;
    }[];
    return rows.map((r) => ({
      threadId: r.thread_id,
      title: r.title,
      lastSkipAt: r.last_skip_at,
      lastSkipReason: r.last_skip_reason,
    }));
  }

  /**
   * Resolve the "terminal assistant message" id the worker would pin
   * against a given thread. The Skipped panel's Retry button uses
   * this to feed the inline wiki-agent run with the same anchor the
   * background worker would have chosen. Returns null when the
   * thread has no eligible assistant message - the caller should
   * surface a no-op rather than calling the agent with a null id.
   */
  async computeWikiTerminalMsgId(threadId: string): Promise<string | null> {
    const { data, error } = await this.client.rpc(
      'compute_wiki_terminal_msg_id',
      { p_thread_id: threadId }
    );
    if (error) throw new SupabaseError(error.message);
    if (typeof data === 'string' && data.length > 0) return data;
    return null;
  }

  /**
   * Advance the wiki pointer + clear the skip marker from outside
   * the worker's claim protocol. Called by the Skipped panel's
   * Retry button after a successful inline agent run. RLS scopes
   * the underlying RPC to the caller's own threads, so this is
   * safe to expose to the UI directly.
   */
  async manualAdvanceWikiPointer(
    threadId: string,
    msgId: string
  ): Promise<void> {
    const { error } = await this.client.rpc('manual_advance_wiki_pointer', {
      p_thread_id: threadId,
      p_msg_id: msgId,
    });
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Atomic claim for one wiki-librarian run. Returns true if the
   * caller acquired the run (the prior timestamp is older than
   * `minIntervalSeconds`, or no run has happened yet); false
   * otherwise. The worker calls this BEFORE invoking the agent so
   * two devices waking up at the same moment don't both run the
   * agent against the same wiki.
   *
   * The atomicity comes from the SQL UPDATE-with-WHERE shape - the
   * update only matches when the interval has passed, so concurrent
   * callers either both miss the predicate (one already won) or one
   * matches and the others don't.
   */
  async claimWikiLibrarianRun(minIntervalSeconds: number): Promise<boolean> {
    const { data, error } = await this.client.rpc('claim_wiki_librarian_run', {
      p_min_interval_seconds: minIntervalSeconds,
    });
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /**
   * Atomic claim for one deep-sleep run. Same shape as
   * claimWikiLibrarianRun - cross-device coordination via an UPDATE-
   * with-WHERE on profiles.deep_sleep_last_run_at. Deep-sleep and rem
   * share the 'memory-librarian' lease partition (mutex), but the
   * cadence gates are independent so the two agents can run on
   * staggered schedules.
   */
  async claimDeepSleepRun(minIntervalSeconds: number): Promise<boolean> {
    const { data, error } = await this.client.rpc('claim_deep_sleep_run', {
      p_min_interval_seconds: minIntervalSeconds,
    });
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  async claimRemRun(minIntervalSeconds: number): Promise<boolean> {
    const { data, error } = await this.client.rpc('claim_rem_run', {
      p_min_interval_seconds: minIntervalSeconds,
    });
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /**
   * Consolidate two memories into one. The agent decides "A and B are
   * the same fact" and calls this with (survivorId, loserId,
   * newLabel, newData). Server-side RPC handles the four-step
   * sequence atomically: max-confidence survivor write, loser halve,
   * memory_conversation redirect, memory_relations redirect. See
   * schema.sql consolidate_memories for the full rationale.
   *
   * Returns the survivor's post-update confidence so the calling tool
   * can echo it to the LLM. Throws if either row is missing, not
   * owned by the caller, or if survivor_id == loser_id.
   */
  async consolidateMemories(
    survivorId: string,
    loserId: string,
    newLabel: string,
    newData: string
  ): Promise<number> {
    const { data, error } = await this.client.rpc('consolidate_memories', {
      p_survivor_id: survivorId,
      p_loser_id: loserId,
      p_new_label: newLabel,
      p_new_data: newData,
    });
    if (error) throw new SupabaseError(error.message);
    if (typeof data !== 'number') {
      throw new SupabaseError(
        `consolidate_memories returned non-numeric: ${JSON.stringify(data)}`
      );
    }
    return data;
  }

  /**
   * Upsert one or more (memory_id, conversation_id) rows into
   * memory_conversation. Bumps last_seen_at to now() on conflict so
   * the eligibility predicate (`last_processed_at < last_seen_at`)
   * re-fires for any pair whose memories were recently referenced
   * again.
   *
   * Caller passes the rows already keyed to a single conversation;
   * we stamp user_id from the session so the RLS check passes
   * without the caller needing to thread the user id through.
   *
   * Best-effort by contract: the recall path swallows errors here -
   * a missed upsert just means rem doesn't see this co-occurrence
   * this cycle. Not worth blocking the recall path.
   */
  async upsertMemoryConversationRows(
    conversationId: string,
    memoryIds: string[]
  ): Promise<void> {
    if (memoryIds.length === 0) return;
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const now = new Date().toISOString();
    const rows = memoryIds.map((memory_id) => ({
      user_id: session.user.id,
      memory_id,
      conversation_id: conversationId,
      last_seen_at: now,
    }));
    const { error } = await this.client
      .from('memory_conversation')
      .upsert(rows, { onConflict: 'memory_id,conversation_id' });
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Update last_librarian_visit_at = now() for a batch of memory ids.
   * Deep-sleep calls this after a successful agent run on the seed +
   * its similarity neighbors, so the next sweep picks a different
   * neighborhood. Confidence-only nudges don't reset the timestamp;
   * label/data changes do (via the trigger).
   */
  async markMemoriesLibrarianVisited(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { error } = await this.client
      .from('memories')
      .update({ last_librarian_visit_at: new Date().toISOString() })
      .in('id', ids);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Pick the next deep-sleep seed: oldest last_librarian_visit_at,
   * nulls (never-visited) first. The partial-style index
   * memories_librarian_visit_idx is configured `nulls first` so this
   * query is an index scan.
   *
   * Confidence floor of 0.05 mirrors the memory_search hide threshold;
   * memories that have decayed below the floor are effectively retired
   * and not worth the agent's attention. Returns null when the user
   * has no eligible memories (empty store, or every memory below
   * floor).
   */
  async pickDeepSleepSeed(): Promise<{
    id: string;
    label: string;
    data: string;
    confidence: number;
    updated_at: string;
    last_librarian_visit_at: string | null;
  } | null> {
    const { data, error } = await this.client
      .from('memories')
      .select('id, label, data, confidence, updated_at, last_librarian_visit_at')
      .gte('confidence', 0.05)
      .order('last_librarian_visit_at', { ascending: true, nullsFirst: true })
      .order('updated_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    if (!data) return null;
    return data as {
      id: string;
      label: string;
      data: string;
      confidence: number;
      updated_at: string;
      last_librarian_visit_at: string | null;
    };
  }

  /**
   * Pick the oldest conversations that have unprocessed
   * memory_conversation rows for the rem agent. Returns at most
   * `limit` conversation ids ordered by their oldest unprocessed
   * row's last_seen_at - so a single conversation that recalled
   * twice in a row doesn't queue-jump one that recalled once a long
   * time ago.
   *
   * The eligibility predicate is `last_processed_at < last_seen_at`, a
   * column-vs-column comparison PostgREST's filter syntax can't
   * express - it would send "last_seen_at" as a literal and Postgres
   * rejects it as a bad timestamp. The dedup + FIFO ordering live in
   * the pick_rem_eligible_conversations RPC so the comparison can read
   * as SQL.
   */
  async pickRemEligibleConversations(limit: number): Promise<string[]> {
    const { data, error } = await this.client.rpc(
      'pick_rem_eligible_conversations',
      { p_limit: limit }
    );
    if (error) throw new SupabaseError(error.message);
    return ((data ?? []) as Array<{ conversation_id: string }>).map(
      (r) => r.conversation_id
    );
  }

  /**
   * Fetch every memory_conversation row for one conversation - rem
   * uses this as the batch of memories to hand to the agent. Joined
   * against memories so the agent gets the label/data/confidence in
   * one round-trip. Filters out memories below the search floor
   * (same 0.05 cutoff as deep-sleep seed selection) - a memory the
   * user has effectively retired isn't worth the agent's attention
   * even if it was recalled recently.
   */
  async fetchMemoriesForConversation(
    conversationId: string
  ): Promise<
    Array<{
      memory_id: string;
      label: string;
      data: string;
      confidence: number;
    }>
  > {
    const { data, error } = await this.client
      .from('memory_conversation')
      .select(
        'memory_id, memories!inner(id, label, data, confidence, user_id)'
      )
      .eq('conversation_id', conversationId)
      .gte('memories.confidence', 0.05);
    if (error) throw new SupabaseError(error.message);
    type Row = {
      memory_id: string;
      memories: {
        id: string;
        label: string;
        data: string;
        confidence: number;
      };
    };
    return ((data ?? []) as unknown as Row[]).map((r) => ({
      memory_id: r.memory_id,
      label: r.memories.label,
      data: r.memories.data,
      confidence: r.memories.confidence,
    }));
  }

  /**
   * Mark every memory_conversation row for one conversation as
   * processed (last_processed_at = now()). Rem calls this after a
   * successful agent run on the conversation's batch.
   */
  async markMemoryConversationProcessed(conversationId: string): Promise<void> {
    const { error } = await this.client
      .from('memory_conversation')
      .update({ last_processed_at: new Date().toISOString() })
      .eq('conversation_id', conversationId);
    if (error) throw new SupabaseError(error.message);
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

  // Thread response claim --------------------------------------------------
  //
  // Per-thread cross-device claim used by the chat-loop to mark "this
  // device is producing the response right now." Observer devices see
  // the claim on the threads realtime channel and gate their composer
  // accordingly. See `acquire_thread_response_claim` and siblings in
  // `supabase/schema.sql` for the atomic semantics, and
  // `ThreadClaimCoordinator` in `src/lib/exchange/thread-claim-coordinator.ts`
  // for the heartbeat-loop wrapper.
  //
  // Distinct from the worker_leases above: those are user-level
  // singletons partitioned by `workerKind`; these are per-thread,
  // keyed on the thread row itself.

  /**
   * Try to take the response claim on `threadId`. Returns true iff we
   * hold it after the call. Atomic: the underlying SQL update only
   * lands if the thread is unclaimed, ours already (harmless refresh),
   * or carrying an expired claim. A `false` return means another
   * device beat us to the claim and still owns a live TTL window.
   */
  async acquireThreadResponseClaim(
    threadId: string,
    holderId: string,
    ttlSeconds: number
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('acquire_thread_response_claim', {
      p_thread_id: threadId,
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /**
   * Extend our claim on `threadId`. Returns false when the claim has
   * already lapsed or been taken over - the chat-loop must abort
   * immediately in that case to avoid a double-response race with the
   * new holder.
   */
  async heartbeatThreadResponseClaim(
    threadId: string,
    holderId: string,
    ttlSeconds: number
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('heartbeat_thread_response_claim', {
      p_thread_id: threadId,
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /**
   * Release the claim on `threadId` explicitly on graceful end-of-turn
   * (success, abort, error). Lets observer devices re-enable their
   * composer instantly rather than waiting for the TTL to elapse.
   * No-op when we don't actually hold the claim.
   */
  async releaseThreadResponseClaim(threadId: string, holderId: string): Promise<void> {
    const { error } = await this.client.rpc('release_thread_response_claim', {
      p_thread_id: threadId,
      p_holder_id: holderId,
    });
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Atomically claim the oldest thread in need of reflection. Returns
   * null when no thread qualifies (already-reflected, under the token
   * threshold, currently claimed by another device, or lands on
   * today in the user's timezone - the day-gate lets in-flight
   * conversations settle before the autonomous agent reads them).
   * The returned `terminalMsgId` is the specific assistant message
   * we should reflect up to; we pass it back to
   * `markThreadReflectedIfClaimed` after a successful run so a race
   * where the user adds more turns mid-reflection simply queues the
   * thread for the next cycle.
   *
   * `timezone` is the user's display timezone (Settings -> AI ->
   * About you); when null/omitted the SQL falls back to UTC. The
   * caller is responsible for normalising input to a valid IANA name.
   */
  async claimNextThreadForReflection(
    holderId: string,
    ttlSeconds: number,
    timezone: string | null
  ): Promise<{ threadId: string; terminalMsgId: string } | null> {
    const { data, error } = await this.client.rpc('claim_next_thread_for_reflection', {
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
      p_timezone: timezone ?? 'UTC',
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
   * Atomically claim the oldest thread that's still on the placeholder
   * title and hasn't been manually pinned. Returns null when nothing
   * qualifies. The returned `userText` is the first user message on the
   * thread - the worker passes it straight to title-gen without a
   * follow-up SELECT.
   */
  async claimNextThreadForAutoTitle(
    holderId: string,
    ttlSeconds: number
  ): Promise<{ threadId: string; userText: string } | null> {
    const { data, error } = await this.client.rpc('claim_next_thread_for_auto_title', {
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as { thread_id: string; user_text: string }[];
    if (rows.length === 0) return null;
    const row = rows[0];
    return { threadId: row.thread_id, userText: row.user_text };
  }

  /**
   * Save the generated title IF the row is still eligible AND our claim
   * is still valid. The RPC's predicate also re-checks that the title
   * is still the default and the user hasn't manually pinned one mid-
   * flight, so a manual rename or model-driven update_title beats us
   * silently rather than clobbering. False return = a race; caller
   * drops the work and the next cycle simply skips the row.
   */
  async saveThreadTitleIfClaimed(
    threadId: string,
    holderId: string,
    title: string
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('save_thread_title_if_claimed', {
      p_thread_id: threadId,
      p_holder_id: holderId,
      p_title: title,
    });
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /**
   * Release the auto-title claim without writing a title. Used when
   * title-gen returned null (model emitted whitespace, abort fired) so
   * the row goes back to the queue immediately rather than waiting for
   * the per-thread claim TTL to expire. Best-effort; the TTL is the
   * authority on stuck claims.
   */
  async clearAutoTitleClaim(threadId: string, holderId: string): Promise<void> {
    const { error } = await this.client.rpc('clear_auto_title_claim', {
      p_thread_id: threadId,
      p_holder_id: holderId,
    });
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Atomically claim the next thread that's settled past its last
   * topics-tagging snapshot. Returns null when nothing qualifies. The
   * `terminalMsgId` is the assistant message we should tag against;
   * `existingTopics` is the user's current topic vocabulary, fetched
   * in the same round trip so the agent can prompt the model with
   * "reuse these names if they fit" without a second SELECT.
   */
  async claimNextThreadForTopics(
    holderId: string,
    ttlSeconds: number
  ): Promise<{
    threadId: string;
    terminalMsgId: string;
    existingTopics: string[];
  } | null> {
    const { data, error } = await this.client.rpc('claim_next_thread_for_topics', {
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      thread_id: string;
      terminal_msg_id: string;
      existing_topics: string[] | null;
    }[];
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      threadId: row.thread_id,
      terminalMsgId: row.terminal_msg_id,
      existingTopics: Array.isArray(row.existing_topics)
        ? row.existing_topics.filter((t): t is string => typeof t === 'string')
        : [],
    };
  }

  /**
   * Save the agent-produced topics IF our claim is still valid. RPC
   * guards on holder + TTL + user_id. False return = a race; caller
   * drops the work and the next cycle will re-pick the row.
   */
  async saveThreadTopicsIfClaimed(
    threadId: string,
    holderId: string,
    topics: string[],
    msgId: string
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('save_thread_topics_if_claimed', {
      p_thread_id: threadId,
      p_holder_id: holderId,
      p_topics: topics,
      p_msg_id: msgId,
    });
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /**
   * Release the topics claim without writing topics. Used when the
   * agent returned no usable output (model emitted garbage, abort
   * fired) so the row re-enters the queue immediately rather than
   * waiting for the per-thread TTL.
   */
  async clearTopicsClaim(threadId: string, holderId: string): Promise<void> {
    const { error } = await this.client.rpc('clear_topics_claim', {
      p_thread_id: threadId,
      p_holder_id: holderId,
    });
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Topic vocabulary + per-topic counts for the current user. Backs the
   * drawer's topic-filter dropdown; called on drawer mount and
   * refreshed after a tagging event. Returns the alphabetised topics
   * the worker has assigned across all threads, each with its corpus
   * count, plus the count of zero-topic threads (the "(untagged)"
   * dropdown row the UI synthesises - never a member of `topics`).
   */
  async listUserTopics(): Promise<TopicVocabulary> {
    const { data, error } = await this.client.rpc('list_user_topics');
    if (error) throw new SupabaseError(error.message);
    return parseTopicVocabulary(data);
  }

  /**
   * Memory-topics sibling of `claimNextThreadForTopics`. The RPC
   * returns the memory's label + data (so the agent doesn't need a
   * second SELECT) plus the user's existing memory-topic vocabulary.
   * Eligibility predicate inside the RPC is `last_topics_at is null` -
   * a fresh row (never tagged) or a content-edited row (the trigger
   * nulls last_topics_at on label/data change) both qualify.
   */
  async claimNextMemoryForTopics(
    holderId: string,
    ttlSeconds: number
  ): Promise<{
    memoryId: string;
    label: string;
    data: string;
    existingTopics: string[];
  } | null> {
    const { data, error } = await this.client.rpc('claim_next_memory_for_topics', {
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      memory_id: string;
      label: string;
      data: string;
      existing_topics: string[] | null;
    }[];
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      memoryId: row.memory_id,
      label: row.label,
      data: row.data,
      existingTopics: Array.isArray(row.existing_topics)
        ? row.existing_topics.filter((t): t is string => typeof t === 'string')
        : [],
    };
  }

  /**
   * Save the agent-produced topics IF our claim is still valid. RPC
   * stamps `last_topics_at = now()` so the row drops out of the
   * eligibility queue until its content changes again. False return =
   * a race (TTL expired, another holder stole the claim, or the user
   * edited the memory and the trigger nulled our claim mid-run).
   * Caller drops the work in that case.
   */
  async saveMemoryTopicsIfClaimed(
    memoryId: string,
    holderId: string,
    topics: string[]
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc(
      'save_memory_topics_if_claimed',
      {
        p_memory_id: memoryId,
        p_holder_id: holderId,
        p_topics: topics,
      }
    );
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /**
   * Release the memory-topics claim without writing topics. Used when
   * the agent returned no usable output so the row re-enters the
   * queue immediately rather than waiting for the per-row TTL.
   */
  async clearMemoryTopicsClaim(
    memoryId: string,
    holderId: string
  ): Promise<void> {
    const { error } = await this.client.rpc('clear_memory_topics_claim', {
      p_memory_id: memoryId,
      p_holder_id: holderId,
    });
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Memory-topic vocabulary + per-topic counts for the current user.
   * Backs the Memories drawer's topic-filter dropdown; called on drawer
   * mount and refreshed after a tagging event. Counts span the whole
   * memory corpus, not the capped search-result set the panel holds.
   * The "(untagged)" pseudo-topic is NOT in `topics` - the UI
   * synthesises it from the `untagged` count.
   */
  async listUserMemoryTopics(): Promise<TopicVocabulary> {
    const { data, error } = await this.client.rpc('list_user_memory_topics');
    if (error) throw new SupabaseError(error.message);
    return parseTopicVocabulary(data);
  }

  /**
   * Recipe-topics sibling of `claimNextMemoryForTopics`. The RPC
   * returns the recipe's title + cooklang (the agent input) plus
   * the user's existing recipe-topic vocabulary in one round trip.
   * Eligibility predicate inside the RPC is `last_topics_at is
   * null` - a fresh row or a content-edited row (title or
   * cooklang) both qualify; bookmark / rating-only edits do not.
   */
  async claimNextRecipeForTopics(
    holderId: string,
    ttlSeconds: number
  ): Promise<{
    recipeId: string;
    title: string;
    cooklang: string;
    existingTopics: string[];
  } | null> {
    const { data, error } = await this.client.rpc('claim_next_recipe_for_topics', {
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      recipe_id: string;
      title: string;
      cooklang: string;
      existing_topics: string[] | null;
    }[];
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      recipeId: row.recipe_id,
      title: row.title,
      cooklang: row.cooklang,
      existingTopics: Array.isArray(row.existing_topics)
        ? row.existing_topics.filter((t): t is string => typeof t === 'string')
        : [],
    };
  }

  /**
   * Save the agent-produced topics IF our claim is still valid.
   * RPC stamps `last_topics_at = now()` and guards on holder + TTL.
   * False return = a race (TTL expired, holder stolen, or the user
   * edited title/cooklang and the trigger nulled our claim mid-run).
   */
  async saveRecipeTopicsIfClaimed(
    recipeId: string,
    holderId: string,
    topics: string[]
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc(
      'save_recipe_topics_if_claimed',
      {
        p_recipe_id: recipeId,
        p_holder_id: holderId,
        p_topics: topics,
      }
    );
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /**
   * Release the recipe-topics claim without writing topics. Used
   * when the agent returned no usable output so the row re-enters
   * the queue immediately rather than waiting for the per-row TTL.
   */
  async clearRecipeTopicsClaim(
    recipeId: string,
    holderId: string
  ): Promise<void> {
    const { error } = await this.client.rpc('clear_recipe_topics_claim', {
      p_recipe_id: recipeId,
      p_holder_id: holderId,
    });
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Recipe-topic vocabulary + per-topic counts for the current user.
   * Backs the Cookbook drawer's topic-filter dropdown. Distinct from
   * `listUserTopics` (threads) and `listUserMemoryTopics`
   * (memories) so a user's vocabularies don't cross-pollute.
   */
  async listUserRecipeTopics(): Promise<TopicVocabulary> {
    const { data, error } = await this.client.rpc('list_user_recipe_topics');
    if (error) throw new SupabaseError(error.message);
    return parseTopicVocabulary(data);
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
   * Top-k memories most similar to a given memory, via the
   * `search_memories_similar` RPC. The source row's own stored
   * embedding is the query vector, so the ranking matches
   * `searchMemoriesByEmbedding`; the source is excluded server-side so
   * it never lists itself. Returns an empty array when the source
   * hasn't been embedded yet (the worker hasn't caught up) - the caller
   * shows an empty state. Each row carries its `similarity` match score
   * (the value the RPC ranks on); the embedding column itself is never
   * shipped.
   */
  async searchSimilarMemories(
    memoryId: string,
    limit: number
  ): Promise<SimilarMemory[]> {
    const { data, error } = await this.client.rpc('search_memories_similar', {
      p_memory_id: memoryId,
      match_limit: limit,
    });
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as SimilarMemory[];
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
    limit: number,
    selectedTopics: readonly string[] = []
  ): Promise<Memory[]> {
    if (!query || query.length === 0) return [];
    const pattern = ilikeLogicTreePattern(query);
    let q = this.client
      .from('memories')
      .select('id, label, data, confidence, topics, created_at, updated_at')
      .is('embedding', null)
      .or(`label.ilike.${pattern},data.ilike.${pattern}`)
      .order('updated_at', { ascending: false })
      .limit(limit);
    // Server-side topic filter on the just-written rows. Vector hits
    // are filtered client-side inside searchMemoriesSemantic (the RPC
    // returns `topics` on each row), so the two halves of the merged
    // result set agree on what "the filter is active" means without
    // needing to refactor the embedding RPC to take topic args.
    const topicsClause = topicsFilterClause(selectedTopics);
    if (topicsClause) q = q.or(topicsClause);
    const { data, error } = await q;
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
    // User rows carry uploads; assistant rows carry generate_image
    // output (attached at end of turn by the chat-loop). Both hydrate
    // through the same query; tool / system rows never carry
    // attachments so they're left out to keep the IN-list small.
    const attachableIds = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => m.id);
    if (attachableIds.length > 0) {
      const attachmentsByMessageId = await this.listAttachmentsByMessageIds(attachableIds);
      for (const m of messages) {
        if (m.role === 'user' || m.role === 'assistant') {
          m.attachments = attachmentsByMessageId.get(m.id) ?? [];
        }
      }
    }
    // Repair an interrupted-exchange tail in memory so every reader -
    // chat UI, summary worker, reflection worker, recall agents,
    // samskara worker, wiki worker - sees a wire-format-valid
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
    // Bytes are NOT projected - they live in the `attachments` bucket
    // (pointed at by storage_path) and are fetched on demand via a
    // signed URL. Thread load carries metadata only, so a thread full of
    // images no longer ships megabytes of base64 on every open.
    const { data, error } = await this.client
      .from('message_attachments')
      .select(
        'id, message_id, position, filename, mime_type, size_bytes, storage_path, extracted_text, expired_at, created_at'
      )
      .in('message_id', messageIds)
      .order('position', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    for (const row of (data ?? []) as Attachment[]) {
      const existing = result.get(row.message_id) ?? [];
      existing.push({
        id: row.id,
        message_id: row.message_id,
        position: row.position,
        filename: row.filename,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        storage_path: typeof row.storage_path === 'string' ? row.storage_path : null,
        extracted_text: row.extracted_text,
        expired_at: row.expired_at,
        created_at: row.created_at,
      });
      result.set(row.message_id, existing);
    }
    return result;
  }

  /**
   * Bulk-insert attachments for a just-written message. For each row we
   * mint the attachment id client-side, upload its bytes to the
   * `attachments` bucket at `<user_id>/<id>/<filename>`, then insert the
   * row carrying `storage_path` (never the bytes). Client-minted ids let
   * the upload and the insert reference the same path in one pass.
   *
   * Returns the hydrated rows (with `storage_path` set, bytes left in the
   * bucket) so the caller can append them to the in-memory message; the
   * UI fetches a signed URL when it needs to render them.
   */
  async addAttachments(
    messageId: string,
    rows: NewAttachment[]
  ): Promise<Attachment[]> {
    if (rows.length === 0) return [];
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const userId = session.user.id;

    const prepared = await Promise.all(
      rows.map(async (r) => {
        const id = crypto.randomUUID();
        const path = `${userId}/${id}/${r.filename}`;
        const { error: upErr } = await this.client.storage
          .from('attachments')
          .upload(path, base64ToBytes(r.data_base64), {
            contentType: r.mime_type,
            upsert: true,
          });
        if (upErr) throw new SupabaseError(upErr.message);
        return {
          id,
          message_id: messageId,
          position: r.position,
          filename: r.filename,
          mime_type: r.mime_type,
          size_bytes: r.size_bytes,
          storage_path: path,
          extracted_text: r.extracted_text,
        };
      })
    );

    const { data, error } = await this.client
      .from('message_attachments')
      .insert(prepared)
      .select(
        'id, message_id, position, filename, mime_type, size_bytes, storage_path, extracted_text, expired_at, created_at'
      );
    if (error) throw new SupabaseError(error.message);
    return ((data ?? []) as Attachment[]).map((row) => ({
      id: row.id,
      message_id: row.message_id,
      position: row.position,
      filename: row.filename,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      storage_path: typeof row.storage_path === 'string' ? row.storage_path : null,
      extracted_text: row.extracted_text,
      expired_at: row.expired_at,
      created_at: row.created_at,
    }));
  }

  /**
   * A short-lived signed URL per attachment id, for rendering image
   * previews / download links and for handing image bytes to Venice (its
   * vision input fetches public URLs). Skips expired attachments
   * (storage_path null). Batched into one Storage call. Best-effort: an
   * attachment whose signed URL can't be minted is simply omitted from
   * the map rather than failing the whole batch.
   */
  async createAttachmentSignedUrls(
    attachments: readonly Pick<Attachment, 'id' | 'storage_path'>[],
    expiresInSeconds = 3600
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const live = attachments.filter(
      (a): a is { id: string; storage_path: string } => typeof a.storage_path === 'string'
    );
    if (live.length === 0) return out;
    const { data, error } = await this.client.storage
      .from('attachments')
      .createSignedUrls(
        live.map((a) => a.storage_path),
        expiresInSeconds
      );
    if (error) throw new SupabaseError(error.message);
    const urlByPath = new Map<string, string>();
    for (const entry of data ?? []) {
      if (entry.signedUrl && typeof entry.path === 'string') {
        urlByPath.set(entry.path, entry.signedUrl);
      }
    }
    for (const a of live) {
      const url = urlByPath.get(a.storage_path);
      if (url) out.set(a.id, url);
    }
    return out;
  }

  /**
   * Download one attachment's bytes from the bucket as a Blob. Used by the
   * paths that need the raw bytes rather than a URL: doc_create (re-upload
   * into the documents bucket) and recipe_photos_attach (hash + dedup).
   * Throws if the object is gone (expired).
   */
  async downloadAttachmentBlob(storagePath: string): Promise<Blob> {
    const { data, error } = await this.client.storage
      .from('attachments')
      .download(storagePath);
    if (error) throw new SupabaseError(error.message);
    return data;
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
        'id, message_id, position, filename, mime_type, size_bytes, storage_path, extracted_text, expired_at, created_at, messages!inner(thread_id)'
      )
      .eq('messages.thread_id', threadId)
      .eq('filename', filename)
      .like('mime_type', 'image/%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    if (!data) return null;
    return coerceAttachmentRow(data as Record<string, unknown>);
  }

  /**
   * Find the most recent attachment in a thread by filename, regardless of
   * mime type or expiry state. Used by `doc_create` to promote a file the user
   * pasted into the conversation into a persistent Library document: it reads
   * the bytes (from the bucket via `storage_path`, null once expired) and the
   * already-parsed `extracted_text`. RLS scopes the thread join to the caller's
   * own threads.
   */
  async findAttachmentByFilenameInThread(
    threadId: string,
    filename: string
  ): Promise<Attachment | null> {
    const { data, error } = await this.client
      .from('message_attachments')
      .select(
        'id, message_id, position, filename, mime_type, size_bytes, storage_path, extracted_text, expired_at, created_at, messages!inner(thread_id)'
      )
      .eq('messages.thread_id', threadId)
      .eq('filename', filename)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    if (!data) return null;
    return coerceAttachmentRow(data as Record<string, unknown>);
  }

  /**
   * Lightweight summary of every attachment in a thread, used to render
   * the `<thread_attachments>` system block in chat-loop. Omits
   * `extracted_text` (potentially huge) since the block only needs
   * filenames + categorisation.
   *
   * Live vs expired is read off `expired_at`: the expiry sweep stamps it
   * when it deletes an object, and the one-time legacy reclaim stamped it
   * on pre-bucket rows, so a non-null `expired_at` is equivalent to
   * `storage_path is null` here without projecting storage_path.
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
   * Replace the `content` field on a single `role='tool'` row, located
   * by its (thread_id, tool_call_id) pair. The ONLY caller is the
   * ask_user suspend/resume path: the chat-loop initially writes a
   * pending sentinel as the tool row content, and the UI rewrites it
   * to the real answer payload when the user submits (or to an
   * abandonment payload on refresh / new send / sibling cancel).
   *
   * Scoped to role='tool' at the application layer in addition to the
   * RLS UPDATE policy's role check, so a future caller can't
   * accidentally rewrite an assistant or user row's content through
   * this surface. The tool_call_id pair is unique within a thread
   * (one tool result per call) so `single()` is correct here.
   *
   * Returns the updated row so the caller can append/replace it in
   * the in-memory message list.
   */
  async updateToolMessageContent(
    threadId: string,
    toolCallId: string,
    content: string
  ): Promise<Message> {
    const { data, error } = await this.client
      .from('messages')
      .update({ content })
      .eq('thread_id', threadId)
      .eq('tool_call_id', toolCallId)
      .eq('role', 'tool')
      .select()
      .single();
    if (error) throw new SupabaseError(error.message);
    return data as Message;
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
    userRound: number,
    fires: { samskaraId: string; score: number }[]
  ): Promise<void> {
    if (fires.length === 0) return;
    const payload = fires.map((f) => ({ samskara_id: f.samskaraId, score: f.score }));
    const { error } = await this.client.rpc('samskara_record_fires', {
      p_cohort_id: cohortId,
      p_thread_id: threadId,
      p_user_round: userRound,
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
        'id, cohort_id, samskara_id, score, fired_at, was_confirmed, user_round, samskaras(tier, prediction, inner_voice, valence, confidence, health)'
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
      user_round: number | null;
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
        userRound: r.user_round,
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

  // --- Bias profile ------------------------------------------------------

  /**
   * Worker: claim the next thread eligible for bias analysis.
   * Eligibility filter lives in the RPC body. `excludeIds` is the
   * set of conversations the caller knows are currently open in
   * the user's UI (we don't process while they might still be
   * typing); `todayStartUtc` is midnight at the start of "today"
   * in the user's local timezone, expressed as a UTC instant, so
   * threads.updated_at < todayStartUtc means "not today". Returns
   * null when no thread is eligible.
   */
  async biasClaimNextThread(
    holderId: string,
    ttlSeconds: number,
    excludeIds: readonly string[],
    todayStartUtc: Date,
    minUserMessages: number
  ): Promise<{
    threadId: string;
    userMessageCount: number;
    /** Snapshot of bias keys that were rendered into the system
     *  prompt on the most recent chat-loop turn for this thread.
     *  Empty array means no biases were active; the merged
     *  observer/reactor agent skips its reaction-classify pass. */
    activeBiases: string[];
  } | null> {
    const { data, error } = await this.client.rpc('bias_claim_next_thread', {
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
      p_exclude_ids: excludeIds.length > 0 ? Array.from(excludeIds) : null,
      p_today_start: todayStartUtc.toISOString(),
      p_min_user_messages: minUserMessages,
    });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      thread_id: string;
      user_message_count: number;
      active_biases: string[] | null;
    }[];
    if (rows.length === 0) return null;
    return {
      threadId: rows[0].thread_id,
      userMessageCount: rows[0].user_message_count,
      activeBiases: rows[0].active_biases ?? [],
    };
  }

  /**
   * Worker: write the agent's observations AND reactions for one
   * thread in a single RPC. `expectedMsgCount` is the user-message
   * count the worker saw at claim time; the RPC rejects the save
   * if the count has changed since (a new user message landed
   * mid-analysis, and the work is based on stale state).
   *
   * `observations` is a list of `{bias, confidence, reasoning,
   * evidence_message_id}` - empty list is a valid save meaning
   * "agent looked and found nothing." `reactions` is a list of
   * `{bias, was_confirmed, reasoning}` - empty list means "no
   * biases were active or no signal" and is also a valid save.
   * The two arrays are independent at the wire level even though
   * they come from the same merged-agent LLM call.
   *
   * Returns true on success, false if any guard fired.
   */
  async biasSaveObservations(
    threadId: string,
    holderId: string,
    expectedMsgCount: number,
    observations: readonly {
      bias: string;
      confidence: number;
      reasoning: string;
      evidence_message_id: string | null;
    }[],
    reactions: readonly {
      bias: string;
      was_confirmed: boolean | null;
      reasoning: string;
    }[]
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('bias_save_observations', {
      p_thread_id: threadId,
      p_holder_id: holderId,
      p_expected_msg_count: expectedMsgCount,
      p_observations: observations,
      p_reactions: reactions,
    });
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /**
   * Worker: list every reaction row for one bias with its age in
   * days. Feeds the per-(user, bias) feedback EMA in the aggregate
   * phase. Includes the reasoning so the worker logs can show what
   * the agent saw without a second round-trip.
   */
  async biasReactionsForBias(bias: string): Promise<
    {
      threadId: string;
      wasConfirmed: boolean | null;
      ageDays: number;
      createdAt: string;
      reasoning: string;
    }[]
  > {
    const { data, error } = await this.client.rpc('bias_reactions_for_bias', {
      p_bias: bias,
    });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      thread_id: string;
      was_confirmed: boolean | null;
      age_days: number;
      created_at: string;
      reasoning: string;
    }[];
    return rows.map((r) => ({
      threadId: r.thread_id,
      wasConfirmed: r.was_confirmed,
      ageDays: r.age_days,
      createdAt: r.created_at,
      reasoning: r.reasoning,
    }));
  }

  /**
   * Chat-loop: snapshot the set of bias keys that just got
   * rendered into the system prompt. Written per chat-loop turn so
   * the worker's claim RPC can hand the active set to the merged
   * observer/reactor agent. RLS handles ownership; the update is
   * a no-op when the thread doesn't belong to the calling user.
   * Fire-and-forget; errors swallowed by the caller.
   */
  async biasSnapshotActiveBiases(
    threadId: string,
    biases: readonly string[]
  ): Promise<void> {
    const { error } = await this.client
      .from('threads')
      .update({ bias_active_at_turn: Array.from(biases) })
      .eq('id', threadId);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Chat-loop: on a new user message, clear bias-processed state
   * for the thread and delete its observations. The aggregation
   * cache (`bias_summary`) is left alone; the worker's next
   * aggregate pass catches up. Tolerates a missing thread; the
   * caller is fire-and-forget.
   */
  async biasClearThread(threadId: string): Promise<void> {
    const { error } = await this.client.rpc('bias_clear_thread', {
      p_thread_id: threadId,
    });
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Worker: list every processed thread for the user, with the
   * within-thread noisy-OR-collapsed probability for the specified
   * bias. Threads with no observation of this bias contribute
   * `pConv = 0` - that row still counts as a non-hit in the
   * denominator, which is what keeps the rate estimate from
   * collapsing to 1.0.
   */
  async biasProcessedThreadsForBias(bias: string): Promise<
    { threadId: string; processedAt: string; pConv: number }[]
  > {
    const { data, error } = await this.client.rpc('bias_processed_threads_for_bias', {
      p_bias: bias,
    });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      thread_id: string;
      processed_at: string;
      p_conv: number;
    }[];
    return rows.map((r) => ({
      threadId: r.thread_id,
      processedAt: r.processed_at,
      pConv: r.p_conv,
    }));
  }

  /**
   * Worker: upsert one aggregated row into `bias_summary`. Per-row
   * primary key is `(user_id, bias)` so `on conflict` lifts the
   * computed_at and updates the math fields in place. The chat-loop
   * read uses the table directly via a select.
   */
  async biasUpsertSummary(row: {
    bias: string;
    effectiveN: number;
    posteriorAlpha: number;
    posteriorBeta: number;
    posteriorMean: number;
    ciLower: number;
    feedbackScore: number;
    tier: 'elided' | 'soft' | 'strong';
  }): Promise<void> {
    const { error } = await this.client
      .from('bias_summary')
      .upsert(
        {
          bias: row.bias,
          effective_n: row.effectiveN,
          posterior_alpha: row.posteriorAlpha,
          posterior_beta: row.posteriorBeta,
          posterior_mean: row.posteriorMean,
          ci_lower: row.ciLower,
          feedback_score: row.feedbackScore,
          tier: row.tier,
          computed_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,bias' }
      );
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Chat-loop: read every cached aggregate for the user. Returns
   * empty array on cold-start (no row in bias_summary yet) or on
   * any RPC error - the format pass treats both as "no bias block
   * this turn", matching samskara's null-on-empty contract.
   */
  async biasListSummary(): Promise<
    {
      bias: string;
      effectiveN: number;
      posteriorAlpha: number;
      posteriorBeta: number;
      posteriorMean: number;
      ciLower: number;
      feedbackScore: number;
      tier: 'elided' | 'soft' | 'strong';
      computedAt: string;
    }[]
  > {
    const { data, error } = await this.client
      .from('bias_summary')
      .select(
        'bias, effective_n, posterior_alpha, posterior_beta, posterior_mean, ci_lower, feedback_score, tier, computed_at'
      );
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      bias: string;
      effective_n: number;
      posterior_alpha: number;
      posterior_beta: number;
      posterior_mean: number;
      ci_lower: number;
      feedback_score: number | null;
      tier: 'elided' | 'soft' | 'strong';
      computed_at: string;
    }[];
    return rows.map((r) => ({
      bias: r.bias,
      effectiveN: r.effective_n,
      posteriorAlpha: r.posterior_alpha,
      posteriorBeta: r.posterior_beta,
      posteriorMean: r.posterior_mean,
      ciLower: r.ci_lower,
      // feedback_score column was added in v2; pre-v2 rows return
      // null which we treat as the neutral 0.
      feedbackScore: r.feedback_score ?? 0,
      tier: r.tier,
      computedAt: r.computed_at,
    }));
  }

  /**
   * Worker: shape-and-freshness probe for `bias_summary`. Returns the
   * row count and the oldest `computed_at` across the user's rows
   * (RLS scopes the select). Used by the aggregate phase on worker
   * bootstrap to decide whether the shared cache is recent enough
   * to adopt without recomputing - the cache is per-user not
   * per-device, so a sibling tab or another device may have just
   * refreshed it.
   *
   * `count` ties forward-compatibility: if BIAS_KEYS gains a new
   * entry, the cache is incomplete (count < N_biases) and the
   * caller should rebuild even if every existing row is fresh.
   *
   * Payload is small (one timestamp per bias, ~19 rows) so the
   * min-and-count derivation happens client-side; saves a custom
   * RPC for the SQL aggregate.
   */
  async biasSummaryFreshness(): Promise<{
    count: number;
    oldestComputedAt: Date | null;
  }> {
    const { data, error } = await this.client
      .from('bias_summary')
      .select('computed_at');
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as { computed_at: string }[];
    if (rows.length === 0) return { count: 0, oldestComputedAt: null };
    let oldest = rows[0].computed_at;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].computed_at < oldest) oldest = rows[i].computed_at;
    }
    return { count: rows.length, oldestComputedAt: new Date(oldest) };
  }

  /**
   * Debug modal: per-bias raw observation counts across the user's
   * full history. Distinct from `effective_n` on the summary row -
   * effective_n is the recency-weighted sum of ALL processed
   * conversations (including the pConv=0 "no-hit" denominator), so
   * every catalog entry the worker has touched ends up with a
   * non-zero effective_n even when it was never flagged. The
   * observation count answers the user's question "has anything
   * ever been recorded against this bias for me?" - zero means the
   * row's posterior is just the prior plus the cumulative no-hit
   * mass, and the modal renders it as "no evidence" rather than
   * the ~5% prior 10th-percentile.
   *
   * Aggregation is client-side. The bias_observations table has no
   * native group-by in the PostgREST surface, and observation
   * counts are small enough (worker-rate-limited, bounded by the
   * catalog size times processed conversations) that pulling the
   * `bias` column and tallying in JS is cheaper than adding an
   * RPC for it.
   */
  async biasListObservationCounts(): Promise<Record<string, number>> {
    const { data, error } = await this.client
      .from('bias_observations')
      .select('bias');
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as { bias: string }[];
    const counts: Record<string, number> = {};
    for (const r of rows) {
      counts[r.bias] = (counts[r.bias] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Debug modal: list per-conversation reactions for one thread.
   * The current-conversation section uses this to surface "did the
   * user affirm or push back on the compensation for X here?"
   * alongside the observations for the same thread.
   */
  async biasListReactionsForThread(threadId: string): Promise<
    {
      id: string;
      bias: string;
      wasConfirmed: boolean | null;
      reasoning: string;
      createdAt: string;
    }[]
  > {
    const { data, error } = await this.client
      .from('bias_reactions')
      .select('id, bias, was_confirmed, reasoning, created_at')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      id: string;
      bias: string;
      was_confirmed: boolean | null;
      reasoning: string;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      bias: r.bias,
      wasConfirmed: r.was_confirmed,
      reasoning: r.reasoning,
      createdAt: r.created_at,
    }));
  }

  /**
   * Debug modal: fetch a thread's bias_processed_at timestamp.
   * Returns null if the thread row doesn't exist yet (e.g. a brand-
   * new draft conversation that hasn't been materialized to the DB)
   * or if the worker hasn't analyzed it yet. The bias-profile modal
   * uses this to distinguish "not yet analyzed" (no observations
   * because the worker hasn't gotten to it) from "already analyzed,
   * no findings" (no observations because the worker scanned and
   * came up empty) - otherwise a fresh conversation reads as the
   * latter, which is wrong and misleading.
   */
  async biasGetThreadProcessedAt(threadId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from('threads')
      .select('bias_processed_at')
      .eq('id', threadId)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    const row = data as { bias_processed_at: string | null } | null;
    return row?.bias_processed_at ?? null;
  }

  /**
   * Debug modal: list observations for one thread. Used by the
   * per-conversation drill-down. Includes the cited message id so
   * the modal can deep-link back to the original.
   */
  async biasListObservationsForThread(threadId: string): Promise<
    {
      id: string;
      bias: string;
      confidence: number;
      reasoning: string;
      evidenceMessageId: string | null;
      createdAt: string;
    }[]
  > {
    const { data, error } = await this.client
      .from('bias_observations')
      .select('id, bias, confidence, reasoning, evidence_message_id, created_at')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      id: string;
      bias: string;
      confidence: number;
      reasoning: string;
      evidence_message_id: string | null;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      bias: r.bias,
      confidence: r.confidence,
      reasoning: r.reasoning,
      evidenceMessageId: r.evidence_message_id,
      createdAt: r.created_at,
    }));
  }

  /**
   * Debug modal: list every observation for one bias key across
   * every thread the user has, joined to the source thread's
   * title so each row can render as a navigable link. Drives the
   * per-bias drill-down ("which conversations triggered this?")
   * on the bias-profile screen.
   *
   * Sorted newest-first - the user's mental model is "what got
   * flagged recently for this bias?", not chronological reading
   * order. RLS scopes the read to the current user; deleted
   * threads have already cascaded their observations away, so a
   * missing thread title here means the auto-titler hasn't run
   * yet, not a dangling reference.
   */
  async biasListObservationsForBiasKey(biasKey: string): Promise<
    {
      id: string;
      threadId: string;
      threadTitle: string | null;
      confidence: number;
      reasoning: string;
      createdAt: string;
    }[]
  > {
    const { data, error } = await this.client
      .from('bias_observations')
      .select('id, thread_id, confidence, reasoning, created_at, threads(title)')
      .eq('bias', biasKey)
      .order('created_at', { ascending: false });
    if (error) throw new SupabaseError(error.message);
    const out: {
      id: string;
      threadId: string;
      threadTitle: string | null;
      confidence: number;
      reasoning: string;
      createdAt: string;
    }[] = [];
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const id = row.id;
      const threadId = row.thread_id;
      if (typeof id !== 'string' || typeof threadId !== 'string') continue;
      // PostgREST returns a many-to-one embed as a single object,
      // but the supabase-js type inference treats it as either an
      // object or array depending on FK metadata. Mirror the
      // unwrap pattern from listWikiArticleSources so this stays
      // robust against either shape.
      const thread = row.threads as { title?: unknown } | { title?: unknown }[] | null;
      const threadObj = Array.isArray(thread) ? thread[0] : thread;
      const title =
        threadObj && typeof threadObj.title === 'string' ? threadObj.title : null;
      out.push({
        id,
        threadId,
        threadTitle: title,
        confidence: typeof row.confidence === 'number' ? row.confidence : 0,
        reasoning: typeof row.reasoning === 'string' ? row.reasoning : '',
        createdAt: typeof row.created_at === 'string' ? row.created_at : '',
      });
    }
    return out;
  }

  /**
   * Debug modal: list the most-recently-processed threads with
   * counts of observations and the message-count token. Drives the
   * "Processed conversations" table on the bias-profile screen.
   */
  async biasListProcessedThreads(limit: number = 30): Promise<
    {
      threadId: string;
      title: string;
      processedAt: string;
      observationCount: number;
    }[]
  > {
    const { data, error } = await this.client
      .from('threads')
      .select(
        'id, title, bias_processed_at, bias_observations(count)'
      )
      .not('bias_processed_at', 'is', null)
      .order('bias_processed_at', { ascending: false })
      .limit(limit);
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      id: string;
      title: string | null;
      bias_processed_at: string;
      // Supabase's `embedded count` returns an array containing
      // one row with { count: N }; the cast is fragile in the
      // type system, careful at the boundary.
      bias_observations: { count: number }[] | null;
    }[];
    return rows.map((r) => ({
      threadId: r.id,
      title: r.title ?? '',
      processedAt: r.bias_processed_at,
      observationCount: r.bias_observations?.[0]?.count ?? 0,
    }));
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
  /** 1-based index of the user message that triggered this cohort, as
   *  counted by the chat loop at fire time. Null for legacy rows
   *  written before the column existed and not yet covered by the
   *  one-time backfill - the per-message inline UI suppresses the
   *  toggle on user messages where no cohort maps to this round. */
  userRound: number | null;
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
