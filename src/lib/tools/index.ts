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
 *     journal, always_on), resolves names to defs, and projects
 *     them into the OpenAI / Venice request shape.
 *   - The main-chat system prompt is assembled in `../chat-prompt.ts`,
 *     which imports the registry from here to render the dynamic tool
 *     catalog. Prose blocks and the catalog renderer live there, not
 *     here.
 *   - The orchestration loop in `../chat-loop.ts` is the only caller
 *     that invokes executeToolCall() - no other module should reach
 *     directly into a tool's execute() handler.
 *
 * Toolbox model: the always_on toolbox rides with every request and
 * carries every read-only surface (the recall pair, web search,
 * search/list/read tools across memories / conversations / cookbook /
 * journal / app docs, the update_title convenience, the
 * analyze_image vision sub-call, and the toggle_toolbox meta-tool
 * itself). Gated toolboxes carry only writes (memory_create through
 * memory_unrelate, recipe_save through recipe_photo_label_set,
 * journal_delete) and are included only when their name is listed in
 * the thread's `toolboxes_enabled` array. The LLM flips gating via
 * the `toggle_toolbox` meta-tool; the user flips gating via the
 * composer toolbox popover. Both paths write through to the same
 * column. Rationale: read tools were getting passed over because the
 * model judged a toolbox toggle to be too expensive for a one-off
 * lookup, then answered from training data instead. Reads are
 * idempotent and cheap, so they ride for free; writes still need a
 * deliberate user-or-model gate so an autonomous turn can't scribble
 * over user data without intent.
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

// --- Eagerly-imported always-on tools -------------------------------
// The recall pair, web search, update_title, analyze_image, and the
// toggle meta-tool fire on the first-message critical path
// (memory/conversation_recall on topic boundaries, web_search on
// time-sensitive questions, update_title on the very first turn,
// analyze_image when the user attaches an image). The cold-start
// chunk-fetch tax is not acceptable there, so they stay eager. The
// other always-on tools (search/list/read across memories,
// conversations, recipes, journal, app docs) are still always-on but
// lazy-imported via the lazyTool wrappers below - they fire on
// demand, not on every turn, so the schema rides eagerly while the
// impl module loads on first dispatch.
import { toggleToolbox } from './toggle_tools';
import { memoryRecall } from './memory_recall';
import { conversationRecall } from './conversation_recall';
import { webSearch } from './web_search';
import { updateTitle } from './update_title';
import { analyzeImage } from './analyze_image';

// --- Lazy-loaded tool schemas ---------------------------------------
// The schemas (name + description + shortDescription + parameters)
// stay eager because every chat-loop turn renders the catalog and
// every wire payload sends the tool-list shape. The matching impl
// modules are dynamic-imported on first dispatch via the `lazyTool`
// helper below; Vite emits one chunk per `import('./<tool>')` call.
// Tools split across always-on (read paths) and the gated write
// boxes - the lazy split is orthogonal to gating.
import { memorySearchSchema } from './memory_search.schema';
import { memoryCreateSchema } from './memory_create.schema';
import { memoryUpdateSchema } from './memory_update.schema';
import { memoryDeleteSchema } from './memory_delete.schema';
import { memoryReaffirmSchema } from './memory_reaffirm.schema';
import { memoryDoubtSchema } from './memory_doubt.schema';
import { memoryRelateSchema } from './memory_relate.schema';
import { memoryUnrelateSchema } from './memory_unrelate.schema';
import { conversationSearchSchema } from './conversation_search.schema';
import { recipeListSchema } from './recipe_list.schema';
import { recipeGetSchema } from './recipe_get.schema';
import { recipeSaveSchema } from './recipe_save.schema';
import { recipeUpdateSchema } from './recipe_update.schema';
import { recipeDeleteSchema } from './recipe_delete.schema';
import { recipePhotosAttachSchema } from './recipe_photos_attach.schema';
import { recipePhotosRemoveSchema } from './recipe_photos_remove.schema';
import { recipePhotosReorderSchema } from './recipe_photos_reorder.schema';
import { recipePhotoLabelSetSchema } from './recipe_photo_label_set.schema';
import { researchDocsSchema } from './research_docs.schema';
import { journalListSchema } from './journal_list.schema';
import { journalReadSchema } from './journal_read.schema';
import { journalSearchSchema } from './journal_search.schema';
import { journalDeleteSchema } from './journal_delete.schema';

// Agent-only toolbox re-exports moved to the bottom of the file
// alongside other re-exports. Direct `export ... from` rather than
// `import` + `export` so Rollup can tree-shake the chain out of the
// main chunk when main-chunk consumers don't reference these
// symbols (the workers / agents that DO use them import directly
// from `./memory_toolbox` etc., not via this barrel).

// `lazyTool` lives in `./lazy.ts` so the agent-toolbox files
// (`./memory_toolbox`, `./recall_toolbox`,
// `./conversation_recall_toolbox`) can use it too. With every
// consumer going through the lazy path, Vite emits one chunk per
// impl module regardless of which toolbox dispatches into it.
import { lazyTool } from './lazy';

// --- Gated tool wrappers --------------------------------------------
// Each is a thin object: schema fields spread in eagerly, execute()
// resolves the impl chunk on first call. Subsequent calls hit the
// browser's module cache - latency is one Promise resolution.
const memorySearch = lazyTool(
  memorySearchSchema,
  () => import('./memory_search'),
  'memorySearch'
);
const memoryCreate = lazyTool(
  memoryCreateSchema,
  () => import('./memory_create'),
  'memoryCreate'
);
const memoryUpdate = lazyTool(
  memoryUpdateSchema,
  () => import('./memory_update'),
  'memoryUpdate'
);
const memoryDelete = lazyTool(
  memoryDeleteSchema,
  () => import('./memory_delete'),
  'memoryDelete'
);
const memoryReaffirm = lazyTool(
  memoryReaffirmSchema,
  () => import('./memory_reaffirm'),
  'memoryReaffirm'
);
const memoryDoubt = lazyTool(
  memoryDoubtSchema,
  () => import('./memory_doubt'),
  'memoryDoubt'
);
const memoryRelate = lazyTool(
  memoryRelateSchema,
  () => import('./memory_relate'),
  'memoryRelate'
);
const memoryUnrelate = lazyTool(
  memoryUnrelateSchema,
  () => import('./memory_unrelate'),
  'memoryUnrelate'
);
const conversationSearch = lazyTool(
  conversationSearchSchema,
  () => import('./conversation_search'),
  'conversationSearch'
);
const recipeList = lazyTool(
  recipeListSchema,
  () => import('./recipe_list'),
  'recipeList'
);
const recipeGet = lazyTool(
  recipeGetSchema,
  () => import('./recipe_get'),
  'recipeGet'
);
const recipeSave = lazyTool(
  recipeSaveSchema,
  () => import('./recipe_save'),
  'recipeSave'
);
const recipeUpdate = lazyTool(
  recipeUpdateSchema,
  () => import('./recipe_update'),
  'recipeUpdate'
);
const recipeDelete = lazyTool(
  recipeDeleteSchema,
  () => import('./recipe_delete'),
  'recipeDelete'
);
const recipePhotosAttach = lazyTool(
  recipePhotosAttachSchema,
  () => import('./recipe_photos_attach'),
  'recipePhotosAttach'
);
const recipePhotosRemove = lazyTool(
  recipePhotosRemoveSchema,
  () => import('./recipe_photos_remove'),
  'recipePhotosRemove'
);
const recipePhotosReorder = lazyTool(
  recipePhotosReorderSchema,
  () => import('./recipe_photos_reorder'),
  'recipePhotosReorder'
);
const recipePhotoLabelSet = lazyTool(
  recipePhotoLabelSetSchema,
  () => import('./recipe_photo_label_set'),
  'recipePhotoLabelSet'
);
const researchDocs = lazyTool(
  researchDocsSchema,
  () => import('./research_docs'),
  'researchDocs'
);
const journalList = lazyTool(
  journalListSchema,
  () => import('./journal_list'),
  'journalList'
);
const journalRead = lazyTool(
  journalReadSchema,
  () => import('./journal_read'),
  'journalRead'
);
const journalSearch = lazyTool(
  journalSearchSchema,
  () => import('./journal_search'),
  'journalSearch'
);
const journalDelete = lazyTool(
  journalDeleteSchema,
  () => import('./journal_delete'),
  'journalDelete'
);

/**
 * Always-on toolbox. Rides with every request regardless of the
 * thread's `toolboxes_enabled` array.
 *
 * The principle: every read-only surface lives here. Reads are
 * idempotent and cheap; gating them was forcing the model to weigh
 * "do I need this badly enough to flip a toolbox?" and frequently
 * answering wrong - in particular passing over memory_search /
 * journal_search in favour of answering from training data, even
 * when the user had explicitly asked what Nak remembered. Writes
 * still gate (see `cookingToolbox`, `memoriesToolbox`,
 * `journalToolbox` below) because an autonomous tool turn can
 * scribble over user data and the user-or-model gate is the
 * structural backstop.
 *
 * Members in catalog order:
 *   - `toggle_toolbox` - the gating mechanism for the write boxes.
 *   - `memory_recall`, `conversation_recall` - top-of-thread recall
 *     passes that return a structured note. Run a sub-agent under
 *     the hood; their toolboxes are read-only.
 *   - `memory_search` - direct semantic search over the user's
 *     long-term memories. Returns rows with ids so the model can
 *     hand them to the gated write tools.
 *   - `conversation_search` - direct semantic search over prior
 *     conversation titles + summaries.
 *   - `journal_list` / `journal_read` / `journal_search` - date-
 *     based and meaning-based reads over the user's daily journal.
 *   - `recipe_list` / `recipe_get` - browse and fetch the user's
 *     saved recipes.
 *   - `research_docs` - bounded sub-agent that answers
 *     meta-questions about Nak itself by reading the bundled
 *     in-app help corpus.
 *   - `web_search` - sub-completion against Venice's live web
 *     search; the only path search results reach the main model.
 *   - `update_title` - rename the conversation; has to fire on the
 *     very first turn before any gated toolbox is on.
 *   - `analyze_image` - vision sub-completion against an image
 *     attached anywhere in the thread.
 */
export const alwaysOnToolbox: Toolbox = {
  name: 'always_on',
  description:
    'Reflex-level tools that ride every request without being ' +
    'toggled. Read-only surfaces (recall, search, list, read across ' +
    'memories / conversations / journal / cookbook / app docs) plus ' +
    'web search, update_title, analyze_image, and the ' +
    'toggle_toolbox meta-tool.',
  tools: [
    toggleToolbox,
    memoryRecall,
    conversationRecall,
    memorySearch,
    conversationSearch,
    journalList,
    journalRead,
    journalSearch,
    recipeList,
    recipeGet,
    researchDocs,
    webSearch,
    updateTitle,
    analyzeImage,
  ],
};

/**
 * Cookbook write tools. Read paths (`recipe_list`, `recipe_get`)
 * live in the always-on set; this toolbox carries only the tools
 * that mutate cookbook state (saving a new recipe, editing an
 * existing one, deleting one, attaching / removing / reordering
 * photos, captioning photos). The user enables it from the composer
 * popover when they want to record a recipe; the model can also
 * flip it on via `toggle_toolbox` once the conversation makes a
 * cookbook write the obvious next move.
 */
export const cookingToolbox: Toolbox = {
  name: 'cooking',
  description:
    'Save, edit, and delete recipes in the cookbook; attach, remove, ' +
    'reorder, and caption recipe photos. Read tools (recipe_list, ' +
    'recipe_get) are always-on; this toolbox carries the writes.',
  tools: [
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
 * Memory write tools. `memory_search` lives in the always-on set so
 * the model can find ids without a toggle round-trip; this toolbox
 * carries the writes (create, update, delete) plus the volitional-
 * memory levers (reaffirm/doubt for graded confidence, relate/
 * unrelate for the memory-graph layer).
 *
 * Contrast with the agent-only `memoryToolbox` (defined in
 * `./memory_toolbox`, re-exported near the bottom of this file),
 * which swaps `memory_delete` for `memory_invalidate` and includes
 * `memory_search` directly because agents don't have access to the
 * always-on registry. Agents operating on their own authority only
 * get soft-decay, not hard delete.
 */
export const memoriesToolbox: Toolbox = {
  name: 'memories',
  description:
    "Create, update, delete, reaffirm, doubt, and link the user's " +
    'long-term memories. Read paths (memory_search, memory_recall) ' +
    'are always-on; this toolbox carries the writes.',
  tools: [
    memoryCreate,
    memoryUpdate,
    memoryDelete,
    memoryReaffirm,
    memoryDoubt,
    memoryRelate,
    memoryUnrelate,
  ],
};

/**
 * Journal write tools. Reads (`journal_list`, `journal_read`,
 * `journal_search`) live in the always-on set; this toolbox carries
 * the only chat-callable write, `journal_delete`, which removes a
 * journal entry and (for automatic entries) marks the source thread
 * as excluded so the background worker won't regenerate it. Creating
 * automatic entries is the background journaling agent's job, not
 * the model's.
 */
export const journalToolbox: Toolbox = {
  name: 'journal',
  description:
    "Delete journal entries the user no longer wants. Read tools " +
    '(journal_list, journal_read, journal_search) are always-on; ' +
    'this toolbox carries the delete write. Automatic entry creation ' +
    'is handled by the background worker, not this toolbox.',
  tools: [journalDelete],
};

/**
 * The canonical ordered list of toolboxes exposed to the main chat.
 * Order is visible to the model (system-prompt catalog) and to the
 * user (popover list). Always-on goes first so the model reads the
 * reflex-level surfaces before the gated catalog. The conversations
 * and research toolboxes were dropped: their only members were
 * read-only (`conversation_search`, `research_docs`) and now ride in
 * always-on, so an empty gated toolbox would have no tools to gate.
 */
export const TOOLBOXES: readonly Toolbox[] = [
  alwaysOnToolbox,
  cookingToolbox,
  memoriesToolbox,
  journalToolbox,
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
// Direct `export ... from` re-exports so Rollup can elide the
// chain when main-chunk consumers don't read these symbols. Worker
// / agent entry points import the toolboxes directly via their
// source paths, not through this barrel.
export { memoryToolbox } from './memory_toolbox';
export { recallToolbox } from './recall_toolbox';
export { conversationRecallToolbox } from './conversation_recall_toolbox';

export { toOpenAIToolDef, buildToolboxWireList, executeToolboxCall };
export { toggleToolbox, updateTitle };
export type { ToolDef, OpenAIToolDef, ToolContext, ToolResult, Toolbox } from './types';
export type { OpenAIToolCall } from './types';
