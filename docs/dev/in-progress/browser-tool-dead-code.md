# Browser tool/agent dead code after the streaming-root migration

**Status:** triage notes for a future cleanup session. Nothing here is
done except the `analyze_image` worked example (see below). Do NOT treat
the dead lists as safe-to-delete without running the per-file checklist -
the live and dead tools are interleaved inside the same toolboxes.

## One-paragraph summary

The streaming-root migration moved chat tool *execution* into the venice
edge function. A streamed chat turn now dispatches tools server-side
(`getStreamingResponse` -> `performToolCall`, against the Deno ports under
`supabase/functions/venice/tools/` and `.../agents/`). The browser's chat
tool dispatcher (`executeToolCall` in `src/lib/tools/index.ts`) has no
production caller anymore - only tests. But the browser still *composes
the wire `tools` array* (schemas) via `buildToolList`, and browser-side
background agents still dispatch their tools browser-side via
`executeToolboxCall`. So each browser tool's `execute()` is live or dead
depending on whether a live browser agent uses it - and the duplicated
browser/edge implementations have no signpost saying which copy is live.
That is the red herring: the browser copy looks like the implementation,
but for chat tools the edge copy is what runs.

## The dispatch split (why a browser `execute()` can be dead)

- **Chat turn -> edge.** `chat-loop.ts` sends the request (incl. the
  `tools` schema array from `buildToolList`) to `/stream`. The edge
  orchestrator runs the model and dispatches each tool call through
  `performToolCall`, which executes the Deno port. The browser tool's
  `execute()` is never called for a chat turn.
- **Background agent -> browser.** The supervisor/worker pipeline still
  runs background agents browser-side (reflection, wiki, wiki-librarian,
  rem, deep-sleep). Each calls `runHeadlessToolLoop`, which dispatches
  its toolbox via `executeToolboxCall` (`src/lib/tools/run.ts` ->
  `dispatch.ts`). Those tools' browser `execute()` bodies ARE live.
- **`executeToolCall` vs `executeToolboxCall`.** The first (chat
  dispatcher) is dead in production (test-only). The second (agent
  dispatcher) is live. Easy to conflate.

## Worked example already landed (the template)

`analyze_image` was cleaned up on the branch this doc ships from:

- `supabase/functions/venice/tools/analyze_image.ts` - the live impl;
  gained the qwen-primary + uncensored-fallback behavior.
- `src/lib/tools/analyze_image.ts` - gutted to a schema-only `ToolDef`
  whose `execute()` throws, pointing at the edge file. The schema half
  stays because `buildToolList` still advertises `analyze_image`.
- `supabase/functions/venice/performToolCall.ts` - its header comment
  used to claim tools are "dispatched by chat-loop.ts via
  executeToolCall." That stale comment was a contributing red herring;
  it has been corrected to describe edge dispatch.

The full cleanup wants the same shape applied to the rest of the dead
set, ideally via a shared helper rather than ~25 hand-written stubs (see
Mechanics).

## LIVE browser tools - KEEP (execute is load-bearing)

Used by live browser background agents via `executeToolboxCall`. Do NOT
gut or delete these `execute()` bodies.

Live agent toolboxes and their owners:

- `src/lib/tools/memory_toolbox.ts` - `ReflectionAgent`.
- `src/lib/tools/memory_librarian_toolbox.ts` - `RemAgent`,
  `DeepSleepAgent`.
- `src/lib/tools/wiki_toolbox.ts` - `WikiAgent`.
- `src/lib/tools/wiki_librarian_toolbox.ts` - `WikiLibrarianAgent`.

Union of live tools (their browser impl files stay):

`memory_search`, `memory_create`, `memory_update`, `memory_invalidate`,
`memory_reaffirm`, `memory_doubt`, `memory_relate`, `memory_unrelate`,
`memory_consolidate`, `conversation_search`, `wiki_search`,
`wiki_create`, `wiki_update`, `wiki_delete`.

## DEAD chat-only tools - browser `execute()` is dead

Dispatched edge-side, used by no live browser agent. The browser
`ToolDef` must keep advertising the schema (it rides in `buildToolList`),
so the cleanup keeps the schema and removes only the dead implementation.
Grouped by the chat toolbox that references them in
`src/lib/tools/index.ts`:

- **alwaysOnToolbox:** `context`, `memory_recall`, `conversation_recall`,
  `wiki_recall`, `conversation_get`, `wiki_list`, `wiki_get`,
  `recipe_list`, `recipe_get`, `doc_list`, `doc_get`, `doc_grep`,
  `doc_read`, `research_docs`, `web_search`, `update_title`.
  (`analyze_image` already done.)
- **cookingToolbox:** `recipe_save`, `recipe_update`, `recipe_delete`,
  `recipe_photos_attach`, `recipe_photos_remove`, `recipe_photos_reorder`,
  `recipe_photo_label_set`.
- **memoriesToolbox:** `memory_delete` ONLY. The other members
  (`memory_create/update/reaffirm/doubt/relate/unrelate`) are LIVE via
  `memory_toolbox.ts` - this is the interleaving trap. `memory_delete`
  is in no agent toolbox (the agent set carries `memory_invalidate`, not
  `memory_delete`).
- **wikiToolbox (chat, `index.ts`):** `wikiLibrarian` - the
  `src/lib/tools/wiki_librarian.ts` TOOL. See the naming trap below; this
  is NOT the live wiki-librarian agent.
- **libraryToolbox:** `doc_create`, `doc_update`, `doc_delete`.
- **imagesToolbox:** `generate_image` - SPECIAL, see below.

## DEAD browser agent code (recall family)

The browser recall agents have no live constructor - they are only
instantiated inside the dead recall TOOLS' `execute()`
(`memory_recall.ts:44`, `conversation_recall.ts:48`, `wiki_recall.ts:48`),
and chat recall now runs edge-side (`supabase/functions/venice/agents/
recall.ts`, `conversation_recall.ts`, `wiki_recall.ts`, `context.ts`). So
these are removable once the recall tools are:

- `src/lib/agents/recall/` (`RecallAgent`) + `src/lib/tools/recall_toolbox.ts`
- `src/lib/agents/conversation_recall/` (`ConversationRecallAgent`) +
  `src/lib/tools/conversation_recall_toolbox.ts`
- `src/lib/agents/wiki_recall/` (`WikiRecallAgent`) +
  `src/lib/tools/wiki_recall_toolbox.ts`

## Special flowers - per-tool care, do not blanket-gut

- **`toggle_tools`** (`src/lib/tools/toggle_tools.ts`, `toggleToolbox`;
  edge port `tools/toggle_tools.ts`). Mutates `thread.toolboxes_enabled`,
  which is browser-owned UI state. Before touching, confirm how an
  edge-side toggle round-trips back to the browser (realtime on
  `threads`? a follow-up fetch?) - the browser may have a live role here
  beyond schema.
- **`ask_user`** (`src/lib/tools/ask_user.ts`; edge port
  `tools/ask_user.ts`). Returns the `__ask_user_pending__` sentinel; the
  chat-loop suspends and `AskUserCard` rewrites the row to
  `__ask_user_answered__`. The suspension/answer flow is browser-coupled.
  Confirm the browser `execute()` is genuinely off the path before
  gutting.
- **`generate_image`** (`src/lib/tools/generate_image.ts` +
  `generate_image.schema.ts` + `generated-image.ts`; edge ports
  `tools/generate_image.ts` + `tools/_generated_image.ts`). The harvest
  runs edge-side now, so the TOOL `execute()` is likely dead, BUT
  `generated-image.ts` exports pure helpers (`extractGeneratedImage`,
  `stripGeneratedImage`, `generatedImageToNewAttachment`,
  `GENERATED_IMAGE_RESULT_KEY`) that may still be imported by live
  browser rendering / chat-loop code. Verify those readers before
  removing anything beyond the tool `execute()`.

## Naming traps

- **`wiki_librarian` TOOL (dead) vs wiki-librarian AGENT (live).** The
  tool is `src/lib/tools/wiki_librarian.ts`. The agent is
  `src/lib/agents/wiki-librarian/`, constructed in its worker/runner and
  using the live `wiki_librarian_toolbox.ts`.
- **Two "wikiToolbox" / "memoriesToolbox".** The gated CHAT toolboxes
  live in `src/lib/tools/index.ts` (`wikiToolbox = [wikiLibrarian]`,
  `memoriesToolbox = [...]`). The AGENT toolboxes are the separate
  `*_toolbox.ts` modules (`wiki_toolbox.ts`, `memory_toolbox.ts`). Same
  concept-name, different objects, opposite liveness.

## Recommended cleanup mechanics

1. Add a `serverSideTool(schema): ToolDef` helper - a `ToolDef` that
   spreads the schema and whose `execute()` throws, pointing at the edge
   function. One helper beats ~25 near-identical throwing stubs.
2. **Delete** each dead impl file (keep its `.schema.ts`) and repoint the
   chat toolbox in `index.ts` to `serverSideTool(xSchema)`. Prefer delete
   over stub: a file still referenced by an agent toolbox's
   `lazyTool(() => import('./x'))` fails the Rollup build LOUDLY if you
   misclassify, whereas a throwing stub fails silently at agent runtime.
3. Per-file checklist before deleting:
   - Confirm a `.schema.ts` companion exists. If the schema is inline in
     the impl, extract it first so `buildToolList` keeps advertising the
     tool.
   - `grep` for non-test imports of any symbol the impl file exports
     besides the `ToolDef` (helpers consumed elsewhere - the
     `generated-image.ts` case).
   - Confirm the tool is in NO live agent toolbox
     (`memory_toolbox`, `memory_librarian_toolbox`, `wiki_toolbox`,
     `wiki_librarian_toolbox`).
4. After the tools: remove the dead recall agent dirs + recall toolbox
   modules (above). Then `executeToolCall` and its tests in
   `tests/tools.test.ts` should fall out as unused - verify and drop.

## Verification gates

- `mise run check` - the build (Rollup) catches a dangling dynamic
  import if a deleted file is still referenced; svelte-check + lint run.
- `mise run knip` - flags newly-unused files/exports (a `.schema.ts`
  that lost its last reader, orphaned helpers).
- Manual: confirm reflection / wiki / wiki-librarian / rem / deep-sleep
  still resolve their toolbox tools (their `lazyTool` imports must still
  point at live impl files).
