/**
 * Supabase client wrapper — owns auth, threads, messages, and per-user
 * settings. Every call from the UI that touches the user's Supabase
 * project goes through SupabaseService.
 *
 * Security posture: we connect with the project's public **publishable key**,
 * not a service-role key. Row-Level Security (see `supabase/schema.sql`)
 * is the actual boundary — the publishable key only works for the signed-in
 * user's own rows. The service-role key never reaches the browser; it's
 * used by `mise run setup` locally to seed the main user and then
 * discarded.
 *
 * Consumed by `state.svelte.ts` (which instantiates a SupabaseService
 * on unlock), `Chat.svelte` (threads + messages), and `Settings.svelte`
 * (keys rotation, settings, theme).
 */
import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import type { AppConfig } from './config';
import {
  coerceTierModels,
  isModelTier,
  isReasoningEffort,
  isVerbosity,
  type ModelTier,
  type ThinkingLevel,
  type Verbosity,
} from './models';
import { coerceCatalog, type CatalogModel } from './models/catalog';
import { isAccent, isColorMode } from './theme';
import {
  isLogLevel,
  createLogger,
  type SerializableLogEntry,
} from './logger.svelte';

const log = createLogger('supabase');
import type { OpenAIToolCall } from './tools/types';
import type {
  ChatCompletion,
  ChatRequest,
  Citation,
  EmbeddingRequest,
  EmbeddingResponse,
  TokenUsage,
} from './venice';
import {
  buildChatBody,
  parseChatCompletion,
  VeniceError,
} from './venice';
import {
  collectUsagePages,
  type UsageRequestOptions,
  type UsageRow,
  type UsagePageRequest,
  type UsagePageResult,
} from './usage';
import { synthesizeRecoveryMessages } from './conversation-recovery';

// Domain row types live in ./supabase/types/*; this module keeps the
// SupabaseService class plus the row coercers that read those types.
// Re-export the whole type layer so `$lib/supabase` stays the single
// import surface every consumer already reaches for, then pull the
// names this file's coercers and class methods reference into local
// scope (a re-export alone doesn't bind them here).
export * from './supabase/types';
import type {
  Thread,
  Attachment,
  NewAttachment,
  ThreadAttachmentSummary,
  Message,
  ThreadCursor,
  ThreadPage,
  ThreadSearchHit,
  Memory,
  MemoryChangelogKind,
  MemoryChangelogEntry,
  SimilarMemory,
  MemoryRelation,
  WikiArticle,
  WikiRecord,
  WikiArticleSource,
  WikiArticleRelated,
  WikiChangelogKind,
  WikiChangelogEntry,
  WikiRetryResult,
  WikiManualUpdateResult,
  Recipe,
  RecipeVersion,
  RecipePhoto,
  RecipePhotoInput,
  Document,
  UserSettings,
  SystemPrompt,
  TopicVocabulary,
  OffsetPage,
  AgentRunProgressEvent,
  InflightLeaseColumn,
  LastRunOutcomeColumn,
  ManualRunOutcome,
} from './supabase/types';
import {
  coerceSettings,
  coerceSystemPrompt,
  coerceThread,
  coerceAttachmentRow,
  coerceMemoryChangelogEntry,
  coerceManualRunOutcome,
  coerceWikiArticle,
  coerceWikiRecord,
  coerceWikiChangelogEntry,
  parseTopicVocabulary,
  coerceDocument,
  USER_PROFILE_FIELD_MAX,
  UNTAGGED_TOPIC_SENTINEL,
  DEFAULT_THREAD_PAGE_SIZE,
} from './supabase/types';
// Pure helper for the record-changelog message wording; mirrored
// edge-side in venice/tools/_record_helpers.ts. The `import type` cycle
// back to this file from ./wiki is erased at runtime, so this value
// import is one-way.
import { buildRecordChangelogMessage } from './wiki';











/**
 * Decode a base64 string to raw bytes for a Storage upload. Kept local
 * (rather than importing from `attachments.ts`) because that module
 * imports types from here - the dependency must not become a cycle.
 */
// TTL for recipe-image display signed URLs. Generous (6h) so a recipe
// detail / lightbox kept open through a session keeps rendering; a
// longer-open pane re-resolves on reload.
const RECIPE_IMAGE_SIGNED_URL_TTL_SECONDS = 60 * 60 * 6;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}








/**
 * Flatten `RecipePhotoInput[]` into the parallel arrays the
 * versioned recipe RPCs accept on the wire. Empty/whitespace labels
 * round-trip as null (the DB also normalises them server-side; we
 * mirror the rule here so the wire payload is honest about which
 * photos have a caption and which don't). Returns `null` for the
 * label array when no photo carries a label - lets the RPC skip the
 * label parameter path entirely on the common "no captions yet"
 * shape rather than threading a vector of nulls.
 */
function splitPhotoInputs(photos: RecipePhotoInput[]): {
  imageIds: string[];
  imageLabels: (string | null)[] | null;
} {
  const imageIds = photos.map((p) => p.id);
  const labels = photos.map((p) => {
    if (p.label === null || p.label === undefined) return null;
    const trimmed = p.label.trim();
    return trimmed.length === 0 ? null : trimmed;
  });
  const imageLabels = labels.some((l) => l !== null) ? labels : null;
  return { imageIds, imageLabels };
}















class SupabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseError';
  }
}







/**
 * Split a selectedTopics list into the two predicates the query
 * builder needs: real topics for the `&&` overlap test, plus a
 * boolean for "also include rows with no topics at all". Centralised
 * so the three list paths (recent / older / archived) and the search
 * path stay in lockstep on the sentinel.
 */
function partitionSelectedTopics(selected: readonly string[]): {
  topics: string[];
  includeUntagged: boolean;
} {
  let includeUntagged = false;
  const topics: string[] = [];
  for (const t of selected) {
    if (t === UNTAGGED_TOPIC_SENTINEL) includeUntagged = true;
    else topics.push(t);
  }
  return { topics, includeUntagged };
}

/**
 * PostgREST `or(...)` clause matching the active topic filter. Returns
 * null when no filter is active (caller skips the predicate entirely),
 * or a string suitable for `.or()` otherwise. The two halves:
 *
 *   - "topics && {a,b}" — at least one of the selected real topics is
 *     in the row's array. PostgREST encodes array literals as
 *     {a,b,c}.
 *   - "topics.eq.{}" — the row has no topics at all (the
 *     "(untagged)" sentinel was selected).
 *
 * An OR of the two is the union the drawer's checkbox semantics
 * promise. When only one half is active we emit only that half, which
 * keeps the URL shorter and the query plan less branchy.
 *
 * `cs` (contains) vs `ov` (overlap): `ov` is the array-overlap
 * operator (`&&`) which is what we want for OR semantics across
 * multiple topics. `cs` would require ALL of the listed topics to be
 * present, which is AND semantics.
 */
function topicsFilterClause(selected: readonly string[]): string | null {
  if (selected.length === 0) return null;
  const { topics, includeUntagged } = partitionSelectedTopics(selected);
  const parts: string[] = [];
  if (topics.length > 0) {
    // PostgREST array literal: {a,b,c}. Topic strings are alphanumeric
    // by the agent prompt (no commas, no braces) so no escaping is
    // needed; if a stray punctuation char ever sneaks in, PostgREST's
    // own quoting would reject the query before it reached the DB
    // rather than mis-parse it.
    parts.push(`topics.ov.{${topics.join(',')}}`);
  }
  if (includeUntagged) {
    // Empty-array equality: a row whose topics column is `'{}'`. This
    // is what "untagged" means in the UI.
    parts.push('topics.eq.{}');
  }
  // Single predicate doesn't need an or() wrapper at the caller, but
  // the .or() builder accepts a single comma-free clause too.
  return parts.join(',');
}

/**
 * Build a double-quoted ILIKE pattern for a user-supplied substring query
 * that rides INSIDE a `.or('col.ilike.<pattern>,...')` (or `.and(…)`) logic
 * tree. Do NOT use it for a standalone `.ilike(col, value)` filter - see
 * `ilikeFilterPattern` for why the quoting is wrong there.
 *
 * PostgREST's `.or(…)` grammar treats commas as condition separators and
 * parens as grouping. An unquoted comma in the value (e.g. a chatty
 * recall query like "...simmering liquid, so they'll...") splits the
 * value into a second, malformed condition and the whole request fails
 * with "failed to parse logic tree". Backslash-escaping those chars does
 * NOT work - the parser does not honour the backslash, so the comma
 * still terminates the value - the only correct carrier is to wrap the
 * whole value in double quotes. Inside a quoted value a literal
 * double-quote or backslash must itself be backslash-escaped.
 *
 * The surrounding `%` are intentional substring wildcards and live
 * inside the quotes; ILIKE sees them after PostgREST strips the quotes
 * (quote-stripping only happens inside a logic tree). A `%` or `_` typed
 * by the user stays a wildcard, matching the prior behaviour.
 */
function ilikeLogicTreePattern(query: string): string {
  const escaped = query.replace(/(["\\])/g, '\\$1');
  return `"%${escaped}%"`;
}

/**
 * Build an ILIKE substring pattern for a STANDALONE `.ilike(col, value)`
 * filter. Plain `%query%`, no quoting, no escaping.
 *
 * supabase-js sends the value as its own URL-encoded query parameter, read
 * verbatim to the end of that parameter, so the comma/paren reserved-char
 * problem that forces quoting in a `.or(…)` logic tree simply does not
 * exist here. Crucially, PostgREST strips surrounding double quotes ONLY
 * inside a logic tree, not in a standalone horizontal filter - so reusing
 * the quoted `ilikeLogicTreePattern` here makes ILIKE hunt for literal
 * double-quote characters in the title, and a query like "Joy" stops
 * matching a recipe titled "Joy's Favorite Bread" (returns an empty list).
 * The `%`/`_` the user types stay wildcards by design.
 */
function ilikeFilterPattern(query: string): string {
  return `%${query}%`;
}












/**
 * Translate a supabase-js functions.invoke error (from any venice-function
 * route) into a VeniceError. A FunctionsHttpError carries the function's
 * Response on `.context`; we read the status and the function's normalized
 * { error } body off it so the caller surfaces the real failure and a 429 still
 * reads as rate_limit. Anything without a Response context (a relay or transport
 * failure) becomes a network error.
 */
async function veniceFunctionError(error: unknown): Promise<VeniceError> {
  const ctx = (error as { context?: unknown }).context;
  if (ctx instanceof Response) {
    let payload: { error?: string; kind?: string; retryAfterMs?: number | null } = {};
    try {
      payload = await ctx.clone().json();
    } catch {
      // Non-JSON error body - fall back to the status line.
    }
    const message = payload.error ?? `venice function request failed (HTTP ${ctx.status})`;
    const kind = ctx.status === 429 ? 'rate_limit' : 'http';
    // The /complete route relays Venice's Retry-After / x-ratelimit-reset-*
    // hint through the JSON body since the headers themselves don't survive
    // the functions.invoke round trip. Carry the parsed window onto the
    // VeniceError so the browser's retry loop can act on it.
    const retryAfterMs =
      typeof payload.retryAfterMs === 'number' ? payload.retryAfterMs : null;
    return new VeniceError(message, kind, ctx.status, retryAfterMs);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new VeniceError(`Network error contacting the venice function: ${message}`, 'network');
}







/**
 * Maximum attempts (initial + retries) before `SupabaseService.complete`
 * surfaces a 429 to the caller. Picked so a brief quota dip recovers
 * transparently while a stuck quota still surfaces within ~10s of total
 * wait. The streaming path in chat-loop.ts uses its own attempt count;
 * the non-streaming chat seam sits behind tool sub-calls and background
 * agents with no UI feedback, so a propagated 429 lands as a silent
 * `{error: "..."}` in a tool-result row or a swallowed agent failure -
 * being a bit more patient here trades a few seconds of latency for not
 * burning a turn.
 */
const COMPLETE_RATE_LIMIT_MAX_ATTEMPTS = 5;

/**
 * Fallback wait schedule for `complete` 429s, used only when the
 * function-side relayed no Retry-After or x-ratelimit-reset-* hint.
 * Log10-spaced from 1s to 5s across the four retry intervals:
 * 10^(i * log10(5) / 3) for i in 0..3. Smooths the request burst across
 * a quota reset window without piling up several seconds of wait on the
 * first retry.
 */
const COMPLETE_RATE_LIMIT_FALLBACK_WAIT_MS = [1_000, 1_710, 2_924, 5_000];

/**
 * Hard cap on a single 429 wait inside `complete`. Mirrors
 * RATE_LIMIT_WAIT_CAP_MS in chat-loop.ts: a Retry-After longer than a
 * minute almost certainly means a daily/monthly cap that won't clear
 * during the current call, so surface it as a hard error rather than
 * blocking a tool sub-call (or, worse, a background agent the user
 * can't see) for that long.
 */
const COMPLETE_RATE_LIMIT_WAIT_CAP_MS = 60_000;

/**
 * Sleep that resolves either when `ms` elapses or `signal` aborts.
 * Returns true if the signal interrupted the sleep, false on a clean
 * timeout. When no signal is passed, behaves as a plain delay and
 * always returns false. Private to this module - the chat-loop has its
 * own copy because the retry shapes diverge slightly (chat-loop emits
 * UI lifecycle events on either side of the sleep; this one just
 * waits).
 */
function sleepCancellable(
  ms: number,
  signal: AbortSignal | undefined
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The browser's single handle on the user's Supabase project. One class,
 * ~160 methods, grouped by domain with `// --- <group> ---` banners in
 * declaration order. Grep a banner to jump to its block:
 *
 *   Auth & session            sign-in / out, session, password
 *   Settings & Venice proxies user settings + the /complete, /embed,
 *                             /usage, /models, /generate-image, text
 *                             extraction edge-function calls
 *   Threads                   list / search / CRUD / per-thread setters
 *   Memories                  memory CRUD + changelog + paging
 *   Cookbook                  recipes, versions, photos
 *   Wiki articles             article CRUD + paging
 *   Library / documents       document CRUD, upload, grep, stat
 *   Wiki sources, changelog & agent runs
 *                             bibliography, See-Also, changelog, the
 *                             wiki/rem/deep-sleep run + retry routes
 *   Thread response claims    cross-device "responding here" claim
 *   Topic vocabularies        list_user_*_topics
 *   Memory confidence, search & relations
 *                             reaffirm/doubt, embedding search, graph
 *   Messages & attachments    message read/write, attachment storage
 *   Realtime subscriptions & message fetch
 *                             subscribe* + getMessage + inflight lease
 *   Samskara                  fire / substrate / health / clustering
 *   Bias profile              bias summary + observations + reactions
 *
 * Row types and their coercers live in ./supabase/types/*; this file
 * keeps the class plus its query/util helpers.
 */
export class SupabaseService {
  readonly client: SupabaseClient;

  /**
   * `opts.client` is the dependency-injection hatch used by the background
   * worker fleet (the Web Workers under src/lib/agents/). Each worker builds
   * its own `SupabaseClient` with `persistSession: false` + a manually-pinned
   * session, because workers have no localStorage and shouldn't fight the
   * main-thread client for the session store. The default path (no `opts`)
   * preserves the original main-thread behavior.
   */
  constructor(
    config: Pick<AppConfig, 'supabaseUrl' | 'supabasePublishableKey'>,
    opts: { client?: SupabaseClient } = {}
  ) {
    this.client =
      opts.client ??
      createClient(config.supabaseUrl, config.supabasePublishableKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
      });
  }

  // --- Auth & session --------------------------------------------------

  async getSession(): Promise<Session | null> {
    const { data, error } = await this.client.auth.getSession();
    if (error) throw new SupabaseError(error.message);
    return data.session;
  }

  onAuthChange(cb: (session: Session | null) => void): () => void {
    const { data } = this.client.auth.onAuthStateChange((_event, session) => {
      cb(session);
    });
    return () => data.subscription.unsubscribe();
  }

  async signUp(email: string, password: string): Promise<Session | null> {
    const { data, error } = await this.client.auth.signUp({ email, password });
    if (error) throw new SupabaseError(error.message);
    return data.session;
  }

  async signIn(email: string, password: string): Promise<Session> {
    const { data, error } = await this.client.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw new SupabaseError(error.message);
    if (!data.session) throw new SupabaseError('Sign-in returned no session.');
    return data.session;
  }

  async signOut(): Promise<void> {
    const { error } = await this.client.auth.signOut();
    if (error) throw new SupabaseError(error.message);
  }

  // Rotate the Supabase auth (login) password. Supabase's updateUser
  // endpoint does NOT require the current password - any holder of a
  // valid session token could otherwise rotate it. To match what users
  // expect from a "change password" form (and to block a stolen-tab
  // attack against an unlocked session), re-verify the current password
  // by re-signing in first. The re-signin issues a fresh session for
  // the same user, which is harmless.
  async changeAuthPassword(currentPassword: string, newPassword: string): Promise<void> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const email = session.user.email;
    if (!email) {
      throw new SupabaseError(
        'This account has no email on file, so the password cannot be changed here.',
      );
    }
    const reauth = await this.client.auth.signInWithPassword({
      email,
      password: currentPassword,
    });
    if (reauth.error) {
      throw new SupabaseError('Current password is incorrect.');
    }
    const { error } = await this.client.auth.updateUser({ password: newPassword });
    if (error) throw new SupabaseError(error.message);
  }

  // --- Settings & Venice API proxies -----------------------------------

  async getSettings(): Promise<UserSettings> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data, error } = await this.client
      .from('profiles')
      .select('settings')
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    return coerceSettings((data as { settings?: unknown } | null)?.settings);
  }

  /**
   * Fetch Venice billing usage through the `venice` edge function. The browser
   * no longer holds a Venice key for this path - the function reads the shared
   * key server-side and proxies one page per call. The paging loop lives in
   * src/lib/usage.ts (not server-side) precisely so it can drive the Usage
   * pane's per-page progress indicator. The session JWT rides along on
   * functions.invoke and the gateway's verify_jwt gates the call; failures
   * surface as VeniceError so the pane renders the same error shape it always
   * has.
   */
  async fetchUsage(opts: UsageRequestOptions = {}): Promise<UsageRow[]> {
    return collectUsagePages((req) => this.fetchUsagePage(req), opts);
  }

  private async fetchUsagePage(req: UsagePageRequest): Promise<UsagePageResult> {
    const { data, error } = await this.client.functions.invoke('venice/usage', {
      body: req,
    });
    if (error) throw await veniceFunctionError(error);
    const body = (data ?? {}) as { data?: unknown; totalPages?: unknown };
    return {
      rows: Array.isArray(body.data) ? body.data : [],
      totalPages: typeof body.totalPages === 'number' ? body.totalPages : 1,
    };
  }

  /**
   * Fetch the live Venice text-model catalog through the venice edge
   * function's /models route, coerced into the flat CatalogModel shape the
   * Settings model picker reads. The function holds the shared key
   * server-side and relays Venice's response; coercion lives in
   * src/lib/models/catalog.ts (browser-side) so a malformed row degrades
   * to "skipped" rather than failing the whole list. Errors surface as
   * VeniceError, the same shape the Usage pane already renders.
   */
  async fetchModels(): Promise<CatalogModel[]> {
    const { data, error } = await this.client.functions.invoke('venice/models', {
      body: {},
    });
    if (error) throw await veniceFunctionError(error);
    return coerceCatalog(data);
  }

  /**
   * Generate an embedding through the venice edge function's /embed route,
   * replacing the browser's direct Venice call. The function reads the shared
   * key server-side; this keeps the same { model, input } request and
   * { data: [{ embedding }] } response shape the old VeniceClient.embed had, so
   * callers only swap the handle. Note: req.signal is not propagated -
   * functions.invoke has no abort hook - so a superseded search's embed is
   * discarded by the caller's own staleness guard rather than aborted; an embed
   * is a quick call, so the wasted request is cheap.
   */
  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    const { data, error } = await this.client.functions.invoke('venice/embed', {
      body: { model: req.model, input: req.input },
    });
    if (error) throw await veniceFunctionError(error);
    return (data ?? { data: [] }) as EmbeddingResponse;
  }

  /**
   * Extract readable text from a user-uploaded file through the venice edge
   * function's /text-parser route. Routes around the CORS rejection that hits
   * any browser-direct call to Venice's /augment/text-parser (Venice CORS-
   * enables chat/image/embeddings, not text-parser - the user saw "Failed to
   * fetch" on every non-image attachment). The function holds the shared key
   * server-side; this method packages the file as multipart/form-data and
   * surfaces failures through the same VeniceError contract the call sites
   * already render. Returns the parsed text on success.
   *
   * functions.invoke handles FormData natively (it leaves Content-Type unset
   * so the runtime writes the multipart boundary), so the wire shape matches
   * what Venice's endpoint expects.
   */
  async extractText(file: Blob, filename: string): Promise<string> {
    const form = new FormData();
    form.append('file', file, filename);
    const { data, error } = await this.client.functions.invoke('venice/text-parser', {
      body: form,
    });
    if (error) throw await veniceFunctionError(error);
    const text = (data as { text?: unknown } | null)?.text;
    if (typeof text !== 'string') {
      throw new VeniceError(
        'Venice text-parser response did not contain a text field.',
        'parse'
      );
    }
    return text;
  }

  /**
   * Non-streaming chat completion through the venice edge function's
   * /complete route. The browser builds Venice's wire-shape body via
   * buildChatBody and forwards it; the function holds the shared key
   * server-side and relays Venice's response (or error) verbatim. The
   * 429 retry loop stays browser-side: the non-streaming chat seam
   * sits behind tool sub-calls and background agents with no UI
   * feedback, so a propagated 429 lands silently in a tool-result row
   * or a swallowed agent failure - being a bit patient here trades a
   * few seconds of latency for not burning a turn.
   *
   * Retry-After: Venice's hint travels through the function's 429
   * response body (retryAfterMs) since the underlying header does not
   * survive the functions.invoke round trip. Fallback when the hint is
   * absent: a log10-spaced 1s -> 5s schedule, hard-capped at 60s.
   * req.signal aborts both the in-flight invoke (when supabase-js
   * supports it) and the inter-attempt sleep.
   *
   * Streaming chat completion still talks to Venice directly from
   * src/lib/chat-loop.ts; the streaming attractor is the next driver-B
   * milestone.
   */
  async complete(req: ChatRequest): Promise<ChatCompletion> {
    const body = buildChatBody(req, false);
    let attempt = 0;
    while (true) {
      let payload: unknown;
      try {
        const { data, error } = await this.client.functions.invoke('venice/complete', {
          body,
        });
        if (error) throw await veniceFunctionError(error);
        payload = data;
      } catch (err) {
        if (!(err instanceof VeniceError)) throw err;
        const retriesExhausted = attempt >= COMPLETE_RATE_LIMIT_MAX_ATTEMPTS - 1;
        if (
          err.kind !== 'rate_limit' ||
          retriesExhausted ||
          req.signal?.aborted === true
        ) {
          throw err;
        }
        const hint = err.retryAfterMs;
        const fallbackIdx = Math.min(
          attempt,
          COMPLETE_RATE_LIMIT_FALLBACK_WAIT_MS.length - 1
        );
        const baseMs = hint ?? COMPLETE_RATE_LIMIT_FALLBACK_WAIT_MS[fallbackIdx];
        const waitMs = Math.min(baseMs, COMPLETE_RATE_LIMIT_WAIT_CAP_MS);
        log.info(
          `complete rate-limited (attempt ${attempt + 1}/${COMPLETE_RATE_LIMIT_MAX_ATTEMPTS}); waiting ${waitMs}ms before retry`
        );
        const interrupted = await sleepCancellable(waitMs, req.signal);
        if (interrupted) {
          // Aborted during the sleep. Throw a spec-shaped AbortError so
          // callers' existing AbortError branches fire - same path a
          // mid-fetch abort would have taken.
          const abortErr = new Error('Aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        attempt += 1;
        continue;
      }
      return parseChatCompletion(payload);
    }
  }

  /**
   * Merge a partial settings patch into the profiles.settings jsonb. Does a
   * read-then-write — fine for a single-user app but not safe under
   * concurrent writes from multiple tabs. If multi-tab concurrency ever
   * becomes real (e.g. two open browsers both flipping theme), move this
   * to a Postgres `jsonb_set` call so each field updates atomically.
   */
  async updateSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const current = await this.getSettings();
    // Scrub: only allow known keys through, and validate each.
    const merged: UserSettings = { ...current };
    if ('defaultModel' in patch) {
      if (patch.defaultModel === undefined) delete merged.defaultModel;
      else if (isModelTier(patch.defaultModel)) merged.defaultModel = patch.defaultModel;
    }
    if ('tierModels' in patch) {
      // Re-run the coercer so a sloppy caller can't persist a malformed
      // snapshot; an all-empty result clears the key entirely.
      const cleaned = coerceTierModels(patch.tierModels);
      if (cleaned) merged.tierModels = cleaned;
      else delete merged.tierModels;
    }
    if ('defaultReasoningEffort' in patch) {
      if (patch.defaultReasoningEffort === undefined) {
        delete merged.defaultReasoningEffort;
      } else if (isReasoningEffort(patch.defaultReasoningEffort)) {
        merged.defaultReasoningEffort = patch.defaultReasoningEffort;
      }
    }
    if ('defaultVerbosity' in patch) {
      if (patch.defaultVerbosity === undefined) {
        delete merged.defaultVerbosity;
      } else if (isVerbosity(patch.defaultVerbosity)) {
        merged.defaultVerbosity = patch.defaultVerbosity;
      }
    }
    if ('colorMode' in patch) {
      if (patch.colorMode === undefined) delete merged.colorMode;
      else if (isColorMode(patch.colorMode)) merged.colorMode = patch.colorMode;
    }
    if ('accent' in patch) {
      if (patch.accent === undefined) delete merged.accent;
      else if (isAccent(patch.accent)) merged.accent = patch.accent;
    }
    if ('systemPrompts' in patch) {
      if (patch.systemPrompts === undefined) delete merged.systemPrompts;
      else if (Array.isArray(patch.systemPrompts)) {
        // Run each prompt through the coercer so the stored shape is
        // always well-formed, regardless of caller sloppiness.
        const cleaned = patch.systemPrompts
          .map((p) => coerceSystemPrompt(p))
          .filter((p): p is SystemPrompt => p !== null);
        merged.systemPrompts = cleaned;
      }
    }
    if ('defaultLogLevel' in patch) {
      if (patch.defaultLogLevel === undefined) delete merged.defaultLogLevel;
      else if (isLogLevel(patch.defaultLogLevel)) {
        merged.defaultLogLevel = patch.defaultLogLevel;
      }
    }
    if ('emphasisMarkdown' in patch) {
      if (patch.emphasisMarkdown === undefined) delete merged.emphasisMarkdown;
      else if (typeof patch.emphasisMarkdown === 'boolean') {
        merged.emphasisMarkdown = patch.emphasisMarkdown;
      }
    }
    if ('notifyOnComplete' in patch) {
      if (patch.notifyOnComplete === undefined) delete merged.notifyOnComplete;
      else if (typeof patch.notifyOnComplete === 'boolean') {
        merged.notifyOnComplete = patch.notifyOnComplete;
      }
    }
    if ('wikiAutomaticEnabled' in patch) {
      if (patch.wikiAutomaticEnabled === undefined) {
        delete merged.wikiAutomaticEnabled;
      } else if (typeof patch.wikiAutomaticEnabled === 'boolean') {
        merged.wikiAutomaticEnabled = patch.wikiAutomaticEnabled;
      }
    }
    if ('wikiRecordExtractionEnabled' in patch) {
      if (patch.wikiRecordExtractionEnabled === undefined) {
        delete merged.wikiRecordExtractionEnabled;
      } else if (typeof patch.wikiRecordExtractionEnabled === 'boolean') {
        merged.wikiRecordExtractionEnabled = patch.wikiRecordExtractionEnabled;
      }
    }
    if ('wikiLibrarianEnabled' in patch) {
      if (patch.wikiLibrarianEnabled === undefined) {
        delete merged.wikiLibrarianEnabled;
      } else if (typeof patch.wikiLibrarianEnabled === 'boolean') {
        merged.wikiLibrarianEnabled = patch.wikiLibrarianEnabled;
      }
    }
    if ('memoryLibrarianEnabled' in patch) {
      if (patch.memoryLibrarianEnabled === undefined) {
        delete merged.memoryLibrarianEnabled;
      } else if (typeof patch.memoryLibrarianEnabled === 'boolean') {
        merged.memoryLibrarianEnabled = patch.memoryLibrarianEnabled;
      }
    }
    if ('displayTimezone' in patch) {
      if (patch.displayTimezone === undefined) delete merged.displayTimezone;
      else if (
        typeof patch.displayTimezone === 'string' &&
        patch.displayTimezone.length > 0 &&
        patch.displayTimezone.length < 128
      ) {
        merged.displayTimezone = patch.displayTimezone;
      }
      // Clear the legacy key in the same merge so a profile written
      // before the rename doesn't keep ghosting the old value
      // alongside the canonical one.
      delete (merged as { journalTimezone?: string }).journalTimezone;
    }
    // Profile strings: an empty string from the patch means "clear
    // it" (the user blanked the input and hit save), so we delete
    // the merged key rather than persist `''`. coerceSettings drops
    // empty strings on read too, but persisting the absence keeps
    // the stored blob compact.
    if ('userName' in patch) {
      if (
        patch.userName === undefined ||
        (typeof patch.userName === 'string' && patch.userName.length === 0)
      ) {
        delete merged.userName;
      } else if (
        typeof patch.userName === 'string' &&
        patch.userName.length <= USER_PROFILE_FIELD_MAX
      ) {
        merged.userName = patch.userName;
      }
    }
    if ('userLocation' in patch) {
      if (
        patch.userLocation === undefined ||
        (typeof patch.userLocation === 'string' && patch.userLocation.length === 0)
      ) {
        delete merged.userLocation;
      } else if (
        typeof patch.userLocation === 'string' &&
        patch.userLocation.length <= USER_PROFILE_FIELD_MAX
      ) {
        merged.userLocation = patch.userLocation;
      }
    }
    const { error } = await this.client
      .from('profiles')
      .update({ settings: merged })
      .eq('user_id', session.user.id);
    if (error) throw new SupabaseError(error.message);
    return merged;
  }

  // --- Threads ---------------------------------------------------------

  /**
   * One page of threads. `nextCursor === null` means the query has been
   * fully drained; any truthy value is what the caller should pass as
   * `cursor` to fetch the next page.
   */
  async listRecentThreads(
    cutoff: string,
    selectedTopics: readonly string[] = []
  ): Promise<Thread[]> {
    // Everything touched within the "active" window — hardcoded by the
    // caller so the boundary doesn't drift second-to-second and flip
    // threads at the edge between Recent and Older as seconds tick by.
    // Two-column ordering mirrors listOlderThreads so a thread the
    // user just updated doesn't hop position when it transitions.
    let q = this.client
      .from('threads')
      .select('*')
      .eq('archived', false)
      .gte('updated_at', cutoff)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(500);
    const topicsClause = topicsFilterClause(selectedTopics);
    if (topicsClause) q = q.or(topicsClause);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceThread(row as Record<string, unknown>));
  }

  async listOlderThreads(opts: {
    cutoff: string;
    cursor: ThreadCursor | null;
    pageSize?: number;
    selectedTopics?: readonly string[];
  }): Promise<ThreadPage> {
    return this.pageThreads({
      archived: false,
      cutoff: opts.cutoff,
      cursor: opts.cursor,
      pageSize: opts.pageSize ?? DEFAULT_THREAD_PAGE_SIZE,
      selectedTopics: opts.selectedTopics ?? [],
    });
  }

  async listArchivedThreads(opts: {
    cursor: ThreadCursor | null;
    pageSize?: number;
    selectedTopics?: readonly string[];
  }): Promise<ThreadPage> {
    return this.pageThreads({
      archived: true,
      cutoff: null,
      cursor: opts.cursor,
      pageSize: opts.pageSize ?? DEFAULT_THREAD_PAGE_SIZE,
      selectedTopics: opts.selectedTopics ?? [],
    });
  }

  /**
   * One-shot "window" fetch: every thread in `bucket` from the head of
   * the list down to (and including) `target`. Used when the user
   * clicks a search result that lives past the currently-loaded
   * pagination cursor — we need to materialise enough of the list to
   * put a DOM node at the target so `scrollIntoView` has something to
   * aim at.
   *
   * Returning rows in the same ordering the bucket uses lets the
   * caller merge without re-sorting. The archived bucket has no
   * cutoff; the older bucket only window-fetches within the "before
   * the cutoff" range (a Recent-bucket target should already be in
   * memory — recent is eager-loaded).
   */
  async listThreadsSince(opts: {
    target: ThreadCursor;
    archived: boolean;
    cutoff: string | null;
    selectedTopics?: readonly string[];
  }): Promise<Thread[]> {
    let q = this.client
      .from('threads')
      .select('*')
      .eq('archived', opts.archived)
      .gte('updated_at', opts.target.updated_at)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false });
    if (opts.cutoff) q = q.lt('updated_at', opts.cutoff);
    const topicsClause = topicsFilterClause(opts.selectedTopics ?? []);
    if (topicsClause) q = q.or(topicsClause);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceThread(row as Record<string, unknown>));
  }

  private async pageThreads(opts: {
    archived: boolean;
    cutoff: string | null;
    cursor: ThreadCursor | null;
    pageSize: number;
    selectedTopics: readonly string[];
  }): Promise<ThreadPage> {
    // Fetch pageSize+1 rows so we can derive hasMore without a second
    // count query — if the server returned pageSize+1 rows we know at
    // least one page remains, otherwise we're at the tail.
    let q = this.client
      .from('threads')
      .select('*')
      .eq('archived', opts.archived)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(opts.pageSize + 1);
    if (opts.cutoff) q = q.lt('updated_at', opts.cutoff);
    if (opts.cursor) {
      // Composite cursor: (updated_at, id) strictly-less-than the
      // cursor, with id tie-break. PostgREST doesn't have row-value
      // comparison sugar, so spell it as
      // `updated_at < c.updated_at OR (updated_at = c.updated_at AND id < c.id)`.
      const c = opts.cursor;
      q = q.or(
        `updated_at.lt.${c.updated_at},and(updated_at.eq.${c.updated_at},id.lt.${c.id})`
      );
    }
    const topicsClause = topicsFilterClause(opts.selectedTopics);
    if (topicsClause) q = q.or(topicsClause);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []).map((row) => coerceThread(row as Record<string, unknown>));
    const hasMore = rows.length > opts.pageSize;
    const page = hasMore ? rows.slice(0, opts.pageSize) : rows;
    const last = page[page.length - 1];
    const nextCursor: ThreadCursor | null =
      hasMore && last ? { updated_at: last.updated_at, id: last.id } : null;
    return { rows: page, nextCursor };
  }

  /**
   * Merged exact + semantic search across all the user's threads.
   *
   * Exact hits are ILIKE matches against `title` (substring, case-
   * insensitive) — same escape pattern as `searchMemories`. Semantic
   * hits come from the `search_threads_by_embedding` RPC against
   * `title + summary` embeddings populated by the background workers.
   * Both queries run in parallel; the merge puts every exact hit
   * before every semantic hit, deduping by id on the way through so a
   * thread can't appear twice.
   *
   * `queryEmbedding` may be null — callers that couldn't produce an
   * embedding (Venice error, offline) still get useful exact-match
   * results instead of an empty list. Archived threads are included
   * in both halves; the UI greys them.
   */
  async searchThreads(opts: {
    query: string;
    queryEmbedding: number[] | null;
    limit?: number;
    /**
     * When non-empty, search results are narrowed to the same topic
     * filter the drawer's date-sorted list uses. Exact (ILIKE) hits
     * are filtered server-side via the same `topicsFilterClause`
     * helper the list paths use; semantic hits come back from the
     * embedding RPC without topic columns, so we re-fetch the matched
     * rows and filter in memory rather than touching the RPC signature.
     * Matches the "topic filter constrains search too" UX decision -
     * see docs/dev/topics.md.
     */
    selectedTopics?: readonly string[];
  }): Promise<ThreadSearchHit[]> {
    const query = opts.query.trim();
    if (query.length === 0) return [];
    const limit = opts.limit ?? 50;
    const selectedTopics = opts.selectedTopics ?? [];
    const topicsClause = topicsFilterClause(selectedTopics);

    const pattern = ilikeFilterPattern(query);
    let exactQ = this.client
      .from('threads')
      .select('*')
      .ilike('title', pattern)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);
    if (topicsClause) exactQ = exactQ.or(topicsClause);
    const exactPromise = exactQ;

    const semanticPromise = opts.queryEmbedding
      ? this.client.rpc('search_threads_by_embedding', {
          query_embedding: opts.queryEmbedding,
          match_limit: limit,
        })
      : Promise.resolve({ data: [] as unknown[], error: null });

    const [exactRes, semRes] = await Promise.all([exactPromise, semanticPromise]);
    if (exactRes.error) throw new SupabaseError(exactRes.error.message);
    // A semantic failure shouldn't kill the whole search — fall back to
    // exact-only. Mirrors how memory_search falls back when Venice is
    // unreachable.
    const semanticRows =
      semRes.error !== null
        ? []
        : ((semRes.data ?? []) as {
            id: string;
            title: string;
            archived: boolean;
            updated_at: string;
            similarity: number;
          }[]);

    const exactThreads = (exactRes.data ?? []).map((row) =>
      coerceThread(row as Record<string, unknown>)
    );

    // When a topic filter is active, narrow semantic hits to rows
    // matching the same predicate. The embedding RPC doesn't read
    // `topics`, so we do this client-side: fetch the matched rows'
    // topics columns by id, then drop any that don't satisfy the
    // filter. The fetch is one round trip with at most `limit` rows
    // so the overhead is small (and only paid when a filter is
    // active). When no filter is active we skip the round trip
    // entirely and the existing path runs unchanged.
    let allowedSemanticIds: Set<string> | null = null;
    if (selectedTopics.length > 0 && semanticRows.length > 0) {
      const ids = semanticRows.map((r) => r.id);
      const { topics: realTopics, includeUntagged } =
        partitionSelectedTopics(selectedTopics);
      const { data: topicRows, error: topicErr } = await this.client
        .from('threads')
        .select('id, topics')
        .in('id', ids);
      if (topicErr) throw new SupabaseError(topicErr.message);
      allowedSemanticIds = new Set<string>();
      const realSet = new Set(realTopics);
      for (const r of (topicRows ?? []) as { id: string; topics: unknown }[]) {
        const rowTopics = Array.isArray(r.topics)
          ? r.topics.filter((v): v is string => typeof v === 'string')
          : [];
        if (rowTopics.length === 0 && includeUntagged) {
          allowedSemanticIds.add(r.id);
          continue;
        }
        if (realSet.size > 0 && rowTopics.some((t) => realSet.has(t))) {
          allowedSemanticIds.add(r.id);
        }
      }
    }

    const out: ThreadSearchHit[] = [];
    const seen = new Set<string>();
    for (const t of exactThreads) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({ thread: t, kind: 'exact' });
      if (out.length >= limit) return out;
    }
    for (const row of semanticRows) {
      if (seen.has(row.id)) continue;
      if (allowedSemanticIds && !allowedSemanticIds.has(row.id)) continue;
      seen.add(row.id);
      // The RPC projection gives us enough for the row UI; fields the
      // result list doesn't render are stubbed so downstream code that
      // wants a full Thread still gets a valid shape.
      out.push({
        thread: {
          id: row.id,
          user_id: '',
          title: row.title,
          model: null,
          reasoning_effort: null,
          verbosity: null,
          toolboxes_enabled: [],
          archived: row.archived,
          title_manually_set: false,
          intuition_payload: null,
          context_recall_payload: null,
          topics: [],
          response_holder_id: null,
          response_claim_expires_at: null,
          last_error: null,
          created_at: row.updated_at,
          updated_at: row.updated_at,
        },
        kind: 'semantic',
        similarity: row.similarity,
      });
      if (out.length >= limit) return out;
    }
    return out;
  }

  async createThread(
    title: string,
    model: ModelTier | null = null,
    reasoningEffort: ThinkingLevel | null = null,
    verbosity: Verbosity | null = null,
    titleManuallySet = false,
    toolboxesEnabled: string[] = []
  ): Promise<Thread> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data, error } = await this.client
      .from('threads')
      .insert({
        title,
        user_id: session.user.id,
        model,
        reasoning_effort: reasoningEffort,
        verbosity,
        title_manually_set: titleManuallySet,
        // Carries the draft's toolbox selections through to the
        // persisted row. The composer toolbox button is available
        // before a draft materializes, so a user may have enabled
        // toolboxes before the first send - without this passthrough
        // those flips would silently reset to [] on materialization.
        toolboxes_enabled: toolboxesEnabled,
      })
      .select()
      .single();
    if (error) throw new SupabaseError(error.message);
    return coerceThread(data as Record<string, unknown>);
  }

  /**
   * Rename a thread. The `manuallySet` flag is the signal that separates
   * the two callers:
   *
   *   - `false` (default): the `update_title` tool path. Writes the title
   *     but leaves `title_manually_set` alone — so a model-initiated
   *     rename is still considered "up for revision" on a future topic
   *     shift.
   *   - `true`: the user's title input / commitRename. Writes the title
   *     AND flips the sticky flag so the chat loop will stop feeding the
   *     rename instruction to the model. Once the user has picked a
   *     title, that choice wins permanently.
   *
   * Explicitly a single method rather than two (renameThread /
   * renameThreadManually) so there's one RPC round-trip per rename
   * regardless of path.
   */
  async renameThread(
    threadId: string,
    title: string,
    opts: { manuallySet?: boolean } = {}
  ): Promise<void> {
    const patch: Record<string, unknown> = {
      title,
      updated_at: new Date().toISOString(),
    };
    if (opts.manuallySet === true) {
      patch.title_manually_set = true;
    }
    const { error } = await this.client
      .from('threads')
      .update(patch)
      .eq('id', threadId);
    if (error) throw new SupabaseError(error.message);
  }

  async setThreadModel(threadId: string, model: ModelTier | null): Promise<void> {
    const { error } = await this.client
      .from('threads')
      .update({ model, updated_at: new Date().toISOString() })
      .eq('id', threadId);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Pin the reasoning-effort level for this thread, or clear the override
   * (null) so the thread tracks the user default. Doesn't touch
   * updated_at - flipping reasoning shouldn't promote the thread to the
   * top of the sidebar, same rationale as setThreadToolboxesEnabled.
   */
  async setThreadReasoningEffort(
    threadId: string,
    reasoningEffort: ThinkingLevel | null
  ): Promise<void> {
    const { error } = await this.client
      .from('threads')
      .update({ reasoning_effort: reasoningEffort })
      .eq('id', threadId);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Pin the text.verbosity level for this thread, or clear the override
   * (null) so the thread tracks the user default. Same discipline as
   * setThreadReasoningEffort — no updated_at bump because flipping
   * verbosity shouldn't promote the thread to the top of the sidebar.
   */
  async setThreadVerbosity(
    threadId: string,
    verbosity: Verbosity | null
  ): Promise<void> {
    const { error } = await this.client
      .from('threads')
      .update({ verbosity })
      .eq('id', threadId);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Persist the cached intuition payload for this thread. Pass `null`
   * to clear (used by tests; the chat-loop only ever writes a fresh
   * payload). Doesn't bump updated_at - intuition is internal state
   * that shouldn't promote the thread to the top of the sidebar, same
   * discipline as the toolbox / verbosity / reasoning-effort setters.
   *
   * Loose typing on `payload`: the column is jsonb and the intuition
   * module owns the canonical shape (see
   * src/lib/intuition/types.ts#IntuitionPayload). Routing the parse
   * through there means a future shape change touches one file rather
   * than every Supabase call site.
   */
  async setThreadIntuitionPayload(
    threadId: string,
    payload: unknown
  ): Promise<void> {
    const { error } = await this.client
      .from('threads')
      .update({ intuition_payload: payload })
      .eq('id', threadId);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Persist the cached context-recall payload. Sibling of
   * setThreadIntuitionPayload and shares its discipline: no
   * updated_at bump (subconscious priming shouldn't promote the
   * thread in the sidebar), loose typing because the canonical
   * shape lives in src/lib/context-recall/types.ts.
   */
  async setThreadContextRecallPayload(
    threadId: string,
    payload: unknown
  ): Promise<void> {
    const { error } = await this.client
      .from('threads')
      .update({ context_recall_payload: payload })
      .eq('id', threadId);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Replace the thread's set of enabled gated toolboxes. Called from
   * the `toggle_toolbox` meta-tool (LLM path) and from the composer
   * toolbox popover (user path). The array is the new set; any
   * toolbox not listed is disabled. Doesn't touch updated_at - a
   * toolbox flip shouldn't promote the thread to the top of the
   * sidebar. Caller is responsible for pre-filtering to the known
   * toolbox names (this method writes whatever it's given - the
   * validation lives with the callers who know the valid name list).
   */
  async setThreadToolboxesEnabled(
    threadId: string,
    enabled: readonly string[]
  ): Promise<void> {
    const { error } = await this.client
      .from('threads')
      .update({ toolboxes_enabled: enabled })
      .eq('id', threadId);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Flip the thread's archived flag. Unlike setThreadToolboxesEnabled /
   * setThreadReasoningEffort, this one DOES bump updated_at - both
   * directions want the thread promoted to the top of whichever section
   * (Chats or Archive) it lands in, so the user immediately sees where
   * it went.
   */
  async setThreadArchived(threadId: string, archived: boolean): Promise<void> {
    const { error } = await this.client
      .from('threads')
      .update({ archived, updated_at: new Date().toISOString() })
      .eq('id', threadId);
    if (error) throw new SupabaseError(error.message);
  }

  async deleteThread(threadId: string): Promise<void> {
    // Collect the thread's live attachment object keys BEFORE the delete:
    // threads -> messages -> message_attachments all cascade, so once the
    // thread is gone the rows are gone and their bucket keys are
    // unrecoverable. Includes generated images (same table). Expired rows
    // (storage_path null) have no object left, so we filter them out.
    const { data: attachRows, error: listErr } = await this.client
      .from('message_attachments')
      .select('storage_path, messages!inner(thread_id)')
      .eq('messages.thread_id', threadId)
      .not('storage_path', 'is', null);
    if (listErr) throw new SupabaseError(listErr.message);
    const paths = (attachRows ?? [])
      .map((r) => (r as { storage_path: string | null }).storage_path)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);

    const { error } = await this.client.from('threads').delete().eq('id', threadId);
    if (error) throw new SupabaseError(error.message);

    // Best-effort object reclamation AFTER the rows are gone (the reverse of
    // deleteDocument's object-then-row order): the thread has already left the
    // user's view, so a Storage hiccup must not resurrect it. Any object left
    // behind here is caught by the daily attachment-gc sweep (bucket objects
    // with no message_attachments row), so we swallow the remove error rather
    // than fail the delete. Doing it after the cascade also means a partial
    // failure can't strand a live row pointing at a deleted object (which would
    // render as a broken image).
    if (paths.length > 0) {
      await this.client.storage.from('attachments').remove(paths);
    }
  }

  async deleteMessages(messageIds: string[]): Promise<void> {
    // Delete a set of message rows by id - the "delete from here"
    // gesture passes a user message and every row after it. The
    // "messages are self-deletable via thread" RLS policy scopes the
    // delete to threads the caller owns, so a forged id from another
    // user's thread silently matches nothing.
    //
    // Everything that references messages.id either cascades or clears:
    // message_attachments cascade (their bucket objects are reclaimed
    // below), and the threads.last_*_msg_id watermarks + the bias
    // evidence_message_id pointer are ON DELETE SET NULL - so the next
    // reflection/summary/topics/wiki/evaluation cycle simply re-runs
    // from a cleared watermark. samskara_substrate.user_message_id and
    // samskara_fires.user_round are soft pointers with no FK; their
    // rows survive and may go off-by-N, which the samskara design
    // accepts (rare, not worth a trigger).
    if (messageIds.length === 0) return;

    // Collect attachment object keys BEFORE the delete: the cascade
    // removes the rows, after which their bucket keys are
    // unrecoverable. Expired rows (storage_path null) have no object
    // left, so they are filtered out.
    const { data: attachRows, error: listErr } = await this.client
      .from('message_attachments')
      .select('storage_path')
      .in('message_id', messageIds)
      .not('storage_path', 'is', null);
    if (listErr) throw new SupabaseError(listErr.message);
    const paths = (attachRows ?? [])
      .map((r) => (r as { storage_path: string | null }).storage_path)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);

    const { error } = await this.client.from('messages').delete().in('id', messageIds);
    if (error) throw new SupabaseError(error.message);

    // Best-effort object reclamation AFTER the rows are gone (same order
    // as deleteThread): a Storage hiccup must not strand a live row
    // pointing at a deleted object. Anything left behind is swept by the
    // daily attachment-gc (bucket objects with no message_attachments
    // row), so the remove error is swallowed rather than failing the
    // delete.
    if (paths.length > 0) {
      await this.client.storage.from('attachments').remove(paths);
    }
  }

  // memories -------------------------------------------------------------
  //
  // RLS on the memories table scopes every query to the signed-in user's
  // own rows, so these methods don't need to filter by user_id on
  // select/update/delete. Inserts do need to set user_id explicitly (RLS
  // checks with_check against the row, and there's no default).

  // --- Memories --------------------------------------------------------

  /**
   * Case-insensitive substring search over `label || data`. Empty query
   * lists all memories (most-recent first). Results are capped at `limit`
   * so a runaway LLM can't blow up context with a giant memory dump.
   *
   * `selectedTopics` narrows the result set to rows whose `topics`
   * column overlaps the selection (or is empty, if the UI-only
   * UNTAGGED_TOPIC_SENTINEL is included). Empty array means "no filter
   * active" - the LLM-facing memory_search tool passes nothing here
   * because the model has no topic-selection UI, so its calls keep the
   * pre-filter behaviour exactly.
   */
  async searchMemories(
    query: string,
    limit: number,
    selectedTopics: readonly string[] = []
  ): Promise<Memory[]> {
    let q = this.client
      .from('memories')
      .select('id, label, data, confidence, topics, created_at, updated_at')
      .order('updated_at', { ascending: false })
      .limit(limit);
    if (query && query.length > 0) {
      const pattern = ilikeLogicTreePattern(query);
      q = q.or(`label.ilike.${pattern},data.ilike.${pattern}`);
    }
    const topicsClause = topicsFilterClause(selectedTopics);
    if (topicsClause) q = q.or(topicsClause);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as Memory[];
  }

  /**
   * Partial update. Caller guarantees at least one of label/data is set;
   * the tool-side code enforces that contract. We bump updated_at on
   * every write so memory_search orders by freshness.
   */
  async updateMemory(
    id: string,
    patch: { label?: string; data?: string }
  ): Promise<Memory> {
    const { data: row, error } = await this.client
      .from('memories')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, label, data, confidence, topics, created_at, updated_at')
      .single();
    if (error) throw new SupabaseError(error.message);
    return row as Memory;
  }

  async deleteMemory(id: string): Promise<void> {
    const { error } = await this.client.from('memories').delete().eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Fetch a single memory by id, or null when it doesn't exist (or is
   * owned by another user - RLS filters those rows out, so a not-found
   * and a not-owned are indistinguishable here, which is the intended
   * privacy posture). Used by the changelog write paths that need a
   * `label_at_change` snapshot before a destructive mutation: the
   * delete tool (snapshot before the row is gone) and the consolidate
   * tool (snapshot the loser's label for the merge message).
   */
  async getMemoryById(id: string): Promise<Memory | null> {
    const { data, error } = await this.client
      .from('memories')
      .select('id, label, data, confidence, topics, created_at, updated_at')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    return (data as Memory | null) ?? null;
  }

  /**
   * Append a memory-changelog row. Called by every content-affecting
   * memory write path: the create/update/delete tools, the user's
   * direct edits in Memories.svelte, and the librarian's consolidate.
   * Throws on a failed insert so callers can decide whether to surface
   * or swallow it - the tool/UI paths currently swallow (the mutation
   * already landed; a missed changelog row is a smaller harm than a
   * confusing post-success error).
   *
   * `memory_id` is null for hard deletes (the memory is already gone by
   * the time this lands). For create/update/consolidate it points at
   * the live memory; if that memory is later deleted the FK cascades to
   * null but `label_at_change` keeps the row meaningful.
   */
  async createMemoryChangelogEntry(args: {
    memory_id: string | null;
    kind: MemoryChangelogKind;
    label_at_change: string;
    message: string;
  }): Promise<void> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const label = args.label_at_change.trim();
    const message = args.message.trim();
    if (label.length === 0 || message.length === 0) return;
    const { error } = await this.client.from('memory_changelog').insert({
      user_id: session.user.id,
      memory_id: args.memory_id,
      kind: args.kind,
      label_at_change: label,
      message,
    });
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Paged listing of the memory changelog, newest first. `before` is the
   * exclusive cursor in `created_at desc` order - pass the last entry's
   * `created_at` from the prior page to fetch the next one. The
   * (user_id, created_at desc) index makes this a range scan rather than
   * a sort, so the panel can lazy-load deep history cheaply.
   */
  async listMemoryChangelog(opts: {
    limit?: number;
    before?: string | null;
  } = {}): Promise<MemoryChangelogEntry[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    let q = this.client
      .from('memory_changelog')
      .select('id, memory_id, kind, label_at_change, message, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (opts.before) q = q.lt('created_at', opts.before);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    const out: MemoryChangelogEntry[] = [];
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const entry = coerceMemoryChangelogEntry(row);
      if (entry) out.push(entry);
    }
    return out;
  }

  /**
   * One offset page of the memory browse list (most-recent first).
   * Powers the sidebar's infinite scroll for the empty-query case;
   * an active search still goes through `searchMemories` (capped, not
   * paged) so relevance order stays intact. `id` is the final tiebreak
   * so rows colliding on `updated_at` keep a stable cross-page order.
   * `selectedTopics` is filtered server-side - a partial page must be
   * narrowed before it's sliced.
   */
  async listMemoriesPage(opts: {
    offset: number;
    pageSize: number;
    selectedTopics?: readonly string[];
  }): Promise<OffsetPage<Memory>> {
    let q = this.client
      .from('memories')
      .select('id, label, data, confidence, topics, created_at, updated_at')
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false });
    const topicsClause = topicsFilterClause(opts.selectedTopics ?? []);
    if (topicsClause) q = q.or(topicsClause);
    q = q.range(opts.offset, opts.offset + opts.pageSize);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as Memory[];
    const hasMore = rows.length > opts.pageSize;
    return { rows: hasMore ? rows.slice(0, opts.pageSize) : rows, hasMore };
  }

  // recipes --------------------------------------------------------------
  //
  // Same RLS posture as memories: every query is scoped to the signed-in
  // user automatically; only inserts need an explicit user_id because the
  // with_check policy has no default to fall back on.
  //
  // Embedding pipeline: the cookbook stays small enough that the LLM
  // tool path (`recipe_list`, `recipe_search`) gets by on ILIKE alone,
  // but the human-facing drawer search (`RecipeList.svelte`) wires
  // through the shared embeddings worker so a fuzzy query ("fluffy
  // potato side") can find a recipe by meaning rather than title
  // substring. Same claim/save/search RPC trio as the wiki source.

  // --- Cookbook --------------------------------------------------------

  /**
   * List recipes, optionally filtered by a case-insensitive `title`
   * substring. Capped at `limit` to keep the recipe_list tool result
   * small (one recipe's cooklang can be several kilobytes; a runaway
   * list would blow the context budget).
   *
   * `sort` defaults to 'updated' (most-recently-edited first). 'rating'
   * orders by stars descending with `nulls last`, then falls back to
   * `updated_at desc` so unrated rows still show in a stable order at
   * the bottom and ties among same-rated rows resolve to the most
   * recently touched.
   */
  async listRecipes(
    query: string,
    limit: number,
    sort: 'updated' | 'rating' = 'updated'
  ): Promise<Recipe[]> {
    let q = this.client
      .from('recipes')
      .select(
        'id, title, source, source_url, cooklang, rating, upcoming, favorite, topics, created_at, updated_at'
      )
      .limit(limit);
    if (sort === 'rating') {
      q = q
        .order('rating', { ascending: false, nullsFirst: false })
        .order('updated_at', { ascending: false });
    } else {
      q = q.order('updated_at', { ascending: false });
    }
    if (query && query.length > 0) {
      q = q.ilike('title', ilikeFilterPattern(query));
    }
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as Recipe[];
  }

  /**
   * One offset page of the "All recipes" browse list. Powers the
   * sidebar's infinite scroll: the empty-query listing pages through
   * the whole cookbook instead of truncating at a fixed cap.
   *
   * `sort` matches the sidebar picker. Each mode ends with `id` as a
   * final tiebreak so rows that collide on the primary key (two
   * recipes with the same rating + updated_at) keep a stable order
   * across page boundaries - without it an offset window could drop or
   * repeat a colliding row.
   *
   * `selectedTopics` is applied server-side (the older client-side
   * filter only worked because the whole cookbook was in memory; a
   * partial page has to be filtered before it's sliced or the page
   * count would be wrong).
   */
  async listRecipesPage(opts: {
    offset: number;
    pageSize: number;
    sort: 'updated' | 'rating' | 'alphabetical';
    selectedTopics?: readonly string[];
  }): Promise<OffsetPage<Recipe>> {
    let q = this.client
      .from('recipes')
      .select(
        'id, title, source, source_url, cooklang, rating, upcoming, favorite, topics, created_at, updated_at'
      );
    if (opts.sort === 'rating') {
      q = q
        .order('rating', { ascending: false, nullsFirst: false })
        .order('updated_at', { ascending: false })
        .order('id', { ascending: false });
    } else if (opts.sort === 'alphabetical') {
      // Ordered by the column's collation rather than a JS
      // localeCompare so the server's page boundaries match what the
      // client renders - paginating an arbitrary client-side sort would
      // shuffle rows across the seam.
      // TODO: untitled drafts (empty title) sort to the head under a
      // raw `title ASC`, where the user expects them at the tail of an
      // A-Z list, and the collation's case/accent handling may diverge
      // from the dictionary order users expect. Both want a sort key
      // the offset window can page deterministically.
      q = q.order('title', { ascending: true }).order('id', { ascending: true });
    } else {
      q = q
        .order('updated_at', { ascending: false })
        .order('id', { ascending: false });
    }
    const topicsClause = topicsFilterClause(opts.selectedTopics ?? []);
    if (topicsClause) q = q.or(topicsClause);
    // Inclusive range: ask for pageSize + 1 rows so a full extra row
    // signals "another page exists" without a separate count query.
    q = q.range(opts.offset, opts.offset + opts.pageSize);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as Recipe[];
    const hasMore = rows.length > opts.pageSize;
    return { rows: hasMore ? rows.slice(0, opts.pageSize) : rows, hasMore };
  }

  /**
   * Every recipe flagged `upcoming` (the current grocery cycle).
   * Fetched whole rather than paged - the flagged subset is small and
   * the sidebar renders it as a complete bucket above the paginated
   * "All recipes" list, so a partial page would misrepresent it. The
   * topic filter stays client-side over this complete set.
   */
  async listUpcomingRecipes(): Promise<Recipe[]> {
    const { data, error } = await this.client
      .from('recipes')
      .select(
        'id, title, source, source_url, cooklang, rating, upcoming, favorite, topics, created_at, updated_at'
      )
      .eq('upcoming', true)
      .order('updated_at', { ascending: false });
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as Recipe[];
  }

  /** Every recipe flagged `favorite`. Same complete-bucket rationale as listUpcomingRecipes. */
  async listFavoriteRecipes(): Promise<Recipe[]> {
    const { data, error } = await this.client
      .from('recipes')
      .select(
        'id, title, source, source_url, cooklang, rating, upcoming, favorite, topics, created_at, updated_at'
      )
      .eq('favorite', true)
      .order('updated_at', { ascending: false });
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as Recipe[];
  }

  async getRecipe(id: string): Promise<Recipe | null> {
    const { data, error } = await this.client
      .from('recipes')
      .select(
        'id, title, source, source_url, cooklang, rating, upcoming, favorite, topics, created_at, updated_at'
      )
      .eq('id', id)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    return (data as Recipe | null) ?? null;
  }

  /**
   * Semantic + substring search over recipes. Same merge contract as
   * `searchWikiArticles`: vector hits first (RPC, ordered by cosine
   * similarity), then ILIKE hits the vector
   * pass missed, deduped by id and capped at `limit`. Empty `query`
   * falls back to `listRecipes` (most-recently-updated first) so
   * callers don't need to special-case the no-query branch.
   * `queryEmbedding` may be null - callers without Venice get ILIKE-
   * only results.
   *
   * The ILIKE side runs on title only; the semantic side has the
   * full `title + source + cooklang` blob folded into the embedding
   * by the worker, so a meaning match can reach ingredient or
   * technique text the title alone misses.
   */
  async searchRecipes(opts: {
    query: string;
    queryEmbedding: number[] | null;
    limit?: number;
  }): Promise<Recipe[]> {
    const query = opts.query.trim();
    const limit = opts.limit ?? 50;
    if (query.length === 0) return this.listRecipes('', limit);

    const pattern = ilikeFilterPattern(query);

    const ilikePromise = this.client
      .from('recipes')
      .select(
        'id, title, source, source_url, cooklang, rating, upcoming, favorite, topics, created_at, updated_at'
      )
      .ilike('title', pattern)
      .order('updated_at', { ascending: false })
      .limit(limit);

    const semanticPromise = opts.queryEmbedding
      ? this.client.rpc('search_recipes_by_embedding', {
          query_embedding: opts.queryEmbedding,
          match_limit: limit,
        })
      : Promise.resolve({ data: [] as unknown[], error: null });

    const [ilikeRes, semRes] = await Promise.all([ilikePromise, semanticPromise]);
    if (ilikeRes.error) throw new SupabaseError(ilikeRes.error.message);
    const ilikeRows = ((ilikeRes.data ?? []) as unknown[]) as Recipe[];
    const semanticRows: Recipe[] =
      semRes.error !== null ? [] : (((semRes.data ?? []) as unknown[]) as Recipe[]);

    const out: Recipe[] = [];
    const seen = new Set<string>();
    for (const r of semanticRows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      if (out.length >= limit) return out;
    }
    for (const r of ilikeRows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      if (out.length >= limit) return out;
    }
    return out;
  }

  /**
   * Create a recipe and snapshot the initial state into
   * `recipe_versions` atomically via the
   * `recipe_create_with_version` RPC. `changeMessage` is required —
   * it appears in the History panel as the description of the
   * initial save (e.g. "Imported from NYT Cooking", "Created by
   * hand"). `photos` is the ordered list of `(image_id, label)`
   * pairs to link to the new version (empty by default for a
   * recipe with no photos). A null/blank label means "no caption".
   */
  async createRecipe(
    title: string,
    cooklang: string,
    source: string | null,
    sourceUrl: string | null,
    rating: number | null,
    changeMessage: string,
    photos: RecipePhotoInput[] = []
  ): Promise<Recipe> {
    if (!changeMessage || changeMessage.trim().length === 0) {
      throw new SupabaseError('changeMessage is required');
    }
    if (rating !== null && (rating < 1 || rating > 5 || !Number.isInteger(rating))) {
      throw new SupabaseError('rating must be an integer between 1 and 5');
    }
    const { imageIds, imageLabels } = splitPhotoInputs(photos);
    const { data, error } = await this.client.rpc(
      'recipe_create_with_version',
      {
        p_title: title,
        p_cooklang: cooklang,
        p_source: source,
        p_source_url: sourceUrl,
        p_rating: rating,
        p_image_ids: imageIds,
        p_image_labels: imageLabels,
        p_change_message: changeMessage.trim(),
      }
    );
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as Recipe[];
    if (rows.length === 0) {
      throw new SupabaseError('create returned no row');
    }
    return rows[0]!;
  }

  /**
   * Partial update. Caller guarantees at least one field in `patch`
   * is set - enforced by the recipe_update tool and the Cookbook
   * Edit pane before this method runs. Goes through
   * `recipe_update_with_version` so the prior state is snapshotted
   * into `recipe_versions` in the same transaction. `changeMessage`
   * is required and lands on the new version row.
   *
   * The boolean-flag pairs (`p_set_*` + value) preserve the
   * "absent leaves field unchanged; explicit null clears" semantics
   * across the wire: TypeScript's `'field' in patch` distinguishes
   * the two cases, but the Postgres parameter list cannot.
   *
   * `photos` follows the same pattern: omit to inherit the previous
   * version's photo set (and labels) unchanged; pass an array
   * (possibly empty) to set the new version's photo set explicitly.
   * Each entry is `{id, label}`; a null/blank label is "no caption".
   * Bulk editor saves include it; tool-driven scalar edits omit it.
   */
  async updateRecipe(
    id: string,
    patch: {
      title?: string;
      cooklang?: string;
      source?: string | null;
      source_url?: string | null;
      rating?: number | null;
      photos?: RecipePhotoInput[];
    },
    changeMessage: string
  ): Promise<Recipe> {
    if (!changeMessage || changeMessage.trim().length === 0) {
      throw new SupabaseError('changeMessage is required');
    }
    if (
      'rating' in patch &&
      patch.rating !== null &&
      patch.rating !== undefined &&
      (patch.rating < 1 || patch.rating > 5 || !Number.isInteger(patch.rating))
    ) {
      throw new SupabaseError('rating must be an integer between 1 and 5');
    }
    const photoSplit =
      'photos' in patch ? splitPhotoInputs(patch.photos ?? []) : null;
    const { data, error } = await this.client.rpc(
      'recipe_update_with_version',
      {
        p_id: id,
        p_set_title: 'title' in patch,
        p_title: patch.title ?? null,
        p_set_cooklang: 'cooklang' in patch,
        p_cooklang: patch.cooklang ?? null,
        p_set_source: 'source' in patch,
        p_source: patch.source ?? null,
        p_set_source_url: 'source_url' in patch,
        p_source_url: patch.source_url ?? null,
        p_set_rating: 'rating' in patch,
        p_rating: patch.rating ?? null,
        p_set_image_ids: photoSplit !== null,
        p_image_ids: photoSplit?.imageIds ?? null,
        p_image_labels: photoSplit?.imageLabels ?? null,
        p_change_message: changeMessage.trim(),
      }
    );
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as Recipe[];
    if (rows.length === 0) {
      throw new SupabaseError('update returned no row');
    }
    return rows[0]!;
  }

  /**
   * Toggle the workflow `upcoming` flag. Direct table update on
   * purpose - upcoming is not recipe content, so it bypasses the
   * version-writing RPC. We intentionally do not touch `updated_at`
   * either: marking a recipe as upcoming should not bump it to the
   * top of the recency sort, because the user is bookmarking it for
   * a near-future cook, not editing it.
   */
  async setRecipeUpcoming(id: string, upcoming: boolean): Promise<void> {
    const { error } = await this.client
      .from('recipes')
      .update({ upcoming })
      .eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Toggle the `favorite` flag. Same non-versioned, non-`updated_at`-
   * bumping semantics as `setRecipeUpcoming` - favorite is a personal
   * bookmark, not recipe content, so it skips `recipe_versions` and
   * does not reshuffle the recency sort.
   */
  async setRecipeFavorite(id: string, favorite: boolean): Promise<void> {
    const { error } = await this.client
      .from('recipes')
      .update({ favorite })
      .eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  async deleteRecipe(id: string): Promise<void> {
    const { error } = await this.client.from('recipes').delete().eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * List a recipe's full version history, newest first. Cold path —
   * called only when the History panel opens, never as part of the
   * recipe-list bulk fetch.
   */
  async listRecipeVersions(recipeId: string): Promise<RecipeVersion[]> {
    const { data, error } = await this.client
      .from('recipe_versions')
      .select(
        'id, recipe_id, title, source, source_url, cooklang, rating, change_message, created_at'
      )
      .eq('recipe_id', recipeId)
      .order('created_at', { ascending: false });
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as RecipeVersion[];
  }

  async getRecipeVersion(versionId: string): Promise<RecipeVersion | null> {
    const { data, error } = await this.client
      .from('recipe_versions')
      .select(
        'id, recipe_id, title, source, source_url, cooklang, rating, change_message, created_at'
      )
      .eq('id', versionId)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    return (data as RecipeVersion | null) ?? null;
  }

  /**
   * Roll a recipe back to the content of an earlier version. Implemented
   * as a normal update whose patch is the chosen version's snapshot —
   * the revert itself becomes a new version row, so a misclick is
   * recoverable too. Throws if the version belongs to a different
   * recipe (defense against stale UI state passing the wrong id).
   *
   * Photos round-trip through the snapshot too: we read the version's
   * link rows (image ids + labels in display order) and pass them
   * into `photos` on the update patch. Revert restores the exact
   * photo set, order, and captions that were on the recipe at the
   * moment that version was saved.
   */
  async revertRecipe(
    recipeId: string,
    versionId: string,
    changeMessage: string
  ): Promise<Recipe> {
    const v = await this.getRecipeVersion(versionId);
    if (!v) throw new SupabaseError('version not found');
    if (v.recipe_id !== recipeId) {
      throw new SupabaseError('version belongs to a different recipe');
    }
    const photos = await this.listRecipeVersionPhotoInputs(versionId);
    return this.updateRecipe(
      recipeId,
      {
        title: v.title,
        cooklang: v.cooklang,
        source: v.source,
        source_url: v.source_url,
        rating: v.rating,
        photos,
      },
      changeMessage
    );
  }

  // recipe photos --------------------------------------------------------
  //
  // Photos live in two tables: `recipe_images` holds the deduped bytes
  // (one row per (user_id, sha256)), `recipe_version_images` links them
  // to recipe versions. The "current" photo set for a recipe is the
  // links on the recipe's most-recent version. See `supabase/schema.sql`
  // for the full design rationale.

  /**
   * Insert an image into the user's photo library, or return the id of
   * an existing row when the bytes hash matches one already present.
   * Server-side dedup is per-user via the `(user_id, sha256)` unique
   * constraint, so two users uploading the same image each get their
   * own row; the same user uploading the same image twice gets the
   * existing id.
   *
   * Both upload paths converge on this method: the editor's file picker
   * runs after `maybeDownscaleImage`, and the LLM's
   * `recipe_photos_attach` tool runs after copying bytes out of a
   * conversation attachment. Two callers, one dedup contract.
   */
  async upsertRecipeImage(
    sha256: string,
    mimeType: string,
    sizeBytes: number,
    dataBase64: string
  ): Promise<string> {
    // Upload the bytes to the content-addressed key first (idempotent:
    // same sha -> same object, upsert:true), then record the row. The
    // object existing before the row means a reader never sees a row
    // pointing at a missing object.
    const storagePath = await this.uploadRecipeImageObject(sha256, dataBase64, mimeType);
    const { data, error } = await this.client.rpc('recipe_image_upsert', {
      p_sha256: sha256,
      p_mime_type: mimeType,
      p_size_bytes: sizeBytes,
      p_storage_path: storagePath,
    });
    if (error) throw new SupabaseError(error.message);
    if (typeof data !== 'string') {
      throw new SupabaseError('image upsert returned no id');
    }
    return data;
  }

  /**
   * Upload image bytes to the `recipe-images` bucket at the content-
   * addressed key `<user_id>/<sha256>`. Idempotent (upsert:true), so a
   * re-upload of the same image is a harmless overwrite. Returns the
   * object key. Shared by upsertRecipeImage and the one-time migrate.
   */
  async uploadRecipeImageObject(
    sha256: string,
    dataBase64: string,
    mimeType: string
  ): Promise<string> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const path = `${session.user.id}/${sha256}`;
    const { error } = await this.client.storage
      .from('recipe-images')
      .upload(path, base64ToBytes(dataBase64), { contentType: mimeType, upsert: true });
    if (error) throw new SupabaseError(error.message);
    return path;
  }


  /**
   * Fetch the photos currently linked to a recipe, with bytes, in
   * display order. "Currently linked" = on the latest version row.
   * Used by the detail pane and the edit form for thumb rendering.
   *
   * Implemented as a single embedded-select query: pull the latest
   * version row and dive into its link table and the image table in
   * one round-trip. Returns an empty array when the recipe has no
   * photos (or when the recipe has no version row, which shouldn't
   * happen post-versioning rollout but degrades gracefully).
   */
  async listRecipePhotos(recipeId: string): Promise<RecipePhoto[]> {
    const { data, error } = await this.client
      .from('recipe_versions')
      .select(
        'id, recipe_version_images(position, label, recipe_images(id, mime_type, size_bytes, storage_path))'
      )
      .eq('recipe_id', recipeId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    if (!data) return [];
    // PostgREST returns embedded relations as arrays at the type
    // level, even for many-to-one FKs that are guaranteed-single at
    // runtime. The cast through `unknown` is the documented escape
    // hatch for "we know the shape better than the generic types
    // do." Runtime branches below cope with both shapes (single
    // object or single-element array) so we're not making a
    // brittle bet on PostgREST's serialisation mode.
    type ImageEmbed = {
      id: string;
      mime_type: string;
      size_bytes: number;
      storage_path: string | null;
    };
    type LinkRow = {
      position: number;
      label: string | null;
      recipe_images: ImageEmbed | ImageEmbed[] | null;
    };
    const links = (data as unknown as { recipe_version_images?: LinkRow[] | null })
      .recipe_version_images;
    if (!Array.isArray(links)) return [];

    // Collect the rows first, then batch-resolve signed URLs for the
    // bucket objects in a single Storage call.
    const rows: Array<{ img: ImageEmbed; position: number; label: string | null }> = [];
    for (const l of links) {
      const img = Array.isArray(l.recipe_images) ? l.recipe_images[0] : l.recipe_images;
      if (!img) continue;
      rows.push({ img, position: l.position, label: l.label ?? null });
    }

    const paths = rows
      .map((r) => r.img.storage_path)
      .filter((p): p is string => typeof p === 'string');
    const signed = new Map<string, string>();
    if (paths.length > 0) {
      const { data: signedData, error: signErr } = await this.client.storage
        .from('recipe-images')
        .createSignedUrls(paths, RECIPE_IMAGE_SIGNED_URL_TTL_SECONDS);
      if (signErr) throw new SupabaseError(signErr.message);
      for (const entry of signedData ?? []) {
        if (entry.signedUrl && typeof entry.path === 'string') {
          signed.set(entry.path, entry.signedUrl);
        }
      }
    }

    const photos: RecipePhoto[] = [];
    for (const { img, position, label } of rows) {
      const url = (img.storage_path && signed.get(img.storage_path)) || '';
      if (!url) continue; // no bucket object (or signing failed) - skip
      photos.push({
        id: img.id,
        position,
        mime_type: img.mime_type,
        size_bytes: img.size_bytes,
        url,
        label,
      });
    }
    photos.sort((a, b) => a.position - b.position);
    return photos;
  }

  /**
   * Fetch just the image IDs and labels (in order) on a given
   * version. Used by `revertRecipe` to round-trip the photo set
   * without paying for the bytes - the bytes already exist in
   * `recipe_images`, all we need for the revert is the ordered list
   * of `(id, label)` pairs to link onto the new version.
   */
  async listRecipeVersionPhotoInputs(
    versionId: string
  ): Promise<RecipePhotoInput[]> {
    const { data, error } = await this.client
      .from('recipe_version_images')
      .select('image_id, position, label')
      .eq('recipe_version_id', versionId)
      .order('position', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    return (
      (data ?? []) as Array<{ image_id: string; label: string | null }>
    ).map((r) => ({ id: r.image_id, label: r.label ?? null }));
  }

  // User wiki -------------------------------------------------------------

  // --- Wiki articles ---------------------------------------------------

  /**
   * Alphabetical listing of every wiki article for the current user.
   * Sort key is `lower(title)` so case differences ("Apple" vs
   * "apple") fold together. Limit defaults to 500, matching memories
   * - a single user is unlikely to author thousands of
   * encyclopedic articles, and pagination would complicate the
   * client-side store filtering pattern.
   */
  async listWikiArticles(opts: { limit?: number } = {}): Promise<WikiArticle[]> {
    const { data, error } = await this.client
      .from('wiki_articles')
      .select('id, title, content, created_at, updated_at')
      .order('title', { ascending: true })
      .limit(opts.limit ?? 500);
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceWikiArticle(row as Record<string, unknown>));
  }

  /**
   * One offset page of the wiki browse list, alphabetical by title.
   * Powers the sidebar's infinite scroll for the empty-query case; an
   * active search still goes through `searchWikiArticles` (capped, not
   * paged). `id` is the final tiebreak so articles colliding on title
   * keep a stable cross-page order.
   *
   * Ordering is the DB collation's `title ASC`, so the sidebar renders
   * server order verbatim rather than re-sorting with a JS
   * `localeCompare` - a client re-sort over a partial page would
   * disagree with the server's page boundaries and shuffle rows across
   * the seam mid-scroll.
   */
  async listWikiArticlesPage(opts: {
    offset: number;
    pageSize: number;
  }): Promise<OffsetPage<WikiArticle>> {
    const { data, error } = await this.client
      .from('wiki_articles')
      .select('id, title, content, created_at, updated_at')
      .order('title', { ascending: true })
      .order('id', { ascending: true })
      .range(opts.offset, opts.offset + opts.pageSize);
    if (error) throw new SupabaseError(error.message);
    const all = (data ?? []).map((row) =>
      coerceWikiArticle(row as Record<string, unknown>)
    );
    const hasMore = all.length > opts.pageSize;
    return { rows: hasMore ? all.slice(0, opts.pageSize) : all, hasMore };
  }

  async createWikiArticle(args: {
    title: string;
    content: string;
  }): Promise<WikiArticle> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data, error } = await this.client
      .from('wiki_articles')
      .insert({
        user_id: session.user.id,
        title: args.title,
        content: args.content,
      })
      .select('id, title, content, created_at, updated_at')
      .single();
    if (error) throw new SupabaseError(error.message);
    return coerceWikiArticle(data as Record<string, unknown>);
  }

  /**
   * Patch an article's title or content. RLS owner-scopes the update.
   * The schema trigger `clear_wiki_embedding_on_change` nulls the
   * embedding + claim columns when title or content changes so the
   * worker re-embeds on its next poll.
   */
  async updateWikiArticle(
    id: string,
    patch: { title?: string; content?: string }
  ): Promise<WikiArticle> {
    const { data, error } = await this.client
      .from('wiki_articles')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, title, content, created_at, updated_at')
      .single();
    if (error) throw new SupabaseError(error.message);
    return coerceWikiArticle(data as Record<string, unknown>);
  }

  async deleteWikiArticle(id: string): Promise<void> {
    const { error } = await this.client.from('wiki_articles').delete().eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  // Wiki records ---------------------------------------------------------
  //
  // Dated entries linked to a wiki article. The article body owns the
  // consolidated "current state"; records preserve the dated journey.
  // RLS owner-scopes every query; the `wiki_records` table cascades on
  // article delete. updated_at is stamped by a DB trigger, not here.

  /**
   * List records for one article, reverse-chronological by event date.
   * Optional date-range (inclusive) and tag filters. Tags use JSONB
   * containment (`tags @> [...]`) so a row must carry every requested
   * tag (AND semantics) - the GIN index on `tags` backs this.
   */
  async listWikiRecords(
    articleId: string,
    filters: { fromDate?: string; toDate?: string; tags?: string[]; limit?: number } = {}
  ): Promise<WikiRecord[]> {
    let query = this.client
      .from('wiki_records')
      .select(
        'id, article_id, date, content, tags, source_conversation_id, created_at, updated_at'
      )
      .eq('article_id', articleId)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false });
    if (filters.fromDate) query = query.gte('date', filters.fromDate);
    if (filters.toDate) query = query.lte('date', filters.toDate);
    if (filters.tags && filters.tags.length > 0) query = query.contains('tags', filters.tags);
    if (filters.limit) query = query.limit(filters.limit);
    const { data, error } = await query;
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceWikiRecord(row as Record<string, unknown>));
  }

  async getWikiRecord(id: string): Promise<WikiRecord | null> {
    const { data, error } = await this.client
      .from('wiki_records')
      .select(
        'id, article_id, date, content, tags, source_conversation_id, created_at, updated_at'
      )
      .eq('id', id)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    return data ? coerceWikiRecord(data as Record<string, unknown>) : null;
  }

  async createWikiRecord(args: {
    articleId: string;
    date: string;
    content: string;
    tags?: string[];
    sourceConversationId?: string | null;
  }): Promise<WikiRecord> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data, error } = await this.client
      .from('wiki_records')
      .insert({
        user_id: session.user.id,
        article_id: args.articleId,
        date: args.date,
        content: args.content,
        tags: args.tags ?? [],
        source_conversation_id: args.sourceConversationId ?? null,
      })
      .select(
        'id, article_id, date, content, tags, source_conversation_id, created_at, updated_at'
      )
      .single();
    if (error) throw new SupabaseError(error.message);
    const record = coerceWikiRecord(data as Record<string, unknown>);
    await this.appendRecordChangelog(
      record.article_id,
      'record_create',
      record.date,
      record.content
    );
    return record;
  }

  /**
   * Patch a record's date, content, or tags. RLS owner-scopes the
   * update. The `clear_wiki_record_embedding_on_change` trigger nulls
   * the embedding + claim columns when date or content changes so the
   * worker re-embeds; `touch_wiki_record_updated_at` stamps updated_at.
   */
  async updateWikiRecord(
    id: string,
    patch: { date?: string; content?: string; tags?: string[] }
  ): Promise<WikiRecord> {
    const { data, error } = await this.client
      .from('wiki_records')
      .update(patch)
      .eq('id', id)
      .select(
        'id, article_id, date, content, tags, source_conversation_id, created_at, updated_at'
      )
      .single();
    if (error) throw new SupabaseError(error.message);
    const record = coerceWikiRecord(data as Record<string, unknown>);
    await this.appendRecordChangelog(
      record.article_id,
      'record_update',
      record.date,
      record.content
    );
    return record;
  }

  async deleteWikiRecord(id: string): Promise<void> {
    // Read the record first so the changelog row (logged against the
    // surviving parent article) can carry its date + content preview;
    // the record itself is gone after the delete.
    const doomed = await this.getWikiRecord(id);
    const { error } = await this.client.from('wiki_records').delete().eq('id', id);
    if (error) throw new SupabaseError(error.message);
    if (doomed) {
      await this.appendRecordChangelog(
        doomed.article_id,
        'record_delete',
        doomed.date,
        doomed.content
      );
    }
  }

  /**
   * Append a wiki_changelog row for a record write, scoped to the parent
   * article. Best-effort: a record write must not fail because its audit
   * row didn't land (the record is the source of truth; the changelog is
   * a convenience). title_at_change is the parent article's current
   * title, fetched here so the changelog UI renders the row without a
   * join even after the article is later deleted.
   */
  private async appendRecordChangelog(
    articleId: string,
    kind: 'record_create' | 'record_update' | 'record_delete',
    date: string,
    content?: string
  ): Promise<void> {
    try {
      const { data } = await this.client
        .from('wiki_articles')
        .select('title')
        .eq('id', articleId)
        .maybeSingle();
      const title =
        data && typeof (data as { title?: unknown }).title === 'string'
          ? (data as { title: string }).title
          : '(record)';
      await this.createWikiChangelogEntry({
        article_id: articleId,
        kind,
        title_at_change: title,
        message: buildRecordChangelogMessage(kind, date, content),
      });
    } catch {
      // Best-effort - see the doc comment. Swallow so the record write
      // the caller already completed still resolves successfully.
    }
  }

  /**
   * Semantic + substring search across ALL the user's records (every
   * article). Mirrors `searchWikiArticles`: vector hits first, then
   * ILIKE hits the vector path missed, deduped by id, capped at `limit`.
   * Empty query short-circuits to a recent-first listing.
   */
  async searchWikiRecords(opts: {
    query: string;
    queryEmbedding: number[] | null;
    limit?: number;
  }): Promise<WikiRecord[]> {
    const query = opts.query.trim();
    const limit = opts.limit ?? 20;
    if (query.length === 0) {
      const { data, error } = await this.client
        .from('wiki_records')
        .select(
          'id, article_id, date, content, tags, source_conversation_id, created_at, updated_at'
        )
        .order('date', { ascending: false })
        .limit(limit);
      if (error) throw new SupabaseError(error.message);
      return (data ?? []).map((row) => coerceWikiRecord(row as Record<string, unknown>));
    }

    const pattern = ilikeLogicTreePattern(query);
    const ilikePromise = this.client
      .from('wiki_records')
      .select(
        'id, article_id, date, content, tags, source_conversation_id, created_at, updated_at'
      )
      .ilike('content', pattern)
      .order('date', { ascending: false })
      .limit(limit);

    const semanticPromise = opts.queryEmbedding
      ? this.client.rpc('search_wiki_records_by_embedding', {
          query_embedding: opts.queryEmbedding,
          match_limit: limit,
        })
      : Promise.resolve({ data: [] as unknown[], error: null });

    const [ilikeRes, semRes] = await Promise.all([ilikePromise, semanticPromise]);
    if (ilikeRes.error) throw new SupabaseError(ilikeRes.error.message);
    const ilikeRows = (ilikeRes.data ?? []).map((row) =>
      coerceWikiRecord(row as Record<string, unknown>)
    );
    const semanticRows =
      semRes.error !== null
        ? []
        : ((semRes.data ?? []) as unknown[]).map((row) =>
            coerceWikiRecord(row as Record<string, unknown>)
          );

    const out: WikiRecord[] = [];
    const seen = new Set<string>();
    for (const r of semanticRows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      if (out.length >= limit) return out;
    }
    for (const r of ilikeRows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      if (out.length >= limit) return out;
    }
    return out;
  }

  // Documents (Library) --------------------------------------------------
  //
  // Upload flow is two-phase on purpose: createDocument writes the metadata
  // row first (status 'pending', storage_path null), then the caller uploads
  // the binary to the bucket and calls setDocumentStoragePath, then extracts
  // text in the browser and calls setDocumentExtraction.
  // Splitting it this way means a row always exists for the UI to show a
  // "processing" placeholder, and a crash mid-upload leaves a recoverable
  // pending row rather than an orphaned bucket object.

  // --- Library / documents ---------------------------------------------

  async createDocument(args: {
    title: string;
    description?: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<Document> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data, error } = await this.client
      .from('documents')
      .insert({
        user_id: session.user.id,
        title: args.title,
        description: args.description ?? '',
        filename: args.filename,
        mime_type: args.mimeType,
        size_bytes: args.sizeBytes,
      })
      .select(
        'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
      )
      .single();
    if (error) throw new SupabaseError(error.message);
    return coerceDocument(data as Record<string, unknown>);
  }

  async setDocumentStoragePath(id: string, storagePath: string): Promise<void> {
    const { error } = await this.client
      .from('documents')
      .update({ storage_path: storagePath })
      .eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Record the outcome of the browser-side text extraction. On success pass
   * the extracted text and status 'done'; on failure pass status 'failed' and
   * a trimmed error so the Library UI can explain why the doc isn't
   * searchable. The original file stays downloadable either way.
   */
  async setDocumentExtraction(
    id: string,
    result:
      | { status: 'done'; text: string }
      | { status: 'failed'; error: string }
  ): Promise<void> {
    const patch: Record<string, unknown> =
      result.status === 'done'
        ? { extraction_status: 'done', extracted_text: result.text, extraction_error: null }
        : { extraction_status: 'failed', extraction_error: result.error.slice(0, 500) };
    const { error } = await this.client.from('documents').update(patch).eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * One offset page of the Library list, newest first. Powers the drawer's
   * infinite scroll. `id` is the final tiebreak so docs sharing a created_at
   * keep a stable cross-page order.
   */
  async listDocumentsPage(opts: {
    offset: number;
    pageSize: number;
  }): Promise<OffsetPage<Document>> {
    const { data, error } = await this.client
      .from('documents')
      .select(
        'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
      )
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(opts.offset, opts.offset + opts.pageSize);
    if (error) throw new SupabaseError(error.message);
    const all = (data ?? []).map((row) => coerceDocument(row as Record<string, unknown>));
    const hasMore = all.length > opts.pageSize;
    return { rows: hasMore ? all.slice(0, opts.pageSize) : all, hasMore };
  }

  async getDocumentById(id: string): Promise<Document | null> {
    const { data, error } = await this.client
      .from('documents')
      .select(
        'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
      )
      .eq('id', id)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    if (!data) return null;
    return coerceDocument(data as Record<string, unknown>);
  }

  /**
   * Substring search over the user's documents for the Library drawer, newest
   * first. Matches the query against title, description, filename, and the
   * extracted body, so a document surfaces whether the user typed its name or a
   * phrase from inside it. This is the drawer's browse-by-keyword surface; the
   * chat model's precise in-document search is grep_documents (doc_grep).
   */
  async searchDocuments(opts: { query: string; limit?: number }): Promise<Document[]> {
    const query = opts.query.trim();
    if (query.length === 0) return [];
    const pattern = ilikeLogicTreePattern(query);
    const { data, error } = await this.client
      .from('documents')
      .select(
        'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
      )
      .or(
        `title.ilike.${pattern},description.ilike.${pattern},filename.ilike.${pattern},extracted_text.ilike.${pattern}`
      )
      .order('created_at', { ascending: false })
      .limit(opts.limit ?? 100);
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map((row) => coerceDocument(row as Record<string, unknown>));
  }

  /**
   * Patch a document's user-editable metadata (title, description). The
   * extracted body is bound to the original file and is not editable here -
   * replacing content means re-uploading the file.
   */
  async updateDocument(
    id: string,
    patch: { title?: string; description?: string }
  ): Promise<Document> {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.title !== undefined) update.title = patch.title;
    if (patch.description !== undefined) update.description = patch.description;
    const { data, error } = await this.client
      .from('documents')
      .update(update)
      .eq('id', id)
      .select(
        'id, title, description, filename, mime_type, size_bytes, storage_path, extracted_text, extraction_status, extraction_error, created_at, updated_at'
      )
      .single();
    if (error) throw new SupabaseError(error.message);
    return coerceDocument(data as Record<string, unknown>);
  }

  /**
   * Delete a document, its chunks (FK cascade), and its original file in the
   * bucket. The bucket object is removed first; if that fails we still throw
   * before deleting the row, so we never orphan a bucket object behind a
   * deleted row. A leftover row whose object is already gone is the safer
   * failure direction (the UI can retry the delete).
   */
  async deleteDocument(id: string): Promise<void> {
    const doc = await this.getDocumentById(id);
    if (doc?.storage_path) {
      const { error: rmErr } = await this.client.storage
        .from('documents')
        .remove([doc.storage_path]);
      if (rmErr) throw new SupabaseError(rmErr.message);
    }
    const { error } = await this.client.from('documents').delete().eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  // Documents Storage helpers --------------------------------------------

  /**
   * Upload an original file to the private `documents` bucket. The object key
   * convention `<user_id>/<document_id>/<filename>` is what the bucket RLS
   * policy keys on (top-level folder must equal auth.uid()).
   */
  async uploadDocumentFile(args: {
    documentId: string;
    filename: string;
    file: Blob;
    contentType: string;
  }): Promise<string> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const path = `${session.user.id}/${args.documentId}/${args.filename}`;
    const { error } = await this.client.storage
      .from('documents')
      .upload(path, args.file, { contentType: args.contentType, upsert: true });
    if (error) throw new SupabaseError(error.message);
    return path;
  }

  /**
   * Time-limited signed URL for downloading an original file. The bucket is
   * private, so this is the only way the browser surfaces the binary.
   */
  async createDocumentDownloadUrl(storagePath: string, expiresInSeconds = 300): Promise<string> {
    const { data, error } = await this.client.storage
      .from('documents')
      .createSignedUrl(storagePath, expiresInSeconds);
    if (error) throw new SupabaseError(error.message);
    return data.signedUrl;
  }

  // Documents grep / read helpers ----------------------------------------
  //
  // The deterministic grep-then-read pair the chat model uses on a document.
  // Both run server-side over documents.extracted_text (see grep_documents /
  // read_document_lines in schema.sql) so a multi-MB document's text never
  // crosses the wire - only matching snippets or the requested line range come
  // back.

  // --- Wiki sources, changelog & agent runs ----------------------------

  /**
   * Return the bibliography for one article: every thread that has
   * been attributed, joined with the thread's title, ordered by
   * `last_processed_at` ascending so the reader sees the article's
   * narrative of growth (oldest contributing conversation first).
   *
   * Threads hard-deleted out from under their attribution rows show
   * up with a null title until the cascade catches up; the UI handles
   * that with a placeholder.
   */
  async listWikiArticleSources(articleId: string): Promise<WikiArticleSource[]> {
    const { data, error } = await this.client
      .from('wiki_article_sources')
      .select('thread_id, first_processed_at, last_processed_at, threads(title)')
      .eq('article_id', articleId)
      .order('last_processed_at', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    const out: WikiArticleSource[] = [];
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const threadId = row.thread_id;
      if (typeof threadId !== 'string') continue;
      const thread = row.threads as { title?: unknown } | null;
      const title =
        thread && typeof thread.title === 'string' ? thread.title : null;
      out.push({
        thread_id: threadId,
        thread_title: title,
        first_processed_at: String(row.first_processed_at ?? ''),
        last_processed_at: String(row.last_processed_at ?? ''),
      });
    }
    return out;
  }

  /**
   * Batched source-thread lookup for a candidate set of article ids.
   * Returns a Map keyed by article id whose value is the set of thread
   * ids that fed that article. Articles with no rows in
   * `wiki_article_sources` are absent from the map (orphan articles -
   * never written from a recorded conversation).
   *
   * Powers the sole-source exclusion in `searchWikiArticlesSemantic`
   * (src/lib/wiki.ts, the `excludeSoleSourceThreadId` option; the
   * venice function's wiki_search carries the same filter on its tool
   * context): the recall path needs to know
   * "is the current thread the ONLY source of this article?", which is
   * cheaper to answer against an in-memory map of all sources for the
   * returned candidates than as a per-article round-trip. Empty input
   * returns an empty Map without a round-trip.
   */
  async listSourceThreadIdsForArticles(
    articleIds: readonly string[]
  ): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    if (articleIds.length === 0) return out;
    const { data, error } = await this.client
      .from('wiki_article_sources')
      .select('article_id, thread_id')
      .in('article_id', [...articleIds]);
    if (error) throw new SupabaseError(error.message);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const articleId = row.article_id;
      const threadId = row.thread_id;
      if (typeof articleId !== 'string' || typeof threadId !== 'string') continue;
      const set = out.get(articleId);
      if (set) set.add(threadId);
      else out.set(articleId, new Set([threadId]));
    }
    return out;
  }

  /**
   * See Also for an article. Single RPC call; the floor calculation
   * (minimum cosine similarity between the article and its source
   * conversations) lives server-side so the client never has to fetch
   * raw embeddings.
   *
   * Returns an empty array when the article has no embedding yet (the
   * embeddings worker hasn't caught up after a content change),
   * when no other articles clear the floor, or when there are simply
   * no other articles. All three are honest "nothing to suggest".
   */
  async findRelatedWikiArticles(
    articleId: string,
    limit = 5
  ): Promise<WikiArticleRelated[]> {
    const { data, error } = await this.client.rpc('find_related_wiki_articles', {
      p_article_id: articleId,
      p_limit: limit,
    });
    if (error) throw new SupabaseError(error.message);
    const out: WikiArticleRelated[] = [];
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const id = row.id;
      const title = row.title;
      const similarity = row.similarity;
      if (typeof id !== 'string' || typeof title !== 'string') continue;
      out.push({
        id,
        title,
        similarity: typeof similarity === 'number' ? similarity : 0,
      });
    }
    return out;
  }

  /**
   * Append a wiki-changelog row. Called by every wiki write path: the
   * three tools (`wiki_create`/`wiki_update`/`wiki_delete`), the
   * librarian's same three tools, and the user's direct edits in
   * Wiki.svelte. Throws on a failed insert so callers can decide
   * whether to surface the error or swallow it - the tool path
   * currently swallows (the mutation already landed; a missed
   * changelog row is a smaller harm than a confusing post-success
   * error).
   *
   * `article_id` is null for deletes (the article is already gone by
   * the time this lands). For create/update it points at the live
   * article; if the article is later deleted the FK cascades to null
   * but `title_at_change` keeps the row meaningful.
   */
  async createWikiChangelogEntry(args: {
    article_id: string | null;
    kind: WikiChangelogKind;
    title_at_change: string;
    message: string;
  }): Promise<void> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const title = args.title_at_change.trim();
    const message = args.message.trim();
    if (title.length === 0 || message.length === 0) return;
    const { error } = await this.client.from('wiki_changelog').insert({
      user_id: session.user.id,
      article_id: args.article_id,
      kind: args.kind,
      title_at_change: title,
      message,
    });
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Paged listing of the wiki changelog, newest first. `before` is the
   * exclusive cursor in `created_at desc` order - pass the last entry's
   * `created_at` from the prior page to fetch the next one. The
   * (user_id, created_at desc) index makes this a one-row-per-page
   * range scan rather than a sort, so the modal can lazy-load deep
   * history cheaply.
   */
  async listWikiChangelog(opts: {
    limit?: number;
    before?: string | null;
  } = {}): Promise<WikiChangelogEntry[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    let q = this.client
      .from('wiki_changelog')
      .select('id, article_id, kind, title_at_change, message, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (opts.before) q = q.lt('created_at', opts.before);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    const out: WikiChangelogEntry[] = [];
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const entry = coerceWikiChangelogEntry(row);
      if (entry) out.push(entry);
    }
    return out;
  }

  /**
   * Nuke the wiki subsystem for the current user. Deletes every
   * `wiki_articles` row and nulls `last_wiki_processed_msg_id` + the
   * wiki claim columns on the user's threads so the per-conversation
   * agent re-evaluates from scratch. Wraps both statements in a single
   * server-side transaction (see `reset_wiki_data` in schema.sql) so
   * the articles and the per-thread pipeline state stay in lockstep.
   *
   * Callers (Settings -> Wiki -> Reset) MUST gate this behind an
   * explicit user confirmation - it's irreversible.
   */
  async resetWikiData(): Promise<void> {
    const { error } = await this.client.rpc('reset_wiki_data');
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Semantic + substring search over wiki articles. Vector hits first
   * (RPC), then unembedded ILIKE hits, deduped by id. Empty `query`
   * returns the alphabetical listing without embedding.
   * `queryEmbedding` may be null - callers without Venice get
   * ILIKE-only results.
   */
  async searchWikiArticles(opts: {
    query: string;
    queryEmbedding: number[] | null;
    limit?: number;
  }): Promise<WikiArticle[]> {
    const query = opts.query.trim();
    const limit = opts.limit ?? 20;
    if (query.length === 0) return this.listWikiArticles({ limit });

    const pattern = ilikeLogicTreePattern(query);

    const ilikePromise = this.client
      .from('wiki_articles')
      .select('id, title, content, created_at, updated_at')
      .or(`title.ilike.${pattern},content.ilike.${pattern}`)
      .order('title', { ascending: true })
      .limit(limit);

    const semanticPromise = opts.queryEmbedding
      ? this.client.rpc('search_wiki_articles_by_embedding', {
          query_embedding: opts.queryEmbedding,
          match_limit: limit,
        })
      : Promise.resolve({ data: [] as unknown[], error: null });

    const [ilikeRes, semRes] = await Promise.all([ilikePromise, semanticPromise]);
    if (ilikeRes.error) throw new SupabaseError(ilikeRes.error.message);
    const ilikeRows = (ilikeRes.data ?? []).map((row) =>
      coerceWikiArticle(row as Record<string, unknown>)
    );
    const semanticRows =
      semRes.error !== null
        ? []
        : ((semRes.data ?? []) as unknown[]).map((row) =>
            coerceWikiArticle(row as Record<string, unknown>)
          );

    const out: WikiArticle[] = [];
    const seen = new Set<string>();
    // Semantic first - meaning matches outrank substring matches.
    for (const a of semanticRows) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
      if (out.length >= limit) return out;
    }
    for (const a of ilikeRows) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
      if (out.length >= limit) return out;
    }
    return out;
  }

  // Wiki background pipeline ---------------------------------------------

  /**
   * List the user's wiki-skipped threads, most recent first. The
   * Wiki tab's Skipped panel renders this; a row drops off the list
   * automatically when the next successful wiki run on that thread
   * clears the skip marker (mark_thread_wiki_processed_if_claimed
   * nulls both columns in one update).
   */
  async listWikiSkippedThreads(): Promise<
    {
      threadId: string;
      title: string | null;
      lastSkipAt: string;
      lastSkipReason: string | null;
    }[]
  > {
    const { data, error } = await this.client.rpc('list_wiki_skipped_threads');
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      thread_id: string;
      title: string | null;
      last_skip_at: string;
      last_skip_reason: string | null;
    }[];
    return rows.map((r) => ({
      threadId: r.thread_id,
      title: r.title,
      lastSkipAt: r.last_skip_at,
      lastSkipReason: r.last_skip_reason,
    }));
  }

  /**
   * Ask the venice function to re-run the wiki agent against one
   * skipped thread (the Skipped panel's Retry button). The whole
   * claim-free retry cycle - terminal-message resolution, the agent's
   * tool loop with the content-filter fallback, the pointer advance
   * that clears the skip marker - runs server-side; this is a thin
   * authenticated POST. Agent-level failures come back as
   * `kind: 'error'` in the union (an application outcome, not a
   * transport error); only transport/auth failures throw.
   */
  async retryWikiThread(threadId: string): Promise<WikiRetryResult> {
    const { data, error } = await this.client.functions.invoke('venice/wiki-retry', {
      body: { threadId },
    });
    if (error) throw await veniceFunctionError(error);
    const result = data as Partial<WikiRetryResult> | null;
    // Boundary validation: the function returns the union below; an
    // unrecognised shape collapses to an error result rather than
    // letting a malformed payload masquerade as success.
    if (result && result.kind === 'ok' && typeof result.terminalMsgId === 'string') {
      return {
        kind: 'ok',
        terminalMsgId: result.terminalMsgId,
        toolCalls: typeof result.toolCalls === 'number' ? result.toolCalls : 0,
        reasoning: typeof result.reasoning === 'string' ? result.reasoning : '(none)',
      };
    }
    if (result && result.kind === 'no-op' && typeof result.reason === 'string') {
      return { kind: 'no-op', reason: result.reason };
    }
    if (result && result.kind === 'error' && typeof result.error === 'string') {
      return { kind: 'error', error: result.error };
    }
    return { kind: 'error', error: 'wiki-retry returned an unrecognised response' };
  }

  /**
   * Ask the venice function to run the manual per-article wiki agent
   * (the "Ask agent to update" panel). The prompt build, the single
   * JSON completion, and the article + record reads all happen
   * server-side; this is a thin authenticated POST. Returns the
   * preview / noop the panel renders. The function's union also has a
   * kind:'error' for parse / read / transport failures - this method
   * turns that (and any transport/auth failure) into a thrown Error so
   * the panel's existing catch shows a retry banner; callers only ever
   * see preview or noop on a resolved promise.
   */
  async runWikiManualUpdate(args: {
    articleId: string;
    instructions: string;
  }): Promise<WikiManualUpdateResult> {
    const { data, error } = await this.client.functions.invoke('venice/wiki-manual-update', {
      body: { articleId: args.articleId, instructions: args.instructions },
    });
    if (error) throw await veniceFunctionError(error);
    // Boundary validation: the function returns the preview / noop /
    // error union below. An error outcome becomes a throw (the panel
    // wants a banner, not an inline kind); an unrecognised shape throws
    // too rather than masquerading as a no-op.
    const result = data as
      | Partial<WikiManualUpdateResult>
      | { kind?: string; error?: unknown }
      | null;
    if (
      result &&
      result.kind === 'preview' &&
      typeof (result as { title?: unknown }).title === 'string' &&
      typeof (result as { content?: unknown }).content === 'string'
    ) {
      const preview = result as Extract<WikiManualUpdateResult, { kind: 'preview' }>;
      return {
        kind: 'preview',
        title: preview.title,
        content: preview.content,
        reason: typeof preview.reason === 'string' ? preview.reason : '',
        recordOps: Array.isArray(preview.recordOps) ? preview.recordOps : [],
      };
    }
    if (result && result.kind === 'noop') {
      const reason =
        typeof (result as { reason?: unknown }).reason === 'string'
          ? (result as { reason: string }).reason
          : 'No change applied.';
      return { kind: 'noop', reason };
    }
    if (
      result &&
      result.kind === 'error' &&
      typeof (result as { error?: unknown }).error === 'string'
    ) {
      throw new Error((result as { error: string }).error);
    }
    throw new Error('wiki-manual-update returned an unrecognised response');
  }

  /**
   * Ask the venice function to run the wiki librarian now (the Wiki
   * panel's sparkles button). The whole run - article snapshot,
   * prompt build, the tool loop, the in-flight guard shared with the
   * scheduled sweep and the chat-dispatched path - happens
   * server-side; this is a thin authenticated POST. `runId` is the
   * client-minted demux key for the live step events: subscribe via
   * subscribeToAgentRunProgress BEFORE calling this, or the first
   * events race the subscription.
   */
  async runWikiLibrarian(args: {
    instructions: string | null;
    runId: string;
  }): Promise<void> {
    // Detached route: the body is {accepted:true} and the run continues
    // in the background past the gateway window. The outcome arrives
    // later as a `result` event on the agent-runs channel (await it via
    // awaitDetachedRun), so this POST only KICKS the run - a non-error
    // response means accepted. A transport/auth failure throws.
    const { error } = await this.client.functions.invoke('venice/wiki-librarian-run', {
      body: { instructions: args.instructions, runId: args.runId },
    });
    if (error) throw await veniceFunctionError(error);
  }

  /**
   * Ask the venice function to run the rem (associative integration)
   * memory-librarian pass now (the Memories panel's manual button).
   * The whole run - eligibility pick, prompt build, the tool loop,
   * the in-flight guard shared with the scheduled sweeps and the
   * deep-sleep paths - happens server-side; this is a thin
   * authenticated POST. `runId` is the client-minted demux key for
   * the live step events: subscribe via subscribeToAgentRunProgress
   * BEFORE calling this, or the first events race the subscription.
   */
  async runRem(args: { runId: string }): Promise<void> {
    // Detached route: the body is {accepted:true} and the run continues
    // in the background past the gateway window. The RemRunResult arrives
    // later as a `result` event on the agent-runs channel (await it via
    // awaitDetachedRun), so this POST only KICKS the run - a non-error
    // response means accepted. A transport/auth failure throws.
    const { error } = await this.client.functions.invoke('venice/rem-run', {
      body: { runId: args.runId },
    });
    if (error) throw await veniceFunctionError(error);
  }

  /**
   * Ask the venice function to run the deep-sleep memory-librarian
   * pass now. Same contract as runRem (and the wiki librarian's
   * runWikiLibrarian): subscribe to the progress channel before the
   * POST; the in-flight collision comes back as kind 'busy'.
   */
  async runDeepSleep(args: { runId: string }): Promise<void> {
    // Detached route, same contract as runRem: returns {accepted:true};
    // the DeepSleepRunResult arrives as a `result` event on the
    // agent-runs channel (await via awaitDetachedRun). KICK only.
    const { error } = await this.client.functions.invoke('venice/deep-sleep-run', {
      body: { runId: args.runId },
    });
    if (error) throw await veniceFunctionError(error);
  }

  // Thread response claim --------------------------------------------------
  //
  // Per-thread cross-device claim used by the chat-loop to mark "this
  // device is producing the response right now." Observer devices see
  // the claim on the threads realtime channel and gate their composer
  // accordingly. See `acquire_thread_response_claim` and siblings in
  // `supabase/schema.sql` for the atomic semantics, and
  // `ThreadClaimCoordinator` in `src/lib/exchange/thread-claim-coordinator.ts`
  // for the heartbeat-loop wrapper.
  //
  // Distinct from the worker_leases above: those are user-level
  // singletons partitioned by `workerKind`; these are per-thread,
  // keyed on the thread row itself.

  // --- Thread response claims ------------------------------------------

  /**
   * Try to take the response claim on `threadId`. Returns true iff we
   * hold it after the call. Atomic: the underlying SQL update only
   * lands if the thread is unclaimed, ours already (harmless refresh),
   * or carrying an expired claim. A `false` return means another
   * device beat us to the claim and still owns a live TTL window.
   */
  async acquireThreadResponseClaim(
    threadId: string,
    holderId: string,
    ttlSeconds: number
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('acquire_thread_response_claim', {
      p_thread_id: threadId,
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /**
   * Extend our claim on `threadId`. Returns false when the claim has
   * already lapsed or been taken over - the chat-loop must abort
   * immediately in that case to avoid a double-response race with the
   * new holder.
   */
  async heartbeatThreadResponseClaim(
    threadId: string,
    holderId: string,
    ttlSeconds: number
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc('heartbeat_thread_response_claim', {
      p_thread_id: threadId,
      p_holder_id: holderId,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new SupabaseError(error.message);
    return data === true;
  }

  /**
   * Release the claim on `threadId` explicitly on graceful end-of-turn
   * (success, abort, error). Lets observer devices re-enable their
   * composer instantly rather than waiting for the TTL to elapse.
   * No-op when we don't actually hold the claim.
   */
  async releaseThreadResponseClaim(threadId: string, holderId: string): Promise<void> {
    const { error } = await this.client.rpc('release_thread_response_claim', {
      p_thread_id: threadId,
      p_holder_id: holderId,
    });
    if (error) throw new SupabaseError(error.message);
  }

  // --- Topic vocabularies ----------------------------------------------

  /**
   * Topic vocabulary + per-topic counts for the current user. Backs the
   * drawer's topic-filter dropdown; called on drawer mount and
   * refreshed after a tagging event. Returns the alphabetised topics
   * the server-side topics agent has assigned across all threads, each with its corpus
   * count, plus the count of zero-topic threads (the "(untagged)"
   * dropdown row the UI synthesises - never a member of `topics`).
   */
  async listUserTopics(): Promise<TopicVocabulary> {
    const { data, error } = await this.client.rpc('list_user_topics');
    if (error) throw new SupabaseError(error.message);
    return parseTopicVocabulary(data);
  }

  /**
   * Memory-topic vocabulary + per-topic counts for the current user.
   * Backs the Memories drawer's topic-filter dropdown; called on drawer
   * mount and refreshed after a tagging event. Counts span the whole
   * memory corpus, not the capped search-result set the panel holds.
   * The "(untagged)" pseudo-topic is NOT in `topics` - the UI
   * synthesises it from the `untagged` count.
   */
  async listUserMemoryTopics(): Promise<TopicVocabulary> {
    const { data, error } = await this.client.rpc('list_user_memory_topics');
    if (error) throw new SupabaseError(error.message);
    return parseTopicVocabulary(data);
  }

  /**
   * Recipe-topic vocabulary + per-topic counts for the current user.
   * Backs the Cookbook drawer's topic-filter dropdown. Distinct from
   * `listUserTopics` (threads) and `listUserMemoryTopics`
   * (memories) so a user's vocabularies don't cross-pollute.
   */
  async listUserRecipeTopics(): Promise<TopicVocabulary> {
    const { data, error } = await this.client.rpc('list_user_recipe_topics');
    if (error) throw new SupabaseError(error.message);
    return parseTopicVocabulary(data);
  }

  // --- Memory confidence, search & relations ---------------------------

  /**
   * Chat-side reaffirm: +0.5 capped at 10.0. Gentler than the reflection
   * agent's bump (+1.0) because it fires mid-turn on a single exchange
   * rather than on settled evidence across a conversation. Returns the
   * post-adjustment value so the tool result can echo it to the LLM.
   */
  async reaffirmMemoryConfidence(id: string): Promise<number | null> {
    const { data, error } = await this.client.rpc(
      'reaffirm_memory_confidence',
      { p_id: id }
    );
    if (error) throw new SupabaseError(error.message);
    return typeof data === 'number' ? data : null;
  }

  /**
   * Chat-side doubt: ×0.7 with no floor. Gentler than the reflection
   * agent's decay (×0.5). Five doubts from 1.0 lands around 0.168
   * ([shaky] tag territory) without crashing below the 0.05 search-hide
   * floor in one hit.
   */
  async doubtMemoryConfidence(id: string): Promise<number | null> {
    const { data, error } = await this.client.rpc('doubt_memory_confidence', {
      p_id: id,
    });
    if (error) throw new SupabaseError(error.message);
    return typeof data === 'number' ? data : null;
  }

  /**
   * Cosine-similarity search via the `search_memories_by_embedding` RPC.
   * The RPC enforces `user_id = auth.uid()` in addition to RLS and hides
   * the `embedding` column from the response — 2048 floats per row is a
   * lot to ship back just to throw away. Confidence rides the row so
   * consumers can format the qualitative tag without a second round-trip.
   */
  async searchMemoriesByEmbedding(
    queryEmbedding: number[],
    limit: number
  ): Promise<Memory[]> {
    const { data, error } = await this.client.rpc('search_memories_by_embedding', {
      query_embedding: queryEmbedding,
      match_limit: limit,
    });
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as Memory[];
  }

  /**
   * Top-k memories most similar to a given memory, via the
   * `search_memories_similar` RPC. The source row's own stored
   * embedding is the query vector, so the ranking matches
   * `searchMemoriesByEmbedding`; the source is excluded server-side so
   * it never lists itself. Returns an empty array when the source
   * hasn't been embedded yet (the worker hasn't caught up) - the caller
   * shows an empty state. Each row carries its `similarity` match score
   * (the value the RPC ranks on); the embedding column itself is never
   * shipped.
   */
  async searchSimilarMemories(
    memoryId: string,
    limit: number
  ): Promise<SimilarMemory[]> {
    const { data, error } = await this.client.rpc('search_memories_similar', {
      p_memory_id: memoryId,
      match_limit: limit,
    });
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as SimilarMemory[];
  }

  /**
   * Insert a new edge in the memory-relations graph. The unique
   * constraint on (user_id, from_memory_id, to_memory_id, kind) means a
   * repeated call for the same edge raises; the tool-side handler maps
   * that to a friendlier "already exists" payload. Self-loops are
   * rejected at the tool boundary, not here.
   */
  async createMemoryRelation(
    fromId: string,
    toId: string,
    kind: MemoryRelation['kind'],
    note: string | null
  ): Promise<{ id: string; kind: MemoryRelation['kind'] }> {
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const { data, error } = await this.client
      .from('memory_relations')
      .insert({
        user_id: session.user.id,
        from_memory_id: fromId,
        to_memory_id: toId,
        kind,
        note,
      })
      .select('id, kind')
      .single();
    if (error) throw new SupabaseError(error.message);
    return data as { id: string; kind: MemoryRelation['kind'] };
  }

  /**
   * Delete a single relation by id. RLS scopes the delete to the
   * signed-in user's own rows; a wrong id (or another user's edge) is
   * silently a no-op, matching the rest of the CRUD surface here.
   */
  async deleteMemoryRelation(id: string): Promise<void> {
    const { error } = await this.client
      .from('memory_relations')
      .delete()
      .eq('id', id);
    if (error) throw new SupabaseError(error.message);
  }

  /**
   * Outbound edges for a batch of memory ids, joined to the target
   * memory's display fields. Used by opening-recall (bounded traversal),
   * the memory_search tool (graph context alongside hits), and
   * Memories.svelte (per-row edge panel). Returns an empty array if
   * `ids` is empty so callers can skip a conditional.
   */
  async listMemoryRelationsFor(ids: string[]): Promise<MemoryRelation[]> {
    if (ids.length === 0) return [];
    const { data, error } = await this.client.rpc('get_memory_relations', {
      p_ids: ids,
    });
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as MemoryRelation[];
  }

  /**
   * ILIKE fallback, scoped to rows the worker hasn't embedded yet. Used
   * by `memory_search` to fill in results for just-created memories —
   * without this, a memory the user wrote seconds ago would be invisible
   * until the worker catches up.
   */
  async searchUnembeddedMemoriesByText(
    query: string,
    limit: number,
    selectedTopics: readonly string[] = []
  ): Promise<Memory[]> {
    if (!query || query.length === 0) return [];
    const pattern = ilikeLogicTreePattern(query);
    let q = this.client
      .from('memories')
      .select('id, label, data, confidence, topics, created_at, updated_at')
      .is('embedding', null)
      .or(`label.ilike.${pattern},data.ilike.${pattern}`)
      .order('updated_at', { ascending: false })
      .limit(limit);
    // Server-side topic filter on the just-written rows. Vector hits
    // are filtered client-side inside searchMemoriesSemantic (the RPC
    // returns `topics` on each row), so the two halves of the merged
    // result set agree on what "the filter is active" means without
    // needing to refactor the embedding RPC to take topic args.
    const topicsClause = topicsFilterClause(selectedTopics);
    if (topicsClause) q = q.or(topicsClause);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    return (data ?? []) as Memory[];
  }

  // --- Messages & attachments ------------------------------------------

  async listMessages(threadId: string): Promise<Message[]> {
    const { data, error } = await this.client
      .from('messages')
      .select('*')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    const messages = (data ?? []) as Message[];
    // Hydrate attachments in a second query keyed by message id. Keeps
    // the base SELECT cheap (no large base64 payloads on the wire for
    // rows without attachments, which is the common case) and lets
    // the realtime subscribe path reuse the same hydration helper
    // later.
    // User rows carry uploads; assistant rows carry generate_image
    // output (attached at end of turn by the chat-loop). Both hydrate
    // through the same query; tool / system rows never carry
    // attachments so they're left out to keep the IN-list small.
    const attachableIds = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => m.id);
    if (attachableIds.length > 0) {
      const attachmentsByMessageId = await this.listAttachmentsByMessageIds(attachableIds);
      for (const m of messages) {
        if (m.role === 'user' || m.role === 'assistant') {
          m.attachments = attachmentsByMessageId.get(m.id) ?? [];
        }
      }
    }
    // Repair an interrupted-exchange tail in memory so every reader -
    // chat UI, summary worker, reflection worker, recall agents,
    // samskara worker, wiki worker - sees a wire-format-valid
    // sequence. The synthesized rows ride through the wire projection
    // like normal rows; the chat-loop's send path persists them ahead
    // of the next user turn so the DB heals on revisit. See
    // lib/conversation-recovery.ts for the cases handled.
    return synthesizeRecoveryMessages(messages);
  }

  /**
   * Fetch every attachment belonging to the given user-message ids, in
   * one round trip. Returns a map keyed by `message_id` so the caller
   * can hang the array straight onto each message. Ordered by
   * `position` within each bucket so the message renderer doesn't have
   * to re-sort.
   *
   * Used by `listMessages` for the initial load and by the realtime
   * subscription path when a user row arrives with attachments.
   */
  async listAttachmentsByMessageIds(
    messageIds: string[]
  ): Promise<Map<string, Attachment[]>> {
    const result = new Map<string, Attachment[]>();
    if (messageIds.length === 0) return result;
    // Bytes are NOT projected - they live in the `attachments` bucket
    // (pointed at by storage_path) and are fetched on demand via a
    // signed URL. Thread load carries metadata only, so a thread full of
    // images no longer ships megabytes of base64 on every open.
    const { data, error } = await this.client
      .from('message_attachments')
      .select(
        'id, message_id, position, filename, mime_type, size_bytes, storage_path, extracted_text, expired_at, created_at'
      )
      .in('message_id', messageIds)
      .order('position', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    for (const row of (data ?? []) as Attachment[]) {
      const existing = result.get(row.message_id) ?? [];
      existing.push({
        id: row.id,
        message_id: row.message_id,
        position: row.position,
        filename: row.filename,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        storage_path: typeof row.storage_path === 'string' ? row.storage_path : null,
        extracted_text: row.extracted_text,
        expired_at: row.expired_at,
        created_at: row.created_at,
      });
      result.set(row.message_id, existing);
    }
    return result;
  }

  /**
   * Bulk-insert attachments for a just-written message. For each row we
   * mint the attachment id client-side, upload its bytes to the
   * `attachments` bucket at `<user_id>/<id>/<filename>`, then insert the
   * row carrying `storage_path` (never the bytes). Client-minted ids let
   * the upload and the insert reference the same path in one pass.
   *
   * Returns the hydrated rows (with `storage_path` set, bytes left in the
   * bucket) so the caller can append them to the in-memory message; the
   * UI fetches a signed URL when it needs to render them.
   */
  async addAttachments(
    messageId: string,
    rows: NewAttachment[]
  ): Promise<Attachment[]> {
    if (rows.length === 0) return [];
    const session = await this.getSession();
    if (!session) throw new SupabaseError('Not authenticated.');
    const userId = session.user.id;

    const prepared = await Promise.all(
      rows.map(async (r) => {
        const id = crypto.randomUUID();
        const path = `${userId}/${id}/${r.filename}`;
        const { error: upErr } = await this.client.storage
          .from('attachments')
          .upload(path, base64ToBytes(r.data_base64), {
            contentType: r.mime_type,
            upsert: true,
          });
        if (upErr) throw new SupabaseError(upErr.message);
        return {
          id,
          message_id: messageId,
          position: r.position,
          filename: r.filename,
          mime_type: r.mime_type,
          size_bytes: r.size_bytes,
          storage_path: path,
          extracted_text: r.extracted_text,
        };
      })
    );

    const { data, error } = await this.client
      .from('message_attachments')
      .insert(prepared)
      .select(
        'id, message_id, position, filename, mime_type, size_bytes, storage_path, extracted_text, expired_at, created_at'
      );
    if (error) throw new SupabaseError(error.message);
    return ((data ?? []) as Attachment[]).map((row) => ({
      id: row.id,
      message_id: row.message_id,
      position: row.position,
      filename: row.filename,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      storage_path: typeof row.storage_path === 'string' ? row.storage_path : null,
      extracted_text: row.extracted_text,
      expired_at: row.expired_at,
      created_at: row.created_at,
    }));
  }

  /**
   * A short-lived signed URL per attachment id, for rendering image
   * previews / download links and for handing image bytes to Venice (its
   * vision input fetches public URLs). Skips expired attachments
   * (storage_path null). Batched into one Storage call. Best-effort: an
   * attachment whose signed URL can't be minted is simply omitted from
   * the map rather than failing the whole batch.
   */
  async createAttachmentSignedUrls(
    attachments: readonly Pick<Attachment, 'id' | 'storage_path'>[],
    expiresInSeconds = 3600
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const live = attachments.filter(
      (a): a is { id: string; storage_path: string } => typeof a.storage_path === 'string'
    );
    if (live.length === 0) return out;
    const { data, error } = await this.client.storage
      .from('attachments')
      .createSignedUrls(
        live.map((a) => a.storage_path),
        expiresInSeconds
      );
    if (error) throw new SupabaseError(error.message);
    const urlByPath = new Map<string, string>();
    for (const entry of data ?? []) {
      if (entry.signedUrl && typeof entry.path === 'string') {
        urlByPath.set(entry.path, entry.signedUrl);
      }
    }
    for (const a of live) {
      const url = urlByPath.get(a.storage_path);
      if (url) out.set(a.id, url);
    }
    return out;
  }

  /**
   * Find the most recent image attachment in this thread whose filename
   * matches exactly. Returns the row regardless of expiry state - the
   * caller distinguishes "not found" (null return) from "expired"
   * (`data_base64 === null` on the returned row) and produces the right
   * diagnostic for the model.
   *
   * Why thread-scoped instead of message-scoped: the analyze_image tool
   * needs to reach images attached on prior turns of the same conversation,
   * not just the user message that opened the current turn. The earlier
   * design passed only the current message's attachments into ToolContext,
   * which left the model unable to re-analyze an image once the user sent
   * any follow-up message. RLS on `message_attachments` already scopes
   * access to the signed-in user via the via-parent-of-parent chain
   * (attachment -> message -> thread -> user_id), so the join here adds
   * thread filtering without weakening the security model.
   */
  async findImageByFilenameInThread(
    threadId: string,
    filename: string
  ): Promise<Attachment | null> {
    const { data, error } = await this.client
      .from('message_attachments')
      .select(
        'id, message_id, position, filename, mime_type, size_bytes, storage_path, extracted_text, expired_at, created_at, messages!inner(thread_id)'
      )
      .eq('messages.thread_id', threadId)
      .eq('filename', filename)
      .like('mime_type', 'image/%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    if (!data) return null;
    return coerceAttachmentRow(data as Record<string, unknown>);
  }

  /**
   * Lightweight summary of every attachment in a thread, used to render
   * the `<thread_attachments>` system block in chat-loop. Omits
   * `extracted_text` (potentially huge) since the block only needs
   * filenames + categorisation.
   *
   * Live vs expired is read off `expired_at`: the expiry sweep stamps it
   * when it deletes an object, and the one-time legacy reclaim stamped it
   * on pre-bucket rows, so a non-null `expired_at` is equivalent to
   * `storage_path is null` here without projecting storage_path.
   */
  async listAttachmentSummariesForThread(
    threadId: string
  ): Promise<ThreadAttachmentSummary[]> {
    const { data, error } = await this.client
      .from('message_attachments')
      .select(
        'filename, mime_type, expired_at, created_at, messages!inner(thread_id)'
      )
      .eq('messages.thread_id', threadId)
      .order('created_at', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    return ((data ?? []) as Array<{
      filename: string;
      mime_type: string;
      expired_at: string | null;
      created_at: string;
    }>).map((row) => ({
      filename: row.filename,
      mime_type: row.mime_type,
      is_image: row.mime_type.startsWith('image/'),
      expired: row.expired_at !== null,
      created_at: row.created_at,
    }));
  }

  /**
   * Insert one message row and touch the thread's updated_at in a
   * follow-up call. The two writes aren't in a transaction — if the
   * second call fails, we've still saved the message and the thread
   * just keeps its old ordering timestamp until the next activity.
   * That's intentional: losing the message would be a bigger regression
   * than a briefly stale sort order.
   *
   * The optional OpenAI-shape fields let assistant-with-tool-calls and
   * tool-result rows round-trip faithfully. `tool_calls` applies to
   * assistant rows that invoked tools; `tool_call_id` and `name` apply
   * to role='tool' rows pairing the assistant call to its result.
   */
  async addMessage(
    threadId: string,
    role: Message['role'],
    content: string,
    opts: {
      tool_calls?: OpenAIToolCall[] | null;
      tool_call_id?: string | null;
      name?: string | null;
      /** Concrete Venice model id that produced this assistant row. */
      model?: string | null;
      /** Token-usage object returned by the provider for this turn. */
      usage?: TokenUsage | null;
      /** Chain-of-thought text; null when the model didn't produce any. */
      reasoning?: string | null;
      /** Venice web-search citations for this turn. */
      citations?: Citation[] | null;
      /**
       * Override created_at. The column defaults to now() on the
       * server; almost every caller wants that. The exception is
       * the synthetic-recovery persistence path, which heals a
       * wire-shape gap mid-conversation and needs the new row to
       * land at the gap's position in created_at order rather than
       * piling up at the tail.
       */
      created_at?: string;
    } = {}
  ): Promise<Message> {
    // Trim outer whitespace at the write boundary. LLM responses
    // sometimes land with a leading newline or indent (often from
    // Venice's SSE parser peeling the reasoning channel off the
    // content stream), which the markdown renderer interprets as a
    // code-indent and sets the whole reply at a blockquote offset.
    // User inputs occasionally carry trailing blank lines from
    // mobile autocomplete or paste. Trimming at insert keeps the DB
    // canonical; the Markdown component trims at render too so
    // existing rows benefit without a backfill.
    const trimmedContent = content.trim();
    const row: Record<string, unknown> = { thread_id: threadId, role, content: trimmedContent };
    if (opts.tool_calls !== undefined) row.tool_calls = opts.tool_calls;
    if (opts.tool_call_id !== undefined) row.tool_call_id = opts.tool_call_id;
    if (opts.name !== undefined) row.name = opts.name;
    if (opts.model !== undefined) row.model = opts.model;
    if (opts.usage !== undefined) row.usage = opts.usage;
    if (opts.reasoning !== undefined) row.reasoning = opts.reasoning;
    if (opts.citations !== undefined) row.citations = opts.citations;
    if (opts.created_at !== undefined) row.created_at = opts.created_at;
    const { data, error } = await this.client
      .from('messages')
      .insert(row)
      .select()
      .single();
    if (error) throw new SupabaseError(error.message);
    await this.client
      .from('threads')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', threadId);
    return data as Message;
  }

  /**
   * Replace the `content` field on a single `role='tool'` row, located
   * by its (thread_id, tool_call_id) pair. The ONLY caller is the
   * ask_user suspend/resume path: the chat-loop initially writes a
   * pending sentinel as the tool row content, and the UI rewrites it
   * to the real answer payload when the user submits (or to an
   * abandonment payload on refresh / new send / sibling cancel).
   *
   * Scoped to role='tool' at the application layer in addition to the
   * RLS UPDATE policy's role check, so a future caller can't
   * accidentally rewrite an assistant or user row's content through
   * this surface. The tool_call_id pair is unique within a thread
   * (one tool result per call) so `single()` is correct here.
   *
   * Returns the updated row so the caller can append/replace it in
   * the in-memory message list.
   */
  async updateToolMessageContent(
    threadId: string,
    toolCallId: string,
    content: string
  ): Promise<Message> {
    const { data, error } = await this.client
      .from('messages')
      .update({ content })
      .eq('thread_id', threadId)
      .eq('tool_call_id', toolCallId)
      .eq('role', 'tool')
      .select()
      .single();
    if (error) throw new SupabaseError(error.message);
    return data as Message;
  }

  // --- Realtime subscriptions & message fetch --------------------------

  /**
   * Realtime: stream INSERTs for a single thread's messages. Keeps a
   * thread open on two devices in sync — when device A's chat-loop
   * commits a user / assistant / tool row, device B sees it land in
   * the transcript without a refresh. Filtering happens server-side
   * (`filter: thread_id=eq.<id>`), layered on top of RLS so a
   * compromised client can't just listen to other users' threads.
   *
   * The caller is responsible for deduping — the inserting device
   * also receives an echo of its own write, and a race can push the
   * echo ahead of the promise resolution for `addMessage`. Dedupe by
   * `Message.id` at the append site handles both orderings.
   */
  subscribeToMessages(
    threadId: string,
    onMessage: (msg: Message) => void
  ): () => void {
    // Defend the realtime channel: if the consumer throws, the
    // postgres_changes subscription dies silently and the transcript
    // stops receiving echoes for this thread until the user re-selects
    // it. Log and swallow so subsequent echoes still arrive.
    const dispatch = (msg: Message): void => {
      try {
        onMessage(msg);
      } catch (err) {
        log.error('subscribeToMessages handler threw', err);
      }
    };
    const channel = this.client
      .channel(`messages:${threadId}`)
      .on(
        // `postgres_changes` is the realtime-js event shape for
        // replication-stream rows. Typed loose here — the supabase-js
        // generic is over a whole DB schema and we don't have one.
        'postgres_changes' as never,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `thread_id=eq.${threadId}`,
        },
        (payload: { new: Message }) => {
          dispatch(payload.new);
        }
      )
      .on(
        // UPDATE echoes are how the streaming-root assistant row arrives
        // in its terminal state. The function INSERTs the row with
        // `status='streaming'` at first content delta (which the
        // subscriber filters out) and later UPDATEs the same row when
        // the round chain settles - flipping status to `'complete' |
        // 'aborted' | 'error' | 'suspended_for_ask_user'` and pinning
        // the canonical content/reasoning/citations. Without listening
        // for UPDATEs the terminal row would never enter the local
        // `messages` array; the consumer's id-keyed append handles the
        // INSERT-then-UPDATE ordering.
        'postgres_changes' as never,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `thread_id=eq.${threadId}`,
        },
        (payload: { new: Message }) => {
          dispatch(payload.new);
        }
      )
      .subscribe();
    return () => {
      // removeChannel returns a promise but we don't care to await —
      // the caller is teardown path, and stray events after this
      // would be no-ops (the channel is detached). Fire-and-forget
      // matches the onAuthChange unsubscribe contract above.
      void this.client.removeChannel(channel);
    };
  }

  /**
   * Fetch a single message by id. Returns null when the row doesn't
   * exist or is owned by another user (RLS filters those rows out, so
   * the two cases are indistinguishable). Used by the chat-loop at
   * END time to hydrate the assistant row the streaming function just
   * committed so the slot's persistedRows replay buffer carries a
   * canonical record - the realtime UPDATE echo also delivers the
   * same row separately for the live `messages` view, but the
   * end-of-turn synth path needs the row before the echo races in.
   */
  async getMessage(id: string): Promise<Message | null> {
    const { data, error } = await this.client
      .from('messages')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    return (data as Message | null) ?? null;
  }

  /**
   * Realtime: stream INSERT / UPDATE / DELETE on the current user's
   * threads. Keeps the sidebar in sync across devices — a rename on
   * phone reflects on desktop, a newly-created thread appears in the
   * list, and the `updated_at` bump that each message triggers
   * reorders the list newest-first without polling. RLS enforces the
   * user_id scoping; the filter here just narrows the wire traffic.
   *
   * DELETE payloads only carry the primary key (the default
   * `replica identity` — we don't need old-column values), so the
   * handler receives just the id.
   */
  subscribeToThreads(
    userId: string,
    handlers: {
      onInsert?: (thread: Thread) => void;
      onUpdate?: (thread: Thread) => void;
      onDelete?: (id: string) => void;
    }
  ): () => void {
    const channel = this.client
      .channel(`threads:${userId}`)
      .on(
        'postgres_changes' as never,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'threads',
          filter: `user_id=eq.${userId}`,
        },
        (payload: { new: Thread }) => {
          handlers.onInsert?.(payload.new);
        }
      )
      .on(
        'postgres_changes' as never,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'threads',
          filter: `user_id=eq.${userId}`,
        },
        (payload: { new: Thread }) => {
          handlers.onUpdate?.(payload.new);
        }
      )
      .on(
        'postgres_changes' as never,
        {
          event: 'DELETE',
          schema: 'public',
          table: 'threads',
          filter: `user_id=eq.${userId}`,
        },
        (payload: { old: { id: string } }) => {
          handlers.onDelete?.(payload.old.id);
        }
      )
      .subscribe();
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  /**
   * Subscribe to the signed-in user's edge-function log channel. Server-
   * side background work (reflection, and the agent fleets as they
   * migrate off the browser) publishes structured entries to the private
   * `logs:<userId>` Broadcast topic; this feeds each one to `onEntry`,
   * which the caller routes into the Logs drawer via `appendFromEdge`.
   *
   * `private: true` engages the "log channel: owner subscribe" policy on
   * realtime.messages (supabase/schema.sql) - a user only receives their
   * own logs. The edge function publishes under service_role and bypasses
   * the policy. Returns an unsubscribe teardown, same shape as
   * subscribeToThreads.
   */
  subscribeToUserLogs(
    userId: string,
    onEntry: (entry: SerializableLogEntry) => void
  ): () => void {
    const channel = this.client
      .channel(`logs:${userId}`, { config: { private: true } })
      .on('broadcast', { event: 'nak-log' }, ({ payload }) => {
        onEntry(payload as SerializableLogEntry);
      })
      // Surface the channel lifecycle at debug so a future "edge logs
      // aren't reaching the drawer" report can confirm whether the
      // private subscribe reached SUBSCRIBED (vs CHANNEL_ERROR /
      // TIMED_OUT). Drawer-only; not console noise.
      .subscribe((status, err) => {
        log.debug(`logs channel subscribe status: ${status}`, err ?? '');
      });
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  /**
   * Subscribe to any change on the signed-in user's wiki articles.
   * The autonomous wiki agent writes articles server-side (the
   * cron-driven sweep), where the browser's emitWikiChange event bus
   * is unreachable - this replication-stream subscription is how an
   * open Wiki panel learns a background write landed. The caller
   * (Chat.svelte) routes the notification into emitWikiChange so
   * every existing wiki surface refetches through the path it
   * already had.
   *
   * Coarse on purpose: no per-event payloads, just "something
   * changed". The wiki surfaces refetch their own lists; pushing row
   * deltas through would duplicate their loaders for no win.
   */
  /**
   * Read whether a background-agent in-flight lease is currently held
   * for this user. The wiki/memory librarian manual + scheduled runs
   * claim a lease on the profiles row (<agent>_inflight_expires_at);
   * held = a future expiry. RLS lets a user read their own profile.
   * Returns the expiry ISO string when held, else null. The caller
   * derives "running" and arms a timer at the expiry for the crash/TTL
   * case - a lease that lapses without an explicit release writes no
   * row, so no realtime UPDATE fires.
   */
  async getInflightLeaseExpiry(
    userId: string,
    column: InflightLeaseColumn
  ): Promise<string | null> {
    const { data, error } = await this.client
      .from('profiles')
      .select(column)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(`getInflightLeaseExpiry failed: ${error.message}`);
    const exp = (data as Record<string, unknown> | null)?.[column];
    if (typeof exp !== 'string') return null;
    return new Date(exp).getTime() > Date.now() ? exp : null;
  }

  /**
   * Subscribe to in-flight lease transitions for this user via realtime
   * profiles UPDATEs (requires profiles in the supabase_realtime
   * publication - schema.sql). Calls back with the lease expiry ISO when
   * a run claims/holds it, or null when released. Does NOT fire on a TTL
   * lapse (that writes no row) - the caller's expiry timer covers that.
   * Filtering on user_id is safe for UPDATE delivery because the new
   * tuple always carries it (no replica-identity index needed, unlike
   * the DELETE-delivery relays). Returns an unsubscribe.
   */
  subscribeToInflightLease(
    userId: string,
    column: InflightLeaseColumn,
    onChange: (expiry: string | null) => void
  ): () => void {
    const channel = this.client
      .channel(`inflight_lease:${column}:${userId}`)
      .on(
        'postgres_changes' as never,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles',
          filter: `user_id=eq.${userId}`,
        },
        (payload: { new?: Record<string, unknown> | null }) => {
          const exp = payload.new?.[column];
          if (typeof exp !== 'string') {
            onChange(null);
            return;
          }
          onChange(new Date(exp).getTime() > Date.now() ? exp : null);
        }
      )
      .subscribe();
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  /**
   * Read the most-recent manual-run outcome for this user from the
   * `*_last_run_outcome` profiles column. Returns the coerced envelope
   * (runId / source / finishedAt / result) or null when no run has
   * finished yet or the stored shape is unrecognised. Paired with
   * subscribeToLastRunOutcome: this is the on-mount read that recovers a
   * run that finished while the tab was away; the subscription delivers
   * one that finishes while the tab is open. RLS lets a user read their
   * own profile.
   */
  async getLastRunOutcome(
    userId: string,
    column: LastRunOutcomeColumn
  ): Promise<ManualRunOutcome | null> {
    const { data, error } = await this.client
      .from('profiles')
      .select(column)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(`getLastRunOutcome failed: ${error.message}`);
    return coerceManualRunOutcome((data as Record<string, unknown> | null)?.[column]);
  }

  /**
   * Subscribe to manual-run-outcome writes for this user via realtime
   * profiles UPDATEs (the same row + publication the in-flight lease
   * rides). The venice function writes the outcome column when a detached
   * run finishes, so the UPDATE's new tuple carries the fresh envelope -
   * delivering it race-free without a re-read. Calls back with the
   * coerced outcome, or null if the new tuple's column is empty/garbage.
   * Returns an unsubscribe.
   */
  subscribeToLastRunOutcome(
    userId: string,
    column: LastRunOutcomeColumn,
    onOutcome: (outcome: ManualRunOutcome | null) => void
  ): () => void {
    const channel = this.client
      .channel(`last_run_outcome:${column}:${userId}`)
      .on(
        'postgres_changes' as never,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles',
          filter: `user_id=eq.${userId}`,
        },
        (payload: { new?: Record<string, unknown> | null }) => {
          onOutcome(coerceManualRunOutcome(payload.new?.[column]));
        }
      )
      .subscribe();
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  subscribeToWikiArticleChanges(userId: string, onChange: () => void): () => void {
    const channel = this.client
      .channel(`wiki_articles:${userId}`)
      .on(
        'postgres_changes' as never,
        {
          event: '*',
          schema: 'public',
          table: 'wiki_articles',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          onChange();
        }
      )
      .subscribe();
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  /**
   * Subscribe to any change on the signed-in user's wiki records. Twin
   * of subscribeToWikiArticleChanges - the extraction agent, the
   * librarian, the chat record tools, and the in-app compose form all
   * write records, so the open article view refetches its Records
   * section on a coarse "something changed" signal.
   */
  subscribeToWikiRecordChanges(userId: string, onChange: () => void): () => void {
    const channel = this.client
      .channel(`wiki_records:${userId}`)
      .on(
        'postgres_changes' as never,
        {
          event: '*',
          schema: 'public',
          table: 'wiki_records',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          onChange();
        }
      )
      .subscribe();
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  /**
   * Subscribe to any change on the signed-in user's memories. The
   * wiki-articles twin above, for the memory writers that all live
   * server-side now (reflection on the chat-turn tail, the rem and
   * deep-sleep librarian sweeps): the caller (Chat.svelte) routes the
   * notification into emitMemoryChange so an open Memories panel
   * refetches through the path it already had. Same coarse contract -
   * "something changed", no row deltas.
   */
  subscribeToMemoryChanges(userId: string, onChange: () => void): () => void {
    const channel = this.client
      .channel(`memories:${userId}`)
      .on(
        'postgres_changes' as never,
        {
          event: '*',
          schema: 'public',
          table: 'memories',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          onChange();
        }
      )
      .subscribe();
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  /**
   * Subscribe to any change on the signed-in user's recipes. Third of
   * the wiki-articles / memories family: the chat-reachable recipe
   * writers (the recipe_* tools) all run server-side, so this is how
   * an open Cookbook modal or the drawer's Recipes tab learns a
   * model-driven recipe write landed. The caller (Chat.svelte) routes
   * the notification into emitCookbookChange. Same coarse contract -
   * "something changed", no row deltas.
   */
  subscribeToRecipeChanges(userId: string, onChange: () => void): () => void {
    const channel = this.client
      .channel(`recipes:${userId}`)
      .on(
        'postgres_changes' as never,
        {
          event: '*',
          schema: 'public',
          table: 'recipes',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          onChange();
        }
      )
      .subscribe();
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  /**
   * Subscribe to the signed-in user's freshly minted samskaras. The
   * formation pipeline runs in the venice function and publishes a
   * `samskara-mint` Broadcast event per mint (insertMint ->
   * publishSamskaraMint); this relay maps its (tier, valence,
   * confidence) payload into the mood-pill toast (the caller routes it to
   * notifySamskaraMint).
   *
   * Broadcast rather than a postgres_changes echo on purpose: only the
   * server-side INSERT emits the event, so dedup-reinforce hits (which
   * UPDATE an existing row) stay silent - the intended toast semantics -
   * and `samskaras` stays out of the realtime publication, where its
   * fire-bookkeeping UPDATE churn used to flood the WAL decoder (see
   * supabase/functions/_shared/samskara-mint.ts). Payloads with an
   * unexpected shape are dropped: a toast is decoration, never worth
   * surfacing an error for.
   *
   * `private: true` engages the "samskara mint channel: owner subscribe"
   * policy on realtime.messages (supabase/schema.sql) - a user only
   * receives their own mints. The edge function publishes under
   * service_role and bypasses the policy.
   */
  subscribeToSamskaraInserts(
    userId: string,
    onMint: (detail: { tier: 1 | 2; valence: number; confidence: number }) => void
  ): () => void {
    const channel = this.client
      .channel(`samskaras:${userId}`, { config: { private: true } })
      .on('broadcast', { event: 'samskara-mint' }, ({ payload }) => {
        const detail = payload as Record<string, unknown> | undefined;
        if (!detail) return;
        const tier = detail.tier;
        if (tier !== 1 && tier !== 2) return;
        onMint({
          tier,
          valence: typeof detail.valence === 'number' ? detail.valence : 0,
          confidence: typeof detail.confidence === 'number' ? detail.confidence : 0.5,
        });
      })
      // Surface the channel lifecycle at debug so a "mint toasts aren't
      // popping" report can tell an RLS-rejected private subscribe
      // (CHANNEL_ERROR / TIMED_OUT) from a publish-side miss. Same
      // breadcrumb subscribeToUserLogs keeps for the logs channel.
      .subscribe((status, err) => {
        log.debug(`samskaras channel subscribe status: ${status}`, err ?? '');
      });
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  /**
   * Subscribe to the signed-in user's agent-run progress channel. The
   * venice function publishes live step events (model rounds, tool
   * calls with their narration) for user-triggered agent runs - the
   * Wiki librarian's manual-run strip and the Memories panel's
   * rem / deep-sleep strips are the consumers. Subscribe
   * BEFORE issuing the run's POST (the pre-subscribe rule streaming
   * chat established); filter by runId at the call site since the
   * topic is per-user, not per-run. `private: true` engages the
   * "agent-run channel: owner subscribe" policy on realtime.messages.
   */
  subscribeToAgentRunProgress(
    userId: string,
    onEvent: (event: AgentRunProgressEvent) => void
  ): () => void {
    const channel = this.client
      .channel(`agent-runs:${userId}`, { config: { private: true } })
      .on('broadcast', { event: 'agent-progress' }, ({ payload }) => {
        onEvent(payload as AgentRunProgressEvent);
      })
      .subscribe((status, err) => {
        log.debug(`agent-runs channel subscribe status: ${status}`, err ?? '');
      });
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  // Samskara RPCs --------------------------------------------------------
  //
  // Thin wrappers over the SQL functions defined in the samskara
  // section of supabase/schema.sql. The sql functions own all the
  // RLS-aware bookkeeping (cohort weighting, the confidence formula);
  // these methods just shape the arguments and unwrap the response.
  //
  // Only the client-side substrate write (record) and the diagnostics
  // reads live here now. Firing the cosine RPC and reading the compound
  // summary for priming moved server-side with the pre-turn priming
  // relocation; the formation pipeline (claim / assimilate / mint /
  // dedup / compound-regen) also runs server-side in
  // supabase/functions/venice/agents/samskara.ts against the same SQL
  // surface via its p_user_id overloads. (getCompoundSummary survives
  // here only as a diagnostics read - see SamskaraHealthPanel.)

  // --- Samskara --------------------------------------------------------

  /**
   * Insert the per-round substrate stub. The chat loop calls this at
   * end-of-round with the just-persisted message ids; the assimilator
   * worker phase fills in `situation`/`outcome`/`valence` later.
   */
  async samskaraRecordSubstrate(
    threadId: string,
    userMessageId: string,
    assistantMessageId: string | null
  ): Promise<string> {
    const { data, error } = await this.client.rpc('samskara_record_substrate', {
      p_thread_id: threadId,
      p_user_message_id: userMessageId,
      p_assistant_message_id: assistantMessageId,
    });
    if (error) throw new SupabaseError(error.message);
    return data as string;
  }

  /**
   * Read the cached compound summary row. NULL summary or absent row
   * is the cold-start case; chat-loop reader treats both as "no
   * compound block this turn." The caller decides any staleness
   * ceiling on `lastRegenAt` — kept here for future use.
   */
  async samskaraGetCompoundSummary(): Promise<{
    summary: string | null;
    lastRegenAt: string | null;
    samskaraCountAtRegen: number;
  } | null> {
    // samskara_count_at_regen is purely a diagnostics hook — the
    // getter the chat loop uses discards it, but the Samskara
    // diagnostics screen wants to show "summary covers N samskaras".
    // Cheap to return regardless; no reason to fork into two methods.
    const { data, error } = await this.client
      .from('samskara_compound_summary')
      .select('summary, last_regen_at, samskara_count_at_regen')
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    if (!data) return null;
    const row = data as {
      summary: string | null;
      last_regen_at: string | null;
      samskara_count_at_regen: number | null;
    };
    return {
      summary: row.summary,
      lastRegenAt: row.last_regen_at,
      samskaraCountAtRegen: row.samskara_count_at_regen ?? 0,
    };
  }

  // Diagnostics reads --------------------------------------------------
  //
  // These power the inline CohortPanel in the chat transcript and the
  // mood pill's history seed. Pure selects against the user's own rows
  // (RLS handles the scoping), safe to call from the main thread. None
  // are on the chat-loop hot path; they only run when a human asks to
  // see them.

  /**
   * All substrate rows anchored to a thread, newest first. Used by the
   * diagnostics screen to narrate which turns the samskara pipeline
   * has seen for this conversation and where each row sits in the
   * assimilate -> embed lifecycle. Embedding column deliberately
   * omitted (2048 floats per row x N rows is a lot of wire traffic
   * for a human-readable panel).
   */
  async samskaraListSubstrateForThread(
    threadId: string
  ): Promise<SamskaraSubstrateDiagnosticRow[]> {
    const { data, error } = await this.client
      .from('samskara_substrate')
      .select(
        'id, user_message_id, assistant_message_id, situation, outcome, valence, embedding_model, created_at'
      )
      .eq('thread_id', threadId)
      .order('created_at', { ascending: false });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      id: string;
      user_message_id: string;
      assistant_message_id: string | null;
      situation: string | null;
      outcome: string | null;
      valence: number | null;
      embedding_model: string | null;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      userMessageId: r.user_message_id,
      assistantMessageId: r.assistant_message_id,
      situation: r.situation,
      outcome: r.outcome,
      valence: r.valence,
      embeddingModel: r.embedding_model,
      createdAt: r.created_at,
    }));
  }

  /**
   * Most recent fire's valence + tier + confidence for a thread, used
   * to seed the mood pill on conversation reopen so the user doesn't
   * have to wait for a fresh mint to see anything other than 💤.
   * Filters out fires whose joined samskara has a null valence (rare,
   * but the field is nullable until the assimilator lands a reading)
   * - returning null lets the caller fall back to the default
   * placeholder cleanly. Confidence falls back to 1 when the column
   * is null on legacy rows so the seed renders the confident column;
   * the alternative (rendering tentative for "unknown") would be a
   * worse default. `.limit(1)` keeps this cheap on threads with
   * hundreds of fires.
   */
  async samskaraGetLatestFireMood(
    threadId: string
  ): Promise<{ valence: number; tier: 1 | 2; confidence: number } | null> {
    // `samskaras!inner` collapses fires whose FK target was deleted
    // out of the result at the DB level, and the
    // `.not('samskaras.valence', 'is', null)` filter additionally
    // skips fires whose joined samskara hasn't had a valence
    // assimilated yet. Without the !inner, an orphaned fire could
    // come back with samskaras=null and burn the `.limit(1)` slot,
    // hiding a perfectly good fire one row below.
    const { data, error } = await this.client
      .from('samskara_fires')
      .select('samskaras!inner(valence, tier, confidence)')
      .eq('thread_id', threadId)
      .not('samskaras.valence', 'is', null)
      .order('fired_at', { ascending: false })
      .limit(1);
    if (error) throw new SupabaseError(error.message);
    interface EmbeddedMood {
      valence: number | null;
      tier: number;
      confidence: number | null;
    }
    const rows = (data ?? []) as unknown as {
      samskaras: EmbeddedMood | EmbeddedMood[] | null;
    }[];
    const row = rows[0];
    if (!row) return null;
    // supabase-js types the embed as an array even for N:1; runtime
    // is a single object when the FK resolves. Same shape-quirk
    // handled in samskaraListFiresForThread above.
    const joined = Array.isArray(row.samskaras)
      ? (row.samskaras[0] ?? null)
      : row.samskaras;
    if (!joined || joined.valence === null) return null;
    // Collapse any unexpected tier value to tier 1 so the consumer's
    // narrow union doesn't drift.
    const tier: 1 | 2 = joined.tier === 2 ? 2 : 1;
    return {
      valence: joined.valence,
      tier,
      confidence: joined.confidence ?? 1,
    };
  }

  /**
   * All fires anchored to a thread, newest first, with the joined
   * samskara payload so the diagnostics screen can render each cohort
   * without a follow-up round trip. Supabase embed syntax pulls the
   * FK'd row under `samskaras`. Grouping by cohort is left to the
   * renderer.
   */
  async samskaraListFiresForThread(
    threadId: string
  ): Promise<SamskaraFireDiagnosticRow[]> {
    const { data, error } = await this.client
      .from('samskara_fires')
      .select(
        'id, cohort_id, samskara_id, score, fired_at, was_confirmed, verdict, user_round, samskaras(tier, prediction, inner_voice, valence, confidence, health)'
      )
      .eq('thread_id', threadId)
      .order('fired_at', { ascending: false });
    if (error) throw new SupabaseError(error.message);
    // supabase-js types the embed as an array even for N:1 FK'd rows
    // at the type layer — at runtime it's a single object when the
    // relationship resolves to one row. Treat either shape uniformly
    // and pick the first match; null when the FK target was deleted.
    interface EmbeddedSamskara {
      tier: number;
      prediction: string;
      inner_voice: string | null;
      valence: number | null;
      confidence: number;
      health: number;
    }
    const rows = (data ?? []) as unknown as {
      id: string;
      cohort_id: string;
      samskara_id: string;
      score: number;
      fired_at: string;
      was_confirmed: boolean | null;
      verdict: string | null;
      user_round: number | null;
      samskaras: EmbeddedSamskara | EmbeddedSamskara[] | null;
    }[];
    return rows.map((r) => {
      const joined = Array.isArray(r.samskaras)
        ? (r.samskaras[0] ?? null)
        : r.samskaras;
      return {
        id: r.id,
        cohortId: r.cohort_id,
        samskaraId: r.samskara_id,
        score: r.score,
        firedAt: r.fired_at,
        wasConfirmed: r.was_confirmed,
        verdict: r.verdict,
        userRound: r.user_round,
        samskara: joined
          ? {
              tier: joined.tier,
              prediction: joined.prediction,
              innerVoice: joined.inner_voice,
              valence: joined.valence,
              confidence: joined.confidence,
              health: joined.health,
            }
          : null,
      };
    });
  }

  /**
   * Cluster a thread's fires by cosine similarity on their predictions,
   * scoped per-cohort. Used by the diagnostics modal to collapse a
   * 22-row cohort fire list down to a handful of themes the human
   * reader can scan. Returns the cluster_seq (1-based, restarts per
   * cohort) and cluster_size each fire belongs to; the renderer joins
   * back against the existing fires array by fire id.
   *
   * Threshold default 0.7 sits in BGE-M3's "topically similar" band -
   * paraphrases of the same idea typically land between 0.65 and 0.78.
   * MINT dedup uses 0.85 because that's "near-duplicate sentence";
   * for human-readable theme grouping a lower bar reads as "same idea
   * said differently." Modal exposes the threshold as a slider so the
   * caller can tune it live without a redeploy.
   */
  async samskaraClusterThreadFires(
    threadId: string,
    threshold = 0.7
  ): Promise<Map<string, { clusterSeq: number; clusterSize: number }>> {
    const { data, error } = await this.client.rpc(
      'samskara_cluster_thread_fires',
      { p_thread_id: threadId, p_threshold: threshold }
    );
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      fire_id: string;
      cluster_seq: number;
      cluster_size: number;
    }[];
    const map = new Map<string, { clusterSeq: number; clusterSize: number }>();
    for (const r of rows) {
      map.set(r.fire_id, {
        clusterSeq: r.cluster_seq,
        clusterSize: r.cluster_size,
      });
    }
    return map;
  }

  // Observability tab reads ----------------------------------------------
  //
  // Power the Samskara diagnostics tab (Corpus + Health panels). All
  // read-only and RLS-scoped; none write or shape anything. See
  // docs/dev/samskara.md's observability section.

  /**
   * One offset page of the samskara corpus for the Corpus panel's
   * browse list (empty-query regime). `prediction_embedding` is
   * deliberately omitted - 2048 floats x a page of rows is far too fat
   * for a list. Sort maps to a deterministic order; `id` tiebreak keeps
   * cross-page order stable. Optional tier filter.
   */
  async listSamskarasPage(opts: {
    offset: number;
    pageSize: number;
    tier?: number | null;
    sort: SamskaraBrowseSort;
  }): Promise<OffsetPage<SamskaraCorpusRow>> {
    let q = this.client
      .from('samskaras')
      .select(
        'id, tier, prediction, inner_voice, valence, confidence, health, fire_count, confirm_count, disconfirm_count, last_fired_at, created_at'
      );
    if (opts.tier != null) q = q.eq('tier', opts.tier);
    // Order columns per sort key. last_fired_at is nullable, so
    // recently-fired pushes never-fired rows to the bottom.
    switch (opts.sort) {
      case 'strongest':
        q = q.order('health', { ascending: false }).order('confidence', { ascending: false });
        break;
      case 'most_fired':
        q = q.order('fire_count', { ascending: false });
        break;
      case 'recently_fired':
        q = q.order('last_fired_at', { ascending: false, nullsFirst: false });
        break;
      case 'recent':
      default:
        q = q.order('created_at', { ascending: false });
        break;
    }
    q = q.order('id', { ascending: false });
    q = q.range(opts.offset, opts.offset + opts.pageSize);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []).map(mapSamskaraCorpusRow);
    const hasMore = rows.length > opts.pageSize;
    return { rows: hasMore ? rows.slice(0, opts.pageSize) : rows, hasMore };
  }

  /**
   * Corpus semantic search: nearest samskaras by cosine on
   * `prediction_embedding`. Plain cosine, NOT the fire-ranking formula -
   * browse wants closest-to-query, not most-likely-to-fire. Optional
   * tier filter. Returns the same shape as the browse list plus a
   * `cosine` relevance score.
   */
  async searchSamskarasByEmbedding(
    embedding: number[],
    kMax: number,
    tier?: number | null
  ): Promise<SamskaraCorpusRow[]> {
    const { data, error } = await this.client.rpc('samskara_search_by_prediction', {
      p_query_embedding: embedding,
      p_k_max: kMax,
      p_tier: tier ?? null,
    });
    if (error) throw new SupabaseError(error.message);
    return ((data ?? []) as SamskaraCorpusRpcRow[]).map(mapSamskaraCorpusRow);
  }

  /**
   * Substring fallback for corpus search: ILIKE on prediction text.
   * Every samskara is embedded (the column is NOT NULL), so unlike
   * memories there is no disjoint unembedded set - this is purely to
   * surface exact-phrase matches a cosine ranking might bury. Optional
   * tier filter.
   */
  async searchSamskarasByText(
    query: string,
    limit: number,
    tier?: number | null
  ): Promise<SamskaraCorpusRow[]> {
    let q = this.client
      .from('samskaras')
      .select(
        'id, tier, prediction, inner_voice, valence, confidence, health, fire_count, confirm_count, disconfirm_count, last_fired_at, created_at'
      )
      .ilike('prediction', `%${query}%`)
      .order('health', { ascending: false })
      .limit(limit);
    if (tier != null) q = q.eq('tier', tier);
    const { data, error } = await q;
    if (error) throw new SupabaseError(error.message);
    return (data ?? []).map(mapSamskaraCorpusRow);
  }

  /**
   * Greedy cosine clustering of the corpus for the "hide similar"
   * slider. Returns a map keyed by samskara id; each entry names the
   * cluster sequence (representative shares the lowest seq) and the
   * cluster's size so the UI can render "+N similar". Optional tier
   * filter must match the list's filter so the assignments line up.
   */
  async samskaraClusterCorpus(
    threshold: number,
    tier?: number | null
  ): Promise<Map<string, { seq: number; size: number }>> {
    const { data, error } = await this.client.rpc('samskara_cluster_corpus', {
      p_threshold: threshold,
      p_tier: tier ?? null,
    });
    if (error) throw new SupabaseError(error.message);
    const map = new Map<string, { seq: number; size: number }>();
    for (const r of (data ?? []) as {
      samskara_id: string;
      cluster_seq: number;
      cluster_size: number;
    }[]) {
      map.set(r.samskara_id, { seq: r.cluster_seq, size: r.cluster_size });
    }
    return map;
  }

  /**
   * Resolve a samskara's provenance to labelled rows for the detail
   * view. For a tier-2 compound these are its tier-1 children (label =
   * child prediction); for a tier-1 they're substrate situations and
   * association labels. A null label means the target was deleted since
   * minting - the UI renders that as "(removed)".
   */
  async samskaraProvenanceDetail(samskaraId: string): Promise<SamskaraProvenanceRow[]> {
    const { data, error } = await this.client.rpc('samskara_provenance_detail', {
      p_samskara_id: samskaraId,
    });
    if (error) throw new SupabaseError(error.message);
    return ((data ?? []) as {
      kind: string;
      ref_id: string;
      weight: number;
      label: string | null;
      ref_tier: number | null;
    }[]).map((r) => ({
      kind: r.kind as SamskaraProvenanceRow['kind'],
      refId: r.ref_id,
      weight: r.weight,
      label: r.label,
      refTier: r.ref_tier,
    }));
  }

  /**
   * One-row corpus-wide health snapshot for the Health panel: backlog
   * depths, lost-signal counts, inconsistency counts, corpus-quality
   * counts. Computed live; no stored history.
   */
  async samskaraHealthSnapshot(): Promise<SamskaraHealthSnapshot> {
    const { data, error } = await this.client.rpc('samskara_health_snapshot');
    if (error) throw new SupabaseError(error.message);
    // The RPC returns a single-row table; supabase-js hands it back as a
    // one-element array.
    const r = (Array.isArray(data) ? data[0] : data) as Record<string, number> | null;
    return {
      totalSamskaras: r?.total_samskaras ?? 0,
      tier1: r?.tier1 ?? 0,
      tier2: r?.tier2 ?? 0,
      nearDead: r?.near_dead ?? 0,
      neverFired: r?.never_fired ?? 0,
      associations: r?.associations ?? 0,
      associationsUnconsumed: r?.associations_unconsumed ?? 0,
      substrateTotal: r?.substrate_total ?? 0,
      pendingAssimilate: r?.pending_assimilate ?? 0,
      pendingEmbed: r?.pending_embed ?? 0,
      firesTotal: r?.fires_total ?? 0,
      firesAwaitingJudgment: r?.fires_awaiting_judgment ?? 0,
      orphanFires: r?.orphan_fires ?? 0,
      stuckAssimilateClaims: r?.stuck_assimilate_claims ?? 0,
      stuckEmbedClaims: r?.stuck_embed_claims ?? 0,
    };
  }

  /**
   * Windowed activity rates (mints/fires/resolution over the last N
   * days) for the Health panel, computed from existing timestamps.
   */
  async samskaraRates(days: number): Promise<SamskaraRates> {
    const { data, error } = await this.client.rpc('samskara_rates', { p_days: days });
    if (error) throw new SupabaseError(error.message);
    const r = (Array.isArray(data) ? data[0] : data) as Record<string, number> | null;
    return {
      windowDays: r?.window_days ?? days,
      mints: r?.mints ?? 0,
      fires: r?.fires ?? 0,
      resolved: r?.resolved ?? 0,
      unresolved: r?.unresolved ?? 0,
      resolutionPct: r?.resolution_pct ?? 0,
      held: r?.held ?? 0,
      contradicted: r?.contradicted ?? 0,
      notBorneOut: r?.not_borne_out ?? 0,
      notEngaged: r?.not_engaged ?? 0,
    };
  }

  /**
   * Lifetime verdict tally for one samskara's fires, for the detail
   * pane. Raw counts (not the EWMA-discounted confirm/disconfirm the row
   * carries) so the soft-miss bucket reads next to the others. pending =
   * fired but not yet judged.
   */
  async samskaraVerdictCounts(samskaraId: string): Promise<SamskaraVerdictCounts> {
    const { data, error } = await this.client.rpc('samskara_verdict_counts', {
      p_samskara_id: samskaraId,
    });
    if (error) throw new SupabaseError(error.message);
    const r = (Array.isArray(data) ? data[0] : data) as Record<string, number> | null;
    return {
      held: r?.held ?? 0,
      contradicted: r?.contradicted ?? 0,
      notBorneOut: r?.not_borne_out ?? 0,
      notEngaged: r?.not_engaged ?? 0,
      pending: r?.pending ?? 0,
    };
  }

  /**
   * Health panel readout: how many tier-1 members the tier-2 detector
   * would currently offer the minter (0 = nothing available). Calls the
   * same detection RPC the sweep's mint-tier2 phase uses - a non-empty
   * return with few tier-2s is the signal detection is finding uncovered
   * constellations again (the instrument that would have surfaced the
   * "empty every sweep" stall the lift redesign fixed). The RPC is
   * security-invoker and scopes to auth.uid() with no args.
   */
  async samskaraTier2CandidateSize(): Promise<number> {
    const { data, error } = await this.client.rpc('samskara_tier2_candidate');
    if (error) throw new SupabaseError(error.message);
    return Array.isArray(data) ? data.length : 0;
  }

  // --- Bias profile ------------------------------------------------------
  //
  // The per-turn bias writes (active-set snapshot + new-message clear)
  // moved server-side when priming relocated into the venice edge
  // function (supabase/functions/venice/priming.ts). The browser keeps
  // only biasListSummary, the read the diagnostics modal renders from.

  /**
   * Chat-loop: read every cached aggregate for the user. Returns
   * empty array on cold-start (no row in bias_summary yet) or on
   * any RPC error - the format pass treats both as "no bias block
   * this turn", matching samskara's null-on-empty contract.
   */
  async biasListSummary(): Promise<
    {
      bias: string;
      effectiveN: number;
      posteriorAlpha: number;
      posteriorBeta: number;
      posteriorMean: number;
      ciLower: number;
      feedbackScore: number;
      tier: 'elided' | 'soft' | 'strong';
      computedAt: string;
    }[]
  > {
    const { data, error } = await this.client
      .from('bias_summary')
      .select(
        'bias, effective_n, posterior_alpha, posterior_beta, posterior_mean, ci_lower, feedback_score, tier, computed_at'
      );
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      bias: string;
      effective_n: number;
      posterior_alpha: number;
      posterior_beta: number;
      posterior_mean: number;
      ci_lower: number;
      feedback_score: number | null;
      tier: 'elided' | 'soft' | 'strong';
      computed_at: string;
    }[];
    return rows.map((r) => ({
      bias: r.bias,
      effectiveN: r.effective_n,
      posteriorAlpha: r.posterior_alpha,
      posteriorBeta: r.posterior_beta,
      posteriorMean: r.posterior_mean,
      ciLower: r.ci_lower,
      // feedback_score column was added in v2; pre-v2 rows return
      // null which we treat as the neutral 0.
      feedbackScore: r.feedback_score ?? 0,
      tier: r.tier,
      computedAt: r.computed_at,
    }));
  }

  /**
   * Debug modal: per-bias raw observation counts across the user's
   * full history. Distinct from `effective_n` on the summary row -
   * effective_n is the recency-weighted sum of ALL processed
   * conversations (including the pConv=0 "no-hit" denominator), so
   * every catalog entry the worker has touched ends up with a
   * non-zero effective_n even when it was never flagged. The
   * observation count answers the user's question "has anything
   * ever been recorded against this bias for me?" - zero means the
   * row's posterior is just the prior plus the cumulative no-hit
   * mass, and the modal renders it as "no evidence" rather than
   * the ~5% prior 10th-percentile.
   *
   * Aggregation is client-side. The bias_observations table has no
   * native group-by in the PostgREST surface, and observation
   * counts are small enough (worker-rate-limited, bounded by the
   * catalog size times processed conversations) that pulling the
   * `bias` column and tallying in JS is cheaper than adding an
   * RPC for it.
   */
  async biasListObservationCounts(): Promise<Record<string, number>> {
    const { data, error } = await this.client
      .from('bias_observations')
      .select('bias');
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as { bias: string }[];
    const counts: Record<string, number> = {};
    for (const r of rows) {
      counts[r.bias] = (counts[r.bias] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Debug modal: list per-conversation reactions for one thread.
   * The current-conversation section uses this to surface "did the
   * user affirm or push back on the compensation for X here?"
   * alongside the observations for the same thread.
   */
  async biasListReactionsForThread(threadId: string): Promise<
    {
      id: string;
      bias: string;
      wasConfirmed: boolean | null;
      reasoning: string;
      createdAt: string;
    }[]
  > {
    const { data, error } = await this.client
      .from('bias_reactions')
      .select('id, bias, was_confirmed, reasoning, created_at')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      id: string;
      bias: string;
      was_confirmed: boolean | null;
      reasoning: string;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      bias: r.bias,
      wasConfirmed: r.was_confirmed,
      reasoning: r.reasoning,
      createdAt: r.created_at,
    }));
  }

  /**
   * Debug modal: fetch a thread's bias_processed_at timestamp.
   * Returns null if the thread row doesn't exist yet (e.g. a brand-
   * new draft conversation that hasn't been materialized to the DB)
   * or if the worker hasn't analyzed it yet. The bias-profile modal
   * uses this to distinguish "not yet analyzed" (no observations
   * because the worker hasn't gotten to it) from "already analyzed,
   * no findings" (no observations because the worker scanned and
   * came up empty) - otherwise a fresh conversation reads as the
   * latter, which is wrong and misleading.
   */
  async biasGetThreadProcessedAt(threadId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from('threads')
      .select('bias_processed_at')
      .eq('id', threadId)
      .maybeSingle();
    if (error) throw new SupabaseError(error.message);
    const row = data as { bias_processed_at: string | null } | null;
    return row?.bias_processed_at ?? null;
  }

  /**
   * Debug modal: list observations for one thread. Used by the
   * per-conversation drill-down. Includes the cited message id so
   * the modal can deep-link back to the original.
   */
  async biasListObservationsForThread(threadId: string): Promise<
    {
      id: string;
      bias: string;
      confidence: number;
      reasoning: string;
      evidenceMessageId: string | null;
      createdAt: string;
    }[]
  > {
    const { data, error } = await this.client
      .from('bias_observations')
      .select('id, bias, confidence, reasoning, evidence_message_id, created_at')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true });
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      id: string;
      bias: string;
      confidence: number;
      reasoning: string;
      evidence_message_id: string | null;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      bias: r.bias,
      confidence: r.confidence,
      reasoning: r.reasoning,
      evidenceMessageId: r.evidence_message_id,
      createdAt: r.created_at,
    }));
  }

  /**
   * Debug modal: list every observation for one bias key across
   * every thread the user has, joined to the source thread's
   * title so each row can render as a navigable link. Drives the
   * per-bias drill-down ("which conversations triggered this?")
   * on the bias-profile screen.
   *
   * Sorted newest-first - the user's mental model is "what got
   * flagged recently for this bias?", not chronological reading
   * order. RLS scopes the read to the current user; deleted
   * threads have already cascaded their observations away, so a
   * missing thread title here means the auto-titler hasn't run
   * yet, not a dangling reference.
   */
  async biasListObservationsForBiasKey(biasKey: string): Promise<
    {
      id: string;
      threadId: string;
      threadTitle: string | null;
      confidence: number;
      reasoning: string;
      createdAt: string;
    }[]
  > {
    const { data, error } = await this.client
      .from('bias_observations')
      .select('id, thread_id, confidence, reasoning, created_at, threads(title)')
      .eq('bias', biasKey)
      .order('created_at', { ascending: false });
    if (error) throw new SupabaseError(error.message);
    const out: {
      id: string;
      threadId: string;
      threadTitle: string | null;
      confidence: number;
      reasoning: string;
      createdAt: string;
    }[] = [];
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const id = row.id;
      const threadId = row.thread_id;
      if (typeof id !== 'string' || typeof threadId !== 'string') continue;
      // PostgREST returns a many-to-one embed as a single object,
      // but the supabase-js type inference treats it as either an
      // object or array depending on FK metadata. Mirror the
      // unwrap pattern from listWikiArticleSources so this stays
      // robust against either shape.
      const thread = row.threads as { title?: unknown } | { title?: unknown }[] | null;
      const threadObj = Array.isArray(thread) ? thread[0] : thread;
      const title =
        threadObj && typeof threadObj.title === 'string' ? threadObj.title : null;
      out.push({
        id,
        threadId,
        threadTitle: title,
        confidence: typeof row.confidence === 'number' ? row.confidence : 0,
        reasoning: typeof row.reasoning === 'string' ? row.reasoning : '',
        createdAt: typeof row.created_at === 'string' ? row.created_at : '',
      });
    }
    return out;
  }

  /**
   * Debug modal: list the most-recently-processed threads with
   * counts of observations and the message-count token. Drives the
   * "Processed conversations" table on the bias-profile screen.
   */
  async biasListProcessedThreads(limit: number = 30): Promise<
    {
      threadId: string;
      title: string;
      processedAt: string;
      observationCount: number;
    }[]
  > {
    const { data, error } = await this.client
      .from('threads')
      .select(
        'id, title, bias_processed_at, bias_observations(count)'
      )
      .not('bias_processed_at', 'is', null)
      .order('bias_processed_at', { ascending: false })
      .limit(limit);
    if (error) throw new SupabaseError(error.message);
    const rows = (data ?? []) as {
      id: string;
      title: string | null;
      bias_processed_at: string;
      // Supabase's `embedded count` returns an array containing
      // one row with { count: N }; the cast is fragile in the
      // type system, careful at the boundary.
      bias_observations: { count: number }[] | null;
    }[];
    return rows.map((r) => ({
      threadId: r.id,
      title: r.title ?? '',
      processedAt: r.bias_processed_at,
      observationCount: r.bias_observations?.[0]?.count ?? 0,
    }));
  }
}

/** Sort keys for the Corpus browse list. */
export type SamskaraBrowseSort = 'recent' | 'strongest' | 'most_fired' | 'recently_fired';

/**
 * A samskara as rendered in the Corpus panel's list and detail views.
 * camelCased at the boundary so the UI never sees snake_case. `cosine`
 * is present only on search results (the browse list omits it). No
 * embedding - too fat for a list.
 */
export interface SamskaraCorpusRow {
  id: string;
  tier: number;
  prediction: string;
  innerVoice: string | null;
  valence: number | null;
  confidence: number;
  health: number;
  fireCount: number;
  confirmCount: number;
  disconfirmCount: number;
  lastFiredAt: string | null;
  createdAt: string;
  cosine?: number;
}

/** Snake-case shape of a corpus row as it arrives from a select or RPC. */
interface SamskaraCorpusRpcRow {
  id: string;
  tier: number;
  prediction: string;
  inner_voice: string | null;
  valence: number | null;
  confidence: number;
  health: number;
  fire_count: number;
  confirm_count: number;
  disconfirm_count: number;
  last_fired_at: string | null;
  created_at: string;
  cosine?: number;
}

/** One labelled provenance edge of a samskara, for the detail view. */
export interface SamskaraProvenanceRow {
  kind: 'substrate' | 'association' | 'samskara';
  refId: string;
  weight: number;
  /** Resolved label (child prediction / situation / relation), or null if the target was deleted. */
  label: string | null;
  /** Tier of the referenced samskara, present only for kind='samskara'. */
  refTier: number | null;
}

/** Corpus-wide live health snapshot for the Health panel. */
export interface SamskaraHealthSnapshot {
  totalSamskaras: number;
  tier1: number;
  tier2: number;
  nearDead: number;
  neverFired: number;
  associations: number;
  /** Association edges not yet fed to the association-mint pass. Drains across sweeps. */
  associationsUnconsumed: number;
  substrateTotal: number;
  pendingAssimilate: number;
  pendingEmbed: number;
  firesTotal: number;
  firesAwaitingJudgment: number;
  orphanFires: number;
  stuckAssimilateClaims: number;
  stuckEmbedClaims: number;
}

/** Windowed activity rates for the Health panel. */
export interface SamskaraRates {
  windowDays: number;
  mints: number;
  fires: number;
  resolved: number;
  unresolved: number;
  resolutionPct: number;
  held: number;
  contradicted: number;
  notBorneOut: number;
  notEngaged: number;
}

/** Lifetime per-samskara verdict counts (raw fire counts, not the
 *  discounted posterior tallies). `pending` = fired but unjudged. */
export interface SamskaraVerdictCounts {
  held: number;
  contradicted: number;
  notBorneOut: number;
  notEngaged: number;
  pending: number;
}

/** Map a snake-case corpus row (select or RPC) to the camelCase UI shape. */
function mapSamskaraCorpusRow(r: SamskaraCorpusRpcRow): SamskaraCorpusRow {
  return {
    id: r.id,
    tier: r.tier,
    prediction: r.prediction,
    innerVoice: r.inner_voice,
    valence: r.valence,
    confidence: r.confidence,
    health: r.health,
    fireCount: r.fire_count,
    confirmCount: r.confirm_count,
    disconfirmCount: r.disconfirm_count,
    lastFiredAt: r.last_fired_at,
    createdAt: r.created_at,
    ...(typeof r.cosine === 'number' ? { cosine: r.cosine } : {}),
  };
}

/**
 * Substrate row as shown in the diagnostics screen. Excludes the
 * embedding vector (too fat for a human-readable panel) and renames
 * to camelCase at the boundary so the component doesn't ship snake-
 * case identifiers into the UI.
 */
export interface SamskaraSubstrateDiagnosticRow {
  id: string;
  userMessageId: string;
  assistantMessageId: string | null;
  situation: string | null;
  outcome: string | null;
  valence: number | null;
  /** Set once the embedding has landed; also a de-facto "embedded?" flag. */
  embeddingModel: string | null;
  createdAt: string;
}

/**
 * Fire row with its joined samskara payload, for diagnostics
 * rendering. Grouping by `cohortId` is the renderer's job - the DB
 * query returns one row per (cohort_id, samskara_id) pair.
 */
export interface SamskaraFireDiagnosticRow {
  id: string;
  cohortId: string;
  samskaraId: string;
  score: number;
  firedAt: string;
  wasConfirmed: boolean | null;
  /** The next-day judge's verdict for this fire: 'held' / 'contradicted'
   *  / 'not-borne-out' / 'not-engaged', or null until judged. Carries the
   *  soft-miss distinction that wasConfirmed (a boolean) collapses - the
   *  cohort panel renders it per fire. */
  verdict: string | null;
  /** 1-based index of the user message that triggered this cohort, as
   *  counted by the chat loop at fire time. Null for legacy rows
   *  written before the column existed and not yet covered by the
   *  one-time backfill - the per-message inline UI suppresses the
   *  toggle on user messages where no cohort maps to this round. */
  userRound: number | null;
  /** Null only when the samskara was deleted after the fire logged;
   *  the row keeps pointing to the now-orphaned id. */
  samskara: {
    tier: number;
    prediction: string;
    innerVoice: string | null;
    valence: number | null;
    confidence: number;
    health: number;
  } | null;
}
