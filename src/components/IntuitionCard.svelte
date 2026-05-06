<script lang="ts">
  /**
   * Inline rendering of an intuition payload, anchored to the user
   * round it was computed for. Header-only by default - just the
   * brain icon, "Intuition" label, classification badge, and
   * timestamp - so the card sits in the transcript as a thin
   * marker rather than a wall of text. Click the toggle to reveal
   * the full perception / drives / synthesis. The diagnostics
   * modal is reached from the brain pill in the top-right; we do
   * NOT carry a "open in modal" affordance on the card itself,
   * because the modal always renders the *current* cached payload,
   * which may not be the same one this card was built from after a
   * later refresh.
   *
   * Rendered between message blocks in the Chat transcript by the
   * messageBlocks builder when the cache's `computed_at_round`
   * matches the running user-message count. Only one card renders
   * at a time because the cache only holds the most recent payload;
   * scrolling up through history shows older user/assistant
   * exchanges without intuition cards.
   *
   * Visual register: a faded inset card with a brain icon, sitting
   * between the user's message and the assistant's reply. Distinct
   * from a normal message bubble (no avatar, no copy button) and
   * from a tool-call card (no expand chevron, no parameter
   * formatting).
   */
  import {
    DRIVE_NAMES,
    type DriveName,
    type IntuitionPayload,
  } from '$lib/intuition';

  interface Props {
    payload: IntuitionPayload;
  }
  let { payload }: Props = $props();

  let expanded = $state(false);

  const DRIVE_LABELS: Record<DriveName, string> = {
    attunement: 'Attunement',
    candor: 'Candor',
    curiosity: 'Curiosity',
    pragmatism: 'Pragmatism',
    standing: 'Standing',
  };

  function splitPerception(p: string): { category: string | null; body: string } {
    const m = p.match(/^\s*Classification:\s*(\S+)\s*\n+/i);
    if (!m) return { category: null, body: p };
    return {
      category: m[1].toLowerCase(),
      body: p.slice(m[0].length).trim(),
    };
  }

  function formatTime(ms: number): string {
    try {
      return new Date(ms).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  }

  const split = $derived(splitPerception(payload.perception));
</script>

<aside
  class="intuition-card"
  class:expanded
  aria-label="Intuition: subconscious read of this turn"
>
  <header class="card-header">
    <div class="header-primary">
      <span class="icon" aria-hidden="true">&#x1F9E0;</span>
      <span class="card-label">Intuition</span>
      {#if split.category}
        <span class="badge">{split.category}</span>
      {/if}
    </div>
    <div class="header-meta">
      <span class="time subtle">{formatTime(payload.computed_at_at)}</span>
      <button
        type="button"
        class="toggle"
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse intuition' : 'Expand intuition'}
        title={expanded ? 'Collapse' : 'Expand'}
        onclick={() => (expanded = !expanded)}
      >
        {expanded ? '−' : '+'}
      </button>
    </div>
  </header>

  {#if expanded}
    <section class="block">
      <h3 class="block-title">Synthesis</h3>
      <p class="prose">{payload.synthesis}</p>
    </section>
    <section class="block">
      <h3 class="block-title">Perception</h3>
      <p class="prose">{split.body || payload.perception}</p>
    </section>
    <section class="block">
      <h3 class="block-title">Drives</h3>
      <ul class="drive-list">
        {#each DRIVE_NAMES as name (name)}
          <li class="drive-row">
            <span class="drive-name">{DRIVE_LABELS[name]}</span>
            {#if payload.drives[name]}
              <span class="drive-text">{payload.drives[name]}</span>
            {:else}
              <span class="drive-missing subtle">unavailable</span>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</aside>

<style>
  /* Intentionally distinct register from a chat bubble. The card has
     no shoulder-color, no avatar, narrower than the user's column,
     and a dashed-leader border that reads as "internal commentary
     adjacent to the conversation, not a message in it". */
  .intuition-card {
    margin: 0.5rem auto;
    padding: 0.6rem 0.85rem;
    max-width: 44rem;
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    border: 1px dashed color-mix(in srgb, var(--border) 80%, transparent);
    border-radius: 10px;
    font-size: 0.86rem;
    color: color-mix(in srgb, var(--text) 80%, transparent);
    /* Same trap as `.msg` (see styles.css): the card is a flex item
       in `.messages`, so it defaults to `min-width: auto` and is
       sized by its min-content width. The two-row header keeps the
       primary row's min-content small (badge ellipsizes), but the
       expanded body's prose / drive-text can still surface a long
       URL or hash that has no break point. min-width: 0 lets the
       card shrink to its parent's column, and overflow-wrap +
       word-break give those long tokens a place to break instead
       of dragging the card past the viewport. */
    min-width: 0;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  /* Two-row header. Earlier passes tried to fit icon + label +
     badge + time + toggle on a single line; on narrow phones that
     either wrapped raggedly (toggle dropped to its own line because
     of `margin-left: auto`) or, with `flex-wrap: nowrap`, set the
     card's min-content width above the messages-column width and
     forced a viewport scrollbar. Splitting into a primary row
     (identity: icon, label, badge) and a meta row (time left,
     toggle right) lets each row shrink independently and keeps the
     card narrow enough for any mobile viewport. */
  .card-header {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .header-primary {
    display: flex;
    gap: 0.45rem;
    align-items: center;
    flex-wrap: nowrap;
    min-width: 0;
  }

  .header-meta {
    display: flex;
    gap: 0.45rem;
    align-items: center;
  }

  .icon {
    font-size: 1rem;
    line-height: 1;
    flex-shrink: 0;
    font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
  }

  .card-label {
    font-weight: 600;
    font-size: 0.85rem;
    color: var(--text);
    flex-shrink: 0;
  }

  .badge {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    color: var(--text);
    border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
    border-radius: 9999px;
    padding: 0.02rem 0.45rem;
    font-size: 0.72rem;
    text-transform: lowercase;
    /* Shrinkable so very long category labels ("recommendation",
       "continuation") ellipsize on the narrowest phones rather than
       forcing the primary row to overflow. */
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .time {
    font-size: 0.75rem;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  /* Flush right on the meta row, opposite the timestamp. */
  .toggle {
    margin-left: auto;
    flex-shrink: 0;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.85rem;
    line-height: 1;
  }

  .toggle:hover {
    background: var(--bg-2);
  }

  .block {
    margin-top: 0.65rem;
  }

  .block-title {
    font-size: 0.78rem;
    margin: 0 0 0.25rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: color-mix(in srgb, var(--text) 70%, transparent);
  }

  .prose {
    margin: 0;
    white-space: pre-wrap;
    line-height: 1.45;
  }

  .drive-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 0.4rem;
  }

  .drive-row {
    display: grid;
    grid-template-columns: 6.5rem 1fr;
    gap: 0.5rem;
    align-items: baseline;
  }

  .drive-name {
    font-weight: 600;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .drive-text {
    font-size: 0.85rem;
    line-height: 1.4;
    white-space: pre-wrap;
  }

  .drive-missing {
    font-style: italic;
    font-size: 0.8rem;
  }

  .subtle {
    color: color-mix(in srgb, var(--text) 60%, transparent);
  }
</style>
