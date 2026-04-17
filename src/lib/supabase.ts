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

export interface Thread {
  id: string;
  user_id: string;
  title: string;
  /** Per-thread model tier override. Null/absent means use user default. */
  model: ModelTier | null;
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
 * CHECK constraint, so scrub unexpected values to null.
 */
function coerceThread(row: Record<string, unknown>): Thread {
  const model = isModelTier(row.model) ? row.model : null;
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    title: String(row.title ?? ''),
    model,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export interface Message {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
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

  async deleteThread(threadId: string): Promise<void> {
    const { error } = await this.client.from('threads').delete().eq('id', threadId);
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
   */
  async addMessage(
    threadId: string,
    role: Message['role'],
    content: string
  ): Promise<Message> {
    const { data, error } = await this.client
      .from('messages')
      .insert({ thread_id: threadId, role, content })
      .select()
      .single();
    if (error) throw new SupabaseError(error.message);
    await this.client
      .from('threads')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', threadId);
    return data as Message;
  }
}
