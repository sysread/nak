/**
 * Coverage for the background title-generation pipeline that fires
 * in parallel with the main chat-loop on the opening turn of a fresh
 * thread.
 */
import { describe, it, expect, vi } from 'vitest';
import { generateThreadTitle } from '../src/lib/title-gen';
import { agentModel } from '../src/lib/models';
import type { ChatRequest, ChatCompletion, VeniceClient } from '../src/lib/venice';

function mkCompletion(text: string): ChatCompletion {
  return {
    text,
    reasoning: '',
    toolCalls: [],
    usage: null,
    citations: [],
    finishReason: 'stop',
  };
}

function mkVenice(impl: (req: ChatRequest) => Promise<ChatCompletion>) {
  const seen: ChatRequest[] = [];
  const venice = {
    async completeChat(req: ChatRequest): Promise<ChatCompletion> {
      seen.push(req);
      return impl(req);
    },
  } as unknown as VeniceClient;
  return { venice, seen };
}

describe('generateThreadTitle', () => {
  it('returns the sanitised title from the completion text on success', async () => {
    // Model returns the title wrapped in stray quotes + a trailing
    // period; sanitiser strips both. Same shape the update_title tool
    // uses, so manual + tool-driven + auto-generated renames all land
    // with identical formatting.
    const { venice } = mkVenice(async () =>
      mkCompletion('"Python decorators primer."'),
    );
    const out = await generateThreadTitle(
      venice,
      'help me understand python decorators',
      new AbortController().signal,
    );
    expect(out).toBe('Python decorators primer');
  });

  it('targets the autoTitle agent model with reasoning disabled and a tight token cap', async () => {
    // The model is reasoning-capable but we want the title text
    // directly, not a CoT preamble. Lock the wire-config knobs so a
    // future revert (or a copy of this shape) doesn't silently regress
    // into "model emits empty content after burning tokens on
    // reasoning_content."
    const { venice, seen } = mkVenice(async () => mkCompletion('A title'));
    await generateThreadTitle(
      venice,
      'hello there',
      new AbortController().signal,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].model).toBe(agentModel('autoTitle').id);
    expect(seen[0].disableThinking).toBe(true);
    expect(typeof seen[0].maxTokens).toBe('number');
    // Tools NOT offered - this is a single-shot text completion.
    expect(seen[0].tools).toBeUndefined();
  });

  it('sends the user text verbatim as the prompt, no chat history', async () => {
    // The pipeline should NOT carry any prior turns, recall context,
    // or assistant priming - the system prompt + bare user text is
    // the whole input. A future caller adding "context" to the
    // title-gen prompt is exactly the kind of regression this test
    // exists to catch.
    const { venice, seen } = mkVenice(async () => mkCompletion('Title'));
    await generateThreadTitle(
      venice,
      'tell me about the moons of jupiter',
      new AbortController().signal,
    );
    const msgs = seen[0].messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1]).toEqual({
      role: 'user',
      content: 'tell me about the moons of jupiter',
    });
  });

  it('returns null on an empty / whitespace-only user message rather than firing the completion', async () => {
    // No prompt = no title. Skip the call entirely so we don't burn
    // a Venice request on a guaranteed-useless answer.
    const { venice, seen } = mkVenice(async () => mkCompletion('Title'));
    expect(
      await generateThreadTitle(venice, '', new AbortController().signal),
    ).toBeNull();
    expect(
      await generateThreadTitle(venice, '   ', new AbortController().signal),
    ).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it('returns null when the completion comes back with empty / whitespace text', async () => {
    const { venice } = mkVenice(async () => mkCompletion('   '));
    expect(
      await generateThreadTitle(venice, 'real question', new AbortController().signal),
    ).toBeNull();
  });

  it('returns null when Venice throws (network, 4xx, parse) - best-effort posture', async () => {
    // The fallback is the chat-loop's metadata-message nag on round 2,
    // so a failed background completion just delays the rename by one
    // round at worst. Caller awaits null and moves on without a try
    // around it.
    const venice = {
      async completeChat(): Promise<ChatCompletion> {
        throw new Error('venice exploded');
      },
    } as unknown as VeniceClient;
    expect(
      await generateThreadTitle(venice, 'hello', new AbortController().signal),
    ).toBeNull();
  });

  it('resolves null without throwing when the abort signal fires mid-flight', async () => {
    // The caller wires up the same controller scoping the parent send,
    // so an early abort cancels the in-flight Venice call. Resolving
    // null (rather than re-raising) means the caller's
    // .then(...) handler can be unconditional.
    const venice = {
      async completeChat(): Promise<ChatCompletion> {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    } as unknown as VeniceClient;
    const ctl = new AbortController();
    ctl.abort();
    expect(
      await generateThreadTitle(venice, 'hello', ctl.signal),
    ).toBeNull();
  });

  it('looks past pleasantries to the underlying topic in the system prompt copy', async () => {
    // Behaviour beat lifted to a regex assertion so a future wording
    // tweak surfaces here rather than silently changing how the model
    // titles greeting-prefixed messages. The "look past pleasantries"
    // framing is what stops "hey, can you help me with X?" from
    // titling as "Greeting".
    const { venice, seen } = mkVenice(async () => mkCompletion('Title'));
    await generateThreadTitle(venice, 'hi', new AbortController().signal);
    const sys = seen[0].messages[0].content;
    expect(typeof sys).toBe('string');
    expect(sys as string).toMatch(/greeting|pleasantr/i);
    expect(sys as string).toMatch(/3-6\s+word|3\s+to\s+6\s+word/i);
  });
});

// Silence the auto-title logger's warn output during the negative-path
// tests so the suite doesn't print fake-error spam to stderr.
vi.spyOn(console, 'warn').mockImplementation(() => {});
