<script lang="ts">
  /**
   * The seedling inspector - the read-only "surfaced" window onto the
   * notes Nak keeps to itself about the future. Two sections, two
   * features, one contract ("surfaced, not steerable"):
   *
   *   - Working intentions (opt-in, off by default): the standing
   *     goals the minter forms about how to help the user grow. Shown
   *     only when `app.intentsEnabled` - the section must not
   *     advertise a feature the user never switched on.
   *   - Follow-ups (every account): the pending questions Nak saved to
   *     ask later, whose outcomes it does not know.
   *
   * Reached from the always-present seedling pill in the bottom-right
   * column. No write controls on either section - the minter owns the
   * intent portfolio; follow-ups are answered, postponed, or dismissed
   * in conversation. All decision logic lives in the tested primitives
   * ($lib/ui/intents-inspector, $lib/ui/followups-inspector); this file
   * is glue.
   */
  import { onMount } from 'svelte';
  import { app } from '$lib/state.svelte';
  import {
    groupByStatus,
    reformedIds,
    REFORMED_NOTE,
    efficacyView,
    splitStatement,
    targetLabel,
    activeHeadline,
    formatRelative,
    type IntentRow,
    type GroupedIntents,
  } from '$lib/ui/intents-inspector';
  import {
    groupFollowups,
    openStatusChip,
    followupsHeadline,
    inspectorTitle,
    type FollowupInspectorRow,
    type GroupedFollowups,
  } from '$lib/ui/followups-inspector';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  let intentRows = $state<IntentRow[]>([]);
  let followupRows = $state<FollowupInspectorRow[]>([]);
  let loading = $state(true);

  const grouped = $derived<GroupedIntents>(groupByStatus(intentRows));
  const reformed = $derived<Set<string>>(reformedIds(intentRows));
  const followups = $derived<GroupedFollowups>(groupFollowups(followupRows));
  const title = $derived(inspectorTitle(app.intentsEnabled));

  onMount(async () => {
    const supabase = app.supabase;
    if (!supabase) {
      loading = false;
      return;
    }
    try {
      // Intents stay unfetched when the feature is off - the section
      // isn't rendered, and an opted-out account has no rows anyway.
      const [intents, loops] = await Promise.all([
        app.intentsEnabled ? supabase.listIntents() : Promise.resolve([]),
        supabase.listFollowups(),
      ]);
      intentRows = intents;
      followupRows = loops;
    } finally {
      loading = false;
    }
  });
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="center intents-backdrop"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
  <div class="intents-shell" role="dialog" aria-modal="true" aria-label={title}>
    <button
      type="button"
      class="intents-close"
      onclick={onClose}
      aria-label="Close inspector"
      title="Close"
    >&times;</button>

    <div class="intents-body">
      <header class="intents-header">
        <h1 class="intents-title">{title}</h1>
        <p class="subtle intents-blurb">
          Notes Nak keeps to itself about the future. This view is
          read-only - Nak manages these on its own, and you shape them
          just by talking.
        </p>
      </header>

      {#if loading}
        <p class="empty">Loading...</p>
      {:else}
        {#if app.intentsEnabled}
          <section class="feature">
            <h2 class="feature-title">Working intentions</h2>
            <p class="feature-blurb subtle">
              Standing goals Nak forms about how to help you grow, drawn
              from the patterns it observes. It reviews them daily -
              pursuing what helps, pausing what goes quiet, letting go
              of what isn't landing. They are gentle leans, never an
              agenda, and never override what you explicitly ask for.
            </p>

            {#if intentRows.length === 0}
              <p class="empty">
                No intentions yet. Nak reviews your patterns once a day and
                forms an intention only when it sees a real, repeated one with
                a way to help. Nothing here until then.
              </p>
            {:else}
              <p class="headline">{activeHeadline(grouped.active.length)}</p>

              {#each [
                { key: 'active', title: 'Active', blurb: 'Shaping replies now.', list: grouped.active },
                { key: 'dormant', title: 'Paused', blurb: 'Set aside while the pattern is quiet; may return.', list: grouped.dormant },
                { key: 'retired', title: 'Let go', blurb: "Abandoned - not working, or no longer relevant. Kept for the record.", list: grouped.retired },
              ] as section (section.key)}
                {#if section.list.length > 0}
                  <section class="block">
                    <h3 class="block-title">{section.title}</h3>
                    <p class="block-blurb subtle">{section.blurb}</p>

                    {#each section.list as intent (intent.id)}
                      {@const view = efficacyView(intent)}
                      {@const parts = splitStatement(intent.statement)}
                      <article class="intent-card" class:retired={intent.status === 'retired'}>
                        <p class="intent-statement">
                          <!-- {' '} forces the gap between lead and clause: a
                               literal space at the start of the {#if} block is
                               stripped by Svelte whitespace trimming, which ran
                               "...notice" into "when...". -->
                          <strong class="intent-lead">{parts.lead}</strong>{#if parts.context}{' '}<em class="intent-context">{parts.context}</em>{/if}
                        </p>
                        <div class="intent-meta">
                          <span class="target">{targetLabel(intent)}</span>
                          <span class="badge badge-{view.state}" title={view.hint ?? ''}>
                            {view.label}
                          </span>
                          <span class="when subtle">updated {formatRelative(intent.updated_at)}</span>
                        </div>
                        {#if reformed.has(intent.id)}
                          <p class="intent-reformed subtle">{REFORMED_NOTE}</p>
                        {/if}
                        {#if view.hint}
                          <p class="intent-hint subtle">{view.hint}</p>
                        {/if}
                        {#if intent.rationale}
                          <p class="intent-rationale subtle">{intent.rationale}</p>
                        {/if}
                      </article>
                    {/each}
                  </section>
                {/if}
              {/each}
            {/if}
          </section>
        {/if}

        <section class="feature">
          <h2 class="feature-title">Follow-ups</h2>
          <p class="feature-blurb subtle">
            Questions Nak saved to ask you later - so it knows what it
            doesn't know yet. It raises one when the moment is right and
            closes it when you share how things went.
          </p>

          {#if followupRows.length === 0}
            <p class="empty">
              No follow-ups yet. When you share a plan or an upcoming
              event, Nak can note a question to ask you about it later.
            </p>
          {:else}
            <p class="headline">{followupsHeadline(followups.open.length)}</p>

            {#if followups.open.length > 0}
              <section class="block">
                <h3 class="block-title">Waiting to ask</h3>
                <p class="block-blurb subtle">Outcomes Nak doesn't know yet.</p>
                {#each followups.open as loop (loop.id)}
                  <article class="intent-card">
                    <p class="intent-statement">
                      <strong class="intent-lead">{loop.question}</strong>{#if loop.context}{' '}<em class="intent-context">{loop.context}</em>{/if}
                    </p>
                    <div class="intent-meta">
                      <span class="badge">{openStatusChip(loop)}</span>
                      <span class="when subtle">updated {formatRelative(loop.updated_at)}</span>
                    </div>
                  </article>
                {/each}
              </section>
            {/if}

            {#if followups.answered.length > 0}
              <section class="block">
                <h3 class="block-title">Answered</h3>
                <p class="block-blurb subtle">You told Nak how it went.</p>
                {#each followups.answered as loop (loop.id)}
                  <article class="intent-card retired">
                    <p class="intent-statement">
                      <strong class="intent-lead">{loop.question}</strong>
                    </p>
                    {#if loop.resolution}
                      <p class="intent-rationale subtle">Outcome: {loop.resolution}</p>
                    {/if}
                    <div class="intent-meta">
                      <span class="when subtle">answered {formatRelative(loop.updated_at)}</span>
                    </div>
                  </article>
                {/each}
              </section>
            {/if}

            {#if followups.letGo.length > 0}
              <section class="block">
                <h3 class="block-title">Let go</h3>
                <p class="block-blurb subtle">
                  Dropped without an answer - you waved it off, or it went
                  stale. Kept for the record.
                </p>
                {#each followups.letGo as loop (loop.id)}
                  <article class="intent-card retired">
                    <p class="intent-statement">
                      <strong class="intent-lead">{loop.question}</strong>
                    </p>
                    <div class="intent-meta">
                      <span class="when subtle">{formatRelative(loop.updated_at)}</span>
                    </div>
                  </article>
                {/each}
              </section>
            {/if}
          {/if}
        </section>
      {/if}
    </div>
  </div>
</div>

<style>
  .intents-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, #000 50%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
    padding: 1rem;
  }

  .intents-shell {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-modal);
    width: 100%;
    max-width: 46rem;
    height: min(46rem, 90vh);
    overflow: hidden;
  }

  .intents-close {
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
    border-radius: var(--radius-round);
    cursor: pointer;
  }

  .intents-close:hover {
    background: var(--bg-2);
  }

  .intents-header {
    margin: -1rem -1.25rem 1rem;
    padding: 1rem 1.25rem 0.75rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-2);
    min-width: 0;
  }

  .intents-title {
    font-size: 1.1rem;
    margin: 0 0 0.25rem;
    padding-right: 3rem;
  }

  .intents-blurb {
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.45;
  }

  .intents-body {
    height: 100%;
    padding: 1rem 1.25rem;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    min-width: 0;
  }

  /* One .feature block per hosted feature (intentions, follow-ups),
     separated by a rule so the normative-goals / pending-questions line
     stays visually legible inside the shared modal. */
  .feature {
    margin: 0 0 1.75rem;
  }

  .feature + .feature {
    border-top: 1px solid var(--border);
    padding-top: 1.25rem;
  }

  .feature-title {
    font-size: 1rem;
    margin: 0 0 0.25rem;
    color: var(--text);
  }

  .feature-blurb {
    margin: 0 0 0.9rem;
    font-size: 0.82rem;
    line-height: 1.45;
  }

  .headline {
    margin: 0 0 1rem;
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--text);
  }

  .block {
    margin: 0 0 1.5rem;
  }

  .block-title {
    font-size: 0.95rem;
    margin: 0 0 0.2rem;
    color: var(--text);
  }

  .block-blurb {
    margin: 0 0 0.6rem;
    font-size: 0.8rem;
    line-height: 1.45;
  }

  .intent-card {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 0.7rem 0.85rem;
    margin-bottom: 0.6rem;
    background: var(--bg-1);
  }

  /* Retired intents and closed follow-ups are history, dimmed so the
     eye lands on what is live first. */
  .intent-card.retired {
    opacity: 0.62;
  }

  .intent-statement {
    margin: 0 0 0.4rem;
    font-size: 0.92rem;
    line-height: 1.4;
    color: var(--text);
  }

  /* Split the statement so the eye lands on WHAT Nak inclines toward
     (bold lead) before the situational WHEN clause (italic context).
     Both keep the statement color - this is the card headline, distinct
     from the dimmer italic rationale below. Follow-up cards reuse the
     split: question bold, seeding context italic. */
  .intent-lead {
    font-weight: 600;
  }

  .intent-context {
    font-style: italic;
  }

  .intent-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.78rem;
  }

  .target {
    color: var(--text);
  }

  .badge {
    display: inline-flex;
    align-items: center;
    padding: 0.05rem 0.5rem;
    border-radius: var(--radius-pill);
    font-size: 0.72rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-2);
  }

  /* Tone by efficacy state. Only the two confident verdicts get
     color; the uncertain states (unscored, mixed, free-form) stay
     neutral, matching the inspector's honesty-about-uncertainty rule. */
  .badge-landing {
    border-color: color-mix(in srgb, var(--ok, #2e7d32) 55%, var(--border));
    color: var(--ok, #2e7d32);
  }

  .badge-struggling {
    border-color: color-mix(in srgb, var(--warn, #b26a00) 55%, var(--border));
    color: var(--warn, #b26a00);
  }

  .when {
    margin-left: auto;
  }

  .intent-hint {
    margin: 0.4rem 0 0;
    font-size: 0.78rem;
    line-height: 1.4;
  }

  /* The re-formed note explains why a goal Nak previously let go is
     active again, since the superseded retired twin is hidden. */
  .intent-reformed {
    margin: 0.4rem 0 0;
    font-size: 0.78rem;
    line-height: 1.4;
  }

  .intent-rationale {
    margin: 0.4rem 0 0;
    font-size: 0.78rem;
    line-height: 1.4;
    font-style: italic;
  }

  .empty {
    text-align: center;
    color: var(--text-2);
    padding: 2rem 1rem;
    line-height: 1.5;
  }
</style>
