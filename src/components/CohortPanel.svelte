<!--
  CohortPanel: the per-cohort diagnostic card for one user message's
  worth of samskara fire activity. Originally lived inside the
  Samskara diagnostics modal as the "Cohort fires" section; lifted
  out here so the chat transcript can mount one panel per user
  message instead of forcing the user into the modal to inspect a
  specific turn. The modal keeps the corpus-level cards (overview,
  compound summary, mood map) and delegates per-message detail to
  this component.

  Anchored on (thread_id, user_round) via samskara_fires.user_round;
  the parent in Chat.svelte walks the transcript, numbers user
  messages 1..N, and feeds each user message its fires + substrate
  by that index. Substrate joins on user_message_id directly because
  the substrate row knows its anchor message at write time.

  Clustering: each panel receives the thread-wide cluster map from
  its parent (one RPC per thread load, not per panel). Cluster
  threshold is fixed at the documented 0.7 default - the modal's
  live slider went away with the modal section. A "Show all" toggle
  per panel bypasses clustering for the diagnostic case (paraphrase
  inspection); the cluster siblings expand inline via the chevron
  chip just like in the old modal.
-->
<script lang="ts">
  import type {
    SamskaraFireDiagnosticRow,
    SamskaraSubstrateDiagnosticRow,
  } from '$lib/supabase';

  interface ClusterView {
    seq: number;
    representative: SamskaraFireDiagnosticRow;
    siblings: SamskaraFireDiagnosticRow[];
  }

  interface Props {
    /** All fires belonging to this cohort, in any order. */
    fires: SamskaraFireDiagnosticRow[];
    /** Substrate row for the same user-message turn, if the chat
     *  loop already wrote one. Null on the in-flight window between
     *  fire-time and end-of-round, and on aborted turns where the
     *  substrate stub never landed. */
    substrate: SamskaraSubstrateDiagnosticRow | null;
    /** fire_id -> cluster assignment from samskaraClusterThreadFires.
     *  An empty map (RPC failed, or thread had nothing to cluster)
     *  falls through to one-fire-per-singleton so the panel still
     *  renders without abstraction. */
    clusterMap: Map<string, { clusterSeq: number; clusterSize: number }>;
  }
  let { fires, substrate, clusterMap }: Props = $props();

  // Per-panel state. Each cohort owns its own raw-toggle and its
  // own per-cluster expand set so opening cluster #2 in cohort A
  // doesn't shift cluster #2 in cohort B - they share no key space.
  let raw = $state(false);
  let expandedClusters = $state<Set<number>>(new Set());

  // Order fires highest-score-first so the "representative" of any
  // cluster is the strongest member. Pull min(firedAt) and the
  // shared was_confirmed off the first row - every fire in a cohort
  // shares both by construction.
  const sortedFires = $derived(
    [...fires].sort((a, b) => b.score - a.score)
  );
  const firedAt = $derived(sortedFires[0]?.firedAt ?? null);
  const wasConfirmed = $derived(sortedFires[0]?.wasConfirmed ?? null);

  const clusters: ClusterView[] = $derived.by(() => {
    const bySeq = new Map<number, SamskaraFireDiagnosticRow[]>();
    // Fires without a cluster assignment each get a unique negative
    // fallback seq so they render as their own singleton. Using ?? 0
    // would silently collapse every unassigned fire into one bucket
    // and produce duplicate each-block keys.
    let nextFallbackSeq = -1;
    for (const f of sortedFires) {
      const assigned = clusterMap.get(f.id);
      const seq = assigned?.clusterSeq ?? nextFallbackSeq--;
      const bucket = bySeq.get(seq);
      if (bucket) bucket.push(f);
      else bySeq.set(seq, [f]);
    }
    return [...bySeq.entries()]
      .map(([seq, members]) => ({
        seq,
        representative: members[0],
        siblings: members.slice(1),
      }))
      .sort((a, b) => b.representative.score - a.representative.score);
  });

  const collapsed = $derived(clusters.length < sortedFires.length);

  function toggleCluster(seq: number): void {
    const next = new Set(expandedClusters);
    if (next.has(seq)) next.delete(seq);
    else next.add(seq);
    expandedClusters = next;
  }

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

  function formatValence(v: number | null): string {
    if (v === null) return '-';
    const sign = v > 0 ? '+' : '';
    return `${sign}${v.toFixed(2)}`;
  }

  // Three-state resolution label. Null means the reaction classifier
  // hasn't scored this cohort yet - distinguish in-flight from aged-
  // out by the 10-minute resolution window the classifier uses.
  function resolutionLabel(
    confirmed: boolean | null,
    firedAtIso: string | null
  ): string {
    if (confirmed === true) return 'confirmed';
    if (confirmed === false) return 'disconfirmed';
    if (!firedAtIso) return 'pending';
    const ageMs = Date.now() - new Date(firedAtIso).getTime();
    if (ageMs < 60 * 1000) return 'waiting (in-flight)';
    if (ageMs < 10 * 60 * 1000) return 'waiting (resolution window open)';
    return 'aged out (no reaction)';
  }

  function resolutionStatusClass(confirmed: boolean | null): string {
    if (confirmed === true) return 'confirm';
    if (confirmed === false) return 'disconfirm';
    return 'pending';
  }

  function assimilationStatus(r: SamskaraSubstrateDiagnosticRow): string {
    if (r.situation === null) return 'pending assimilation';
    if (r.embeddingModel === null) return 'assimilated, pending embed';
    return 'assimilated + embedded';
  }

  function substrateStatusClass(r: SamskaraSubstrateDiagnosticRow): string {
    if (r.situation === null) return 'pending';
    if (r.embeddingModel === null) return 'partial';
    return 'done';
  }
</script>

<div class="cohort-panel">
  <header class="cohort-head">
    <span class="cohort-time">{formatRelative(firedAt)}</span>
    <span
      class="cohort-status status-{resolutionStatusClass(wasConfirmed)}"
    >
      {resolutionLabel(wasConfirmed, firedAt)}
    </span>
    <span class="cohort-count">
      {#if collapsed && !raw}
        {clusters.length} theme{clusters.length === 1 ? '' : 's'}
        from {sortedFires.length} prediction{sortedFires.length === 1 ? '' : 's'}
      {:else}
        {sortedFires.length} prediction{sortedFires.length === 1 ? '' : 's'}
      {/if}
    </span>
    {#if collapsed}
      <button
        type="button"
        class="raw-toggle"
        onclick={() => (raw = !raw)}
        title={raw
          ? 'Re-collapse this cohort by theme'
          : 'Bypass clustering and show every fire individually'}
      >
        {raw ? 'Group by theme' : 'Show all'}
      </button>
    {/if}
  </header>

  {#if raw}
    <ul class="fire-list">
      {#each sortedFires as fire (fire.id)}
        <li class="fire-row">
          {@render fireRow(fire)}
        </li>
      {/each}
    </ul>
  {:else}
    <ul class="fire-list">
      {#each clusters as cluster (cluster.seq)}
        {@const expanded = expandedClusters.has(cluster.seq)}
        <li class="fire-row">
          {@render fireRow(cluster.representative)}
          {#if cluster.siblings.length > 0}
            <button
              type="button"
              class="cluster-chip"
              aria-expanded={expanded}
              onclick={() => toggleCluster(cluster.seq)}
              title="Other predictions that fired in this cohort with cosine >= the cluster threshold to the representative"
            >
              <span class="cluster-chip-mark" aria-hidden="true">
                {expanded ? '-' : '+'}
              </span>
              {cluster.siblings.length} similar
            </button>
            {#if expanded}
              <ul class="sibling-list">
                {#each cluster.siblings as sibling (sibling.id)}
                  <li class="sibling-row">
                    {@render fireRow(sibling)}
                  </li>
                {/each}
              </ul>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if substrate}
    <!-- Substrate stub for the same round. Lives in the panel because
         it shares the same per-user-message anchor: the chat loop
         writes both at the boundaries of one turn. Lifecycle status
         tracks how far the formation worker has carried the row -
         situation/outcome filled by the assimilator, embedding model
         filled by the embedder. -->
    <div class="substrate-block">
      <header class="substrate-head">
        <span class="substrate-label">substrate</span>
        <span
          class="substrate-status status-{substrateStatusClass(substrate)}"
        >
          {assimilationStatus(substrate)}
        </span>
        {#if substrate.valence !== null}
          <span class="substrate-meta">
            valence {formatValence(substrate.valence)}
          </span>
        {/if}
      </header>
      {#if substrate.situation}
        <p class="substrate-situation">{substrate.situation}</p>
      {/if}
      {#if substrate.outcome}
        <p class="substrate-outcome subtle">
          <em>Outcome:</em>
          {substrate.outcome}
        </p>
      {/if}
    </div>
  {/if}
</div>

{#snippet fireRow(fire: SamskaraFireDiagnosticRow)}
  <div class="fire-head">
    <span class="fire-tier">T{fire.samskara?.tier ?? '?'}</span>
    <span
      class="fire-score"
      title="cosine^1.3 * sqrt(health * confidence) * sample-size bonus"
    >
      score {fire.score.toFixed(3)}
    </span>
    {#if fire.samskara}
      <span class="fire-meta">
        val {formatValence(fire.samskara.valence)} ·
        conf {fire.samskara.confidence.toFixed(2)} ·
        health {fire.samskara.health.toFixed(2)}
      </span>
    {:else}
      <span class="fire-meta subtle">samskara deleted since fire</span>
    {/if}
  </div>
  {#if fire.samskara}
    <p class="fire-prediction">{fire.samskara.prediction}</p>
    {#if fire.samskara.innerVoice}
      <p class="fire-inner-voice">
        <em>{fire.samskara.innerVoice}</em>
      </p>
    {/if}
  {/if}
{/snippet}

<style>
  .cohort-panel {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-2);
    font-size: 0.85rem;
    line-height: 1.4;
  }

  .cohort-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
  }
  .cohort-time {
    color: var(--muted);
    font-size: 0.78rem;
  }
  .cohort-status,
  .substrate-status {
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0 0.4rem;
    border-radius: 2px;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }
  .status-confirm {
    background: color-mix(in srgb, var(--accent) 20%, transparent);
    color: var(--accent);
  }
  .status-disconfirm {
    background: color-mix(in srgb, #d14343 22%, transparent);
    color: #d14343;
  }
  .status-pending {
    background: color-mix(in srgb, #d89614 22%, transparent);
    color: #d89614;
  }
  .status-partial {
    background: color-mix(in srgb, #d89614 18%, transparent);
    color: #d89614;
  }
  .status-done {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--accent);
  }
  .cohort-count {
    color: var(--muted);
    font-size: 0.78rem;
  }
  .raw-toggle {
    margin-left: auto;
    background: none;
    border: 1px solid var(--border);
    color: var(--muted);
    font-size: 0.72rem;
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
  }
  .raw-toggle:hover {
    color: var(--text);
    border-color: var(--muted);
  }

  .fire-list,
  .sibling-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .fire-row,
  .sibling-row {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    border-top: 1px dashed color-mix(in srgb, var(--border) 70%, transparent);
    padding-top: 0.35rem;
  }
  .fire-row:first-child,
  .sibling-row:first-child {
    border-top: 0;
    padding-top: 0;
  }
  .sibling-list {
    margin-top: 0.4rem;
    padding-left: 0.75rem;
    border-left: 2px solid var(--border);
  }

  .fire-head {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    font-size: 0.72rem;
    color: var(--muted);
  }
  .fire-tier {
    font-weight: 600;
    color: var(--text);
  }
  .fire-prediction {
    margin: 0;
    font-size: 0.85rem;
  }
  .fire-inner-voice {
    margin: 0;
    font-size: 0.8rem;
    color: var(--muted);
  }

  .cluster-chip {
    align-self: flex-start;
    background: none;
    border: 1px solid var(--border);
    color: var(--muted);
    font-size: 0.72rem;
    padding: 2px 8px;
    border-radius: 999px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  .cluster-chip:hover {
    color: var(--text);
    border-color: var(--muted);
  }
  .cluster-chip-mark {
    font-weight: 700;
  }

  .substrate-block {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding-top: 0.5rem;
    border-top: 1px dashed var(--border);
  }
  .substrate-head {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: baseline;
  }
  .substrate-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    font-weight: 600;
  }
  .substrate-meta {
    font-size: 0.72rem;
    color: var(--muted);
  }
  .substrate-situation,
  .substrate-outcome {
    margin: 0;
    font-size: 0.82rem;
  }
  .subtle {
    color: var(--muted);
  }
</style>
