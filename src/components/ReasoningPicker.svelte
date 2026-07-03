<!--
  Reasoning-effort picker — the composer-bar twin of the model-profile
  picker. Controlled: parent owns the open/closed state so coordination
  with adjacent popovers (model, prompts) stays in one place; this
  component is a pure view over `value`, `defaultLevel`, and `open`.

  Extracted from Chat.svelte so the picker can be mounted in isolation
  for component tests — Chat.svelte itself is too coupled to the live
  `app` state to mount cleanly under @testing-library/svelte.

  Shape of the emitted DOM matches the inline version it replaced:
  `.model-picker-btn` on the trigger, `.composer-menu .menu-item-btn`
  on the menu rows, so the existing composer styles keep working.
-->
<script lang="ts">
  import { THINKING_LEVELS, THINKING_LEVEL_LABELS, type ThinkingLevel } from '$lib/models';

  interface Props {
    /** Currently-resolved level for the thread (override-or-default). May be 'off'. */
    value: ThinkingLevel;
    /**
     * The active model profile's default level, shown with a `default`
     * badge in the menu. May be 'off' - a profile can ship with
     * thinking disabled, in which case the badge lands on the Off row.
     */
    defaultLevel: ThinkingLevel;
    /** Controlled popover state. Parent coordinates "only one menu open". */
    open: boolean;
    /** Fired on button click; parent toggles `open` (and closes peers). */
    onToggle: () => void;
    /** Fired when the user picks a level. Parent closes the menu. */
    onSelect: (level: ThinkingLevel) => void;
  }
  let { value, defaultLevel, open, onToggle, onSelect }: Props = $props();
</script>

<button
  type="button"
  class="secondary model-picker-btn"
  onclick={onToggle}
  aria-haspopup="true"
  aria-expanded={open}
  title={`Reasoning effort: ${THINKING_LEVEL_LABELS[value]}`}
>
  <!-- Lightbulb line icon rather than a 💭 emoji: the emoji renders as a
       thin monochrome text glyph against the toggle background and reads
       as a disabled/low-contrast control. A stroke SVG inheriting
       currentColor matches the model and verbosity triggers at full
       --text contrast. `.model-picker-model-icon` keeps it visible past
       the rule that hides the trailing chevron. -->
  <svg class="model-picker-model-icon" width="18" height="18" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
       stroke-linejoin="round" aria-hidden="true">
    <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
    <path d="M9 18h6" />
    <path d="M10 22h4" />
  </svg>
  <span class="model-picker-label">{THINKING_LEVEL_LABELS[value]}</span>
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="6 9 12 15 18 9" />
  </svg>
</button>

{#if open}
  <div class="composer-menu composer-menu-left" role="menu">
    <div class="menu-header">Reasoning effort for this conversation</div>
    {#each THINKING_LEVELS as level (level)}
      <button
        type="button"
        class="menu-item menu-item-btn"
        class:selected={value === level}
        onclick={() => onSelect(level)}
        role="menuitemradio"
        aria-checked={value === level}
      >
        <span class="menu-item-label">
          <strong>{THINKING_LEVEL_LABELS[level]}</strong>
        </span>
        {#if level === defaultLevel}<span class="menu-item-badge">default</span>{/if}
      </button>
    {/each}
  </div>
{/if}
