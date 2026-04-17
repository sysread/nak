<script lang="ts">
  /*
   * The main screen. Three concerns stacked top-to-bottom:
   *
   *   top-bar   — hamburger, title (inline renameable), model tier toggle
   *   messages  — scrollable list of bubbles, plus in-flight streaming text
   *   composer  — textarea + expand button + send button
   *
   * Threads come in two flavors:
   *   - Persisted threads: live in Supabase, have real ids, load messages
   *     on select.
   *   - Drafts: local-only, have client-side UUIDs, flagged via
   *     `isDraft`. Created by newThread(); materialized to Supabase on
   *     the first `send` or manual rename (see materializeIfDraft).
   *     Abandoned drafts disappear on refresh because they aren't stored.
   *
   * Streaming lifecycle:
   *   1. User clicks send → insert user message row → clear composer.
   *   2. Kick off `app.venice.streamChat` with an AbortController.
   *      Deltas append into `streamingText`, which renders as an
   *      "assistant" bubble below the persisted messages.
   *   3. When the stream completes: insert an assistant message row,
   *      clear streamingText, refresh the thread list so the sidebar
   *      ordering reflects updated_at.
   *   4. First exchange of a new thread triggers `autoTitle` in the
   *      background — see that helper for the tradeoffs.
   *
   * Model selection:
   *   - The top-right toggle sets a per-thread override (threads.model).
   *   - Clicking the tier that matches the user's default clears the
   *     override (writes null) so the thread keeps tracking default
   *     changes — see setTier().
   */
  import { onMount, tick } from 'svelte';
  import type { Session } from '@supabase/supabase-js';
  import { app, lock, setDefaultModel, setTheme } from '$lib/state.svelte';
  import { clearSession, getSessionThreadId, setSessionThreadId } from '$lib/session';
  import type { Thread, Message } from '$lib/supabase';
  import {
    MODELS,
    TIERS,
    DEFAULT_TIER,
    UTILITY_TIER,
    resolveTier,
    type ModelTier,
  } from '$lib/models';
  import Auth from './Auth.svelte';
  import Settings from './Settings.svelte';
  import Markdown from '../components/Markdown.svelte';

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
      if (s) {
        void refreshThreads();
        void refreshSettings();
      } else {
        threads = [];
      }
    });
    void app.supabase.getSession().then((s) => {
      session = s;
      sessionLoaded = true;
      if (s) {
        void refreshThreads();
        void refreshSettings();
      }
    });
    return unsubscribe;
  });

  async function refreshSettings(): Promise<void> {
    if (!app.supabase) return;
    try {
      const s = await app.supabase.getSettings();
      if (s.defaultModel) setDefaultModel(s.defaultModel);
      // If the server has a theme choice and it differs from the cached one,
      // apply it now. setTheme also re-caches, so subsequent loads are fast.
      if (s.colorMode || s.accent) {
        setTheme(s.colorMode ?? app.colorMode, s.accent ?? app.accent);
      }
    } catch {
      // Best-effort: fall back to DEFAULT_TIER / cached theme from activate().
    }
  }

  // True once we've attempted to restore the last-open thread from the
  // session blob — ensures we only do it on the first threads fetch.
  let threadRestoreAttempted = false;

  async function refreshThreads(): Promise<void> {
    if (!app.supabase) return;
    try {
      const fresh = await app.supabase.listThreads();
      // Preserve any in-memory drafts — they don't round-trip through
      // Supabase until the user sends or renames.
      const drafts = threads.filter((t) => t.isDraft);
      threads = [...drafts, ...fresh];
      if (!threadRestoreAttempted) {
        threadRestoreAttempted = true;
        // On first load within a tab, restore whichever conversation was
        // open last time. Only kicks in if the id still exists (the thread
        // may have been deleted, or it was an abandoned draft).
        const restored = getSessionThreadId();
        if (restored && threads.some((t) => t.id === restored)) {
          void selectThread(restored);
          return;
        }
      }
      if (activeThreadId && !threads.find((t) => t.id === activeThreadId)) {
        activeThreadId = null;
        messages = [];
        setSessionThreadId(null);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Turn an in-memory draft thread into a real Supabase row. Returns the
   * materialized Thread. Safe to call when the thread is already real —
   * in that case it's a no-op and just returns the thread as-is.
   */
  async function materializeIfDraft(draft: Thread, title?: string): Promise<Thread> {
    if (!draft.isDraft || !app.supabase) return draft;
    const real = await app.supabase.createThread(title ?? draft.title, draft.model);
    // Swap the draft for the real thread in local state; keep the new id
    // in the session so a reload sticks to the now-persisted conversation.
    threads = threads.map((t) => (t.id === draft.id ? real : t));
    if (activeThreadId === draft.id) {
      activeThreadId = real.id;
      setSessionThreadId(real.id);
    }
    return real;
  }

  async function selectThread(id: string): Promise<void> {
    if (!app.supabase) return;
    // Abandoned-draft cleanup: if the previously active thread was a draft
    // (never sent, never renamed), drop it from the sidebar rather than
    // leaving an empty placeholder behind once the user moves on.
    if (activeThreadId && activeThreadId !== id) {
      const prev = threads.find((t) => t.id === activeThreadId);
      if (prev?.isDraft) {
        threads = threads.filter((t) => t.id !== activeThreadId);
      }
    }
    activeThreadId = id;
    setSessionThreadId(id);
    messages = [];
    streamingText = '';
    // On mobile the drawer is modal, so dismiss it once a thread is chosen.
    // On desktop the sidebar is a persistent column — leave it open.
    if (
      typeof window !== 'undefined' &&
      window.matchMedia('(max-width: 720px)').matches
    ) {
      drawerOpen = false;
    }
    // Drafts aren't in Supabase yet — no messages to fetch.
    const t = threads.find((x) => x.id === id);
    if (t?.isDraft) return;
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

  const defaultTier = $derived<ModelTier>(app.defaultModel ?? DEFAULT_TIER);
  const currentTier = $derived<ModelTier>(
    resolveTier(currentThread?.model ?? null, defaultTier)
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
    try {
      if (currentThread.isDraft) {
        // Manual rename is a save signal: materialize with the new title
        // in a single round-trip rather than create-then-rename.
        await materializeIfDraft(currentThread, next);
        return;
      }
      const threadId = currentThread.id;
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

  async function setTier(tier: ModelTier): Promise<void> {
    if (!app.supabase || !currentThread) return;
    // If the chosen tier matches the user's default, clear the per-thread
    // override so the thread keeps tracking future default changes; only
    // pin an explicit tier when it actually differs from the default.
    const next: ModelTier | null = tier === defaultTier ? null : tier;
    if ((currentThread.model ?? null) === next) return;
    const threadId = currentThread.id;
    // Update local state immediately so the UI reflects the choice.
    threads = threads.map((t) => (t.id === threadId ? { ...t, model: next } : t));
    // For drafts, the choice rides along in memory and gets persisted when
    // the draft materializes (on send or manual rename). Changing the
    // model alone shouldn't create a Supabase row.
    if (currentThread.isDraft) return;
    try {
      await app.supabase.setThreadModel(threadId, next);
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
    // Create a local-only draft. It materializes in Supabase only when the
    // user sends a message or renames the thread; an abandoned draft just
    // disappears on refresh.
    const session = await app.supabase.getSession();
    if (!session) return;
    const now = new Date().toISOString();
    const draft: Thread = {
      id: crypto.randomUUID(),
      user_id: session.user.id,
      title: DEFAULT_TITLE,
      model: null,
      created_at: now,
      updated_at: now,
      isDraft: true,
    };
    threads = [draft, ...threads];
    await selectThread(draft.id);
  }

  async function deleteThread(id: string): Promise<void> {
    if (!app.supabase) return;
    const t = threads.find((x) => x.id === id);
    if (!t) return;
    if (!confirm('Delete this thread and all its messages?')) return;
    try {
      // Drafts only exist in memory — just drop them locally.
      if (!t.isDraft) await app.supabase.deleteThread(id);
      threads = threads.filter((x) => x.id !== id);
      if (activeThreadId === id) {
        activeThreadId = null;
        messages = [];
        setSessionThreadId(null);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function send(): Promise<void> {
    const text = composer.trim();
    if (!text || !app.supabase || !app.venice) return;
    error = null;

    const active = activeThreadId
      ? threads.find((t) => t.id === activeThreadId) ?? null
      : null;
    // Capture the tier BEFORE materializing, since materialize mutates
    // `threads` and could make `currentThread` briefly null.
    const tier = resolveTier(active?.model ?? null, defaultTier);
    const modelId = MODELS[tier].id;

    let threadId: string;
    let isFirstExchange = false;
    if (!active) {
      // No thread selected — create one on the fly.
      const t = await app.supabase.createThread(DEFAULT_TITLE);
      threads = [t, ...threads];
      threadId = t.id;
      activeThreadId = t.id;
      setSessionThreadId(t.id);
      isFirstExchange = true;
    } else if (active.isDraft) {
      // First send on a draft — materialize it now, preserving any model
      // choice the user already made from the dropdown.
      const real = await materializeIfDraft(active);
      threadId = real.id;
      isFirstExchange = true;
    } else {
      threadId = active.id;
      isFirstExchange = messages.length === 0 && active.title === DEFAULT_TITLE;
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

  // ⌘+Enter (macOS), Ctrl+Enter (everyone else), and the legacy Shift+Enter
  // all submit. Plain Enter still inserts a newline so long-form drafts
  // aren't interrupted. `metaKey` maps to the Command key on macOS; on
  // Windows/Linux it's the rarely-pressed Super/Windows key, so including
  // it there is harmless.
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.shiftKey)) {
      e.preventDefault();
      void send();
    }
  }

  // Platform-aware hint in the composer placeholder. Uses the modern
  // navigator.userAgentData.platform when available and falls back to
  // the legacy navigator.platform string.
  const isMac = $derived.by(() => {
    if (typeof navigator === 'undefined') return false;
    const p =
      (navigator as Navigator & { userAgentData?: { platform?: string } })
        .userAgentData?.platform ?? navigator.platform ?? '';
    return /mac/i.test(p);
  });
  const sendHint = $derived(
    isMac ? '\u2318+Enter to send, Enter for newline' : 'Ctrl+Enter to send, Enter for newline'
  );

  async function signOut(): Promise<void> {
    // Clear the cached master-password session too — an explicit sign-out
    // should reset auto-unlock so a refresh goes back to the Unlock screen.
    clearSession();
    await app.supabase?.signOut();
  }

  // Mobile drawer. Hidden by default on narrow viewports via CSS, which
  // Sidebar visibility — doubles as the mobile drawer toggle and the
  // desktop "hide sidebar" toggle. Initial value is viewport-aware so
  // desktop loads with the sidebar open and mobile loads with it closed,
  // without a layout flash.
  let drawerOpen = $state(
    typeof window !== 'undefined' && window.innerWidth > 720
  );
  function closeDrawer(): void {
    drawerOpen = false;
  }
  function toggleDrawer(): void {
    drawerOpen = !drawerOpen;
  }

  // Composer expand toggle. When true, the textarea grows to 40vh so the
  // user has room for longer prompts; otherwise it sticks to the compact
  // ~12rem max-height.
  let composerExpanded = $state(false);

</script>

{#if !sessionLoaded}
  <div class="center"><p class="subtle">Connecting…</p></div>
{:else if !session}
  <Auth />
{:else if showSettings}
  <Settings onClose={() => (showSettings = false)} />
{:else}
  <div class="shell" class:drawer-open={drawerOpen}>
    <div
      class="drawer-backdrop"
      onclick={closeDrawer}
      onkeydown={(e) => { if (e.key === 'Escape') closeDrawer(); }}
      role="button"
      tabindex={drawerOpen ? 0 : -1}
      aria-label="Close thread drawer"
      aria-hidden={!drawerOpen}
    ></div>
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
          <button
            class="secondary icon-btn lock-btn"
            onclick={lock}
            title="Lock (session is unlocked)"
            aria-label="Lock"
          >
            <svg class="lock-open" width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round"
                 stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 9.9-1" />
            </svg>
            <svg class="lock-closed" width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round"
                 stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </button>
          <button
            class="secondary icon-btn"
            onclick={signOut}
            title="Sign out"
            aria-label="Sign out"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </footer>
    </aside>

    <main class="chat">
      <div class="top-bar">
        <button
          class="secondary icon-btn hamburger"
          onclick={toggleDrawer}
          title={drawerOpen ? 'Hide threads' : 'Show threads'}
          aria-label={drawerOpen ? 'Hide threads' : 'Show threads'}
          aria-expanded={drawerOpen}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <button
          class="secondary icon-btn new-thread-mini"
          onclick={newThread}
          disabled={currentIsEmpty}
          title={currentIsEmpty ? "You're already on an empty thread." : 'Start a new conversation'}
          aria-label="Start a new conversation"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </button>
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
          <div
            class="model-toggle"
            role="group"
            aria-label="Model tier"
            title={`Active: ${MODELS[currentTier].label} (${MODELS[currentTier].id})`}
          >
            {#each TIERS as tier (tier)}
              <button
                type="button"
                class="model-toggle-btn"
                class:selected={currentTier === tier}
                aria-pressed={currentTier === tier}
                onclick={() => setTier(tier)}
                title={MODELS[tier].label}
                aria-label={MODELS[tier].label}
              >
                <span aria-hidden="true">{MODELS[tier].icon}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
      <div class="messages">
        {#each messages as m (m.id)}
          <div class="msg {m.role}">
            <Markdown content={m.content} />
          </div>
        {/each}
        {#if streamingText}
          <div class="msg assistant">
            <Markdown content={streamingText} />
          </div>
        {/if}
        {#if messages.length === 0 && !streamingText}
          <div class="empty">Type a message to begin.</div>
        {/if}
      </div>
      {#if error}<p class="error" style="padding:0 1rem">{error}</p>{/if}
      <div class="composer">
        <div class="textarea-wrap">
          <textarea
            class:expanded={composerExpanded}
            bind:value={composer}
            onkeydown={onKeydown}
            placeholder={`Message… (${sendHint})`}
            disabled={sending}
          ></textarea>
          <button
            type="button"
            class="composer-expand"
            onclick={() => (composerExpanded = !composerExpanded)}
            title={composerExpanded ? 'Shrink composer' : 'Expand composer'}
            aria-label={composerExpanded ? 'Shrink composer' : 'Expand composer'}
            aria-pressed={composerExpanded}
          >
            {#if composerExpanded}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2" stroke-linecap="round"
                   stroke-linejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            {:else}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="2" stroke-linecap="round"
                   stroke-linejoin="round" aria-hidden="true">
                <polyline points="18 15 12 9 6 15" />
              </svg>
            {/if}
          </button>
        </div>
        <button
          class="send-btn"
          onclick={send}
          disabled={sending || composer.trim().length === 0}
          title={sending ? 'Sending…' : 'Send'}
          aria-label={sending ? 'Sending' : 'Send'}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"
               aria-hidden="true">
            <path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>
    </main>
  </div>
{/if}
