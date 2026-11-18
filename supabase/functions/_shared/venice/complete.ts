// Venice /chat/completions relay (non-streaming): the retrying
// veniceComplete proxy plus its strict-validation strip-and-retry
// machinery. The barrel _shared/venice.ts re-exports everything.
import { DEFAULT_BASE_URL, parseVeniceRetryAfterMs, VeniceError } from './shared.ts';

export interface VeniceCompleteOptions {
  apiKey: string;
  /**
   * Venice wire-shape body the browser already built via the exported
   * buildChatBody helper in src/lib/venice.ts. The function does not
   * inspect or reshape it - thin proxy. Keeping the shaping browser-side
   * sidesteps the wire-shape duplication the chat-completions design doc
   * flagged.
   */
  body: Record<string, unknown>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * Backoff delays (ms) BETWEEN retry attempts for transient upstream
   * failures; length is the number of retries. Defaults to
   * COMPLETE_RETRY_SCHEDULE_MS. Pass `[]` to disable retries (the unit
   * tests that assert single-attempt error mapping do this so they stay
   * fast and exercise the classifier directly).
   */
  retrySchedule?: number[];
  /**
   * Opt-in: also retry a 429 (rate_limit), honoring Venice's Retry-After
   * window (capped, see RATE_LIMIT_WAIT_CAP_MS). Off by default so the
   * browser-proxied non-streaming route and the mid-turn tool calls keep
   * their current give-up-on-429 behavior. The server-side background
   * agents (auto-title and the rest of the curation family) set this:
   * they have no browser rate-limit loop behind them, so without it a
   * single "model overloaded" 429 fails the whole sub-call.
   */
  retryRateLimit?: boolean;
  /**
   * Aborts the in-flight fetch and any pending backoff sleep. Optional -
   * the route handler does not wire one today (the backoff is bounded),
   * but tool sub-completions and tests can cancel.
   */
  signal?: AbortSignal;
}

// Transient-failure retry schedule for the non-streaming completion.
// Venice's /chat/completions intermittently returns a 5xx (capacity)
// or drops the connection; a single hiccup otherwise fails the whole
// non-streaming call, which silently kills whatever background feature
// issued it (auto-title, intuition, context recall, web_search, the
// summary/topics/bias agents, ...). These are the same transient
// classes the streaming path already retries server-side
// (withRateLimitRetry in getStreamingCompletion); the non-streaming
// path lost its retry loop in the move onto the edge function. 429 is
// retried only when the caller opts in via retryRateLimit (the
// server-side curation/background agents do; the browser-proxied route
// and mid-turn tools do not, because the browser's
// SupabaseService.complete owns their rate-limit loop and honors
// Retry-After). Deterministic (no jitter) on purpose - the retries hit
// Venice's infra, not ours, and the per-turn caller count is small, so
// there's no thundering herd against our own service to spread out.
const COMPLETE_RETRY_SCHEDULE_MS = [500, 1500, 4000];

// Ceiling on how long a single 429 backoff will wait, even if Venice's
// Retry-After asks for longer. Keeps a sustained-overload 429 from
// parking a background sub-call past the function's waitUntil budget;
// the agents' claim-release-and-retry-next-tick path is the backstop
// for overload that outlasts this.
const RATE_LIMIT_WAIT_CAP_MS = 5000;

// --- Strict-validation wire fields ----------------------------------------
//
// Optional wire knobs that can be dropped from a request body when a
// model's backend rejects them with strict validation. Venice serves
// one model id from several upstream backends, and some of them (GLM
// 5.x was the first observed) run strict pydantic validation on the
// forwarded body and 400 the whole request with "Extra inputs are not
// permitted, field: 'X'" for fields other backends silently ignore.
// Which backend answers can change request to request, so a model that
// accepted a knob a minute ago can reject it now. Only advisory knobs
// belong in this set - losing one changes response style or thinking
// depth at worst, never correctness. Fields that change semantics
// (`tools`, `messages`, `response_format`) must never be silently
// dropped.
// Consumers: the streaming wrapper (venice/getStreamingCompletion.ts)
// and veniceComplete below strip-and-retry on a matching 400; the
// orchestrator's preemptive strip of fields recorded in
// model_feature_rejections (venice/feature-rejections.ts) gates on the
// same set, so a stray DB row can never strip a semantic field.
// Entries are wire PATHS: a bare key ('text') or one dotted level
// ('venice_parameters.disable_thinking') - the path grammar
// hasWireField/deleteWireField implement.
export const DROPPABLE_WIRE_FIELDS: ReadonlySet<string> = new Set([
  'text',
  'reasoning_effort',
  'venice_parameters.disable_thinking',
]);

// Field names a backend reports that differ from the path nak sends.
// nak sends verbosity OpenAI-style as `text: {verbosity}`, but Venice
// flattens it to a top-level `verbosity` before forwarding to some
// backends, so their 400 reads "field: 'verbosity'" for a field that
// is not in our body under that name. Normalizing to 'text' keeps the
// strip targeting what we actually sent, and keeps the recorded
// model_feature_rejections row matching what the browser's Settings
// helper (verbosityRejectedForModel) looks for.
const REPORTED_FIELD_ALIASES: Readonly<Record<string, string>> = {
  verbosity: 'text',
};

/**
 * True when the body carries the wire path - a top-level key, or a
 * key nested one level down for 'a.b' paths.
 */
export function hasWireField(
  body: Record<string, unknown>,
  path: string,
): boolean {
  const dot = path.indexOf('.');
  if (dot === -1) return path in body;
  const parent = body[path.slice(0, dot)];
  return (
    typeof parent === 'object' && parent !== null && path.slice(dot + 1) in parent
  );
}

/**
 * Delete the wire path from the body in place. For a dotted path the
 * nested key is removed and an emptied parent object is dropped too -
 * an empty `venice_parameters: {}` left behind would itself be an
 * "extra input" to a strict backend.
 */
export function deleteWireField(
  body: Record<string, unknown>,
  path: string,
): void {
  const dot = path.indexOf('.');
  if (dot === -1) {
    delete body[path];
    return;
  }
  const parentKey = path.slice(0, dot);
  const parent = body[parentKey];
  if (typeof parent !== 'object' || parent === null) return;
  delete (parent as Record<string, unknown>)[path.slice(dot + 1)];
  if (Object.keys(parent).length === 0) delete body[parentKey];
}

/**
 * Copy of the body with the wire path removed. The caller's body and
 * any nested parent object are left untouched - deleteWireField's
 * in-place twin for callers that do not own the body.
 */
function withoutWireField(
  body: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...body };
  const dot = path.indexOf('.');
  if (dot !== -1) {
    const parentKey = path.slice(0, dot);
    const parent = copy[parentKey];
    if (typeof parent === 'object' && parent !== null) {
      copy[parentKey] = { ...(parent as Record<string, unknown>) };
    }
  }
  deleteWireField(copy, path);
  return copy;
}

// SPECIAL CASE - one model, one Venice serving quirk. Not a general
// mechanism; the general one is the strip-and-retry on a 400 below.
//
// On Venice, z-ai-glm-5-3-flash rejects every request that carries
// BOTH reasoning_effort and the text.verbosity knob ("Extra inputs are
// not permitted, field: 'verbosity'"), streaming or not. Either knob
// alone is accepted. A live probe on 2026-10-18 found this
// deterministic (every request, not intermittent). Flash is the
// default model for chat and web search, so leaving it to the
// strip-and-retry would cost an extra round-trip on every thinking-on
// message. Dropping verbosity up front for that one combination
// avoids the round-trip and keeps verbosity on thinking-off requests,
// where the model honors it.
//
// If Venice fixes this, the only cost of leaving it in place is that
// verbosity is ignored on thinking-on flash turns. Re-probe (both
// knobs, no strip) before deleting it. Other models that show the same
// rejection are handled by the general strip-and-retry, not by
// widening this check.
const GLM_53_FLASH_MODEL_ID = 'z-ai-glm-5-3-flash';

/**
 * Remove wire fields a specific model is known to reject before the
 * request goes out. Mutates the body in place; returns the removed
 * paths for logging. See the SPECIAL CASE note above - it covers one
 * model and one field combination.
 */
export function stripModelQuirkFields(body: Record<string, unknown>): string[] {
  if (
    body.model === GLM_53_FLASH_MODEL_ID &&
    hasWireField(body, 'reasoning_effort') &&
    hasWireField(body, 'text')
  ) {
    deleteWireField(body, 'text');
    return ['text'];
  }
  return [];
}

/**
 * Extract the rejected wire path from a strict-validation 400, or
 * null when the error is anything else. Two shapes are recognized:
 *
 *   - The pydantic-style extra-field message Venice relays:
 *     `Extra inputs are not permitted, field: 'text'`. The named
 *     field is the path, after REPORTED_FIELD_ALIASES maps a
 *     backend-side name ('verbosity') back to the path nak sends
 *     ('text').
 *   - A backend refusing the disable_thinking knob outright. Two
 *     wordings observed on GLM 5.3, depending on which backend
 *     answers: `Reasoning is mandatory for this endpoint and cannot
 *     be disabled.` and `GLM-5.3 is a thinking-only model; disabling
 *     thinking (reasoning_effort='none') is not supported.` The
 *     second names reasoning_effort because Venice translates
 *     disable_thinking into reasoning_effort='none' before
 *     forwarding - nak never sent that field. Maps to the
 *     venice_parameters.disable_thinking path; stripping it falls
 *     back to thinking-on, which is what the backend forces anyway.
 */
export function rejectedWireField(err: unknown): string | null {
  if (
    !(err instanceof VeniceError) ||
    err.kind !== 'http' ||
    err.status !== 400
  ) {
    return null;
  }
  const m = err.message.match(
    /Extra inputs are not permitted, field: '([^']+)'/,
  );
  if (m) return REPORTED_FIELD_ALIASES[m[1]] ?? m[1];
  if (/reasoning is mandatory|thinking-only model/i.test(err.message)) {
    return 'venice_parameters.disable_thinking';
  }
  return null;
}

/**
 * True for failures a retry might clear: a connection-level error, or an
 * upstream 5xx (500/502/503/504). A 4xx (bad request, auth) and a
 * 'parse' (deterministic bad body) won't improve on retry, and
 * 'rate_limit' is owned by the browser's retry loop.
 */
function isTransientCompleteError(err: VeniceError): boolean {
  if (err.kind === 'network') return true;
  return (
    err.kind === 'http' && typeof err.status === 'number' && err.status >= 500
  );
}

/**
 * Resolve after `ms`, or early with `true` if `signal` aborts first.
 * `false` means the full delay elapsed. No signal = a plain sleep.
 */
function sleepCancellable(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * POST /chat/completions against Venice with the shared key. Thin proxy:
 * forwards the body verbatim, returns the parsed JSON response verbatim.
 * The browser's parseChatCompletion takes the shape from there.
 *
 * Retries transient upstream failures (5xx / connection drop) on the
 * COMPLETE_RETRY_SCHEDULE_MS backoff before giving up; see
 * isTransientCompleteError for what counts and why 429 is excluded. On
 * 429, the helper reads Retry-After / x-ratelimit-reset-* into a
 * retryAfterMs hint so the browser's retry loop can act on Venice's
 * window rather than picking a backoff blindly. Other non-OK statuses
 * collapse to http; network failures to network; non-JSON success
 * bodies to parse.
 */
export async function veniceComplete(opts: VeniceCompleteOptions): Promise<unknown> {
  const schedule = opts.retrySchedule ?? COMPLETE_RETRY_SCHEDULE_MS;
  let attempt = 0;
  // Shallow copy: the quirk strip only touches top-level fields, and
  // this helper must not mutate a body the caller owns.
  let body = { ...opts.body };
  stripModelQuirkFields(body);
  for (;;) {
    try {
      return await veniceCompleteOnce({ ...opts, body });
    } catch (err) {
      // Strict-validation fallback, same contract as the streaming
      // wrapper's: a 400 naming a droppable advisory field is re-issued
      // without it, immediately and outside the retry schedule (the
      // request never reached inference). The hasWireField check
      // terminates the loop - a repeat 400 naming an already-stripped
      // field falls through to the rethrow. No persistence here: this
      // path has no orchestrator to record the discovery, so each call
      // pays the extra round-trip.
      const rejected = rejectedWireField(err);
      if (
        rejected !== null &&
        DROPPABLE_WIRE_FIELDS.has(rejected) &&
        hasWireField(body, rejected) &&
        !opts.signal?.aborted
      ) {
        console.log(
          `[veniceComplete] model backend rejected optional field '${rejected}'; stripping and retrying`,
        );
        body = withoutWireField(body, rejected);
        continue;
      }
      const retryable =
        err instanceof VeniceError &&
        (isTransientCompleteError(err) ||
          (opts.retryRateLimit === true && err.kind === 'rate_limit'));
      if (!retryable || attempt >= schedule.length) throw err;
      // On a 429 Venice tells us how long its window is; honor that over
      // the blind schedule, but floor it at the scheduled delay and cap
      // it (a long Retry-After must not blow the background budget).
      const baseMs = schedule[attempt];
      const waitMs =
        err.kind === 'rate_limit' && typeof err.retryAfterMs === 'number'
          ? Math.min(Math.max(err.retryAfterMs, baseMs), RATE_LIMIT_WAIT_CAP_MS)
          : baseMs;
      const interrupted = await sleepCancellable(waitMs, opts.signal);
      // Aborted mid-backoff: surface the failure we already have rather
      // than firing another attempt the caller no longer wants.
      if (interrupted) throw err;
      attempt += 1;
    }
  }
}

/**
 * One attempt of the /chat/completions proxy: fetch, classify a non-OK
 * status into a typed VeniceError, parse the body. The retrying
 * veniceComplete wrapper above owns the attempt loop.
 */
async function veniceCompleteOnce(opts: VeniceCompleteOptions): Promise<unknown> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    throw new VeniceError(
      `Network error contacting Venice: ${(err as Error).message}`,
      'network'
    );
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    // 600, not the 200 the other endpoints use: completions errors are
    // the ones that land verbatim in user-facing surfaces (the Wiki
    // Skipped panel stores this message as the per-thread skip reason),
    // and Venice's context-length 400 body runs past 200 chars - the
    // old cap cut it mid-sentence ("...for a total of at least 1638").
    // 600 covers every observed completions error body whole.
    if (res.status === 429) {
      throw new VeniceError(
        `Venice chat/completions 429: ${errBody.slice(0, 600)}`,
        'rate_limit',
        429,
        parseVeniceRetryAfterMs(res.headers)
      );
    }
    throw new VeniceError(
      `Venice chat/completions ${res.status}: ${errBody.slice(0, 600)}`,
      'http',
      res.status
    );
  }

  try {
    return await res.json();
  } catch {
    throw new VeniceError('Failed to parse Venice completion response.', 'parse');
  }
}
