/**
 * Integration test for the `web_search` tool. Hits the real Venice API
 * with a temporary key supplied via the `VENICE_INFERENCE_KEY` env var
 * and captures the actual failure shape we see in production. Skipped
 * by default - the test only runs when the env var is set, so CI
 * never picks up an inadvertently-committed key and unit-test runs
 * stay hermetic.
 *
 * Why this exists: the `web_search` tool keeps surfacing
 *   "sub-agent completion produced no answer text. This usually
 *    indicates a transient fast-tier failure, a content-filter
 *    rejection, or the search backend returning no usable hits
 *    without a no-results note."
 * to the chat. The string is correct - the underlying completeChat
 * call returns empty text - but the *cause* needs live traffic to
 * diagnose. This test reproduces the call against the same model
 * (`agentModel('webSearch').id`), with the same `webSearch: 'on'` +
 * `webCitations: true` flags the tool sets, and prints the full
 * response shape (text, reasoning, citations, finishReason, usage)
 * so we can see whether Venice is dropping text, exhausting the
 * token budget on reasoning, or returning citations without prose.
 *
 * Run locally with:
 *   VENICE_INFERENCE_KEY=<key> pnpm exec vitest run tests/web-search.integration.test.ts
 */
import { describe, it, expect } from 'vitest';
import { VeniceClient } from '../src/lib/venice';
import { webSearch, WEB_SEARCH_SYSTEM_PROMPT } from '../src/lib/tools/web_search';
import { agentModel } from '../src/lib/models';
import type { ToolContext } from '../src/lib/tools/types';
import type { SupabaseService } from '../src/lib/supabase';

const apiKey = process.env.VENICE_INFERENCE_KEY ?? '';
const RUN = apiKey.length > 0;

// Use vitest's conditional .skipIf so the file is harmless when the
// env var is missing (CI, hermetic local runs) but engages when the
// developer wires a key in for debugging.
const itLive = RUN ? it : it.skip;

function makeCtx(venice: VeniceClient): ToolContext {
  // The tool only reads `venice` and `signal`; the rest can be stubs.
  return {
    venice,
    supabase: {} as unknown as SupabaseService,
    userId: 'test-user',
    threadId: 'test-thread',
    signal: new AbortController().signal,
  };
}

describe('web_search integration (live Venice)', () => {
  if (!RUN) {
    // Surface the skip reason in the test output so a local run that
    // forgot the env var doesn't look like a silent pass.
    // eslint-disable-next-line no-console
    console.log(
      '[web-search.integration] skipped: VENICE_INFERENCE_KEY not set'
    );
  }

  itLive(
    'captures the raw completeChat shape for a simple time-sensitive query',
    async () => {
      const venice = new VeniceClient({ apiKey });
      // Historical regression witness: the 400-token cap (without
      // disableThinking) is the failure shape web_search hit before
      // the fix - the reasoning model's CoT preamble ate the budget
      // and `content` came back empty. We hold the value at 400 on
      // purpose so this test stays a useful repro for "did the
      // budget-vs-CoT bug come back?"; the production tool now uses
      // an 8196 cap + disableThinking and is well clear of this trap.
      const result = await venice.completeChat({
        model: agentModel('webSearch').id,
        messages: [
          { role: 'system', content: WEB_SEARCH_SYSTEM_PROMPT },
          { role: 'user', content: 'Query: who is the current US president' },
        ],
        webSearch: 'on',
        webCitations: true,
        maxTokens: 400,
        signal: new AbortController().signal,
      });
      // eslint-disable-next-line no-console
      console.log('[completeChat] raw response shape:', {
        textLength: result.text.length,
        textPreview: result.text.slice(0, 200),
        reasoningLength: result.reasoning.length,
        reasoningPreview: result.reasoning.slice(0, 200),
        citationsCount: result.citations.length,
        finishReason: result.finishReason,
        usage: result.usage,
      });
      // Don't fail the run if Venice produced no text - that's the
      // bug we're investigating; failing here would just hide the
      // observation. We log the shape and exit; the live failure
      // reproduction is below.
      expect(result).toBeDefined();
    },
    60_000
  );

  itLive(
    'reproduces the empty-answer error path through web_search.execute',
    async () => {
      const venice = new VeniceClient({ apiKey });
      const ctx = makeCtx(venice);
      let err: Error | null = null;
      let value: unknown = null;
      try {
        value = await webSearch.execute(
          { query: 'who is the current US president' },
          ctx
        );
      } catch (e) {
        err = e as Error;
      }
      // eslint-disable-next-line no-console
      console.log('[web_search.execute]', err ? `THREW: ${err.message}` : 'OK', {
        value,
      });
      // Same rationale as above: don't gate the assertion - we want
      // to see what happens, not enforce a contract that the live
      // service might be violating.
      expect(true).toBe(true);
    },
    60_000
  );

  itLive(
    'tries the same query without webSearch to see if the model emits text at all',
    async () => {
      // Control: if even a plain (no-search) call to the same model
      // returns empty text, the issue isn't search-specific. If it
      // returns text here but not above, the search augmentation
      // path is the problem.
      const venice = new VeniceClient({ apiKey });
      const result = await venice.completeChat({
        model: agentModel('webSearch').id,
        messages: [
          { role: 'system', content: WEB_SEARCH_SYSTEM_PROMPT },
          { role: 'user', content: 'Query: who is the current US president' },
        ],
        maxTokens: 400,
        signal: new AbortController().signal,
      });
      // eslint-disable-next-line no-console
      console.log('[completeChat NO-SEARCH] raw response shape:', {
        textLength: result.text.length,
        textPreview: result.text.slice(0, 200),
        reasoningLength: result.reasoning.length,
        reasoningPreview: result.reasoning.slice(0, 200),
        finishReason: result.finishReason,
        usage: result.usage,
      });
      expect(result).toBeDefined();
    },
    60_000
  );
});
