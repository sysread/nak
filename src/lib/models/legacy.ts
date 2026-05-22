/**
 * Retired Venice model ids. An entry lives here once nothing in the
 * active registry (MODELS in ./index.ts, AGENT_MODELS, the user-facing
 * TIERS) points at it anymore. We keep them around only because
 * assistant-message rows in user databases store the concrete id they
 * were answered by, and the per-message context-ring indicator in
 * AssistantBody.svelte needs to look up the window for any historical
 * id to compute its percentage.
 *
 * Shape is intentionally narrow: just `id` and `contextWindow`. No code
 * reads anything else on a retired entry, and capability flags would
 * silently rot here without exercise. If you re-pin a retired id, move
 * its row into the active MODELS map in ./index.ts and re-verify its
 * capability flags against Venice's /models response - the values that
 * applied at retirement are not preserved.
 *
 * Don't delete rows even once a swap feels old. Removing one hides the
 * ring on every historical message answered by that id, with no
 * recovery path short of re-adding the entry.
 */

export interface LegacyModelSpec {
  readonly id: string;
  readonly contextWindow: number;
}

/**
 * Every Venice id Nak has ever pinned that is no longer active. Grouped
 * by the role the id used to fill - the comment block above each group
 * is the only documentation those ids get. If an id pulled multiple
 * shifts, the comment captures the longest-lived role.
 */
export const LEGACY_MODELS: Readonly<Record<string, LegacyModelSpec>> = {
  // Retired Smart-tier ids.
  'kimi-k2-5':                         { id: 'kimi-k2-5', contextWindow: 256_000 },
  'kimi-k2-6':                         { id: 'kimi-k2-6', contextWindow: 256_000 },
  'zai-org-glm-5-1':                   { id: 'zai-org-glm-5-1', contextWindow: 200_000 },

  // Briefly fronted all three tiers between the GLM swap and the swap
  // back to deepseek-v4-flash. Kept for the short window during which
  // any user-facing assistant row could have stamped this id.
  'deepseek-v4-pro':                   { id: 'deepseek-v4-pro', contextWindow: 1_000_000 },

  // Retired Balanced-tier ids.
  'arcee-trinity-large-thinking':      { id: 'arcee-trinity-large-thinking', contextWindow: 256_000 },
  'gemma-4-uncensored':                { id: 'gemma-4-uncensored', contextWindow: 256_000 },
  'minimax-m27':                       { id: 'minimax-m27', contextWindow: 198_000 },
  'zai-org-glm-5':                     { id: 'zai-org-glm-5', contextWindow: 198_000 },

  // Retired Fast-tier ids.
  'grok-41-fast':                      { id: 'grok-41-fast', contextWindow: 1_000_000 },
  'zai-org-glm-4.7':                   { id: 'zai-org-glm-4.7', contextWindow: 198_000 },

  // Retired background-agent ids from the now-deleted journal feature.
  // Never fronted a user-facing tier, but kept here for completeness
  // and so a future re-pin has the row already wired into the legacy
  // registry.
  'minimax-m25':                       { id: 'minimax-m25', contextWindow: 198_000 },
  'qwen3-235b-a22b-instruct-2507':     { id: 'qwen3-235b-a22b-instruct-2507', contextWindow: 128_000 },
  'zai-org-glm-4.7-flash':             { id: 'zai-org-glm-4.7-flash', contextWindow: 128_000 },
  'nvidia-nemotron-cascade-2-30b-a3b': { id: 'nvidia-nemotron-cascade-2-30b-a3b', contextWindow: 256_000 },

  // Retired recall-trio id (memory / conversation / wiki recall).
  // MoE / json_object pressure produced grounded-content fabrication
  // (confabulated user facts emitted as kind:'note' without consulting
  // memory_search / wiki_search); the three recall slots were repointed
  // at deepseek-v4-flash to share the dense reasoning capacity used by
  // reflection and the other tool-driven background agents.
  'qwen3-5-35b-a3b':                   { id: 'qwen3-5-35b-a3b', contextWindow: 256_000 },
};
