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
  import { app, lock, setDefaultModel, setSystemPrompts, setTheme } from '$lib/state.svelte';
  import { clearSession, getSessionThreadId, setSessionThreadId } from '$lib/session';
  import type { Thread, Message } from '$lib/supabase';
  import { runChatLoop, toVeniceMessage } from '$lib/chat-loop';
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
  import CopyButton from '../components/CopyButton.svelte';
  import Markdown from '../components/Markdown.svelte';
  import Scanner from '../components/Scanner.svelte';
  import ToolCalls from '../components/ToolCalls.svelte';

  const DEFAULT_TITLE = 'New conversation';

  let session = $state<Session | null>(null);
  let sessionLoaded = $state(false);
  let showSettings = $state(false);

  let threads = $state<Thread[]>([]);
  let activeThreadId = $state<string | null>(null);
  let messages = $state<Message[]>([]);
  let streamingText = $state('');

  /**
   * In-memory latency tracking for tool calls in the current session.
   * Populated by the chat-loop's onToolStart / onToolDone / onToolError
   * handlers and read by the ToolCalls component. Wiped on navigation
   * (fresh thread selection clears this) because "how long did this
   * take when it originally ran?" isn't a question we bother to
   * persist — reopened conversations show only the final status
   * glyph and hide the pill.
   */
  let toolTimings = $state<Record<string, { startedAt: number; endedAt?: number; error?: boolean }>>(
    {}
  );
  /**
   * Live monotonic clock, driven by rAF while any tool is in flight and
   * frozen when everything is idle. Drives the live-duration pill and
   * the animated ellipsis in ToolCalls. Using performance.now() because
   * Date.now() is clamped on a 1ms boundary and can go backwards.
   */
  let nowMs = $state<number>(typeof performance !== 'undefined' ? performance.now() : 0);
  $effect(() => {
    const pending = Object.values(toolTimings).some((t) => t.endedAt === undefined);
    if (!pending) return;
    let raf = 0;
    const tick = (): void => {
      nowMs = performance.now();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
  let composer = $state('');
  let composerEl: HTMLTextAreaElement | undefined = $state();
  let sending = $state(false);
  let error = $state<string | null>(null);
  let abortCtl: AbortController | null = null;

  // Auto-grow the composer so the caret is always visible as the user
  // types. CSS caps the textarea at 40vh — once content exceeds that
  // the element scrolls internally. We reset height to auto first so
  // deletes shrink the box back down to the natural content height.
  $effect(() => {
    void composer;
    const el = composerEl;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  });

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
      setSystemPrompts(s.systemPrompts ?? []);
      // Only (re)seed the active set if the user hasn't already started
      // toggling prompts on the current thread. Avoids clobbering their
      // per-thread selection when settings arrive late.
      if (activePromptIds.size === 0) resetActivePromptsToDefaults();
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
    // Re-seed the active prompt set from defaults whenever the user
    // switches threads — per-thread toggles are not persisted, so a
    // thread switch is effectively a fresh start for this UI state.
    resetActivePromptsToDefaults();
    // Opening a thread starts in follow-bottom mode; the autoscroll
    // effect lands the view on the newest messages once they load.
    followBottom = true;
    // Tool-call timings are a session-scoped display aid; nav to another
    // thread drops them so the previous thread's pills don't leak into
    // the new one.
    toolTimings = {};
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
    markTitling(threadId, true);
    let raw = '';
    try {
      try {
        for await (const ev of app.venice.streamChat({
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
          // Title generation never sends tools; any non-text event is
          // ignored. Keeping the filter explicit makes the intent clear.
          if (ev.type === 'text') raw += ev.delta;
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
    } finally {
      // Always clear the indicator, including early returns above.
      markTitling(threadId, false);
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
      tools_enabled: false,
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
    // Sending is an explicit "pay attention to the bottom" signal — even
    // if the user had scrolled up before hitting send, we want their new
    // message (and the impending streaming response) in view.
    followBottom = true;
    try {
      const userMsg = await app.supabase.addMessage(threadId, 'user', text);
      messages = [...messages, userMsg];
      streamingText = '';
      abortCtl = new AbortController();

      // Build the request payload: active system prompts first (in library
      // order, skipping empties), then the stored conversation history
      // (faithfully projected onto the OpenAI wire shape via
      // toVeniceMessage so stored tool_calls / tool_call_id / name
      // round-trip). Prompts aren't stored on the thread — we re-apply
      // whatever the user has toggled on at send time.
      const systemMessages: { role: 'system'; content: string }[] = app.systemPrompts
        .filter((p) => activePromptIds.has(p.id) && p.body.trim().length > 0)
        .map((p) => ({ role: 'system' as const, content: p.body }));
      const freshThread = threads.find((t) => t.id === threadId);
      if (!freshThread) throw new Error('thread disappeared before send');
      const currentUserId = session?.user.id ?? freshThread.user_id;
      const historyOnWire = [
        ...systemMessages,
        ...messages.map(toVeniceMessage),
      ];

      // Coalesce streamingText updates with rAF so the main thread
      // only re-parses/sanitizes/renders the growing text at most once
      // per paint. Without this, bursts of SSE deltas (e.g. a whole
      // sentence landing in one TCP chunk) would each trigger a full
      // marked + DOMPurify re-parse, visible as UI gulps instead of a
      // smooth stream. Also guarantees at least one paint of the
      // "thinking dots" state before any streamingText is written.
      let pending: string | null = null;
      let rafId = 0;
      const flushPending = (): void => {
        rafId = 0;
        if (pending !== null) {
          streamingText = pending;
          pending = null;
        }
      };
      const cancelPending = (): void => {
        if (rafId !== 0) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
      };

      let loopResult;
      try {
        loopResult = await runChatLoop({
          venice: app.venice,
          supabase: app.supabase,
          thread: freshThread,
          userId: currentUserId,
          modelId,
          history: historyOnWire,
          signal: abortCtl.signal,
          handlers: {
            onTextUpdate: (t) => {
              pending = t;
              if (rafId === 0) rafId = requestAnimationFrame(flushPending);
            },
            onAssistantPersisted: (msg) => {
              // Cancel any pending frame — the persisted row takes
              // over rendering and we don't want a stale flush to
              // replay the text into streamingText after this.
              cancelPending();
              pending = null;
              messages = [...messages, msg];
              streamingText = '';
            },
            onToolResultPersisted: (msg) => {
              messages = [...messages, msg];
            },
            onToolStart: (call) => {
              // performance.now() rather than Date.now() so the
              // elapsed math is monotonic — the user's clock jumping
              // (NTP sync, daylight saving) can't produce negative
              // durations.
              toolTimings[call.id] = { startedAt: performance.now() };
            },
            onToolDone: (call) => {
              const t = toolTimings[call.id];
              if (t) t.endedAt = performance.now();
            },
            onToolError: (call) => {
              const t = toolTimings[call.id];
              if (t) {
                t.endedAt = performance.now();
                t.error = true;
              }
            },
            onToolsEnabledChange: (enabled) => {
              threads = threads.map((t) =>
                t.id === threadId ? { ...t, tools_enabled: enabled } : t
              );
              // Brief flash on the composer toolbox so a human eye
              // notices the LLM-initiated state flip. User-initiated
              // flips don't flash (the click itself is the feedback).
              toolboxFlash = true;
              setTimeout(() => {
                toolboxFlash = false;
              }, 600);
            },
          },
        });
      } finally {
        // Commit anything pending synchronously so post-loop code
        // sees the final state.
        cancelPending();
        if (pending !== null) {
          streamingText = pending;
          pending = null;
        }
      }
      if (loopResult.stoppedByLimit && !loopResult.finalText) {
        error = 'Stopped: tool-call loop hit the 5-round limit.';
      }
      if (isFirstExchange && loopResult.finalText.length > 0) {
        // Fire-and-forget: don't block the UI on title generation.
        void autoTitle(threadId, text);
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
  // The composer textarea resizes naturally up to max-height and is
  // user-resizable via the native drag handle (see .composer-textarea).

  // Scroll behavior for the messages list.
  //
  //   followBottom = true  → stream deltas and user sends pin the view
  //                          to the bottom.
  //   followBottom = false → the user has scrolled upward while content
  //                          was arriving; stop auto-scrolling. The
  //                          floating "↓" button re-engages follow mode.
  //
  // The scroll handler derives `followBottom` from the current
  // position, so programmatic scrolls (streaming appends) and user
  // scrolls go through the same code path — we just react to "is the
  // view still near the bottom?" and set the flag accordingly. No
  // ignore-next-event plumbing needed.
  const NEAR_BOTTOM_PX = 48;
  let messagesEl: HTMLDivElement | undefined = $state();
  let followBottom = $state(true);
  let hasOverflow = $state(false);

  function isNearBottom(el: HTMLElement): boolean {
    return el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX;
  }

  function scrollToBottom(smooth = false): void {
    const el = messagesEl;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }

  function onMessagesScroll(): void {
    const el = messagesEl;
    if (!el) return;
    followBottom = isNearBottom(el);
    hasOverflow = el.scrollHeight > el.clientHeight + 1;
  }

  // Streaming deltas arrive fast enough that scrolling on every
  // coalesced paint makes the content rocket off-screen before the
  // eye can lock onto a word — the view feels like a slot machine.
  // Debounce the streaming-driven scroll so bursts of tokens settle
  // into periodic nudges instead of a continuous blur. The max-wait
  // cap guarantees the view still keeps up with a sustained stream:
  // no matter how fast the tokens come, a scroll fires at least once
  // per SCROLL_MAX_WAIT_MS window. Discrete transitions (user sends,
  // assistant-message commit, thread switch) bypass this path and
  // scroll immediately — see the $effect below.
  const SCROLL_DEBOUNCE_MS = 80;
  const SCROLL_MAX_WAIT_MS = 300;
  let scrollDebounceTimer = 0;
  let scrollMaxWaitTimer = 0;

  function cancelScrollTimers(): void {
    if (scrollDebounceTimer !== 0) {
      clearTimeout(scrollDebounceTimer);
      scrollDebounceTimer = 0;
    }
    if (scrollMaxWaitTimer !== 0) {
      clearTimeout(scrollMaxWaitTimer);
      scrollMaxWaitTimer = 0;
    }
  }

  function firePendingStreamScroll(): void {
    cancelScrollTimers();
    // Re-check followBottom at fire time: the user may have scrolled
    // up while the timer was pending, and scroll-lock honors current
    // intent rather than the intent at the moment the timer was set.
    if (followBottom) scrollToBottom(false);
  }

  function scheduleStreamScroll(): void {
    if (!followBottom) {
      // Scroll-lock engaged — drop any pending scrolls so a stale
      // timer doesn't fight the user after they scroll up.
      cancelScrollTimers();
      return;
    }
    if (scrollDebounceTimer !== 0) clearTimeout(scrollDebounceTimer);
    scrollDebounceTimer = window.setTimeout(
      firePendingStreamScroll,
      SCROLL_DEBOUNCE_MS
    );
    // Max-wait ceiling: armed on the first scheduled scroll of a
    // streaming burst and only reset when a scroll actually fires.
    // Without this, a rapid-enough stream would reset the debounce
    // timer forever and the view would never catch up.
    if (scrollMaxWaitTimer === 0) {
      scrollMaxWaitTimer = window.setTimeout(
        firePendingStreamScroll,
        SCROLL_MAX_WAIT_MS
      );
    }
  }

  // Two separate effects so streaming deltas and discrete message-list
  // mutations can drive different scroll policies. Splitting them is
  // the simplest way to get "debounce tokens, snap on commits" without
  // prev-value bookkeeping inside a single effect.

  // Message-list mutations — user send, assistant-persist, thread load,
  // thread switch. These mark a clean transition and should land the
  // view on the bottom immediately. Firing here also supersedes any
  // pending streaming debounce: the commit we just observed is the
  // latest state, so a stale late-firing timer would just flicker.
  $effect(() => {
    void messages;
    const el = messagesEl;
    if (!el) return;
    hasOverflow = el.scrollHeight > el.clientHeight + 1;
    cancelScrollTimers();
    if (followBottom) scrollToBottom(false);
  });

  // Streaming deltas — debounced with a max-wait cap. `streamingText`
  // toggling to '' at the end of a round also runs through here; the
  // follow-up messages effect (assistant persisted) will cancel the
  // pending timer and do the final snap-to-bottom, so we don't need
  // a special "stream ended" signal.
  $effect(() => {
    void streamingText;
    const el = messagesEl;
    if (!el) return;
    hasOverflow = el.scrollHeight > el.clientHeight + 1;
    scheduleStreamScroll();
  });

  // Composer popovers (prompts list + model picker). Only one is open at
  // a time. Click-outside closes; Escape too.
  let promptsMenuOpen = $state(false);
  let modelMenuOpen = $state(false);
  let composerBarEl: HTMLDivElement | undefined = $state();

  // IDs of system prompts active for the current thread. Seeded from
  // `enabledByDefault` when a thread is opened, not persisted. Swapping
  // threads resets this to the current defaults — per-thread toggles do
  // not carry across conversations.
  let activePromptIds = $state<Set<string>>(new Set());

  // Thread ids currently having their title auto-generated by the Fast
  // tier. Used to swap the title text for a Scanner in the sidebar and
  // the top bar so the user gets feedback that something is happening.
  let titlingThreadIds = $state<Set<string>>(new Set());
  function markTitling(threadId: string, on: boolean): void {
    const next = new Set(titlingThreadIds);
    if (on) next.add(threadId);
    else next.delete(threadId);
    titlingThreadIds = next;
  }

  function resetActivePromptsToDefaults(): void {
    activePromptIds = new Set(
      app.systemPrompts.filter((p) => p.enabledByDefault).map((p) => p.id)
    );
  }

  function togglePrompt(id: string): void {
    const next = new Set(activePromptIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    activePromptIds = next;
  }

  const activePromptCount = $derived(
    app.systemPrompts.filter((p) => activePromptIds.has(p.id)).length
  );

  function closeMenus(): void {
    promptsMenuOpen = false;
    modelMenuOpen = false;
  }

  function onDocClick(e: MouseEvent): void {
    if (!promptsMenuOpen && !modelMenuOpen) return;
    if (composerBarEl && composerBarEl.contains(e.target as Node)) return;
    closeMenus();
  }

  function onDocKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') closeMenus();
  }

  $effect(() => {
    if (!promptsMenuOpen && !modelMenuOpen) return;
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onDocKey);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onDocKey);
    };
  });

  // Brief pulse on the composer toolbox button when the LLM flips
  // tools_enabled via toggle_tools. Set true on change, unset after the
  // animation finishes — ~600ms is enough for the keyframe to complete.
  let toolboxFlash = $state(false);

  /**
   * Render plan derived from the raw message list. Tool-result rows are
   * folded into their parent assistant message's tool-group so the UI
   * sees one card per turn. Plain user / assistant-text rows pass through.
   *
   * Built as a $derived so messages mutations re-group automatically
   * (e.g. when the chat-loop pushes a new tool-result in mid-turn).
   */
  type MessageBlock =
    | { kind: 'plain'; message: Message }
    | { kind: 'tool-group'; assistant: Message; resultsByCallId: Record<string, Message> };

  const messageBlocks = $derived.by<MessageBlock[]>(() => {
    // First pass: index tool rows by their tool_call_id.
    const resultsByCallId: Record<string, Message> = {};
    for (const m of messages) {
      if (m.role === 'tool' && m.tool_call_id) {
        resultsByCallId[m.tool_call_id] = m;
      }
    }
    // Second pass: emit blocks, folding assistant-with-tool_calls rows
    // into a tool-group that carries the matching result rows.
    const blocks: MessageBlock[] = [];
    for (const m of messages) {
      if (m.role === 'tool') continue; // folded under their assistant parent
      if (
        m.role === 'assistant' &&
        m.tool_calls &&
        m.tool_calls.length > 0
      ) {
        const scoped: Record<string, Message> = {};
        for (const call of m.tool_calls) {
          const r = resultsByCallId[call.id];
          if (r) scoped[call.id] = r;
        }
        blocks.push({ kind: 'tool-group', assistant: m, resultsByCallId: scoped });
      } else {
        blocks.push({ kind: 'plain', message: m });
      }
    }
    return blocks;
  });

  /**
   * Manual toolbox toggle — the user-driven path parallel to the
   * toggle_tools tool. Writes straight through to Supabase + updates
   * local state. Only meaningful on a real (non-draft) thread; drafts
   * don't exist server-side until they materialize on send.
   */
  async function toggleToolsManually(): Promise<void> {
    if (!app.supabase || !currentThread || currentThread.isDraft) return;
    const next = !currentThread.tools_enabled;
    const threadId = currentThread.id;
    // Optimistic: update locally first so the button feels instant.
    threads = threads.map((t) =>
      t.id === threadId ? { ...t, tools_enabled: next } : t
    );
    try {
      await app.supabase.setThreadToolsEnabled(threadId, next);
    } catch (err) {
      // Revert on failure so the UI doesn't lie about server state.
      threads = threads.map((t) =>
        t.id === threadId ? { ...t, tools_enabled: !next } : t
      );
      error = err instanceof Error ? err.message : String(err);
    }
  }
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
            >
              {#if titlingThreadIds.has(t.id)}
                <Scanner label="Generating title" size={0.85} />
              {:else}
                {t.title || 'Untitled'}
              {/if}
            </button>
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
          {:else if titlingThreadIds.has(currentThread.id)}
            <div class="title-btn" aria-label="Generating title">
              <Scanner label="Generating title" />
            </div>
          {:else}
            <button
              class="title-btn"
              title="Click to rename"
              onclick={startRename}
            >{currentThread.title || 'Untitled'}</button>
          {/if}
        </div>
      </div>
      <div class="messages-wrap">
        <div
          class="messages"
          bind:this={messagesEl}
          onscroll={onMessagesScroll}
        >
          {#each messageBlocks as block (block.kind === 'plain' ? block.message.id : block.assistant.id)}
            {#if block.kind === 'tool-group'}
              <div class="msg assistant">
                {#if block.assistant.content}
                  <CopyButton text={block.assistant.content} ariaLabel="Copy message" />
                  <Markdown content={block.assistant.content} />
                {/if}
                <ToolCalls
                  calls={block.assistant.tool_calls ?? []}
                  resultsByCallId={block.resultsByCallId}
                  timings={toolTimings}
                  nowMs={nowMs}
                />
              </div>
            {:else}
              <div class="msg {block.message.role}">
                {#if block.message.role === 'assistant'}
                  <CopyButton text={block.message.content} ariaLabel="Copy message" />
                {/if}
                <Markdown content={block.message.content} />
              </div>
            {/if}
          {/each}
          {#if sending || streamingText}
            <div class="msg assistant">
              {#if streamingText}
                <!-- While the response is arriving, render the buffer as
                     plain pre-wrap text. Full markdown (syntax highlighting,
                     KaTeX, DOMPurify) re-parses the whole growing string on
                     every update — fine for a finished message, but during
                     streaming it pegs the main thread and makes the text
                     land in visible gulps. Once the stream completes the
                     committed message rerenders via <Markdown> below. -->
                <div class="streaming-text">{streamingText}</div>
              {:else}
                <!-- Placeholder shown between "user hit send" and "first
                     token arrived" — gives the composer submit some
                     immediate feedback that something is happening.
                     Wrapper centers the inline-flex Scanner inside the
                     bubble so it doesn't read as a stranded artifact in
                     the top-left corner. -->
                <div class="thinking">
                  <Scanner label="Thinking" />
                </div>
              {/if}
            </div>
          {/if}
          {#if messages.length === 0 && !streamingText && !sending}
            <div class="empty">Type a message to begin.</div>
          {/if}
        </div>
        {#if !followBottom && hasOverflow}
          <button
            type="button"
            class="scroll-to-bottom"
            onclick={() => {
              followBottom = true;
              scrollToBottom(true);
            }}
            title="Scroll to latest"
            aria-label="Scroll to latest"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2.5" stroke-linecap="round"
                 stroke-linejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        {/if}
      </div>
      {#if error}<p class="error" style="padding:0 1rem">{error}</p>{/if}
      <div class="composer">
        <div class="composer-shell">
          <textarea
            class="composer-textarea"
            bind:value={composer}
            bind:this={composerEl}
            onkeydown={onKeydown}
            placeholder={`Message… (${sendHint})`}
            disabled={sending}
          ></textarea>
          <div class="composer-bar" bind:this={composerBarEl}>
            <div class="composer-bar-left">
              <!-- Prompts: toggles which system prompts ride along on
                   every future send in this conversation. -->
              <button
                type="button"
                class="secondary icon-btn"
                class:active={activePromptCount > 0}
                onclick={() => {
                  modelMenuOpen = false;
                  promptsMenuOpen = !promptsMenuOpen;
                }}
                title="System prompts"
                aria-label="System prompts"
                aria-haspopup="true"
                aria-expanded={promptsMenuOpen}
                disabled={app.systemPrompts.length === 0}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <line x1="4" y1="21" x2="4" y2="14" />
                  <line x1="4" y1="10" x2="4" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12" y2="3" />
                  <line x1="20" y1="21" x2="20" y2="16" />
                  <line x1="20" y1="12" x2="20" y2="3" />
                  <line x1="1" y1="14" x2="7" y2="14" />
                  <line x1="9" y1="8" x2="15" y2="8" />
                  <line x1="17" y1="16" x2="23" y2="16" />
                </svg>
                {#if activePromptCount > 0}
                  <span class="badge" aria-hidden="true">{activePromptCount}</span>
                {/if}
              </button>

              <!-- Model picker: per-thread override, stored on threads.model. -->
              {#if currentThread}
                <button
                  type="button"
                  class="secondary model-picker-btn"
                  onclick={() => {
                    promptsMenuOpen = false;
                    modelMenuOpen = !modelMenuOpen;
                  }}
                  aria-haspopup="true"
                  aria-expanded={modelMenuOpen}
                  title={`Model: ${MODELS[currentTier].label} (${MODELS[currentTier].id})`}
                >
                  <span class="model-picker-icon" aria-hidden="true">{MODELS[currentTier].icon}</span>
                  <span class="model-picker-label">{MODELS[currentTier].label}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
              {/if}

              <!-- Tool master switch: on = every registered tool's schema
                   rides along with the next send; off = only toggle_tools.
                   Pulses on LLM-initiated flips via .flash (see CSS). -->
              {#if currentThread && !currentThread.isDraft}
                <button
                  type="button"
                  class="secondary toolbox-btn"
                  class:on={currentThread.tools_enabled}
                  class:flash={toolboxFlash}
                  onclick={toggleToolsManually}
                  title={currentThread.tools_enabled
                    ? 'Tools ON — click to disable'
                    : 'Tools OFF — click to enable'}
                  aria-label={currentThread.tools_enabled ? 'Disable tools' : 'Enable tools'}
                  aria-pressed={currentThread.tools_enabled}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" stroke-width="2"
                       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M3 7h18v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                    <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    <line x1="3" y1="12" x2="21" y2="12" />
                    <line x1="10" y1="12" x2="10" y2="14" />
                    <line x1="14" y1="12" x2="14" y2="14" />
                  </svg>
                </button>
              {/if}
            </div>

            <button
              class="send-btn composer-send"
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

            {#if promptsMenuOpen}
              <div class="composer-menu composer-menu-left" role="menu">
                <div class="menu-header">Active for this conversation</div>
                {#each app.systemPrompts as p (p.id)}
                  <label class="menu-item">
                    <input
                      type="checkbox"
                      checked={activePromptIds.has(p.id)}
                      onchange={() => togglePrompt(p.id)}
                    />
                    <span class="menu-item-label">{p.name || '(unnamed)'}</span>
                    {#if p.enabledByDefault}<span class="menu-item-badge">default</span>{/if}
                  </label>
                {/each}
                {#if app.systemPrompts.length === 0}
                  <div class="menu-empty">No prompts — add some in Settings.</div>
                {/if}
              </div>
            {/if}

            {#if modelMenuOpen && currentThread}
              <div class="composer-menu composer-menu-left" role="menu">
                <div class="menu-header">Model for this conversation</div>
                {#each TIERS as tier (tier)}
                  <button
                    type="button"
                    class="menu-item menu-item-btn"
                    class:selected={currentTier === tier}
                    onclick={() => {
                      void setTier(tier);
                      modelMenuOpen = false;
                    }}
                    role="menuitemradio"
                    aria-checked={currentTier === tier}
                  >
                    <span class="menu-item-icon" aria-hidden="true">{MODELS[tier].icon}</span>
                    <span class="menu-item-label">
                      <strong>{MODELS[tier].label}</strong>
                      <span class="subtle" style="display:block;font-size:0.75rem">{MODELS[tier].id}</span>
                    </span>
                    {#if tier === defaultTier}<span class="menu-item-badge">default</span>{/if}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      </div>
    </main>
  </div>
{/if}
