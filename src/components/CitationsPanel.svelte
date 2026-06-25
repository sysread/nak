<!--
  Citations panel — list of sources for one turn, shown as a slide-down
  under the message action bar (web-search citations) or under a recall
  injection (context-recall citations). Rows are the normalized
  `DisplayCitation` shape, so external web URLs and internal in-app
  routes render through one component; the caller maps its native
  citation type via `src/lib/ui/citations.ts`.

  Each row corresponds to a `^N^` superscript in the body (1-based). Two
  entry points:

    1. User clicks the "Citations" / "Sources" button in the action bar
       → panel toggles open/closed.
    2. User clicks a `^N^` superscript inside the body → parent
       component opens the panel AND bumps `flashCite` to trigger a
       background-color pulse on row N, so the eye lands on the
       specific source after the slide-down animation completes.

  The flash is driven by a `{ index, key }` token rather than a bare
  index, because the same citation may be clicked twice in a row and
  the animation needs to re-fire each time. Bumping `key` every time
  the parent registers a click forces Svelte to re-apply the `.flash`
  class in a fresh keyed block — whose intro-end handler removes the
  class again — giving us one animation per click without timers.
-->
<script lang="ts">
  import { slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import type { DisplayCitation } from '$lib/ui/citations';

  interface Props {
    citations: DisplayCitation[];
    open: boolean;
    /**
     * Bump `key` to re-trigger a row flash even when `index` didn't
     * change since the last click (same citation clicked twice). The
     * parent owns this and increments on every citation-click event.
     * `index` is 1-based to match the `^N^` superscripts; null when
     * no flash is pending.
     */
    flashCite?: { index: number; key: number } | null;
    /**
     * "Orphan refs" mode: the message body has `^N^` superscripts,
     * but the citations column is empty or null — typically because
     * the turn was written before the column existed. Rendering the
     * panel with an explanatory note (instead of no panel at all)
     * keeps the in-body superscript clicks from silently no-opping,
     * and tells the user the links aren't broken — just unsaved.
     */
    unavailable?: boolean;
  }

  const {
    citations,
    open,
    flashCite = null,
    unavailable = false,
  }: Props = $props();

  /**
   * Truthy only while a specific flash request is in flight. Rendered
   * via a `#key` block keyed on both `index` and `key` so every click
   * produces a fresh DOM node whose intro transition runs — the row
   * background transitions from accent-tinted back to its default.
   */
  const flashTarget = $derived(flashCite);
</script>

{#if open && unavailable}
  <!-- Orphan-refs notice. The body still has `^N^` superscripts, but
       the citation data for this turn isn't in our database (either
       the message predates the column or the response was captured
       before we started persisting citations). The panel still
       opens so the superscript clicks aren't dead ends, but the
       content is a single status line rather than a list. -->
  <div
    class="citations-panel citations-unavailable"
    role="status"
    transition:slide={{ duration: 220, easing: cubicOut }}
  >
    Sources aren't saved on this message — only responses from newer
    turns carry the citation list.
  </div>
{:else if open && citations.length > 0}
  <ol
    class="citations-panel"
    role="list"
    aria-label="Sources"
    transition:slide={{ duration: 220, easing: cubicOut }}
  >
    {#each citations as c (c.index)}
      <li
        class="citation-row"
        class:flash={flashTarget?.index === c.index}
        id="cite-{c.index}"
        data-cite={c.index}
      >
        {#key flashTarget && flashTarget.index === c.index ? flashTarget.key : null}
          <!-- The `{#key}` block is the flash driver: whenever the
               parent bumps `flashCite.key`, this block re-mounts for
               the matching row, re-running the CSS transition on
               `.flash`. Non-matching rows re-render through the
               empty-key branch and stay static. -->
          <span class="citation-index" aria-hidden="true">{c.index}</span>
        {/key}
        <div class="citation-body">
          <!-- External web sources open in a new tab; internal recall
               routes (?memory= / ?cid= / ?wiki_article_id=) carry no
               target/rel so the parent's click delegation can intercept
               them and navigate in-app. -->
          <a
            class="citation-title"
            href={c.href}
            target={c.external ? '_blank' : undefined}
            rel={c.external ? 'noopener noreferrer nofollow' : undefined}
          >
            {c.label}
          </a>
          {#if c.meta}
            <span class="citation-date">{c.meta}</span>
          {/if}
          {#if c.snippet}
            <div class="citation-snippet">{c.snippet}</div>
          {/if}
        </div>
      </li>
    {/each}
  </ol>
{/if}

<style>
  /* Panel: sits as a full-width block under `.msg-actions`. Inset
     padding makes the list look like a built-in card rather than a
     floating popover; shared border radius with the message bubble
     keeps the "same card, another row" feel. */
  .citations-panel {
    margin: 0.5rem 0 0;
    padding: 0.5rem;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 0.9rem;
    line-height: 1.4;
  }

  .citation-row {
    display: flex;
    gap: 0.5rem;
    padding: 0.4rem 0.5rem;
    border-radius: var(--radius);
    /* Default background transitions to accent-weak when `.flash`
       toggles in, then back here when it toggles out. The slower
       out-transition (1.2s) is deliberate — we want the user to see
       the highlight settle down, not blink through. */
    background: transparent;
    transition: background 1200ms ease-out;
  }

  /* While `.flash` is applied (the lifetime of the keyed block in
     the component), the row is tinted with `accent-weak`. Removing
     the class triggers the transition back to `transparent` above,
     which produces the desired "quick flash that fades out" effect
     after the panel's slide-down animation has settled. */
  .citation-row.flash {
    background: var(--accent-weak);
    /* A snappy in-transition so the eye registers the flash the
       instant it lands — the long fade is what the user reads as
       "attention drawn, now released." */
    transition: background 120ms ease-out;
  }

  /* Fixed-width numeric lane so multi-digit indexes don't push the
     title text around. The column is intentionally narrow — beyond
     ~20 citations per answer we'd want a different design anyway. */
  .citation-index {
    flex: 0 0 1.4rem;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    font-weight: 600;
    text-align: right;
  }

  .citation-body {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }

  .citation-title {
    color: var(--accent);
    text-decoration: none;
    font-weight: 500;
    word-break: break-word;
  }

  .citation-title:hover,
  .citation-title:focus-visible {
    text-decoration: underline;
  }

  .citation-date {
    color: var(--muted);
    font-size: 0.8rem;
  }

  .citation-snippet {
    color: var(--muted);
    font-size: 0.85rem;
    /* Clamp to a few lines — a verbose snippet would blow out the
       panel's vertical budget. Users who want the full page click
       the title link. */
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* Orphan-refs panel: muted / italic so it reads as a status line
     rather than a list row. Shares the same surface color as the
     real list so the "panel opened" gesture looks identical — only
     the contents change. */
  .citations-unavailable {
    padding: 0.65rem 0.85rem;
    color: var(--muted);
    font-style: italic;
    font-size: 0.9rem;
    line-height: 1.4;
  }
</style>
