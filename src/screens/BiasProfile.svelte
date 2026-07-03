<script lang="ts">
  /**
   * Bias Profile diagnostics modal. Read-only view of the
   * sweep-maintained per-user, per-bias evidence cache plus the
   * underlying per-conversation observations.
   *
   * Reached from the chart-glyph button in the bottom-right pill
   * column (sibling to the intuition brain and the samskara mood
   * pill). Opens via `navigate({ modal: 'bias-profile' })` and
   * pulls every row in bias_summary on mount.
   *
   * Four sections:
   *
   *   - Current conversation. Shows only when a thread is active.
   *     Lists the soft+strong biases that are currently shaping
   *     responses on this turn (the same RENDER_CAP-capped set the
   *     chat-loop injects into the system prompt) plus any
   *     observations and reactions the sweep has already recorded
   *     for this thread (or an explanation of why none exist yet -
   *     the thread is excluded from analysis while open).
   *
   *   - Bias landscape. One bar per catalog entry tracking the CI
   *     lower bound against the surfacing gates, for an at-a-glance
   *     comparison across the whole catalog.
   *
   *   - Per-bias evidence table. One row per catalog entry showing
   *     the tier badge, the credible-interval lower bound, the
   *     posterior mean, the effective sample size, and a preview of
   *     the system-prompt contribution (if any). Each flagged row
   *     expands to its per-observation drill-down.
   *
   *   - Recently processed conversations. Latest N (default 30)
   *     threads the sweep has analyzed, each expandable to its
   *     per-observation list.
   *
   * No write controls; the pipeline is autonomic. Display
   * decisions (sorting, the rendered set, formatters, prose
   * interpretation, chart geometry, empty-state copy) live in
   * `$lib/ui/bias-profile`; this file is Svelte wire-up.
   */
  import { onMount } from 'svelte';
  import { app } from '$lib/state.svelte';
  import { navigate, route } from '$lib/routing.svelte';
  import {
    type BiasSummaryDisplayRow,
    barWidthPct,
    biasDefinition,
    biasGuidance,
    biasHue,
    biasLabel,
    chartScale,
    currentObservationsEmptyCopy,
    currentReactionsEmptyCopy,
    displayThreadTitle,
    formatConfidence,
    formatEffectiveN,
    formatFeedback,
    formatProbability,
    formatTimestamp,
    hasEvidence,
    interpretBias,
    observationsLabel,
    reactionVerdict,
    reactionVerdictClass,
    renderedBiasRows,
    sortSummaryRows,
    tierTitle,
    IN_PROMPT_TITLE,
    reactionVerdictTitle,
  } from '$lib/ui/bias-profile';
  import {
    ALPHA_PRIOR,
    BETA_PRIOR,
    CI_LB_SOFT,
    CI_LB_STRONG,
    FEEDBACK_HALF_LIFE_DAYS,
    FEEDBACK_THRESHOLD_DELTA,
    HALF_LIFE_DAYS,
    N_EFF_FLOOR,
    RENDER_CAP,
  } from '$lib/bias/types';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  interface ProcessedThreadRow {
    threadId: string;
    title: string;
    processedAt: string;
    observationCount: number;
  }

  interface ObservationRow {
    id: string;
    bias: string;
    confidence: number;
    reasoning: string;
    evidenceMessageId: string | null;
    createdAt: string;
  }

  /** One row of `bias_reactions`, surfaced in the per-thread
   *  drill-down sections. The three-state was_confirmed matches
   *  the agent's classification: true = affirmed, false = pushed
   *  back, null = neutral / no signal. */
  interface ReactionRow {
    id: string;
    bias: string;
    wasConfirmed: boolean | null;
    reasoning: string;
    createdAt: string;
  }

  /** One observation surfaced in the per-bias drill-down. Carries
   *  the source thread's title for the navigable link plus the
   *  agent's reasoning string for the inline blockquote. */
  interface BiasObservationRow {
    id: string;
    threadId: string;
    threadTitle: string | null;
    confidence: number;
    reasoning: string;
    createdAt: string;
  }

  let summary = $state<BiasSummaryDisplayRow[]>([]);
  let processed = $state<ProcessedThreadRow[]>([]);
  // Per-bias drill-down expansion state. `expandedBiasKey` is the
  // bias whose observations are currently shown inline under its
  // row in the per-bias evidence table (only one open at a time).
  // `expandedBiasObs` holds the loaded rows; `null` means "fetch
  // in flight", `[]` means "loaded but empty" (rare - implies the
  // sweep cleared the observations between the counts load and
  // the per-bias fetch).
  let expandedBiasKey = $state<string | null>(null);
  let expandedBiasObs = $state<BiasObservationRow[] | null>(null);
  // Per-bias count of raw observations across the user's history.
  // Zero means the sweep has analyzed conversations but never
  // flagged this bias - the summary row's ci_lower is just the
  // prior's 10th-percentile (~5%) plus the cumulative no-hit mass,
  // not actual signal. Drives the "no evidence" rendering in the
  // chart, value column, and per-bias detail cards.
  let observationCounts = $state<Record<string, number>>({});
  let loading = $state(true);
  let expandedThreadId = $state<string | null>(null);
  let expandedObs = $state<ObservationRow[]>([]);
  let expandedReactions = $state<ReactionRow[]>([]);
  // Observations + reactions for the currently-open thread,
  // eagerly loaded on mount so the "Current conversation" section
  // can render without the user having to expand the thread row in
  // the processed-conversations list. Null means "not yet fetched";
  // empty array means "fetched and nothing recorded."
  let currentThreadObs = $state<ObservationRow[] | null>(null);
  let currentThreadReactions = $state<ReactionRow[] | null>(null);
  // Has the sweep analyzed the active thread yet? Drives the
  // copy under "Observations from this conversation" - we need to
  // distinguish "already analyzed, came up empty" from "not yet
  // analyzed" (which covers both the sweep-not-gotten-to-it case
  // and the brand-new-draft case where the thread row doesn't even
  // exist in the DB and the observations query trivially returns
  // []). Null while the fetch is in flight.
  let currentThreadProcessedAt = $state<string | null>(null);
  // Snapshot route.cid at mount so a thread switch behind the modal
  // doesn't yank the section's data partway through. The user can
  // close and reopen the modal to see the new thread.
  const activeThreadId = route.cid;

  onMount(async () => {
    const supabase = app.supabase;
    if (!supabase) {
      loading = false;
      return;
    }
    try {
      const [s, p, counts, threadObs, threadReactions, processedAt] = await Promise.all([
        supabase.biasListSummary(),
        supabase.biasListProcessedThreads(30),
        supabase.biasListObservationCounts(),
        activeThreadId
          ? supabase.biasListObservationsForThread(activeThreadId)
          : Promise.resolve([] as ObservationRow[]),
        activeThreadId
          ? supabase.biasListReactionsForThread(activeThreadId)
          : Promise.resolve([] as ReactionRow[]),
        activeThreadId
          ? supabase.biasGetThreadProcessedAt(activeThreadId)
          : Promise.resolve(null),
      ]);
      summary = s;
      processed = p;
      observationCounts = counts;
      currentThreadObs = activeThreadId ? threadObs : null;
      currentThreadReactions = activeThreadId ? threadReactions : null;
      currentThreadProcessedAt = processedAt;
    } finally {
      loading = false;
    }
  });

  /**
   * Expand or collapse the per-bias evidence drill-down for a
   * single bias row. Lazy-fetches observations on first expand so
   * the modal's initial mount stays cheap regardless of how much
   * history the user has accumulated. The in-flight guard handles
   * a quick re-click on a different row landing the stale
   * response under the new row's expansion.
   */
  async function toggleBiasObservations(biasKey: string): Promise<void> {
    if (expandedBiasKey === biasKey) {
      expandedBiasKey = null;
      expandedBiasObs = null;
      return;
    }
    expandedBiasKey = biasKey;
    expandedBiasObs = null;
    const supabase = app.supabase;
    if (!supabase) {
      expandedBiasObs = [];
      return;
    }
    try {
      const obs = await supabase.biasListObservationsForBiasKey(biasKey);
      if (expandedBiasKey !== biasKey) return;
      expandedBiasObs = obs;
    } catch {
      if (expandedBiasKey !== biasKey) return;
      expandedBiasObs = [];
    }
  }

  /**
   * Navigate to a thread from inside the modal. Closes the modal
   * and clears the drawer in the same route patch so the
   * conversation surface is what the user lands on - leaving the
   * modal open behind a thread switch would re-render the modal's
   * "Current conversation" section against the new thread mid-
   * interaction, which is more confusing than helpful.
   */
  function openThread(threadId: string): void {
    navigate({ cid: threadId, modal: null, drawer: null });
  }

  async function toggleThread(threadId: string): Promise<void> {
    if (expandedThreadId === threadId) {
      expandedThreadId = null;
      expandedObs = [];
      expandedReactions = [];
      return;
    }
    expandedThreadId = threadId;
    expandedObs = [];
    expandedReactions = [];
    const supabase = app.supabase;
    if (!supabase) return;
    try {
      const [obs, reactions] = await Promise.all([
        supabase.biasListObservationsForThread(threadId),
        supabase.biasListReactionsForThread(threadId),
      ]);
      // Guard against a quick re-toggle (collapse this thread,
      // or expand a different one) while the fetch was in flight -
      // without this check, the stale response would overwrite the
      // newly-active panel's data with the prior thread's
      // observations.
      if (expandedThreadId !== threadId) return;
      expandedObs = obs;
      expandedReactions = reactions;
    } catch {
      if (expandedThreadId !== threadId) return;
      expandedObs = [];
      expandedReactions = [];
    }
  }

  // All display decisions delegate to $lib/ui/bias-profile; the
  // deriveds below are the reactive wire-up over those primitives.
  const summaryRows = $derived(sortSummaryRows(summary));
  const renderedRows = $derived(renderedBiasRows(summary));
  const rendered = $derived(new Set(renderedRows.map((r) => r.bias)));
  // Denominator for the landscape bars, computed once per row set
  // (see chartScale's doc for the gate-anchoring rationale).
  const scale = $derived(chartScale(summaryRows));
  // Empty-state copy for the two current-conversation blocks; null
  // means the loaded list renders instead. The not-yet-analyzed /
  // analyzed-but-empty distinction (including the brand-new-draft
  // gotcha) is encoded in the primitives.
  const obsEmptyCopy = $derived(
    currentObservationsEmptyCopy(currentThreadObs, currentThreadProcessedAt),
  );
  const reactionsEmptyCopy = $derived(
    currentReactionsEmptyCopy(
      currentThreadReactions,
      currentThreadProcessedAt,
      renderedRows.length,
    ),
  );
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="center bias-backdrop"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
  <div class="bias-shell" role="dialog" aria-modal="true" aria-label="Bias profile diagnostics">
    <button
      type="button"
      class="bias-close"
      onclick={onClose}
      aria-label="Close diagnostics"
      title="Close"
    >&times;</button>

    <div class="bias-body">
      <!-- Header is INSIDE the scroll surface so the long blurb
           doesn't pin to the top and eat half the viewport on
           mobile. The close button stays absolutely positioned
           against the shell (above), independent of scroll. -->
      <header class="bias-header">
        <h1 class="bias-title">Bias profile</h1>
        <p class="subtle bias-blurb">
          A background worker silently analyzes past conversations
          for cognitive biases and System-1 heuristics in your
          phrasing. Evidence accumulates across conversations via
          a Bayesian posterior with recency decay; biases that
          clear the credible-interval gate are injected as
          compensation guidance in the chat assistant's system
          prompt. Today's conversations and the one currently open
          here are excluded.
        </p>
      </header>

      {#if loading}
        <p class="empty">Loading...</p>
      {:else}
        {#if activeThreadId}
          <section class="block">
            <h2 class="block-title">Current conversation</h2>
            <p class="block-blurb subtle">
              What the bias layer is doing for the thread you have
              open right now. Conversations are analyzed only after
              they settle: the hourly sweep picks one up once its
              last activity falls on a previous day.
            </p>

            <h3 class="sub-title">Shaping responses on this turn</h3>
            {#if renderedRows.length === 0}
              <p class="empty">
                No biases currently meet the surfacing threshold.
                The system prompt for this turn carries no
                bias-compensation block.
              </p>
            {:else}
              <ul class="bias-list">
                {#each renderedRows as row (row.bias)}
                  <li class="bias-row">
                    <header class="bias-row-header">
                      <span class="bias-name">{biasLabel(row.bias)}</span>
                      <span class="tier-badge {row.tier}" title={tierTitle(row.tier)}>{row.tier}</span>
                    </header>
                    <p class="bias-def subtle">{biasGuidance(row.bias)}</p>
                  </li>
                {/each}
              </ul>
            {/if}

            <h3 class="sub-title">Observations from this conversation</h3>
            {#if obsEmptyCopy !== null}
              <!-- Copy choice (not-yet-analyzed vs analyzed-and-
                   empty, including the brand-new-draft gotcha)
                   lives in currentObservationsEmptyCopy. -->
              <p class="empty">{obsEmptyCopy}</p>
            {:else}
              <div class="obs-list flush">
                {#each currentThreadObs ?? [] as o (o.id)}
                  <div class="obs-card">
                    <header class="obs-header">
                      <span class="obs-bias">{biasLabel(o.bias)}</span>
                      <span class="obs-confidence subtle">
                        confidence {formatConfidence(o.confidence)}
                      </span>
                    </header>
                    <p class="obs-reasoning">{o.reasoning}</p>
                  </div>
                {/each}
              </div>
            {/if}

            <h3 class="sub-title">Reactions to compensation on this conversation</h3>
            {#if reactionsEmptyCopy !== null}
              <!-- Three-way copy choice (not-yet-analyzed vs
                   nothing-was-active vs no-clear-signal) lives in
                   currentReactionsEmptyCopy. -->
              <p class="empty">{reactionsEmptyCopy}</p>
            {:else}
              <div class="obs-list flush">
                {#each currentThreadReactions ?? [] as r (r.id)}
                  <div class="obs-card">
                    <header class="obs-header">
                      <span class="obs-bias">{biasLabel(r.bias)}</span>
                      <span class="reaction-verdict {reactionVerdictClass(r.wasConfirmed)}" title={reactionVerdictTitle(r.wasConfirmed)}>
                        {reactionVerdict(r.wasConfirmed)}
                      </span>
                    </header>
                    <p class="obs-reasoning">{r.reasoning}</p>
                  </div>
                {/each}
              </div>
            {/if}
          </section>
        {/if}

        <section class="block">
          <h2 class="block-title">Bias landscape</h2>
          <p class="block-blurb subtle">
            One bar per catalog entry, length tracking the 90%
            credible interval lower bound (the same quantity the
            surfacing gates check against). Hue moves blue -&gt;
            green -&gt; orange -&gt; red as the bar passes the soft
            ({formatProbability(CI_LB_SOFT)}) and strong
            ({formatProbability(CI_LB_STRONG)}) gates. Biases the
            worker has never flagged read as "no evidence" with a
            faint gray placeholder bar - their underlying numbers
            collapse to the prior's 10th-percentile (~5%) and would
            be misleading if rendered against the gate scale.
            Detail cards for each entry follow below.
          </p>
          <!-- Usage-style at-a-glance comparison. The detail
               cards beneath carry the full numbers and prose; this
               view exists to answer "which biases stand out and by
               how much?" in a single glance. -->
          <div
            class="bias-chart"
            role="table"
            aria-label="Bias landscape"
          >
            <div class="bias-chart-row bias-chart-head" role="row">
              <span class="bias-chart-name" role="columnheader">Bias</span>
              <span class="bias-chart-bar-head" role="columnheader">90% CI lower</span>
              <span class="bias-chart-value" role="columnheader">&nbsp;</span>
            </div>
            {#each summaryRows as row (row.bias)}
              <div class="bias-chart-row" role="row">
                <span
                  class="bias-chart-name"
                  role="cell"
                  title={biasDefinition(row.bias)}
                >{biasLabel(row.bias)}</span>
                <span class="bias-chart-bar-cell" role="cell">
                  <!-- Bar geometry (the visible-nub minimum, the
                       gate-anchored scale, the fixed no-evidence
                       nub) lives in barWidthPct + chartScale. -->
                  <span
                    class="bias-chart-bar"
                    class:elided={row.tier === 'elided'}
                    class:no-evidence={!hasEvidence(observationCounts, row.bias)}
                    style="--bias-pct:{barWidthPct(row.ciLower, hasEvidence(observationCounts, row.bias), scale)}%; --bias-hue:{biasHue(row.ciLower)}"
                  ></span>
                </span>
                <span class="bias-chart-value" role="cell">
                  {#if !hasEvidence(observationCounts, row.bias)}
                    <em class="no-evidence-label">no evidence</em>
                  {:else}
                    {formatProbability(row.ciLower)}
                  {/if}
                </span>
              </div>
            {/each}
          </div>
        </section>

        <section class="block">
          <h2 class="block-title">Per-bias evidence</h2>
          <p class="block-blurb subtle">
            One row per catalog entry. Tier is gated by the lower
            bound of the 90% credible interval plus a floor on the
            effective sample size. Soft ({CI_LB_SOFT.toFixed(2)} &lt;
            CI lower &le; {CI_LB_STRONG.toFixed(2)}) reads as
            "occasionally"; strong (CI lower &gt;
            {CI_LB_STRONG.toFixed(2)}) reads as "consistently". Top
            {RENDER_CAP} by CI lower are rendered into the system
            prompt - the "in prompt" pill marks which.
          </p>
          <ul class="bias-list">
            {#each summaryRows as row (row.bias)}
              <li class="bias-row">
                <header class="bias-row-header">
                  <span class="bias-name">{biasLabel(row.bias)}</span>
                  <span class="tier-badge {row.tier}" title={tierTitle(row.tier)}>{row.tier}</span>
                  {#if rendered.has(row.bias)}
                    <span class="in-prompt" title={IN_PROMPT_TITLE}>in prompt</span>
                  {/if}
                </header>
                <p class="bias-def subtle">{biasDefinition(row.bias)}</p>
                <dl class="bias-stats">
                  <div>
                    <dt>CI lower (90%)</dt>
                    <dd>
                      {#if !hasEvidence(observationCounts, row.bias)}
                        <em class="no-evidence-label">no evidence</em>
                      {:else}
                        {formatProbability(row.ciLower)}
                      {/if}
                    </dd>
                  </div>
                  <div><dt>posterior mean</dt><dd>{formatProbability(row.posteriorMean)}</dd></div>
                  <div><dt>effective N</dt><dd>{formatEffectiveN(row.effectiveN)}</dd></div>
                  <div title="EMA of compensation-reaction feedback in [-1, +1]. Positive = user has affirmed compensation; negative = user has pushed back. Shifts the surfacing gates by up to {FEEDBACK_THRESHOLD_DELTA.toFixed(2)} at the extremes."><dt>feedback</dt><dd>{formatFeedback(row.feedbackScore)}</dd></div>
                </dl>
                <!-- Prose gloss on what the four numbers above
                     mean for this bias. Tier-aware, with a
                     trailing feedback sentence when the EMA is
                     meaningful enough to shift the gates. -->
                <p class="bias-interpretation">
                  {interpretBias(row, rendered.has(row.bias), hasEvidence(observationCounts, row.bias))}
                </p>
                {#if hasEvidence(observationCounts, row.bias)}
                  <!-- Per-bias drill-down. Surfacing this only on
                       rows the analysis has actually flagged - rows
                       with no observations have nothing to show
                       and the toggle would read as broken. -->
                  <button
                    type="button"
                    class="bias-evidence-toggle"
                    onclick={() => toggleBiasObservations(row.bias)}
                    aria-expanded={expandedBiasKey === row.bias}
                  >
                    {expandedBiasKey === row.bias ? 'Hide' : 'View'}
                    {observationsLabel(observationCounts[row.bias] ?? 0)}
                  </button>
                  {#if expandedBiasKey === row.bias}
                    {#if expandedBiasObs === null}
                      <p class="bias-evidence-empty subtle">Loading...</p>
                    {:else if expandedBiasObs.length === 0}
                      <!-- Race window: the count loaded on mount
                           said >0, but the per-bias fetch came
                           back empty. The worker likely cleared
                           the source thread's observations after
                           a new message arrived in it. -->
                      <p class="bias-evidence-empty subtle">
                        No observations available - the sweep may
                        have re-analyzed the source conversations
                        since this modal opened.
                      </p>
                    {:else}
                      <ul class="bias-evidence-list">
                        {#each expandedBiasObs as o (o.id)}
                          <li class="bias-evidence-item">
                            <button
                              type="button"
                              class="bias-evidence-link"
                              onclick={() => openThread(o.threadId)}
                              title="Open this conversation"
                            >{displayThreadTitle(o.threadTitle)}</button>
                            <blockquote class="bias-evidence-reason">
                              {o.reasoning}
                            </blockquote>
                          </li>
                        {/each}
                      </ul>
                    {/if}
                  {/if}
                {/if}
              </li>
            {/each}
          </ul>
        </section>

        <section class="block">
          <h2 class="block-title">Recently processed conversations</h2>
          <p class="block-blurb subtle">
            Latest threads the sweep has analyzed. Click a row to
            expand the per-observation list. A thread re-enters the
            queue when you send a new message in it (prior
            observations are cleared and reanalyzed on the next
            worker scan).
          </p>
          {#if processed.length === 0}
            <p class="empty">No threads processed yet.</p>
          {:else}
            <ul class="thread-list">
              {#each processed as t (t.threadId)}
                <li class="thread-row">
                  <button
                    type="button"
                    class="thread-toggle"
                    onclick={() => toggleThread(t.threadId)}
                  >
                    <span class="thread-title">{t.title || '(untitled)'}</span>
                    <span class="thread-meta subtle">
                      {t.observationCount} obs &middot; {formatTimestamp(t.processedAt)}
                    </span>
                  </button>
                  {#if expandedThreadId === t.threadId}
                    <div class="obs-list">
                      {#if expandedObs.length === 0}
                        <p class="empty">No observations for this thread.</p>
                      {:else}
                        {#each expandedObs as o (o.id)}
                          <div class="obs-card">
                            <header class="obs-header">
                              <span class="obs-bias">{biasLabel(o.bias)}</span>
                              <span class="obs-confidence subtle">
                                confidence {formatConfidence(o.confidence)}
                              </span>
                            </header>
                            <p class="obs-reasoning">{o.reasoning}</p>
                          </div>
                        {/each}
                      {/if}
                      {#if expandedReactions.length > 0}
                        <p class="sub-list-label subtle">Reactions</p>
                        {#each expandedReactions as r (r.id)}
                          <div class="obs-card">
                            <header class="obs-header">
                              <span class="obs-bias">{biasLabel(r.bias)}</span>
                              <span class="reaction-verdict {reactionVerdictClass(r.wasConfirmed)}" title={reactionVerdictTitle(r.wasConfirmed)}>
                                {reactionVerdict(r.wasConfirmed)}
                              </span>
                            </header>
                            <p class="obs-reasoning">{r.reasoning}</p>
                          </div>
                        {/each}
                      {/if}
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/if}

      <footer class="bias-footer subtle">
        <p>
          Math: Bayesian Beta-Binomial posterior with exponential
          recency decay (half-life {HALF_LIFE_DAYS} days), prior
          Beta({ALPHA_PRIOR}, {BETA_PRIOR}), effective-N floor of
          {N_EFF_FLOOR}, 90% one-sided credible interval lower bound
          as the surfacing gate.
        </p>
        <p>
          Compensation-feedback EMA (half-life {FEEDBACK_HALF_LIFE_DAYS}
          days) shifts both surfacing gates symmetrically by up to
          {FEEDBACK_THRESHOLD_DELTA.toFixed(2)} at the extremes:
          consistent affirmation surfaces biases sooner, consistent
          pushback raises the bar.
        </p>
        <p>
          See <code>docs/dev/bias-profile.md</code> for the full
          derivation.
        </p>
      </footer>
    </div>
  </div>
</div>

<style>
  .bias-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, #000 50%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
    padding: 1rem;
  }

  .bias-shell {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow-modal);
    width: 100%;
    max-width: 52rem;
    height: min(48rem, 90vh);
    /* Body is the sole scroll surface. The header lives inside
       the body so its content scrolls with everything else - the
       earlier "fixed header" layout chewed half the viewport on
       narrow screens, leaving only a sliver for the actual
       evidence table. Close button remains absolutely positioned
       at the shell level so it stays reachable regardless of
       scroll position. */
    overflow: hidden;
  }

  .bias-close {
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

  .bias-close:hover {
    background: var(--bg-2);
  }

  .bias-header {
    /* Bleeds outside the body padding so the bottom border
       reaches the modal walls; matches the original fixed-header
       look while sitting inside the scroll surface. The negative
       horizontal margin pairs with the body's symmetric padding. */
    margin: -1rem -1.25rem 1rem;
    padding: 1rem 1.25rem 0.75rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-2);
    min-width: 0;
  }

  .bias-title {
    font-size: 1.1rem;
    margin: 0 0 0.25rem;
    padding-right: 3rem;
  }

  .bias-blurb {
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.45;
  }

  .bias-body {
    height: 100%;
    padding: 1rem 1.25rem;
    overflow-y: auto;
    /* iOS Safari momentum scrolling on the body so the scroll
       gesture feels native inside the modal. */
    -webkit-overflow-scrolling: touch;
    min-width: 0;
  }

  .sub-title {
    font-size: 0.85rem;
    margin: 0.9rem 0 0.4rem;
    color: var(--text);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .sub-title:first-of-type {
    margin-top: 0.5rem;
  }

  /* When `.obs-list` rides directly under a sub-title (the
     "Observations from this conversation" path in the current-
     conversation section) we don't want the indent the thread-
     list version inherits. */
  .obs-list.flush {
    padding: 0;
  }

  .block {
    margin: 0 0 1.25rem;
  }

  .block-title {
    font-size: 0.95rem;
    margin: 0 0 0.4rem;
    color: var(--text);
  }

  .block-blurb {
    margin: 0 0 0.6rem;
    font-size: 0.8rem;
    line-height: 1.45;
  }

  .bias-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 0.7rem;
  }

  .bias-row {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.65rem 0.75rem;
    background: var(--bg-2);
  }

  .bias-row-header {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin: 0 0 0.3rem;
    flex-wrap: wrap;
  }

  .bias-name {
    font-weight: 600;
    font-size: 0.92rem;
  }

  .bias-def {
    margin: 0 0 0.45rem;
    font-size: 0.8rem;
    line-height: 1.4;
  }

  .bias-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
    gap: 0.5rem;
    margin: 0;
  }

  .bias-stats div {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.3rem 0.5rem;
  }

  .bias-stats dt {
    font-size: 0.7rem;
    color: color-mix(in srgb, var(--text) 65%, transparent);
    margin: 0 0 0.1rem;
  }

  .bias-stats dd {
    margin: 0;
    font-size: 0.9rem;
    font-variant-numeric: tabular-nums;
  }

  /* Prose gloss under the stats grid. Same visual weight as the
     definition line but with the default text color (not subtle) -
     this paragraph is the interpretive payload of the card, not
     metadata. */
  .bias-interpretation {
    margin: 0.5rem 0 0;
    font-size: 0.8rem;
    line-height: 1.45;
    color: var(--text);
  }

  /* Landscape bar chart. Mirrors the structure of .usage-chart
     in src/styles.css (Settings > Usage), with bias-prefixed
     class names so the two charts can drift independently if
     either feature's needs change. Columns: [name] [bar] [value].
     `display: contents` on the row lets the grid lay out cells
     directly so column tracks stay aligned across rows. */
  .bias-chart {
    display: grid;
    grid-template-columns: minmax(0, max-content) minmax(0, 1fr) max-content;
    gap: 0.3rem 0.65rem;
    align-items: center;
    margin: 0;
  }

  .bias-chart-row {
    display: contents;
  }

  .bias-chart-head > * {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: color-mix(in srgb, var(--text) 65%, transparent);
    padding-bottom: 0.15rem;
    border-bottom: 1px solid var(--border);
  }

  .bias-chart-name {
    /* Right-aligned so the ragged-length labels form a clean
       right edge against the bar. White-space nowrap avoids
       mid-name line breaks; if the modal is narrow enough that
       the longest label doesn't fit, the column falls back to
       horizontal scroll inside the cell (min-width: 0 is what
       lets the column clamp). */
    text-align: end;
    font-size: 0.82rem;
    color: var(--text);
    white-space: nowrap;
    overflow-x: auto;
    min-width: 0;
  }

  .bias-chart-bar-cell {
    display: flex;
    align-items: center;
  }

  .bias-chart-bar {
    display: block;
    width: var(--bias-pct, 0%);
    height: 0.55rem;
    /* Hue is gate-relative (see biasHue): blue below CI_LB_SOFT,
       green at the soft gate, orange at the strong gate, red
       past it. Saturation / lightness are fixed so the only
       moving part is hue. Matches the visual idiom of the
       Usage chart's bars. */
    background: linear-gradient(
      90deg,
      hsl(var(--bias-hue, 220), 62%, 52%) 0%,
      hsl(var(--bias-hue, 220), 62%, 52%) 70%,
      hsl(var(--bias-hue, 220), 58%, 40%) 100%
    );
    border-radius: 999px;
  }

  .bias-chart-bar.elided {
    /* Cool the elided bars down a notch so the eye drifts to the
       at-tier bars first without losing the elided ones entirely.
       The hue is still set by biasHue (blue territory anyway for
       elided); this just lowers saturation and opacity. */
    opacity: 0.7;
  }

  .bias-chart-bar.no-evidence {
    /* Never-flagged biases: override the gate-relative hue with a
       desaturated gray and drop opacity further so the bar reads
       as "placeholder, not a measurement." The fixed 1.5% width
       (set inline) gives the row a visible nub so the eye can
       still scan the column without the row vanishing. */
    background: color-mix(in srgb, var(--text) 35%, transparent);
    opacity: 0.35;
  }

  .no-evidence-label {
    /* Same color/weight as the .subtle helper - the label is
       metadata, not a measurement, and shouldn't compete visually
       with the at-tier rows' percentages. */
    color: color-mix(in srgb, var(--text) 55%, transparent);
    font-style: italic;
    font-size: 0.78rem;
  }

  .bias-chart-value {
    font-variant-numeric: tabular-nums;
    font-size: 0.8rem;
    color: color-mix(in srgb, var(--text) 75%, transparent);
    text-align: end;
    min-width: 3rem;
  }

  .bias-chart-bar-head {
    text-align: start;
  }

  .tier-badge {
    border: 1px solid var(--border);
    border-radius: 9999px;
    padding: 0.05rem 0.5rem;
    font-size: 0.72rem;
    text-transform: lowercase;
    background: color-mix(in srgb, var(--text) 8%, transparent);
  }

  .tier-badge.strong {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
    border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
  }

  .tier-badge.soft {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
  }

  .in-prompt {
    font-size: 0.7rem;
    color: var(--accent);
    border: 1px dashed var(--accent);
    border-radius: 9999px;
    padding: 0.05rem 0.4rem;
  }

  .thread-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 0.4rem;
  }

  .thread-row {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-2);
    overflow: hidden;
  }

  .thread-toggle {
    display: flex;
    width: 100%;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.55rem 0.75rem;
    background: transparent;
    color: var(--text);
    border: none;
    cursor: pointer;
    text-align: left;
  }

  .thread-toggle:hover {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }

  .thread-title {
    font-size: 0.9rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .thread-meta {
    font-size: 0.78rem;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .obs-list {
    padding: 0 0.75rem 0.65rem;
    display: grid;
    gap: 0.45rem;
  }

  .obs-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 0.65rem;
  }

  .obs-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    margin: 0 0 0.3rem;
  }

  .obs-bias {
    font-weight: 600;
    font-size: 0.85rem;
  }

  .obs-confidence {
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }

  .obs-reasoning {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.4;
  }

  /* Per-bias drill-down. The toggle is a text-link affordance
     under the interpretation paragraph; expanded list lives
     inside the bias-row card, so it inherits the card's
     boundary rather than spawning its own panel. */
  .bias-evidence-toggle {
    margin: 0.55rem 0 0;
    padding: 0;
    background: none;
    border: none;
    color: var(--accent);
    font-size: 0.78rem;
    cursor: pointer;
    text-align: left;
  }

  .bias-evidence-toggle:hover {
    text-decoration: underline;
  }

  .bias-evidence-empty {
    margin: 0.5rem 0 0;
    font-size: 0.8rem;
    line-height: 1.4;
  }

  .bias-evidence-list {
    list-style: none;
    margin: 0.5rem 0 0;
    padding: 0;
    display: grid;
    gap: 0.55rem;
  }

  .bias-evidence-item {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 0.65rem;
  }

  .bias-evidence-link {
    display: inline-block;
    max-width: 100%;
    padding: 0;
    background: none;
    border: none;
    color: var(--link, var(--accent));
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    text-align: left;
    /* Wrap long thread titles instead of widening the card. The item
       sits in a grid track whose default min-width:auto lets a
       nowrap title expand the column past the modal edge on mobile
       (the ellipsis never triggers - the track just grows). Wrapping
       plus overflow-wrap:anywhere breaks even an unbroken token so
       the link always stays within the card. */
    overflow-wrap: anywhere;
  }

  .bias-evidence-link:hover {
    color: var(--link-hover, var(--accent));
  }

  /* Blockquote-styled reasoning line under the title link. The
     left border + indent reads like the markdown `> reason`
     idiom the surface emulates - title on top, agent's reasoning
     visually nested beneath. */
  .bias-evidence-reason {
    margin: 0.3rem 0 0;
    padding: 0 0 0 0.65rem;
    border-left: 2px solid color-mix(in srgb, var(--accent) 35%, var(--border));
    font-size: 0.8rem;
    line-height: 1.45;
    color: color-mix(in srgb, var(--text) 82%, transparent);
  }

  .bias-footer {
    padding-top: 0.75rem;
    border-top: 1px dashed var(--border);
    margin-top: 1rem;
    font-size: 0.78rem;
    display: grid;
    gap: 0.3rem;
    line-height: 1.4;
  }

  .bias-footer p {
    margin: 0;
  }

  .bias-footer code {
    font-family: var(--font-mono, monospace);
    font-size: 0.75rem;
  }

  .empty {
    margin: 0;
    color: var(--text);
    line-height: 1.5;
  }

  .subtle {
    color: color-mix(in srgb, var(--text) 65%, transparent);
  }

  /* Reaction verdict pill. Three colorways for the three-state
     was_confirmed: affirmed (accent-tinted), pushed back (danger-
     tinted), neutral (subtle gray). Same shape as the tier
     badge - small, lowercase, pill-bordered - so the two read as
     part of the same vocabulary. */
  .reaction-verdict {
    border: 1px solid var(--border);
    border-radius: 9999px;
    padding: 0.05rem 0.5rem;
    font-size: 0.72rem;
    text-transform: lowercase;
    background: color-mix(in srgb, var(--text) 8%, transparent);
  }

  .reaction-verdict.affirmed {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  }

  .reaction-verdict.pushed {
    background: color-mix(in srgb, var(--danger) 18%, transparent);
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  }

  /* Sub-list separator label that appears between observations
     and reactions inside the expanded thread drill-down so the
     two cards-of-the-same-shape are distinguishable at a glance. */
  .sub-list-label {
    margin: 0.5rem 0 0.25rem;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
</style>
