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
   * concurrent writes from multiple tabs.
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

  async createThread(title: string): Promise<Thread> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data, error } = await this.client
      .from('threads')
      .insert({ title, user_id: session.user.id })
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
    // bump thread updated_at so ordering reflects activity
    await this.client
      .from('threads')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', threadId);
    return data as Message;
  }
}
