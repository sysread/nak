// Edge-side structured logger that mirrors browser background work into
// the in-app Logs drawer.
//
// Background agents that run in the browser (the supervised worker
// fleet) reach the drawer by postMessage'ing serialized log entries up
// to the main thread (src/lib/logger.svelte.ts appendFromWorker). Once
// an agent moves into this edge function it loses that pipe - its
// console.log lands only in Supabase's function logs. createEdgeLogger
// restores the drawer as the single observability surface: every entry
// is BOTH console-logged (function logs stay complete) AND published to
// the user's private 'logs:<user-uuid>' Realtime Broadcast topic, which
// the browser subscribes to and feeds into the same ring buffer
// (appendFromEdge). Auth is the realtime.messages "log channel: owner
// subscribe" policy in supabase/schema.sql; the topic name carries the
// owner id so a user only ever sees their own logs.
//
// Delivery: each emit fires a fire-and-forget POST to the Realtime
// broadcast HTTP endpoint and records the in-flight promise. Callers
// running under EdgeRuntime.waitUntil MUST `await logger.flush()` before
// the function settles - otherwise the runtime can tear down the last
// few un-awaited POSTs (typically the outcome line, the one most worth
// seeing). The console mirror means a dropped broadcast still survives
// in the function logs, so flush() is about drawer fidelity, not data
// safety.

// Wire shape shared with the browser. MUST stay structurally identical
// to SerializableLogEntry / SerializableDetail in
// src/lib/logger.svelte.ts - the browser reconstitutes this payload
// (fromSerializableDetail) without a runtime schema check, so a drift
// here surfaces as a silently mis-rendered drawer entry, not an error.
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

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

export interface EdgeLogger {
  trace(message: string, ...details: unknown[]): void;
  debug(message: string, ...details: unknown[]): void;
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
  /**
   * Await every broadcast POST started so far. Call once at the end of a
   * waitUntil tail so the runtime doesn't drop in-flight sends. Safe to
   * call repeatedly; resolves immediately when nothing is pending.
   */
  flush(): Promise<void>;
}

export interface CreateEdgeLoggerOpts {
  /** Override the broadcast transport. Tests inject a fake fetch. */
  fetchImpl?: typeof fetch;
  /** Override the project URL (defaults to SUPABASE_URL). */
  supabaseUrl?: string;
  /** Override the service key (defaults to SUPABASE_SERVICE_ROLE_KEY). */
  serviceKey?: string;
  /** Wall clock; overridable so tests get deterministic timestamps. */
  now?: () => number;
}

function toSerializableDetail(v: unknown): SerializableDetail {
  if (v instanceof Error) {
    return { kind: 'error', name: v.name, message: v.message, stack: v.stack ?? null };
  }
  if (typeof v === 'string') return { kind: 'string', value: v };
  try {
    // Round-trip through JSON to drop anything not clone-safe (functions,
    // cycles); fall back to a string repr so the entry still carries
    // something readable rather than failing the whole send.
    return { kind: 'json', value: JSON.parse(JSON.stringify(v)) };
  } catch {
    return { kind: 'string', value: safeString(v) };
  }
}

function safeString(v: unknown): string {
  try {
    return String(v);
  } catch {
    return '[unserializable]';
  }
}

function writeConsole(entry: SerializableLogEntry): void {
  const prefix = entry.source ? `[${entry.source}]` : '';
  const args = prefix ? [prefix, entry.message] : [entry.message];
  switch (entry.level) {
    case 'trace':
    case 'debug':
      console.debug(...args);
      return;
    case 'info':
      console.log(...args);
      return;
    case 'warn':
      console.warn(...args);
      return;
    case 'error':
      console.error(...args);
      return;
  }
}

/**
 * Build a logger bound to one user + subsystem. `source` is the drawer's
 * grouping tag (e.g. 'reflection'), matching the browser createLogger
 * convention. Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from the
 * environment unless overridden; when either is absent (e.g. unit tests
 * with no Supabase env) the broadcast is skipped and only the console
 * mirror runs.
 */
export function createEdgeLogger(
  userId: string,
  source: string,
  opts: CreateEdgeLoggerOpts = {},
): EdgeLogger {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const url = opts.supabaseUrl ?? Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey =
    opts.serviceKey ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const now = opts.now ?? (() => Date.now());
  const endpoint = url ? `${url}/realtime/v1/api/broadcast` : '';
  const topic = `logs:${userId}`;

  const pending: Promise<void>[] = [];

  function broadcast(entry: SerializableLogEntry): void {
    // No env -> drawer publish is a no-op (console mirror already ran).
    if (!endpoint || !serviceKey) return;
    const p = fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        messages: [
          { topic, event: 'nak-log', payload: entry, private: true },
        ],
      }),
    })
      .then(() => undefined)
      // Best-effort: a failed broadcast still survives in the console
      // mirror. Swallow so a logging hiccup never propagates into the
      // agent's own control flow.
      .catch(() => undefined);
    pending.push(p);
  }

  function emit(level: LogLevel, message: string, details: unknown[]): void {
    const entry: SerializableLogEntry = {
      timestamp: now(),
      level,
      source,
      message,
      details: details.map(toSerializableDetail),
    };
    writeConsole(entry);
    broadcast(entry);
  }

  return {
    trace: (msg, ...rest) => emit('trace', msg, rest),
    debug: (msg, ...rest) => emit('debug', msg, rest),
    info: (msg, ...rest) => emit('info', msg, rest),
    warn: (msg, ...rest) => emit('warn', msg, rest),
    error: (msg, ...rest) => emit('error', msg, rest),
    async flush() {
      // Snapshot + clear so a flush during active logging doesn't spin.
      const inflight = pending.splice(0, pending.length);
      await Promise.allSettled(inflight);
    },
  };
}
