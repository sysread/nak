<script lang="ts">
  /**
   * The diagnostic-pill column (recall / intuition / bias / samskara
   * mood / intents) for BOTH surfaces it appears on:
   *
   *   - desktop: a vertical column floating bottom-right of the messages
   *     pane (variant="desktop", mounted in .messages-wrap).
   *   - mobile:  a drop-up "wharf" menu hanging off a three-dot button in
   *     the composer bar (variant="mobile", mounted in .composer-bar).
   *
   * Both surfaces loop the SAME ordered registry
   * (`src/lib/ui/diagnostic-pills.ts`), so they cannot drift apart:
   * adding or reordering a pill is a single edit in that file. The two
   * mounts live in different DOM parents (the desktop column anchors its
   * absolute positioning to .messages-wrap so it tracks the scroll-to-
   * bottom arrow; the mobile trigger has to sit in the composer bar), so
   * this one component is mounted twice with a `variant` prop rather than
   * once - see the two <DiagnosticPills> tags in Chat.svelte, each
   * pointing at the other. See docs/dev/diagnostic-pills.md.
   *
   * This component is a pure reader. The samskara mood data is owned by
   * the single headless SamskaraMoodSync.svelte (mounted once); both of
   * these mounts just read `moodState.visual`.
   */
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { navigate } from '$lib/routing.svelte';
  import { app } from '$lib/state.svelte';
  import { moodState } from '$lib/samskara/mood.svelte';
  import {
    visibleDiagnosticPills,
    type DiagnosticPillContext,
  } from '$lib/ui/diagnostic-pills';
  import type { ContextRecallPayload } from '$lib/context-recall';
  import type { IntuitionPayload } from '$lib/intuition';

  interface Props {
    variant: 'desktop' | 'mobile';
    recall: ContextRecallPayload | null;
    intuition: IntuitionPayload | null;
    // Mobile-only. The open state + its toggle stay lifted in Chat.svelte
    // because closeMenus() coordinates this wharf with the sibling model-
    // picker wharf and the outside-click handler.
    open?: boolean;
    onToggle?: () => void;
    onClose?: () => void;
  }

  let {
    variant,
    recall,
    intuition,
    open = false,
    onToggle,
    onClose,
  }: Props = $props();

  const ctx = $derived<DiagnosticPillContext>({
    recall,
    intuition,
    moodVisual: moodState.visual,
    intentsEnabled: app.intentsEnabled,
  });

  const pills = $derived(visibleDiagnosticPills(ctx));

  const FLY_IN_MS = 220;
  const FLY_OUT_MS = 320;

  // The samskara pill re-keys on each mood id so a fresh mint re-plays
  // the fly transition; every other pill is stable across renders and
  // keys on its id alone.
  function pillKey(id: string): string {
    return id === 'samskara' ? `samskara-${ctx.moodVisual?.id ?? 0}` : id;
  }
</script>

{#if variant === 'desktop'}
  <!-- Desktop column. The buttons are absolutely positioned (each at its
       own `bottom`, computed by the registry) and anchor to .messages-wrap
       - this static wrapper takes no layout space, it just groups the
       pills so one selector can hide the whole column on mobile. -->
  <div class="diag-column" aria-live="polite" aria-atomic="true">
    {#each pills as p (pillKey(p.descriptor.id))}
      {@const d = p.descriptor}
      {@const enabled = d.enabled(ctx)}
      <button
        type="button"
        class="diag-pill"
        class:is-disabled={!enabled}
        class:tier-2={d.id === 'samskara' && ctx.moodVisual?.tier === 2}
        style="bottom: {p.bottom};"
        disabled={!enabled}
        title={d.title(ctx)}
        aria-label={d.ariaLabel(ctx)}
        onclick={() => {
          if (enabled) navigate({ modal: d.modal });
        }}
        in:fly={{ x: 24, duration: FLY_IN_MS, easing: cubicOut }}
        out:fly={{ x: 24, duration: FLY_OUT_MS, easing: cubicOut }}
      >
        <span class="emoji" aria-hidden="true">{d.emoji(ctx)}</span>
      </button>
    {/each}
  </div>
{:else}
  <!-- Mobile drop-up. The .composer-diag-anchor is a local positioning
       context so the panel rises directly above its three-dot trigger. -->
  <div class="composer-diag-anchor">
    <button
      type="button"
      class="secondary icon-btn composer-diag-trigger"
      class:open
      onclick={() => onToggle?.()}
      title="Diagnostics menu"
      aria-label="Diagnostics menu"
      aria-haspopup="true"
      aria-expanded={open}
      aria-controls="composer-diag-wharf"
    >
      <!-- Three vertical dots, distinct from the adjacent model-picker
           wharf's 3x3 grid so the two affordances read as separate
           concerns at a glance. -->
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <circle cx="12" cy="5" r="1.8" />
        <circle cx="12" cy="12" r="1.8" />
        <circle cx="12" cy="19" r="1.8" />
      </svg>
    </button>

    <!-- Same registry, same order, rendered as flat tiles. Each tap
         closes the wharf (onClose = closeMenus) before navigating. -->
    <div
      id="composer-diag-wharf"
      class="composer-diag-wharf"
      class:wharf-open={open}
    >
      {#each pills as p (p.descriptor.id)}
        {@const d = p.descriptor}
        {@const enabled = d.enabled(ctx)}
        <button
          type="button"
          class="diag-tile"
          disabled={!enabled}
          title={d.title(ctx)}
          aria-label={d.ariaLabel(ctx)}
          onclick={() => {
            onClose?.();
            navigate({ modal: d.modal });
          }}
        >
          <span class="emoji" aria-hidden="true">{d.emoji(ctx)}</span>
        </button>
      {/each}
    </div>
  </div>
{/if}

<style>
  /* ---- Desktop column ----------------------------------------------
     Static wrapper (no box of its own); pointer-events:none so the gaps
     between pills stay click-through to the messages pane. Each pill
     re-enables pointer events. Hidden wholesale on mobile - one selector
     replaces the old five-class hide-list that pills kept leaking past. */
  .diag-column {
    pointer-events: none;
  }

  .diag-pill {
    position: absolute;
    right: 1rem;
    /* `bottom` is set inline from the registry. */
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.1rem;
    height: 2.1rem;
    padding: 0;
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    color: var(--text);
    border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
    border-radius: var(--radius-round);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.22);
    /* z-index 25: above the chat surface, below modals (30), drawers
       (40), and the update banner (100). A passive glance cue should
       never float over interactive surfaces. */
    z-index: 25;
    pointer-events: auto;
    cursor: pointer;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }

  .diag-pill:hover {
    border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
  }

  .diag-pill:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* Disabled = "feature exists, no data to surface yet": faded + cursor
     signal without lying about interactivity. Clicks blocked by the
     disabled attribute. */
  .diag-pill:disabled,
  .diag-pill.is-disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .diag-pill:disabled:hover,
  .diag-pill.is-disabled:hover {
    border-color: color-mix(in srgb, var(--border) 80%, transparent);
  }

  /* Tier-2 (compound-of-compounds) samskara mints get an extra accent
     ring so a higher-order claim is distinguishable from a flat tier-1
     one. Only the samskara pill ever carries .tier-2. */
  .diag-pill.tier-2 {
    box-shadow:
      0 4px 12px rgba(0, 0, 0, 0.22),
      0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent);
  }

  .diag-pill .emoji {
    font-size: 1.1rem;
    line-height: 1;
    /* Face emojis (events.ts) already carry Emoji_Presentation=Yes, so
       no U+FE0F needed; the font hint still helps older Android WebView
       where the system emoji font isn't reached by the default cascade. */
    font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
  }

  /* ---- Mobile drop-up wharf -----------------------------------------
     Anchor + panel are display:none on desktop (the column above is the
     desktop surface) and flip on at the mobile breakpoint. */
  .composer-diag-anchor {
    display: none;
    position: relative;
  }

  .composer-diag-wharf {
    display: none;
  }

  @media (max-width: 720px) {
    /* Desktop column off; the pills live in the wharf below. */
    .diag-column {
      display: none;
    }

    .composer-diag-anchor {
      display: inline-flex;
      /* Hard-tuck the diag trigger against the model-picker wharf
         trigger on its left. Without this, .composer-bar's space-between
         distributes the flex children evenly and drops this trigger in
         the middle; the auto margin consumes the free space to its right
         so the cluster packs left and send stays flush right. */
      margin-right: auto;
    }

    button.composer-diag-trigger.open {
      box-shadow:
        inset 1px 1px 0 var(--bevel-lo),
        inset -1px -1px 0 var(--bevel-hi);
      background: var(--bg-2);
    }

    /* Panel renders only when .wharf-open. Anchored to the trigger via
       the .composer-diag-anchor positioning context so it rises directly
       above the three-dot button. composer-wharf-slide is the shared
       keyframe (global, also used by the model-picker wharf). */
    .composer-diag-wharf.wharf-open {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 3px;
      position: absolute;
      left: 0;
      bottom: calc(100% + 0.35rem);
      background: var(--bg-2);
      border-radius: 0;
      box-shadow:
        inset 1px 1px 0 var(--bevel-hi),
        inset -1px -1px 0 var(--bevel-lo),
        0 10px 22px rgba(0, 0, 0, 0.35);
      z-index: 25;
      animation: composer-wharf-slide 160ms cubic-bezier(0.2, 0, 0, 1);
    }

    .composer-diag-wharf.wharf-open .diag-tile {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.4rem;
      height: 2.4rem;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: var(--bg-2);
      color: var(--text);
      cursor: pointer;
      box-shadow:
        inset 1px 1px 0 var(--bevel-hi),
        inset -1px -1px 0 var(--bevel-lo);
    }

    .composer-diag-wharf.wharf-open .diag-tile:active {
      box-shadow:
        inset 1px 1px 0 var(--bevel-lo),
        inset -1px -1px 0 var(--bevel-hi);
    }

    /* Same opacity + cursor signal as the desktop pills' disabled state
       so the two surfaces read consistently. */
    .composer-diag-wharf.wharf-open .diag-tile:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }

    .composer-diag-wharf.wharf-open .diag-tile .emoji {
      font-size: 1.2rem;
      line-height: 1;
      font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
    }
  }
</style>
