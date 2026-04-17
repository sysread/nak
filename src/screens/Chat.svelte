<script lang="ts">
  import { onMount } from 'svelte';
  import type { Session } from '@supabase/supabase-js';
  import { app, lock } from '$lib/state.svelte';
  import { clearSession } from '$lib/session';
  import type { Thread, Message } from '$lib/supabase';
  import Auth from './Auth.svelte';
  import Settings from './Settings.svelte';

  let session = $state<Session | null>(null);
  let sessionLoaded = $state(false);
  let showSettings = $state(false);

  let threads = $state<Thread[]>([]);
  let activeThreadId = $state<string | null>(null);
  let messages = $state<Message[]>([]);
  let streamingText = $state('');
  let composer = $state('');
  let sending = $state(false);
  let error = $state<string | null>(null);
  let abortCtl: AbortController | null = null;

  const DEFAULT_MODEL = 'llama-3.3-70b';

  onMount(() => {
    if (!app.supabase) return;
    const unsubscribe = app.supabase.onAuthChange((s) => {
      session = s;
      sessionLoaded = true;
      if (s) void refreshThreads();
      else threads = [];
    });
    void app.supabase.getSession().then((s) => {
      session = s;
      sessionLoaded = true;
      if (s) void refreshThreads();
    });
    return unsubscribe;
  });

  async function refreshThreads(): Promise<void> {
    if (!app.supabase) return;
    try {
      threads = await app.supabase.listThreads();
      if (activeThreadId && !threads.find((t) => t.id === activeThreadId)) {
        activeThreadId = null;
        messages = [];
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function selectThread(id: string): Promise<void> {
    if (!app.supabase) return;
    activeThreadId = id;
    messages = [];
    streamingText = '';
    try {
      messages = await app.supabase.listMessages(id);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  // True when the active thread has no messages yet — clicking "New thread"
  // in this state would produce a second empty thread, so we disable it.
  const currentIsEmpty = $derived(activeThreadId !== null && messages.length === 0);

  async function newThread(): Promise<void> {
    if (!app.supabase) return;
    if (currentIsEmpty) return;
    try {
      const t = await app.supabase.createThread('New conversation');
      threads = [t, ...threads];
      await selectThread(t.id);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function deleteThread(id: string): Promise<void> {
    if (!app.supabase) return;
    if (!confirm('Delete this thread and all its messages?')) return;
    try {
      await app.supabase.deleteThread(id);
      threads = threads.filter((t) => t.id !== id);
      if (activeThreadId === id) {
        activeThreadId = null;
        messages = [];
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function send(): Promise<void> {
    const text = composer.trim();
    if (!text || !app.supabase || !app.venice) return;
    error = null;

    let threadId = activeThreadId;
    if (!threadId) {
      const title = text.slice(0, 48);
      const t = await app.supabase.createThread(title);
      threads = [t, ...threads];
      threadId = t.id;
      activeThreadId = t.id;
    }

    composer = '';
    sending = true;
    try {
      const userMsg = await app.supabase.addMessage(threadId, 'user', text);
      messages = [...messages, userMsg];
      streamingText = '';
      abortCtl = new AbortController();
      const history = messages.map((m) => ({ role: m.role, content: m.content }));
      let full = '';
      for await (const delta of app.venice.streamChat({
        model: DEFAULT_MODEL,
        messages: history,
        signal: abortCtl.signal,
      })) {
        full += delta;
        streamingText = full;
      }
      if (full.length > 0) {
        const assistantMsg = await app.supabase.addMessage(threadId, 'assistant', full);
        messages = [...messages, assistantMsg];
      }
      streamingText = '';
      await refreshThreads();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      streamingText = '';
    } finally {
      sending = false;
      abortCtl = null;
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  async function signOut(): Promise<void> {
    // Clear the cached master-password session too — an explicit sign-out
    // should reset auto-unlock so a refresh goes back to the Unlock screen.
    clearSession();
    await app.supabase?.signOut();
  }
</script>

{#if !sessionLoaded}
  <div class="center"><p class="subtle">Connecting…</p></div>
{:else if !session}
  <Auth />
{:else if showSettings}
  <Settings onClose={() => (showSettings = false)} />
{:else}
  <div class="shell">
    <aside class="sidebar">
      <header>
        <button
          style="width:100%"
          onclick={newThread}
          disabled={currentIsEmpty}
          title={currentIsEmpty ? "You're already on an empty thread." : 'Start a new conversation'}
        >+ New thread</button>
      </header>
      <div class="thread-list">
        {#each threads as t (t.id)}
          <div class="row" style="padding:0 0.2rem">
            <button
              class="thread grow"
              class:active={t.id === activeThreadId}
              onclick={() => selectThread(t.id)}
            >{t.title || 'Untitled'}</button>
            <button class="secondary" title="Delete" aria-label="Delete thread"
                    onclick={() => deleteThread(t.id)}>×</button>
          </div>
        {/each}
        {#if threads.length === 0}
          <p class="subtle" style="padding:0.75rem">No threads yet.</p>
        {/if}
      </div>
      <footer>
        <div class="subtle" style="margin-bottom:0.4rem;font-size:0.8rem">
          {session.user.email}
        </div>
        <div class="row">
          <button class="secondary grow" onclick={() => (showSettings = true)}>Settings</button>
          <button class="secondary" onclick={lock}>Lock</button>
        </div>
        <button class="secondary" style="width:100%;margin-top:0.4rem" onclick={signOut}>
          Sign out
        </button>
      </footer>
    </aside>

    <main class="chat">
      <div class="top-bar">
        <div class="subtle">
          {activeThreadId ? threads.find((t) => t.id === activeThreadId)?.title : 'Start a new conversation'}
        </div>
      </div>
      <div class="messages">
        {#each messages as m (m.id)}
          <div class="msg {m.role}">{m.content}</div>
        {/each}
        {#if streamingText}
          <div class="msg assistant">{streamingText}</div>
        {/if}
        {#if messages.length === 0 && !streamingText}
          <div class="empty">Type a message to begin.</div>
        {/if}
      </div>
      {#if error}<p class="error" style="padding:0 1rem">{error}</p>{/if}
      <div class="composer">
        <textarea
          bind:value={composer}
          onkeydown={onKeydown}
          placeholder="Message… (Shift+Enter to send, Enter for newline)"
          disabled={sending}
        ></textarea>
        <button onclick={send} disabled={sending || composer.trim().length === 0}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </main>
  </div>
{/if}
