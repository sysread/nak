/**
 * Unified logger for main-thread and Web Worker code paths.
 *
 * Two jobs, tied together because they surface the same dev-facing
 * surface area:
 *
 *   1. Mirror every call to the browser console so regular devtools
 *      still work - nothing here hides log output; we *add* a panel.
 *   2. Feed an in-app Logs drawer (left-side panel in `Chat.svelte`)
 *      backed by a capped ring buffer of structured entries. Main-
 *      thread call sites write directly into the buffer; worker call
 *      sites postMessage a serialized entry back up, and the worker
 *      managers (embeddings / summary / reflection / attachment-
 *      expiry) route those entries into the main-thread buffer via
 *      `appendFromWorker`.
 *
 * Why one module for both contexts: call sites (e.g. the three
 * `loop.ts` drivers under `src/lib/agents/` and `src/lib/embeddings/`)
 * run inside dedicated Web Workers in production and inside Node /
 * jsdom during unit tests. They can't know their host context up
 * front, and we don't want two parallel logger APIs they'd have to
 * pick between. A single `createLogger('source')` returns the same
 * shape regardless; the module's own IS_WORKER detection decides
 * whether to push into the local buffer or postMessage.
 *
 * Why capped: a misbehaving loop could spam logs indefinitely and
 * the drawer's scroll region would grow until the tab OOMs. MAX_ENTRIES
 * is a compromise - large enough to retain a useful history across a
 * long session, small enough that the reactive $state array stays
 * cheap to diff.
 *
 * Why pre-serialize worker details: Error instances don't survive
 * postMessage's structured clone (the class identity is lost and
 * stack becomes undefined). We flatten into a tagged-union that the
 * renderer can reconstitute - Error -> Error-like object with
 * name/message/stack preserved - so the drawer renders worker logs
 * indistinguishably from main-thread logs.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /** Monotonic, buffer-local. Used as the `{#each}` key so re-renders
   *  don't reshuffle DOM when entries at the head are dropped. */
  id: number;
  /** Capture time, ms since epoch. Local-time formatting happens in
   *  the renderer so the buffer stays timezone-agnostic. */
  timestamp: number;
  level: LogLevel;
  /** Subsystem tag like `update`, `reflection-worker`, `samskara`.
   *  Null only for callers that don't belong to a named subsystem. */
  source: string | null;
  message: string;
  /** Structured extras: the caller passed them as rest args, e.g.
   *  `log.warn('poll failed', err, { attempt: 2 })`. The renderer
   *  hides these behind an expand caret when non-empty. */
  details: unknown[];
}

export interface Logger {
  debug(message: string, ...details: unknown[]): void;
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

// Worker-to-main wire format. Explicit tagged union instead of raw
// `unknown` so the receiving side can reconstitute Error instances
// (which otherwise lose their stack through structured clone) and
// safely JSON-stringify the rest.
export type SerializableDetail =
  | { kind: 'string'; value: string }
  | { kind: 'json'; value: unknown }
  | { kind: 'error'; name: string; message: string; stack: string | null };

export interface SerializableLogEntry {
  timestamp: number;
  level: LogLevel;
  source: string | null;
  message: string;
  details: SerializableDetail[];
}

export interface WorkerLogMessage {
  type: 'nak-log';
  entry: SerializableLogEntry;
}

// Cap the buffer. 2000 entries is enough to cover a few hours of a
// chatty session (reflection + embedding workers together log maybe
// a few dozen entries per minute). Exceeding this drops from the head,
// which matches the mental model of a scroll-back console.
const MAX_ENTRIES = 2000;

// WorkerGlobalScope exists only inside dedicated/shared/service
// workers. jsdom (vitest) and the real main-thread browser context
// both lack it, so this check cleanly discriminates without a
// fragile `typeof window` inversion.
const IS_WORKER: boolean = (() => {
  try {
    const scope = (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope;
    return typeof scope === 'function' && self instanceof (scope as new () => unknown);
  } catch {
    return false;
  }
})();

interface LogsState {
  entries: LogEntry[];
}
interface DrawerState {
  open: boolean;
}

// The $state stores are created unconditionally. In a worker context
// they just sit unread - pushEntry is never called on the worker side
// (we postMessage instead). Cheaper than a runtime branch every time
// someone imports the module.
const state = $state<LogsState>({ entries: [] });
const drawerState = $state<DrawerState>({ open: false });

let nextId = 1;

function pushEntry(partial: Omit<LogEntry, 'id'>): void {
  const entry: LogEntry = { ...partial, id: nextId++ };
  state.entries.push(entry);
  if (state.entries.length > MAX_ENTRIES) {
    // Drop the oldest N rather than clearing the whole array - the
    // drawer's scroll position stays meaningful across a long burst.
    state.entries.splice(0, state.entries.length - MAX_ENTRIES);
  }
}

function toSerializableDetail(v: unknown): SerializableDetail {
  if (v instanceof Error) {
    return { kind: 'error', name: v.name, message: v.message, stack: v.stack ?? null };
  }
  if (typeof v === 'string') return { kind: 'string', value: v };
  try {
    // structuredClone validates the value *is* clone-safe. If it
    // throws (functions, DOM nodes, cyclic structures) fall back to
    // a string repr so the entry still carries something readable.
    return { kind: 'json', value: structuredClone(v) };
  } catch {
    return { kind: 'string', value: safeString(v) };
  }
}

function fromSerializableDetail(d: SerializableDetail): unknown {
  if (d.kind === 'string') return d.value;
  if (d.kind === 'json') return d.value;
  // Reconstruct an Error-like object. Not a real Error instance - the
  // renderer only reads name/message/stack, so a plain object matches
  // what we'd show for a main-thread Error too.
  const e = new Error(d.message);
  e.name = d.name;
  if (d.stack) e.stack = d.stack;
  return e;
}

function safeString(v: unknown): string {
  try {
    return String(v);
  } catch {
    return '[unserializable]';
  }
}

function writeConsole(
  level: LogLevel,
  source: string | null,
  message: string,
  details: unknown[]
): void {
  const prefix = source ? `[${source}]` : '';
  const args = prefix ? [prefix, message, ...details] : [message, ...details];
  const c = console;
  switch (level) {
    case 'debug':
      c.debug(...args);
      return;
    case 'info':
      c.log(...args);
      return;
    case 'warn':
      c.warn(...args);
      return;
    case 'error':
      c.error(...args);
      return;
  }
}

function emit(
  level: LogLevel,
  source: string | null,
  message: string,
  details: unknown[]
): void {
  writeConsole(level, source, message, details);
  const timestamp = Date.now();
  if (IS_WORKER) {
    const serialized: SerializableLogEntry = {
      timestamp,
      level,
      source,
      message,
      details: details.map(toSerializableDetail),
    };
    try {
      (self as DedicatedWorkerGlobalScope).postMessage({
        type: 'nak-log',
        entry: serialized,
      } satisfies WorkerLogMessage);
    } catch {
      // Best-effort: the console mirror above still carried the log,
      // so a failed postMessage (e.g. non-dedicated worker context)
      // doesn't lose the message entirely.
    }
    return;
  }
  pushEntry({ timestamp, level, source, message, details });
}

/**
 * Named logger for a subsystem. The `source` tag is the drawer's
 * grouping key; pick something short and stable. Existing prefixes
 * in the codebase (`update`, `reflection-worker`, `samskara`,
 * `recall-agent`, ...) are the convention - one source per file is
 * typical, but not a hard rule.
 */
export function createLogger(source: string): Logger {
  return {
    debug: (msg, ...rest) => emit('debug', source, msg, rest),
    info: (msg, ...rest) => emit('info', source, msg, rest),
    warn: (msg, ...rest) => emit('warn', source, msg, rest),
    error: (msg, ...rest) => emit('error', source, msg, rest),
  };
}

/** Fallback logger for callers without a natural subsystem tag. */
export const log: Logger = {
  debug: (msg, ...rest) => emit('debug', null, msg, rest),
  info: (msg, ...rest) => emit('info', null, msg, rest),
  warn: (msg, ...rest) => emit('warn', null, msg, rest),
  error: (msg, ...rest) => emit('error', null, msg, rest),
};

/**
 * Relay a worker-originated log entry into the main-thread buffer.
 * Called by each worker manager's `message` handler when it sees a
 * `{type:'nak-log'}` wire message. Does NOT re-emit to console -
 * the worker already logged there; mirroring again would double-
 * print.
 */
export function appendFromWorker(entry: SerializableLogEntry): void {
  pushEntry({
    timestamp: entry.timestamp,
    level: entry.level,
    source: entry.source,
    message: entry.message,
    details: entry.details.map(fromSerializableDetail),
  });
}

export function isWorkerLogMessage(data: unknown): data is WorkerLogMessage {
  if (!data || typeof data !== 'object') return false;
  return (data as { type?: unknown }).type === 'nak-log';
}

/**
 * Read-only view + clear operation on the log buffer. The drawer
 * reads `entries` reactively; `clear` is the "trash" button.
 */
export const logs = {
  get entries(): LogEntry[] {
    return state.entries;
  },
  clear(): void {
    state.entries = [];
    nextId = 1;
  },
};

/** Open/close singleton for the in-app Logs drawer. */
export const logsDrawer = {
  get state(): DrawerState {
    return drawerState;
  },
  open(): void {
    drawerState.open = true;
  },
  close(): void {
    drawerState.open = false;
  },
  toggle(): void {
    drawerState.open = !drawerState.open;
  },
};
