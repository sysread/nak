// In-process non-streaming Venice chat completion helper for tools.
//
// Mirrors what src/lib/supabase.ts SupabaseService.complete does on
// the browser side - build the body, call Venice, parse the response
// into a {text, reasoning, citations, usage, finishReason} bundle.
// Skips the rate-limit retry loop because the streaming function's
// outer round timing already bounds individual tool calls and a
// tool-level 429 surfaces cleanly to the model as a tool error
// (which the round loop already handles).
//
// Why we don't call /complete via HTTP: the function already has the
// Venice key (readVeniceKey) and veniceComplete; an HTTP hop to a
// sibling function would mean extra latency, an extra JWT decode,
// and one more failure mode. Direct in-process call is the right
// shape.

import { veniceComplete } from '../../_shared/venice.ts';

export interface ToolCompletionResult {
  text: string;
  reasoning: string;
  citations: ToolCitation[];
  finishReason: string | null;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

export interface ToolCitation {
  title: string;
  url: string;
  content: string | null;
  date: string | null;
  index: number;
}

export interface ToolCompletionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | unknown;
  name?: string;
  tool_call_id?: string;
}

export interface ToolCompletionOptions {
  apiKey: string;
  model: string;
  messages: readonly ToolCompletionMessage[];
  /** Web-search switch; 'on' enables Venice's server-side search. */
  webSearch?: 'on' | 'off';
  webCitations?: boolean;
  webScraping?: boolean;
  /** Disable the model's chain-of-thought pass entirely. */
  disableThinking?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export async function toolComplete(opts: ToolCompletionOptions): Promise<ToolCompletionResult> {
  const venice_parameters: Record<string, unknown> = {};
  if (opts.webSearch !== undefined) {
    venice_parameters.enable_web_search = opts.webSearch;
  }
  if (opts.webCitations !== undefined) {
    venice_parameters.enable_web_citations = opts.webCitations;
  }
  if (opts.webScraping !== undefined) {
    venice_parameters.web_scraping = opts.webScraping;
  }
  if (opts.disableThinking === true) {
    venice_parameters.disable_thinking = true;
  }

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
  };
  if (Object.keys(venice_parameters).length > 0) {
    body.venice_parameters = venice_parameters;
  }
  if (opts.maxTokens !== undefined) {
    body.max_completion_tokens = opts.maxTokens;
  }
  if (opts.temperature !== undefined) {
    body.temperature = opts.temperature;
  }

  const raw = await veniceComplete({ apiKey: opts.apiKey, body });
  return parseCompletion(raw);
}

function parseCompletion(payload: unknown): ToolCompletionResult {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Venice completion response was not an object.');
  }
  const obj = payload as Record<string, unknown>;
  const choices = Array.isArray(obj.choices) ? (obj.choices as Array<Record<string, unknown>>) : [];
  const choice = choices[0] ?? {};
  const message = (choice.message as Record<string, unknown> | undefined) ?? {};
  const text = typeof message.content === 'string' ? message.content : '';
  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  const finishReason = typeof choice.finish_reason === 'string'
    ? (choice.finish_reason as string)
    : null;

  let usage: ToolCompletionResult['usage'] = null;
  const rawUsage = obj.usage as Record<string, unknown> | undefined;
  if (
    rawUsage &&
    typeof rawUsage.prompt_tokens === 'number' &&
    typeof rawUsage.completion_tokens === 'number' &&
    typeof rawUsage.total_tokens === 'number'
  ) {
    usage = {
      prompt_tokens: rawUsage.prompt_tokens,
      completion_tokens: rawUsage.completion_tokens,
      total_tokens: rawUsage.total_tokens,
    };
  }

  const citations: ToolCitation[] = [];
  const veniceParams = obj.venice_parameters as Record<string, unknown> | undefined;
  const rawCitations = veniceParams?.web_search_citations;
  if (Array.isArray(rawCitations)) {
    rawCitations.forEach((c, i) => {
      if (typeof c !== 'object' || c === null) return;
      const rec = c as Record<string, unknown>;
      const title = typeof rec.title === 'string' ? rec.title : '';
      const url = typeof rec.url === 'string' ? rec.url : '';
      if (!title || !url) return;
      citations.push({
        title,
        url,
        content: typeof rec.content === 'string' ? rec.content : null,
        date: typeof rec.date === 'string' ? rec.date : null,
        index: i + 1,
      });
    });
  }

  return { text, reasoning, citations, finishReason, usage };
}
