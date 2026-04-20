# Nak — Developer Notes

Architecture, conventions, and subsystem deep-dives for people working
on Nak itself. End-user documentation lives in
[`../user/`](../user/README.md).

This directory is scaffolded — the content will grow alongside the
codebase. The repo-root `CLAUDE.md` is the current source of truth for
conventions; as topics get too large to live there, they'll migrate
into their own files here.

## Planned sections

- **Architecture** — the Vite + Svelte 5 app shell, the Supabase data
  layer, the Venice streaming adapter.
- **Storage** — schema, RLS, the `settings` blob on `profiles`, and
  the idempotency rules schema files must follow.
- **Encryption** — how API keys are encrypted at rest and why the
  current primitive choice.
- **Markdown rendering** — the `marked` → `DOMPurify` → `{@html}`
  pipeline and the highlight.js dynamic-loading dance.
- **Build & deploy** — Vite config, PWA config, the Cloudflare Pages
  target, and the `sync-supabase` deploy job.
- **Conventions** — commenting style, testing stance, separation-of-
  concerns dogma. Currently lives in `CLAUDE.md` at the repo root.

## Until the sections exist

Read `CLAUDE.md` at the repo root. It's the working convention doc.
