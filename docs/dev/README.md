# Nak — Developer Notes

Architecture, conventions, and per-feature deep-dives for
people working on Nak itself. End-user documentation lives
next door in [`../user/`](../user/README.md).

These docs are GitHub-rendered only — they are not bundled
into the app and don't appear in the in-app Help modal.
The in-app manual covers user-facing behavior; this tree
covers the implementation.
Adding dev docs in-app would be a new feature, not a
packaging tweak.

## How this is organized

Two overview docs frame the codebase, followed by one doc per
coherent feature.
Each feature doc follows a common pattern — Role, Files,
Entry points, Data model, Contracts, Interactions, Gotchas —
but the exact headings may vary slightly by feature.
The goal is consistency, not rigidity.

The "Interactions" section is meant to fight rot: when two
features drift apart it's usually because the coupling was
tacit.
Feature docs list the other features they actually touch,
with the specific coupling named.
Treat this as a best-effort ledger to cross-check before
changing a contract that other features depend on.

## Contents

### Overview

- [Architecture](./architecture.md) — boot flow, phase state
  machine, background-job model, data-layer conventions, Venice
  adapter. The one doc to read first.
- [Frontend organization](./frontend-organization.md) — how
  UI logic splits between pure primitives in `src/lib/ui/`
  and Svelte composition in `src/components/`. Read before
  adding or refactoring anything under either directory.
- [Components](./components.md) — the reusable Svelte
  components screens compose.
- [File storage](./file-storage.md) — how user file bytes are
  stored: private Storage buckets, signed-URL reads,
  `storage_path` pointers, and the server-side expiry / GC
  sweeps. Read before touching attachments, the Library, or
  cookbook photos.

### Core features

- [Auth & session](./auth-session.md) — Supabase auth, the
  plaintext local config, and session lifecycle.
- [Chat](./chat.md) — chat screen + chat-loop + models +
  realtime thread list.
- [Exchange](./exchange.md) — per-thread streaming state
  (`ExchangeSlot` / `ExchangeStore`) and the cross-device
  "this device is producing the response" claim
  (`ThreadClaimCoordinator` + the `threads.response_holder_id`
  / `response_claim_expires_at` columns).
- [Attachments](./attachments.md) — per-message file
  attachments, Venice text-parser integration, and the
  expiration worker.
- [Tools](./tools.md) — the browser-side toolbox catalog +
  the edge-side dispatch (chat tools and agent loops).
- [MCP integrations](./mcp-integrations.md) — remote MCP
  server connections: OAuth discovery + DCR + PKCE, per-user
  token storage, dynamic toolbox popup, edge-side dispatch,
  daily catalog refresh sweep, and the Settings Integrations
  pane.
- [Memory](./memory.md) — `memories` store + reflection
  agent + memory recall.
- [Wiki](./wiki.md) — flat encyclopedic articles about
  the user, the autonomous wiki agent, the per-article
  manual update flow, the `wiki_*` tools, and the Wiki
  drawer tab.
- [Conversation digest](./conversation-digest.md) — the daily
  per-user recap of a day's conversations: the timezone day-gated
  claim RPC, the hourly digest sweep agent, the
  `conversation_digests` table, and the Daily digest panel on the
  Chats tab.
- [Cookbook](./cookbook.md) — `recipes` store + Cooklang
  parser + the recipe_* tools + the Cookbook modal and
  drawer tab.
- [Grocery list](./grocery-list.md) — the `grocery_items` /
  `grocery_sections` store, the Groceries drawer tab (all-items
  browse sidebar + section-card shopping panel), the
  ingredient-checkbox bridge from recipes, the recipe-edit
  invalidation trigger, sticky section prefs, shopping trips with
  the In-cart section, and the item-photo bucket plus its GC
  sweep.
- [Library](./library.md) — persistent uploaded documents:
  the `documents` + `document_chunks` tables, the Storage
  bucket for originals, browser-side extraction + chunking,
  the chunk-level embedding search, the `doc_*` tools, and
  the Library drawer tab + panel.
- [Offline cache](./offline-cache.md) — the per-device IndexedDB
  mirror of favorited articles and favorited/upcoming recipes, the
  reconcile + read-through that keeps it fresh without evicting on a
  network blip, and the offline indicator. Read before touching the
  wiki/recipe read paths or the connectivity UI.
- [Conversation recall](./conversation-recall.md) — recall
  over thread summaries.
- [Context recall](./context-recall.md) — topic-boundary
  recall pipeline. Fires on the same triggers as intuition,
  fans out to the memory-recall and conversation-recall
  agents in parallel, stitches their notes into one
  `<think>`-tagged priming block.
- [Follow-ups](./followups.md) — pending questions the model
  saves for itself ("ask how the lasagna turned out") so later
  conversations treat unknown outcomes as unknown; surfaces
  semantically and date-due through the context-recall gather,
  captured and resolved by the chat model + reflection.
- [Summaries](./summaries.md) - server-side thread-summary
  curation unit.
- [Topics](./topics.md) - server-side tagging units (threads,
  memories, recipes) plus the drawer's topic-filter dropdown.
- [Auto-title](./auto-title.md) - server-side curation unit
  that fills in titles for threads still on the placeholder.
- [Embeddings](./embeddings.md) — the server-side embed
  backfill (pg_cron + the venice function) plus the canonical
  claim-RPC pattern.
- [Samskara](./samskara.md) — the chat model's progressively-
  built predictive model of the user. Substrate compounds into
  samskaras compounds into a prose summary that lives
  always-on in the system prompt; mints surface as a subtle
  bottom-right mood pill.
- [Intuition](./intuition.md) — the subconscious layer. A
  perception agent + five drives + a synthesis agent that
  produces a `<think>`-tagged internal monologue, injected
  ahead of the next completion. Cached per-thread; refreshed
  on title changes, mood-band shifts, and a staleness fuse.
- [Second thoughts](./second-thoughts.md) — the post-game
  metacognitive twin of intuition. A fast non-reasoning reviewer
  runs in the completed-turn tail, re-reads the answer over a
  narrow turn slice, and writes a per-message doubt verdict;
  a doubt surfaces a panel + a user-triggered refinement that
  appends a reconsidered answer. Deferred: automatic correction.
- [Bias profile](./bias-profile.md) — silent server-side pipeline
  (hourly cron sweep in the venice function) that analyzes past
  conversations for cognitive biases and
  System-1 heuristics, aggregates evidence via a Bayesian
  Beta-Binomial posterior with recency decay, and injects
  compensation guidance for the strongest-evidence biases into
  the main chat LLM's system prompt.
- [Diagnostic pills](./diagnostic-pills.md) — the shared
  bottom-right glance column (recall / intuition / bias /
  samskara mood / intents) and its mobile drop-up twin. One
  registry + one component drive both surfaces; read before
  adding a pill or touching either layout.
- [Prompt augmentation](./prompt-augmentation.md) — the
  cross-feature contract for everything that shapes one chat
  turn: the injection order of the bias appendix + the
  context-recall / samskara / intuition `<think>` chain + the
  per-turn metadata block, plus freshness, failure degradation,
  and observability rules. The spec `chat/loop.ts` implements.
- [Settings](./settings.md) — the settings modal +
  `profiles.settings` JSONB + theme.
- [Help](./help.md) — in-app rendering of `docs/user/`.
- [Logging](./logging.md) — the `createLogger` surface, the
  in-app log drawer, and the edge-to-main log relay.
- [Edge function auth](./edge-function-auth.md) — the b-strict
  service-role client model for the venice edge function, and
  why streaming turns can't rely on the user's session JWT.

### Build & deploy

- [Build & deploy](./build-deploy.md) — Vite, PWA,
  GitHub Pages, the sync-on-deploy schema workflow.
- [Local dev stack](./local-stack.md) — a throwaway local
  Supabase backend (`mise run dev-start`) isolated from the
  linked cloud project, for schema work without touching prod.

### Future work

- [Planned changes](./planned-changes.md) — deferred features
  that we tried and reverted (or scoped out and haven't
  started). Lessons learned and the "correct way" captured so
  the next attempt doesn't redo the dead-end investigation.
- [Plans](./plans/) — historical planning docs for shipped
  features (samskara tiering, association minting, decay,
  observability). Kept for the design rationale; the
  implementation may have diverged since.

## Writing conventions

- **Column-wrap prose around 65 chars**, breaking at
  sentence or phrase boundaries where possible so
  individual lines carry meaning on their own.
  Keeps diffs tight and matches the comment voice in
  `src/lib/*.ts`.
  Avoid collapsing several sentences onto a single
  long line — the readability loss isn't worth the
  saved bytes.
- **Internal links prefixed with `./` or `../`.** Repo-wide
  convention enforced by `CLAUDE.md`'s "User-facing
  documentation" section. In the dev tree the enforcement
  is by eyeballs only, but keep it consistent.
- **File paths point at real files.** Never copy code
  bodies into a doc — the file moves, the doc rots. Name
  the path, name the function or column, trust the reader
  to open the file.
- **"Gotchas" sections are the load-bearing part.** They
  surface the non-obvious constraints that comments
  protect. If you delete a comment in a file, check
  whether the corresponding Gotcha here needs updating
  too.

## When to update these docs

- A schema change (anything in `supabase/schema.sql`) → the
  affected feature doc's Data model section.
- A new tool, agent, or worker → the relevant feature doc's
  Files + Entry points + Interactions sections.
  Add a link from `architecture.md` if it introduces a new
  subsystem pattern.
  Maintainer policy; no code enforces it.
- A new Svelte component under `src/components/` → a new
  section in `components.md`.
- A feature that starts calling into another feature for
  the first time → both docs' Interactions sections.

Dev docs should move in the same PR as the code change. A
commit that adds a subsystem without updating `docs/dev/`
is incomplete in the same way a user-visible change
without a `docs/user/` update is incomplete.
