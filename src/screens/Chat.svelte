<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { Session } from '@supabase/supabase-js';
  import { app, lock } from '$lib/state.svelte';
  import { clearSession } from '$lib/session';
  import type { Thread, Message } from '$lib/supabase';
  import {
    MODELS,
    TIERS,
    DEFAULT_TIER,
    UTILITY_TIER,
    resolveTier,
    isModelTier,
    type ModelTier,
  } from '$lib/models';
  import Auth from './Auth.svelte';
  import Settings from './Settings.svelte';

  const DEFAULT_TITLE = 'New conversation';

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

  // Inline title rename state.
  let renaming = $state(false);
  let renameBuffer = $state('');
  let titleInputEl: HTMLInputElement | undefined = $state();

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

  const currentThread = $derived(
    activeThreadId ? threads.find((t) => t.id === activeThreadId) ?? null : null
  );

  const defaultTier = $derived<ModelTier>(app.config?.defaultModel ?? DEFAULT_TIER);
  const currentTier = $derived<ModelTier>(
    resolveTier(currentThread?.model ?? null, defaultTier)
  );
  const selectValue = $derived<'default' | ModelTier>(
    currentThread?.model ?? 'default'
  );

  async function startRename(): Promise<void> {
    if (!currentThread) return;
    renameBuffer = currentThread.title;
    renaming = true;
    await tick();
    titleInputEl?.focus();
    titleInputEl?.select();
  }

  async function commitRename(): Promise<void> {
    if (!renaming) return;
    renaming = false;
    const next = renameBuffer.trim();
    if (!app.supabase || !currentThread) return;
    if (!next || next === currentThread.title) return;
    const threadId = currentThread.id;
    try {
      await app.supabase.renameThread(threadId, next);
      threads = threads.map((t) => (t.id === threadId ? { ...t, title: next } : t));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  function cancelRename(): void {
    renaming = false;
    renameBuffer = '';
  }

  function onTitleKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  }

  async function onModelChange(e: Event): Promise<void> {
    const raw = (e.target as HTMLSelectElement).value;
    const next: ModelTier | null = isModelTier(raw) ? raw : null;
    if (!app.supabase || !currentThread) return;
    const threadId = currentThread.id;
    try {
      await app.supabase.setThreadModel(threadId, next);
      threads = threads.map((t) => (t.id === threadId ? { ...t, model: next } : t));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Best-effort: ask the fast model for a short title for this thread. Runs
   * after the first user+assistant round-trip. Any failure is swallowed —
   * the thread simply keeps the default title.
   */
  async function autoTitle(threadId: string, firstUserMsg: string): Promise<void> {
    if (!app.venice || !app.supabase) return;
    let raw = '';
    try {
      for await (const d of app.venice.streamChat({
        model: MODELS[UTILITY_TIER].id,
        messages: [
          {
            role: 'system',
            content:
              'Return a 3–6 word title summarizing this conversation. No trailing punctuation. No quotes. Plain text.',
          },
          { role: 'user', content: firstUserMsg.slice(0, 1000) },
        ],
        maxTokens: 24,
      })) {
        raw += d;
      }
    } catch {
      return;
    }
    const title = raw
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’.!?]+$/g, '')
      .trim()
      .slice(0, 80);
    if (!title) return;
    try {
      await app.supabase.renameThread(threadId, title);
      threads = threads.map((t) => (t.id === threadId ? { ...t, title } : t));
    } catch {
      /* ignore */
    }
  }

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
    let isFirstExchange = false;
    if (!threadId) {
      // Leave the title as the default so autoTitle() can replace it once
      // the assistant finishes responding.
      const t = await app.supabase.createThread(DEFAULT_TITLE);
      threads = [t, ...threads];
      threadId = t.id;
      activeThreadId = t.id;
      isFirstExchange = true;
    } else {
      isFirstExchange =
        messages.length === 0 &&
        (currentThread?.title ?? '') === DEFAULT_TITLE;
    }

    const tier = resolveTier(currentThread?.model ?? null, defaultTier);
    const modelId = MODELS[tier].id;

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
        model: modelId,
        messages: history,
        signal: abortCtl.signal,
      })) {
        full += delta;
        streamingText = full;
      }
      if (full.length > 0) {
        const assistantMsg = await app.supabase.addMessage(threadId, 'assistant', full);
        messages = [...messages, assistantMsg];
        if (isFirstExchange) {
          // Fire-and-forget: don't block the UI on title generation.
          void autoTitle(threadId, text);
        }
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
          <button
            class="secondary icon-btn"
            onclick={() => (showSettings = true)}
            title="Settings"
            aria-label="Settings"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button class="secondary grow" onclick={lock}>Lock</button>
        </div>
        <button class="secondary" style="width:100%;margin-top:0.4rem" onclick={signOut}>
          Sign out
        </button>
      </footer>
    </aside>

    <main class="chat">
      <div class="top-bar">
        <div class="title-wrap">
          {#if !currentThread}
            <div class="subtle">Start a new conversation</div>
          {:else if renaming}
            <input
              class="title-input"
              bind:this={titleInputEl}
              bind:value={renameBuffer}
              onkeydown={onTitleKey}
              onblur={commitRename}
              maxlength="80"
            />
          {:else}
            <button
              class="title-btn"
              title="Click to rename"
              onclick={startRename}
            >{currentThread.title || 'Untitled'}</button>
          {/if}
        </div>
        {#if currentThread}
          <select
            class="model-select"
            value={selectValue}
            onchange={onModelChange}
            title={`Active: ${MODELS[currentTier].label} (${MODELS[currentTier].id})`}
          >
            <option value="default">Default ({MODELS[defaultTier].label})</option>
            {#each TIERS as tier (tier)}
              <option value={tier}>{MODELS[tier].label} — {MODELS[tier].id}</option>
            {/each}
          </select>
        {/if}
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
