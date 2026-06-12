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
      return Promise.resolve(script.rpc(name, args));
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
      name === 'compute_wiki_terminal_msg_id'
        ? { data: 'a1', error: null }
        : { data: null, error: null },
    tables: HAPPY_TABLES,
  });

  const result = await retryWikiThread(admin, 'u', 't-1', {
    // deno-lint-ignore require-await
    complete: async (opts) => {
      models.push(opts.model);
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
  assertEquals(models, ['deepseek-v4-flash', 'arcee-trinity-large-thinking']);
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
      name === 'compute_wiki_terminal_msg_id'
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
      name === 'compute_wiki_terminal_msg_id'
        ? { data: 'a1', error: null }
        : { data: null, error: null },
    tables: HAPPY_TABLES,
  });

  const result = await retryWikiThread(admin, 'u', 't-1', {
    // deno-lint-ignore require-await
    complete: async (opts) => {
      models.push(opts.model);
      if (opts.model === 'deepseek-v4-flash') throw FILTER_ERROR;
      throw new Error('arcee timeout');
    },
  });

  assertEquals(result.kind, 'error');
  // The primary's classifier rejection is no longer the headline once
  // we have moved past it - the fallback's failure is what stopped us.
  if (result.kind === 'error') assertStringIncludes(result.error, 'arcee timeout');
  assertEquals(models, ['deepseek-v4-flash', 'arcee-trinity-large-thinking']);
});

Deno.test('retry: no terminal assistant message is a no-op that never reaches Venice', async () => {
  let completeCalls = 0;
  const { admin, rpcCalls } = makeAdmin({
    rpc: (name) =>
      name === 'compute_wiki_terminal_msg_id'
        ? { data: null, error: null }
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

Deno.test('retry: a pointer-advance failure after a successful run surfaces as an error', async () => {
  const { admin } = makeAdmin({
    rpc: (name) => {
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
