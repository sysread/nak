# Nak — User Guide

This is the end-user manual for Nak, a bring-your-own-infrastructure AI
chat PWA. It covers what you can do from the chat interface, how to set
the app up on your own Supabase + Venice accounts, and how to keep your
data yours.

Developer-facing material (architecture, build tooling, conventions)
lives next door in [`../dev/`](../dev/README.md).

## How this is organized

Pages are grouped by what you're trying to do. Each page is self-
contained — start at whichever topic matches your question. Most pages
link out to related pages where the topics overlap.

You can reach these pages two ways:

- From inside the app — click the **Help** button in the conversation
  drawer footer (the leftmost icon). The index you're reading now is
  the landing page.
- On GitHub — browse the `docs/user/` tree directly.

## Contents

### Getting started

- [Getting started](./getting-started.md) — sign up, add your Supabase
  and Venice keys, pick a default model, send your first message.

### Using Nak

- [The chat interface](./chat.md) — composer, streaming, thinking mode,
  regeneration, copy/edit/delete.
- [Attachments](./attachments.md) — attach files to a message; how
  they're stored, which tiers can see what, on-upload image
  compression, and managing files from the Artifacts tab.
- [Threads](./threads.md) — the conversation drawer, pinning,
  archiving, renaming, deleting.
- [Memory](./memory.md) — the long-term store Nak builds up about you
  across conversations: what gets remembered, how to correct or
  forget something, what's scoped to your account.
- [Wiki](./wiki.md) — a flat encyclopedia about you: titled articles
  about projects, people, places, and topics, maintained by both you
  and a background agent. The assistant reaches them through the
  always-on `wiki_search` tool.
- [Library](./library.md) — upload documents (contracts, insurance
  policies, tax docs) to keep as permanent, searchable reference
  material. The assistant can search inside them to answer your
  questions, and they never expire the way chat attachments do.
- [Intuition](./intuition.md) — the subconscious read Nak forms of
  each conversation: how the brain icon next to the mood emoji works,
  and what the inline cards mean.
- [Bias profile](./bias-profile.md) — the chart icon in the
  bottom-right pill column. Nak watches your past conversations
  for cognitive biases and quietly nudges its responses to
  compensate; this page covers what's tracked, where the math sits,
  and how to inspect what it has on you.
- [Cookbook](./cookbook.md) — a personal store for Cooklang recipes,
  with a dedicated modal and a tab in the conversation drawer.
- [Samskara](./samskara.md) — the instincts Nak forms about you as you
  chat: the read-only Samskara tab (browse the whole corpus, tier-1 and
  tier-2 compounds, plus a pipeline-health readout), the per-conversation
  mood pill, and the per-message "what fired this turn" dropdown.
- [Search](./search.md) — finding a thread, recipe, or wiki article
  by meaning across your history.
- [Keyboard shortcuts](./shortcuts.md) — the keys that save you the
  most time.

### Configuration

- [Settings overview](./settings.md) — tour of the Settings modal and
  what each pane controls.
- [Models & reasoning](./models.md) — picking a model tier, reasoning
  effort, and the web-search toggle.
- [Appearance](./appearance.md) — color modes and accent colors.

### Data & security

- [Security model](./security.md) — what's stored where, what RLS
  protects, and why the publishable key is safe to ship.
- [Export & import](./export-import.md) — moving your Supabase URL
  and publishable key to another browser.

### Under the hood

- [What runs in the background](./background.md) — auto-titling,
  thread summaries, embeddings, and the web-search toggle. What's
  running on your behalf between messages, and what you can
  control. ([Memory](./memory.md) covers reflection and recall
  separately.)

### Installing as an app

- [Install as a PWA](./install-pwa.md) — getting Nak onto your home
  screen, taskbar, or dock, and what works offline.

## When docs and reality disagree

If something in the app doesn't match what these pages say, the app is
the source of truth — the docs are stale. File it so the mismatch gets
fixed (see the project's top-level `README.md` for where to report).
