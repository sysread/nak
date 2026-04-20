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
  type ModelTier,
  type ReasoningEffort,
} from './models';
import { isAccent, isColorMode, type Accent, type ColorMode } from './theme';
import type { OpenAIToolCall } from './tools/types';
import type { TokenUsage } from './venice';

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
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    title: String(row.title ?? ''),
    model,
    reasoning_effort,
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
    reasoningEffort: ReasoningEffort | null = null
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
    return (data ?? []) as Message[];
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
    } = {}
  ): Promise<Message> {
    const row: Record<string, unknown> = { thread_id: threadId, role, content };
    if (opts.tool_calls !== undefined) row.tool_calls = opts.tool_calls;
    if (opts.tool_call_id !== undefined) row.tool_call_id = opts.tool_call_id;
    if (opts.name !== undefined) row.name = opts.name;
    if (opts.model !== undefined) row.model = opts.model;
    if (opts.usage !== undefined) row.usage = opts.usage;
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
}
