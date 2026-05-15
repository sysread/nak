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
  machine, worker model, data-layer conventions, Venice
  adapter. The one doc to read first.
- [Components](./components.md) — the reusable Svelte
  components screens compose.

### Core features

- [Auth & session](./auth-session.md) — Supabase auth,
  master-password envelope, session lifecycle, locking.
- [Chat](./chat.md) — chat screen + chat-loop + models +
  realtime thread list.
- [Attachments](./attachments.md) — per-message file
  attachments, Venice text-parser integration, and the
  expiration worker.
- [Tools](./tools.md) — tool registry + the two parallel
  executors (chat-side and headless-agent-side).
- [Memory](./memory.md) — `memories` store + reflection
  agent + memory recall.
- [Wiki](./wiki.md) — flat encyclopedic articles about
  the user, the autonomous wiki agent, the per-article
  manual update flow, the `wiki_*` tools, and the Wiki
  drawer tab.
- [Cookbook](./cookbook.md) — `recipes` store + Cooklang
  parser + the recipe_* tools + the Cookbook modal and
  drawer tab.
- [Conversation recall](./conversation-recall.md) — recall
  over thread summaries.
- [Context recall](./context-recall.md) — topic-boundary
  recall pipeline. Fires on the same triggers as intuition,
  fans out to the memory-recall and conversation-recall
  agents in parallel, stitches their notes into one
  `<think>`-tagged priming block.
- [Summaries](./summaries.md) — background thread-summary
  worker.
- [Auto-title](./auto-title.md) — background worker that fills
  in titles for threads still on the placeholder. Replaces the
  in-Chat fire-and-forget call site.
- [Embeddings](./embeddings.md) — the Web-Worker embedding
  pipeline plus the canonical cross-tab-lock + claim-RPC
  pattern.
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
- [Settings](./settings.md) — the settings modal +
  `profiles.settings` JSONB + theme.
- [Help](./help.md) — in-app rendering of `docs/user/`.
- [Logging](./logging.md) — the `createLogger` surface, the
  in-app log drawer, and the worker-to-main log relay.

### Build & deploy

- [Build & deploy](./build-deploy.md) — Vite, PWA,
  GitHub Pages, the sync-on-deploy schema workflow.

### Future work

- [Planned changes](./planned-changes.md) — deferred features
  that we tried and reverted (or scoped out and haven't
  started). Lessons learned and the "correct way" captured so
  the next attempt doesn't redo the dead-end investigation.

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
