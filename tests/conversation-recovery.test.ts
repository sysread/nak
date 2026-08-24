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
  // The shared counter doubles as the position: rows built in
  // sequence get ascending integer positions, mirroring what the
  // insert trigger assigns to a normally-appended thread.
  ++nextId;
  return {
    id: `m-${nextId}`,
    thread_id: 't-1',
    role,
    content,
    created_at: new Date().toISOString(),
    position: nextId,
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

describe('synthetic position placement', () => {
  it('spaces trailing synthetics strictly between the tail position and the next integer', () => {
    const thread = [
      msg('user', 'do a and b'),
      msg('assistant', '', {
        tool_calls: [call('tcA', 'tool_a'), call('tcB', 'tool_b')],
      }),
      msg('tool', '{"ok":true}', { tool_call_id: 'tcA', name: 'tool_a' }),
    ];
    const tail = thread[2].position as number;
    const result = synthesizeRecoveryMessages(thread);
    const synth = result.slice(3);
    expect(synth).toHaveLength(2);
    // Strictly increasing, and strictly below the next integer so a
    // concurrent tail append (the insert trigger's floor(max)+1) can
    // never collide with a healed row.
    expect(synth[0].position as number).toBeGreaterThan(tail);
    expect(synth[1].position as number).toBeGreaterThan(synth[0].position as number);
    expect(synth[1].position as number).toBeLessThan(tail + 1);
  });

  it('places mid-conversation synthetics strictly inside their gap', () => {
    // Case 3 shape: an unanswered tool call followed by a later user
    // turn. The healed rows must land BETWEEN the broken exchange and
    // the user row that follows it, not at the tail.
    const thread = [
      msg('user', 'do it'),
      msg('assistant', '', { tool_calls: [call('tc1')] }),
      msg('user', 'hello? are you there?'),
    ];
    const gapStart = thread[1].position as number;
    const gapEnd = thread[2].position as number;
    const result = synthesizeRecoveryMessages(thread);
    expect(result).toHaveLength(5);
    const synth = result.filter((r) => r.synthetic);
    expect(synth).toHaveLength(2);
    for (const row of synth) {
      expect(row.position as number).toBeGreaterThan(gapStart);
      expect(row.position as number).toBeLessThan(gapEnd);
    }
    // The whole healed list reads in strictly ascending position
    // order - what listMessages' ORDER BY would produce after the
    // rows persist.
    const positions = result.map((r) => r.position as number);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
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

/**
 * Mid-conversation repair: an `asst_with_tool_calls` whose tool block
 * is incomplete or missing entirely, but where the conversation
 * continues past it. Same fan-in mismatch error as end-of-conversation,
 * just buried in the middle. Drives:
 *
 *   Venice HTTP 400: Not the same number of function calls and
 *                    responses
 *
 * The walking algorithm has to thread the needle here - synthesise
 * ONLY for the genuinely-broken turn, leave every healthy turn around
 * it untouched.
 */
describe('synthesizeRecoveryMessages: mid-conversation repair', () => {
  it('repairs a partial fan-in mid-thread (asst-tc[a,b], tool[a], user, ...)', () => {
    const thread = [
      msg('user', 'do a and b'),
      msg('assistant', '', {
        tool_calls: [call('tcA', 'tool_a'), call('tcB', 'tool_b')],
      }),
      msg('tool', '{"ok":true}', { tool_call_id: 'tcA', name: 'tool_a' }),
      msg('user', 'never mind, what about c?'),
      msg('assistant', 'c is c'),
    ];
    const result = synthesizeRecoveryMessages(thread);
    // Expect synthetic tool[b] + recovery assistant inserted between
    // tool[a] and the follow-up user. Two new rows ahead of the user.
    expect(result.length).toBe(thread.length + 2);
    // Original turns up through tool[a] are unchanged.
    expect(result.slice(0, 3)).toEqual(thread.slice(0, 3));
    // Synthetic tool for tcB.
    const synthTool = result[3];
    expect(synthTool.role).toBe('tool');
    expect(synthTool.tool_call_id).toBe('tcB');
    expect(synthTool.synthetic).toBe(true);
    // Synthetic recovery assistant.
    const synthAsst = result[4];
    expect(synthAsst.role).toBe('assistant');
    expect(synthAsst.synthetic).toBe(true);
    expect(isRecoveryMessage(synthAsst)).toBe(true);
    // Original user + final assistant land after the recovery, in
    // their original order.
    expect(result[5]).toBe(thread[3]);
    expect(result[6]).toBe(thread[4]);
  });

  it('repairs a fully-orphaned asst-with-tc mid-thread (asst-tc[a], user, ...)', () => {
    // The asst announced a tool call but no tool ran at all before
    // the user typed again.
    const thread = [
      msg('user', 'find me a recipe'),
      msg('assistant', '', { tool_calls: [call('tcA', 'recipe_get')] }),
      msg('user', 'actually never mind'),
      msg('assistant', 'okay'),
    ];
    const result = synthesizeRecoveryMessages(thread);
    expect(result.length).toBe(thread.length + 2);
    // After asst-tc, synthetic tool for tcA, then recovery assistant.
    expect(result[2].role).toBe('tool');
    expect(result[2].tool_call_id).toBe('tcA');
    expect(result[2].synthetic).toBe(true);
    expect(result[3].role).toBe('assistant');
    expect(result[3].synthetic).toBe(true);
    // Original user + asst follow.
    expect(result[4]).toBe(thread[2]);
    expect(result[5]).toBe(thread[3]);
  });

  it('inserts a recovery assistant for `tool -> user` even when fan-in is complete', () => {
    // Edge case: every tool_call has a result, but no follow-up
    // assistant fired before the user typed again. The wire would
    // serialise as `tool -> user` which is itself a violation.
    const thread = [
      msg('user', 'do a'),
      msg('assistant', '', { tool_calls: [call('tcA', 'tool_a')] }),
      msg('tool', '{"ok":true}', { tool_call_id: 'tcA', name: 'tool_a' }),
      msg('user', 'follow-up'),
      msg('assistant', 'reply'),
    ];
    const result = synthesizeRecoveryMessages(thread);
    // No synthetic tool needed (tcA was answered), but a recovery
    // assistant slots in between tool and user.
    expect(result.length).toBe(thread.length + 1);
    expect(result.slice(0, 3)).toEqual(thread.slice(0, 3));
    expect(result[3].role).toBe('assistant');
    expect(result[3].synthetic).toBe(true);
    expect(isRecoveryMessage(result[3])).toBe(true);
    expect(result[4]).toBe(thread[3]);
    expect(result[5]).toBe(thread[4]);
  });

  it('repairs multiple separate broken turns in a single thread', () => {
    const thread = [
      // First broken turn: partial fan-in followed by user.
      msg('user', 'do a and b'),
      msg('assistant', '', {
        tool_calls: [call('tcA', 'tool_a'), call('tcB', 'tool_b')],
      }),
      msg('tool', '{"ok":true}', { tool_call_id: 'tcA', name: 'tool_a' }),
      msg('user', 'okay try c instead'),
      // Healthy middle turn.
      msg('assistant', 'sure'),
      // Second broken turn: orphan asst-with-tc.
      msg('user', 'now do c'),
      msg('assistant', '', { tool_calls: [call('tcC', 'tool_c')] }),
      // EOF after the orphan asst-with-tc.
    ];
    const result = synthesizeRecoveryMessages(thread);
    // First repair: synth tool[b] + recovery_asst between tool[a] and user.
    // Second repair: synth tool[c] + recovery_asst at the end.
    // Expect 4 new rows total.
    expect(result.length).toBe(thread.length + 4);
    // First repair landmarks.
    expect(result[3].role).toBe('tool');
    expect(result[3].tool_call_id).toBe('tcB');
    expect(result[4].role).toBe('assistant');
    expect(isRecoveryMessage(result[4])).toBe(true);
    // Healthy middle preserved.
    expect(result[5]).toBe(thread[3]); // 'okay try c instead'
    expect(result[6]).toBe(thread[4]); // 'sure'
    expect(result[7]).toBe(thread[5]); // 'now do c'
    expect(result[8]).toBe(thread[6]); // asst-with-tc[c]
    // Second repair landmarks.
    expect(result[9].role).toBe('tool');
    expect(result[9].tool_call_id).toBe('tcC');
    expect(result[10].role).toBe('assistant');
    expect(isRecoveryMessage(result[10])).toBe(true);
  });

  it('is idempotent on a mid-conversation thread that was already healed', () => {
    // Run synthesis once, then again - the second pass must not add
    // anything. This is the load-bearing property; without it, every
    // re-read would multiply recovery rows on a thread the chat-loop
    // hasn't yet persisted.
    const broken = [
      msg('user', 'do a and b'),
      msg('assistant', '', {
        tool_calls: [call('tcA', 'tool_a'), call('tcB', 'tool_b')],
      }),
      msg('tool', '{"ok":true}', { tool_call_id: 'tcA', name: 'tool_a' }),
      msg('user', 'next'),
      msg('assistant', 'reply'),
    ];
    const healed = synthesizeRecoveryMessages(broken);
    expect(healed.length).toBe(broken.length + 2);
    const healedAgain = synthesizeRecoveryMessages(healed);
    expect(healedAgain).toBe(healed);
  });

  it('walks past every healthy tool block without modifying anything', () => {
    // Walk-through stress test: multiple healthy tool turns in a
    // row, in different shapes. The algorithm should produce the
    // input array by reference.
    const thread = [
      msg('user', 'do a'),
      msg('assistant', '', { tool_calls: [call('tcA')] }),
      msg('tool', '{}', { tool_call_id: 'tcA' }),
      msg('assistant', 'a done'),
      msg('user', 'do b and c in parallel'),
      msg('assistant', '', { tool_calls: [call('tcB'), call('tcC')] }),
      msg('tool', '{}', { tool_call_id: 'tcB' }),
      msg('tool', '{}', { tool_call_id: 'tcC' }),
      msg('assistant', 'b and c done'),
      msg('user', 'one more'),
      msg('assistant', '', { tool_calls: [call('tcD')] }),
      msg('tool', '{}', { tool_call_id: 'tcD' }),
      msg('assistant', 'd done too'),
    ];
    expect(synthesizeRecoveryMessages(thread)).toBe(thread);
  });

  it('matches tool results by id even when they arrive out of call order', () => {
    // A parallel tool fan-out where the responses come back in a
    // different order than the calls. The walk uses id-based set
    // membership, so this is wire-valid and shouldn't trigger.
    const thread = [
      msg('user', 'parallel'),
      msg('assistant', '', { tool_calls: [call('tcA'), call('tcB')] }),
      msg('tool', '{}', { tool_call_id: 'tcB' }),
      msg('tool', '{}', { tool_call_id: 'tcA' }),
      msg('assistant', 'both done'),
    ];
    expect(synthesizeRecoveryMessages(thread)).toBe(thread);
  });
});

/**
 * False-positive guards. Each case here is a wire-format-VALID shape
 * that the synthesizer must NOT touch. A false positive corrupts a
 * healthy thread - the user prion the branch name warns about - so
 * these are the most important tests in the file.
 */
describe('synthesizeRecoveryMessages: false-positive guards', () => {
  it('passes a long healthy single-tool-call conversation through by reference', () => {
    const thread = [
      msg('user', 'q1'),
      msg('assistant', '', { tool_calls: [call('tc1')] }),
      msg('tool', '{}', { tool_call_id: 'tc1' }),
      msg('assistant', 'a1'),
      msg('user', 'q2'),
      msg('assistant', '', { tool_calls: [call('tc2')] }),
      msg('tool', '{}', { tool_call_id: 'tc2' }),
      msg('assistant', 'a2'),
      msg('user', 'q3'),
      msg('assistant', '', { tool_calls: [call('tc3')] }),
      msg('tool', '{}', { tool_call_id: 'tc3' }),
      msg('assistant', 'a3'),
    ];
    expect(synthesizeRecoveryMessages(thread)).toBe(thread);
  });

  it('passes a complete parallel-tool turn through (4 calls, 4 results)', () => {
    const thread = [
      msg('user', 'do a, b, c, d'),
      msg('assistant', '', {
        tool_calls: [call('a'), call('b'), call('c'), call('d')],
      }),
      msg('tool', '{}', { tool_call_id: 'a' }),
      msg('tool', '{}', { tool_call_id: 'b' }),
      msg('tool', '{}', { tool_call_id: 'c' }),
      msg('tool', '{}', { tool_call_id: 'd' }),
      msg('assistant', 'all four done'),
    ];
    expect(synthesizeRecoveryMessages(thread)).toBe(thread);
  });

  it('passes consecutive multi-round tool turns within one user request through', () => {
    // chat-loop's "search, then update_title" two-step is a real
    // pattern: one user prompt, multiple asst-with-tc rounds, each
    // with its own complete fan-in, then a final assistant.
    const thread = [
      msg('user', 'find a recipe and rename the thread'),
      msg('assistant', '', { tool_calls: [call('searchTc')] }),
      msg('tool', '{"hits":[]}', { tool_call_id: 'searchTc' }),
      msg('assistant', '', { tool_calls: [call('renameTc')] }),
      msg('tool', '{"ok":true}', { tool_call_id: 'renameTc' }),
      msg('assistant', 'searched and renamed'),
    ];
    expect(synthesizeRecoveryMessages(thread)).toBe(thread);
  });

  it('passes an asst-with-EMPTY-tool_calls (length-zero array) through', () => {
    // Some providers normalise tool_calls to [] rather than null on
    // turns that didn't invoke any tool. The walk's outer check
    // gates on length > 0, so this is treated as plain assistant
    // text and nothing fires.
    const thread = [
      msg('user', 'hi'),
      msg('assistant', 'hello', { tool_calls: [] }),
    ];
    expect(synthesizeRecoveryMessages(thread)).toBe(thread);
  });

  it('passes a user-ended thread through (chat-loop is about to respond)', () => {
    // Critical: a thread waiting for the next assistant response
    // must NOT get a recovery assistant slapped on it - that would
    // rewrite the user's pending prompt as a finished exchange.
    const thread = [
      msg('user', 'q1'),
      msg('assistant', 'a1'),
      msg('user', 'q2 - awaiting reply'),
    ];
    expect(synthesizeRecoveryMessages(thread)).toBe(thread);
  });

  it('passes a system-only thread through (e.g. before any user has spoken)', () => {
    const thread = [msg('system', 'you are helpful')];
    expect(synthesizeRecoveryMessages(thread)).toBe(thread);
  });

  it('preserves reference equality on a no-op pass through a long thread', () => {
    // 100 turns, all healthy. Reference equality matters because
    // listMessages calls every reader site - any unnecessary array
    // copy multiplies across the workers.
    const turns: Message[] = [];
    for (let n = 0; n < 50; n++) {
      turns.push(msg('user', `q${n}`));
      turns.push(msg('assistant', `a${n}`));
    }
    expect(synthesizeRecoveryMessages(turns)).toBe(turns);
  });

  it('does not synthesize for a healthy turn followed immediately by a broken one', () => {
    // Make sure the walk doesn't bleed state across turns. The
    // first turn is complete; only the second should get repair.
    const thread = [
      msg('user', 'first'),
      msg('assistant', '', { tool_calls: [call('tc1')] }),
      msg('tool', '{}', { tool_call_id: 'tc1' }),
      msg('assistant', 'first done'),
      msg('user', 'second'),
      msg('assistant', '', { tool_calls: [call('tc2')] }),
      // EOF: tc2 unanswered.
    ];
    const result = synthesizeRecoveryMessages(thread);
    expect(result.length).toBe(thread.length + 2);
    // First four rows untouched.
    expect(result.slice(0, 4)).toEqual(thread.slice(0, 4));
    expect(result[4]).toBe(thread[4]);
    expect(result[5]).toBe(thread[5]);
    // Repair lives at the end.
    expect(result[6].role).toBe('tool');
    expect(result[6].tool_call_id).toBe('tc2');
    expect(result[6].synthetic).toBe(true);
    expect(result[7].role).toBe('assistant');
    expect(result[7].synthetic).toBe(true);
  });

  it('does not insert a recovery between a complete tool block and its assistant follow-up', () => {
    // The most important false-positive guard for the new logic:
    // tool[b] -> tool[a] -> assistant is the canonical happy path
    // and cannot be touched.
    const thread = [
      msg('user', 'parallel'),
      msg('assistant', '', { tool_calls: [call('a'), call('b')] }),
      msg('tool', '{}', { tool_call_id: 'b' }),
      msg('tool', '{}', { tool_call_id: 'a' }),
      msg('assistant', 'reply'),
      msg('user', 'follow-up'),
    ];
    expect(synthesizeRecoveryMessages(thread)).toBe(thread);
  });
});
