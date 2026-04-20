<script lang="ts">
  /*
   * Nested tool-call display, rendered inside an assistant bubble when
   * that turn invoked tools. One row per call:
   *
   *   [status-glyph]  [tool-name]  [duration-or-timer-pill]
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
   *     falls back to parsing the result content — a payload with an
   *     `error` key renders as failure, otherwise success.
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
  }
  let { calls, resultsByCallId, timings, nowMs }: Props = $props();

  let expanded = $state<Record<string, boolean>>({});

  type Status = 'pending' | 'ok' | 'error';

  function statusFor(callId: string): Status {
    const t = timings[callId];
    const result = resultsByCallId[callId];
    // Session-local: timings are canonical while the call is in flight.
    if (t && !t.endedAt) return 'pending';
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
        // Non-JSON content is uncommon but fine — treat as success.
      }
      return 'ok';
    }
    return 'pending';
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
</script>

<div class="tool-calls" role="group" aria-label="Tool calls">
  <div class="tool-calls-heading">Tools:</div>
  {#each calls as call (call.id)}
    {@const status = statusFor(call.id)}
    {@const isOpen = expanded[call.id] === true}
    <div class="tool-call">
      <button
        type="button"
        class="tool-call-row"
        class:open={isOpen}
        onclick={() => toggle(call.id)}
        aria-expanded={isOpen}
      >
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
        <span class="tool-name">{call.function.name}</span>
        {#if durationPill(call.id)}
          <span class="tool-pill">{durationPill(call.id)}</span>
        {/if}
        <span class="tool-chevron" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
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
