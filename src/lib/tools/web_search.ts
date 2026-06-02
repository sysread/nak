/**
 * Web-search entrypoint. The main chat model calls this when a question
 * benefits from live data (news, prices, scores, releases past the
 * training cutoff, today's weather, etc.). We run a one-shot sub-
 * completion against the fast tier with Venice's server-side web
 * search on, collect the synthesized answer plus `web_search_citations`,
 * and hand the pair back as a structured tool result.
 *
 * Why a tool rather than a venice_parameter on every turn: Venice
 * treats `enable_web_search: 'on'` as unconditional - every completion
 * runs a search whether the question needs one or not. That burns
 * quota, pollutes context with search results for questions the model
 * could have answered from weights, and makes the model hedge. Moving
 * search behind an explicit tool call means search happens only when
 * the model actually reaches for it, and citations surface only on
 * those turns.
 *
 * Toolbox scoping: `web_search` lives in the main chat's TOOLS list
 * AND in ALWAYS_ON (so it fires even when the thread's master tool
 * toggle is off - it's read-only and reflex-level, same rationale as
 * the `*_recall` tools). Deliberately excluded from `memoryToolbox`,
 * `recallToolbox`, and `conversationRecallToolbox`: background agents
 * have no reason to reach for live web data, and giving them the tool
 * would burn search quota and pollute memories with web-scraped noise.
 *
 * Citation flow: chat-loop inspects every tool result for a `citations`
 * array of the Venice shape. When it finds one, it renumbers the
 * entries into a contiguous 1-based list across the whole turn and
 * persists that on the terminal assistant row's `citations` column -
 * so the same CitationsPanel / `^N^` superscript rendering the old
 * always-on web-search path fed still works, just sourced from here.
 */
import type { ToolDef } from './types';
import type { VeniceMessage } from '../venice';
import { agentModel } from '../models';
import { createLogger } from '../logger.svelte';
import { webSearchSchema } from './web_search.schema';

const log = createLogger('web-search-tool');

/**
 * System prompt for the sub-call. Exported so tests can assert its
 * shape without re-declaring the literal.
 *
 * The bulk of this prompt is the "source discipline" block. It costs
 * tokens, but the modern web is full of SEO chum, content farms,
 * AI-generated rewrites of other AI-generated rewrites, and outdated
 * mirrors of pages that have since been corrected. A model that
 * synthesizes the top N hits without weighting source quality will
 * confidently launder slop into citations the user trusts because they
 * came back with `^N^` superscripts. Spelling out the same source-
 * evaluation heuristics librarians teach for internet research - prefer
 * primary sources, cross-reference, attribute single-source claims,
 * surface disagreement, prefer recent results for time-sensitive
 * topics - measurably improves the synthesis quality.
 *
 * Output framing (2-4 sentences, no preamble, `^N^` citation marks)
 * stays at the bottom so the sub-model sees the task shape after the
 * research stance.
 */
export const WEB_SEARCH_SYSTEM_PROMPT = [
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
  ...webSearchSchema,
  async execute(args, ctx) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (query.length === 0) {
      // Throwing here lets chat-loop's encodeToolContent fold the
      // message into `{error: "..."}` on the tool-result row, which
      // the main model reads on the next round and can adapt to
      // (e.g. retry with a non-empty query).
      throw new Error('web_search requires a non-empty `query` argument');
    }
    const contextHint =
      typeof args.context_hint === 'string' ? args.context_hint.trim() : '';

    log.info(`query: ${query.slice(0, 80)}${query.length > 80 ? '...' : ''}`);

    const userTurn = contextHint.length > 0
      ? `${contextHint}\n\nQuery: ${query}`
      : `Query: ${query}`;

    const messages: VeniceMessage[] = [
      { role: 'system', content: WEB_SEARCH_SYSTEM_PROMPT },
      { role: 'user', content: userTurn },
    ];

    // Non-streaming completion. Background sub-agents have no UI to
    // render token-by-token into, and SSE adds latency the user can't
    // see. Equally important: the silent "stream finished with no
    // text" failure mode this tool used to hit was a Venice SSE quirk
    // - the non-streaming endpoint returns the answer + citations in
    // one shot or surfaces an HTTP error, no in-between.
    //
    // disableThinking + maxTokens budget: the web-search summariser
    // resolves to whichever id `agentModel('webSearch')` is pointed
    // at (currently deepseek-v4-flash; see AGENT_MODELS in
    // src/lib/models). That id is a reasoning model that, by
    // default, emits its chain-of-thought through `reasoning_content`
    // BEFORE writing any answer text into `content`. A tight cap
    // got eaten by the CoT preamble and the model hit
    // `finish_reason: 'length'` with empty `content`. disable_thinking
    // is Venice's full off switch: the model skips the reasoning
    // pass entirely, so the entire token budget goes to the user-
    // visible answer.
    //
    // 8196 is the heightened ceiling for web-search and recall-shape
    // sub-calls - a single query can pull a dense, citation-heavy
    // summary and we'd rather pay the tokens than truncate a
    // synthesis the user is going to act on. The 2048 project-wide
    // floor would also work for the typical 2-4 sentence answer,
    // but web-search has a long tail of "summarise these N hits"
    // queries where 2048 is uncomfortably close to the wire.
    let result;
    try {
      result = await ctx.supabase.complete({
        model: agentModel('webSearch').id,
        messages,
        signal: ctx.signal,
        webSearch: 'on',
        webCitations: true,
        // The main chat loop no longer asks Venice to auto-scrape URLs
        // pasted into user turns - that injection path was retired in
        // favor of routing URL handling through this tool. We still
        // want scraping ON for the sub-completion so a research query
        // that quotes a URL (e.g. "summarize https://example.com/...")
        // pulls the page content as part of resolving the query.
        webScraping: true,
        disableThinking: true,
        maxTokens: 8196,
      });
    } catch (err) {
      // Surface the underlying Venice error into the log drawer
      // verbatim before it propagates out. The chat-loop's
      // encodeToolContent wraps the thrown message into
      // `{error: "..."}` on the tool-result row, which is what the
      // model reads on the next round - but the log drawer is the
      // only surface where a developer / power user can see the
      // actual Venice response (HTTP code, kind, body detail).
      // Without this log line, "web_search failed" arrives at the
      // drawer with no context.
      const detail = err instanceof Error ? err.message : String(err);
      log.error(`Venice completeChat failed: ${detail}`);
      throw err;
    }

    const trimmed = result.text.trim();

    // Empty answer: the sub-completion finished but emitted no usable
    // prose. Common causes: fast-tier transient failure, content-filter
    // rejection, the search backend returning zero hits and the model
    // emitting nothing rather than a no-results note, or the model
    // exhausting its output budget on reasoning before reaching text.
    // Throw rather than hand back `{answer: '', citations: [...]}` -
    // that empty shape is indistinguishable from a successful "no
    // results" response and gives the calling model no signal about
    // whether to retry, rephrase, or surface the failure to the user.
    // The throw routes through chat-loop's encodeToolContent into
    // `{error: "..."}` on the tool-result row.
    //
    // The log drawer entry carries the full diagnostic shape -
    // `finish_reason`, token usage, citation count, and a short
    // reasoning preview if any. That's what tells the developer
    // WHY text was empty: `'length'` means we hit the maxTokens cap
    // (CoT regression - check disable_thinking is set),
    // `'content_filter'` means Venice's safety layer trimmed the
    // synthesis, an empty `usage` block alongside zero text usually
    // means a transient fast-tier hiccup, etc. Without this detail,
    // the drawer just shows "no answer text" and the user has no
    // way to tell the cases apart.
    if (trimmed.length === 0) {
      log.warn(
        `sub-agent completion produced no text content (${result.citations.length} citation(s) seen)`,
        {
          finishReason: result.finishReason,
          usage: result.usage,
          reasoningLength: result.reasoning.length,
          reasoningPreview: result.reasoning.slice(0, 300),
        }
      );
      throw new Error(
        'web_search: sub-agent completion produced no answer text. ' +
          'This usually indicates a transient fast-tier failure, a ' +
          'content-filter rejection, or the search backend returning no ' +
          'usable hits without a no-results note. Retry the call; if it ' +
          'keeps happening, rephrase the query or surface the failure to ' +
          'the user.'
      );
    }

    log.info(`done: ${result.citations.length} source(s)`);

    return { answer: trimmed, citations: result.citations };
  },
};
