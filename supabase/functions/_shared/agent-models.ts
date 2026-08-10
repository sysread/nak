/**
 * Agent model ID constants for the edge function side.
 *
 * The browser's AGENT_MODELS in src/lib/models/index.ts is the
 * canonical source for the roles it knows about (reflection, wiki,
 * wikiRecords, etc.). But the edge has additional agents (bias,
 * summary, topics, intent, samskara, secondThoughts, etc.) that
 * were added without extending the browser's AgentRole type.
 *
 * This module consolidates ALL edge agent model IDs in one place
 * so a model swap only edits the base constants below instead of
 * 22 files. The browser keeps its own AGENT_MODELS for the roles
 * it tracks; agents that exist only on the edge live here.
 *
 * When changing a base model here, also check src/lib/models/index.ts
 * AGENT_MODELS - if the role exists there, update both.
 */

// --- Base models -----------------------------------------------------------
// Two models cover every background agent. Swapping a base constant
// here retargets every agent that uses it.

// deepseek-v4-flash: 1M context window, good reasoning. Used by
// agents that read entire threads or articles (reflection, wiki,
// recall) and agents that need more careful judgment (samskara
// evaluation, digest).
export const BIG_WINDOW_MODEL = 'deepseek-v4-flash';

// mistral-small-3-2-24b-instruct: fast, cheap, good enough for
// classification and extraction tasks that don't need a huge
// context window or deep reasoning (tagging, summarization, intent
// detection, bias analysis, auto-title).
export const EASY_TASK_MODEL = 'mistral-small-3-2-24b-instruct';

// --- Per-agent assignments -------------------------------------------------
// Roles mirrored from AGENT_MODELS in src/lib/models/index.ts
export const REFLECTION_MODEL = BIG_WINDOW_MODEL;
export const WIKI_MODEL = BIG_WINDOW_MODEL;
export const WIKI_RECORDS_MODEL = BIG_WINDOW_MODEL;
export const WIKI_LIBRARIAN_MODEL = BIG_WINDOW_MODEL;
export const WIKI_MANUAL_MODEL = BIG_WINDOW_MODEL;
export const WIKI_RECALL_MODEL = BIG_WINDOW_MODEL;
export const DEEP_SLEEP_MODEL = BIG_WINDOW_MODEL;
export const REM_MODEL = BIG_WINDOW_MODEL;
export const RECALL_MODEL = BIG_WINDOW_MODEL;
export const CONVERSATION_RECALL_MODEL = BIG_WINDOW_MODEL;

// Edge-only agents (no AGENT_MODELS entry in the browser)
export const BIAS_MODEL = EASY_TASK_MODEL;
export const SUMMARY_MODEL = EASY_TASK_MODEL;
export const TOPICS_MODEL = EASY_TASK_MODEL;
export const RECIPE_TOPICS_MODEL = EASY_TASK_MODEL;
export const MEMORY_TOPICS_MODEL = EASY_TASK_MODEL;
export const INTENT_MODEL = EASY_TASK_MODEL;
export const INTENT_EMPLOYMENT_MODEL = EASY_TASK_MODEL;
export const SAMSKARA_MODEL = EASY_TASK_MODEL;
export const EVALUATION_MODEL = BIG_WINDOW_MODEL;
export const SECOND_THOUGHTS_MODEL = EASY_TASK_MODEL;
export const AUTO_TITLE_MODEL = EASY_TASK_MODEL;
export const DIGEST_MODEL = BIG_WINDOW_MODEL;

// Fallback model for the wiki agent's content-filter retry path.
// Uncensored model used when the primary model refuses on a
// content-classifier false positive.
export const CONTENT_FILTER_FALLBACK_MODEL = 'venice-uncensored-1-2';
