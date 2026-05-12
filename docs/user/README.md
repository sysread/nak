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
  they're stored, which tiers can see what, and the 30-day
  expiration policy.
- [Threads](./threads.md) — the conversation drawer, pinning,
  archiving, renaming, deleting.
- [Memory](./memory.md) — the long-term store Nak builds up about you
  across conversations: what gets remembered, how to correct or
  forget something, what's scoped to your account.
- [Wiki](./wiki.md) — a flat encyclopedia about you: titled articles
  about projects, people, places, and topics, maintained by both you
  and a background agent. The assistant reaches them through the
  always-on `wiki_search` tool.
- [Intuition](./intuition.md) — the subconscious read Nak forms of
  each conversation: how the brain icon next to the mood emoji works,
  and what the inline cards mean.
- [Journal](./journal.md) — a daily diary Nak keeps for you
  alongside your conversations, plus space for your own entries.
- [Cookbook](./cookbook.md) — a personal store for Cooklang recipes,
  with a dedicated modal and a tab in the conversation drawer.
- [Search](./search.md) — finding a thread, recipe, journal day, or
  wiki article by meaning across your history.
- [Keyboard shortcuts](./shortcuts.md) — the keys that save you the
  most time.

### Configuration

- [Settings overview](./settings.md) — tour of the Settings modal and
  what each pane controls.
- [Models & reasoning](./models.md) — picking a model tier, reasoning
  effort, and the web-search toggle.
- [Appearance](./appearance.md) — color modes and accent colors.

### Data & security

- [Security model](./security.md) — how your API keys are encrypted,
  what the master password protects, and how locking the session
  works.
- [Export & import](./export-import.md) — moving your keys to another
  browser.

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
