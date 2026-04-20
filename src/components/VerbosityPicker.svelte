<!--
  Verbosity picker — composer-bar twin of the reasoning-effort picker.
  Controlled: parent owns the open/closed state so coordination with
  adjacent popovers (prompts, model, reasoning) stays in one place;
  this component is a pure view over `value`, `defaultVerbosity`, and
  `open`.

  Surfaced unconditionally — unlike ReasoningPicker there's no
  model-capability gate, because `text.verbosity` is a plain OpenAI-
  shape field that providers either honor or silently ignore.

  Shape of the emitted DOM matches the model / reasoning pickers
  (`.model-picker-btn` trigger, `.composer-menu .menu-item-btn` rows)
  so the existing composer styles keep working.
-->
<script lang="ts">
  import {
    VERBOSITIES,
    VERBOSITY_LABELS,
    type Verbosity,
  } from '$lib/models';

  interface Props {
    /** Currently-resolved verbosity for the thread (override-or-default). */
    value: Verbosity;
    /** User's default, shown with a `default` badge in the menu. */
    defaultVerbosity: Verbosity;
    /** Controlled popover state. Parent coordinates "only one menu open". */
    open: boolean;
    /** Fired on button click; parent toggles `open` (and closes peers). */
    onToggle: () => void;
    /** Fired when the user picks a level. Parent closes the menu. */
    onSelect: (verbosity: Verbosity) => void;
  }
  let { value, defaultVerbosity, open, onToggle, onSelect }: Props = $props();
</script>

<button
  type="button"
  class="secondary model-picker-btn"
  onclick={onToggle}
  aria-haspopup="true"
  aria-expanded={open}
  title={`Verbosity: ${VERBOSITY_LABELS[value]}`}
>
  <!-- U+1F4AC SPEECH BALLOON + U+FE0F for emoji presentation — same
       variation-selector discipline as the tier-toggle icons in
       models.ts, so the glyph renders as a color emoji rather than a
       thin text outline against the toggle background. -->
  <span class="model-picker-icon" aria-hidden="true">💬</span>
  <span class="model-picker-label">{VERBOSITY_LABELS[value]}</span>
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="6 9 12 15 18 9" />
  </svg>
</button>

{#if open}
  <div class="composer-menu composer-menu-left" role="menu">
    <div class="menu-header">Verbosity for this conversation</div>
    {#each VERBOSITIES as v (v)}
      <button
        type="button"
        class="menu-item menu-item-btn"
        class:selected={value === v}
        onclick={() => onSelect(v)}
        role="menuitemradio"
        aria-checked={value === v}
      >
        <span class="menu-item-label">
          <strong>{VERBOSITY_LABELS[v]}</strong>
        </span>
        {#if v === defaultVerbosity}<span class="menu-item-badge">default</span>{/if}
      </button>
    {/each}
  </div>
{/if}
