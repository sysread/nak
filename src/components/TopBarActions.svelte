<!--
  Top-bar action cluster for a section (Chats / Recipes / Memories /
  Wiki). The top-bar in Chat.svelte hands this component the section's
  list of icon actions; this component owns how that list is laid out
  at each viewport:

    - 1 action  -> a single plain icon button (a group/menu of one is
                   pointless), identical on every viewport.
    - 2+ actions -> a Bootstrap-style merged button group on desktop;
                   collapsed behind a single overflow ("...") menu on
                   mobile, where the row of separate icons crowds the
                   bar (the reason this component exists).

  A `pinned` action opts out of the mobile collapse: it renders as a
  standalone icon button on mobile (`.top-bar-pinned`, shown only at
  the mobile breakpoint) and is excluded from the overflow menu, while
  the desktop merged group still includes it. Exists for the chats
  tab's new-conversation button - a primary action a user reaches for
  constantly, which must not cost a menu round-trip on the phone.

  Both renderings of the multi-action case are emitted at once and the
  CSS media query at `max-width: 720px` (see `.top-bar-group` /
  `.top-bar-overflow-btn` / `.top-bar-menu` in styles.css) decides which
  is visible - no resize listener. Each action's `icon` snippet renders
  in both: as the tooltip'd glyph in the desktop group, and as the row
  glyph beside `label` in the mobile menu.

  This is glue, not feature logic: every field on a TopBarAction is a
  framework closure (onclick), a reactive flag (disabled), or a snippet
  (icon), so a port to React/Vue would rewrite all of it. There is no
  pure UI-behavior primitive to hoist into src/lib/ui/ here.
-->
<script module lang="ts">
  import type { Snippet } from 'svelte';

  // One control in a section's top-bar cluster. `title` is the tooltip
  // AND the aria-label on the desktop icon button, so it must read as a
  // full action phrase ("Run the wiki librarian now"); `label` is the
  // shorter text shown in the mobile menu row ("Run librarian").
  // `class` carries any per-action styling hook the icon button needs
  // beyond the shared `.icon-btn` base (e.g. the accent-tinted
  // `.new-thread-mini`); it is not applied to the menu row, which uses
  // the shared menu-item styling.
  export interface TopBarAction {
    id: string;
    label: string;
    title: string;
    class?: string;
    disabled?: boolean;
    /**
     * Keep this action out of the mobile overflow menu, rendered as
     * its own always-visible icon button instead. Desktop layout is
     * unaffected. Reserve for a section's primary action.
     */
    pinned?: boolean;
    onclick: () => void;
    icon: Snippet;
  }
</script>

<script lang="ts">
  interface Props {
    actions: TopBarAction[];
    // aria-label / tooltip for the mobile overflow trigger and the
    // desktop group wrapper - e.g. "Wiki actions".
    menuLabel: string;
  }
  let { actions, menuLabel }: Props = $props();

  let menuOpen = $state(false);

  // Mobile split: pinned actions stay visible, the rest collapse into
  // the overflow menu. Desktop ignores the split (the merged group
  // renders `actions` in full).
  const pinnedActions = $derived(actions.filter((a) => a.pinned));
  const menuActions = $derived(actions.filter((a) => !a.pinned));

  function runAction(action: TopBarAction): void {
    if (action.disabled) return;
    action.onclick();
    menuOpen = false;
  }

  // Close the overflow menu on an outside click or Escape. Scoped to
  // this component's own `.top-bar-actions` root so it never fights the
  // composer popovers' document-level handler in Chat.svelte - a click
  // inside our wrapper (the trigger or a menu row) is handled by the
  // buttons' own onclick, everything else closes us.
  $effect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target;
      if (t instanceof Element && t.closest('.top-bar-actions')) return;
      menuOpen = false;
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') menuOpen = false;
    };
    document.addEventListener('click', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onDown);
      document.removeEventListener('keydown', onKey);
    };
  });
</script>

{#if actions.length === 1}
  {@const a = actions[0]}
  <button
    class="secondary icon-btn {a.class ?? ''}"
    onclick={() => runAction(a)}
    disabled={a.disabled}
    title={a.title}
    aria-label={a.title}
  >
    {@render a.icon()}
  </button>
{:else if actions.length > 1}
  <div class="top-bar-actions">
    <div class="top-bar-group" role="group" aria-label={menuLabel}>
      {#each actions as a (a.id)}
        <button
          class="secondary icon-btn {a.class ?? ''}"
          onclick={() => runAction(a)}
          disabled={a.disabled}
          title={a.title}
          aria-label={a.title}
        >
          {@render a.icon()}
        </button>
      {/each}
    </div>
    <!-- Mobile-only twins of the pinned actions; the desktop group
         above already includes them, and .top-bar-pinned is
         display:none outside the mobile breakpoint. -->
    {#each pinnedActions as a (a.id)}
      <button
        class="secondary icon-btn top-bar-pinned {a.class ?? ''}"
        onclick={() => runAction(a)}
        disabled={a.disabled}
        title={a.title}
        aria-label={a.title}
      >
        {@render a.icon()}
      </button>
    {/each}
    {#if menuActions.length > 0}
    <button
      class="secondary icon-btn top-bar-overflow-btn"
      onclick={() => (menuOpen = !menuOpen)}
      aria-haspopup="true"
      aria-expanded={menuOpen}
      title={menuLabel}
      aria-label={menuLabel}
    >
      <!-- Feather "more-vertical" - the conventional overflow / kebab
           glyph. -->
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="1" />
        <circle cx="12" cy="5" r="1" />
        <circle cx="12" cy="19" r="1" />
      </svg>
    </button>
    {#if menuOpen}
      <div class="top-bar-menu" role="menu">
        {#each menuActions as a (a.id)}
          <button
            class="menu-item menu-item-btn"
            role="menuitem"
            onclick={() => runAction(a)}
            disabled={a.disabled}
            title={a.title}
          >
            <span class="top-bar-menu-icon" aria-hidden="true">{@render a.icon()}</span>
            <span class="menu-item-label">{a.label}</span>
          </button>
        {/each}
      </div>
    {/if}
    {/if}
  </div>
{/if}
