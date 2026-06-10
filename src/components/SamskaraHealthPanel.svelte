<script lang="ts">
  /*
   * Health panel for the Samskara diagnostics tab. Makes otherwise-
   * invisible pipeline failures legible: backlog depths, lost reaction
   * signal, dead workers, staleness, inconsistencies, and windowed
   * activity rates. Everything is computed live on open from existing
   * rows - no stored history (see docs/dev/samskara.md observability
   * section).
   *
   * Composition only: every severity classification, lease-liveness
   * decision, and relative-time format is delegated to
   * `$lib/ui/samskara-browse`.
   */
  import { onMount } from 'svelte';
  import { app } from '$lib/state.svelte';
  import {
    severityFor,
    compoundStaleness,
    leaseLiveness,
    worstSeverity,
    relativeTime,
    HEALTH_THRESHOLDS,
    SAMSKARA_WORKER_KINDS,
    type Severity,
  } from '$lib/ui/samskara-browse';
  import type {
    SamskaraHealthSnapshot,
    SamskaraRates,
    SamskaraWorkerLease,
  } from '$lib/supabase';

  let loading = $state(true);
  let error = $state<string | null>(null);
  let snap = $state<SamskaraHealthSnapshot | null>(null);
  let rates = $state<SamskaraRates | null>(null);
  let leases = $state<SamskaraWorkerLease[]>([]);
  let compoundRegenAt = $state<string | null>(null);

  async function load(): Promise<void> {
    if (!app.supabase) {
      error = 'Not connected to Supabase yet.';
      loading = false;
      return;
    }
    loading = true;
    error = null;
    const sb = app.supabase;
    // Sequential, not Promise.all'd: supabase-js shares one auth-token
    // lock per client, and a cold-load burst of concurrent calls can
    // trip its 5s lock timeout (the same reason the old modal fetched
    // sequentially). These are explicitly-opened diagnostics, not a hot
    // path, so the extra wall-clock is invisible.
    try {
      snap = await sb.samskaraHealthSnapshot();
      rates = await sb.samskaraRates(7);
      leases = await sb.samskaraWorkerLeases();
      compoundRegenAt = (await sb.samskaraGetCompoundSummary())?.lastRegenAt ?? null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  // Each signal row: a label, the value, and its severity. Grouped into
  // cards in the markup. The derivations read the snapshot through the
  // primitives so the thresholds live in one place.
  const backlog = $derived(
    snap
      ? [
          { label: 'Pending assimilation', value: snap.pendingAssimilate, sev: severityFor(snap.pendingAssimilate, HEALTH_THRESHOLDS.pendingAssimilate) },
          { label: 'Pending embedding', value: snap.pendingEmbed, sev: severityFor(snap.pendingEmbed, HEALTH_THRESHOLDS.pendingEmbed) },
          { label: 'Fires aged out unresolved', value: snap.firesAgedOut, sev: severityFor(snap.firesAgedOut, HEALTH_THRESHOLDS.firesAgedOut) },
        ]
      : []
  );

  const inconsistencies = $derived(
    snap
      ? [
          { label: 'Orphan fires', value: snap.orphanFires, sev: severityFor(snap.orphanFires, HEALTH_THRESHOLDS.orphanFires) },
          { label: 'Stuck assimilate claims', value: snap.stuckAssimilateClaims, sev: severityFor(snap.stuckAssimilateClaims, HEALTH_THRESHOLDS.stuckClaims) },
          { label: 'Stuck embed claims', value: snap.stuckEmbedClaims, sev: severityFor(snap.stuckEmbedClaims, HEALTH_THRESHOLDS.stuckClaims) },
        ]
      : []
  );

  const workers = $derived(leaseLiveness(leases, SAMSKARA_WORKER_KINDS));
  const compoundSev = $derived<Severity>(compoundStaleness(compoundRegenAt));

  // Panel headline dot: the worst of every signal so a glance tells you
  // whether anything needs attention.
  const overall = $derived<Severity>(
    worstSeverity([
      ...backlog.map((b) => b.sev),
      ...inconsistencies.map((i) => i.sev),
      compoundSev,
      ...workers.map((w): Severity => (w.live ? 'ok' : 'alarm')),
    ])
  );
</script>

<div class="samskara-health">
  {#if loading}
    <p class="subtle">Loading health…</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if snap}
    <div class="health-headline">
      <span class="sev-dot sev-{overall}" aria-hidden="true"></span>
      <span>{overall === 'ok' ? 'Pipeline healthy' : overall === 'warn' ? 'Needs a look' : 'Something is stuck'}</span>
      <button type="button" class="secondary health-refresh" onclick={() => void load()}>Refresh</button>
    </div>

    <h3 class="health-group">Workers</h3>
    <div class="health-card">
      {#each workers as w (w.workerKind)}
        <div class="health-row">
          <span class="sev-dot sev-{w.live ? 'ok' : 'alarm'}" aria-hidden="true"></span>
          <span class="health-label">{w.workerKind}</span>
          <span class="health-value">{w.live ? `live, expires ${relativeTime(w.expiresAt)}` : 'no live holder'}</span>
        </div>
      {/each}
    </div>

    <h3 class="health-group">Backlog &amp; lost signal</h3>
    <div class="health-card">
      {#each backlog as row (row.label)}
        <div class="health-row">
          <span class="sev-dot sev-{row.sev}" aria-hidden="true"></span>
          <span class="health-label">{row.label}</span>
          <span class="health-value">{row.value}</span>
        </div>
      {/each}
    </div>

    <h3 class="health-group">Inconsistencies</h3>
    <div class="health-card">
      {#each inconsistencies as row (row.label)}
        <div class="health-row">
          <span class="sev-dot sev-{row.sev}" aria-hidden="true"></span>
          <span class="health-label">{row.label}</span>
          <span class="health-value">{row.value}</span>
        </div>
      {/each}
    </div>

    <h3 class="health-group">Staleness</h3>
    <div class="health-card">
      <div class="health-row">
        <span class="sev-dot sev-{compoundSev}" aria-hidden="true"></span>
        <span class="health-label">Compound summary regenerated</span>
        <span class="health-value">{relativeTime(compoundRegenAt)}</span>
      </div>
    </div>

    {#if rates}
      <h3 class="health-group">Activity (last {rates.windowDays}d)</h3>
      <div class="health-card">
        <div class="health-row">
          <span class="health-label">Mints</span>
          <span class="health-value">{rates.mints}</span>
        </div>
        <div class="health-row">
          <span class="health-label">Fires</span>
          <span class="health-value">{rates.fires}</span>
        </div>
        <div class="health-row">
          <span class="health-label">Reaction resolution</span>
          <span class="health-value">
            {rates.resolutionPct.toFixed(0)}% ({rates.resolved}/{rates.fires})
          </span>
        </div>
      </div>
    {/if}

    <h3 class="health-group">Corpus</h3>
    <div class="health-card">
      <div class="health-row">
        <span class="health-label">Samskaras</span>
        <span class="health-value">{snap.totalSamskaras} (T1 {snap.tier1} · T2 {snap.tier2})</span>
      </div>
      <div class="health-row">
        <span class="health-label">Near-dead / never-fired</span>
        <span class="health-value">{snap.nearDead} / {snap.neverFired}</span>
      </div>
      <div class="health-row">
        <span class="health-label">Substrate / associations</span>
        <span class="health-value">{snap.substrateTotal} / {snap.associations}</span>
      </div>
    </div>
  {/if}
</div>

<style>
  .samskara-health {
    padding: 0.5rem 0 1.5rem;
    font-size: 0.88rem;
  }
  .health-headline {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
  }
  .health-refresh {
    margin-left: auto;
    font-size: 0.78rem;
    padding: 0.2rem 0.5rem;
  }
  .health-group {
    font-size: 0.74rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin: 1rem 0 0.35rem;
  }
  .health-card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 0.4rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .health-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .health-label {
    color: var(--muted);
  }
  .health-value {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
  }
  /* Severity dot. Green/amber/red for ok/warn/alarm, sized to read as a
     status light next to each row without dominating. */
  .sev-dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--muted);
  }
  .sev-ok {
    background: var(--ok, #22c55e);
  }
  .sev-warn {
    background: #f59e0b;
  }
  .sev-alarm {
    background: var(--danger, #ef4444);
  }
</style>
