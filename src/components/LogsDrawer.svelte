<!--
  Right-edge logs panel. On desktop it's an in-flow grid column
  inside .shell (mirror of the threads sidebar on the left); on
  mobile it collapses into a fixed-position overlay drawer with a
  click-to-dismiss backdrop. Opened from the scroll-icon button on
  the right end of the top bar in Chat.svelte. Wired via the
  `logsDrawer` singleton in `$lib/logger.svelte.ts` - this component
  reads `logsDrawer.state.open` and `logs.entries` reactively. The
  panel is always mounted; visibility is driven by the
  `.shell.logs-open` class on the parent (grid column expansion on
  desktop, transform translate on mobile). Layout/positioning CSS
  lives in styles.css next to the sidebar's rules so both side
  panels share one source of truth.

  ExtractedTextDrawer next door is still a pure overlay - it's a
  read-this-then-go-away preview, not a debugging companion that
  earns its own column.

  Backdrop dismisses on click (mobile only - on desktop there is no
  backdrop because the panel takes layout space). Escape closes from
  any focus context.

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
  import {
    logs,
    logsDrawer,
    LOG_LEVELS,
    LOG_LEVEL_LABELS,
    type LogEntry,
    type LogLevel,
  } from '$lib/logger.svelte';
  import { app } from '$lib/state.svelte';

  const drawer = logsDrawer;

  // Visible-level threshold. `debug` is the most permissive (shows
  // all); stepping up hides the lower tiers. Matches devtools-console
  // filter semantics so users don't have to re-learn the dropdown.
  // Seeded from app.defaultLogLevel and re-seeded every time the
  // drawer opens, so the Appearance setting is the source of truth
  // at open time. Users can still override within a session; the
  // override lasts until close/reopen.
  let levelFilter = $state<LogLevel>(app.defaultLogLevel);

  // Multi-token search mode. The search string is split on whitespace
  // into independent needles; `or` matches entries hitting any needle,
  // `and` matches only entries hitting every needle. Both lose the
  // adjacency-match behaviour of a single literal substring - users
  // who want a literal "foo bar" phrase have to drop the space.
  // Default is `or` because that's the discovery-friendly mode (typing
  // a second token broadens, not narrows). Re-seeded on each open so
  // a stray toggle doesn't carry across sessions.
  let matchMode = $state<'or' | 'and'>('or');

  $effect(() => {
    if (drawer.state.open) {
      levelFilter = app.defaultLogLevel;
      matchMode = 'or';
    }
  });

  let search = $state('');

  // Per-entry expand state. Keyed by entry id so opening a detail on
  // entry #42 stays open when new entries push in at the tail. A Set
  // rather than a Map because we only track "is it expanded" - no
  // per-entry payload to carry.
  let expanded = $state<Set<number>>(new Set());

  // Rank levels so the filter can do a numeric >= check. Kept local
  // to the component because no other site needs this ordering.
  // `trace` sits below `debug` so picking the Trace+ tier widens the
  // filter to include the per-cycle worker breadcrumbs.
  const LEVEL_RANK: Record<LogLevel, number> = {
    trace: -1,
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  function entryMatches(
    e: LogEntry,
    threshold: LogLevel,
    needles: string[],
    mode: 'or' | 'and'
  ): boolean {
    if (LEVEL_RANK[e.level] < LEVEL_RANK[threshold]) return false;
    if (needles.length === 0) return true;
    const hay = (
      (e.source ?? '') + ' ' + e.message + ' ' + detailsHaystack(e.details)
    ).toLowerCase();
    if (mode === 'and') {
      return needles.every((n) => hay.includes(n.toLowerCase()));
    }
    return needles.some((n) => hay.includes(n.toLowerCase()));
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

  // Whitespace-split tokens. Empty tokens (from leading / trailing /
  // double spaces) are dropped so the user doesn't accidentally match
  // every entry just by hitting space.
  const needles = $derived(
    search.trim().split(/\s+/).filter((s) => s.length > 0)
  );

  const visible = $derived(
    logs.entries.filter((e) => entryMatches(e, levelFilter, needles, matchMode))
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
      searchMode: matchMode,
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

  // Split `text` into runs of unmatched/matched substrings against the
  // current search needles. Caller renders matched runs inside <mark>
  // for the search-highlight band, unmatched runs as plain text. Empty
  // needle list short-circuits to a single unmatched run so an empty
  // filter produces no DOM churn vs. the pre-highlight render.
  //
  // Multi-needle highlighting: collect every match range across every
  // needle, sort by start, merge overlaps, then walk the merged ranges
  // to emit segments. Highlights are mode-agnostic - in OR mode we mark
  // whichever needle hit; in AND mode every needle hit by definition,
  // so the same logic produces the right rendering for both.
  function highlightSegments(
    text: string,
    queryNeedles: string[]
  ): Array<{ text: string; match: boolean }> {
    if (queryNeedles.length === 0 || text.length === 0) {
      return [{ text, match: false }];
    }
    const hay = text.toLowerCase();
    const ranges: Array<[number, number]> = [];
    for (const n of queryNeedles) {
      if (n.length === 0) continue;
      const find = n.toLowerCase();
      let i = 0;
      while (i < text.length) {
        const at = hay.indexOf(find, i);
        if (at === -1) break;
        ranges.push([at, at + n.length]);
        i = at + n.length;
      }
    }
    if (ranges.length === 0) return [{ text, match: false }];
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) {
        last[1] = Math.max(last[1], r[1]);
      } else {
        merged.push([r[0], r[1]]);
      }
    }
    const out: Array<{ text: string; match: boolean }> = [];
    let cursor = 0;
    for (const [s, e] of merged) {
      if (s > cursor) out.push({ text: text.slice(cursor, s), match: false });
      out.push({ text: text.slice(s, e), match: true });
      cursor = e;
    }
    if (cursor < text.length) out.push({ text: text.slice(cursor), match: false });
    return out;
  }

  function toggleExpanded(id: number): void {
    // Re-assign the Set so Svelte sees it as a new value; mutating in
    // place wouldn't retrigger the $state proxy for Set-typed fields.
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  function onBackdropKey(e: KeyboardEvent): void {
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

<!-- Backdrop is always in the DOM but hidden via CSS on desktop and
     when the panel is closed; only shows on mobile while
     .shell.logs-open. Keeping it mounted means the background-fade
     transition has a stable starting state to animate from. -->
<button
  type="button"
  class="logs-backdrop"
  aria-label="Close logs"
  tabindex={drawer.state.open ? 0 : -1}
  aria-hidden={!drawer.state.open}
  onclick={() => drawer.close()}
  onkeydown={onBackdropKey}
></button>
<!-- inert + aria-hidden when closed: the panel is always in the DOM
     so the parent grid can animate column width, but focus, screen
     readers, and pointer events should treat it as gone until open. -->
<aside
  class="logs-drawer"
  aria-label="Application logs"
  aria-hidden={!drawer.state.open}
  inert={!drawer.state.open}
>
    <header class="logs-header">
      <h2 class="logs-title">Logs</h2>
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
      <!-- Two-row layout: both dropdowns on row 1, search input plus
           Copy/Clear on row 2. Earlier we paired the level dropdown
           with Copy/Clear and put Any/All next to the search input,
           but the search was elastic enough to push Copy/Clear into
           wrapping below it on narrow drawer widths. Grouping the
           dropdowns on their own row lets the search be the only
           greedy element on row 2, so Copy/Clear stay anchored at
           the right edge regardless of viewport width. -->
      <div class="logs-controls-row">
        <label class="logs-level">
          <span class="visually-hidden">Minimum level</span>
          <select bind:value={levelFilter} aria-label="Minimum log level">
            {#each LOG_LEVELS as level (level)}
              <option value={level}>{LOG_LEVEL_LABELS[level]}</option>
            {/each}
          </select>
        </label>
        <!-- Search syntax is whitespace-tokenised, case-insensitive
             substring per token. The mode select decides whether an
             entry has to hit any token (Any) or every token (All).
             It sits on row 1 with the level dropdown because both
             affect what the search input below filters - reading
             top-to-bottom, the user picks the level threshold and
             match mode, then types the query. -->
        <label class="logs-mode">
          <span class="visually-hidden">Match mode</span>
          <select bind:value={matchMode} aria-label="Search match mode">
            <option value="or">Any</option>
            <option value="and">All</option>
          </select>
        </label>
      </div>
      <div class="logs-controls-row">
        <!-- The three input attributes below stop mobile keyboards
             (iOS Safari especially) from auto-capitalizing the first
             letter, auto-correcting tokens like `id` -> `Id`, and
             rendering red squiggles under code identifiers.
             autocorrect="off" is Safari-specific but harmless
             elsewhere. -->
        <input
          type="search"
          class="logs-search"
          placeholder="Search (space-separated)"
          bind:value={search}
          aria-label="Search logs"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
        />
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
                <span class="log-source"
                  >[{#each highlightSegments(entry.source, needles) as seg}{#if seg.match}<mark
                        class="log-mark">{seg.text}</mark>{:else}{seg.text}{/if}{/each}]</span
                >
              {/if}
              <span class="log-message"
                >{#each highlightSegments(entry.message, needles) as seg}{#if seg.match}<mark
                      class="log-mark">{seg.text}</mark>{:else}{seg.text}{/if}{/each}</span
              >
            </div>
            {#each inlineStringDetails(entry.details) as s}
              <div class="log-inline-detail"
                >{#each highlightSegments(s, needles) as seg}{#if seg.match}<mark
                      class="log-mark">{seg.text}</mark>{:else}{seg.text}{/if}{/each}</div
              >
            {/each}
            {#if hasStructured && isOpen}
              <div class="log-structured">
                {#each structuredDetails(entry.details) as d}
                  <pre class="log-structured-block"
                    >{#each highlightSegments(formatStructured(d), needles) as seg}{#if seg.match}<mark
                          class="log-mark">{seg.text}</mark>{:else}{seg.text}{/if}{/each}</pre>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
</aside>

<style>
  /* Layout / positioning of .logs-drawer + .logs-backdrop lives in
     src/styles.css alongside the threads-sidebar rules so both side
     panels share one source of truth. The styles below own only the
     panel's internal rendering (header, controls, entry list). */

  .logs-backdrop {
    /* Visible only on mobile while .shell.logs-open (see styles.css).
       Buttons get a default 1px border + padding from the global form
       reset; clear it so the backdrop is a flat tappable surface. */
    border: 0;
    padding: 0;
    cursor: pointer;
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

  /* Row 1 holds both filter dropdowns (level + match mode); row 2
     holds the search input and the Copy/Clear actions. The search
     is the only flex-grow item on row 2 so it absorbs all spare
     width and Copy/Clear stay pinned to the right edge without
     wrapping. */
  .logs-controls-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  /* Shared size for every control in the header. Native <select>
     chrome (especially the chevron) would otherwise render taller
     than a plain <input>, leaving the dropdown visibly out of line
     with the search box. Explicit height + box-sizing + line-height
     pins the visible box regardless of the browser's default
     padding. */
  .logs-level select,
  .logs-mode select,
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

  /* Same chevron-room treatment as the level dropdown, narrower
     min-width because "Any" / "All" are short labels - sizing it
     to 6rem like the level select would just leave dead space and
     squeeze the search input. */
  .logs-mode select {
    padding-right: 1.4rem;
    min-width: 4.2rem;
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
    /* Single knob for the whole stream. Children that used to be
       rem-based are now em-based against this so a tweak here scales
       the badge, timestamp, source tag, message, and structured
       blocks together instead of pulling them out of proportion. */
    font-size: 0.6rem;
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
    font-size: 0.88em;
    font-weight: 600;
    padding: 0 0.35rem;
    border-radius: 2px;
    letter-spacing: 0.04em;
    min-width: 2.9rem;
    text-align: center;
  }

  /* Trace lines outnumber every other tier when the user opts into
     them, so they get the dimmest treatment - lower opacity than
     debug so the eye filters them as background chatter and only
     stops on the higher-tier rows. */
  .level-trace .log-level-badge {
    background: color-mix(in srgb, var(--muted) 10%, transparent);
    color: color-mix(in srgb, var(--muted) 70%, transparent);
  }
  .level-trace .log-message,
  .level-trace .log-source,
  .level-trace .log-time {
    color: color-mix(in srgb, var(--muted) 80%, transparent);
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
    font-size: 0.92em;
  }

  .log-source {
    flex-shrink: 0;
    color: var(--accent);
    font-size: 0.92em;
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
    font-size: 0.97em;
    max-height: 40vh;
    overflow: auto;
  }

  /* Search-match highlight. `--accent-weak` is the theme's pastel
     companion to `--accent` - light pastels in light mode, dark
     accent shades in dark mode - so the band reads as a soft
     foreground tint without competing with the accent itself.
     Forcing `color: var(--text)` overrides the user-agent default
     <mark> styling (yellow bg + black text) so the matched run
     stays legible in both themes regardless of accent palette. */
  .log-mark {
    background: var(--accent-weak);
    color: var(--text);
    padding: 0 1px;
    border-radius: 2px;
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
