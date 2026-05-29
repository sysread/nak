# Migration inventory

A living checklist of everything that must eventually move into (or behind) an
edge function, so nothing is forgotten between milestones. The *why* and the
architecture live in the [README](./README.md) - the strategic spine and the
two drivers (minimize-recovery and single-source-of-truth for the Venice key).
This file is the concrete punch list: call sites, workers, and processes, with
status.

**Iteratively audited - not exhaustive or final.** Each milestone re-audits and
updates this. Last full audit: **2026-05-29**, after the Library feature landed,
against `src/lib/venice.ts` callers (`grep`) and the `src/lib/agents/` worker
fleet. Line numbers drift; re-grep before relying on one.

Status key:

- **DONE** - runs server-side / through the function.
- **PARTIAL** - some of the surface moved, some hasn't.
- **TODO** - still browser-direct.
- **N/A-recovery** - interactive (no minimize-recovery need), but still a
  driver-B item while it holds the Venice key.

## Venice endpoints (the primitives the function wraps)

| Endpoint | `VeniceClient` method | Status |
| --- | --- | --- |
| `POST /embeddings` | `embed` | PARTIAL - backfill DONE (cron, server-side); query-time embeds TODO |
| `POST /chat/completions` | `completeChat`, `streamChat` | TODO - the hard one; streaming is the attractor |
| `GET /billing/usage` | (was `fetchUsage`, now `SupabaseService.fetchUsage`) | DONE - milestone 2, `/usage` route |
| `POST /augment/text-parser` | `extractText` | TODO |
| `POST /image/generate` | `generateImage` | TODO - no sub-plan yet |

The README's endpoint list historically said "five" but enumerated four -
**image generation was the missing fifth**. It has a live browser caller (the
`generate_image` tool) and uses the browser's local Venice key, so it is a real
driver-B item even though it is the least-used endpoint.

## Venice call sites (browser) - callers to route through the function

Driver B needs every one of these to call the function instead of Venice
directly (so the key leaves the client). `file:line` from the 2026-05-29 audit.

### `embed` (`/embeddings`)

Corpus side is DONE server-side via the cron backfill (memories, threads,
recipes, wiki, samskara-substrate, document-chunks - the six `EMBED_SOURCES`).
These are the remaining query-time / live embeds, all still browser-direct:

- `src/components/RecipeList.svelte:88` - recipe search needle (N/A-recovery)
- `src/lib/wiki.ts:113` - wiki search needle (N/A-recovery)
- `src/lib/memories.ts:168` - memory search needle (N/A-recovery)
- `src/lib/documents.ts:195` - doc search needle (N/A-recovery) [Library]
- `src/lib/tools/conversation_search.ts:79` - conversation_search tool (mid-turn)
- `src/lib/context-recall/gather.ts:247` - opening-turn recall priming (live critical path)
- `src/lib/samskara/index.ts:128` - samskara embed (audit: live vs background)
- `src/screens/Chat.svelte:5226` - chat-side embed (audit which path)
- `src/lib/agents/deep-sleep/loop.ts:79` - deep-sleep worker embed (background)
- `src/lib/agents/samskara/loop.ts:495` - samskara worker embed (background)

### `completeChat` / `streamChat` (`/chat/completions`)

Non-streaming (`completeChat`) - the leaf that tools, workers, and the intuition
pipeline call:

- workers: `bias/agent.ts:67`, `memory_topics/agent.ts:183`,
  `recipe_topics/agent.ts:185`, `samskara/agent.ts:108`, `summary/agent.ts:199`,
  `topics/agent.ts:252`, `wiki/agent.ts:568`
- intuition: `intuition/pipeline.ts:77`, `intuition/pipeline.ts:292`
- auto-title: `title-gen.ts:87`
- tools: `tools/analyze_image.ts:192`, `tools/research_docs.ts:181`,
  `tools/run.ts:292`, `tools/web_search.ts:146`

Streaming (`streamChat`) - the attractor, the live chat turn:

- `src/lib/chat-loop.ts:614`

### `extractText` (`/augment/text-parser`)

- `src/lib/documents.ts:159` - Library ingestion (`ingestDocument`)
- `src/screens/Chat.svelte:1264` - attachments flow

### `generateImage` (`/image/generate`)

- `src/lib/tools/generate_image.ts:93` - the `generate_image` tool

## Background workers (driver A: relocate the loop + cron)

Each runs as a browser Web Worker today (see `src/lib/agents/`). Surviving a
closed tab means moving its claim -> process -> save loop server-side and onto a
schedule - the pattern milestone 1 established for the embeddings backfill.
Wrapping the Venice endpoint each one calls is necessary but not sufficient; the
orchestration has to move too.

- **embeddings backfill** - DONE (milestone 1).
- **TODO** (call `completeChat`, some also `embed`): `summary`, `reflection`,
  `topics`, `memory_topics`, `recipe_topics`, `bias`, `samskara`, `wiki`,
  `wiki-librarian`, `deep-sleep`, `rem`, `attachment_expiry`, `auto_title`.
- **Recall family** (`conversation_recall`, `wiki_recall`, `recall`): mostly
  live-turn priming, not background drains - audit per-worker before assuming a
  cron shape fits.

Not yet audited per-worker: each one's exact Venice usage, whether it is truly
background vs live-turn, and whether a cron cadence fits. That is the
"further audits along the way" work.

## Multi-step processes

- **Document ingestion** (`ingestDocument`, `src/lib/documents.ts`): create row
  -> upload binary to Storage -> `extractText` -> chunk -> insert chunks. A
  browser orchestration that calls the text-parser endpoint; a candidate to move
  server-side so a long-PDF upload survives the page being backgrounded. The
  chunk *embeddings* already ride the cron backfill (`document-chunks` source).

## The attractor

The streaming chat turn running entirely in an edge function - reading Venice,
persisting the assistant message itself, the client reconciling on return - is
the end state for driver A. It is the root of the call tree; every leaf above
climbs toward it. Design lives in [chat-completions.md](./chat-completions.md);
the open fork (how the client collects the stream) is recorded there.
