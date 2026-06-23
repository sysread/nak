# Edge functions

The Deno half of nak. Three functions today:

- **`venice/`** - the main chat-turn runtime. Owns the streaming
  round chain, tool dispatch, output guards, last_error writes,
  per-round image attachment, broadcast/realtime fan-out, the
  reconnect probe for orphan stream recovery, and embedding
  backfill (the `/embed-backfill` route). See
  `../docs/dev/in-progress/venice-edge-functions/` for the
  feature-level architecture notes.
- **`attachment-gc/`** - I/O-free orchestration for the daily
  attachment-bucket orphan GC sweep, kicked by `pg_cron`.
  Reclaims objects whose `message_attachments` row is gone (a
  deleted thread/message).
- **`recipe-image-gc/`** - I/O-free orchestration for the
  recipe-image GC sweep, kicked by `pg_cron`. Replaces the old
  AFTER DELETE orphan trigger; covered in
  `../docs/dev/in-progress/recipe-images-storage-migration.md`.

## When does work belong here vs in the browser?

The split between browser and edge function is **not** "who
writes the database" - both are first-class Supabase writers.
It's **who owns the lifecycle of the work that produces the
row**. The full frame plus the per-row writer-of-record
inventory lives in
[`../../docs/dev/architecture.md`](../../docs/dev/architecture.md)
under "Production-path ownership." Short version:

- **Browser owns** work that is "one user click → one DB write"
  and would just be retyped on a tab crash. Composer send,
  thread rename, recipe edit, settings change, manual upload.
- **Function owns** work that must outlive the tab. A streamed
  turn (30+ s; user might close the tab), the embedding
  backfill, image generation. This is the
  `EdgeRuntime.waitUntil` regime - the whole point of the
  streaming-root migration.
- **Background derivation the user toggles** (reflection, wiki,
  intuition, samskara, journaling, auto-title) is browser-side
  today. Long-term candidate for migration as the
  cron-plus-waitUntil pattern matures, but losing this work on
  tab close isn't a correctness problem - it just resumes next
  session.

The auto-title case is the test of the frame: the same
`threads.title` column has two writers, the auto-title worker
(browser) and a manual rename (browser today, but the function
would own it if auto-title moved server-side). Each writer is a
property of its **production path**, not the column. Two
writers on one column is fine when each owns a distinct path.

## Deno island, intentionally

The function tree under `supabase/functions/` is treated as a
separate toolchain from `src/lib/`. The browser is Node/Vite +
TypeScript via the Svelte plugin; this is Deno. Files don't
cross-import.

Concretely:

- Imports use explicit `.ts` extensions (Deno requirement).
- The model registry is duplicated in miniature. `stream-guards.ts`
  carries `LEAKY_MODEL_IDS` mirroring the browser's
  `leaksSpecialTokens` flag. `_shared/venice.ts` carries the
  embed wire-shape. The header comment on `_shared/venice.ts`
  documents this stance: *"Sharing the browser client is a
  consolidation-phase decision, not a step-5 one."*
- Drift management is manual. When a browser-side capability
  flag (`leaksSpecialTokens`, etc.) changes, the function-side
  mirror needs the same edit. Cite the browser source-of-truth
  in the comment so the next session knows where to look.

The consolidation move - extracting
`src/lib/models/wire-config.ts` as a pure types + capability
data + cascade functions module that both trees import - is
worth doing when the duplication grows past a handful of
flags. Not yet.

## Layout

```text
supabase/functions/
├── _shared/                   - cross-function utilities
│   ├── venice.ts              - embed + complete wire shape
│   ├── venice-stream.ts       - streaming event union + parser
│   ├── error-translate.ts     - VeniceError + dispatch errors -> last_error
│   ├── backfill.ts            - embedding backfill orchestration
│   ├── embed-input.ts         - per-source embed-text composition
│   ├── attachment-gc.ts       - attachment-bucket orphan GC orchestration
│   └── recipe-image-gc.ts     - recipe image GC orchestration
├── venice/
│   ├── index.ts               - HTTP routing (/stream, /embed, /complete, /usage, etc.)
│   ├── getStreamingResponse.ts - round loop + persistence + control channel
│   ├── getStreamingCompletion.ts - Venice SSE consumer + normalizer
│   ├── performToolCall.ts     - single tool dispatch (Deno port of browser dispatchTools)
│   ├── broadcast.ts           - adaptive 4-tier buffering with 429 backoff
│   ├── stream-guards.ts       - special-token-leak guard + retry temperature schedule
│   ├── tools/                 - one file per ported tool
│   └── agents/                - one file per ported recall agent + headless tool loop
├── attachment-gc/
│   └── index.ts               - cron-driven entry point
└── recipe-image-gc/
    └── index.ts               - cron-driven entry point
```

## Testing

```sh
mise run test                  # vitest run includes function-side tests under tests/
```

The function-side tests use a fake fetch (no network, no Venice
calls) and exercise the round loop, tool dispatch, error
translation, and broadcast buffering in isolation. Pure
orchestration logic (`backfill.ts`, `attachment-gc.ts`,
`recipe-image-gc.ts`) is I/O-injected for the same reason -
runs under vitest, no Deno-only mocks needed.

## Deploy

```sh
mise run sync                  # applies schema.sql + deploys functions
```

The CI deploy job in `.github/workflows/deploy.yml` runs the
same `node scripts/sync.mjs` on every merge to main. See the
"Supabase schema changes" section of the top-level
`../../CLAUDE.md` for the schema-side conventions.
