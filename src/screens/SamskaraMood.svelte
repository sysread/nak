<script lang="ts">
  /*
   * Conversation-scoped mood modal. The "mood" - where the current
   * conversation's latest samskara fire sits on the (valence x
   * confidence) -> emoji map - is inherently per-conversation, so it
   * lives in a modal opened from the mood pill rather than on the
   * corpus-global Samskara tab. (Scope split: per-conversation -> this
   * modal; per-round triggered predictions -> the inline cohort
   * dropdown; global -> the Samskara tab.)
   *
   * Thin shell around SamskaraMoodLegend, which reads the shared
   * moodState the pill writes, so the "you are here" dot matches the
   * pill the user clicked to open this.
   */
  import SamskaraMoodLegend from '../components/SamskaraMoodLegend.svelte';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose(); }} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="center samskara-mood-backdrop"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
  <div class="samskara-mood-shell" role="dialog" aria-modal="true" aria-label="Conversation mood">
    <button
      type="button"
      class="samskara-mood-close"
      onclick={onClose}
      aria-label="Close"
      title="Close"
    >×</button>
    <header class="samskara-mood-header">
      <h1 class="samskara-mood-title">Conversation mood</h1>
      <p class="subtle samskara-mood-blurb">
        Where this conversation's latest read sits on the mood map. The
        dot tracks the mood pill; it clears when you switch threads.
      </p>
    </header>
    <div class="samskara-mood-body">
      <SamskaraMoodLegend />
    </div>
  </div>
</div>

<style>
  .samskara-mood-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, #000 50%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
    padding: 1rem;
  }
  .samskara-mood-shell {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-modal);
    width: 100%;
    max-width: 40rem;
    max-height: 88vh;
    overflow: hidden;
    display: grid;
    grid-template-rows: auto 1fr;
  }
  .samskara-mood-close {
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
  .samskara-mood-close:hover {
    background: var(--bg-2);
  }
  .samskara-mood-header {
    padding: 1rem 1.25rem 0.5rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-2);
    min-width: 0;
  }
  .samskara-mood-title {
    font-size: 1.1rem;
    margin: 0 0 0.25rem;
    padding-right: 3rem;
  }
  .samskara-mood-blurb {
    margin: 0;
    font-size: 0.85rem;
  }
  .samskara-mood-body {
    padding: 0.5rem 1.25rem 1.25rem;
    overflow-y: auto;
    min-width: 0;
  }
  @media (max-width: 720px) {
    .samskara-mood-backdrop {
      padding: 0.5rem;
    }
    .samskara-mood-header {
      padding: 0.75rem 0.85rem 0.5rem;
    }
    .samskara-mood-body {
      padding: 0.5rem 0.85rem 1rem;
    }
  }
</style>
