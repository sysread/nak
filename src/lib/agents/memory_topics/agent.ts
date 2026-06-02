/**
 * Memory-topics agent. One tagging pass per invocation: the worker has
 * already claimed a memory row and fetched its label + data + the
 * user's existing topic vocabulary in a single RPC, so the agent's job
 * is just to build the prompt, call the fast model with a JSON-pinned
 * response_format, and parse + normalise the model's output.
 *
 * Shape mirrors `../topics/agent.ts` deliberately - same Agent<I,O>
 * scaffold, same normaliser rules, same JSON-fence-strip helper. The
 * differences are the input shape (label+data instead of a
 * conversation transcript) and the prompt (see `./prompt.ts`).
 */
import type { Agent, AgentRunRequest, AgentRunResult } from '../types';
import type { SupabaseService } from '../../supabase';
import type { VeniceMessage } from '../../venice';
import type { Toolbox } from '../../tools/types';
import { agentModel } from '../../models';
import { buildMemoryTopicsPrompt } from './prompt';
import { UNTAGGED_TOPIC_SENTINEL } from '../../supabase';

/**
 * Empty toolbox - the memory-topics agent produces a pure JSON object.
 * Same posture as `../topics/agent.ts`; we satisfy the Agent interface
 * with an empty toolbox rather than narrowing the base type.
 */
const emptyToolbox: Toolbox = {
  name: 'memory-topics',
  description:
    'No tools - the memory-topics agent produces a JSON object only.',
  tools: [],
};

export interface MemoryTopicsInput {
  /** Memory row claimed by the worker before this runs. */
  memoryId: string;
  /** Memory label - rendered verbatim into the prompt's LABEL field. */
  label: string;
  /** Memory data body - rendered verbatim into the prompt's DATA field. */
  data: string;
  /**
   * Existing memory-topic vocabulary for the user, fetched in the same
   * round trip as the claim. Passed to the model as a "reuse these if
   * any apply" list so the vocabulary doesn't sprawl into near-
   * duplicates over time. Empty array means "brand new account or no
   * tags yet" - the model picks freely.
   */
  existingTopics: readonly string[];
}

export interface MemoryTopicsOutput {
  /**
   * Normalised topic tags, validated + capped at 4. Empty array when
   * the model produced unparseable output, no valid items, or only the
   * reserved sentinel - the loop treats an empty result as a non-
   * result and retries on the next cycle rather than saving an
   * untagged-marker.
   */
  topics: string[];
}

/**
 * Strip a leading/trailing ```json fence if the model added one
 * despite the prompt's "no markdown fence" instruction. Same helper
 * the thread topics agent uses - duplicated rather than extracted
 * because the two helpers' callers should not share a util module
 * for two-line functions (see CLAUDE.md on premature abstraction).
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
 * any rule, otherwise the canonical form. Identical rules to
 * `../topics/agent.ts::normaliseTag`: lowercase, strip non-alphanum-
 * or-hyphen, length 1..40, can't equal the "(untagged)" sentinel.
 *
 * Duplicated rather than extracted for the same reason as
 * stripJsonFence above - keeping two small validators next to their
 * respective prompts beats creating a shared util that has to grow
 * for every future caller's edge cases.
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
 * Parse the model's raw output into a validated topic list. Returns
 * an empty array on any parse failure or all-invalid items. The empty
 * path triggers the loop's "empty-topics" branch which releases the
 * claim without writing - the row re-enters the queue and a future
 * cycle retries.
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

export class MemoryTopicsAgent
  implements Agent<MemoryTopicsInput, MemoryTopicsOutput>
{
  readonly name = 'memory-topics';
  readonly model: string;
  readonly toolbox: Toolbox = emptyToolbox;

  constructor(
    private supabase: SupabaseService,
    /**
     * Optional model override - defaults to the registry's
     * `memoryTopics` slot. Useful for tests; a future A/B can pin a
     * concrete id without a call-site change.
     */
    modelId?: string
  ) {
    this.model = modelId ?? agentModel('memoryTopics').id;
  }

  async run(
    req: AgentRunRequest<MemoryTopicsInput>
  ): Promise<AgentRunResult<MemoryTopicsOutput>> {
    const signal = req.signal ?? new AbortController().signal;

    if (signal.aborted) {
      return {
        output: { topics: [] },
        toolCalls: 0,
        stoppedReason: 'aborted',
      };
    }

    try {
      const userMessage: VeniceMessage = {
        role: 'user',
        content: buildMemoryTopicsPrompt(
          req.input.label,
          req.input.data,
          req.input.existingTopics
        ),
      };

      // Bounded JSON output - 256 tokens is plenty for an object
      // shaped `{"topics":["a","b","c","d"]}` with 40-char tags.
      // response_format pins the model to JSON so the parser doesn't
      // have to handle freeform prose around the object.
      const result = await this.supabase.complete({
        model: this.model,
        messages: [userMessage],
        maxTokens: 256,
        responseFormat: { type: 'json_object' },
        signal,
      });

      return {
        output: { topics: parseTopics(result.text) },
        toolCalls: 0,
        stoppedReason: signal.aborted ? 'aborted' : 'done',
      };
    } catch (err) {
      return {
        output: { topics: [] },
        toolCalls: 0,
        stoppedReason: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Test hook: expose the internal validator so unit tests can drive the
 * parser without spinning up a SupabaseService stub. Same `__test`
 * convention as ../topics/agent.ts and the other agents.
 */
export const __test = { parseTopics, normaliseTag };
