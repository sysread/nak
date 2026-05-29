/**
 * Tool registry - the list of every function the LLM can invoke in this
 * app, organised into named toolboxes, plus the helpers that turn those
 * boxes into wire-shaped payloads.
 *
 * Responsibility split:
 * *   - Each tool file (./toggle_tools.ts, ./memory_*.ts, ./conversation_*.ts,
 *     ...) exports a single ToolDef describing what it does and how to
 *     run it.
 *   - This file composes them into named toolboxes (cooking, memories,
 *     always_on), resolves names to defs, and projects them into
 *     the OpenAI / Venice request shape.
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
 * wiki / app docs, the update_title convenience, the analyze_image
 * vision sub-call, and the toggle_toolbox meta-tool itself). Gated
 * toolboxes carry only writes (memory_create through memory_unrelate,
 * recipe_save through recipe_photo_label_set) and are included only
 * when their name is listed in the thread's `toolboxes_enabled`
 * array. The LLM flips gating via
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
// The umbrella `context` tool, the four per-layer recall tools, web
// search, update_title, analyze_image, and the toggle meta-tool fire
// on the first-message critical path (the recall surfaces on topic
// boundaries / when the model needs persistent context, web_search
// on time-sensitive questions, update_title on the very first turn,
// analyze_image when the user attaches an image). The cold-start
// chunk-fetch tax is not acceptable there, so they stay eager. The
// other always-on tools (search/list/read across memories,
// conversations, recipes, wiki, app docs) are still
// always-on but lazy-imported via the lazyTool wrappers below - they
// fire on demand, not on every turn, so the schema rides eagerly
// while the impl module loads on first dispatch.
import { toggleToolbox } from './toggle_tools';
import { memoryRecall } from './memory_recall';
import { conversationRecall } from './conversation_recall';
import { wikiRecall } from './wiki_recall';
import { contextTool } from './context';
import { webSearch } from './web_search';
import { updateTitle } from './update_title';
import { analyzeImage } from './analyze_image';
import { askUser } from './ask_user';

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
import { conversationGetSchema } from './conversation_get.schema';
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
import { wikiSearchSchema } from './wiki_search.schema';
import { wikiListSchema } from './wiki_list.schema';
import { wikiGetSchema } from './wiki_get.schema';
import { wikiLibrarianSchema } from './wiki_librarian.schema';
import { docSearchSchema } from './doc_search.schema';
import { docListSchema } from './doc_list.schema';
import { docGetSchema } from './doc_get.schema';
import { docGrepSchema } from './doc_grep.schema';
import { docReadSchema } from './doc_read.schema';
import { docCreateSchema } from './doc_create.schema';
import { docUpdateSchema } from './doc_update.schema';
import { docDeleteSchema } from './doc_delete.schema';
import { generateImageSchema } from './generate_image.schema';

// Agent-only toolbox re-exports moved to the bottom of the file
// alongside other re-exports. Direct `export ... from` rather than
// `import` + `export` so Rollup can tree-shake the chain out of the
// main chunk when main-chunk consumers don't reference these
// symbols (the workers / agents that DO use them import directly
// from `./memory_toolbox` etc., not via this barrel).

// `lazyTool` lives in `./lazy.ts` so the agent-toolbox files
// (`./memory_toolbox`, `./recall_toolbox`,
// `./conversation_recall_toolbox`, `./wiki_recall_toolbox`) can use
// it too. With every consumer going through the lazy path, Vite
// emits one chunk per impl module regardless of which toolbox
// dispatches into it.
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
const conversationGet = lazyTool(
  conversationGetSchema,
  () => import('./conversation_get'),
  'conversationGet'
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
const wikiSearch = lazyTool(
  wikiSearchSchema,
  () => import('./wiki_search'),
  'wikiSearch'
);
const wikiList = lazyTool(
  wikiListSchema,
  () => import('./wiki_list'),
  'wikiList'
);
const wikiGet = lazyTool(
  wikiGetSchema,
  () => import('./wiki_get'),
  'wikiGet'
);
const wikiLibrarian = lazyTool(
  wikiLibrarianSchema,
  () => import('./wiki_librarian'),
  'wikiLibrarian'
);
const docSearch = lazyTool(docSearchSchema, () => import('./doc_search'), 'docSearch');
const docList = lazyTool(docListSchema, () => import('./doc_list'), 'docList');
const docGet = lazyTool(docGetSchema, () => import('./doc_get'), 'docGet');
const docGrep = lazyTool(docGrepSchema, () => import('./doc_grep'), 'docGrep');
const docRead = lazyTool(docReadSchema, () => import('./doc_read'), 'docRead');
const docCreate = lazyTool(docCreateSchema, () => import('./doc_create'), 'docCreate');
const docUpdate = lazyTool(docUpdateSchema, () => import('./doc_update'), 'docUpdate');
const docDelete = lazyTool(docDeleteSchema, () => import('./doc_delete'), 'docDelete');
const generateImage = lazyTool(
  generateImageSchema,
  () => import('./generate_image'),
  'generateImage'
);

/**
 * Always-on toolbox. Rides with every request regardless of the
 * thread's `toolboxes_enabled` array.
 *
 * The principle: every read-only surface lives here. Reads are
 * idempotent and cheap; gating them was forcing the model to weigh
 * "do I need this badly enough to flip a toolbox?" and frequently
 * answering wrong - in particular passing over memory_search in
 * favour of answering from training data, even when the user had
 * explicitly asked what Nak remembered. Writes still gate (see
 * `cookingToolbox`, `memoriesToolbox` below) because an autonomous
 * tool turn can scribble over user data and the user-or-model gate
 * is the structural backstop.
 *
 * Members in catalog order:
 *   - `toggle_toolbox` - the gating mechanism for the write boxes.
 *   - `context` - the umbrella recall tool that searches all three
 *     persistent layers (memories, prior conversations, wiki) in
 *     parallel and returns a works-cited index: memory facts verbatim
 *     plus related conversations and wiki articles by id. PREFERRED
 *     first step when the model wants broad context on the user; the
 *     per-layer recall tools below stay as targeted drill-downs.
 *   - `memory_recall`, `conversation_recall`, `wiki_recall` -
 *     per-layer recall passes, each running an LLM sub-agent that
 *     returns a synthesized note from one store. The targeted,
 *     more-expensive drill-down tier above the deterministic `context`
 *     survey; first-line picks when the model already knows which
 *     layer it wants a considered read of.
 *   - `memory_search` - direct semantic search over the user's
 *     long-term memories. Returns rows with ids so the model can
 *     hand them to the gated write tools.
 *   - `conversation_search` - direct semantic search over prior
 *     conversation titles + summaries.
 *   - `conversation_get` - primary-key fetch of one prior thread
 *     (title, summary, windowed transcript) once the model knows the
 *     id, from a search hit or an auto-injected context block. The
 *     conversation-layer counterpart to `wiki_get`.
 *   - `wiki_search` - semantic search over the user's flat wiki
 *     (encyclopedic articles about topics in their life). Articles
 *     are never auto-injected; this and the two reads below are the
 *     only paths to reach them.
 *   - `wiki_list` / `wiki_get` - alphabetical projection and
 *     primary-key body fetch for the wiki. Same shape as the
 *     recipe pair below; together they let the model survey wiki
 *     shape and read a specific article without paying for a
 *     vector search when it already knows the id.
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
 *   - `ask_user` - pose a clarifying multiple-choice question to the
 *     user instead of guessing intent. The chat-loop suspends after
 *     this call lands; the next round starts when the user submits an
 *     answer via the AskUserCard UI. Always-on because the model
 *     should be able to reach for it as a clarification reflex on the
 *     first turn, not after toggling a write box.
 */
export const alwaysOnToolbox: Toolbox = {
  name: 'always_on',
  description:
    'Reflex-level tools that ride every request without being ' +
    'toggled. The umbrella `context` recall, the three per-layer ' +
    'recall tools, and read-only surfaces (search across ' +
    'memories / conversations / wiki / cookbook / app docs; ' +
    'plus get for conversations and wiki, and list/get for cookbook) ' +
    'plus web search, ' +
    'update_title, analyze_image, ask_user, and the toggle_toolbox meta-tool.',
  tools: [
    toggleToolbox,
    contextTool,
    memoryRecall,
    conversationRecall,
    wikiRecall,
    memorySearch,
    conversationSearch,
    conversationGet,
    wikiSearch,
    wikiList,
    wikiGet,
    recipeList,
    recipeGet,
    docSearch,
    docList,
    docGet,
    docGrep,
    docRead,
    researchDocs,
    webSearch,
    updateTitle,
    analyzeImage,
    askUser,
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
 * Wiki maintenance toolbox. Wiki reads (wiki_search, wiki_list,
 * wiki_get, wiki_recall) live in the always-on set; this toolbox
 * carries the librarian-delegation tool, which dispatches a
 * multi-round sub-agent that can create, update, and delete wiki
 * articles on the user's behalf. The user enables the toolbox from
 * the composer popover when they want to ask Nak to consolidate or
 * reshape their wiki; the model can flip it on via `toggle_toolbox`
 * once the conversation makes a librarian run the obvious next move.
 *
 * Only the librarian-invocation tool lives here - direct
 * wiki_create / wiki_update / wiki_delete are NOT exposed to the
 * main chat at all. Those remain reserved for the autonomous wiki
 * agent and the librarian itself, so any wiki edit driven by the
 * main chat has to go through the librarian's full read-then-plan
 * loop rather than a one-shot scribble.
 */
export const wikiToolbox: Toolbox = {
  name: 'wiki',
  description:
    "Delegate wiki maintenance tasks to the user's librarian sub-agent " +
    '(merge duplicates, delete stubs, split or rewrite articles). Read ' +
    'paths (wiki_search, wiki_list, wiki_get, wiki_recall) are ' +
    'always-on; this toolbox carries the librarian invocation.',
  tools: [wikiLibrarian],
};

/**
 * Image-generation toolbox. Gated rather than always-on: generating an
 * image spends Venice credits and writes a persistent attachment row,
 * so it gets the same deliberate user-or-model gate the cookbook /
 * memory writes use. The user enables it from the composer popover; the
 * model can flip it on via `toggle_toolbox` once a "draw me X" makes
 * generation the obvious next move. The generated image is attached to
 * the assistant's reply and rides the same 30-day retention as user
 * uploads.
 */
export const imagesToolbox: Toolbox = {
  name: 'images',
  description:
    'Generate an image from a text prompt and attach it to the reply. ' +
    'Stored under the same 30-day retention as user uploads; reachable ' +
    'afterward by analyze_image via its filename.',
  tools: [generateImage],
};

/**
 * Library write tools. Document reads (doc_search, doc_list, doc_get) live in
 * the always-on set; this toolbox carries the writes that mutate the user's
 * persistent document Library: promoting a pasted file into a permanent doc,
 * editing a doc's title/description, and deleting a doc (with its chunks and
 * stored original). Gated like the cookbook / memory writes - the user enables
 * it from the composer popover, or the model flips it on via toggle_toolbox
 * once saving or removing a document is the obvious next move. The model has no
 * file of its own, so doc_create only promotes a file the user already
 * attached to the conversation.
 */
export const libraryToolbox: Toolbox = {
  name: 'library',
  description:
    "Manage the user's document Library: save a file they attached to the " +
    'conversation as a permanent searchable document (doc_create), edit a ' +
    "document's title or description (doc_update), or delete a document " +
    '(doc_delete). Read paths (doc_search, doc_list, doc_get) are always-on; ' +
    'this toolbox carries the writes.',
  tools: [docCreate, docUpdate, docDelete],
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
  wikiToolbox,
  libraryToolbox,
  imagesToolbox,
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

/**
 * Look up the optional pretty-formatter overrides a tool may
 * declare on its schema. Used by the tool-call detail panel
 * (`src/components/ToolCalls.svelte` via `src/lib/ui/tool-calls.ts`)
 * to render args/results in a tool-specific shape when one is
 * available, falling back to the generic JSON-as-markdown
 * formatter otherwise. Unknown names return `undefined` so the
 * caller can fall back cleanly - a persisted call referencing
 * a tool that was renamed or removed since the row was written
 * should still render readably.
 */
export interface ToolFormatters {
  formatArgs?(args: Record<string, unknown>): string;
  formatResult?(result: unknown): string;
}

export function getToolFormatters(name: string): ToolFormatters | undefined {
  const tool = byName(name);
  if (!tool) return undefined;
  return { formatArgs: tool.formatArgs, formatResult: tool.formatResult };
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
export { wikiRecallToolbox } from './wiki_recall_toolbox';

export { toOpenAIToolDef, buildToolboxWireList, executeToolboxCall };
export { toggleToolbox, updateTitle };
export type { ToolDef, OpenAIToolDef, ToolContext, ToolResult, Toolbox } from './types';
export type { OpenAIToolCall } from './types';
