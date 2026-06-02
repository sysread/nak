/**
 * Recipe-topics agent. One tagging pass per invocation: the worker
 * has already claimed a recipe row and fetched its title + cooklang +
 * existing vocabulary in a single RPC, so the agent's job is just to
 * build the prompt, call the fast model with a JSON-pinned
 * response_format, and parse + validate the output.
 *
 * Shape mirrors `../memory_topics/agent.ts` deliberately - same
 * Agent<I,O> scaffold, same normaliser rules, same JSON-fence-strip
 * helper. The differences are the input shape (title + cooklang
 * instead of label + data), the prompt (see `./prompt.ts`), and the
 * cap (6 instead of 4 - recipes span more dimensions, see the prompt
 * comment for the reasoning).
 */
import type { Agent, AgentRunRequest, AgentRunResult } from '../types';
import type { SupabaseService } from '../../supabase';
import type { VeniceMessage } from '../../venice';
import type { Toolbox } from '../../tools/types';
import { agentModel } from '../../models';
import { buildRecipeTopicsPrompt } from './prompt';
import { UNTAGGED_TOPIC_SENTINEL } from '../../supabase';

/**
 * Empty toolbox - the recipe-topics agent produces a pure JSON
 * object. Same posture as `../memory_topics/agent.ts`.
 */
const emptyToolbox: Toolbox = {
  name: 'recipe-topics',
  description:
    'No tools - the recipe-topics agent produces a JSON object only.',
  tools: [],
};

/**
 * Tag cap. Higher than threads (4) and memories (4) because recipes
 * legitimately span four dimensions (primary ingredients + cuisine +
 * course + technique); see `./prompt.ts` for the design discussion
 * that landed on 6. Six gives all four dimensions room plus a
 * second headline ingredient on multi-protein dishes.
 */
const MAX_RECIPE_TOPICS = 6;

export interface RecipeTopicsInput {
  /** Recipe row claimed by the worker before this runs. */
  recipeId: string;
  /** Recipe title - rendered verbatim into the prompt's TITLE field. */
  title: string;
  /** Cooklang source body - rendered verbatim into the prompt's COOKLANG block. */
  cooklang: string;
  /**
   * Existing recipe-topic vocabulary for the user, fetched in the
   * same round trip as the claim. Passed to the model as a "reuse
   * these if any apply" list so the vocabulary doesn't sprawl into
   * near-duplicates. Empty array means "brand new account or no
   * tags yet" - the model picks freely.
   */
  existingTopics: readonly string[];
}

export interface RecipeTopicsOutput {
  /**
   * Normalised topic tags, validated + capped at MAX_RECIPE_TOPICS.
   * Empty array when the model produced unparseable output, no
   * valid items, or only the reserved sentinel - the loop treats
   * an empty result as a non-result and retries on the next cycle.
   */
  topics: string[];
}

/**
 * Strip a leading/trailing ```json fence if the model added one
 * despite the prompt's "no markdown fence" instruction. Duplicated
 * from the sibling topics agents rather than extracted - see those
 * files for the rationale (CLAUDE.md on premature abstraction).
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
 * Per-tag validation + normalisation. Identical rules to the sibling
 * topics agents: lowercase, strip non-alphanum-or-hyphen, length
 * 1..40, can't equal the "(untagged)" sentinel.
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
 * Parse the model's raw output into a validated topic list. Caps at
 * MAX_RECIPE_TOPICS items. Returns [] on any parse failure or all-
 * invalid items - the loop's "empty-topics" branch then releases the
 * claim without writing.
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
    if (out.length >= MAX_RECIPE_TOPICS) break;
  }
  return out;
}

export class RecipeTopicsAgent
  implements Agent<RecipeTopicsInput, RecipeTopicsOutput>
{
  readonly name = 'recipe-topics';
  readonly model: string;
  readonly toolbox: Toolbox = emptyToolbox;

  constructor(
    private supabase: SupabaseService,
    /**
     * Optional model override - defaults to the registry's
     * `recipeTopics` slot. Useful for tests; a future A/B can pin a
     * concrete id without a call-site change.
     */
    modelId?: string
  ) {
    this.model = modelId ?? agentModel('recipeTopics').id;
  }

  async run(
    req: AgentRunRequest<RecipeTopicsInput>
  ): Promise<AgentRunResult<RecipeTopicsOutput>> {
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
        content: buildRecipeTopicsPrompt(
          req.input.title,
          req.input.cooklang,
          req.input.existingTopics
        ),
      };

      // 384 tokens covers the worst case: six 40-char tags. The
      // bound matters because the model is told to emit JSON only;
      // a runaway prose preamble would otherwise eat the budget
      // before the actual array lands. The cap is generous - typical
      // output is well under 100 tokens.
      const result = await this.supabase.complete({
        model: this.model,
        messages: [userMessage],
        maxTokens: 384,
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
 * Test hook: expose the internal validator + cap so unit tests can
 * drive the parser without spinning up a SupabaseService stub. Same
 * `__test` convention as the sibling agents.
 */
export const __test = { parseTopics, normaliseTag, MAX_RECIPE_TOPICS };
