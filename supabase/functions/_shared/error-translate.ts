// User-facing translation for chat-turn failures.
//
// One canonical mapping from "the system threw or routed an error" to
// "the user-facing string we put in front of them," shared between the
// Deno streaming function (which writes the result onto threads.last_error)
// and the browser (which uses the same helper for transient errors that
// never reach the function - JWT expiry mid-stream, channel drop). The
// browser imports via the $shared alias (see vite.config.ts); the
// function imports as a normal relative path.
//
// The output shape mirrors the threads.last_error column:
//   { kind, message, retryable }
// - `kind` is the structured cause for UI branching (retry vs not, what
//   icon, where to link to fix). Mirrors VeniceErrorKind for the
//   wire-level cases plus four synthetic kinds for cases that don't
//   originate from a Venice fetch: 'round_limit', 'wall_timeout',
//   'tool_dispatch', 'commit_conflict'.
// - `message` is the prose we render in the error card. ASCII only, no
//   model jargon, calibrated to what an end user can act on. Falls back
//   to the raw upstream message capped at 280 chars when we don't
//   recognize the source - better to show something than nothing.
// - `retryable` is the UI hint for whether the error card carries a
//   Retry button. Auth and internal errors are not retryable (the user
//   action is "fix the key" or "file a bug"); transient errors are.
//
// When adjusting messages, lean toward "what does the user do next?"
// over "what technically happened." The kind field carries the
// technical signal for code branching; the message is for humans.

/**
 * VeniceErrorKind plus the synthetic kinds the orchestrator produces
 * server-side. Strings (not a TS enum) so the column shape stays
 * portable across runtimes and forward-compatible with future kinds
 * added without a schema change.
 */
export type TranslatedErrorKind =
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
  | 'commit_conflict';

/**
 * What the translation produces. Mirrors the columns the function will
 * pack into threads.last_error JSON.
 */
export interface TranslatedError {
  kind: TranslatedErrorKind;
  message: string;
  retryable: boolean;
}

/**
 * Inputs the helper consumes. All fields are optional so callers from
 * very different stack positions (a thrown VeniceError, a synthetic
 * round-limit terminal, a browser-side network catch) can build the
 * input from whatever they have.
 */
export interface TranslateInput {
  /** Required - the source bucket. Drives the message lookup. */
  kind: TranslatedErrorKind;
  /** HTTP status from Venice when applicable. Used to refine the 'http'
   *  message (5xx vs other 4xx) and is included verbatim in the prose. */
  status?: number;
  /** Venice rate-limit hint from Retry-After / x-ratelimit-reset-*.
   *  When present and positive, the rate_limit message names the wait. */
  retryAfterMs?: number | null;
  /** Tool name for kind='tool_dispatch'. Folded into the message verbatim. */
  toolName?: string;
  /** commit_assistant_message reason for kind='commit_conflict'
   *  ('newer_user_message', 'anchor_missing', 'row_not_streaming',
   *  'ownership_mismatch'). Drives the prose. */
  conflictReason?: string;
  /** Upstream error message, used as fallback when we don't recognize
   *  the kind and want to surface SOMETHING. Capped at 280 chars. */
  rawMessage?: string;
}

const RAW_FALLBACK_CAP = 280;

function cap(s: string): string {
  if (s.length <= RAW_FALLBACK_CAP) return s;
  return s.slice(0, RAW_FALLBACK_CAP - 1) + '…';
}

/**
 * Cheap, predictable, no side-effects. Same input -> same output every
 * time so the function-side write and a hypothetical replay land on
 * identical column content.
 */
export function translateError(input: TranslateInput): TranslatedError {
  switch (input.kind) {
    case 'auth':
      return {
        kind: 'auth',
        message:
          'Venice rejected the API key. Update it in Settings and try again.',
        retryable: false,
      };
    case 'rate_limit': {
      const waitMs = input.retryAfterMs ?? null;
      const waitSeconds = waitMs && waitMs > 0 ? Math.ceil(waitMs / 1000) : null;
      const message = waitSeconds
        ? `Venice is rate-limiting requests. Try again in ${waitSeconds} second${waitSeconds === 1 ? '' : 's'}.`
        : 'Venice is rate-limiting requests. Wait a moment and try again.';
      return { kind: 'rate_limit', message, retryable: true };
    }
    case 'http': {
      const status = input.status;
      if (status && status >= 500) {
        return {
          kind: 'http',
          message: `Venice returned a server error (HTTP ${status}). Try again in a moment.`,
          retryable: true,
        };
      }
      if (status) {
        return {
          kind: 'http',
          message: `Venice rejected the request (HTTP ${status}). ${cap(input.rawMessage ?? 'Try again.')}`,
          retryable: status === 408 || status === 425 || status === 429,
        };
      }
      return {
        kind: 'http',
        message: cap(input.rawMessage ?? 'Venice returned an unexpected response. Try again.'),
        retryable: true,
      };
    }
    case 'network':
      return {
        kind: 'network',
        message: "Couldn't reach Venice. Check your connection and try again.",
        retryable: true,
      };
    case 'parse':
      return {
        kind: 'parse',
        message:
          "Couldn't read Venice's response. The stream may have been corrupted; try again.",
        retryable: true,
      };
    case 'truncated':
      return {
        kind: 'truncated',
        message:
          'Venice cut the response off mid-stream. Automatic retry did not recover it. Try again.',
        retryable: true,
      };
    case 'internal':
      return {
        kind: 'internal',
        message: `Internal error in the streaming function. ${cap(input.rawMessage ?? 'Try again, or file an issue if it persists.')}`,
        retryable: false,
      };
    case 'round_limit':
      return {
        kind: 'round_limit',
        message:
          'The model kept calling tools and never produced a final response (round limit hit). Try a more focused question.',
        retryable: true,
      };
    case 'wall_timeout':
      return {
        kind: 'wall_timeout',
        message:
          'The response took too long and was aborted by the function wall timeout. Try again, or break the request into smaller steps.',
        retryable: true,
      };
    case 'tool_dispatch': {
      const tool = input.toolName ?? 'unknown';
      const reason = input.rawMessage ? cap(input.rawMessage) : 'no detail.';
      return {
        kind: 'tool_dispatch',
        message: `Tool '${tool}' failed: ${reason}`,
        retryable: true,
      };
    }
    case 'commit_conflict': {
      const reason = input.conflictReason ?? 'unknown';
      // Reasons come from commit_assistant_message in schema.sql.
      switch (reason) {
        case 'newer_user_message':
          return {
            kind: 'commit_conflict',
            message:
              'A newer message landed before this response could finish. The reply was discarded so the newest message is the live one.',
            retryable: false,
          };
        case 'anchor_missing':
          return {
            kind: 'commit_conflict',
            message:
              'The original user message vanished while this reply was streaming (probably deleted). Reply discarded.',
            retryable: false,
          };
        case 'ownership_mismatch':
        case 'row_not_streaming':
          return {
            kind: 'commit_conflict',
            message:
              'A bookkeeping race aborted this reply. Try again.',
            retryable: true,
          };
        default:
          return {
            kind: 'commit_conflict',
            message: `Reply could not be committed (${reason}). Try again.`,
            retryable: true,
          };
      }
    }
  }
}

/**
 * Pack the translated payload plus the function-side wall clock into
 * the JSON shape `threads.last_error` carries. The browser keys the
 * error card off this column, so the JSON object the function UPDATES
 * must match what the browser code reads via `currentThread.last_error`.
 *
 * `occurredAt` is the function's now() at the point of error, not the
 * row's updated_at - the column update bumps updated_at independently
 * for sidebar ordering. Keeping the error timestamp inside the payload
 * lets the browser show "10 minutes ago" without needing a second
 * column or a join.
 */
export interface LastErrorPayload extends TranslatedError {
  occurred_at: string;
}

export function packLastError(
  err: TranslatedError,
  occurredAtIso: string,
): LastErrorPayload {
  return { ...err, occurred_at: occurredAtIso };
}
