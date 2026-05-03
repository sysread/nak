/**
 * Coverage for the conversation-recovery synthesis module. The module
 * runs inside `listMessages` against every thread read, so the cases
 * here exhaustively pin which trailing shapes get synthesized into a
 * wire-format-valid sequence and which are passed through unchanged.
 *
 * The shapes that matter are the ones that produce
 *   "Unexpected role 'user' after role 'tool'" (or its sibling
 *   "tool_calls without responses") on the next prompt-append - those
 * MUST be repaired. Healthy shapes MUST pass through by reference so
 * callers can short-circuit on identity.
 */
import { describe, it, expect } from 'vitest';
import {
  synthesizeRecoveryMessages,
  isRecoveryMessage,
  trimToCompleteTurn,
  trimToFirstUserOrSystem,
  RECOVERY_MARKER,
} from '../src/lib/conversation-recovery';
import type { Message } from '../src/lib/supabase';
import type { OpenAIToolCall } from '../src/lib/tools/types';

let nextId = 0;
function msg(
  role: Message['role'],
  content: string,
  extras: Partial<Message> = {}
): Message {
  return {
    id: `m-${++nextId}`,
    thread_id: 't-1',
    role,
    content,
    created_at: new Date().toISOString(),
    ...extras,
  };
}

function call(id: string, name = 'do_thing', args = '{}'): OpenAIToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

describe('synthesizeRecoveryMessages', () => {
  it('returns the array unchanged when empty', () => {
    const empty: Message[] = [];
    expect(synthesizeRecoveryMessages(empty)).toBe(empty);
  });

  it('passes a healthy assistant-ended thread through by reference', () => {
    const thread = [
      msg('user', 'hi'),
      msg('assistant', 'hello'),
    ];
    expect(synthesizeRecoveryMessages(thread)).toBe(thread);
  });

  it('passes a user-ended thread through (the chat-loop is about to respond)', () => {
    const thread = [
      msg('user', 'hi'),
      msg('assistant', 'hello'),
      msg('user', 'follow up'),
    ];
    expect(synthesizeRecoveryMessages(thread)).toBe(thread);
  });

  it('passes a complete tool-using turn through (asst, tool, asst)', () => {
    const thread = [
      msg('user', 'hi'),
      msg('assistant', '', { tool_calls: [call('tc1')] }),
      msg('tool', '{"ok":true}', { tool_call_id: 'tc1', name: 'do_thing' }),
      msg('assistant', 'done'),
    ];
    expect(synthesizeRecoveryMessages(thread)).toBe(thread);
  });

  it('repairs an orphan-tool-result tail (asst-tc, tool, [missing assistant])', () => {
    const thread = [
      msg('user', 'hi'),
      msg('assistant', '', { tool_calls: [call('tc1')] }),
      msg('tool', '{"ok":true}', { tool_call_id: 'tc1', name: 'do_thing' }),
    ];
    const result = synthesizeRecoveryMessages(thread);
    expect(result.length).toBe(thread.length + 1);
    const appended = result[result.length - 1];
    expect(appended.role).toBe('assistant');
    expect(appended.synthetic).toBe(true);
    expect(isRecoveryMessage(appended)).toBe(true);
  });

  it('repairs a partial tool fan-in (asst-tc[a,b], tool[a]) with synthetic tool[b] + assistant', () => {
    const thread = [
      msg('user', 'do a and b'),
      msg('assistant', '', {
        tool_calls: [call('tcA', 'tool_a'), call('tcB', 'tool_b')],
      }),
      msg('tool', '{"ok":true}', { tool_call_id: 'tcA', name: 'tool_a' }),
    ];
    const result = synthesizeRecoveryMessages(thread);
    // Two appended rows: synthetic tool for tcB, then recovery assistant.
    expect(result.length).toBe(thread.length + 2);
    const synthTool = result[result.length - 2];
    expect(synthTool.role).toBe('tool');
    expect(synthTool.tool_call_id).toBe('tcB');
    expect(synthTool.name).toBe('tool_b');
    expect(synthTool.synthetic).toBe(true);
    expect(isRecoveryMessage(synthTool)).toBe(true);
    const synthAsst = result[result.length - 1];
    expect(synthAsst.role).toBe('assistant');
    expect(synthAsst.synthetic).toBe(true);
  });

  it('repairs a fully-orphaned assistant-with-tool_calls (no tool rows after)', () => {
    const thread = [
      msg('user', 'do a and b'),
      msg('assistant', '', {
        tool_calls: [call('tcA', 'tool_a'), call('tcB', 'tool_b')],
      }),
    ];
    const result = synthesizeRecoveryMessages(thread);
    // Two synthetic tool rows + one synthetic assistant row.
    expect(result.length).toBe(thread.length + 3);
    expect(result[result.length - 3].role).toBe('tool');
    expect(result[result.length - 3].tool_call_id).toBe('tcA');
    expect(result[result.length - 2].role).toBe('tool');
    expect(result[result.length - 2].tool_call_id).toBe('tcB');
    expect(result[result.length - 1].role).toBe('assistant');
    for (const row of result.slice(-3)) {
      expect(row.synthetic).toBe(true);
      expect(isRecoveryMessage(row)).toBe(true);
    }
  });

  it('passes an assistant with empty tool_calls array through (no calls to answer)', () => {
    const thread = [
      msg('user', 'hi'),
      msg('assistant', 'hello', { tool_calls: [] }),
    ];
    expect(synthesizeRecoveryMessages(thread)).toBe(thread);
  });

  it('is idempotent: a thread already ending in a recovery row is passed through', () => {
    const thread = [
      msg('user', 'hi'),
      msg('assistant', '', { tool_calls: [call('tc1')] }),
      msg('tool', '{"ok":true}', { tool_call_id: 'tc1', name: 'do_thing' }),
    ];
    const healed = synthesizeRecoveryMessages(thread);
    // Calling synthesize on the already-healed array must NOT add more.
    const healedAgain = synthesizeRecoveryMessages(healed);
    expect(healedAgain).toBe(healed);
  });

  it('embeds the recovery marker so isRecoveryMessage detects it', () => {
    const synth = synthesizeRecoveryMessages([
      msg('user', 'hi'),
      msg('assistant', '', { tool_calls: [call('tc1')] }),
      msg('tool', '{}', { tool_call_id: 'tc1', name: 'do_thing' }),
    ]);
    const recovery = synth[synth.length - 1];
    expect(recovery.content).toContain(RECOVERY_MARKER);
  });

  it('handles a trailing tool row with no assistant parent gracefully (no crash)', () => {
    // Pathological - a tool row at the very start of a thread - but
    // listMessages should never wedge if it arrives. Just append a
    // recovery assistant; the tool row stays as-is.
    const thread = [
      msg('tool', '{"orphan":true}', { tool_call_id: 'tcX', name: 'mystery' }),
    ];
    const result = synthesizeRecoveryMessages(thread);
    expect(result.length).toBe(2);
    expect(result[1].role).toBe('assistant');
    expect(result[1].synthetic).toBe(true);
  });
});

describe('trimToCompleteTurn', () => {
  it('returns the array unchanged when the last row is a complete turn', () => {
    const thread = [msg('user', 'hi'), msg('assistant', 'hello')];
    expect(trimToCompleteTurn(thread)).toBe(thread);
  });

  it('drops a trailing tool row', () => {
    const thread = [
      msg('user', 'hi'),
      msg('assistant', '', { tool_calls: [call('tc1')] }),
      msg('tool', '{}', { tool_call_id: 'tc1' }),
    ];
    const trimmed = trimToCompleteTurn(thread);
    // Both the trailing tool AND the now-orphaned assistant-with-tc get dropped.
    expect(trimmed.length).toBe(1);
    expect(trimmed[0].role).toBe('user');
  });

  it('drops a trailing assistant-with-tool_calls (orphan)', () => {
    const thread = [
      msg('user', 'hi'),
      msg('assistant', '', { tool_calls: [call('tc1')] }),
    ];
    const trimmed = trimToCompleteTurn(thread);
    expect(trimmed.length).toBe(1);
    expect(trimmed[0].role).toBe('user');
  });

  it('drops multiple trailing tool rows in a row', () => {
    const thread = [
      msg('user', 'hi'),
      msg('assistant', '', { tool_calls: [call('a'), call('b')] }),
      msg('tool', '{}', { tool_call_id: 'a' }),
      msg('tool', '{}', { tool_call_id: 'b' }),
    ];
    const trimmed = trimToCompleteTurn(thread);
    expect(trimmed.length).toBe(1);
    expect(trimmed[0].role).toBe('user');
  });

  it('keeps an assistant-with-tool_calls when followed by its complete tool fan-in + final assistant', () => {
    const thread = [
      msg('user', 'hi'),
      msg('assistant', '', { tool_calls: [call('tc1')] }),
      msg('tool', '{}', { tool_call_id: 'tc1' }),
      msg('assistant', 'final'),
    ];
    expect(trimToCompleteTurn(thread)).toBe(thread);
  });
});

describe('trimToFirstUserOrSystem', () => {
  it('returns the array unchanged when the first row is user', () => {
    const thread = [msg('user', 'hi'), msg('assistant', 'hello')];
    expect(trimToFirstUserOrSystem(thread)).toBe(thread);
  });

  it('returns the array unchanged when the first row is system', () => {
    const thread = [msg('system', 'sys'), msg('user', 'hi')];
    expect(trimToFirstUserOrSystem(thread)).toBe(thread);
  });

  it('drops leading orphan tool rows', () => {
    const thread = [
      msg('tool', '{}', { tool_call_id: 'tc1' }),
      msg('user', 'hi'),
      msg('assistant', 'hello'),
    ];
    const trimmed = trimToFirstUserOrSystem(thread);
    expect(trimmed.length).toBe(2);
    expect(trimmed[0].role).toBe('user');
  });

  it('drops a leading assistant turn that begins mid-exchange', () => {
    const thread = [
      msg('assistant', 'mid-turn'),
      msg('user', 'next'),
      msg('assistant', 'reply'),
    ];
    const trimmed = trimToFirstUserOrSystem(thread);
    expect(trimmed.length).toBe(2);
    expect(trimmed[0].role).toBe('user');
  });

  it('returns empty when no user or system row exists', () => {
    const thread = [msg('assistant', 'a'), msg('tool', '{}')];
    const trimmed = trimToFirstUserOrSystem(thread);
    expect(trimmed.length).toBe(0);
  });
});
