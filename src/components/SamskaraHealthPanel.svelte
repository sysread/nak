<script lang="ts">
  /*
   * Overview surface for the Samskara diagnostics tab: the global,
   * always-on read on what the pipeline has formed and whether it is
   * working. Two things stacked on one page (they were two separate
   * top-bar surfaces before - a Summary page and a Health page - which
   * read as redundant since both are global per-user reads):
   *
   *   1. The compound summary - the prose block that rides in every
   *      system prompt - at the top, below the refresh row.
   *   2. Pipeline health - backlog depths, staleness, inconsistencies,
   *      windowed activity rates, corpus shape, and whether a tier-2
   *      candidate is currently offerable. Computed live on open from
   *      existing rows, no stored history (see docs/dev/samskara.md
   *      observability section).
   *
   * One Refresh reloads BOTH - the summary and every health read - so
   * the page is a single coherent snapshot, not two stale halves.
   *
   * Composition only: the severity classification, regen status, and
   * count-to-label transforms are delegated to
   * `$lib/ui/samskara-health`; the relative-time format comes from
   * `$lib/ui/samskara-browse`, shared with the detail pane.
   */
  import { onMount } from 'svelte';
  import { app } from '$lib/state.svelte';
  import {
    severityFor,
    compoundRegenStatus,
    worstSeverity,
    healthHeadline,
    verdictBreakdown,
    tier2CandidateLabel,
    samskaraCountPhrase,
    HEALTH_THRESHOLDS,
    type Severity,
  } from '$lib/ui/samskara-health';
  import { relativeTime } from '$lib/ui/samskara-browse';
  import type { SamskaraHealthSnapshot, SamskaraRates } from '$lib/supabase';

  let loading = $state(true);
  let error = $state<string | null>(null);
  let snap = $state<SamskaraHealthSnapshot | null>(null);
  let rates = $state<SamskaraRates | null>(null);
  // The always-on compound prose block, shown at the top of the page.
  let compound = $state<{
    summary: string | null;
    lastRegenAt: string | null;
    samskaraCountAtRegen: number;
  } | null>(null);
  // How many tier-1 members the tier-2 detector would currently offer
  // the minter (0 = none). Surfaced so the "is detection finding
  // uncovered constellations?" question is visible without a self-join.
  let tier2CandidateSize = $state(0);

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
      compound = await sb.samskaraGetCompoundSummary();
      tier2CandidateSize = await sb.samskaraTier2CandidateSize();
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

  // Compound-summary regen health is the event-count backlog (samskaras
  // formed since the last regen vs the regen threshold), NOT the summary's
  // age - see compoundRegenStatus for why age is a false positive on an
  // idle account.
  const compoundRegen = $derived(
    compoundRegenStatus(snap?.totalSamskaras ?? 0, compound?.samskaraCountAtRegen ?? 0, !!compound?.summary)
  );

  // Panel headline dot: the worst of the ACTIONABLE signals - backlog
  // depth, internal inconsistencies, compound-regen backlog.
  const overall = $derived<Severity>(
    worstSeverity([
      ...backlog.map((b) => b.sev),
      ...inconsistencies.map((i) => i.sev),
      compoundRegen.sev,
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
      <span>{healthHeadline(overall)}</span>
      <button type="button" class="secondary health-refresh" onclick={() => void load()}>Refresh</button>
    </div>

    <!-- Compound summary: the always-on prose block, at the top of the
         page below the refresh row. This is the global read - "what does
         Nak think of me, overall?" - rebuilt in the background as new
         samskaras form, so it drifts between conversations rather than
         mid-thread. Refresh (above) reloads it alongside the health
         reads. -->
    <h3 class="health-group">Compound summary <span class="health-group-note">(always on in system prompt)</span></h3>
    <section class="health-summary">
      {#if compound?.summary}
        <div class="health-summary-block">
          <pre class="health-summary-text">{compound.summary}</pre>
          <p class="subtle health-summary-meta">
            Covers {samskaraCountPhrase(compound.samskaraCountAtRegen)} ·
            regenerated {relativeTime(compound.lastRegenAt)}
          </p>
        </div>
      {:else}
        <p class="subtle">
          No compound summary yet - it is built in the background once
          enough samskaras have formed.
        </p>
      {/if}
    </section>

    <h3 class="health-group">Backlog</h3>
    <div class="health-card">
      {#each backlog as row (row.label)}
        <div class="health-row">
          <span class="sev-dot sev-{row.sev}" aria-hidden="true"></span>
          <span class="health-label">{row.label}</span>
          <span class="health-value">{row.value}</span>
        </div>
      {/each}
      <!-- Informational, not thresholded / not in `backlog`: the next-day
           judge's backlog starts large (every pre-redesign fire) and drains
           over time, so a static severity would false-alarm the headline
           during the expected drain. -->
      <div class="health-row">
        <span class="health-label">Awaiting judgment</span>
        <span class="health-value">{snap.firesAwaitingJudgment}</span>
      </div>
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
      {#if compound?.summary}
        <!-- Dotted signal: the regen backlog (new samskaras since the last
             regen vs the threshold the background job fires at), NOT the
             age below it. Age can't drive the dot - regen only runs when
             the sweep visits an active user, so a stale-but-idle summary is
             benign (see compoundRegenStatus). -->
        <div class="health-row">
          <span class="sev-dot sev-{compoundRegen.sev}" aria-hidden="true"></span>
          <span class="health-label">New samskaras since summary</span>
          <span class="health-value">{compoundRegen.delta} / {compoundRegen.threshold}</span>
        </div>
        <!-- Informational, not dotted: when the summary last rebuilt. Useful
             context, but age alone is not a health signal. -->
        <div class="health-row">
          <span class="health-label">Summary last regenerated</span>
          <span class="health-value">{relativeTime(compound.lastRegenAt)}</span>
        </div>
      {:else}
        <div class="health-row">
          <span class="sev-dot sev-{compoundRegen.sev}" aria-hidden="true"></span>
          <span class="health-label">Compound summary</span>
          <span class="health-value">not built yet</span>
        </div>
      {/if}
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
          <span class="health-label">Judged</span>
          <span class="health-value">
            {rates.resolutionPct.toFixed(0)}% ({rates.resolved}/{rates.fires})
          </span>
        </div>
        <div class="health-row">
          <span class="health-label">Verdicts</span>
          <span class="health-value health-value--stack">
            {#each verdictBreakdown(rates) as v (v.label)}
              <span>{v.count} {v.label}</span>
            {/each}
          </span>
        </div>
      </div>
      <p class="health-note subtle">
        Fires are judged the next day by the evaluation sweep, against the
        whole settled conversation - so a recent fire whose thread is still
        same-day (or under 2 rounds) simply hasn't been judged yet.
      </p>
    {/if}

    <h3 class="health-group">Corpus</h3>
    <div class="health-card">
      <div class="health-row">
        <span class="health-label">Samskaras</span>
        <span class="health-value">{snap.totalSamskaras} (T1 {snap.tier1} · T2 {snap.tier2})</span>
      </div>
      <!-- Informational, not thresholded: a non-empty candidate is GOOD
           (detection is finding an uncovered constellation to compound),
           and "none" is the normal resting state, so neither warrants a
           severity dot. This is the readout that makes the tier-2
           detector's liveness visible - an empty result with few tier-2s
           used to require a manual self-join to diagnose. -->
      <div class="health-row">
        <span class="health-label">Tier-2 candidate</span>
        <span class="health-value">{tier2CandidateLabel(tier2CandidateSize)}</span>
      </div>
      <div class="health-row">
        <span class="health-label">Near-dead / never-fired</span>
        <span class="health-value">{snap.nearDead} / {snap.neverFired}</span>
      </div>
      <div class="health-row">
        <span class="health-label">Substrate / associations</span>
        <span class="health-value">
          {snap.substrateTotal} / {snap.associations} ({snap.associationsUnconsumed} awaiting mint)
        </span>
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
  /* Lowercase parenthetical rider on a group heading (the heading itself
     is uppercased); text-transform: none keeps it readable as prose. */
  .health-group-note {
    text-transform: none;
    font-weight: 400;
    letter-spacing: 0;
  }
  /* Compound-summary block. The summary is the page's primary reading
     content, so the prose inherits the root 1rem size (no font-size
     override) to match message / wiki / memory body text rather than the
     0.88rem the diagnostics rows use. */
  .health-summary-block {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 0.6rem 0.75rem;
  }
  .health-summary-text {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: inherit;
    font-size: 1rem;
    line-height: 1.45;
  }
  .health-summary-meta {
    margin: 0.5rem 0 0;
    font-size: 0.75rem;
  }
  .health-note {
    margin: 0.35rem 0 0;
    font-size: 0.78rem;
    line-height: 1.4;
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
  /* Verdict breakdown stacks its counts vertically, right-aligned,
     instead of one slash-joined line - the joined form wrapped
     mid-slash on narrow viewports. */
  .health-value--stack {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.1rem;
  }
  /* Severity dot. Green/amber/red for ok/warn/alarm, sized to read as a
     status light next to each row without dominating. */
  .sev-dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: var(--radius-round);
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
