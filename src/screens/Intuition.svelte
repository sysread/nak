<script lang="ts">
  /**
   * Intuition diagnostics modal. Read-only view of the cached
   * subconscious payload for the active thread - the perception, the
   * synthesised internal monologue, and each of the five drive
   * reactions that fed into the synthesis.
   *
   * Reached from the brain-glyph button in the top-right (sibling to
   * the samskara mood pill). Opens via `navigate({ modal:
   * 'intuition' })` and reads the active thread's payload from the
   * route + threads list. Non-thread states (cold start, deleted
   * thread) render an explanatory empty-state rather than a blank
   * panel.
   *
   * Sibling to Samskara.svelte - same chrome, distinct content. We
   * don't reuse the Samskara modal for intuition because the two
   * surface different layers of state and the user benefits from
   * being able to glance at one without dismissing the other.
   *
   * The display is intentionally raw: the synthesis text is what got
   * injected into the next completion's <think> block, and the user
   * gets to see exactly that. Per-drive reactions are shown verbatim
   * (no summarisation, no paraphrasing) so the user can audit
   * whether a drive is steering the synthesis somewhere they would
   * not endorse.
   */
  import { route } from '$lib/routing.svelte';
  import {
    coerceIntuitionPayload,
    DRIVE_NAMES,
    type DriveName,
    type IntuitionPayload,
  } from '$lib/intuition';
  import type { Thread } from '$lib/supabase';

  interface Props {
    onClose: () => void;
    /** Active threads passed in by the parent so the modal can find
     *  the row matching `route.cid`. We read from the parent rather
     *  than from app.state because the threads list is owned by
     *  Chat.svelte's local state. */
    threads: readonly Thread[];
  }
  let { onClose, threads }: Props = $props();

  const payload = $derived.by<IntuitionPayload | null>(() => {
    const cid = route.cid;
    if (cid === null) return null;
    const t = threads.find((th) => th.id === cid);
    if (!t) return null;
    return coerceIntuitionPayload(t.intuition_payload);
  });

  const DRIVE_LABELS: Record<DriveName, string> = {
    attunement: 'Attunement',
    candor: 'Candor',
    curiosity: 'Curiosity',
    pragmatism: 'Pragmatism',
    standing: 'Standing',
  };

  const DRIVE_BLURBS: Record<DriveName, string> = {
    attunement: 'reads the person - mood, register, history',
    candor: 'truth over comfort, anti-sycophancy',
    curiosity: 'finds the deeper question, the real angle',
    pragmatism: 'matches answer weight to question weight',
    standing: 'effort amplifier - do a good job, lean in',
  };

  /**
   * Strip the "Classification: <category>" prefix line from the
   * perception so the body reads naturally. The category itself is
   * pulled out and rendered as a separate badge above the prose.
   */
  function splitPerception(p: string): { category: string | null; body: string } {
    const m = p.match(/^\s*Classification:\s*(\S+)\s*\n+/i);
    if (!m) return { category: null, body: p };
    return {
      category: m[1].toLowerCase(),
      body: p.slice(m[0].length).trim(),
    };
  }

  function formatTimestamp(ms: number): string {
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return String(ms);
    }
  }

  function formatTrigger(t: IntuitionPayload['trigger']): string {
    switch (t) {
      case 'title':
        return 'topic shift (title changed)';
      case 'mood':
        return 'mood shift';
      case 'stale':
        return 'staleness fuse';
      case 'cold':
        return 'first read on this thread';
    }
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="center intuition-backdrop"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
  <div class="intuition-shell" role="dialog" aria-modal="true" aria-label="Intuition diagnostics">
    <button
      type="button"
      class="intuition-close"
      onclick={onClose}
      aria-label="Close diagnostics"
      title="Close"
    >&times;</button>

    <header class="intuition-header">
      <h1 class="intuition-title">Intuition</h1>
      <p class="subtle intuition-blurb">
        The subconscious read of this conversation. A perception
        observes the situation; five drives react in parallel; their
        synthesis is injected as a prior thought before the next
        response.
      </p>
    </header>

    <div class="intuition-body">
      {#if !payload}
        <p class="empty">
          {#if route.cid === null}
            No conversation selected. The intuition layer reads from
            the active thread.
          {:else}
            No intuition fired yet on this thread. The first read
            usually lands during the opening turn (when the model
            sets the title) and refreshes when your mood band
            shifts or the topic changes meaningfully.
          {/if}
        </p>
      {:else}
        {@const split = splitPerception(payload.perception)}
        <section class="block">
          <h2 class="block-title">Synthesis</h2>
          <p class="block-blurb subtle">
            What the conscious agent sees as its prior thought
            before responding. This is what was injected as
            &lt;think&gt; content on the next round.
          </p>
          <p class="prose">{payload.synthesis}</p>
        </section>

        <section class="block">
          <h2 class="block-title">Perception</h2>
          {#if split.category}
            <p class="meta-row">
              <span class="badge">{split.category}</span>
              <span class="subtle">classification</span>
            </p>
          {/if}
          <p class="prose">{split.body || payload.perception}</p>
        </section>

        <section class="block">
          <h2 class="block-title">Drives</h2>
          <p class="block-blurb subtle">
            Five independent first-person reactions that fed into
            the synthesis. A missing drive ran but failed (rate
            limit, parse error) - the synthesis still ran with the
            ones that responded.
          </p>
          <ul class="drive-list">
            {#each DRIVE_NAMES as name (name)}
              <li class="drive-row">
                <header class="drive-header">
                  <span class="drive-name">{DRIVE_LABELS[name]}</span>
                  <span class="drive-blurb subtle">{DRIVE_BLURBS[name]}</span>
                </header>
                {#if payload.drives[name]}
                  <p class="prose drive-text">{payload.drives[name]}</p>
                {:else}
                  <p class="drive-missing subtle">unavailable for this run</p>
                {/if}
              </li>
            {/each}
          </ul>
        </section>

        <footer class="intuition-footer subtle">
          <p>Computed {formatTimestamp(payload.computed_at_at)}</p>
          <p>Trigger: {formatTrigger(payload.trigger)}</p>
          <p>User round: {payload.computed_at_round}</p>
        </footer>
      {/if}
    </div>
  </div>
</div>

<style>
  .intuition-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, #000 50%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
    padding: 1rem;
  }

  .intuition-shell {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow-modal);
    width: 100%;
    max-width: 48rem;
    display: grid;
    grid-template-rows: auto 1fr;
    height: min(44rem, 88vh);
    overflow: hidden;
  }

  .intuition-close {
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

  .intuition-close:hover {
    background: var(--bg-2);
  }

  .intuition-header {
    padding: 1rem 1.25rem 0.75rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-2);
    min-width: 0;
  }

  .intuition-title {
    font-size: 1.1rem;
    margin: 0 0 0.25rem;
    padding-right: 3rem;
  }

  .intuition-blurb {
    margin: 0;
    font-size: 0.85rem;
  }

  .intuition-body {
    padding: 1rem 1.25rem;
    overflow-y: auto;
    min-width: 0;
  }

  .block {
    margin: 0 0 1.25rem;
  }

  .block:last-of-type {
    margin-bottom: 0.5rem;
  }

  .block-title {
    font-size: 0.95rem;
    margin: 0 0 0.4rem;
    color: var(--text);
  }

  .block-blurb {
    margin: 0 0 0.5rem;
    font-size: 0.8rem;
  }

  .prose {
    margin: 0;
    white-space: pre-wrap;
    line-height: 1.45;
    color: var(--text);
  }

  .meta-row {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    margin: 0 0 0.4rem;
    font-size: 0.85rem;
  }

  .badge {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--text);
    border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
    border-radius: 9999px;
    padding: 0.05rem 0.5rem;
    font-size: 0.78rem;
    text-transform: lowercase;
  }

  .drive-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 0.85rem;
  }

  .drive-row {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.65rem 0.75rem;
    background: var(--bg-2);
  }

  .drive-header {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    margin: 0 0 0.35rem;
    flex-wrap: wrap;
  }

  .drive-name {
    font-weight: 600;
    font-size: 0.9rem;
  }

  .drive-blurb {
    font-size: 0.78rem;
  }

  .drive-text {
    font-size: 0.9rem;
  }

  .drive-missing {
    margin: 0;
    font-size: 0.8rem;
    font-style: italic;
  }

  .intuition-footer {
    padding-top: 0.75rem;
    border-top: 1px dashed var(--border);
    margin-top: 1rem;
    font-size: 0.78rem;
    display: grid;
    gap: 0.15rem;
  }

  .intuition-footer p {
    margin: 0;
  }

  .empty {
    margin: 0;
    color: var(--text);
    line-height: 1.5;
  }

  .subtle {
    color: color-mix(in srgb, var(--text) 65%, transparent);
  }
</style>
