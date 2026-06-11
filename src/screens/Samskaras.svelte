<script lang="ts">
  /*
   * Main panel for the Samskara diagnostics tab. Read-only operator
   * observability surface (see docs/dev/samskara.md observability
   * section): the in-chat experience stays opaque; this is the
   * deliberately-opened window into what the pipeline has formed and
   * whether it's working.
   *
   * Two sub-views: Corpus (detail of the samskara selected in the
   * sidebar, including its provenance - for a tier-2 that's its tier-1
   * children) and Health (the SamskaraHealthPanel). The sidebar
   * (SamskaraBrowseList) drives `route.samskara_id`.
   *
   * The compound-summary + mood-legend still live in the standalone
   * Samskara diagnostics modal; folding those in as a third sub-view and
   * retiring the modal is a follow-up.
   */
  import { onMount } from 'svelte';
  import { app } from '$lib/state.svelte';
  import { route } from '$lib/routing.svelte';
  import { samskaraBrowseStore } from '$lib/samskara-browse-store.svelte';
  import {
    tierBadge,
    formatValence,
    relativeTime,
  } from '$lib/ui/samskara-browse';
  import type { SamskaraProvenanceRow } from '$lib/supabase';
  import SamskaraHealthPanel from '../components/SamskaraHealthPanel.svelte';

  // The tab is corpus-global by design: Corpus, Health, and the always-on
  // compound Summary. The per-conversation mood graph lives in its own
  // modal (opened from the mood pill), not here.
  type SubView = 'corpus' | 'health' | 'summary';
  let subView = $state<SubView>('corpus');

  // Compound summary for the Summary sub-view - the always-on prose block
  // that rides in every system prompt (per-user, global - hence the tab).
  let compound = $state<{ summary: string | null; lastRegenAt: string | null; samskaraCountAtRegen: number } | null>(null);
  let compoundLoading = $state(false);

  onMount(() => {
    if (!app.supabase) return;
    compoundLoading = true;
    void app.supabase
      .samskaraGetCompoundSummary()
      .then((c) => (compound = c))
      .catch(() => (compound = null))
      .finally(() => (compoundLoading = false));
  });

  const selected = $derived(
    route.samskara_id
      ? samskaraBrowseStore.results.find((r) => r.id === route.samskara_id) ?? null
      : null
  );

  let provenance = $state<SamskaraProvenanceRow[]>([]);
  let provLoading = $state(false);

  // Load provenance whenever the selected samskara changes. A failure
  // just leaves the list empty - provenance is supplementary detail, not
  // load-bearing for the rest of the panel.
  $effect(() => {
    const id = route.samskara_id;
    if (!id || !app.supabase) {
      provenance = [];
      return;
    }
    let cancelled = false;
    provLoading = true;
    void app.supabase
      .samskaraProvenanceDetail(id)
      .then((rows) => {
        if (!cancelled) provenance = rows;
      })
      .catch(() => {
        if (!cancelled) provenance = [];
      })
      .finally(() => {
        if (!cancelled) provLoading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  function provenanceHeading(kind: SamskaraProvenanceRow['kind']): string {
    if (kind === 'samskara') return 'Compounded from (tier-1 children)';
    if (kind === 'substrate') return 'Formed from (substrate)';
    return 'Related observations';
  }
</script>

<div class="samskara-panel">
  <div class="samskara-subnav" role="tablist" aria-label="Samskara views">
    <button
      type="button"
      class="samskara-subnav-btn"
      class:active={subView === 'corpus'}
      role="tab"
      aria-selected={subView === 'corpus'}
      onclick={() => (subView = 'corpus')}
    >Corpus</button>
    <button
      type="button"
      class="samskara-subnav-btn"
      class:active={subView === 'health'}
      role="tab"
      aria-selected={subView === 'health'}
      onclick={() => (subView = 'health')}
    >Health</button>
    <button
      type="button"
      class="samskara-subnav-btn"
      class:active={subView === 'summary'}
      role="tab"
      aria-selected={subView === 'summary'}
      onclick={() => (subView = 'summary')}
    >Summary</button>
  </div>

  <div class="samskara-panel-body">
    {#if subView === 'health'}
      <SamskaraHealthPanel />
    {:else if subView === 'summary'}
      <!-- Summary sub-view: the always-on compound block. Global
           (per-user), so it belongs on the tab. The per-conversation
           mood graph lives in the mood modal, not here. -->
      <section class="samskara-summary">
        <h3 class="samskara-summary-head">Compound summary (always on in system prompt)</h3>
        <p class="subtle samskara-summary-help">
          A background worker rebuilds this once enough new samskaras have
          been minted since the last regen, so it drifts between
          conversations rather than mid-thread.
        </p>
        {#if compoundLoading}
          <p class="subtle">Loading summary…</p>
        {:else if compound?.summary}
          <div class="samskara-compound-block">
            <pre class="samskara-compound-text">{compound.summary}</pre>
            <p class="subtle samskara-compound-meta">
              Covers {compound.samskaraCountAtRegen} samskara{compound.samskaraCountAtRegen === 1 ? '' : 's'} ·
              regenerated {relativeTime(compound.lastRegenAt)}
            </p>
          </div>
        {:else}
          <p class="subtle">No compound summary yet - the worker builds one once you have ~5 samskaras.</p>
        {/if}
      </section>
    {:else if !selected}
      <p class="subtle samskara-empty">
        Pick a samskara from the list to inspect what the model believes,
        how confident it is, and where the belief came from.
      </p>
    {:else}
      <article class="samskara-detail">
        <header class="samskara-detail-head">
          <span class="samskara-detail-badge" class:t2={selected.tier === 2}>{tierBadge(selected.tier)}</span>
          <h2 class="samskara-detail-pred">{selected.prediction}</h2>
        </header>
        {#if selected.innerVoice}
          <p class="samskara-inner-voice"><em>{selected.innerVoice}</em></p>
        {/if}
        <dl class="samskara-stats">
          <div><dt>valence</dt><dd>{formatValence(selected.valence)}</dd></div>
          <div><dt>confidence</dt><dd>{selected.confidence.toFixed(2)}</dd></div>
          <div><dt>health</dt><dd>{selected.health.toFixed(2)}</dd></div>
          <div><dt>fired</dt><dd>{selected.fireCount}x</dd></div>
          <div><dt>confirm / disconfirm</dt><dd>{selected.confirmCount.toFixed(1)} / {selected.disconfirmCount.toFixed(1)}</dd></div>
          <div><dt>last fired</dt><dd>{relativeTime(selected.lastFiredAt)}</dd></div>
          <div><dt>created</dt><dd>{relativeTime(selected.createdAt)}</dd></div>
        </dl>

        <h3 class="samskara-prov-head">
          {provenance.length > 0 ? provenanceHeading(provenance[0].kind) : 'Provenance'}
        </h3>
        {#if provLoading}
          <p class="subtle">Loading provenance…</p>
        {:else if provenance.length === 0}
          <p class="subtle">No provenance recorded.</p>
        {:else}
          <ul class="samskara-prov-list">
            {#each provenance as p (p.kind + p.refId)}
              <li>
                {#if p.kind === 'samskara' && p.refTier}
                  <span class="samskara-prov-badge">T{p.refTier}</span>
                {/if}
                <span class="samskara-prov-label">{p.label ?? '(removed)'}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </article>
    {/if}
  </div>
</div>

<style>
  .samskara-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .samskara-subnav {
    display: flex;
    gap: 0.25rem;
    padding: 0.5rem 0.75rem 0;
    border-bottom: 1px solid var(--border);
  }
  .samskara-subnav-btn {
    padding: 0.35rem 0.75rem;
    font-size: 0.85rem;
    background: transparent;
    color: var(--muted);
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
  }
  .samskara-subnav-btn.active {
    color: var(--text);
    border-bottom-color: var(--accent);
  }
  .samskara-panel-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0.75rem 1rem;
  }
  .samskara-empty {
    max-width: 32rem;
    line-height: 1.5;
  }
  .samskara-summary-head {
    font-size: 0.74rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin: 0 0 0.3rem;
  }
  .samskara-summary-help {
    margin: 0 0 0.6rem;
    font-size: 0.85rem;
    line-height: 1.4;
  }
  .samskara-compound-block {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 0.6rem 0.75rem;
  }
  .samskara-compound-text {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: inherit;
    font-size: 0.88rem;
    line-height: 1.45;
  }
  .samskara-compound-meta {
    margin: 0.5rem 0 0;
    font-size: 0.75rem;
  }
  .samskara-detail-head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .samskara-detail-badge {
    flex-shrink: 0;
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
    background: var(--bg-2);
    color: var(--muted);
  }
  .samskara-detail-badge.t2 {
    background: color-mix(in srgb, var(--accent) 25%, transparent);
    color: var(--text);
  }
  .samskara-detail-pred {
    font-size: 1.05rem;
    margin: 0;
    line-height: 1.4;
  }
  .samskara-inner-voice {
    color: var(--muted);
    margin: 0.4rem 0 0;
  }
  .samskara-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 0.4rem 1rem;
    margin: 0.8rem 0;
  }
  .samskara-stats div {
    display: flex;
    flex-direction: column;
  }
  .samskara-stats dt {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .samskara-stats dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
  .samskara-prov-head {
    font-size: 0.74rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin: 1rem 0 0.4rem;
  }
  .samskara-prov-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .samskara-prov-list li {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
  }
  .samskara-prov-badge {
    flex-shrink: 0;
    font-size: 0.65rem;
    font-weight: 600;
    color: var(--muted);
  }
  .samskara-prov-label {
    line-height: 1.4;
  }
</style>
