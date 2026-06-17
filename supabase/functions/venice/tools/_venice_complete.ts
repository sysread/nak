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
  /**
   * Tool-calls the model emitted on this turn. Empty for completions
   * that didn't request a tools array (the default sub-completion
   * shape - research_docs, analyze_image, etc.). Populated when the
   * caller is driving an agent (runHeadlessAgent in
   * supabase/functions/venice/agents/_run.ts), which feeds them back
   * through the agent's toolbox dispatcher.
   */
  toolCalls: ToolCompletionCall[];
}

export interface ToolCompletionCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
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
  /**
   * OpenAI-format tools the model can call this turn. Forwarded as
   * the request body's `tools` field; the parsed response surfaces
   * any tool_calls the model emitted on `toolCalls`. Omitted by
   * default since most sub-completions don't dispatch tools.
   */
  tools?: readonly Record<string, unknown>[];
  /**
   * Optional reasoning_effort knob. Forwarded verbatim to Venice on
   * reasoning-capable models; non-reasoning tiers silently ignore.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /**
   * Opt-in to retrying a 429 (rate_limit) with backoff. Off by default
   * so mid-turn tool calls keep surfacing a 429 to the model promptly
   * (the round loop bounds them); the background curation agents that
   * borrow this helper set it so a transient "model overloaded" doesn't
   * fail the whole sub-call. Forwarded to veniceComplete.
   */
  retryRateLimit?: boolean;
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
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
  }
  if (opts.reasoningEffort !== undefined) {
    body.reasoning_effort = opts.reasoningEffort;
  }

  const raw = await veniceComplete({
    apiKey: opts.apiKey,
    body,
    retryRateLimit: opts.retryRateLimit,
  });
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

  // Parse any tool_calls the model emitted. OpenAI shape is
  // [{id, type:'function', function:{name, arguments}}]; we drop
  // entries missing id or function.name (no callable identity) and
  // coerce missing arguments to "{}" so the downstream agent driver
  // can parseToolArguments(...) without a separate null check.
  const toolCalls: ToolCompletionCall[] = [];
  const rawCalls = message.tool_calls;
  if (Array.isArray(rawCalls)) {
    for (const c of rawCalls as Array<Record<string, unknown>>) {
      if (typeof c?.id !== 'string') continue;
      const fn = c.function as Record<string, unknown> | undefined;
      if (typeof fn?.name !== 'string') continue;
      toolCalls.push({
        id: c.id,
        type: 'function',
        function: {
          name: fn.name,
          arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}',
        },
      });
    }
  }

  return { text, reasoning, citations, finishReason, usage, toolCalls };
}
