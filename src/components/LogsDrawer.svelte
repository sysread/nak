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
    type LogLevel,
  } from '$lib/logger.svelte';
  import { app } from '$lib/state.svelte';
  import {
    availableSources as availableSourcesFn,
    buildLogSnapshot,
    emptyMessage,
    entryMatches,
    formatStructured,
    formatTimestamp,
    hasStructuredDetails,
    highlightSegments,
    inlineStringDetails,
    nearBottom,
    splitNeedles,
    structuredDetails,
  } from '$lib/ui/logs-drawer';

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

  // Source tag filter. Empty string is the "All sources" sentinel; any
  // other value is an exact match against entry.source. Populated
  // dynamically from the current buffer (see `availableSources` below)
  // so the dropdown only ever offers tags that actually appear -
  // typing `embed-worker` in the search box would also work, but the
  // dropdown surfaces what's there without making the user remember
  // exact spellings. Re-seeded on each open like the other filters.
  let sourceFilter = $state('');

  $effect(() => {
    if (drawer.state.open) {
      levelFilter = app.defaultLogLevel;
      matchMode = 'or';
      sourceFilter = '';
    }
  });

  let search = $state('');

  // Per-entry expand state. Keyed by entry id so opening a detail on
  // entry #42 stays open when new entries push in at the tail. A Set
  // rather than a Map because we only track "is it expanded" - no
  // per-entry payload to carry.
  let expanded = $state<Set<number>>(new Set());

  const needles = $derived(splitNeedles(search));

  const visible = $derived(
    logs.entries.filter((e) =>
      entryMatches(e, {
        levelFilter,
        matchMode,
        sourceFilter,
        needles,
      })
    )
  );

  const availableSources = $derived(availableSourcesFn(logs.entries));

  // Copy-to-clipboard for the currently-filtered entry set. Feeds
  // the same "paste a JSON blob into chat" workflow as the
  // Samskara diagnostics panel; keeps what the user is looking at,
  // not the full raw buffer, so a search-narrowed view doesn't
  // bury the 10 relevant lines under 1990 unrelated ones. Two-state
  // only: 'copied' flashes the checkmark glyph, 'idle' shows the
  // copy glyph. A clipboard failure (denied permission, insecure
  // context, both writeText AND the textarea fallback throwing) bails
  // without flashing - the absence of the checkmark is itself the
  // failure signal, matching CopyButton.svelte's convention.
  let copyState = $state<'idle' | 'copied'>('idle');
  let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

  async function copyLogs(): Promise<void> {
    const text = JSON.stringify(
      buildLogSnapshot({
        capturedAt: new Date().toISOString(),
        buildCommit: __APP_COMMIT__,
        buildTime: __APP_BUILD_TIME__,
        levelFilter,
        matchMode,
        sourceFilter,
        search,
        visibleEntries: visible,
      }),
      null,
      2
    );
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
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
        ok = true;
      } catch {
        // Both paths failed - bail silently per the convention
        // documented on copyState above.
      } finally {
        document.body.removeChild(ta);
      }
    }
    if (!ok) return;
    copyState = 'copied';
    if (copyResetTimer !== null) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      copyState = 'idle';
      copyResetTimer = null;
    }, 1500);
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
    followTail = nearBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
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
      <!-- Three-row layout: level + mode dropdowns on row 1, source
           dropdown on row 2, search input plus Copy/Clear on row 3.
           Earlier we paired the level dropdown with Copy/Clear and
           put Any/All next to the search input, but the search was
           elastic enough to push Copy/Clear into wrapping below it
           on narrow drawer widths. Grouping the dropdowns on their
           own row lets the search be the only greedy element on the
           search row, so Copy/Clear stay anchored at the right edge.
           The source dropdown gets its own row because tag names
           ("conversation-recall-agent", "attachment-expiry-worker")
           are long enough that squeezing them onto row 1 would
           truncate on a ~280px mobile drawer. -->
      <div class="logs-controls-row">
        <label class="logs-level">
          <span class="visually-hidden">Minimum level</span>
          <select name="logs-level" bind:value={levelFilter} aria-label="Minimum log level">
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
          <select name="logs-match-mode" bind:value={matchMode} aria-label="Search match mode">
            <option value="or">Any</option>
            <option value="and">All</option>
          </select>
        </label>
      </div>
      <!-- Row 2: source-tag filter. Populated dynamically from the
           current buffer so it only ever offers tags that actually
           appear. Disabled (with the "All sources" placeholder
           greyed out) when the buffer has no entries with a source
           yet - keeps the row's vertical footprint stable instead of
           popping in once the first worker breadcrumb lands, which
           would shift the search row down mid-read. -->
      <div class="logs-controls-row">
        <label class="logs-source">
          <span class="visually-hidden">Source tag</span>
          <select
            name="logs-source"
            bind:value={sourceFilter}
            aria-label="Filter by source tag"
            disabled={availableSources.length === 0}
          >
            <option value="">All sources</option>
            {#each availableSources as src (src)}
              <option value={src}>{src}</option>
            {/each}
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
          name="logs-search"
          class="logs-search"
          placeholder="Search (space-separated)"
          bind:value={search}
          aria-label="Search logs"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
        />
        <div class="logs-row-actions">
          <!-- Copy + Clear share the message-card .copy-btn surface so
               the panel's icon controls read as one family with the
               assistant-bubble action row. Copy flips its glyph to
               a checkmark on success (matches CopyButton.svelte);
               Clear is a trash glyph - destructive but unguarded by
               design, the in-memory log buffer is cheap to repopulate
               and an extra confirm dialog would add friction users
               typically resent for a debugging tool. -->
          <button
            type="button"
            class="copy-btn"
            class:copied={copyState === 'copied'}
            onclick={() => void copyLogs()}
            aria-label={copyState === 'copied' ? 'Copied' : 'Copy logs'}
            title="Copy the currently filtered entries as a JSON blob for pasting into chat / a bug report"
          >
            {#if copyState === 'copied'}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
                   aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            {:else}
              <!-- Two-overlapping-pages glyph; mirrors the icon used by
                   CopyButton.svelte so the surfaces read identically. -->
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                   aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            {/if}
          </button>
          <button
            type="button"
            class="copy-btn logs-clear"
            onclick={() => {
              logs.clear();
              expanded = new Set();
              // Drop the source filter too - whatever tag was picked
              // is no longer in the buffer, and leaving it set would
              // either show "no entries match" or, depending on the
              // browser, default-display the first remaining option
              // while sourceFilter still holds the gone-away value.
              sourceFilter = '';
            }}
            aria-label="Clear logs"
            title="Clear all log entries"
          >
            <!-- Trash-can glyph (lid + bin + two interior strokes).
                 Matches the lucide trash icon used elsewhere in the
                 ecosystem and reads as "discard" without needing a
                 label. -->
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                 aria-hidden="true">
              <path d="M3 6h18" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
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
          {emptyMessage(logs.entries.length, visible.length)}
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
  .logs-source select,
  .logs-search {
    box-sizing: border-box;
    height: 28px;
    line-height: 1.2;
    font-size: 0.8rem;
    padding: 0 0.5rem;
  }

  /* Group Copy + Clear so they read as a pair of row-2 actions
     pinned to the right of the search input. Gap matches the
     controls-row's own gap so the visual rhythm stays uniform
     across the whole header. */
  .logs-row-actions {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  /* Pin the icon buttons to the same 28px height as the search
     input so the row reads as one continuous control strip. The
     base .copy-btn rule (in styles.css) sizes itself from padding
     + the 14px SVG, which lands a couple pixels short - explicit
     height + square aspect keeps the buttons visually aligned with
     the input regardless of theme. */
  .logs-row-actions .copy-btn {
    box-sizing: border-box;
    height: 28px;
    width: 28px;
    padding: 0;
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

  /* Source dropdown stretches to the full row width because tag
     names like "conversation-recall-agent" run ~13em and would
     otherwise truncate against the native chevron. Own row in the
     header (see the markup comment) so the level + mode dropdowns
     above stay at their fixed widths and aren't pulled wider by
     this one's growth. */
  .logs-source {
    flex: 1 1 auto;
    min-width: 0;
  }
  .logs-source select {
    width: 100%;
    padding-right: 1.6rem;
  }
  /* Greyed-out look while the buffer has no sourced entries yet -
     the row is still mounted so the search row below doesn't
     reflow into a different spot once the first worker log lands.
     Browsers vary on default disabled-select appearance, so set
     the colour + cursor explicitly. */
  .logs-source select:disabled {
    color: var(--muted);
    opacity: 0.6;
    cursor: not-allowed;
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
    /* Inherit the root's Lekton-first monospace stack rather than
       declaring our own - using a separate font-family override here
       (with a --font-mono variable that's never actually defined)
       was routing the stream to Menlo, which read as a foreign
       typeface against the Lekton-rendered message cards in the same
       view. Whatever the root picks for body copy is the right choice
       for the drawer too. */
    /* Single knob for the whole stream. Children that used to be
       rem-based are now em-based against this so a tweak here scales
       the badge, timestamp, source tag, message, and structured
       blocks together instead of pulling them out of proportion. */
    font-size: 0.55rem;
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
    border-radius: var(--radius-xs);
  }

  .log-caret:hover {
    color: var(--text);
  }

  .log-level-badge {
    flex-shrink: 0;
    font-size: 0.88em;
    font-weight: 600;
    padding: 0 0.35rem;
    border-radius: var(--radius-xs);
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
    border-radius: var(--radius);
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
    border-radius: var(--radius-xs);
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
