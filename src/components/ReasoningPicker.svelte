<!--
  Reasoning-effort picker — the composer-bar twin of the model tier
  picker. Controlled: parent owns the open/closed state so coordination
  with adjacent popovers (model, prompts) stays in one place; this
  component is a pure view over `value`, `defaultEffort`, and `open`.

  Extracted from Chat.svelte so the picker can be mounted in isolation
  for component tests — Chat.svelte itself is too coupled to the live
  `app` state to mount cleanly under @testing-library/svelte.

  Shape of the emitted DOM matches the inline version it replaced:
  `.model-picker-btn` on the trigger, `.composer-menu .menu-item-btn`
  on the menu rows, so the existing composer styles keep working.
-->
<script lang="ts">
  import {
    REASONING_EFFORTS,
    REASONING_EFFORT_LABELS,
    type ReasoningEffort,
  } from '$lib/models';

  interface Props {
    /** Currently-resolved effort for the thread (override-or-default). */
    value: ReasoningEffort;
    /** User's default, shown with a `default` badge in the menu. */
    defaultEffort: ReasoningEffort;
    /** Controlled popover state. Parent coordinates "only one menu open". */
    open: boolean;
    /** Fired on button click; parent toggles `open` (and closes peers). */
    onToggle: () => void;
    /** Fired when the user picks a level. Parent closes the menu. */
    onSelect: (effort: ReasoningEffort) => void;
  }
  let { value, defaultEffort, open, onToggle, onSelect }: Props = $props();
</script>

<button
  type="button"
  class="secondary model-picker-btn"
  onclick={onToggle}
  aria-haspopup="true"
  aria-expanded={open}
  title={`Reasoning effort: ${REASONING_EFFORT_LABELS[value]}`}
>
  <span class="model-picker-icon" aria-hidden="true">💭</span>
  <span class="model-picker-label">{REASONING_EFFORT_LABELS[value]}</span>
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="6 9 12 15 18 9" />
  </svg>
</button>

{#if open}
  <div class="composer-menu composer-menu-left" role="menu">
    <div class="menu-header">Reasoning effort for this conversation</div>
    {#each REASONING_EFFORTS as effort (effort)}
      <button
        type="button"
        class="menu-item menu-item-btn"
        class:selected={value === effort}
        onclick={() => onSelect(effort)}
        role="menuitemradio"
        aria-checked={value === effort}
      >
        <span class="menu-item-label">
          <strong>{REASONING_EFFORT_LABELS[effort]}</strong>
        </span>
        {#if effort === defaultEffort}<span class="menu-item-badge">default</span>{/if}
      </button>
    {/each}
  </div>
{/if}
