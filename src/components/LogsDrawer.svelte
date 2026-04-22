<!--
  Right-side drawer that renders the in-app log buffer. Opened from
  the scroll-icon button on the right end of the top bar in
  Chat.svelte. Wired via the `logsDrawer` singleton in
  `$lib/logger.svelte.ts` - this component reads
  `logsDrawer.state.open` and `logs.entries` reactively.

  Same side and size footprint as ExtractedTextDrawer. Only one of
  the two is opened at a time in practice (logs is a debugging
  tool, extracted-text is a document-reading tool), so the stacking
  case of both simultaneously open is tolerated but not optimized
  for. Overlay backdrop dismisses on click; Escape closes too. Sits
  above the transcript via fixed positioning so it overlays the
  sidebar too, not just the main column - log debugging deserves a
  full-height panel regardless of whether the threads sidebar is
  currently showing.

  Entry rendering strategy:
  - Plain-string details render inline as a second line under the
    message (no expander needed).
  - Structured details (Error instances, plain objects, arrays) get
    an expand caret. Errors show stack; other objects get JSON.
  - Multiple details on one entry expand together under a single
    caret, pretty-printed one after the other.

  The level dropdown is cascading: selecting `info` shows info +
  warn + error. Selecting `debug` shows everything. Matches the
  convention of every browser devtools console.
-->
<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import {
    logs,
    logsDrawer,
    LOG_LEVELS,
    LOG_LEVEL_LABELS,
    type LogEntry,
    type LogLevel,
  } from '$lib/logger.svelte';
  import { app } from '$lib/state.svelte';
  import { navigate } from '$lib/routing.svelte';

  const drawer = logsDrawer;

  // Visible-level threshold. `debug` is the most permissive (shows
  // all); stepping up hides the lower tiers. Matches devtools-console
  // filter semantics so users don't have to re-learn the dropdown.
  // Seeded from app.defaultLogLevel and re-seeded every time the
  // drawer opens, so the Appearance setting is the source of truth
  // at open time. Users can still override within a session; the
  // override lasts until close/reopen.
  let levelFilter = $state<LogLevel>(app.defaultLogLevel);

  $effect(() => {
    if (drawer.state.open) levelFilter = app.defaultLogLevel;
  });

  let search = $state('');

  // Per-entry expand state. Keyed by entry id so opening a detail on
  // entry #42 stays open when new entries push in at the tail. A Set
  // rather than a Map because we only track "is it expanded" - no
  // per-entry payload to carry.
  let expanded = $state<Set<number>>(new Set());

  // Rank levels so the filter can do a numeric >= check. Kept local
  // to the component because no other site needs this ordering.
  const LEVEL_RANK: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  function entryMatches(e: LogEntry, threshold: LogLevel, needle: string): boolean {
    if (LEVEL_RANK[e.level] < LEVEL_RANK[threshold]) return false;
    if (needle.length === 0) return true;
    const hay = (e.source ?? '') + ' ' + e.message + ' ' + detailsHaystack(e.details);
    return hay.toLowerCase().includes(needle.toLowerCase());
  }

  function detailsHaystack(details: unknown[]): string {
    // Flatten details into a searchable string. Errors contribute
    // their message + stack; objects contribute their JSON; anything
    // else falls back to String(). Best-effort: a huge nested object
    // still searches in O(n) so this stays predictable.
    const parts: string[] = [];
    for (const d of details) {
      if (d instanceof Error) {
        parts.push(d.message);
        if (d.stack) parts.push(d.stack);
        continue;
      }
      if (typeof d === 'string') {
        parts.push(d);
        continue;
      }
      try {
        parts.push(JSON.stringify(d));
      } catch {
        parts.push(String(d));
      }
    }
    return parts.join(' ');
  }

  const visible = $derived(
    logs.entries.filter((e) => entryMatches(e, levelFilter, search.trim()))
  );

  // Copy-to-clipboard for the currently-filtered entry set. Feeds
  // the same "paste a JSON blob into chat" workflow as the
  // Samskara diagnostics panel; keeps what the user is looking at,
  // not the full raw buffer, so a search-narrowed view doesn't
  // bury the 10 relevant lines under 1990 unrelated ones. Details
  // are normalized to a clone-safe shape because Error instances
  // and circular objects don't survive JSON.stringify cleanly.
  let copyState = $state<'idle' | 'copied' | 'error'>('idle');
  let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

  function normalizeDetail(d: unknown): unknown {
    if (d instanceof Error) {
      return { name: d.name, message: d.message, stack: d.stack ?? null };
    }
    if (d === null || typeof d !== 'object') return d;
    try {
      // Round-trip through JSON to strip functions / symbols /
      // non-enumerable props and catch circular refs early.
      return JSON.parse(JSON.stringify(d));
    } catch {
      try {
        return String(d);
      } catch {
        return '[unserializable]';
      }
    }
  }

  function buildLogSnapshot(): string {
    const payload = {
      capturedAt: new Date().toISOString(),
      buildCommit: __APP_COMMIT__,
      buildTime: __APP_BUILD_TIME__,
      levelFilter,
      searchFilter: search,
      totalEntries: logs.entries.length,
      shownEntries: visible.length,
      entries: visible.map((e) => ({
        id: e.id,
        timestamp: new Date(e.timestamp).toISOString(),
        level: e.level,
        source: e.source,
        message: e.message,
        details: e.details.map(normalizeDetail),
      })),
    };
    return JSON.stringify(payload, null, 2);
  }

  async function copyLogs(): Promise<void> {
    const text = buildLogSnapshot();
    try {
      await navigator.clipboard.writeText(text);
      copyState = 'copied';
    } catch {
      // Fallback for browsers that reject writeText (old Safari,
      // non-secure contexts). Same shape the Samskara panel uses.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        copyState = 'copied';
      } catch {
        copyState = 'error';
      } finally {
        document.body.removeChild(ta);
      }
    }
    if (copyResetTimer !== null) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      copyState = 'idle';
      copyResetTimer = null;
    }, 2000);
  }

  function formatTimestamp(ms: number): string {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const mss = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${mss}`;
  }

  function hasStructuredDetails(details: unknown[]): boolean {
    // Plain-string details render inline under the message; anything
    // else (Error, object, array, number, ...) gets the expander.
    return details.some((d) => typeof d !== 'string');
  }

  function inlineStringDetails(details: unknown[]): string[] {
    return details.filter((d): d is string => typeof d === 'string');
  }

  function structuredDetails(details: unknown[]): unknown[] {
    return details.filter((d) => typeof d !== 'string');
  }

  function formatStructured(d: unknown): string {
    if (d instanceof Error) {
      // Show the stack if we have one; otherwise fall back to the
      // name+message line so the entry still conveys something.
      return d.stack && d.stack.length > 0
        ? d.stack
        : `${d.name}: ${d.message}`;
    }
    try {
      return JSON.stringify(d, null, 2);
    } catch {
      return String(d);
    }
  }

  function toggleExpanded(id: number): void {
    // Re-assign the Set so Svelte sees it as a new value; mutating in
    // place wouldn't retrigger the $state proxy for Set-typed fields.
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  function onOverlayKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') drawer.close();
  }

  // Escape anywhere closes the drawer - same pattern as
  // ExtractedTextDrawer. Scoped to document because focus may sit in
  // the search field or a log row when the user hits Escape.
  $effect(() => {
    if (!drawer.state.open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') drawer.close();
    };
    document.addEventListener('keydown', handler);
    return (): void => document.removeEventListener('keydown', handler);
  });

  // Scroll pin to bottom. When the drawer is open and the user is
  // already near the bottom, new entries should keep the view pinned
  // so the stream feels like `tail -f`. When the user has scrolled
  // up to read earlier entries, don't yank them back - matches the
  // behavior of the main message list.
  let bodyEl: HTMLDivElement | undefined = $state();
  let followTail = $state(true);

  function onBodyScroll(): void {
    const el = bodyEl;
    if (!el) return;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 16;
    followTail = nearBottom;
  }

  $effect(() => {
    // Track the entries length; when it changes and we're tailing,
    // scroll to bottom after the DOM settles. visible.length not
    // logs.entries.length so filtering-while-streaming also tails
    // correctly.
    const _ = visible.length;
    void _;
    if (!drawer.state.open) return;
    if (!followTail) return;
    queueMicrotask(() => {
      const el = bodyEl;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
  });
</script>

{#if drawer.state.open}
  <button
    type="button"
    class="logs-overlay"
    aria-label="Close logs"
    onclick={() => drawer.close()}
    onkeydown={onOverlayKey}
    transition:fade={{ duration: 150, easing: cubicOut }}
  ></button>
  <aside
    class="logs-drawer"
    aria-label="Application logs"
    transition:fly={{ x: 360, duration: 220, easing: cubicOut }}
  >
    <header class="logs-header">
      <h2 class="logs-title">Logs</h2>
      <!-- Samskara diagnostics shortcut. Icon is a stylized fist -
           "Summary of inner turmoil for this chat" per the original
           ask. Closes the drawer on click because the modal it opens
           takes the full screen; reopening the drawer after is a
           deliberate user action. -->
      <button
        type="button"
        class="secondary icon-btn"
        aria-label="Samskara diagnostics"
        title="Samskara diagnostics"
        onclick={() => {
          drawer.close();
          navigate({ modal: 'samskara' });
        }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
             fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round">
          <!-- Closed fist, knuckles up, thumb wrapped on the left.
               The four vertical strokes read as curled fingers; the
               half-circle on the left is the thumb bulge. -->
          <rect x="6" y="10" width="13" height="9" rx="2" />
          <line x1="9.5" y1="12.5" x2="9.5" y2="16.5" />
          <line x1="12.5" y1="12.5" x2="12.5" y2="16.5" />
          <line x1="15.5" y1="12.5" x2="15.5" y2="16.5" />
          <path d="M6 13c-2 0-2 3 0 3" />
        </svg>
      </button>
      <button
        type="button"
        class="secondary icon-btn"
        aria-label="Close"
        onclick={() => drawer.close()}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            d="M6 6l12 12M18 6L6 18"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            fill="none"
          />
        </svg>
      </button>
    </header>
    <div class="logs-controls">
      <!-- Two-row layout: compact controls on top, full-width search
           below. The level dropdown was truncating to 'Det' on the
           single-row version because flex competition with the
           grow-1 search input left it auto-sizing against its
           initially-measured content. Splitting the rows gives the
           dropdown room to breathe and keeps Clear reachable on
           narrow viewports without a horizontal scroll. -->
      <div class="logs-controls-row">
        <label class="logs-level">
          <span class="visually-hidden">Minimum level</span>
          <select bind:value={levelFilter} aria-label="Minimum log level">
            {#each LOG_LEVELS as level (level)}
              <option value={level}>{LOG_LEVEL_LABELS[level]}</option>
            {/each}
          </select>
        </label>
        <div class="logs-row-actions">
          <button
            type="button"
            class="secondary logs-copy"
            onclick={() => void copyLogs()}
            title="Copy the currently filtered entries as a JSON blob for pasting into chat / a bug report"
          >
            {#if copyState === 'copied'}
              Copied!
            {:else if copyState === 'error'}
              Copy failed
            {:else}
              Copy
            {/if}
          </button>
          <button
            type="button"
            class="secondary logs-clear"
            onclick={() => {
              logs.clear();
              expanded = new Set();
            }}
            title="Clear all log entries"
          >
            Clear
          </button>
        </div>
      </div>
      <div class="logs-controls-row">
        <input
          type="search"
          class="logs-search"
          placeholder="Search"
          bind:value={search}
          aria-label="Search logs"
        />
      </div>
    </div>
    <div
      class="logs-body"
      bind:this={bodyEl}
      onscroll={onBodyScroll}
    >
      {#if visible.length === 0}
        <p class="logs-empty">
          {logs.entries.length === 0
            ? 'No log entries yet.'
            : 'No entries match the current filter.'}
        </p>
      {:else}
        {#each visible as entry (entry.id)}
          {@const hasStructured = hasStructuredDetails(entry.details)}
          {@const isOpen = expanded.has(entry.id)}
          <div class="log-entry level-{entry.level}">
            <div class="log-entry-head">
              {#if hasStructured}
                <button
                  type="button"
                  class="log-caret"
                  aria-expanded={isOpen}
                  aria-label={isOpen ? 'Collapse details' : 'Expand details'}
                  onclick={() => toggleExpanded(entry.id)}
                >
                  <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
                    {#if isOpen}
                      <path d="M6 15l6-6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none" />
                    {:else}
                      <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none" />
                    {/if}
                  </svg>
                </button>
              {:else}
                <span class="log-caret-spacer" aria-hidden="true"></span>
              {/if}
              <span class="log-level-badge">{entry.level.toUpperCase()}</span>
              <time class="log-time">{formatTimestamp(entry.timestamp)}</time>
              {#if entry.source}
                <span class="log-source">[{entry.source}]</span>
              {/if}
              <span class="log-message">{entry.message}</span>
            </div>
            {#each inlineStringDetails(entry.details) as s}
              <div class="log-inline-detail">{s}</div>
            {/each}
            {#if hasStructured && isOpen}
              <div class="log-structured">
                {#each structuredDetails(entry.details) as d}
                  <pre class="log-structured-block">{formatStructured(d)}</pre>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  </aside>
{/if}

<style>
  .logs-overlay {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--bg) 55%, transparent);
    /* Sit above the transcript and sidebar but below the drawer itself
       so a click on the drawer doesn't dismiss it. */
    z-index: 40;
    border: 0;
    padding: 0;
    cursor: pointer;
  }

  /* Right-anchored so the scroll-icon button on the right end of the
     top bar opens a panel that visually extends from the pointer.
     Shell bg + left-facing shadow match the sidebar's mirror-image
     styling on the opposite edge. */
  .logs-drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(520px, 96vw);
    display: flex;
    flex-direction: column;
    background: var(--bg-2);
    border-left: 1px solid var(--border);
    box-shadow: -8px 0 24px color-mix(in srgb, #000 18%, transparent);
    z-index: 41;
  }

  .logs-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 0.9rem;
    border-bottom: 1px solid var(--border);
  }

  .logs-title {
    flex: 1 1 auto;
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }

  .logs-controls {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.5rem 0.9rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }

  /* Row 1 spaces the level dropdown and Clear button to opposite
     ends so there's a visible separation between "filter what's
     shown" and "destroy what's shown". Row 2 is just the search
     input stretched to the full drawer width. */
  .logs-controls-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .logs-controls-row:first-child {
    justify-content: space-between;
  }

  /* Shared size for every control in the header. Native <select>
     chrome (especially the chevron) would otherwise render taller
     than a plain <input>, leaving the dropdown visibly out of line
     with the search box. Explicit height + box-sizing + line-height
     pins the visible box regardless of the browser's default
     padding. */
  .logs-level select,
  .logs-search,
  .logs-copy,
  .logs-clear {
    box-sizing: border-box;
    height: 28px;
    line-height: 1.2;
    font-size: 0.8rem;
    padding: 0 0.5rem;
  }

  /* Group Copy + Clear so they read as a pair of row-1 actions
     rather than independent items competing with the dropdown for
     attention. Gap matches the controls-row's own gap so the
     visual rhythm stays uniform across the whole header. */
  .logs-row-actions {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  /* Reserve room for the native chevron so the selected label
     doesn't crowd it, and a min-width so every option in
     LOG_LEVEL_LABELS (widest is "Debug+") fits even though some
     browsers auto-size the select from the currently-selected
     option rather than the widest. */
  .logs-level select {
    padding-right: 1.6rem;
    min-width: 6rem;
  }

  .logs-search {
    flex: 1 1 auto;
    min-width: 0;
    width: 100%;
  }

  .logs-body {
    flex: 1 1 auto;
    overflow: auto;
    padding: 0.4rem 0;
    font-family: var(--font-mono, ui-monospace, Menlo, Consolas, monospace);
    font-size: 0.7rem;
    line-height: 1.4;
    background: var(--bg);
  }

  .logs-empty {
    margin: 0;
    padding: 0.9rem;
    color: var(--muted);
    font-style: italic;
    font-family: var(--font-sans, inherit);
  }

  .log-entry {
    padding: 0.25rem 0.75rem;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
    word-break: break-word;
  }

  .log-entry-head {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .log-caret,
  .log-caret-spacer {
    width: 14px;
    height: 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .log-caret {
    background: transparent;
    border: 0;
    padding: 0;
    color: var(--muted);
    cursor: pointer;
    border-radius: 2px;
  }

  .log-caret:hover {
    color: var(--text);
  }

  .log-level-badge {
    flex-shrink: 0;
    font-size: 0.62rem;
    font-weight: 600;
    padding: 0 0.35rem;
    border-radius: 2px;
    letter-spacing: 0.04em;
    min-width: 2.9rem;
    text-align: center;
  }

  .level-debug .log-level-badge {
    background: color-mix(in srgb, var(--muted) 18%, transparent);
    color: var(--muted);
  }
  .level-info .log-level-badge {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    color: var(--accent);
  }
  .level-warn .log-level-badge {
    background: color-mix(in srgb, #d89614 22%, transparent);
    color: #d89614;
  }
  .level-error .log-level-badge {
    background: color-mix(in srgb, #d14343 22%, transparent);
    color: #d14343;
  }

  .log-time {
    flex-shrink: 0;
    color: var(--muted);
    font-size: 0.64rem;
  }

  .log-source {
    flex-shrink: 0;
    color: var(--accent);
    font-size: 0.64rem;
  }

  .log-message {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--text);
    white-space: pre-wrap;
  }

  .log-inline-detail {
    margin: 0.1rem 0 0 calc(14px + 0.4rem);
    color: color-mix(in srgb, var(--text) 80%, var(--muted));
    white-space: pre-wrap;
  }

  .log-structured {
    margin: 0.25rem 0 0.25rem calc(14px + 0.4rem);
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .log-structured-block {
    margin: 0;
    padding: 0.4rem 0.55rem;
    background: var(--bg-2);
    border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
    border-radius: var(--radius, 4px);
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.68rem;
    max-height: 40vh;
    overflow: auto;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    border: 0;
  }
</style>
