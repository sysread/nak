# Logging

The logger is the app's single entry point for diagnostic output.
Every subsystem calls into `createLogger('<source>')` and gets a
five-method surface (`trace` / `debug` / `info` / `warn` / `error`)
that feeds an in-app log drawer and, for the actionable tiers,
also writes to the browser console. `trace` and `debug` are
drawer-only - they don't mirror to the console at all, because
the per-cycle worker breadcrumbs that ride those tiers were
drowning devtools even with Verbose off. `info` / `warn` /
`error` still mirror through `console.log` / `console.warn` /
`console.error`. No call site in `src/` talks to `console.*`
directly - the one exception is `logger.svelte.ts` itself, which
is allowlisted in `eslint.config.js`.

## Level guidance

- `trace` - per-cycle worker breadcrumbs that fire whether or not
  the worker found work to do. The samskara worker's phase rotation
  produces several of these per cycle; embeddings/reflection/summary
  workers add their own. They sit below `debug` and the drawer
  filters them out at the default tier.
- `debug` - decisions worth keeping visible whenever the drawer is
  at its default tier. Phase actually claimed a row, agent returned a
  result, save was rejected.
- `info` - one-shot lifecycle events worth seeing at a quieter tier:
  worker startup, a new samskara minted, a compound summary saved.
- `warn` / `error` - actionable problems. Routed through
  `console.warn` / `console.error`.

Console mirroring: only `info` / `warn` / `error` reach the
browser console. `trace` and `debug` are drawer-only, so the
actionable tiers stay legible in devtools while the noisy
per-cycle breadcrumbs are still searchable in the in-app drawer.

## Role

Two jobs, one module:

1. **Mirror the actionable tiers to the browser console.** A user
   with devtools open sees `info` on `console.log`, `warn` on
   `console.warn`, and `error` on `console.error`. `trace` and
   `debug` skip the console mirror entirely and live only in the
   in-app drawer, where level filtering and search keep the
   high-volume worker breadcrumbs usable.
2. **Feed a capped in-app ring buffer.** The `logs` rune store
   exposes an `entries` array read by `LogsDrawer.svelte`. The
   drawer sits on the right edge of the Chat screen (same side
   as `ExtractedTextDrawer`; in practice only one of the two is
   open at a time, so simultaneous-stack layout is tolerated but
   not optimized for) and renders the buffer with level
   filtering, source-tag filtering, substring search, and a
   clear button. The source-tag dropdown is built dynamically
   from the tags present in the buffer (sorted, deduped), so it
   stays in sync with whatever subsystems have actually emitted -
   no separate registration step when adding a new `createLogger`
   call site.

## Files

- `src/lib/logger.svelte.ts` - the logger module. Holds the
  reactive buffer, the drawer open/close singleton, and the
  worker-to-main log relay.
- `src/components/LogsDrawer.svelte` - the right-side drawer.
  Reads `logs.entries` and `logsDrawer.state.open` reactively.
  Composition only: the filter runes, the three `$effect`s
  (re-seed filters on open, Escape listener, scroll-pin tail),
  the clipboard orchestration, and the markup. Every decision
  the panel makes is delegated to the primitives module next
  door.
- `src/lib/ui/logs-drawer.ts` - pure UI-behavior primitives.
  `entryMatches(entry, filter)` + `splitNeedles(search)` for
  the filter predicate; `availableSources(entries)` for the
  source-tag dropdown; the `hasStructuredDetails` /
  `inlineStringDetails` / `structuredDetails` partition over
  detail arrays; `formatStructured` and `normalizeDetail` for
  the structured-render and clone-safe-snapshot paths;
  `highlightSegments(text, needles)` for the multi-needle
  range-merge highlight algorithm; `formatTimestamp`,
  `nearBottom`, `emptyMessage`, and `buildLogSnapshot` for the
  rest. Unit-tested directly at `tests/logs-drawer.test.ts`
  with plain vitest (50 cases, no mount, no harness).
- `src/screens/Chat.svelte` - mounts `<LogsDrawer />` and owns
  the scroll-icon button in the top bar that toggles it.

## Entry points

```ts
import { createLogger } from '$lib/logger.svelte';

const log = createLogger('reflection-worker');

log.info('picked up thread', threadId);
log.warn('poll failed', err);
log.debug('payload', { foo, bar });
```

Pick a short, stable source tag. Existing tags:

- `update` - service-worker update lifecycle
- `reflection-worker`, `summary-worker`, `embed-worker`,
  `attachment-expiry-worker`, `samskara-worker` - background
  loop drivers
- `recall-agent`, `conversation-recall-agent` - tool executors
- `samskara` - chat-loop-side samskara helpers
- `chat` - main screen one-offs (e.g. attachment persist failures)

Rest arguments after the message string are "details". The drawer
renders string details inline as a second line under the message;
Error instances, objects, and arrays get an expand caret that shows
a pretty-printed stack or JSON body.

## Data model

```ts
interface LogEntry {
  id: number;              // monotonic, buffer-local
  timestamp: number;       // Date.now()
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  source: string | null;   // from createLogger(source)
  message: string;
  details: unknown[];      // rest args, with Error/JSON preserved
}
```

The buffer is capped at `MAX_ENTRIES` (2000). When exceeded, the
oldest entries are dropped from the head so the drawer's scroll
position stays meaningful across bursts.

## Worker-to-main relay

Three of the five background workers (embeddings, reflection,
summary, attachment-expiry, samskara) import the logger from their
loop drivers. Worker-context calls detect `WorkerGlobalScope` at
module init and:

1. Mirror the actionable tiers (`info` / `warn` / `error`) to
   the worker's own console. `trace` and `debug` skip this step,
   matching the main-thread policy.
2. Serialize the entry (Error -> `{name, message, stack}`,
   non-clone-safe values -> string repr) and `postMessage` it to
   the main thread as `{ type: 'nak-log', entry }`.

Each worker manager's `message` handler checks for
`isWorkerLogMessage(evt.data)` and calls `appendFromWorker(entry)`
to land the entry in the main-thread buffer. The entry keeps its
original source tag, so a `reflection-worker` breadcrumb shows up
in the drawer indistinguishable from a main-thread `reflection-
worker` entry.

Each manager also keeps a small legacy path for the
`{type: 'log', level, message}` wire format the worker entry files
still use directly (e.g. the `setSession failed` message emitted
before the loop can import the logger). Those go through a local
`createLogger('<worker-name>')` in the manager so they land in the
drawer too.

## Contracts

- **No direct `console.*` in `src/`.** Enforced by the default
  `no-console` ESLint rule; overridden only for
  `src/lib/logger.svelte.ts`.
- **Logger writes are synchronous and fire-and-forget.** The
  worker postMessage path swallows failures. For info/warn/error
  the console mirror above it has already carried the log, so a
  failed post doesn't lose information; for trace/debug the entry
  is dropped, since those tiers are drawer-only and have no
  console fallback.
- **The ring buffer is capped.** Code that spins in a tight error
  loop can't OOM the tab through logging.
- **`logs.clear()` is destructive.** Bound to the drawer's Clear
  button. Nothing else should call it.

## Interactions

- **Chat** - mounts `<LogsDrawer />` and owns the top-bar toggle
  button. See `docs/dev/chat.md`.
- **Build & deploy** - the service-worker update lifecycle
  (`src/lib/update.svelte.ts`) is the noisiest main-thread source;
  the `update` source tag is load-bearing for debugging
  spurious-banner and reload-hang reports. See
  `docs/dev/build-deploy.md`.
- **Embeddings**, **Memory**, **Summaries**, **Attachments**,
  **Samskara** - each worker emits progress breadcrumbs through
  the logger from its loop driver. See the respective feature
  docs for which cycle transitions log what.

## Gotchas

- **`.svelte.ts` suffix is required.** The module uses `$state`
  runes for the buffer and the drawer open/close singleton; the
  Svelte transformer only runs on files matching `*.svelte` or
  `*.svelte.ts`.
- **Worker-context detection uses `WorkerGlobalScope`.** jsdom
  (vitest) does not define it, so tests that import the logger
  always land on the main-thread path. If you add a test-time
  worker harness, you'll need to stub the detection.
- **Error instances don't survive postMessage.** The worker
  serializer flattens them into `{name, message, stack}` and the
  main-thread deserializer reconstructs a plain Error-like object.
  The drawer's renderer reads `.stack` off whatever it gets, so
  the two paths are indistinguishable to the UI - but a downstream
  consumer that wanted a real `Error` instance would need to
  reconstruct it.
