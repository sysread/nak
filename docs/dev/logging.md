# Logging

The logger is the app's single entry point for diagnostic output.
Every subsystem calls into `createLogger('<source>')` and gets a
four-method surface (`debug` / `info` / `warn` / `error`) that both
writes to the browser console and feeds an in-app log drawer. No
call site in `src/` talks to `console.*` directly - the one
exception is `logger.svelte.ts` itself, which is allowlisted in
`eslint.config.js`.

## Role

Two jobs, one module:

1. **Mirror every log call to the browser console.** The logger
   never hides output. A user with devtools open sees the same
   stream they always have, with the same `console.log` /
   `console.warn` / `console.error` level mapping.
2. **Feed a capped in-app ring buffer.** The `logs` rune store
   exposes an `entries` array read by `LogsDrawer.svelte`. The
   drawer sits on the right edge of the Chat screen (same side
   as `ExtractedTextDrawer`; in practice only one of the two is
   open at a time, so simultaneous-stack layout is tolerated but
   not optimized for) and renders the buffer with level
   filtering, substring search, and a clear button.

## Files

- `src/lib/logger.svelte.ts` - the logger module. Holds the
  reactive buffer, the drawer open/close singleton, and the
  worker-to-main log relay.
- `src/components/LogsDrawer.svelte` - the left-side drawer.
  Reads `logs.entries` and `logsDrawer.state.open` reactively.
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
  level: 'debug' | 'info' | 'warn' | 'error';
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

1. Still write to the worker's own console.
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
  worker postMessage path swallows failures - the console mirror
  above it has already carried the log, so a failed post doesn't
  lose information.
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
