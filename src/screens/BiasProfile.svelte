<script lang="ts">
  /**
   * Bias Profile diagnostics modal. Read-only view of the
   * worker-maintained per-user, per-bias evidence cache plus the
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
   *     observations the worker has already recorded for this
   *     thread (or an explanation of why none exist yet - the
   *     thread is excluded from analysis while open).
   *
   *   - Per-bias evidence table. One row per catalog entry showing
   *     the tier badge, the credible-interval lower bound, the
   *     posterior mean, the effective sample size, and a preview of
   *     the system-prompt contribution (if any).
   *
   *   - Recently processed conversations. Latest N (default 30)
   *     threads the worker has analyzed, each expandable to its
   *     per-observation list.
   *
   *   - Per-observation drill-down. Inside an expanded thread, one
   *     card per observation with the bias name, confidence, and
   *     the reasoning string.
   *
   * No write controls; the worker is autonomic.
   */
  import { onMount } from 'svelte';
  import { app } from '$lib/state.svelte';
  import { route } from '$lib/routing.svelte';
  import { BIAS_CATALOG, type BiasKey, isBiasKey } from '$lib/bias/catalog';
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

  interface SummaryRow {
    bias: string;
    effectiveN: number;
    posteriorMean: number;
    ciLower: number;
    feedbackScore: number;
    tier: 'elided' | 'soft' | 'strong';
    computedAt: string;
  }

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

  let summary = $state<SummaryRow[]>([]);
  let processed = $state<ProcessedThreadRow[]>([]);
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
      const [s, p, threadObs, threadReactions] = await Promise.all([
        supabase.biasListSummary(),
        supabase.biasListProcessedThreads(30),
        activeThreadId
          ? supabase.biasListObservationsForThread(activeThreadId)
          : Promise.resolve([] as ObservationRow[]),
        activeThreadId
          ? supabase.biasListReactionsForThread(activeThreadId)
          : Promise.resolve([] as ReactionRow[]),
      ]);
      summary = s;
      processed = p;
      currentThreadObs = activeThreadId ? threadObs : null;
      currentThreadReactions = activeThreadId ? threadReactions : null;
    } finally {
      loading = false;
    }
  });

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
      expandedObs = obs;
      expandedReactions = reactions;
    } catch {
      expandedObs = [];
      expandedReactions = [];
    }
  }

  /**
   * Sort summary rows for the table: strong tier first, then soft,
   * then elided; within each tier, by ciLower descending so the
   * strongest signal lands at the top.
   */
  const summaryRows = $derived.by<SummaryRow[]>(() => {
    const tierWeight = (t: string): number =>
      t === 'strong' ? 0 : t === 'soft' ? 1 : 2;
    return [...summary].sort((a, b) => {
      const t = tierWeight(a.tier) - tierWeight(b.tier);
      if (t !== 0) return t;
      return b.ciLower - a.ciLower;
    });
  });

  /**
   * Set of bias keys that would be rendered into the system prompt
   * this turn (post render-cap). The "in prompt" pill in the table
   * reads from this so the user can see which biases are actually
   * shaping responses right now, not just which ones cleared the
   * tier gate.
   */
  const renderedRows = $derived.by<SummaryRow[]>(() => {
    return summary
      .filter((r) => r.tier === 'soft' || r.tier === 'strong')
      .sort((a, b) => b.ciLower - a.ciLower)
      .slice(0, RENDER_CAP);
  });
  const rendered = $derived(new Set(renderedRows.map((r) => r.bias)));

  function biasLabel(key: string): string {
    if (!isBiasKey(key)) return key;
    return BIAS_CATALOG[key as BiasKey].label;
  }

  function biasDefinition(key: string): string {
    if (!isBiasKey(key)) return '';
    return BIAS_CATALOG[key as BiasKey].definition;
  }

  /**
   * The pre-written compensation guidance string for a bias - the
   * same text that rides into the chat LLM's system prompt when
   * the bias clears a tier. Surfaced in the "Current conversation"
   * section so the user can see what the assistant is being told
   * about them, not just the bias name.
   */
  function biasGuidance(key: string): string {
    if (!isBiasKey(key)) return '';
    return BIAS_CATALOG[key as BiasKey].guidance;
  }

  function formatTimestamp(iso: string | null): string {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  function formatProbability(n: number): string {
    return (n * 100).toFixed(1) + '%';
  }

  function formatEffectiveN(n: number): string {
    return n.toFixed(1);
  }

  /**
   * Feedback score is signed in [-1, +1]. Render with an explicit
   * sign so the polarity reads at a glance; +0.00 / -0.00 also
   * collapse to the neutral 0.00.
   */
  function formatFeedback(n: number): string {
    const abs = Math.abs(n);
    if (abs < 0.005) return '0.00';
    const sign = n > 0 ? '+' : '-';
    return `${sign}${abs.toFixed(2)}`;
  }

  /**
   * Render-time tag for a reaction's three-state was_confirmed.
   */
  function reactionVerdict(wasConfirmed: boolean | null): string {
    if (wasConfirmed === true) return 'affirmed';
    if (wasConfirmed === false) return 'pushed back';
    return 'neutral';
  }
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
              open right now. The conversation itself is excluded
              from analysis while open in this tab; the worker
              picks it back up after you close it.
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
                      <span class="tier-badge {row.tier}">{row.tier}</span>
                    </header>
                    <p class="bias-def subtle">{biasGuidance(row.bias)}</p>
                  </li>
                {/each}
              </ul>
            {/if}

            <h3 class="sub-title">Observations from this conversation</h3>
            {#if currentThreadObs === null}
              <p class="empty">
                Not yet analyzed. While this conversation is open
                in this tab the worker excludes it from its scan;
                once you close it (and the conversation is no
                longer dated today) the worker will pick it up on
                its next rotation.
              </p>
            {:else if currentThreadObs.length === 0}
              <p class="empty">
                Already analyzed - the worker found no clear bias
                evidence in this conversation. Reporting nothing
                is the correct answer most of the time.
              </p>
            {:else}
              <div class="obs-list flush">
                {#each currentThreadObs as o (o.id)}
                  <div class="obs-card">
                    <header class="obs-header">
                      <span class="obs-bias">{biasLabel(o.bias)}</span>
                      <span class="obs-confidence subtle">
                        confidence {(o.confidence * 100).toFixed(0)}%
                      </span>
                    </header>
                    <p class="obs-reasoning">{o.reasoning}</p>
                  </div>
                {/each}
              </div>
            {/if}

            <h3 class="sub-title">Reactions to compensation on this conversation</h3>
            {#if currentThreadReactions === null || currentThreadReactions.length === 0}
              <p class="empty">
                {#if currentThreadReactions === null}
                  Not yet analyzed. Reactions are recorded for the
                  biases that were active in the system prompt while
                  the conversation happened; the worker classifies
                  them after you close the conversation.
                {:else if renderedRows.length === 0}
                  No biases were active in the system prompt during
                  this conversation, so there was nothing for you
                  to react to.
                {:else}
                  Already analyzed - the agent did not see a clear
                  affirmation or pushback signal for the active
                  biases on this conversation.
                {/if}
              </p>
            {:else}
              <div class="obs-list flush">
                {#each currentThreadReactions as r (r.id)}
                  <div class="obs-card">
                    <header class="obs-header">
                      <span class="obs-bias">{biasLabel(r.bias)}</span>
                      <span class="reaction-verdict {r.wasConfirmed === true ? 'affirmed' : r.wasConfirmed === false ? 'pushed' : 'neutral'}">
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
                  <span class="tier-badge {row.tier}">{row.tier}</span>
                  {#if rendered.has(row.bias)}
                    <span class="in-prompt">in prompt</span>
                  {/if}
                </header>
                <p class="bias-def subtle">{biasDefinition(row.bias)}</p>
                <dl class="bias-stats">
                  <div><dt>CI lower (90%)</dt><dd>{formatProbability(row.ciLower)}</dd></div>
                  <div><dt>posterior mean</dt><dd>{formatProbability(row.posteriorMean)}</dd></div>
                  <div><dt>effective N</dt><dd>{formatEffectiveN(row.effectiveN)}</dd></div>
                  <div title="EMA of compensation-reaction feedback in [-1, +1]. Positive = user has affirmed compensation; negative = user has pushed back. Shifts the surfacing gates by up to {FEEDBACK_THRESHOLD_DELTA.toFixed(2)} at the extremes."><dt>feedback</dt><dd>{formatFeedback(row.feedbackScore)}</dd></div>
                </dl>
              </li>
            {/each}
          </ul>
        </section>

        <section class="block">
          <h2 class="block-title">Recently processed conversations</h2>
          <p class="block-blurb subtle">
            Latest threads the worker has analyzed. Click a row to
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
                                confidence {(o.confidence * 100).toFixed(0)}%
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
                              <span class="reaction-verdict {r.wasConfirmed === true ? 'affirmed' : r.wasConfirmed === false ? 'pushed' : 'neutral'}">
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
