<script lang="ts">
  /*
   * The (valence x confidence) -> emoji legend the bottom-right mood
   * pill reads at mint time, rendered straight from MOOD_TABLE so the
   * legend can never drift from the live mapping. The current pill
   * position is overlaid as a glowing "you are here" dot, read through
   * the shared moodState so it stays in lockstep with the pill the user
   * clicked to get here.
   *
   * Moved verbatim out of the retired Samskara diagnostics modal into a
   * standalone component so the Samskara tab's Summary sub-view can host
   * it. Composition only - the MOOD_TABLE lookup and the cell math live
   * in $lib/samskara/events; the range-label and aria-label derivations
   * live in $lib/ui/samskara-mood-legend.
   */
  import { MOOD_TABLE, CONFIDENCE_CUT, cellFor, type MoodColumn } from '$lib/samskara/events';
  import {
    valenceRangeLabel,
    valenceRangeCompactLabel,
    moodDotAriaLabel,
  } from '$lib/ui/samskara-mood-legend';
  import { moodState } from '$lib/samskara/mood.svelte';

  const currentCell: { row: number; column: MoodColumn } | null = $derived.by(() => {
    const m = moodState.current;
    if (!m) return null;
    return cellFor(m.valence, m.confidence);
  });
</script>

<details class="mood-legend" open>
  <summary class="mood-legend-summary">What controls the "mood"?</summary>
  <p class="mood-legend-blurb">
    Each samskara carries a <strong>valence</strong> [-1, 1] (warm/cool)
    and a <strong>confidence</strong> [0, 1]. The pill picks the matching
    cell below; columns split on confidence at {CONFIDENCE_CUT}. The
    <span class="mood-dot-inline" aria-hidden="true"></span>
    dot marks where the pill currently sits.
  </p>
  <div class="mood-legend-table-wrap">
    <table class="mood-legend-table">
      <thead>
        <tr>
          <th class="mood-axis-y" scope="col">
            <span class="mood-axis-label">valence</span>
          </th>
          <th scope="col">
            confident
            <span class="mood-axis-sub">conf &ge; {CONFIDENCE_CUT}</span>
          </th>
          <th scope="col">
            tentative
            <span class="mood-axis-sub">conf &lt; {CONFIDENCE_CUT}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {#each MOOD_TABLE as row, i (i)}
          <tr>
            <th scope="row" class="mood-row-label">
              <span class="mood-row-name">{row.confidentLabel}</span>
              <span class="mood-row-range">{valenceRangeLabel(i)}</span>
              <span class="mood-row-range-compact" aria-hidden="true">
                {valenceRangeCompactLabel(i)}
              </span>
            </th>
            <td class="mood-cell">
              <span class="mood-glyph" aria-hidden="true">{row.confidentEmoji}</span>
              <span class="mood-cell-label">{row.confidentLabel}</span>
              {#if currentCell && currentCell.row === i && currentCell.column === 'confident'}
                <span
                  class="mood-dot"
                  aria-label={moodDotAriaLabel(row.confidentLabel, moodState.current?.confidence ?? 0, moodState.current?.valence ?? 0)}
                ></span>
              {/if}
            </td>
            <td class="mood-cell">
              <span class="mood-glyph" aria-hidden="true">{row.tentativeEmoji}</span>
              <span class="mood-cell-label">{row.tentativeLabel}</span>
              {#if currentCell && currentCell.row === i && currentCell.column === 'tentative'}
                <span
                  class="mood-dot"
                  aria-label={moodDotAriaLabel(row.tentativeLabel, moodState.current?.confidence ?? 0, moodState.current?.valence ?? 0)}
                ></span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if currentCell && moodState.current}
    <p class="mood-legend-current subtle">
      Currently at valence {moodState.current.valence.toFixed(2)},
      confidence {moodState.current.confidence.toFixed(2)} -
      tier {moodState.current.tier}.
    </p>
  {:else}
    <p class="mood-legend-current subtle">
      No current mood reading - the pill is on its 💤 placeholder because
      nothing has fired or been minted on this thread yet.
    </p>
  {/if}
  <p class="mood-legend-foot subtle">
    Glyph collisions are intentional - the slight smile shows up for both
    confident "content" and tentative "cheerful" because the emoji
    vocabulary thins out fast on the warm side. Hover the pill itself for
    the disambiguating label.
  </p>
</details>

<style>
  .mood-legend {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 0.5rem 0.75rem;
    margin: 1.2rem 0 1rem;
  }
  .mood-legend-summary {
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    padding: 0.1rem 0;
    user-select: none;
  }
  .mood-legend-summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--radius-xs);
  }
  .mood-legend-blurb {
    margin: 0.6rem 0 0.4rem;
    font-size: 0.85rem;
    line-height: 1.45;
  }
  /* Wrap the table so it can scroll horizontally on very narrow
     viewports rather than overflowing. container-type enables the
     @container rule below, which drops the label column when too
     narrow to show the full table without scrolling. */
  .mood-legend-table-wrap {
    overflow-x: auto;
    container-type: inline-size;
  }
  .mood-legend-table {
    width: 100%;
    min-width: 22rem;
    border-collapse: collapse;
    font-size: 0.85rem;
  }
  .mood-legend-table thead th:nth-child(2),
  .mood-legend-table thead th:nth-child(3) {
    width: 50%;
  }
  @container (max-width: 22rem) {
    .mood-legend-table {
      min-width: 0;
    }
    .mood-legend-table th:first-child,
    .mood-legend-table td:first-child {
      display: none;
    }
    .mood-cell .mood-cell-label {
      display: none;
    }
  }
  .mood-legend-table th,
  .mood-legend-table td {
    border: 1px solid var(--border);
    padding: 0.4rem 0.55rem;
    text-align: center;
    vertical-align: middle;
  }
  .mood-legend-table thead th {
    background: var(--bg-2);
    font-weight: 600;
    font-size: 0.78rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .mood-axis-y {
    text-align: left;
  }
  .mood-axis-label {
    display: inline-block;
    font-style: italic;
    text-transform: none;
    letter-spacing: 0;
    color: var(--muted);
  }
  .mood-axis-sub {
    display: block;
    font-size: 0.7rem;
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    color: var(--muted);
    margin-top: 0.1rem;
  }
  .mood-row-label {
    text-align: left;
    background: var(--bg-2);
  }
  .mood-row-name {
    display: block;
    font-weight: 600;
  }
  .mood-row-range {
    display: block;
    font-size: 0.72rem;
    font-weight: 400;
    color: var(--muted);
    margin-top: 0.1rem;
    white-space: nowrap;
  }
  .mood-row-range-compact {
    display: none;
  }
  .mood-cell {
    line-height: 1.2;
    position: relative;
  }
  /* "You are here" dot - solid red with a soft glow, breathing pulse so
     it's noticed without being demanding. Reduced-motion drops the
     pulse. */
  .mood-dot {
    position: absolute;
    top: 0.3rem;
    right: 0.3rem;
    width: 0.6rem;
    height: 0.6rem;
    border-radius: var(--radius-round);
    background: #ef4444;
    box-shadow:
      0 0 0 2px color-mix(in srgb, #ef4444 35%, transparent),
      0 0 8px 2px color-mix(in srgb, #ef4444 55%, transparent);
    pointer-events: none;
    animation: mood-dot-pulse 2.4s ease-in-out infinite;
  }
  @keyframes mood-dot-pulse {
    0%,
    100% {
      box-shadow:
        0 0 0 2px color-mix(in srgb, #ef4444 35%, transparent),
        0 0 6px 1px color-mix(in srgb, #ef4444 45%, transparent);
    }
    50% {
      box-shadow:
        0 0 0 3px color-mix(in srgb, #ef4444 45%, transparent),
        0 0 10px 3px color-mix(in srgb, #ef4444 70%, transparent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .mood-dot {
      animation: none;
    }
  }
  .mood-dot-inline {
    display: inline-block;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: var(--radius-round);
    background: #ef4444;
    box-shadow:
      0 0 0 2px color-mix(in srgb, #ef4444 30%, transparent),
      0 0 4px 1px color-mix(in srgb, #ef4444 45%, transparent);
    vertical-align: -0.05em;
    margin: 0 0.15rem;
  }
  .mood-legend-current {
    margin: 0.5rem 0 0;
    font-size: 0.78rem;
    line-height: 1.45;
  }
  .mood-glyph {
    display: block;
    font-size: 1.6rem;
    line-height: 1.1;
    font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
  }
  .mood-cell-label {
    display: block;
    font-size: 0.75rem;
    color: var(--muted);
    margin-top: 0.1rem;
  }
  .mood-legend-foot {
    margin: 0.5rem 0 0;
    font-size: 0.78rem;
    line-height: 1.45;
  }
  @media (max-width: 720px) {
    .mood-row-name,
    .mood-row-range {
      display: none;
    }
    .mood-row-range-compact {
      display: block;
      font-size: 0.72rem;
      font-weight: 400;
      color: var(--muted);
      white-space: nowrap;
    }
  }
</style>
