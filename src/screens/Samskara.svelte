<script lang="ts">
  /*
   * Samskara diagnostics modal. Read-only window into the corpus-
   * level state of the samskara pipeline: corpus counters, the
   * compound summary that's injected into every system prompt, and
   * the mood-pill legend.
   *
   * Per-user-message diagnostics (cohort fires + substrate stub for
   * one turn) live INLINE in the chat transcript via CohortPanel,
   * not here. Each user message that triggered samskaras gets a
   * pulse-icon toggle in its action row; click it to expand a panel
   * anchored to that turn. Reaching per-turn detail no longer
   * requires opening the modal at all - the modal is for everything
   * that isn't tied to a specific user message.
   *
   * Reached from the fist-icon button in the Logs drawer footer;
   * opens via `navigate({ modal: 'samskara' })` and reads `route.cid`
   * only for the per-thread Overview counters. Renders fine on the
   * empty thread-picker state because the global sections (corpus
   * counts, compound summary, mood legend) don't need a thread.
   */
  import { onMount } from 'svelte';
  import { app } from '$lib/state.svelte';
  import { route } from '$lib/routing.svelte';
  import {
    MOOD_TABLE,
    CONFIDENCE_CUT,
    cellFor,
    type MoodColumn,
  } from '$lib/samskara/events';
  import { moodState } from '$lib/samskara/mood.svelte';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  // Deliberately NO createLogger here. The diagnostics screen is the
  // observer; its own fetches would clutter the drawer the user is
  // likely watching alongside it. Errors surface in the in-component
  // `error` state instead.

  interface CompoundSummary {
    summary: string | null;
    lastRegenAt: string | null;
    samskaraCountAtRegen: number;
  }
  interface Counts {
    totalSamskaras: number;
    tier1Samskaras: number;
    tier2Samskaras: number;
    substrateInThread: number;
    firesInThread: number;
    associations: number;
  }

  let loading = $state(true);
  let error = $state<string | null>(null);
  let compound = $state<CompoundSummary | null>(null);
  let counts = $state<Counts | null>(null);
  // Snapshot route.cid ONCE at mount. The modal is full-screen so
  // the user can't switch threads without first closing us; a fresh
  // open re-runs onMount. Intentionally NOT reactive to avoid the
  // effect-retriggering stampede that an earlier version produced
  // during the cold-load path when route.cid + app.supabase were
  // both still settling.
  const threadId = route.cid;

  // Where the mood pill currently sits in MOOD_TABLE, for the
  // legend's "you are here" dot. Reads through the shared moodState
  // so it stays in lockstep with the pill the user clicked to open
  // this modal - SamskaraToasts updates moodState on every mint and
  // on the seed-from-history path, so this derived recomputes
  // automatically whenever the pill itself changes. Null when there
  // is no current mood (brand-new chat, or a thread that has never
  // fired and whose seed hasn't returned).
  const currentCell: { row: number; column: MoodColumn } | null = $derived.by(
    () => {
      const m = moodState.current;
      if (!m) return null;
      return cellFor(m.valence, m.confidence);
    }
  );

  // Two sequential queries: corpus counters + compound summary.
  // Sequential rather than Promise.all'd because supabase-js shares
  // a single auth-token lock per client; concurrent calls on the
  // cold-load path (alongside refreshSettings + the worker clients)
  // used to trip the 5s lock timeout and fail every in-flight fetch
  // with "TypeError: Failed to fetch". Sequential keeps the lock
  // uncontested. Total wall-clock is well under a second on warm
  // sessions and the modal is explicitly opened, so the latency is
  // not on a hot path.
  //
  // Each section wraps its own try/catch so a single-query failure
  // doesn't blank the whole screen.
  async function refresh(): Promise<void> {
    if (!app.supabase) {
      error = 'Not connected to Supabase yet.';
      loading = false;
      return;
    }
    loading = true;
    error = null;
    const sb = app.supabase;

    try {
      compound = await sb.samskaraGetCompoundSummary();
    } catch (err) {
      compound = null;
      error = `Compound summary: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      // When no thread is selected we still fetch corpus counters
      // with a zero-UUID stand-in, so the modal's Overview remains
      // useful on the empty state.
      const effectiveThread = threadId ?? '00000000-0000-0000-0000-000000000000';
      counts = await sb.samskaraDiagnosticsCounts(effectiveThread);
    } catch (err) {
      counts = null;
      error = error ?? `Counts: ${err instanceof Error ? err.message : String(err)}`;
    }

    loading = false;
  }

  onMount(() => {
    void refresh();
  });

  // --- formatters ---------------------------------------------------------

  function formatRelative(iso: string | null | undefined): string {
    if (!iso) return 'never';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return iso ?? 'never';
    const diffMs = Date.now() - then;
    const diffSec = Math.round(diffMs / 1000);
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.round(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.round(diffHr / 24);
    if (diffDay < 30) return `${diffDay}d ago`;
    const diffMo = Math.round(diffDay / 30);
    if (diffMo < 12) return `${diffMo}mo ago`;
    const diffYr = Math.round(diffMo / 12);
    return `${diffYr}y ago`;
  }

  // Copy-to-clipboard: build one self-contained JSON blob that
  // mirrors what the panel renders, so pasting it into a separate
  // conversation gives an assistant enough context to reason about
  // the samskara state without needing DB access. The blob includes
  // a capture timestamp + the build fingerprint so a pasted report
  // can be correlated with a specific deploy. Opaque ids are kept
  // so the reader can cross-reference against the log drawer.
  let copyState = $state<'idle' | 'copied' | 'error'>('idle');
  let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

  function buildSnapshot(): string {
    // Corpus-level snapshot: counters + compound summary. Per-user-
    // message detail (cohort fires + substrate stub for one turn)
    // is no longer aggregated here because it lives inline in the
    // chat transcript and the user's preferred snapshot path for
    // those is "open the panel under the message, screenshot or
    // paste the visible content." Re-adding a bulk export here
    // would have to re-walk the thread anyway; do it lazily when
    // someone asks.
    const snapshot = {
      capturedAt: new Date().toISOString(),
      buildCommit: __APP_COMMIT__,
      buildTime: __APP_BUILD_TIME__,
      threadId,
      counts,
      compoundSummary: compound,
    };
    return JSON.stringify(snapshot, null, 2);
  }

  // Manual trigger for the co-firing-based dedup RPC. The samskara
  // worker runs the same RPC each rotation as its `dedup` phase, so
  // this button is a "do it now without waiting for the 60s idle
  // tick" escape hatch rather than the only way collapses happen.
  // Per-call cap (20 merges) is enforced inside the RPC; click a few
  // times in a row if the diagnostic panel still shows redundancy.
  // Idempotent - a second click against a clean pool returns 0 - so
  // re-running is safe. We still confirm because it deletes rows; a
  // mistake isn't catastrophic (provenance + fires are migrated to
  // the keeper) but a surprise is worth avoiding.
  let collapseState = $state<'idle' | 'running' | 'done' | 'error'>('idle');
  let collapsedCount = $state<number | null>(null);
  let collapseResetTimer: ReturnType<typeof setTimeout> | null = null;

  async function collapseDuplicates(): Promise<void> {
    if (!app.supabase) return;
    const ok = window.confirm(
      'Consolidate samskaras?\n\n' +
        'Tier-1 samskaras that reliably co-fire in the same cohort ' +
        '(Hebbian redundancy) are merged into their oldest ' +
        'representative. Fires and provenance move with the merge; ' +
        'losers are deleted. A population-count safety cap kicks in ' +
        'if the pool is still over target after the co-firing pass. ' +
        'Capped at 20 merges per click - re-click to drain further. ' +
        'Idempotent.'
    );
    if (!ok) return;
    collapseState = 'running';
    collapsedCount = null;
    if (collapseResetTimer !== null) {
      clearTimeout(collapseResetTimer);
      collapseResetTimer = null;
    }
    try {
      const n = await app.supabase.samskaraCollapseByCofiring();
      collapsedCount = n;
      collapseState = 'done';
      // Reload so the counters + cohort list reflect the post-collapse
      // state. A user who just clicked the button wants to see the
      // outcome, not stale numbers.
      await refresh();
    } catch {
      collapseState = 'error';
    }
    collapseResetTimer = setTimeout(() => {
      collapseState = 'idle';
      collapsedCount = null;
      collapseResetTimer = null;
    }, 4000);
  }

  async function copySnapshot(): Promise<void> {
    const text = buildSnapshot();
    try {
      await navigator.clipboard.writeText(text);
      copyState = 'copied';
    } catch {
      // Fallback: some browsers (older Safari in non-secure contexts,
      // or when the Clipboard API is blocked) reject writeText. A
      // hidden textarea + execCommand('copy') still works in those
      // environments; good enough for a debug surface.
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

  // Aggregated transient feedback for the icon toolbar. The icon
  // buttons themselves never change shape, so any "Copied", "Loading",
  // "Consolidated N" message has to land in this companion span. Order
  // matters - loading wins because Refresh is the only button that
  // disables the rest, and an in-flight collapse beats a stale "Copied"
  // toast from the previous action.
  const toolbarStatus: string | null = $derived.by(() => {
    if (loading) return 'Loading…';
    if (collapseState === 'running') return 'Consolidating…';
    if (collapseState === 'done') {
      return collapsedCount === 0
        ? 'Nothing to consolidate'
        : `Consolidated ${collapsedCount}`;
    }
    if (collapseState === 'error') return 'Consolidation failed';
    if (copyState === 'copied') return 'Copied!';
    if (copyState === 'error') return 'Copy failed';
    return null;
  });
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="center samskara-backdrop"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
  <div class="samskara-shell" role="dialog" aria-modal="true" aria-label="Samskara diagnostics">
    <button
      type="button"
      class="samskara-close"
      onclick={onClose}
      aria-label="Close diagnostics"
      title="Close"
    >×</button>

    <header class="samskara-header">
      <h1 class="samskara-title">Samskara diagnostics</h1>
      <p class="subtle samskara-blurb">
        Read-only view of this chat's samskara state: fires,
        substrate, and the compound summary riding in every system
        prompt.
      </p>
      <!-- Compact icon bar. Replaced wider labeled buttons that wrapped
           to two rows on phones. Transient state (Copied, Consolidating,
           Consolidated N, etc.) lives in the polite-aria-live status
           span instead of mutating button labels - the buttons stay
           fixed-width so the bar doesn't reflow as actions resolve. -->
      <div class="samskara-toolbar">
        <button
          type="button"
          class="secondary icon-btn samskara-icon-btn"
          onclick={() => void refresh()}
          disabled={loading}
          aria-label="Refresh diagnostics"
          title="Refresh diagnostics"
        >
          <svg
            class="icon"
            class:icon-spinning={loading}
            viewBox="0 0 24 24"
            width="18"
            height="18"
            aria-hidden="true"
          >
            <path
              d="M3.5 12a8.5 8.5 0 0 1 14.5-6l2 2"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              fill="none"
            />
            <path
              d="M20 3v5h-5"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              fill="none"
            />
            <path
              d="M20.5 12a8.5 8.5 0 0 1-14.5 6l-2-2"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              fill="none"
            />
            <path
              d="M4 21v-5h5"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              fill="none"
            />
          </svg>
        </button>
        <button
          type="button"
          class="secondary icon-btn samskara-icon-btn"
          onclick={() => void copySnapshot()}
          disabled={loading}
          aria-label="Export panel snapshot to clipboard"
          title="Copy everything on this panel as a JSON blob for pasting into a chat / bug report"
        >
          <svg
            class="icon"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            aria-hidden="true"
          >
            <rect
              x="9"
              y="3"
              width="6"
              height="3"
              rx="1"
              stroke="currentColor"
              stroke-width="2"
              fill="none"
            />
            <path
              d="M9 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              fill="none"
            />
          </svg>
        </button>
        <button
          type="button"
          class="secondary icon-btn samskara-icon-btn"
          onclick={() => void collapseDuplicates()}
          disabled={loading || collapseState === 'running'}
          aria-label="Consolidate duplicate samskaras"
          title="Merge tier-1 samskaras that reliably co-fire together (primary) and trim the pool to target count (safety cap). Same RPC the background worker runs each rotation; this is the manual 'do it now' trigger. Capped at 20 merges per click."
        >
          <!-- Two parent nodes merging into one - visual shorthand for
               co-firing samskaras being consolidated into a keeper. -->
          <svg
            class="icon"
            class:icon-spinning={collapseState === 'running'}
            viewBox="0 0 24 24"
            width="18"
            height="18"
            aria-hidden="true"
          >
            <circle
              cx="6"
              cy="5"
              r="2"
              stroke="currentColor"
              stroke-width="2"
              fill="none"
            />
            <circle
              cx="18"
              cy="5"
              r="2"
              stroke="currentColor"
              stroke-width="2"
              fill="none"
            />
            <circle
              cx="12"
              cy="19"
              r="2"
              stroke="currentColor"
              stroke-width="2"
              fill="none"
            />
            <path
              d="M7 7l4 10M17 7l-4 10"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              fill="none"
            />
          </svg>
        </button>
        <span
          class="samskara-toolbar-status"
          class:visible={toolbarStatus !== null}
          aria-live="polite"
          aria-atomic="true"
        >
          {toolbarStatus ?? ''}
        </span>
      </div>
    </header>

    <section class="samskara-body">
      {#if error}
        <p class="error">{error}</p>
      {/if}

      <!-- Overview counts. Three thread-scoped numbers (substrate,
           fires, total samskaras) + three corpus-wide (total /
           tier-1 / tier-2 / associations) so you can see at a glance
           whether the pipeline is producing anything. -->
      <h2 class="pane-section">Overview</h2>
      {#if counts}
        <div class="counts-grid">
          <div class="count-card">
            <div class="count-value">{counts.totalSamskaras}</div>
            <div class="count-label">Samskaras (total)</div>
            <div class="count-sub">
              tier 1: {counts.tier1Samskaras} · tier 2: {counts.tier2Samskaras}
            </div>
          </div>
          <div class="count-card">
            <div class="count-value">{counts.associations}</div>
            <div class="count-label">Pair associations</div>
          </div>
          <div class="count-card">
            <div class="count-value">{counts.substrateInThread}</div>
            <div class="count-label">Substrate in this chat</div>
          </div>
          <div class="count-card">
            <div class="count-value">{counts.firesInThread}</div>
            <div class="count-label">Fires in this chat</div>
            <div class="count-sub">
              expand the pulse icon on each user message to see its cohort
            </div>
          </div>
        </div>
      {:else if !error}
        <p class="subtle">Loading counts…</p>
      {/if}

      <!-- Mood-pill legend. Renders the (valence x confidence) lookup
           the toast pill reads at mint time, sourced directly from
           MOOD_TABLE so the legend can never drift from the live
           mapping. The current pill position is overlaid as a
           glowing red dot on the matching cell, read from the shared
           moodState so the dot can never drift from the pill the
           user clicked to open us. Wrapped in <details> so the user
           can fold it once they've internalised the axes. Defaults
           to open because clicking the pill is the moment the
           "what does that emoji mean?" question is likeliest. -->
      <details class="mood-legend" open>
        <summary class="mood-legend-summary">
          What controls the "mood"?
        </summary>
        <p class="mood-legend-blurb">
          Each samskara carries a <strong>valence</strong> [-1, 1]
          (warm/cool) and a <strong>confidence</strong> [0, 1]. The
          pill picks the matching cell below; columns split on
          confidence at {CONFIDENCE_CUT}. The
          <span class="mood-dot-inline" aria-hidden="true"></span>
          dot marks where the pill currently sits.
        </p>
        <div class="mood-legend-table-wrap">
          <table class="mood-legend-table">
            <thead>
              <tr>
                <th class="mood-axis-y" scope="col">
                  <span class="mood-axis-label">valence</span>
                </th>
                <th scope="col">
                  confident
                  <span class="mood-axis-sub">conf &ge; {CONFIDENCE_CUT}</span>
                </th>
                <th scope="col">
                  tentative
                  <span class="mood-axis-sub">conf &lt; {CONFIDENCE_CUT}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {#each MOOD_TABLE as row, i (i)}
                <tr>
                  <th scope="row" class="mood-row-label">
                    <span class="mood-row-name">{row.confidentLabel}</span>
                    <span class="mood-row-range">
                      {#if i === 0}
                        v &ge; {row.valenceMin}
                      {:else if row.valenceMin === -Infinity}
                        v &lt; {MOOD_TABLE[i - 1].valenceMin}
                      {:else}
                        {row.valenceMin} &le; v &lt; {MOOD_TABLE[i - 1].valenceMin}
                      {/if}
                    </span>
                    <!-- Compact threshold shown on mobile in place of the
                         full label + verbose range. Just the binding bound
                         so the column stays narrow enough to read the cells. -->
                    <span class="mood-row-range-compact" aria-hidden="true">
                      {#if row.valenceMin === -Infinity}
                        &lt; {MOOD_TABLE[i - 1].valenceMin}
                      {:else}
                        &ge; {row.valenceMin}
                      {/if}
                    </span>
                  </th>
                  <td class="mood-cell">
                    <span class="mood-glyph" aria-hidden="true">{row.confidentEmoji}</span>
                    <span class="mood-cell-label">{row.confidentLabel}</span>
                    {#if currentCell && currentCell.row === i && currentCell.column === 'confident'}
                      <span
                        class="mood-dot"
                        aria-label={`Pill currently here: ${row.confidentLabel}, confidence ${(moodState.current?.confidence ?? 0).toFixed(2)}, valence ${(moodState.current?.valence ?? 0).toFixed(2)}`}
                      ></span>
                    {/if}
                  </td>
                  <td class="mood-cell">
                    <span class="mood-glyph" aria-hidden="true">{row.tentativeEmoji}</span>
                    <span class="mood-cell-label">{row.tentativeLabel}</span>
                    {#if currentCell && currentCell.row === i && currentCell.column === 'tentative'}
                      <span
                        class="mood-dot"
                        aria-label={`Pill currently here: ${row.tentativeLabel}, confidence ${(moodState.current?.confidence ?? 0).toFixed(2)}, valence ${(moodState.current?.valence ?? 0).toFixed(2)}`}
                      ></span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if currentCell && moodState.current}
          <p class="mood-legend-current subtle">
            Currently at valence {moodState.current.valence.toFixed(2)},
            confidence {moodState.current.confidence.toFixed(2)} -
            tier {moodState.current.tier}.
          </p>
        {:else}
          <p class="mood-legend-current subtle">
            No current mood reading - the pill is on its 💤 placeholder
            because nothing has fired or been minted on this thread yet.
          </p>
        {/if}
        <p class="mood-legend-foot subtle">
          Glyph collisions are intentional - the slight smile shows up
          for both confident "content" and tentative "cheerful"
          because the emoji vocabulary thins out fast on the warm
          side. Hover the pill itself for the disambiguating label.
        </p>
      </details>

      <!-- Compound summary: the prose block always injected. Shows
           what the model actually sees as its predictive-self model
           this session. Stale / empty cases rendered explicitly so
           "nothing shown" reads as data rather than a bug. -->
      <h2 class="pane-section">Compound summary (always on in system prompt)</h2>
      <p class="subtle pane-help">
        Static for the whole conversation. A background worker rebuilds
        it once enough new samskaras have been minted since the last
        regen, so the paragraph drifts between conversations rather than
        mid-thread. Each turn also gets a per-turn "fired this turn"
        bullet list appended next to this paragraph, recomputed from
        the current user message. Click the pulse icon under a user
        message in the chat transcript to inspect what fired for that
        specific turn.
      </p>
      {#if compound === null && !loading && !error}
        <p class="subtle">No compound summary yet - the worker builds one once you have ~5 samskaras.</p>
      {:else if compound}
        {#if compound.summary}
          <div class="compound-block">
            <pre class="compound-text">{compound.summary}</pre>
            <p class="subtle compound-meta">
              Covers {compound.samskaraCountAtRegen} samskara{compound.samskaraCountAtRegen === 1 ? '' : 's'} ·
              regenerated {formatRelative(compound.lastRegenAt)}
            </p>
          </div>
        {:else}
          <p class="subtle">Summary row exists but is empty. Worker hasn't written yet.</p>
        {/if}
      {/if}

    </section>
  </div>
</div>

<style>
  .samskara-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, #000 50%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
    padding: 1rem;
  }

  .samskara-shell {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow-modal);
    width: 100%;
    max-width: 52rem;
    display: grid;
    grid-template-rows: auto 1fr;
    height: min(44rem, 88vh);
    overflow: hidden;
  }

  .samskara-close {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 2;
    width: 2rem;
    height: 2rem;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 1.4rem;
    line-height: 1;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 50%;
    cursor: pointer;
  }

  .samskara-close:hover {
    background: var(--bg-2);
  }

  .samskara-header {
    padding: 1rem 1.25rem 0.75rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-2);
    /* Grid items default to min-width: auto, which lets a non-shrinking
       child (the toolbar's flex row, see below) push the header wider
       than the shell's track. The shell has overflow: hidden, so any
       overshoot manifests as the blurb and the "Consolidate"
       button getting clipped at the right edge on narrow viewports.
       Allow the header to shrink to its track. */
    min-width: 0;
  }

  .samskara-title {
    font-size: 1.1rem;
    margin: 0 0 0.25rem;
    /* Only the title row vertically overlaps the absolute-positioned
       close button (top: 0.5rem, height: 2rem, so it sits between
       0.5rem and 2.5rem from the shell top). The blurb and toolbar
       fall below the close button and can use the full header width,
       so the gutter goes here rather than on the header. */
    padding-right: 3rem;
  }

  .samskara-blurb {
    margin: 0 0 0.6rem;
    font-size: 0.85rem;
  }

  .samskara-toolbar {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    /* The three icon buttons fit inside any reasonable viewport, but
       a long status message (e.g. "Consolidated 20") still needs a
       wrap target. row-gap is tighter than column gap because wrapped
       rows don't need as much air. */
    flex-wrap: wrap;
    row-gap: 0.3rem;
  }

  /* Compact icon button used in the diagnostics toolbar. Slightly
     tighter than the global .icon-btn so three of them plus a status
     line still feel like a unit instead of a stripe of chrome. */
  .samskara-icon-btn {
    width: 1.9rem;
    height: 1.9rem;
    padding: 0.35rem;
    color: var(--text);
  }
  .samskara-icon-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .samskara-icon-btn .icon {
    display: block;
  }

  /* Spin while a long-running action is in flight - applied to the
     refresh icon during a fetch and the consolidate icon during the
     RPC. Reduced-motion users see the disabled-button opacity drop
     plus the status text and lose nothing. */
  @keyframes samskara-icon-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .icon-spinning {
    animation: samskara-icon-spin 1s linear infinite;
    transform-origin: 50% 50%;
  }
  @media (prefers-reduced-motion: reduce) {
    .icon-spinning {
      animation: none;
    }
  }

  /* Companion status string for the icon bar. Kept out of the layout
     when there's nothing to say (max-width:0 + no padding) so the bar
     stays the width of just the icons; fades in once a message is
     available. aria-live on the element itself means screen readers
     hear "Copied!" / "Consolidated 5" without us refocusing anything. */
  .samskara-toolbar-status {
    font-size: 0.78rem;
    color: var(--muted);
    margin-left: 0.2rem;
    opacity: 0;
    max-width: 0;
    overflow: hidden;
    white-space: nowrap;
    transition: opacity 160ms ease, max-width 160ms ease;
  }
  .samskara-toolbar-status.visible {
    opacity: 1;
    max-width: 16rem;
  }

  .samskara-body {
    padding: 1rem 1.25rem 1.5rem;
    overflow-y: auto;
    min-width: 0;
    font-size: 0.9rem;
  }

  .pane-section {
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin: 1.2rem 0 0.5rem;
  }
  .pane-section:first-child {
    margin-top: 0;
  }
  /* Help text under a section heading. Tucked tight to the heading so
     the relationship reads as "subtitle" rather than "first paragraph
     of body content"; uppercase pane-section above already carries the
     visual break. */
  .pane-help {
    margin: -0.2rem 0 0.6rem;
    font-size: 0.85rem;
    line-height: 1.4;
  }

  .counts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: 0.6rem;
  }

  /* Mood-pill legend. Sits just under the Overview counts because the
     click-the-pill -> open-this-modal flow is where the user is most
     likely asking "what did that emoji mean." <details>/<summary>
     gives us native dismiss-and-remember behaviour without component
     state. margin-top puts a clear gutter between this card and the
     counts-grid above so the section reads as its own block, not as
     an appendix to Overview. */
  .mood-legend {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 0.5rem 0.75rem;
    margin-top: 1.2rem;
    margin-bottom: 1rem;
  }

  .mood-legend-summary {
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    /* Native disclosure marker stays - readers expect the triangle
       to telegraph "this folds." Intrinsic contents render with the
       summary's font so summary-padding aligns with body-padding. */
    padding: 0.1rem 0;
    user-select: none;
  }

  .mood-legend-summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 2px;
  }

  .mood-legend-blurb {
    margin: 0.6rem 0 0.4rem;
    font-size: 0.85rem;
    line-height: 1.45;
  }

  /* Wrap the table so it can scroll horizontally on very narrow
     viewports rather than overflowing the modal shell. min-width
     keeps the cells readable - shrinking below this just turns the
     table into hieroglyphics. container-type enables the @container
     rule below, which drops the label column when the wrapper is too
     narrow to show the full table without scrolling. */
  .mood-legend-table-wrap {
    overflow-x: auto;
    container-type: inline-size;
  }

  .mood-legend-table {
    width: 100%;
    min-width: 22rem;
    border-collapse: collapse;
    font-size: 0.85rem;
  }

  /* Equal-width data columns. Both cells carry width: 50% so the
     browser's table-layout: auto gives them identical share of the
     space left over after the label column takes its minimum width. */
  .mood-legend-table thead th:nth-child(2),
  .mood-legend-table thead th:nth-child(3) {
    width: 50%;
  }

  /* When the wrapper is narrower than the table's min-width, the label
     column would trigger horizontal scrolling. Drop it entirely, relax
     min-width so the two data columns fill the available space, and also
     hide the word labels inside the cells - leaving only the emoji glyphs.
     Both changes fire at the same threshold: once the table is narrow
     enough to lose its row-label column, the cell text goes too. A
     separate lower threshold is impractical because padding leaves the
     wrapper no narrower than ~17rem even on a 320px phone. */
  @container (max-width: 22rem) {
    .mood-legend-table {
      min-width: 0;
    }
    .mood-legend-table th:first-child,
    .mood-legend-table td:first-child {
      display: none;
    }
    /* Higher specificity than the standalone .mood-cell-label { display: block }
       rule that appears later in this stylesheet and would otherwise win. */
    .mood-cell .mood-cell-label {
      display: none;
    }
  }

  .mood-legend-table th,
  .mood-legend-table td {
    border: 1px solid var(--border);
    padding: 0.4rem 0.55rem;
    text-align: center;
    vertical-align: middle;
  }

  .mood-legend-table thead th {
    background: var(--bg-2);
    font-weight: 600;
    font-size: 0.78rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* The top-left axis cell carries the y-axis label ("valence")
     while the column headers carry the x-axis split. Two scope=col
     headers + scope=row on the per-row band names give screen
     readers a sensible reading order without an explicit caption. */
  .mood-axis-y {
    text-align: left;
  }

  .mood-axis-label {
    display: inline-block;
    font-style: italic;
    text-transform: none;
    letter-spacing: 0;
    color: var(--muted);
  }

  .mood-axis-sub {
    display: block;
    font-size: 0.7rem;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    color: var(--muted);
    margin-top: 0.1rem;
  }

  .mood-row-label {
    text-align: left;
    background: var(--bg-2);
  }

  .mood-row-name {
    display: block;
    font-weight: 600;
  }

  .mood-row-range {
    display: block;
    font-size: 0.72rem;
    font-weight: 400;
    color: var(--muted);
    margin-top: 0.1rem;
    /* Math notation can break across the cell awkwardly on narrow
       columns; nowrap keeps each range on one line. The wrapping
       table-wrap above handles overflow at the table level. */
    white-space: nowrap;
  }

  /* Compact threshold label for mobile. Hidden on desktop where the full
     .mood-row-name + .mood-row-range is shown instead. */
  .mood-row-range-compact {
    display: none;
  }

  .mood-cell {
    /* Stack the glyph above its label so the emoji reads as the
       primary content and the disambiguating word as a caption.
       position:relative anchors the absolutely-positioned
       .mood-dot when the current pill lands in this cell. */
    line-height: 1.2;
    position: relative;
  }

  /* "You are here" dot. Absolutely positioned in the top-right
     corner of whichever .mood-cell currently matches the pill's
     (valence, confidence). Solid red with a soft red glow so it
     reads instantly against any cell color in either theme; the
     `pulse` keyframe gives a subtle breathing animation so the
     dot is noticed without being demanding. Reduced-motion
     respects users who don't want the pulse. */
  .mood-dot {
    position: absolute;
    top: 0.3rem;
    right: 0.3rem;
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    background: #ef4444;
    box-shadow:
      0 0 0 2px color-mix(in srgb, #ef4444 35%, transparent),
      0 0 8px 2px color-mix(in srgb, #ef4444 55%, transparent);
    pointer-events: none;
    animation: mood-dot-pulse 2.4s ease-in-out infinite;
  }

  @keyframes mood-dot-pulse {
    0%,
    100% {
      box-shadow:
        0 0 0 2px color-mix(in srgb, #ef4444 35%, transparent),
        0 0 6px 1px color-mix(in srgb, #ef4444 45%, transparent);
    }
    50% {
      box-shadow:
        0 0 0 3px color-mix(in srgb, #ef4444 45%, transparent),
        0 0 10px 3px color-mix(in srgb, #ef4444 70%, transparent);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .mood-dot {
      animation: none;
    }
  }

  /* Inline dot used in the legend blurb so the prose can refer to
     "the [dot] dot" without leaving the reader to guess which
     visual we mean. Static (no pulse) since the moving dot is
     already in the table; shape and color match exactly. */
  .mood-dot-inline {
    display: inline-block;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: #ef4444;
    box-shadow:
      0 0 0 2px color-mix(in srgb, #ef4444 30%, transparent),
      0 0 4px 1px color-mix(in srgb, #ef4444 45%, transparent);
    /* Nudge to optical-center against the surrounding text. */
    vertical-align: -0.05em;
    margin: 0 0.15rem;
  }

  .mood-legend-current {
    margin: 0.5rem 0 0;
    font-size: 0.78rem;
    line-height: 1.45;
  }

  .mood-glyph {
    display: block;
    font-size: 1.6rem;
    line-height: 1.1;
    /* Same font-family hint as the toast pill - older Android
       WebView's default cascade can miss the system emoji font. */
    font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
  }

  .mood-cell-label {
    display: block;
    font-size: 0.75rem;
    color: var(--muted);
    margin-top: 0.1rem;
  }

  .mood-legend-foot {
    margin: 0.5rem 0 0;
    font-size: 0.78rem;
    line-height: 1.45;
  }

  .count-card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 0.6rem 0.75rem;
  }

  .count-value {
    font-size: 1.3rem;
    font-weight: 600;
  }

  .count-label {
    font-size: 0.78rem;
    color: var(--muted);
    margin-top: 0.2rem;
  }

  .count-sub {
    font-size: 0.72rem;
    color: var(--muted);
    margin-top: 0.15rem;
  }

  .compound-block {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 0.6rem 0.75rem;
  }

  .compound-text {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: inherit;
    font-size: 0.88rem;
    line-height: 1.45;
  }

  .compound-meta {
    margin: 0.5rem 0 0;
    font-size: 0.75rem;
  }

  /* Mobile: claw back the gutter the desktop layout was happy to spend
     so the diagnostic body actually has room for the stat cards and
     the compound-summary block. Mirrors the pattern in Journal.svelte -
     tighten the backdrop padding and the per-pane paddings instead of
     letting the modal stay 1rem-inset on a 360px screen. */
  @media (max-width: 720px) {
    .samskara-backdrop {
      padding: 0.5rem;
    }
    .samskara-header {
      padding: 0.75rem 0.85rem 0.6rem;
    }
    .samskara-title {
      padding-right: 2.75rem;
    }
    .samskara-body {
      padding: 0.85rem 0.85rem 1.25rem;
    }
    .count-card,
    .compound-block {
      padding: 0.5rem 0.6rem;
    }
    /* Drop the auto-fit minimum so two narrow stat cards fit on a row
       instead of stacking 1-up; minmax(7rem, 1fr) still keeps the
       value+label legible at small sizes. */
    .counts-grid {
      grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
    }
    /* Mood map: hide the verbose label + range in the first column and
       show the compact threshold instead. This collapses the label
       column enough that both data columns are visible without scrolling. */
    .mood-row-name,
    .mood-row-range {
      display: none;
    }
    .mood-row-range-compact {
      display: block;
      font-size: 0.72rem;
      font-weight: 400;
      color: var(--muted);
      white-space: nowrap;
    }
  }
</style>
