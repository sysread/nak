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
import { isLogLevel, type LogLevel } from './logger.svelte';
import type { OpenAIToolCall } from './tools/types';
import type { Citation, TokenUsage } from './venice';

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
   * Master switch for tool availability on this thread. Flipped by the
   * `toggle_tools` meta-tool (LLM-driven) or the composer toolbox button
   * (user-driven). When false, only toggle_tools rides along with each
   * request; when true, every registered tool's schema is included.
   */
  tools_enabled: boolean;
  /**
   * Soft-hide flag. Archived threads still load — they just render under
   * the drawer's collapsed "Archive" section and lock out the composer.
   * Flipped by the archive / restore row actions; restore also bumps
   * updated_at so the thread jumps to the top of the Chats list.
   */
  archived: boolean;
  created_at: string;
  updated_at: string;
  /**
   * App-local flag: true when this thread exists only in memory (the user
   * clicked "new thread" but hasn't sent a message or renamed it yet).
   * Drafts are never sent to Supabase — they materialize on first save.
   */
  isDraft?: boolean;
}

/**
 * Coerce the raw row from Supabase. The `model` column is `text` without a
 * CHECK constraint, so scrub unexpected values to null. `tools_enabled`
 * defaults to false if the column is missing (older row before the
 * migration, or a coerce on a freshly-minted draft).
 */
function coerceThread(row: Record<string, unknown>): Thread {
  const model = isModelTier(row.model) ? row.model : null;
  const reasoning_effort = isReasoningEffort(row.reasoning_effort)
    ? row.reasoning_effort
    : null;
  const verbosity = isVerbosity(row.verbosity) ? row.verbosity : null;
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    title: String(row.title ?? ''),
    model,
    reasoning_effort,
    verbosity,
    tools_enabled: row.tools_enabled === true,
    archived: row.archived === true,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/**
 * A saved memory — label + free-form data, per-user. The `embedding` column
 * exists on the table but we deliberately don't ship it to the client
 * (1024 floats is a lot of bytes for a list view). The embed-on-write
 * path will populate it server-side or via a dedicated client method.
 */
export interface Memory {
  id: string;
  label: string;
  data: string;
  created_at: string;
  updated_at: string;
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
  created_at: string;
  updated_at: string;
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
   * Opt out of Venice's server-side web-search augmentation. Absent /
   * true → we send `venice_parameters.enable_web_search='on'` plus
   * `enable_web_citations=true` on every chat request, grounding every
   * turn with live results and inline source attribution. Explicit
   * `false` → we send `'off'` so the field is pinned even if Venice
   * later changes its server-side default.
   */
  webSearchEnabled?: boolean;
  /**
   * Minimum level the Logs drawer should show by default. Absent
   * means "show everything" (the lowest tier, `debug`) — falling back
   * to DEFAULT_LOG_LEVEL in state.svelte.ts. The drawer seeds its own
   * filter from this value at open time; within-session overrides via
   * the drawer's dropdown are not persisted.
   */
  defaultLogLevel?: LogLevel;
}

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
  // Tri-state on the wire (absent / true / false). Only a literal `false`
  // flips the feature off — any other shape leaves it absent so the
  // caller-side default ("enabled") kicks in.
  if (r.webSearchEnabled === false) out.webSearchEnabled = false;
  else if (r.webSearchEnabled === true) out.webSearchEnabled = true;
  if (isLogLevel(r.defaultLogLevel)) out.defaultLogLevel = r.defaultLogLevel;
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
    if ('webSearchEnabled' in patch) {
      if (patch.webSearchEnabled === undefined) delete merged.webSearchEnabled;
      else if (typeof patch.webSearchEnabled === 'boolean') {
        merged.webSearchEnabled = patch.webSearchEnabled;
      }
    }
    if ('defaultLogLevel' in patch) {
      if (patch.defaultLogLevel === undefined) delete merged.defaultLogLevel;
      else if (isLogLevel(patch.defaultLogLevel)) {
        merged.defaultLogLevel = patch.defaultLogLevel;
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
          tools_enabled: false,
          archived: row.archived,
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
   * `Thread[]` — the tool result set doesn't need user_id /
   * tools_enabled / model / reasoning_effort, and surfacing those on
   * tool results would be noise the LLM then has to filter.
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
    verbosity: Verbosity | null = null
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
      })
      .select()
      .single();
    if (error) throw new SupabaseError(error.message);
    return coerceThread(data as Record<string, unknown>);
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    const { error } = await this.client
      .from('threads')
      .update({ title, updated_at: new Date().toISOString() })
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
   * updated_at — flipping reasoning shouldn't promote the thread to the
   * top of the sidebar, same rationale as setThreadToolsEnabled.
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
   * Flip the thread's tool-availability master switch. Called from the
   * toggle_tools meta-tool (LLM path) and from the composer toolbox button
   * (user path). Doesn't touch updated_at — we don't want a toggle to
   * promote the thread to the top of the sidebar.
   */
  async setThreadToolsEnabled(threadId: string, enabled: boolean): Promise<void> {
    const { error } = await this.client
      .from('threads')
      .update({ tools_enabled: enabled })
      .eq('id', threadId);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Flip the thread's archived flag. Unlike setThreadToolsEnabled /
   * setThreadReasoningEffort, this one DOES bump updated_at — both
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
      .select('id, label, data, created_at, updated_at')
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

  async createMemory(label: string, data: string): Promise<Memory> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data: row, error } = await this.client
      .from('memories')
      .insert({ user_id: session.user.id, label, data })
      .select('id, label, data, created_at, updated_at')
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
      .select('id, label, data, created_at, updated_at')
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
   * List recipes most-recent first, optionally filtered by a case-
   * insensitive `title` substring. Capped at `limit` to keep the
   * recipe_list tool result small (one recipe's cooklang can be
   * several kilobytes; a runaway list would blow the context budget).
   */
  async listRecipes(query: string, limit: number): Promise<Recipe[]> {
    let q = this.client
      .from('recipes')
      .select('id, title, source, source_url, cooklang, created_at, updated_at')
      .order('updated_at', { ascending: false })
      .limit(limit);
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
      .select('id, title, source, source_url, cooklang, created_at, updated_at')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    return (data as Recipe | null) ?? null;
  }

  async createRecipe(
    title: string,
    cooklang: string,
    source: string | null = null,
    sourceUrl: string | null = null
  ): Promise<Recipe> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data: row, error } = await this.client
      .from('recipes')
      .insert({
        user_id: session.user.id,
        title,
        cooklang,
        source,
        source_url: sourceUrl,
      })
      .select('id, title, source, source_url, cooklang, created_at, updated_at')
      .single();
    if (error) throw new SupabaseError(error.message);
    return row as Recipe;
  }

  /**
   * Partial update. Caller guarantees at least one field in `patch`
   * is set — enforced by the recipe_update tool before it reaches
   * here. Bumps updated_at so the list orders freshly-edited recipes
   * to the top.
   */
  async updateRecipe(
    id: string,
    patch: {
      title?: string;
      cooklang?: string;
      source?: string | null;
      source_url?: string | null;
    }
  ): Promise<Recipe> {
    const { data: row, error } = await this.client
      .from('recipes')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, title, source, source_url, cooklang, created_at, updated_at')
      .single();
    if (error) throw new SupabaseError(error.message);
    return row as Recipe;
  }

  async deleteRecipe(id: string): Promise<void> {
    const { error } = await this.client.from('recipes').delete().eq('id', id);
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
   * Cosine-similarity search via the `search_memories_by_embedding` RPC.
   * The RPC enforces `user_id = auth.uid()` in addition to RLS and hides
   * the `embedding` column from the response — 2048 floats per row is a
   * lot to ship back just to throw away.
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
      .select('id, label, data, created_at, updated_at')
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
    return messages;
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
          onInsert(payload.new);
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
   * `cosine * sqrt(health * confidence)` so weak-but-relevant samskaras
   * can break through against strong-but-distant ones. The caller
   * computes `kMax` as `ceil(K_BASE * log10(N + 10))` per the agreed
   * log10 dampening on priming volume.
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
   * Maintenance: collapse existing tier-1 near-duplicates. Walks the
   * user's samskaras newest-first; for each row, finds an older row
   * with cosine similarity >= threshold on `prediction_embedding`;
   * migrates fires + provenance to the older "winner"; folds the
   * loser's counters in; deletes the loser. Returns the number of
   * rows collapsed. Idempotent - a second call after a clean pass
   * returns 0. Safe to run while the worker is live; a concurrent
   * mint-tier1 can at worst re-create a twin we just removed, which
   * the next run collapses.
   */
  async samskaraCollapseDuplicates(threshold = 0.9): Promise<number> {
    const { data, error } = await this.client.rpc('samskara_collapse_duplicates', {
      p_threshold: threshold,
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
 * the ranked weight `cosine * sqrt(health * confidence)`; callers
 * include it in the priming block so the chat model can perceive the
 * relative weight of each fired samskara.
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
