/**
 * Topic-tagging agent. Runs one tagging pass over a conversation:
 * fetches messages up to the claimed terminal assistant message,
 * appends the topics instruction (with the user's existing topic
 * vocabulary inlined for normalisation), asks the fast model for a
 * JSON object listing 1-4 topic tags, and parses + validates the
 * output before handing it back to the worker for the save RPC.
 *
 * Shape mirrors `../summary/agent.ts` deliberately. The loop-harness
 * + worker-entry pattern expects an `Agent<Input, Output>` it can
 * `run()` against, and reusing the same scaffold means anyone reading
 * the summary code has this one's vocabulary for free. The
 * normalisation post-step (lowercase, strip non-alphanum-or-hyphen,
 * dedupe, cap at 4) is local because no other agent shares its
 * validation rules.
 */
import type { Agent, AgentRunRequest, AgentRunResult } from '../types';
import type { SupabaseService, Message } from '../../supabase';
import type { VeniceMessage } from '../../venice';
import type { Toolbox } from '../../tools/types';
import { sanitizeToolCallIdForWire, sanitizeToolCallsForWire } from '../../tools/wire';
import {
  trimToCompleteTurn,
  trimToFirstUserOrSystem,
} from '../../conversation-recovery';
import { agentModel } from '../../models';
import { buildTopicsPrompt } from './prompt';
import { UNTAGGED_TOPIC_SENTINEL } from '../../supabase';

/**
 * Empty toolbox - the topics agent produces pure JSON. Same posture as
 * the summary agent: we satisfy the Agent interface with an empty
 * toolbox rather than narrowing the base type, because every other
 * agent does use tools and a special case for the textual ones would
 * push the empty case elsewhere.
 */
const emptyToolbox: Toolbox = {
  name: 'topics',
  description: 'No tools - the topics agent produces a JSON object only.',
  tools: [],
};

export interface TopicsInput {
  /** Thread to tag - claimed by the worker before this runs. */
  threadId: string;
  /**
   * Terminal assistant message the claim was made against. Slicing
   * the history at this id means a race where the user added turns
   * mid-tagging simply queues the thread for the next cycle.
   */
  terminalMsgId: string;
  /**
   * Existing topic vocabulary for the user, fetched in the same
   * round trip as the claim. Passed to the model as a "reuse these
   * if any apply" list so the vocabulary doesn't sprawl into near-
   * duplicates over time. Empty array means "brand new account or
   * no tags yet" - the model picks freely.
   */
  existingTopics: readonly string[];
}

export interface TopicsOutput {
  /**
   * Normalised topic tags, validated + capped at 4. Empty array when
   * the model produced unparseable output, no valid items, or only
   * the reserved sentinel - the loop treats an empty result as a
   * non-result and retries on the next cycle rather than saving
   * "untagged" garbage that would mask the row's eligibility.
   */
  topics: string[];
  /** Message count fed to the model on the call. Observability breadcrumb. */
  inputMessageCount: number;
}

/**
 * Project a stored Message row onto the Venice wire format. Same
 * helper the summary agent uses; copied rather than shared because
 * the projection is tiny and three subsystems sharing a util module
 * is more coupling than the duplication costs.
 */
function messageToVenice(m: Message): VeniceMessage {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      content: m.content,
      tool_call_id:
        m.tool_call_id != null
          ? sanitizeToolCallIdForWire(m.tool_call_id)
          : undefined,
      name: m.name ?? undefined,
    };
  }
  const out: VeniceMessage = { role: m.role, content: m.content };
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
    out.tool_calls = sanitizeToolCallsForWire(m.tool_calls);
  }
  return out;
}

/**
 * Cap the conversation feed at first 40 + last 80 messages. Same
 * shape as summary - outcomes carry more topic weight than origins
 * but origin tells you what the thread was launched into, so we want
 * both ends. trim* helpers prevent a tool/user seam from corrupting
 * the wire framing.
 */
const MAX_INPUT_MESSAGES = 120;

function condenseHistory(all: Message[]): Message[] {
  if (all.length <= MAX_INPUT_MESSAGES) return all;
  const head = trimToCompleteTurn(all.slice(0, 40));
  const tail = trimToFirstUserOrSystem(all.slice(-80));
  return [...head, ...tail];
}

/**
 * Strip a leading/trailing ```json fence if the model added one
 * despite the prompt's "no markdown fence" instruction. Same helper
 * other JSON-out agents use; some fast models still wrap structured
 * JSON when their default behaviour leaks through.
 */
function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    const withoutFence = trimmed
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '');
    return withoutFence.trim();
  }
  return trimmed;
}

/**
 * Per-tag validation + normalisation. Returns null when the tag fails
 * any rule, otherwise the canonical form. Rules track the prompt:
 *
 *   - Must be a non-empty string after lowercasing and trim.
 *   - Strip characters outside [a-z0-9-]. A model that emits
 *     "bread-baking!" becomes "bread-baking"; "Cooking 101" becomes
 *     "cooking-101". A tag that strips down to empty is dropped.
 *   - Length 1..40 chars. The lower bound is "anything substantive";
 *     the upper bound is "a topic, not a sentence" - a 40-char tag
 *     is already way past the prompt's "one or two words" target.
 *   - Cannot equal the "(untagged)" sentinel - that's a UI primitive,
 *     not a topic, and a model that emits it would corrupt the
 *     drawer's filter semantics. Surrounding parens get stripped by
 *     the regex above anyway but the explicit guard makes the
 *     forbidden value impossible to reach via any normalisation
 *     path.
 */
function normaliseTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const lowered = raw.toLowerCase().trim();
  if (lowered.length === 0) return null;
  const cleaned = lowered.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (cleaned.length === 0 || cleaned.length > 40) return null;
  if (cleaned === UNTAGGED_TOPIC_SENTINEL) return null;
  return cleaned;
}

/**
 * Parse the raw model output into a validated topic list. Returns an
 * empty array on any parse failure, missing key, wrong type, or
 * all-invalid items. The empty-array path triggers the loop's
 * "empty-topics" branch which releases the claim without writing -
 * the row re-enters the queue and a future cycle retries.
 */
function parseTopics(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as Record<string, unknown>;
  const list = obj.topics;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const norm = normaliseTag(item);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= 4) break;
  }
  return out;
}

export class TopicsAgent implements Agent<TopicsInput, TopicsOutput> {
  readonly name = 'topics';
  readonly model: string;
  readonly toolbox: Toolbox = emptyToolbox;

  constructor(
    private supabase: SupabaseService,
    /**
     * Optional model override - defaults to the registry's `topics`
     * slot (see AGENT_MODELS in src/lib/models). Same rationale as
     * the summary override: useful for tests, and a future A/B
     * against a different model can pin a concrete id without a
     * call-site change.
     */
    modelId?: string
  ) {
    this.model = modelId ?? agentModel('topics').id;
  }

  async run(
    req: AgentRunRequest<TopicsInput>
  ): Promise<AgentRunResult<TopicsOutput>> {
    const signal = req.signal ?? new AbortController().signal;

    if (signal.aborted) {
      return {
        output: { topics: [], inputMessageCount: 0 },
        toolCalls: 0,
        stoppedReason: 'aborted',
      };
    }

    try {
      const allMessages = await this.supabase.listMessages(req.input.threadId);
      const terminalIdx = allMessages.findIndex(
        (m) => m.id === req.input.terminalMsgId
      );
      const slice =
        terminalIdx >= 0 ? allMessages.slice(0, terminalIdx + 1) : allMessages;

      if (slice.length === 0) {
        return {
          output: { topics: [], inputMessageCount: 0 },
          toolCalls: 0,
          stoppedReason: 'done',
        };
      }

      const condensed = condenseHistory(slice);
      const convo: VeniceMessage[] = condensed.map(messageToVenice);
      convo.push({
        role: 'user',
        content: buildTopicsPrompt(req.input.existingTopics),
      });

      // Bounded JSON output - 512 tokens is a generous cap for an
      // object whose longest plausible body is `{"topics":["a","b",
      // "c","d"]}` with 40-char tags. response_format pins the model
      // to JSON shape so the parser doesn't have to handle freeform
      // prose around the object.
      const result = await this.supabase.complete({
        model: this.model,
        messages: convo,
        maxTokens: 512,
        responseFormat: { type: 'json_object' },
        signal,
      });

      return {
        output: {
          topics: parseTopics(result.text),
          inputMessageCount: condensed.length,
        },
        toolCalls: 0,
        stoppedReason: signal.aborted ? 'aborted' : 'done',
      };
    } catch (err) {
      return {
        output: { topics: [], inputMessageCount: 0 },
        toolCalls: 0,
        stoppedReason: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Test hook: expose the internal validator so unit tests can drive
 * the parser without spinning up a SupabaseService stub. Kept behind a
 * `__test` namespace so production callers can't accidentally lean
 * on it - consistent with the convention in routing.svelte.ts /
 * crypto.ts / session.ts.
 */
export const __test = { parseTopics, normaliseTag };
