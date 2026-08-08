/**
 * Application logger feeding the browser console and the in-app Logs
 * drawer.
 *
 * Two jobs, tied together because they surface the same dev-facing
 * surface area:
 *
 *   1. Mirror `info` / `warn` / `error` calls to the browser console
 *      so regular devtools still work for the actionable tiers.
 *      `trace` and `debug` are intentionally NOT mirrored - they go
 *      only to the in-app drawer, because high-volume breadcrumbs on
 *      those tiers were swamping the browser console even with the
 *      Verbose filter off.
 *   2. Feed an in-app Logs drawer (left-side panel in `Chat.svelte`)
 *      backed by a capped ring buffer of structured entries. Local
 *      call sites write directly into the buffer; server-side
 *      background work (the venice function's agent fleets) arrives
 *      through `appendFromEdge` via the user's `logs:<id>` Broadcast
 *      channel - the edge logger emits the identical
 *      SerializableLogEntry wire shape.
 *
 * Why capped: a misbehaving loop could spam logs indefinitely and
 * the drawer's scroll region would grow until the tab OOMs. MAX_ENTRIES
 * is a compromise - large enough to retain a useful history across a
 * long session, small enough that the reactive $state array stays
 * cheap to diff.
 *
 * Why the tagged-union detail shape: Error instances don't survive
 * JSON serialization (the class identity is lost and stack becomes
 * undefined), and edge entries ride a Broadcast channel as JSON. The
 * union lets the renderer reconstitute an Error-like object with
 * name/message/stack preserved, so server-side logs render
 * indistinguishably from local ones.
 */

import { untrack } from 'svelte';
import type {
  LogLevel,
  SerializableDetail,
  SerializableLogEntry,
} from '$shared/log-wire';

export type { LogLevel, SerializableDetail, SerializableLogEntry };

/** Runtime predicate. Used when coercing persisted settings jsonb that
 *  carries a caller-supplied `defaultLogLevel` - any other shape falls
 *  back to the hard-coded default in state.svelte.ts. */
export function isLogLevel(v: unknown): v is LogLevel {
  return (
    v === 'trace' ||
    v === 'debug' ||
    v === 'info' ||
    v === 'warn' ||
    v === 'error'
  );
}

/** Ordered tier list, most permissive first. Exported so UI dropdowns
 *  and the Appearance pane stay in sync with the type definition
 *  without duplicating the literal order. `trace` sits below `debug`
 *  for per-cycle worker breadcrumbs that are too noisy to keep on at
 *  the default tier; users opt into seeing them. */
export const LOG_LEVELS: readonly LogLevel[] = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
] as const;

/** Display labels. The `+` suffix on the lower tiers makes the
 *  cascading-minimum semantics obvious: selecting `Info+` shows info,
 *  warn, and error. `Error` has no `+` because there's nothing above
 *  it to include. */
export const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  trace: 'Trace+',
  debug: 'Debug+',
  info: 'Info+',
  warn: 'Warn+',
  error: 'Error',
};

/** Default for a fresh profile. `'info'` keeps the drawer focused on
 *  one-shot lifecycle events worth seeing without prompting; routine
 *  per-load and per-cycle breadcrumbs sit at `debug` / `trace` and
 *  surface when the user drops the filter from the Appearance pane. */
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

export interface LogEntry {
  /** Monotonic, buffer-local. Used as the `{#each}` key so re-renders
   *  don't reshuffle DOM when entries at the head are dropped. */
  id: number;
  /** Capture time, ms since epoch. Local-time formatting happens in
   *  the renderer so the buffer stays timezone-agnostic. */
  timestamp: number;
  level: LogLevel;
  /** Subsystem tag like `update`, `chat-loop`, `bias`.
   *  Null only for callers that don't belong to a named subsystem.
   *
   *  Level guidance for new call sites: `trace` for per-cycle worker
   *  breadcrumbs that have no diagnostic value when the worker is
   *  doing routine "no work to do" rotations - they're available with
   *  one dropdown step but stay out of the default view. `debug` for
   *  decisions worth keeping visible whenever the drawer is at its
   *  default tier. `info` for one-shot lifecycle events worth seeing
   *  even at quieter tiers. */
  source: string | null;
  message: string;
  /** Structured extras: the caller passed them as rest args, e.g.
   *  `log.warn('poll failed', err, { attempt: 2 })`. The renderer
   *  hides these behind an expand caret when non-empty. */
  details: unknown[];
}

export interface Logger {
  trace(message: string, ...details: unknown[]): void;
  debug(message: string, ...details: unknown[]): void;
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

// Drawer wire format, shared with the edge logger via
// _shared/log-wire.ts. Explicit tagged union instead of raw
// `unknown` so the receiving side can reconstitute Error
// instances (which otherwise lose their stack through JSON
// serialization) and safely stringify the rest.

// Cap the buffer. 2000 entries is enough to cover a few hours of a
// chatty session (the edge fleets' relayed logs plus local breadcrumbs
// run maybe a few dozen entries per minute). Exceeding this drops from
// the head, which matches the mental model of a scroll-back console.
const MAX_ENTRIES = 2000;

// Vitest sets `process.env.VITEST='true'` for every runner subprocess.
// The console mirror (info/warn/error) in `writeConsole` exists so
// devtools-driven debugging works in production; under vitest it just
// bloats test output (~hundreds of "[samskara] fire embed failed..."
// lines per run from production error-handling paths the tests
// deliberately exercise). The in-memory ring buffer continues to
// receive entries regardless, so any test that wants to assert on a
// log can read `logs.entries` - none do today, but the buffer
// remains live.
const IS_TEST: boolean = (() => {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env;
    return env?.VITEST === 'true';
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

const state = $state<LogsState>({ entries: [] });
const drawerState = $state<DrawerState>({ open: false });

let nextId = 1;

function pushEntry(partial: Omit<LogEntry, 'id'>): void {
  const entry: LogEntry = { ...partial, id: nextId++ };
  // Logging must be inert with respect to the reactive graph. A log
  // call can land synchronously inside an $effect body - the
  // offline-cache session-live effect logs on mount, for one - and the
  // push below both reads state.entries.length and writes the array. If
  // that read is captured while an effect is the active reaction, the
  // effect ends up depending on the log buffer it just wrote, re-runs,
  // logs again, and trips effect_update_depth_exceeded - a main-thread
  // hang that also starves the gotrue auth lock and realtime connect.
  // untrack severs the dependency capture: the write still notifies the
  // Logs drawer's own readers (visible / availableSources / scroll
  // pin), but no ambient effect gets subscribed to the buffer.
  untrack(() => {
    state.entries.push(entry);
    if (state.entries.length > MAX_ENTRIES) {
      // Drop the oldest N rather than clearing the whole array - the
      // drawer's scroll position stays meaningful across a long burst.
      state.entries.splice(0, state.entries.length - MAX_ENTRIES);
    }
  });
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

function writeConsole(
  level: LogLevel,
  source: string | null,
  message: string,
  details: unknown[]
): void {
  // Under vitest, skip the console mirror so the logs production code
  // emits during error-path tests don't pile up in the gate's stdout.
  // Tests that need to assert on log output can read `logs.entries`
  // from the ring buffer, which still receives entries.
  if (IS_TEST) return;
  // `trace` and `debug` are drawer-only on purpose. The per-cycle
  // worker breadcrumbs that ride those tiers were drowning the
  // browser console even with Verbose off; the in-app drawer has
  // proper level filtering and search, so devtools doesn't need
  // to carry them too.
  if (level === 'trace' || level === 'debug') return;
  const prefix = source ? `[${source}]` : '';
  const args = prefix ? [prefix, message, ...details] : [message, ...details];
  const c = console;
  switch (level) {
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
  pushEntry({ timestamp: Date.now(), level, source, message, details });
}

/**
 * Named logger for a subsystem. The `source` tag is the drawer's
 * grouping key; pick something short and stable. Existing prefixes
 * in the codebase (`update`, `chat-loop`, `bias`, ...) are the
 * convention - one source per file is typical, but not a hard rule.
 * Edge-side sources arrive through `appendFromEdge` and share the
 * same namespace, so a server agent and its browser-side helpers can
 * deliberately group under one tag (the bias pipeline does).
 */
export function createLogger(source: string): Logger {
  return {
    trace: (msg, ...rest) => emit('trace', source, msg, rest),
    debug: (msg, ...rest) => emit('debug', source, msg, rest),
    info: (msg, ...rest) => emit('info', source, msg, rest),
    warn: (msg, ...rest) => emit('warn', source, msg, rest),
    error: (msg, ...rest) => emit('error', source, msg, rest),
  };
}

// Shared ingress for remotely-originated entries (Web Worker postMessage
// or edge-function Broadcast). Both arrive pre-serialized; reconstitute
// the details and push into the same ring buffer. No console mirror -
// the origin already logged to its own console, and re-emitting would
// double-print.
function appendSerialized(entry: SerializableLogEntry): void {
  pushEntry({
    timestamp: entry.timestamp,
    level: entry.level,
    source: entry.source,
    message: entry.message,
    details: entry.details.map(fromSerializableDetail),
  });
}

/**
 * Relay an edge-function-originated log entry into the buffer. Called by
 * the `SupabaseService.subscribeToUserLogs` handler when a `nak-log`
 * Broadcast event arrives on the user's `logs:<id>` channel. The edge
 * logger (supabase/functions/_shared/edge-log.ts) emits the identical
 * SerializableLogEntry shape, so server-side background work (reflection,
 * and the other agent fleets as they migrate off the browser) renders in
 * the drawer indistinguishably from worker logs.
 */
export function appendFromEdge(entry: SerializableLogEntry): void {
  appendSerialized(entry);
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
