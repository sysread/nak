import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import type { AppConfig } from './config';

export interface Thread {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
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

  async listThreads(): Promise<Thread[]> {
    const { data, error } = await this.client
      .from('threads')
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as Thread[];
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
    return data as Thread;
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    const { error } = await this.client
      .from('threads')
      .update({ title, updated_at: new Date().toISOString() })
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
