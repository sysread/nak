// Behavioral coverage for the wiki agent's retry path, driven through
// the runner's completion seam: the content-classifier fallback
// ordering (primary model first, uncensored fallback second, and ONLY
// on the classifier sentinel) and the pointer/skip-marker semantics
// around it. Port of the inventory the deleted browser suite
// (tests/wiki-agent.test.ts) carried before the fleet moved
// server-side.

import { assertEquals, assertStringIncludes } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import { retryWikiThread } from '../venice/agents/wiki.ts';
import type { ToolCompletionResult } from '../venice/tools/_venice_complete.ts';

function completion(partial: Partial<ToolCompletionResult>): ToolCompletionResult {
  return {
    text: '',
    reasoning: '',
    citations: [],
    finishReason: 'stop',
    usage: null,
    toolCalls: [],
    ...partial,
  };
}

interface StubResult {
  data: unknown;
  error: { message: string } | null;
}

/**
 * Minimal thenable PostgREST-builder stub: every chain method returns
 * the same object, and awaiting it (or calling single/maybeSingle)
 * resolves the scripted result. Enough for the read paths the retry
 * flow touches (messages list, app_config key, profiles settings).
 */
function chain(result: StubResult): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit', 'in', 'insert', 'update', 'delete', 'upsert']) {
    c[m] = () => c;
  }
  c.maybeSingle = () => Promise.resolve(result);
  c.single = () => Promise.resolve(result);
  c.then = (
    resolve: (v: StubResult) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return c;
}

interface FakeAdminScript {
  rpc: (name: string, args: Record<string, unknown>) => StubResult;
  tables: Record<string, StubResult>;
}

function makeAdmin(script: FakeAdminScript): {
  admin: SupabaseClient;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const admin = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      // thread_transcript is the transcript read path (a
      // set-returning function the loader chains .select() on), so
      // serve it from the `messages` table stub - scripts keep
      // declaring transcript data under `tables.messages`. Every
      // other rpc resolves its scripted result; chain() keeps the
      // return awaitable whether or not the caller chains further.
      if (name === 'thread_transcript') {
        return chain(
          script.tables['messages'] ?? {
            data: null,
            error: { message: 'no stub for thread_transcript' },
          },
        );
      }
      return chain(script.rpc(name, args));
    },
    from: (table: string) =>
      chain(script.tables[table] ?? { data: null, error: { message: `no stub for table ${table}` } }),
  } as unknown as SupabaseClient;
  return { admin, rpcCalls };
}

const MESSAGES = [
  { id: 'u1', role: 'user', content: 'tell me about my dog', tool_calls: null, tool_call_id: null, name: null },
  { id: 'a1', role: 'assistant', content: 'Got it.', tool_calls: null, tool_call_id: null, name: null },
];

const HAPPY_TABLES: Record<string, StubResult> = {
  messages: { data: MESSAGES, error: null },
  app_config: { data: { venice_api_key: 'key' }, error: null },
  profiles: { data: { settings: {} }, error: null },
};

const FILTER_ERROR = new Error(
  'Venice chat/completions 400: {"error":"Input text data may contain inappropriate content.","request_id":"abc"}',
);

Deno.test('retry: classifier rejection on the primary retries the uncensored fallback, in order', async () => {
  const models: string[] = [];
  const { admin, rpcCalls } = makeAdmin({
    rpc: (name) =>
      name === 'claim_wiki_thread_for_retry'
        ? { data: true, error: null }
        : name === 'compute_wiki_terminal_msg_id'
          ? { data: 'a1', error: null }
          : { data: null, error: null },
    tables: HAPPY_TABLES,
  });

  const efforts: Array<string | undefined> = [];
  const result = await retryWikiThread(admin, 'u', 't-1', {
    // deno-lint-ignore require-await
    complete: async (opts) => {
      models.push(opts.model);
      efforts.push(opts.reasoningEffort);
      if (opts.model === 'deepseek-v4-flash') throw FILTER_ERROR;
      return completion({ text: 'Fallback ran, no edits warranted.' });
    },
  });

  assertEquals(result.kind, 'ok');
  if (result.kind === 'ok') {
    assertEquals(result.terminalMsgId, 'a1');
    // Zero tool calls is a legitimate done outcome; the reasoning is
    // the model's operator summary.
    assertEquals(result.toolCalls, 0);
    assertEquals(result.reasoning, 'Fallback ran, no edits warranted.');
  }
  // Order matters: primary first, fallback second. A reversed order
  // would mean the agent skipped the configured model entirely.
  assertEquals(models, ['deepseek-v4-flash', 'venice-uncensored-1-2']);
  // The fallback is a non-reasoning model: reasoning_effort must stay
  // off its wire body (some providers 400 on the unknown field).
  assertEquals(efforts, ['medium', undefined]);
  // Success advances the pointer + clears the skip marker.
  assertEquals(
    rpcCalls.some((c) => c.name === 'manual_advance_wiki_pointer'),
    true,
  );
});

Deno.test('retry: a non-classifier error does NOT trigger the fallback and leaves the skip marker', async () => {
  const models: string[] = [];
  const { admin, rpcCalls } = makeAdmin({
    rpc: (name) =>
      name === 'claim_wiki_thread_for_retry'
        ? { data: true, error: null }
        : name === 'compute_wiki_terminal_msg_id'
          ? { data: 'a1', error: null }
          : { data: null, error: null },
    tables: HAPPY_TABLES,
  });

  const result = await retryWikiThread(admin, 'u', 't-1', {
    // deno-lint-ignore require-await
    complete: async (opts) => {
      models.push(opts.model);
      throw new Error('Venice chat/completions 500: gateway error');
    },
  });

  assertEquals(result.kind, 'error');
  if (result.kind === 'error') assertStringIncludes(result.error, '500');
  // One call: the primary. The fallback path is classifier-only.
  assertEquals(models, ['deepseek-v4-flash']);
  // Critical: the pointer did NOT advance, so the user keeps seeing
  // the row in the Skipped panel.
  assertEquals(
    rpcCalls.some((c) => c.name === 'manual_advance_wiki_pointer'),
    false,
  );
});

Deno.test('retry: both attempts failing surfaces the FALLBACK error', async () => {
  const models: string[] = [];
  const { admin } = makeAdmin({
    rpc: (name) =>
      name === 'claim_wiki_thread_for_retry'
        ? { data: true, error: null }
        : name === 'compute_wiki_terminal_msg_id'
          ? { data: 'a1', error: null }
          : { data: null, error: null },
    tables: HAPPY_TABLES,
  });

  const result = await retryWikiThread(admin, 'u', 't-1', {
    // deno-lint-ignore require-await
    complete: async (opts) => {
      models.push(opts.model);
      if (opts.model === 'deepseek-v4-flash') throw FILTER_ERROR;
      throw new Error('fallback timeout');
    },
  });

  assertEquals(result.kind, 'error');
  // The primary's classifier rejection is no longer the headline once
  // we have moved past it - the fallback's failure is what stopped us.
  if (result.kind === 'error') assertStringIncludes(result.error, 'fallback timeout');
  assertEquals(models, ['deepseek-v4-flash', 'venice-uncensored-1-2']);
});

Deno.test('retry: no terminal assistant message is a no-op that never reaches Venice', async () => {
  let completeCalls = 0;
  const { admin, rpcCalls } = makeAdmin({
    rpc: (name) =>
      name === 'claim_wiki_thread_for_retry'
        ? { data: true, error: null }
        : { data: null, error: null },
    tables: HAPPY_TABLES,
  });

  const result = await retryWikiThread(admin, 'u', 't-empty', {
    // deno-lint-ignore require-await
    complete: async () => {
      completeCalls += 1;
      return completion({ text: 'should not run' });
    },
  });

  assertEquals(result.kind, 'no-op');
  assertEquals(completeCalls, 0);
  assertEquals(
    rpcCalls.some((c) => c.name === 'manual_advance_wiki_pointer'),
    false,
  );
});

Deno.test('retry: an already-claimed thread is busy and never reaches Venice', async () => {
  let completeCalls = 0;
  const { admin, rpcCalls } = makeAdmin({
    // The thread is already claimed (the sweep, or a concurrent retry):
    // claim_wiki_thread_for_retry returns false.
    rpc: (name) =>
      name === 'claim_wiki_thread_for_retry'
        ? { data: false, error: null }
        : { data: null, error: null },
    tables: HAPPY_TABLES,
  });

  const result = await retryWikiThread(admin, 'u', 't-1', {
    // deno-lint-ignore require-await
    complete: async () => {
      completeCalls += 1;
      return completion({ text: 'should not run' });
    },
  });

  assertEquals(result.kind, 'busy');
  // No work happened: never resolved a terminal message, never called
  // the model, never advanced the pointer. And nothing to release - we
  // never held the claim.
  assertEquals(completeCalls, 0);
  assertEquals(
    rpcCalls.some((c) => c.name === 'compute_wiki_terminal_msg_id'),
    false,
  );
  assertEquals(
    rpcCalls.some((c) => c.name === 'release_wiki_thread_retry_claim'),
    false,
  );
});

// A completion request is a distill pass when it carries no tools -
// the tool loop always sends the toolbox wire list, the distill
// completions never do.
function isDistillCall(opts: { tools?: readonly unknown[] }): boolean {
  return !opts.tools || opts.tools.length === 0;
}

const CTX_ERROR = new Error(
  "Venice chat/completions 400: {\"error\":{\"message\":\"This model's maximum context length is 163840 tokens. However, you requested 8192 output tokens and your prompt contains at least 160000 input tokens\"}}",
);

Deno.test('retry: a mid-run context-length rejection distills the transcript and retries, without the uncensored fallback', async () => {
  const calls: Array<'act' | 'distill'> = [];
  const models = new Set<string>();
  const { admin } = makeAdmin({
    rpc: (name) =>
      name === 'claim_wiki_thread_for_retry'
        ? { data: true, error: null }
        : name === 'compute_wiki_terminal_msg_id'
          ? { data: 'a1', error: null }
          : { data: null, error: null },
    tables: HAPPY_TABLES,
  });

  const result = await retryWikiThread(admin, 'u', 't-1', {
    // deno-lint-ignore require-await
    complete: async (opts) => {
      models.add(opts.model);
      if (isDistillCall(opts)) {
        calls.push('distill');
        return completion({ text: 'DISTILLED NOTES' });
      }
      calls.push('act');
      // First act attempt: the backend says the transcript is too big.
      if (calls.filter((c) => c === 'act').length === 1) throw CTX_ERROR;
      // Second act attempt must be reading notes, not the transcript.
      const first = opts.messages[0];
      assertStringIncludes(String(first.content), '<conversation_notes>');
      assertStringIncludes(String(first.content), 'DISTILLED NOTES');
      return completion({ text: 'Processed from notes.' });
    },
  });

  assertEquals(result.kind, 'ok');
  if (result.kind === 'ok') assertEquals(result.reasoning, 'Processed from notes.');
  assertEquals(calls, ['act', 'distill', 'act']);
  // The context-length path stays on the primary model - the
  // uncensored fallback is for classifier rejections only.
  assertEquals([...models], ['deepseek-v4-flash']);
});

Deno.test('retry: a context-length rejection that survives distillation surfaces as an error', async () => {
  const { admin, rpcCalls } = makeAdmin({
    rpc: (name) =>
      name === 'claim_wiki_thread_for_retry'
        ? { data: true, error: null }
        : name === 'compute_wiki_terminal_msg_id'
          ? { data: 'a1', error: null }
          : { data: null, error: null },
    tables: HAPPY_TABLES,
  });

  const result = await retryWikiThread(admin, 'u', 't-1', {
    // Every completion - act and distill alike - hits the ceiling.
    // deno-lint-ignore require-await
    complete: async () => {
      throw CTX_ERROR;
    },
  });

  assertEquals(result.kind, 'error');
  if (result.kind === 'error') assertStringIncludes(result.error, 'maximum context length');
  // No pointer advance: the thread stays visible in the Skipped panel.
  assertEquals(
    rpcCalls.some((c) => c.name === 'manual_advance_wiki_pointer'),
    false,
  );
});

Deno.test('retry: agent rounds carry an explicit max_completion_tokens cap', async () => {
  const caps: Array<number | undefined> = [];
  const { admin } = makeAdmin({
    rpc: (name) =>
      name === 'claim_wiki_thread_for_retry'
        ? { data: true, error: null }
        : name === 'compute_wiki_terminal_msg_id'
          ? { data: 'a1', error: null }
          : { data: null, error: null },
    tables: HAPPY_TABLES,
  });

  const result = await retryWikiThread(admin, 'u', 't-1', {
    // deno-lint-ignore require-await
    complete: async (opts) => {
      caps.push(opts.maxTokens);
      return completion({ text: 'done' });
    },
  });

  assertEquals(result.kind, 'ok');
  // An absent cap makes the serving backend reserve its own default
  // output budget (observed 65536 tokens) out of the context window -
  // the root cause of the 2026-07-23 skipped threads.
  assertEquals(caps, [8_192]);
});

Deno.test('retry: a pointer-advance failure after a successful run surfaces as an error', async () => {
  const { admin } = makeAdmin({
    rpc: (name) => {
      if (name === 'claim_wiki_thread_for_retry') return { data: true, error: null };
      if (name === 'compute_wiki_terminal_msg_id') return { data: 'a1', error: null };
      if (name === 'manual_advance_wiki_pointer') return { data: null, error: { message: 'RPC blew up' } };
      return { data: null, error: null };
    },
    tables: HAPPY_TABLES,
  });

  const result = await retryWikiThread(admin, 'u', 't-1', {
    // deno-lint-ignore require-await
    complete: async () => completion({ text: 'done' }),
  });

  assertEquals(result.kind, 'error');
  if (result.kind === 'error') {
    assertStringIncludes(result.error, 'pointer-advance failed');
    assertStringIncludes(result.error, 'RPC blew up');
  }
});
