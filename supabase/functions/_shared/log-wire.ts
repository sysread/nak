/**
 * Logger wire types shared between the browser
 * (src/lib/logger.svelte.ts) and the edge logger
 * (supabase/functions/_shared/edge-log.ts).
 *
 * These define the shape that travels over the Realtime Broadcast
 * channel from edge to browser. Both sides reconstitute entries
 * from this shape (the browser via appendFromEdge /
 * fromSerializableDetail) without a runtime schema check, so a
 * drift surfaces as a silently mis-rendered drawer entry.
 *
 * Centralizing the types here closes the "MUST stay structurally
 * identical" comment that lived in edge-log.ts with no parity test
 * to enforce it.
 *
 * LogLevel helpers (isLogLevel, LOG_LEVELS, LOG_LEVEL_LABELS,
 * DEFAULT_LOG_LEVEL) stay in the browser's logger.svelte.ts -
 * they are UI-only and the edge does not need them.
 */

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
