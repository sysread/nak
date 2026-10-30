<script lang="ts">
  /*
   * Sidebar listing for the user's skills. Shown in the left drawer
   * when the Skills tab is active. Owns the search input - bound to
   * `skillsStore.query` so a keystroke filters the listing in place.
   *
   * Rows show the name plus a one-line description snippet (the
   * skill's trigger surface - enough to judge relevance without
   * opening the row). Click sets `route.skill` so the main panel
   * renders that skill's detail.
   *
   * Search is a plain ILIKE round trip (no embed, so no spinner
   * theatre) driven through `runSkillsSearch` on the shared store.
   * The panel's bus listener refreshes this listing on panel writes
   * and realtime relays - this component stays dumb.
   */
  import { app } from '$lib/state.svelte';
  import { route, navigate } from '$lib/routing.svelte';
  import {
    skillsStore,
    runSkillsSearch,
    loadMoreSkills,
  } from '$lib/skills-store.svelte';
  import { SEARCH_DEBOUNCE_MS, emptyMessage, rowSnippet } from '$lib/ui/skills-list';
  import { infiniteScroll } from '$lib/actions/infinite-scroll';
  import Scanner from './Scanner.svelte';

  // Parent (Chat shell) passes a callback that dismisses the mobile
  // drawer once the panel has navigated to the chosen skill.
  // Optional so the component is usable in contexts that don't own
  // a drawer.
  interface Props {
    onSelect?: () => void;
  }
  const { onSelect }: Props = $props();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Re-run the query whenever the bound search text changes. Reads
  // `skillsStore.query` reactively so a keystroke in EITHER the
  // sidebar input or any other binding feeds the same search.
  $effect(() => {
    const _q = skillsStore.query;
    void _q;
    if (!app.supabase) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!app.supabase) return;
      void runSkillsSearch(app.supabase);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };
  });

  function pickSkill(id: string): void {
    navigate({ skill: id });
    onSelect?.();
  }
</script>

<div class="recipe-drawer-list">
  <!-- The sidebar-search-input class is load-bearing, not cosmetic:
       the mobile drawer's focus handling duck-types it to collapse
       the tab nav so this input clears the on-screen keyboard
       (src/lib/ui/sidebar-search-focus.ts). -->
  <div class="skill-list-controls">
    <input
      type="search"
      name="skill-search"
      class="sidebar-search-input"
      placeholder="Search skills"
      aria-label="Search skills"
      bind:value={skillsStore.query}
      autocomplete="off"
      spellcheck="false"
    />
  </div>
  {#if skillsStore.loading && skillsStore.results.length === 0}
    <p class="subtle" style="padding:0.75rem">Loading skills...</p>
  {:else if skillsStore.error}
    <p class="error" style="padding:0.75rem">
      Couldn't load skills: {skillsStore.error}
    </p>
  {:else if skillsStore.results.length === 0}
    <p class="subtle" style="padding:0.75rem">
      {emptyMessage(skillsStore.query)}
    </p>
  {:else}
    <!-- Rendered in server order (name ASC for both browse and
         search - there is no ranking layer). No client re-sort -
         see the store's results doc. -->
    {#each skillsStore.results as s (s.id)}
      <div class="row thread-row" data-skill-id-link={s.id}>
        <button
          class="thread grow skill-row"
          class:active={route.skill === s.id}
          aria-current={route.skill === s.id ? 'true' : undefined}
          onclick={() => pickSkill(s.id)}
          title={s.name}
        >
          <span class="skill-row-name">{s.name}</span>
          {#if s.description}
            <span class="skill-row-snippet">{rowSnippet(s.description)}</span>
          {/if}
        </button>
      </div>
    {/each}
    {#if skillsStore.hasMore}
      <!-- Infinite-scroll sentinel for the browse list. hasMore is
           forced false during a search (capped, unpaged), so this
           only appears in the empty-query regime. -->
      <div
        class="skill-list-sentinel"
        use:infiniteScroll={{ onHit: () => app.supabase && loadMoreSkills(app.supabase) }}
        aria-hidden="true"
      >
        {#if skillsStore.loadingMore}
          <Scanner label="Loading more skills" size={0.85} />
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  /* Mirrors the search-row styling used by the other drawer tabs -
     same shape as `.memory-list-controls` / `.wiki-list-controls`.
     The bottom margin is the only separator between the search row
     and the listing rows - no rule line. */
  .skill-list-controls {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    padding: 0.4rem 0.6rem;
    margin-bottom: 0.5rem;
  }
  .skill-list-controls .sidebar-search-input {
    flex: 1;
    min-width: 0;
  }
  /* Two-line row: the global `.thread` button defaults to a single
     ellipsized line, so this overrides it into a column stack for
     the name + snippet pair. Both children stay single-line with
     their own ellipsis; the column just lets them stack. */
  .skill-row {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    align-items: flex-start;
  }
  .skill-row-name {
    font-weight: 500;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The description snippet - the trigger surface, at a glance.
     Quieter than the name so rows stay scannable. */
  .skill-row-snippet {
    font-size: 0.78rem;
    color: var(--text-subtle, var(--text));
    opacity: 0.8;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Pagination sentinel - a small box at the list tail the
     IntersectionObserver can catch as it nears the viewport. */
  .skill-list-sentinel {
    min-height: 1px;
    padding: 0.5rem 0;
  }
</style>
