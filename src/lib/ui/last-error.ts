// Parse + project the threads.last_error jsonb column.
//
// The function-side writer (supabase/functions/_shared/error-translate.ts)
// packs `{kind, message, retryable, occurred_at}` into the column. The
// renderer reads it as `unknown` (jsonb passes through unparsed in the
// row coerce) and uses this module to validate the shape and project
// the prose fields the message-list card needs.
//
// Drift tolerance: a row predating the column reads as null, a row
// written by an older function build that omits a field reads through
// defaults, and a shape that's outright wrong reads as null (the card
// just doesn't render rather than crashing the screen). The kind set
// here mirrors `TranslatedErrorKind` from the function-side translator;
// stays in sync by virtue of being read off the same column.
//
// Interacts with: src/lib/supabase.ts (Thread.last_error column),
// src/screens/Chat.svelte (the error card rendering),
// supabase/functions/_shared/error-translate.ts (the writer).

export type LastErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'http'
  | 'network'
  | 'parse'
  | 'truncated'
  | 'internal'
  | 'round_limit'
  | 'wall_timeout'
  | 'tool_dispatch'
  | 'commit_conflict'
  | 'guard_exhausted';

export interface LastError {
  kind: LastErrorKind;
  message: string;
  retryable: boolean;
  /** ISO timestamp the function wrote when the error landed. */
  occurredAt: string | null;
}

const KNOWN_KINDS: ReadonlyArray<LastErrorKind> = [
  'auth',
  'rate_limit',
  'http',
  'network',
  'parse',
  'truncated',
  'internal',
  'round_limit',
  'wall_timeout',
  'tool_dispatch',
  'commit_conflict',
  'guard_exhausted',
];

function isKnownKind(value: unknown): value is LastErrorKind {
  return typeof value === 'string' && KNOWN_KINDS.includes(value as LastErrorKind);
}

/**
 * Parse a jsonb value into a LastError, or null if the value doesn't
 * carry an interpretable error envelope. Treats absent fields as
 * defaults rather than failing the parse so a partially-written column
 * (a code-bug on the writer side, a forward-compatible field reorder)
 * still renders something readable. The "kind" field is the only
 * required signal - without it we don't know what we're looking at.
 */
export function parseLastError(value: unknown): LastError | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (!isKnownKind(obj.kind)) return null;
  const message =
    typeof obj.message === 'string' && obj.message.length > 0
      ? obj.message
      : 'An error occurred.';
  // Default retryable=true for unknown shapes - a missing flag should
  // err on the side of letting the user try again. The writer always
  // sets it for known kinds, so the default only kicks in for shapes
  // outside the current schema.
  const retryable = obj.retryable !== false;
  const occurredAt =
    typeof obj.occurred_at === 'string' && obj.occurred_at.length > 0
      ? obj.occurred_at
      : null;
  return { kind: obj.kind, message, retryable, occurredAt };
}

/**
 * Map an error kind to a short heading the card uses above the prose.
 * Distinct from the prose itself so the visual scan reads "what kind
 * of problem" first, "what to do" second. Headings stay terse - the
 * full sentence lives in `message`.
 */
export function headingFor(kind: LastErrorKind): string {
  switch (kind) {
    case 'auth':
      return 'Venice API key rejected';
    case 'rate_limit':
      return 'Rate limited by Venice';
    case 'http':
      return 'Venice request failed';
    case 'network':
      return 'Network error';
    case 'parse':
      return "Couldn't read response";
    case 'truncated':
      return 'Response cut off';
    case 'internal':
      return 'Internal error';
    case 'round_limit':
      return 'Hit the round limit';
    case 'wall_timeout':
      return 'Timed out';
    case 'tool_dispatch':
      return 'Tool failed';
    case 'commit_conflict':
      return 'Commit conflict';
    case 'guard_exhausted':
      return 'Malformed response';
  }
}
