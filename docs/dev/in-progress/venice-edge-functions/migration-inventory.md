# Migration inventory

A living checklist of everything that must eventually move into (or behind) an
edge function, so nothing is forgotten between milestones. The *why* and the
architecture live in the [README](./README.md) - the strategic spine and the
two drivers (minimize-recovery and single-source-of-truth for the Venice key).
This file is the concrete punch list: call sites, workers, and processes, with
status.

**Iteratively audited - not exhaustive or final.** Each milestone re-audits and
updates this. Last full audit: **2026-06-04**, after the streaming-root
cut landed (see [streaming-root.md](./streaming-root.md)). The live chat
loop's `streamChat` was the last browser-direct Venice consumer; it now
goes through the `/stream` edge function (envelope POST + Broadcast
channel subscription), the Venice API key was removed from the client
bundle, and the per-turn round loop + tool dispatch live entirely on the
function side. **The migration's two drivers are met:** every Venice
endpoint goes through an edge function, and the function is the single
source of truth for the key. Audit walks `src/lib/venice.ts` callers
(`grep`), the `src/lib/agents/` worker fleet, and the
`supabase/functions/` directory. Line numbers drift; re-grep before
relying on one.

Status key:

- **DONE** - runs server-side / through the function.
- **TODO** - still browser-direct.
- **N/A-recovery** - interactive (no minimize-recovery need), but still a
  driver-B item while it holds the Venice key.

## Venice endpoints (the primitives the function wraps)

| Endpoint | `VeniceClient` method | Status |
| --- | --- | --- |
| `POST /embeddings` | `embed` (deleted from `VeniceClient`) | DONE - backfill (milestone 1, cron) + query-time (milestone 3, `/embed` route from the browser via `SupabaseService.embed`) |
| `POST /chat/completions` | `completeChat` (deleted from `VeniceClient`), `streamChat` (rewritten as a thin envelope-POST + Broadcast subscriber) | DONE for both halves - milestone 6 (`claude/complete-edge-function`) + the worker-fleet sweeps that followed (`claude/headless-tool-loop-complete`, `claude/recall-family-complete`, `claude/deep-sleep-rem-complete`, `claude/bias-agent-complete`, `claude/samskara-agent-complete`, `claude/wiki-agent-complete`, `claude/wiki-librarian-agent-complete`, `claude/venice-migration-cleanup`), then the streaming half (`claude/streaming-root-edge-function`, see [streaming-root.md](./streaming-root.md)). |
| `GET /billing/usage` | (was `fetchUsage`, now `SupabaseService.fetchUsage`) | DONE - milestone 2, `/usage` route |
| `POST /augment/text-parser` | `extractText` (deleted from `VeniceClient`) | DONE - milestone 4, `/text-parser` route. Fixed the CORS-broken browser path (every non-image upload had been "Failed to fetch"). Empirical: Venice caps at ~25 MB; the Supabase edge-function gateway is transparent at that scale (no escape hatch needed). `MAX_DOCUMENT_FILE_BYTES` clamped to 24 MiB to fail at the form guard instead of mid-upload. |
| `POST /image/generate` | `generateImage` (deleted from `VeniceClient`) | DONE - milestone 5, `/image-generate` route. Single browser caller (the `generate_image` tool) routes through `SupabaseService.generateImage`; the content-policy header check + variants=1/return_binary=false defaults moved into the Deno helper. |

## Venice call sites (browser) - callers to route through the function

Driver B needs every one of these to call the function instead of Venice
directly (so the key leaves the client). `file:line` from the 2026-06-01 audit.

### `embed` (`/embeddings`)

DONE - milestone 3 (`claude/embed-via-edge-function`, merged to main as
`ac2f6ec`). All ten browser embed callers (recipes/wiki/memories/library
search needles, the `conversation_search` tool, `context-recall/gather`,
`samskara`, `Chat.svelte` live path, and the `deep-sleep` + `samskara`
worker embeds) now go through `SupabaseService.embed` → `/embed` route.
`VeniceClient.embed` was deleted; the shared `veniceFunctionError` helper
was generalized from the `/usage` path to cover both routes. Cron
backfill (memories, threads, recipes, wiki, samskara-substrate,
document-chunks - the six `EMBED_SOURCES`) is still milestone 1's
server-side path.

### `completeChat` (`/chat/completions` non-streaming)

DONE - milestone 6 (`claude/complete-edge-function`) and the seven
follow-on sweeps that migrated every caller (see the milestone-history
section below). The function-side `/complete` route is a thin proxy: the
browser builds Venice's wire shape via the exported `buildChatBody` helper
(in `src/lib/venice.ts`) and forwards it; the function attaches the shared
key and returns Venice's response verbatim, plus a parsed `retryAfterMs`
on 429 so the browser's retry loop can act on Venice's hint.
`parseChatCompletion` + the rate-limit retry loop live in
`SupabaseService.complete` (the rate-limit constants moved private into
supabase.ts alongside the consumer in the cleanup sweep). This sidesteps
the wire-shape duplication question
[chat-completions.md](./chat-completions.md) flagged - the body builder
stays in one place. `VeniceClient.completeChat` is deleted.

**Migrated callers** (call `SupabaseService.complete`):

- tools: `tools/analyze_image.ts:180`, `tools/research_docs.ts:181`,
  `tools/web_search.ts:146`
- intuition: `intuition/pipeline.ts:77`, `intuition/pipeline.ts:292`
- auto-title: `title-gen.ts` (called from `agents/auto_title/loop.ts`
  and the supervisor's auto-title unit)

**Headless tool-loop driver** (`tools/run.ts:292`):
MIGRATED in `claude/headless-tool-loop-complete`. The driver itself
drives `toolCtx.supabase.complete` instead of taking a `venice` opt;
the 8 agent classes that compose it (`rem`, `recall`,
`conversation_recall`, `wiki_recall`, `reflection`, `wiki`,
`deep-sleep`, `wiki-librarian`) stopped passing `venice: this.venice`
at the top of each `runHeadlessToolLoop({ ... })` call.

**Recall family** (`RecallAgent`, `ConversationRecallAgent`,
`WikiRecallAgent`) MIGRATED in `claude/recall-family-complete`. Each
class dropped `venice` from its constructor; the matching tool
dispatchers (`memory_recall`, `conversation_recall`, `wiki_recall`)
stopped passing `ctx.venice`. `ToolContext.venice` became optional
to accommodate the recall agents not populating it; the chat loop
still populates the field in production for `wiki_librarian`'s sake
until the wiki-librarian family migrates. After wiki-librarian's
sweep ships, `ToolContext.venice` deletes outright.

**Deep-sleep + rem (the memory-librarian pair)** MIGRATED in
`claude/deep-sleep-rem-complete`. Both agent classes (`DeepSleepAgent`,
`RemAgent`) dropped `venice` from their constructors and toolCtx
literals; `deep-sleep/loop.ts` CycleContext lost its venice field;
both workers stopped constructing `VeniceClient` and accepting
`veniceApiKey`/`veniceBaseUrl` in the StartMessage; both managers
stopped sending `veniceApiKey` in `buildStartPayload`; the
main-thread `runManually` wrappers in `deep-sleep/runner.svelte.ts`
and `rem/runner.svelte.ts` dropped their `venice` opts; and the
shared `memory-librarian-run.svelte.ts` dispatcher dropped venice
from its StartDeps. Only main-thread caller (`Memories.svelte`'s
`confirmLibrarianRun`) stopped guarding on `app.venice`.

**Bias** MIGRATED in `claude/bias-agent-complete`. Bias is the first
of the no-tool-loop agents to migrate -- it calls Venice directly
through a `callOnce` helper rather than going through
`runHeadlessToolLoop`, so the migration moves `callOnce` to
`SupabaseService.complete` while keeping the `VeniceError`
`rate_limit` discrimination intact (the error class still wraps
function-side 429s). Agent constructor switched to `supabase`;
loop CycleContext lost its venice field (it was pass-through only);
worker dropped `VeniceClient` + `veniceApiKey`/`veniceBaseUrl` from
StartMessage + `venice` from CycleContext literal; manager dropped
`veniceApiKey` from `buildStartPayload`.

**Samskara** MIGRATED in `claude/samskara-agent-complete`. Same
shape as bias -- `callOnce` (4 phase methods plus the compound-
summary regen path all funnel through it) switched to
`SupabaseService.complete`; `SamskaraAgent` constructor takes
supabase; loop CycleContext drops the pass-through venice field;
worker drops the `VeniceClient` import + construction + the venice
fields on StartMessage and the CycleContext literal; manager drops
`veniceApiKey`. Test fixture for the cycle loop drops its inert
`fakeVenice` stub.

**Wiki** MIGRATED in `claude/wiki-agent-complete`. The wiki agent
mixes two completion paths: most rounds drive `runHeadlessToolLoop`
(already migrated in step 2), but `updateOne` makes one direct
non-streaming completion call for the per-article manual-update
flow. Both paths now go through `SupabaseService.complete`. Agent
constructor dropped `venice`; the headless-tool-loop toolCtx dropped
its `venice: this.venice` slot. Worker and manager follow the
standard shape (drop `VeniceClient` import + venice api-key fields).
Main-thread WikiAgent constructors in `Wiki.svelte`
(`submitManualUpdate`) and `WikiSkippedPanel.svelte` (`retryRow`)
stopped guarding on `app.venice` and stopped passing it. Wiki test
fixture dropped the now-obsolete `makeInertVenice` helper.

**Wiki-librarian + supervisor-hosted fleet** MIGRATED in
`claude/wiki-librarian-agent-complete`. The wiki-librarian half is
the standard agent shape (drop venice from constructor + toolCtx,
worker, manager, runner.svelte.ts `RunManuallyOpts`). The
supervisor sweep that ships in the same commit migrates the five
agents the supervisor worker hosts: reflection (constructor-only,
already drove `runHeadlessToolLoop`), summary, topics,
memory_topics, recipe_topics (each had one direct
`venice.completeChat` call swapped to `supabase.complete` plus the
constructor swap). The supervisor worker drops `VeniceClient`
import + the venice block; its `SupervisorContext` drops the
pass-through venice field; the manager drops `veniceApiKey`. The
two unused-`_supabase` shimmed constructors on `MemoryTopicsAgent`
and `RecipeTopicsAgent` shed the underscore prefix because the
field is now actively used. `ToolContext.venice` deleted outright;
the non-null assertion `ctx.venice!` in `tools/wiki_librarian.ts`
removed; the `venice` field on the production `ToolContext`
literal in `chat-loop.ts` dropped; the venice guards in
`Wiki.svelte`'s `submitLibrarianRun` dropped. Ten test files
cleaned of stale `venice: ...` ToolContext fields; six unused
`VeniceClient` type imports stripped; the `mockVenice` helpers
in `agents.test.ts` and `tools.test.ts` deleted; `summary-agent.
test.ts` rewritten to script `supabase.complete` instead of
`venice.completeChat`; `reflection-agent.test.ts` and `wiki-agent.
test.ts` `makeInertVenice` helpers + their nine and nine
constructor-arg call sites collapsed.

**Cleanup** in `claude/venice-migration-cleanup` after the
wiki-librarian sweep retired the last consumer.
`VeniceClient.completeChat` deleted; the
`COMPLETE_CHAT_RATE_LIMIT_*` exports and the `sleepCancellable`
helper deleted from `venice.ts` and re-homed private into
`supabase.ts` next to the one consumer. The
`describe('VeniceClient.completeChat', ...)` block in
`tests/venice.test.ts` deleted (~300 lines). The
`web-search.integration.test.ts` historical-bug reproduction
deleted (it exercised the deleted method).

### `streamChat` (`/chat/completions` streaming)

DONE - `claude/streaming-root-edge-function`. The browser's
`streamChat` is now a thin POST to the `/stream` edge function
that subscribes to a Supabase Realtime Broadcast channel for the
event stream; `src/lib/venice.ts` no longer owns the SSE
parser, the round loop, the rate-limit retry, or the tool
dispatch - all moved to `supabase/functions/venice/`
(`getStreamingResponse.ts` round loop, `getStreamingCompletion.ts`
SSE consumer, `performToolCall.ts` dispatch). The Venice API
key is gone from the client bundle. Full architectural rationale
in [streaming-root.md](./streaming-root.md).

- Browser caller (`src/lib/chat-loop.ts`) still calls
  `venice.streamChat(...)`, but the implementation is now an
  envelope POST + channel subscriber, not a direct Venice fetch.

### `extractText` (`/augment/text-parser`)

DONE - milestone 4 (`claude/text-parser-edge-function`, merged to main as
`1b5fb7f`). The Library ingest (`src/lib/documents.ts`) and the chat-
attachments composer (`src/screens/Chat.svelte`) both call
`SupabaseService.extractText` (multipart `FormData` through
`functions.invoke`); `VeniceClient.extractText` is gone.

### `generateImage` (`/image/generate`)

DONE - milestone 5 (`claude/image-generate-edge-function`). The
`generate_image` tool (`src/lib/tools/generate_image.ts`) calls
`SupabaseService.generateImage`; the camel-to-snake_case translation, the
variants=1/return_binary=false defaults, and the `x-venice-is-content-
violation` guard live in the Deno helper. `VeniceClient.generateImage`
is gone.

## Background workers (driver A: relocate the loop + cron)

Each runs as a browser Web Worker today (see `src/lib/agents/`). Surviving a
closed tab means moving its claim -> process -> save loop server-side and onto a
schedule - the pattern milestone 1 established for the embeddings backfill.
Wrapping the Venice endpoint each one calls is necessary but not sufficient; the
orchestration has to move too.

- **embeddings backfill** - DONE (milestone 1).
- **attachment_expiry** - DONE (no longer a browser worker; relocated to the
  `expire-attachments` edge function + cron as part of the attachments
  Storage-bucket migration). Does not call Venice - it sweeps expired bucket
  entries and rows - but the driver-A relocation pattern is the same shape as
  milestone 1.
- **recipe-image-gc** - DONE (server-side from inception, never a browser
  worker - introduced alongside the recipe-image Storage-bucket migration).
  Worth tracking here as another exemplar of the cron-worker pattern even
  though it skipped the browser-to-server hop.
- **Driver B done across the worker fleet.** Every browser-resident worker
  (`bias`, `samskara`, `summary`, `topics`, `memory_topics`, `recipe_topics`,
  `wiki`, `wiki-librarian`, `deep-sleep`, `rem`, `auto_title`) now drives
  `SupabaseService.complete` for chat completions; none constructs a
  `VeniceClient` or carries a `veniceApiKey` on its start payload. Driver A
  (relocate the worker loop server-side onto a `pg_cron` schedule) is the
  next-level question for each worker -- still open per-family, but the
  shared-key half of the migration is done.
- **Recall family** (`conversation_recall`, `wiki_recall`, `recall`): mostly
  live-turn priming, not background drains - the per-family cron audit
  starts here.

## Multi-step processes

- **Document ingestion** (`ingestDocument`, `src/lib/documents.ts`): create row
  -> upload binary to Storage -> `extractText` -> store the text. A browser
  orchestration that now calls the function for the extraction step (milestone
  4), but the orchestration itself is still browser-driven. A candidate to
  move server-side so a long-PDF upload survives the page being backgrounded:
  trigger an `ingest-documents` edge function from a `documents.extraction_status
  = 'pending'` cron sweep, mirroring the embeddings backfill shape.

## The attractor

The streaming chat turn running entirely in an edge function - reading Venice,
persisting the assistant message itself, the client reconciling on return - is
the end state for driver A. It is the root of the call tree; every leaf above
climbs toward it. Design lives in [chat-completions.md](./chat-completions.md);
the open fork (how the client collects the stream) is recorded there.
