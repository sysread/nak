<!--
  Verbosity picker — composer-bar twin of the reasoning-effort picker.
  Controlled: parent owns the open/closed state so coordination with
  adjacent popovers (prompts, model, reasoning) stays in one place;
  this component is a pure view over `value`, `defaultVerbosity`,
  `open`, and `disabled`.

  Surfaced unconditionally but disable-able — unlike ReasoningPicker
  (hidden outright for non-reasoning models) the control stays visible
  and disables when the model's backend is known to reject the
  `text.verbosity` wire knob (see model_feature_rejections; the parent
  derives `disabled` via verbosityRejectedForModel). Most providers
  that don't honor the knob silently ignore it, so enabled-but-inert
  is the common case and hiding would be wrong.

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
    /**
     * True when the thread's model is recorded as rejecting the
     * verbosity knob. Disables the trigger and swaps the tooltip for
     * the explanation. Default false so older mounts keep working.
     */
    disabled?: boolean;
    /** Fired on button click; parent toggles `open` (and closes peers). */
    onToggle: () => void;
    /** Fired when the user picks a level. Parent closes the menu. */
    onSelect: (verbosity: Verbosity) => void;
  }
  let { value, defaultVerbosity, open, disabled = false, onToggle, onSelect }: Props = $props();
</script>

<button
  type="button"
  class="secondary model-picker-btn"
  onclick={onToggle}
  {disabled}
  aria-haspopup="true"
  aria-expanded={open}
  title={disabled
    ? "This model doesn't support the verbosity setting"
    : `Verbosity: ${VERBOSITY_LABELS[value]}`}
>
  <!-- Speech-bubble line icon rather than a 💬 emoji: the emoji renders
       as a thin monochrome text glyph against the toggle background and
       reads as a disabled/low-contrast control. A stroke SVG inheriting
       currentColor matches the model and reasoning triggers at full
       --text contrast. `.model-picker-model-icon` keeps it visible past
       the rule that hides the trailing chevron. -->
  <svg class="model-picker-model-icon" width="18" height="18" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
       stroke-linejoin="round" aria-hidden="true">
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  </svg>
  <span class="model-picker-label">{VERBOSITY_LABELS[value]}</span>
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="6 9 12 15 18 9" />
  </svg>
</button>

{#if open && !disabled}
  <!-- The !disabled guard covers the edge where the menu is open when
       the profile flips to a rejecting model (a mid-open thread or
       profile switch) - the trigger can no longer close it once the
       button is disabled, so the menu closes itself instead of
       stranding an interactive popover under a dead trigger. -->
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
