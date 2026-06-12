// web_search (function-side port)
//
// Calls Venice with enable_web_search='on' through a one-shot
// non-streaming completion against a dedicated search model, harvests
// the synthesized answer plus web_search_citations, and returns them
// to the model. Wire schema lives in src/lib/tools/web_search.schema.ts.
//
// disable_thinking is on because the search model is reasoning-capable
// (tencent-hy3-preview defaults to high reasoning_effort) and its CoT
// pass would otherwise eat the token budget before any answer text
// lands. 8196-token cap matches the browser-side ceiling for
// citation-heavy summaries.
//
// Empty-text-with-citations is treated as an error rather than a
// silent empty result - mirror of the browser path's discipline.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { readVeniceKey } from './_venice_key.ts';
import { toolComplete } from './_venice_complete.ts';

// Mirror of agentModel('webSearch') in src/lib/models/index.ts. Same
// same-PR sync discipline as the other browser-mirror constants.
const WEB_SEARCH_MODEL = 'tencent-hy3-preview';

const WEB_SEARCH_SYSTEM_PROMPT = [
  'You are a research-savvy search assistant. Given the query below,',
  'return a concise synthesis answering it based on live web results.',
  '',
  'Source discipline:',
  '- Prefer primary sources, established outlets, official',
  '  documentation, peer-reviewed research, and recognized',
  '  subject-matter experts. Be skeptical of content farms, SEO blogs,',
  '  single-author opinion pieces, anonymous posts, and pages that',
  '  read like AI-generated rewrites of other sources.',
  '- Corroborate claims across multiple independent sources before',
  '  stating them as fact. If only one source supports a claim,',
  '  attribute it ("according to X") rather than asserting it flatly.',
  '- When sources disagree, say so rather than silently picking one.',
  '  Surface material uncertainty instead of papering over it.',
  '- For time-sensitive topics (prices, scores, news, releases),',
  '  weight recent results and flag when the best available',
  '  information looks stale.',
  '- Watch for sponsored content, press releases dressed as reporting,',
  '  and partisan framing; note the angle when it is load-bearing for',
  '  the claim.',
  '',
  'Output: 2-4 sentences. Mark sourced claims with ^N^ superscripts',
  'where N is a 1-based citation index. Do not preamble, do not',
  'describe what you are doing, do not apologize if a source is',
  'missing - just answer. If the live search turns up nothing useful',
  'or nothing recent enough to answer the query, write a brief 1-2',
  'sentence note saying what you searched for and that no relevant',
  'results were found - never return an empty response, the prose is',
  'what tells the caller you tried and came up dry.',
].join('\n');

export const webSearch: ToolDef = {
  name: 'web_search',
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (query.length === 0) {
      throw new Error('web_search requires a non-empty `query` argument');
    }
    const contextHint =
      typeof args.context_hint === 'string' ? args.context_hint.trim() : '';

    const userTurn = contextHint.length > 0
      ? `${contextHint}\n\nQuery: ${query}`
      : `Query: ${query}`;

    const apiKey = await readVeniceKey(ctx.adminClient);
    if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

    const result = await toolComplete({
      apiKey,
      model: WEB_SEARCH_MODEL,
      messages: [
        { role: 'system', content: WEB_SEARCH_SYSTEM_PROMPT },
        { role: 'user', content: userTurn },
      ],
      webSearch: 'on',
      webCitations: true,
      webScraping: true,
      disableThinking: true,
      maxTokens: 8196,
    });

    const trimmed = result.text.trim();
    if (trimmed.length === 0) {
      // Mirror of browser-path discipline: empty text with possibly
      // some citations means the sub-completion finished without
      // emitting a usable synthesis. Throw so the chat-loop's tool-
      // error path triggers; the model sees a clear failure rather
      // than an empty answer dressed up as success.
      throw new Error(
        'web_search: sub-agent completion produced no answer text. ' +
          'Common causes: transient fast-tier failure, content-filter ' +
          'rejection, search backend returning no usable hits, or the ' +
          'model exhausting its budget on reasoning. Retry the call; ' +
          'if it persists, rephrase the query or surface the failure ' +
          'to the user.',
      );
    }

    return { answer: trimmed, citations: result.citations };
  },
};

registerTool(webSearch);
