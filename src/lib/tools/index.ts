/**
 * Tool registry - the list of every function the LLM can invoke in this
 * app, organised into named toolboxes, plus the helpers that turn those
 * boxes into wire-shaped payloads.
 *
 * Responsibility split:
 *   - Each tool file (./toggle_tools.ts, ./memory_*.ts, ./conversation_*.ts,
 *     ...) exports a single ToolDef describing what it does and how to
 *     run it.
 *   - This file composes them into named toolboxes (cooking, memories,
 *     conversations, always_on), resolves names to defs, and projects
 *     them into the OpenAI / Venice request shape.
 *   - The main-chat system prompt is assembled in `../chat-prompt.ts`,
 *     which imports the registry from here to render the dynamic tool
 *     catalog. Prose blocks and the catalog renderer live there, not
 *     here.
 *   - The orchestration loop in `../chat-loop.ts` is the only caller
 *     that invokes executeToolCall() - no other module should reach
 *     directly into a tool's execute() handler.
 *
 * Toolbox model: the always_on toolbox rides with every request
 * (reflex-level reads: recall pair, web search, the update_title
 * convenience, and the toggle_toolbox meta-tool itself). Other
 * toolboxes are gated - included only when their name is listed in
 * the thread's `toolboxes_enabled` array. The LLM flips gating via
 * the `toggle_toolbox` meta-tool; the user flips gating via the
 * composer toolbox popover. Both paths write through to the same
 * column.
 *
 * Note on the agent-only `memoryToolbox` re-exported near the bottom
 * of this file: its definition lives in `./memory_toolbox` (kept out
 * of this barrel for reflection-worker bundling reasons - see that
 * file's header) but the export rides through here so callers can
 * still pull it from `$lib/tools`. It is a DIFFERENT set of tools
 * (`memory_invalidate` in place of `memory_delete`) than the user-
 * facing `memoriesToolbox` defined in this file. Agents must not
 * hard-delete on their own authority - they can only soft-decay
 * confidence. The user-facing surface keeps hard-delete because
 * "forget X" is user-directed and unambiguous. Don't collapse the
 * two.
 */
import type { ToolDef, OpenAIToolDef, ToolContext, ToolResult, Toolbox } from './types';
import { toggleToolbox } from './toggle_tools';
import { memorySearch } from './memory_search';
import { memoryCreate } from './memory_create';
import { memoryUpdate } from './memory_update';
import { memoryDelete } from './memory_delete';
import { memoryReaffirm } from './memory_reaffirm';
import { memoryDoubt } from './memory_doubt';
import { memoryRelate } from './memory_relate';
import { memoryUnrelate } from './memory_unrelate';
import { memoryRecall } from './memory_recall';
import { conversationSearch } from './conversation_search';
import { conversationRecall } from './conversation_recall';
import { webSearch } from './web_search';
import { recallToolbox } from './recall_toolbox';
import { conversationRecallToolbox } from './conversation_recall_toolbox';
import { recipeSave } from './recipe_save';
import { recipeList } from './recipe_list';
import { recipeGet } from './recipe_get';
import { recipeUpdate } from './recipe_update';
import { recipeDelete } from './recipe_delete';
import { recipePhotosAttach } from './recipe_photos_attach';
import { recipePhotosRemove } from './recipe_photos_remove';
import { recipePhotosReorder } from './recipe_photos_reorder';
import { recipePhotoLabelSet } from './recipe_photo_label_set';
import { updateTitle } from './update_title';
import { analyzeImage } from './analyze_image';
import { researchDocs } from './research_docs';
import { memoryToolbox } from './memory_toolbox';
import { journalList } from './journal_list';
import { journalRead } from './journal_read';
import { journalSearch } from './journal_search';
import { journalDelete } from './journal_delete';

/**
 * Always-on toolbox. Rides with every request regardless of the
 * thread's `toolboxes_enabled` array.
 *
 * Rationale for each inclusion:
 *
 *   - `toggle_toolbox` - the gating mechanism itself. Without it in
 *     the always-on set, the model can't enable gated toolboxes.
 *   - `memory_recall`, `conversation_recall` - the LLM-callable
 *     escape hatches for explicit user lookups ("what was that
 *     thread about X?") and for cases where the chat-loop's
 *     automatic context-recall priming has gone stale. The system
 *     prompt frames them as escape hatches rather than per-turn
 *     reflexes, so a prefatory toggle round-trip would add latency
 *     to a path that needs to fire on user demand. Both are read-
 *     only (they spawn a sub-agent and return a structured note).
 *   - `web_search` - a search for "today's weather" or "latest
 *     release of X" is a reflex-level capability that must fire
 *     without first enabling a toolbox. Read-only (no DB writes;
 *     runs a sub-completion with Venice's server-side search on).
 *     The main chat loop never sets `enable_web_search` itself, so
 *     this tool is the only path search results reach the model.
 *   - `update_title` - has to fire on the very first turn of a
 *     fresh thread, when no gated toolbox is on yet. Gating it
 *     would mean a toggle round-trip before the model could set
 *     the initial title, which defeats the "single-call adaptive
 *     title" design.
 *   - `analyze_image` - a fast vision sub-completion the model
 *     reaches for when an attached image needs to be inspected
 *     before answering. Always-on for the same reason as recall:
 *     the user expects the model to look at the image they just
 *     sent without an intervening toolbox flip.
 *
 * Note on what's NOT here: `research_docs` is a research capability
 * (read-only bundled docs) that would pass the always-on criteria on
 * read-safety grounds, but meta-questions about the app are rare
 * relative to actual work turns - gating it keeps the default request
 * payload smaller. See `researchToolbox` below.
 */
export const alwaysOnToolbox: Toolbox = {
  name: 'always_on',
  description:
    'Reflex-level tools that ride every request without being toggled. ' +
    'Includes recall (memory + prior conversations), live web search, ' +
    'the title-rename convenience, and the toggle_toolbox meta-tool ' +
    'itself.',
  tools: [
    toggleToolbox,
    memoryRecall,
    conversationRecall,
    webSearch,
    updateTitle,
    analyzeImage,
  ],
};

/** Save-and-read recipes against the cookbook CRUD. */
export const cookingToolbox: Toolbox = {
  name: 'cooking',
  description:
    'Save, read, update, and delete recipes in the cookbook, plus ' +
    'attach photos from the current conversation to a recipe, ' +
    'remove or reorder them, and set or clear photo captions.',
  tools: [
    recipeList,
    recipeGet,
    recipeSave,
    recipeUpdate,
    recipeDelete,
    recipePhotosAttach,
    recipePhotosRemove,
    recipePhotosReorder,
    recipePhotoLabelSet,
  ],
};

/**
 * User-facing memory CRUD plus the volitional-memory lever:
 * reaffirm/doubt tools for graded confidence adjustment, and
 * relate/unrelate for the memory-graph layer. The confidence pair sits
 * alongside memory_invalidate in the reflection toolbox below; here in
 * the chat toolbox they're the primary levers, and memory_delete stays
 * as the user-authorised hard-delete (not present in the reflection
 * toolbox).
 *
 * Contrast with the agent-only `memoryToolbox` (defined in
 * `./memory_toolbox`, re-exported near the bottom of this file),
 * which swaps `memory_delete` for `memory_invalidate` because agents
 * operating on their own authority only get soft-decay, not hard
 * delete.
 */
export const memoriesToolbox: Toolbox = {
  name: 'memories',
  description:
    "Search, create, update, delete, reaffirm, doubt, and link the " +
    "signed-in user's long-term memories.",
  tools: [
    memorySearch,
    memoryCreate,
    memoryUpdate,
    memoryDelete,
    memoryReaffirm,
    memoryDoubt,
    memoryRelate,
    memoryUnrelate,
  ],
};

/** Search prior conversations by title + summary embedding. */
export const conversationsToolbox: Toolbox = {
  name: 'conversations',
  description: 'Search the titles and summaries of prior conversations.',
  tools: [conversationSearch],
};

/**
 * Journal (daily diary). Read-focused tools for the main chat -
 * the write path is the background journaling agent's, not this
 * toolbox's. `journal_delete` is here because removing an entry is
 * user-directed (and invokes the per-thread exclude side-effect);
 * creating an automatic entry is not the model's call.
 *
 * Gated rather than always-on because most conversations don't
 * involve the journal - including the schemas on every turn would
 * grow the request payload without paying rent. The LLM can flip it
 * on via toggle_toolbox once a reflective topic opens up.
 */
export const journalToolbox: Toolbox = {
  name: 'journal',
  description:
    "Read and search the user's daily journal entries, " +
    'and delete entries they no longer want. Entries come from two ' +
    "sources per day: 'automatic' (written by the background " +
    "journaling agent from the user's conversations) and 'user' " +
    '(first-person entries the user composed themselves). Writing ' +
    'automatic entries is handled by the background worker, not this ' +
    'toolbox.',
  tools: [journalList, journalRead, journalSearch, journalDelete],
};

/**
 * Research capabilities that aren't a fit for always-on. Today this is
 * just `research_docs` - a sub-agent that answers questions about Nak
 * itself by reading the bundled in-app help corpus, and (when the
 * caller passes `include_internal_dev_docs: true`) the developer docs
 * under `docs/dev/` so the same tool can field "how would I add
 * feature X?" architecture questions. The tool is read-only (no DB
 * writes, no network fetch), so it could technically sit in
 * `alwaysOnToolbox`, but meta-questions about the app are a tiny
 * fraction of conversation turns. Gating it keeps the default request
 * payload smaller; the LLM can flip this toolbox on via
 * `toggle_toolbox` the moment a user turn looks like a meta-question
 * and keep it on for the rest of that thread.
 *
 * Future research-adjacent tools (e.g. reading a saved document the
 * user uploaded, pulling a snippet from a knowledge base) would land
 * here rather than each getting their own single-tool toolbox.
 */
export const researchToolbox: Toolbox = {
  name: 'research',
  description:
    'Research capabilities for answering meta-questions about Nak - ' +
    'how features work, what a setting does, how the app is built ' +
    'internally - or other research-adjacent lookups. Enable when ' +
    'the user asks how to do something in Nak, what a UI element ' +
    'means, or wants to plan a change to Nak itself.',
  tools: [researchDocs],
};

/**
 * The canonical ordered list of toolboxes exposed to the main chat.
 * Order is visible to the model (system-prompt catalog) and to the
 * user (popover list). Always-on goes first so the model reads the
 * reflex-level surfaces before the gated catalog.
 */
export const TOOLBOXES: readonly Toolbox[] = [
  alwaysOnToolbox,
  cookingToolbox,
  memoriesToolbox,
  conversationsToolbox,
  journalToolbox,
  researchToolbox,
];

/**
 * Gated toolboxes - the set a thread can enable or disable. Derived by
 * subtracting `alwaysOnToolbox` from `TOOLBOXES` so adding a new
 * toolbox automatically extends the gated list (unless it's added to
 * the always-on set, in which case it must be declared there).
 */
const GATED_TOOLBOXES: readonly Toolbox[] = TOOLBOXES.filter(
  (tb) => tb.name !== alwaysOnToolbox.name
);

/**
 * Toolbox names that the UI + schema recognise as valid values in the
 * thread's `toolboxes_enabled` array. Exported for the UI popover and
 * for the toggle meta-tool to validate incoming names against.
 */
export const GATED_TOOLBOX_NAMES: readonly string[] = GATED_TOOLBOXES.map(
  (tb) => tb.name
);

/**
 * Metadata for the UI popover - just what the renderer needs to draw
 * the checkbox list. Kept as a plain projection so Chat.svelte
 * doesn't pull in tool definitions, tool code, or the full Toolbox
 * type just to render a list.
 */
export interface ToolboxMeta {
  readonly name: string;
  readonly description: string;
}

export const GATED_TOOLBOX_META: readonly ToolboxMeta[] = GATED_TOOLBOXES.map(
  (tb) => ({ name: tb.name, description: tb.description })
);

/**
 * Flat, deduped view of every tool reachable from the main chat
 * model - i.e. every tool across `TOOLBOXES`. Does NOT include
 * agent-only toolboxes (`memoryToolbox`, `recallToolbox`,
 * `conversationRecallToolbox`) - those are addressed by toolbox
 * directly. Exposed for test assertions and any future UI that
 * wants to inventory the full catalog; the wire builder
 * (`buildToolList`) still composes from `TOOLBOXES` so a tool's
 * toolbox membership drives enablement.
 */
export const TOOLS: readonly ToolDef[] = (() => {
  const seen = new Set<string>();
  const out: ToolDef[] = [];
  for (const tb of TOOLBOXES) {
    for (const tool of tb.tools) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      out.push(tool);
    }
  }
  return out;
})();

function byName(name: string): ToolDef | undefined {
  for (const tb of TOOLBOXES) {
    const hit = tb.tools.find((t) => t.name === name);
    if (hit) return hit;
  }
  return undefined;
}

// `toOpenAIToolDef`, `buildToolboxWireList`, and `executeToolboxCall`
// live in `./dispatch` so the reflection agent worker can reach them
// without walking the rest of this barrel (which statically imports
// `research_docs` + lazy docs-glob, incompatible with the worker's
// IIFE format). Re-exported below for callers that still import from
// `$lib/tools`.
import {
  toOpenAIToolDef,
  buildToolboxWireList,
  executeToolboxCall,
} from './dispatch';

/**
 * The tools array we send with a request, built from the thread's
 * currently-enabled toolbox names. The always-on toolbox is always
 * included. Unknown names in the input are ignored (a toolbox that
 * was deleted or renamed should not break mid-flight). Duplicate
 * tool names across toolboxes are deduped on first-seen.
 */
export function buildToolList(enabledToolboxes: readonly string[]): OpenAIToolDef[] {
  const enabled = new Set(enabledToolboxes);
  const seen = new Set<string>();
  const out: OpenAIToolDef[] = [];
  for (const tb of TOOLBOXES) {
    if (tb.name !== alwaysOnToolbox.name && !enabled.has(tb.name)) continue;
    for (const tool of tb.tools) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      out.push(toOpenAIToolDef(tool));
    }
  }
  return out;
}

/**
 * Dispatch a single tool call by name. Unknown tools throw so the caller
 * can surface a clear error back to the model as a tool-result message.
 */
export async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const tool = byName(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.execute(args, ctx);
}

// Re-export the agent-only toolboxes whose definitions live in their
// own leaf files (`./memory_toolbox`, `./recall_toolbox`,
// `./conversation_recall_toolbox`). `memoryToolbox` moved out of this
// barrel because the reflection worker imports it - see its file
// header for the IIFE/code-splitting failure mode that keeps it out
// of `./index.ts`. The recall toolboxes live in their own files to
// avoid a circular import - see those files' headers for why.
export { memoryToolbox, recallToolbox, conversationRecallToolbox };

export { toOpenAIToolDef, buildToolboxWireList, executeToolboxCall };
export { toggleToolbox, updateTitle };
export type { ToolDef, OpenAIToolDef, ToolContext, ToolResult, Toolbox } from './types';
export type { OpenAIToolCall } from './types';
