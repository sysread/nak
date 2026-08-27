// web_search (function-side port)
//
// Two retrieval modes behind one tool name:
//
// - query mode: calls Venice with enable_web_search='on' through a
//   one-shot non-streaming completion against a dedicated search
//   model, harvests the synthesized answer plus web_search_citations,
//   and returns them to the model.
// - url mode: posts the URL to Venice's /augment/scrape endpoint and
//   returns the page content as markdown, verbatim. The search
//   pipeline is built around queries and does poorly when handed a
//   bare URL - it searches FOR the URL instead of reading it - so
//   direct links skip the search model entirely.
//
// Wire schema lives in src/lib/tools/web_search.schema.ts.
//
// Faithfulness is the priority for the search model (a confabulated
// summary of live results is worse than none) and a CoT pass would
// only burn the answer budget - so the call pins disable_thinking,
// which is load-bearing on the current reasoning-capable id, not a
// defensive no-op. If summaries start drifting from their sources,
// mistral-small-3-2-24b-instruct is the known-faithful fallback.
// 8196-token cap matches the browser-side ceiling for citation-heavy
// summaries.
//
// Empty-text-with-citations is treated as an error rather than a
// silent empty result - mirror of the browser path's discipline.
//
// Both modes tag their result with the untrusted-content notice (see
// ../untrusted-content.ts). Query mode needs it as much as url mode
// does: the synthesis is written by our own sub-model, but that model
// read attacker-reachable pages to write it, so a directive planted on
// a search hit can launder itself into the summary text and into the
// citation snippets riding alongside it.

import { registerTool, type ToolContext, type ToolDef } from '../performToolCall.ts';
import { readVeniceKey } from './_venice_key.ts';
import { toolComplete } from './_venice_complete.ts';
import { veniceScrapeUrl } from '../../_shared/venice.ts';
import { withUntrustedNotice } from '../untrusted-content.ts';

// Ceiling on scraped-page content returned to the model, in
// characters (~8k tokens - the same order as the query mode's
// 8196-token answer cap). Scraped pages are unbounded; an article
// index or a docs page can run hundreds of KB of markdown, which
// would blow the chat context in one tool round. Truncation is
// flagged in the result so the model knows the tail is missing.
const SCRAPE_MAX_CHARS = 32_000;

// Mirror of agentModel('webSearch') in src/lib/models/index.ts. Same
// same-PR sync discipline as the other browser-mirror constants.
const WEB_SEARCH_MODEL = 'z-ai-glm-5-3-flash';

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
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    if (query.length === 0 && url.length === 0) {
      throw new Error(
        'web_search requires either a `query` (to search) or a `url` (to fetch one page)'
      );
    }

    if (url.length > 0) {
      // A URL wins over a query when both arrive: the model naming a
      // specific page is the stronger signal of intent, and scraping
      // it answers the query-shaped framing anyway.
      return await executeScrape(url, ctx);
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

    return withUntrustedNotice('a live web search', {
      answer: trimmed,
      citations: result.citations,
    });
  },
};

// url mode: fetch one page via Venice's scrape endpoint and hand its
// markdown to the model raw - no sub-completion, no synthesis. The
// single self-citation makes the fetched page surface in the reply's
// sources panel through the same tool-citation harvest the query
// mode's citations ride (getStreamingResponse.ts).
async function executeScrape(url: string, ctx: ToolContext) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`web_search: \`url\` is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `web_search: \`url\` must be http(s), got ${parsed.protocol}//`
    );
  }

  const apiKey = await readVeniceKey(ctx.adminClient);
  if (!apiKey) throw new Error('no Venice key configured (app_config unseeded)');

  const content = await veniceScrapeUrl({ apiKey, url, signal: ctx.signal });

  const truncated = content.length > SCRAPE_MAX_CHARS;
  return withUntrustedNotice(`the web page ${url}`, {
    url,
    content: truncated ? content.slice(0, SCRAPE_MAX_CHARS) : content,
    ...(truncated ? { truncated: true } : {}),
    citations: [{ title: url, url, content: null, date: null, index: 1 }],
  });
}

registerTool(webSearch);
