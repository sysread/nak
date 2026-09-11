# Browser Companion Extension Plan

Status: PROPOSED - not started. This is the research-and-design
record; nothing here is implemented. When it ships, graduate the
end-state into a permanent feature doc and delete this file per
the CLAUDE.md "in-progress/ is for open work only" rule.

Read [`../architecture.md`](../architecture.md) first; this plan
assumes its production-path ownership vocabulary, the streaming
contract in [`../chat.md`](../chat.md), and the config-export
mechanics in [`../auth-session.md`](../auth-session.md).

## SYNOPSIS

A Manifest V3 browser extension that lets the user interact with
nak chat from the context of any web page: snapshot the
JS-rendered DOM, hand page text or files to a nak thread, and let
the existing server-side turn machinery do the rest. Distributed
load-unpacked as a per-user zip with the nak config baked in; no
app store.

## PURPOSE

Server-side fetch sees an empty shell on every modern page -
content is rendered by JS in the user's browser, and only the
browser has it. Nak has no component that lives there. The failure
is concrete: the 2026-09-08 recipe-URL test showed Venice web
search returns links and snippets only, never page content, so a
recipe URL pasted into chat gets nothing useful. The planned
extension is the missing scrape surface.

Target uses: summarize web pages, evaluate Amazon listings, and
import recipes into the cookbook from recipe sites that require
JavaScript to render (which is all of them).

The user is the only real user (a second user - their daughter -
is a soft goal), so installation friction is a non-issue and the
Chrome Web Store's review overhead is explicitly rejected. The
user already installs Chrome Web Store extensions from Opera, so
Opera compatibility is required and Chrome-family is the whole
target; Firefox is out of scope.

## DESCRIPTION

### How nak behaves today

- The browser is already a thin trigger. A chat turn is: insert
  the user message row, POST to the `venice/stream` edge route,
  then subscribe to the thread's Realtime Broadcast channel - or
  poll the thread row until terminal. The edge function drives
  every round, every tool dispatch, and all persistence under
  `EdgeRuntime.waitUntil`; a vanished subscriber loses nothing
  (see [`../chat.md`](../chat.md)).
- Every chat tool is schema-only browser-side; real
  implementations run in the edge function. A client that ships
  the schemas gets `recipe_save`, `doc_save`, and friends for
  free, with zero tool logic on the client.
- Config lives in a two-field plaintext blob (`nak:config:v2`:
  Supabase URL + publishable key) with an existing
  `kind: "nak-config", version: 2` export/import format designed
  for moving credentials between clients.
- The Web Share Target path (`src/lib/share-intake.ts`) is the
  closest existing analog: OS-level share -> append to composer.
  It is append-to-composer semantics, not a chat client.
- File text extraction already exists client-side:
  `SupabaseService.extractText` multipart-POSTs to the
  `venice/text-parser` edge route, which relays to Venice's
  extraction endpoint and returns the text layer.

### What the extension is

Three surfaces, one extension:

1. **Content script** - capture. Injected via the `activeTab`
   permission plus a context menu, so no "read all sites"
   install warning. Runs Readability.js over
   `document.documentElement.innerHTML` for the readable text
   layer; raw selection as the spot-check alternative. Content
   scripts see the fully rendered DOM, JS-mangled or not - this
   is the entire point of the feature.
2. **Background service worker** - owns auth (supabase-js with a
   chrome.storage adapter) and the API client. Does the
   trigger-and-poll turn sequence. No tool logic, no turn
   machinery: it inserts the user message and invokes
   `venice/stream`, exactly like the PWA does.
3. **Side panel** (Chrome Side Panel API; Opera inherits it as
   Chromium) - the live chat view. Lightweight for v0: trigger
   the turn, poll the thread row to terminal, render the final
   reply. Streaming display can come later since the server owns
   the whole turn.

The extension holds zero new server surface: no routes, no
schema, no new writers-of-record. It is a second client of the
same contract. Page text and file extractions ride the same
paths the PWA already uses - inline into the user message below
the share path's size threshold, the attachment pipeline
(Storage upload + row) above it.

### Config baked into the zip

The load-unpacked zip is customized at download time by the
deployed app, client-side: a page on the PWA fetches the
extension zip artifact, replaces a single `nak-config.json`
entry inside it with the user's live config (JSZip - pure
client-side, no server), and offers the patched zip for
download. Two payoffs:

- Setup is "install, click Connect, done" - the extension reads
  its baked `nak-config.json` on first run. A paste fallback
  (the existing export/import blob) covers a config that later
  changes.
- `manifest.json` can be patched with `host_permissions` for the
  user's actual Supabase origin at download time. The origin is
  known per-deployment and is not a secret. This deletes the
  `optional_host_permissions` runtime-permission dance entirely;
  the trade is that a config change means a new zip and an
  extension reload, which is acceptable for a one-user tool.

Non-customized zips (placeholder config) are never published;
the deployed instance is the only distribution point, so every
zip it produces can be config-correct.

### Repository placement: same repo

The extension's entire backend already lives here; a companion
repo would duplicate the stream request shape, the channel name
convention, and the config format, and drift the moment any of
them move. Same-repo also makes the contract tests real rather
than aspirational.

Concretely:

- Add `pnpm-workspace.yaml` with `packages/*`. The PWA stays the
  root package; the extension becomes `packages/extension` with
  its own `manifest.json` and a plain Vite multi-entry build
  (background + content script + panel). Not crxjs - plain Vite
  keeps the build boring.
- Shared contract code is mirrored with contract tests rather
  than forced into an importable shared package. The stream
  request body and the config blob shape are pinned by a vitest
  contract test that imports both sides and asserts the shapes
  agree, so a contract change on either side fails the gate.
  `buildChatBody` (wire-body builder) is the one candidate
  worth extracting for real if it turns out to be
  dependency-free; otherwise mirror it.
- The gate (`mise run check`) gains an extension build + lint
  task. The Deno island is untouched.
- This reorganization is the feature's own change, so it does
  not trip the "no restructuring in unrelated PRs" rule.

### Milestones

- **M0 - scaffolding + distribution.** pnpm workspace,
  `packages/extension` with a minimal manifest and a zip build,
  and the deployed-instance download page with client-side
  config baking. After M0 you can install an empty extension
  from the deployed app.
- **M1 - capture + handoff.** Context menu on a page ->
  Readability extraction -> seed a nak thread with the text.
  Reuses share-intake semantics; no chat UI in the extension.
  This alone covers summarization and "send this page to nak."
- **M2 - side panel chat.** Full trigger-and-poll client in the
  side panel: sign-in state, thread picker, send, terminal-reply
  render. Amazon listing evaluation and recipe import become
  one-surface flows: snapshot -> "import this recipe" -> the
  model calls `recipe_save` server-side.
- **M3 - files.** File picker / drag-drop into the panel;
  multipart to `venice/text-parser` for the text layer (PDFs,
  docx); attachment pipeline for size overflow. Content scripts
  cannot see inside Chrome's PDF viewer (it is a plugin page),
  so files flow as file objects, not DOM snapshots.

M1 alone is a usable product; M2 is the real chat experience.

## Gotchas and risks

- **MV3 service worker lifecycle.** SWs die when idle; the
  stream watcher must live in the side panel page (an open port
  keeps everything alive), never only in the SW. The
  poll-the-row fallback exists in the PWA for exactly this
  shape - copy it, do not reinvent Realtime-in-a-SW.
- **Prompt injection is the real security surface.** Page
  content is untrusted text going into an agent that holds
  `recipe_save`, `doc_save`, `memory_*`. Nak already accepts
  this posture for attachments; state it in the plan and leave
  it deliberate. The extension holds the user's session token,
  so the extension itself is trusted-side - which is also why
  capture stays `activeTab`-scoped.
- **Manifest changes need a reload.** Baked `host_permissions`
  land at install; changing the origin later means a fresh zip.
  Acceptable - the origin basically never changes.
- **Multi-user is free.** The daughter signs in with her own
  account on the same hosted project; RLS splits the data. The
  zip is baked for the deployment, not the user, so one zip
  serves both.
- **docs/user/ must move in the same PR** as any user-visible
  behavior (install page, extension UX), per repo rule. Same
  for a `docs/qa/use-cases/` walkthrough.

## Where it ends up

Permanent feature doc (extension.md in `docs/dev/`) gets written
at graduation; this plan is the design narrative.
