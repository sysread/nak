# Migration inventory

A living checklist of everything that must eventually move into (or behind) an
edge function, so nothing is forgotten between milestones. The *why* and the
architecture live in the [README](./README.md) - the strategic spine and the
two drivers (minimize-recovery and single-source-of-truth for the Venice key).
This file is the concrete punch list: call sites, workers, and processes, with
status.

**Iteratively audited - not exhaustive or final.** Each milestone re-audits and
updates this. Last full audit: **2026-06-02**, after the chat-completions
non-streaming leaf landed PARTIALLY: tools + intuition + auto-title moved
through `SupabaseService.complete`, but the background-agent Web Workers
(bias, samskara, summary, topics, etc.) still bootstrap their own
`VeniceClient` via `veniceApiKey` postMessage and call
`VeniceClient.completeChat` directly - their migration is deferred to a
follow-up milestone where the worker-message protocol can be reshaped
cleanly. Audit walks `src/lib/venice.ts` callers (`grep`), the
`src/lib/agents/` worker fleet, and the `supabase/functions/` directory.
Line numbers drift; re-grep before relying on one.

Status key:

- **DONE** - runs server-side / through the function.
- **PARTIAL** - some of the surface moved, some hasn't.
- **TODO** - still browser-direct.
- **N/A-recovery** - interactive (no minimize-recovery need), but still a
  driver-B item while it holds the Venice key.

## Venice endpoints (the primitives the function wraps)

| Endpoint | `VeniceClient` method | Status |
| --- | --- | --- |
| `POST /embeddings` | `embed` (deleted from `VeniceClient`) | DONE - backfill (milestone 1, cron) + query-time (milestone 3, `/embed` route from the browser via `SupabaseService.embed`) |
| `POST /chat/completions` | `completeChat` (PARTIAL - tools + intuition + auto-title moved; background workers deferred), `streamChat` (TODO - the attractor) | PARTIAL - milestone 6 (`claude/complete-edge-function`), `/complete` route. See "completeChat (`/chat/completions` non-streaming)" below for the deferred caller list. |
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

PARTIAL - milestone 6 (`claude/complete-edge-function`). The function-side
`/complete` route is a thin proxy: the browser builds Venice's wire shape
via the exported `buildChatBody` helper (in `src/lib/venice.ts`) and
forwards it; the function attaches the shared key and returns Venice's
response verbatim, plus a parsed `retryAfterMs` on 429 so the browser's
retry loop can act on Venice's hint. `parseChatCompletion` + the rate-
limit retry loop stay browser-side in `SupabaseService.complete`. This
sidesteps the wire-shape duplication question
[chat-completions.md](./chat-completions.md) flagged - the body builder
stays in one place.

**Migrated callers** (call `SupabaseService.complete`):

- tools: `tools/analyze_image.ts:180`, `tools/research_docs.ts:181`,
  `tools/web_search.ts:146`
- intuition: `intuition/pipeline.ts:77`, `intuition/pipeline.ts:292`
- auto-title: `title-gen.ts` (called from `agents/auto_title/loop.ts`
  and the supervisor's auto-title unit)

**Deferred callers** (still hold `VeniceClient.completeChat`):

- background-agent Web Workers: `agents/bias/`, `agents/samskara/`,
  `agents/summary/`, `agents/topics/`, `agents/memory_topics/`,
  `agents/recipe_topics/`, `agents/wiki/`, `agents/wiki-librarian/`,
  `agents/deep-sleep/`, `agents/rem/`, plus the recall family
  (`agents/recall/`, `agents/conversation_recall/`, `agents/wiki_recall/`)
- the headless tool-loop driver `tools/run.ts:292` (used by the recall
  family and the wiki librarian)

Why deferred: each worker bootstraps its own `VeniceClient` from a
`veniceApiKey` postMessage from the main thread; migrating means
reshaping the worker-message protocol to thread a `SupabaseService`
in instead, plus dropping `veniceApiKey` from every worker-start path.
Larger blast radius than this milestone could land cleanly. Tracked
as the next driver-B mover.

### `streamChat` (`/chat/completions` streaming)

TODO - the attractor, the live chat turn.

- `src/lib/chat-loop.ts:614` - the sole caller.

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
- **TODO** (call `completeChat`, some also called `embed` pre-milestone 3):
  `summary`, `reflection`, `topics`, `memory_topics`, `recipe_topics`, `bias`,
  `samskara`, `wiki`, `wiki-librarian`, `deep-sleep`, `rem`, `auto_title`.
- **Recall family** (`conversation_recall`, `wiki_recall`, `recall`): mostly
  live-turn priming, not background drains - audit per-worker before assuming a
  cron shape fits.

Not yet audited per-worker: each one's exact Venice usage, whether it is truly
background vs live-turn, and whether a cron cadence fits. That is the
"further audits along the way" work.

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
