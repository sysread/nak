<script lang="ts">
  /*
   * Nested tool-call display, rendered inside an assistant bubble when
   * that turn invoked tools. One row per call. When the model provided
   * an `activity` narration (injected into every tool schema in
   * src/lib/tools/wire.ts), the row stacks vertically: the
   * sentence on a full-width line above the summary so it wraps freely
   * on narrow viewports, with the status glyph + tool name + duration
   * pill + chevron on the summary line below.
   *
   *   Searching your memories for notes about the dishwasher
   *   [status-glyph]  memory_search                       [pill] [▸]
   *
   * Older persisted calls from before the `activity` injection existed
   * don't carry the sentence - the assistant row's tool_calls JSON has
   * no `activity` key. We fall back to the legacy single-line layout
   * in that case (status glyph + tool name + pill + chevron, no
   * activity row above).
   *
   * Clicking a row expands it into a detail panel showing the arguments
   * (pretty-printed as a `json` fenced block) and the result (same).
   * Rows are collapsed by default so the conversation stays readable.
   *
   * Status sources:
   *   - In-session calls have a timings entry (startedAt + endedAt +
   *     error flag). That's how we know duration and whether to show
   *     the live ticker.
   *   - Replayed history (no timings; just the persisted tool row)
   *     falls back to parsing the result content - a payload with an
   *     `error` key renders as failure, otherwise success.
   *   - Orphaned calls (no timings and no persisted result, or a
   *     started-but-never-ended timing while the session is idle) are
   *     cut-off leftovers: the stream died mid-turn before a result
   *     landed. Parent signals that state via `sending === false` -
   *     we render those as errors so the spinner doesn't animate
   *     forever.
   *
   * Timings disappear on navigation (they're in-memory, owned by
   * Chat.svelte); reopening a conversation shows completed rows with
   * the status glyph only, no duration pill. That's intentional —
   * historical latency wasn't worth persisting.
   */
  import type { OpenAIToolCall } from '$lib/tools';
  import type { Message } from '$lib/supabase';
  import Markdown from './Markdown.svelte';
  import { clickShouldCollapse } from '$lib/ui/collapse-click';
  import {
    activityFor,
    DEFAULT_DETAIL_VIEW,
    durationPill,
    flipDetailView,
    formattersFor,
    renderArgs,
    renderResult,
    statusFor,
    type CallTiming,
    type DetailView,
  } from '$lib/ui/tool-calls';

  interface Props {
    /** The tool_calls array from the assistant message that invoked them. */
    calls: OpenAIToolCall[];
    /** Persisted tool-result rows, keyed by their tool_call_id. */
    resultsByCallId: Record<string, Message>;
    /** Session-local timings for in-flight / recently-completed calls. */
    timings: Record<string, CallTiming>;
    /**
     * Monotonic "now" value the parent ticks while any call in the
     * whole message list is in flight. Drives the live ms counter;
     * doesn't advance when everything is idle, so we're not chewing
     * through frames on static history.
     */
    nowMs: number;
    /**
     * True iff the chat session is actively streaming right now. Used
     * to distinguish "still in flight" from "stream died and never
     * produced a result" - a call with no timing and no result reads
     * as pending while a turn is running (brief window before the
     * first onToolStart fires) and as errored once the session is
     * idle (orphaned cutoff).
     */
    sending: boolean;
  }
  let { calls, resultsByCallId, timings, nowMs, sending }: Props = $props();

  let expanded = $state<Record<string, boolean>>({});
  // Per-call view mode for the detail panel. Defaults to the
  // readable markdown rendering; the in-panel button flips a
  // single call into raw-JSON view without disturbing siblings.
  // Keyed by call.id so a card's mode survives collapse/expand
  // within the same conversation render.
  let viewMode = $state<Record<string, DetailView>>({});

  function toggle(callId: string): void {
    expanded[callId] = !expanded[callId];
  }

  function flipView(callId: string): void {
    const current = viewMode[callId] ?? DEFAULT_DETAIL_VIEW;
    viewMode[callId] = flipDetailView(current);
  }
</script>

<div class="tool-calls" role="group" aria-label="Tool calls">
  <div class="tool-calls-heading">Tools:</div>
  {#each calls as call (call.id)}
    {@const status = statusFor(call.id, timings, resultsByCallId, sending)}
    {@const isOpen = expanded[call.id] === true}
    {@const activity = activityFor(call)}
    {@const pill = durationPill(call.id, timings, nowMs)}
    <div class="tool-call">
      <button
        type="button"
        class="tool-call-row"
        class:open={isOpen}
        onclick={() => toggle(call.id)}
        aria-expanded={isOpen}
      >
        {#if activity}
          <!-- Full-width row above the summary. Wraps freely so a long
               sentence stays readable on narrow viewports - the previous
               layout shared a row with the status glyph, name, duration
               pill, and chevron, which on mobile left ~30ch and clipped
               the activity behind ellipsis. -->
          <span class="tool-activity">{activity}</span>
        {/if}
        <span class="tool-call-summary">
          <span class="tool-status status-{status}" aria-hidden="true">
            {#if status === 'pending'}
              <!-- Rotated via CSS animation when the status class is
                   status-pending. Character choice favors glyphs that
                   read clearly at small sizes in Lekton Mono. -->
              ↻
            {:else if status === 'ok'}
              ✓
            {:else}
              ✗
            {/if}
          </span>
          {#if activity}
            <span class="tool-name-sub">{call.function.name}</span>
          {:else}
            <span class="tool-name">{call.function.name}</span>
          {/if}
          {#if pill}
            <span class="tool-pill">{pill}</span>
          {/if}
          <span class="tool-chevron" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
        </span>
      </button>
      {#if isOpen}
        {@const view = viewMode[call.id] ?? DEFAULT_DETAIL_VIEW}
        {@const formatters = formattersFor(call.function.name)}
        <!-- Clicking anywhere on the expanded detail collapses it - a
             long result pushes the row toggle far off-screen, so
             collapsing from the bottom shouldn't require scrolling back
             up. Pointer convenience only: the row button above stays
             the accessible, keyboard-reachable toggle, so no
             role/tabindex here. The guard leaves clicks on the
             view-mode toggle and on links in markdown-rendered results
             to their own behavior, and skips the click that ends a
             text drag-selection so copying a payload doesn't snap the
             panel shut. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="tool-detail"
          title="Click to collapse"
          onclick={(event) => {
            if (clickShouldCollapse(event.target, window.getSelection())) {
              toggle(call.id);
            }
          }}
        >
          <div class="tool-detail-header">
            <h3 class="tool-detail-label">arguments</h3>
            <!-- Per-call view toggle. The button label names the
                 OTHER view (so a user reading markdown sees
                 "view: json" and knows what the click does). The
                 markdown shape covers the common reading case;
                 JSON stays one click away for users who want the
                 raw wire payload (debugging, copy-paste). -->
            <button
              type="button"
              class="tool-detail-view-toggle"
              onclick={() => flipView(call.id)}
              aria-label="Switch tool-call view"
            >
              view: {view === 'markdown' ? 'json' : 'pretty'}
            </button>
          </div>
          <Markdown content={renderArgs(call, view, formatters)} />
          <h3 class="tool-detail-label">result</h3>
          <Markdown content={renderResult(call.id, resultsByCallId, view, formatters)} />
        </div>
      {/if}
    </div>
  {/each}
</div>
