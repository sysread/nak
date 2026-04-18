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
import { isModelTier, type ModelTier } from './models';
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
   * Master switch for tool availability on this thread. Flipped by the
   * `toggle_tools` meta-tool (LLM-driven) or the composer toolbox button
   * (user-driven). When false, only toggle_tools rides along with each
   * request; when true, every registered tool's schema is included.
   */
  tools_enabled: boolean;
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
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    title: String(row.title ?? ''),
    model,
    tools_enabled: row.tools_enabled === true,
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
 * Per-user preferences persisted on `profiles.settings` (jsonb). Keeps
 * prefs that should follow the account across browsers — API keys and
 * the master-password KDF remain per-device by design.
 */
export interface UserSettings {
  defaultModel?: ModelTier;
  colorMode?: ColorMode;
  accent?: Accent;
  /** Library of named system prompts the user can toggle per-thread. */
  systemPrompts?: SystemPrompt[];
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
  return out;
}

export class SupabaseService {
  readonly client: SupabaseClient;

  constructor(config: Pick<AppConfig, 'supabaseUrl' | 'supabaseAnonKey'>) {
    this.client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
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
    const { error } = await this.client
      .from('profiles')
      .update({ settings: merged })
      .eq('user_id', session.user.id);
    if (error) throw new SupabaseError(error.message);
    return merged;
  }

  async listThreads(): Promise<Thread[]> {
    const { data, error } = await this.client
      .from('threads')
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceThread(row as Record<string, unknown>));
  }

  async createThread(title: string, model: ModelTier | null = null): Promise<Thread> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data, error } = await this.client
      .from('threads')
      .insert({ title, user_id: session.user.id, model })
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
