<script lang="ts">
  /*
   * Main panel for the Samskara diagnostics tab. Read-only operator
   * observability surface (see docs/dev/samskara.md observability
   * section): the in-chat experience stays opaque; this is the
   * deliberately-opened window into what the pipeline has formed and
   * whether it's working.
   *
   * Two surfaces, NO sub-nav:
   *
   *   - Overview - the DEFAULT landing page (SamskaraHealthPanel). The
   *     GLOBAL per-user read, reached on tab-open and via the single
   *     top-bar Overview button in Chat.svelte: the always-on compound
   *     summary prose block stacked above corpus-wide pipeline health
   *     (silent-failure detection over the whole pipeline). The summary
   *     and health used to be two separate top-bar surfaces; they read
   *     as redundant - both are global - so they were merged into this
   *     one page, summary on top.
   *   - Corpus - detail of the samskara selected in the sidebar,
   *     including its provenance (for a tier-2, its tier-1 children).
   *
   * The sidebar (SamskaraBrowseList) drives `route.samskara_id`;
   * selecting a row switches into Corpus so the detail shows. The
   * top-bar button flips `triggerOverviewView` to jump back to the
   * global surface (clearing the selection so the sidebar deselects,
   * matching how the global read shouldn't leave a stale per-instinct
   * selection highlighted).
   */
  import { app } from '$lib/state.svelte';
  import { route, navigate } from '$lib/routing.svelte';
  import { samskaraBrowseStore } from '$lib/samskara-browse-store.svelte';
  import {
    tierBadge,
    formatValence,
    relativeTime,
    groupProvenance,
    verdictCountList,
    engagementSummary,
    releaseStatus,
  } from '$lib/ui/samskara-browse';
  import type { SamskaraProvenanceRow, SamskaraVerdictCounts } from '$lib/supabase';
  import SamskaraHealthPanel from '../components/SamskaraHealthPanel.svelte';

  interface Props {
    /**
     * Top-bar Overview button in Chat.svelte flips this to true to jump
     * back to the global Overview landing page (compound summary +
     * pipeline health). The panel switches to the Overview surface,
     * clears any selected samskara so the sidebar deselects, and resets
     * the flag. `$bindable` so the reset is visible to the parent
     * without a dedicated callback prop - same pattern as the wiki
     * changelog trigger.
     */
    triggerOverviewView?: boolean;
  }
  let {
    triggerOverviewView = $bindable(false),
  }: Props = $props();

  // Overview is the default surface (global, per-user; the summary +
  // health page). Corpus is the per-samskara detail reached by selecting
  // a sidebar row. No sub-nav. The per-conversation mood graph lives in
  // its own modal (opened from the mood pill), not here.
  type SubView = 'overview' | 'corpus';
  let subView = $state<SubView>('overview');

  // Selecting a samskara in the sidebar means "show me this one" - switch
  // into Corpus so its detail renders rather than leaving the user on
  // Summary/Health wondering why their click did nothing. Guarded on a
  // truthy id so clearing the selection (e.g. the Summary button below)
  // doesn't yank the view back to Corpus. Fires on a deep link with a
  // samskara_id already in the URL too, which correctly lands on Corpus.
  $effect(() => {
    if (route.samskara_id) subView = 'corpus';
  });

  // Top-bar Overview button -> the landing page. Clear the selection so
  // the sidebar deselects and a later re-click of the same row is seen
  // as a fresh selection (it re-sets samskara_id, re-tripping the effect
  // above). Clearing to null is guarded out of that effect, so the two
  // don't fight. The compound summary the Overview surface shows is
  // loaded by SamskaraHealthPanel itself (and reloaded by its Refresh),
  // so there's nothing to fetch here.
  $effect(() => {
    if (triggerOverviewView) {
      subView = 'overview';
      if (route.samskara_id) navigate({ samskara_id: null });
      triggerOverviewView = false;
    }
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

  // Group provenance by kind so a mixed-provenance samskara (substrate +
  // association, the association-mint case) renders one headed section
  // per kind instead of mislabeling the whole list off the first row.
  const provenanceGroups = $derived(groupProvenance(provenance));

  // Lifetime verdict tally for the selected samskara. The stats dl shows
  // the discounted confirm/disconfirm posterior inputs; this shows the
  // raw count by verdict so the soft-miss (not-borne-out) bucket is
  // legible rather than folded into disconfirm. Loaded on selection, same
  // best-effort shape as provenance - a failure leaves it null and the
  // section just doesn't render.
  let verdictCounts = $state<SamskaraVerdictCounts | null>(null);
  const engagement = $derived(verdictCounts ? engagementSummary(verdictCounts) : null);
  $effect(() => {
    const id = route.samskara_id;
    if (!id || !app.supabase) {
      verdictCounts = null;
      return;
    }
    let cancelled = false;
    void app.supabase
      .samskaraVerdictCounts(id)
      .then((c) => {
        if (!cancelled) verdictCounts = c;
      })
      .catch(() => {
        if (!cancelled) verdictCounts = null;
      });
    return () => {
      cancelled = true;
    };
  });
</script>

<div class="samskara-panel">
  <div class="samskara-panel-body">
    {#if subView === 'overview'}
      <!-- Overview surface: the default landing page. The compound
           summary block stacked above corpus-wide pipeline health, plus
           a short orientation. Global (per-user) - the place to answer
           "what does Nak think of me, overall, and is the machinery
           working?" The panel owns its own loads + Refresh. The
           per-conversation mood graph lives in the mood modal, not
           here. -->
      <p class="samskara-summary-intro">
        As you chat, Nak quietly forms <strong>samskaras</strong> -
        one-line predictive instincts about you, each of the shape "in
        situations like X, this user tends to Y." They're distilled in
        the background from your conversations; when a new message
        resembles a samskara's situation, it fires and nudges Nak's
        reply. Browse the individual instincts in the list to the left;
        below is the global read - the always-on compound summary and the
        forming pipeline's health.
      </p>
      <SamskaraHealthPanel />
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

        {#if verdictCounts}
          <!-- Lifetime verdict tally. The confirm/disconfirm above are
               the recency-discounted posterior inputs; this is the raw
               count by verdict, so not-borne-out (the soft miss) reads
               next to held / contradicted / not-engaged instead of
               vanishing into the disconfirm number. -->
          <dl class="samskara-stats samskara-verdicts">
            {#each verdictCountList(verdictCounts) as v (v.label)}
              <div><dt>{v.label}</dt><dd>{v.count}</dd></div>
            {/each}
            {#if engagement && engagement.ratePct !== null}
              <!-- Engagement rate: the share of judged fires that
                   genuinely engaged. Low is normal (wide-K firing is
                   mostly loose topical matches), but zero across many
                   judged fires is what marks a claim for release. -->
              <div>
                <dt>engagement</dt>
                <dd>{engagement.ratePct}% ({engagement.genuine}/{engagement.judged})</dd>
              </div>
            {/if}
          </dl>
          <!-- Decay standing: whether this row is established evidence
               or on a release path (45-day probation for never-tested
               claims, cap-pressure eviction for fired-but-never-engaged
               ones). Mirrors the SQL release machinery's guards. -->
          <p class="samskara-release subtle">
            {releaseStatus(selected.createdAt, verdictCounts, Date.now())}
          </p>
        {/if}

        {#if provLoading}
          <h3 class="samskara-prov-head">Provenance</h3>
          <p class="subtle">Loading provenance…</p>
        {:else if provenance.length === 0}
          <h3 class="samskara-prov-head">Provenance</h3>
          <p class="subtle">No provenance recorded.</p>
        {:else}
          {#each provenanceGroups as group (group.kind)}
            <h3 class="samskara-prov-head">{group.heading}</h3>
            <ul class="samskara-prov-list">
              {#each group.rows as p (p.kind + p.refId)}
                <li>
                  {#if p.kind === 'samskara' && p.refTier}
                    <span class="samskara-prov-badge">T{p.refTier}</span>
                  {/if}
                  <span class="samskara-prov-label">{p.label ?? '(removed)'}</span>
                </li>
              {/each}
            </ul>
          {/each}
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
  /* No max-width: the intro wraps to the natural container width, the
     same as the health panel below it. An artificial reading column
     here left the intro narrow while the panel under it ran full-width,
     which read as broken alignment. No explicit font-size either - the
     body prose inherits the 1rem root size, the same reading size .msg /
     .wiki-content / .memory-card-data use. The compound summary block
     itself now lives in SamskaraHealthPanel (the Overview surface), not
     here. */
  .samskara-summary-intro {
    margin: 0 0 1.1rem;
    line-height: 1.55;
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
    border-radius: var(--radius-pill);
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
  /* Verdict tally reuses the stats grid but is set off by a top rule and
     tighter top margin so it reads as a related sub-block under the core
     stats rather than a second equal-weight section. */
  .samskara-verdicts {
    margin-top: 0;
    padding-top: 0.6rem;
    border-top: 1px dashed color-mix(in srgb, var(--border) 70%, transparent);
  }
  /* Decay-standing line: rides directly under the verdict tally as a
     one-line caption, not a separate section. */
  .samskara-release {
    margin: 0 0 0.8rem;
    font-size: 0.8rem;
    line-height: 1.4;
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
