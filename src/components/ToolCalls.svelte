<script lang="ts">
  /*
   * Nested tool-call display, rendered inside an assistant bubble when
   * that turn invoked tools. One row per call. When the model provided
   * an `activity` narration (injected into every tool schema in
   * src/lib/tools/dispatch.ts), the row stacks vertically: the
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

  interface CallTiming {
    startedAt: number;
    endedAt?: number;
    error?: boolean;
  }

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

  type Status = 'pending' | 'ok' | 'error';

  function statusFor(callId: string): Status {
    const t = timings[callId];
    const result = resultsByCallId[callId];
    // Session-local: a started-but-not-ended timing means the call is
    // in flight - but only if the session is actually still streaming.
    // If `sending` is false, the stream ended without completing this
    // tool (parent finalizes dangling timings on the sending->idle
    // edge, so this branch is rarely hit; the guard is defense in
    // depth for the frame between the edge firing and the finalize
    // effect running).
    if (t && !t.endedAt) return sending ? 'pending' : 'error';
    if (t?.error) return 'error';
    // Replayed history: we don't have timings, so fall back to the
    // tool-result row. A JSON `error` key means the execution failed;
    // anything else we treat as success.
    if (result) {
      try {
        const parsed = JSON.parse(result.content) as unknown;
        if (parsed && typeof parsed === 'object' && 'error' in (parsed as object)) {
          return 'error';
        }
      } catch {
        // Non-JSON content is uncommon but fine - treat as success.
      }
      return 'ok';
    }
    // No timing, no result. During an active turn this is the brief
    // window between the assistant message landing in `messages` and
    // the first onToolStart handler firing - render as pending so the
    // row doesn't flash red. When the session is idle it means the
    // tool_calls persisted but execution never ran (stream cut off
    // before any tool started, or thread opened fresh with an orphan
    // tail and in-memory timings wiped) - render as errored so the
    // spinner doesn't animate indefinitely.
    return sending ? 'pending' : 'error';
  }

  function durationPill(callId: string): string {
    const t = timings[callId];
    if (!t) return '';
    if (t.endedAt !== undefined) {
      return `${Math.round(t.endedAt - t.startedAt)} ms`;
    }
    const elapsed = Math.max(0, Math.round(nowMs - t.startedAt));
    return `${elapsed} ms`;
  }

  function toggle(callId: string): void {
    expanded[callId] = !expanded[callId];
  }

  /**
   * Pretty-print a JSON string for the markdown fence. Falls back to
   * the raw string if parsing fails — the LLM occasionally emits
   * invalid JSON and we still want to show what it sent.
   */
  function prettyJson(raw: string): string {
    if (!raw) return '';
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  function fencedArgs(call: OpenAIToolCall): string {
    return '```json\n' + prettyJson(call.function.arguments || '{}') + '\n```';
  }

  function fencedResult(callId: string): string {
    const result = resultsByCallId[callId];
    if (!result) return '_In progress…_';
    return '```json\n' + prettyJson(result.content) + '\n```';
  }

  /**
   * Pull the narration sentence out of a call's arguments JSON.
   * Returns `null` when the key is missing (older persisted calls
   * from before the `activity` injection existed, or a streaming call
   * whose arguments haven't finished arriving yet), when it's not a
   * string, or when it parses to an empty string. Callers fall back
   * to the legacy tool-name-primary layout when this is null.
   */
  function activityFor(call: OpenAIToolCall): string | null {
    const raw = call.function.arguments;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && 'activity' in parsed) {
        const value = (parsed as { activity: unknown }).activity;
        if (typeof value === 'string') {
          const trimmed = value.trim();
          return trimmed.length > 0 ? trimmed : null;
        }
      }
    } catch {
      // Partial JSON during streaming is expected; the activity will
      // appear on the next render once the fragments close.
    }
    return null;
  }
</script>

<div class="tool-calls" role="group" aria-label="Tool calls">
  <div class="tool-calls-heading">Tools:</div>
  {#each calls as call (call.id)}
    {@const status = statusFor(call.id)}
    {@const isOpen = expanded[call.id] === true}
    {@const activity = activityFor(call)}
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
          {#if durationPill(call.id)}
            <span class="tool-pill">{durationPill(call.id)}</span>
          {/if}
          <span class="tool-chevron" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
        </span>
      </button>
      {#if isOpen}
        <div class="tool-detail">
          <div class="tool-detail-label">arguments</div>
          <Markdown content={fencedArgs(call)} />
          <div class="tool-detail-label">result</div>
          <Markdown content={fencedResult(call.id)} />
        </div>
      {/if}
    </div>
  {/each}
</div>
