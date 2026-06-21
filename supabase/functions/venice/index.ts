// The `venice` edge function - the single deployed function that wraps our
// Venice.ai calls (Supabase's "fat function" guidance: few large functions,
// not many small). It routes internally by trailing path segment:
//   /embed     - browser-triggered, one vector for a search query or (legacy)
//                a single backfill row. Authenticated as the calling user.
//   /usage     - browser-triggered, one page of billing usage. The browser's
//                paging loop calls it once per page so it can drive a per-page
//                progress indicator. Authenticated as the calling user.
//   /backfill  - cron-triggered (pg_cron -> pg_net), drains pending embeddings
//                across every table server-side. Service-role only.
//   /text-parser - browser-triggered, forwards a multipart file upload to
//                  Venice's /augment/text-parser. Bug-driven: browser direct
//                  calls were CORS-rejected on non-image files; the function
//                  fixes both the chat-attachment and Library-upload paths.
//   /image-generate - browser-triggered, forwards a prompt + options to
//                     Venice's /image/generate. The generate_image tool calls
//                     it; the function pins variants=1/return_binary=false
//                     so the response is a single base64 image ready for the
//                     attachments path.
//   /complete - browser-triggered, thin proxy for Venice's /chat/completions
//               (non-streaming). The body-shaping helper buildChatBody lives
//               in src/lib/venice.ts and runs browser-side; this route just
//               attaches the shared key, forwards, and relays Venice's
//               response - including a parsed retryAfterMs on 429 so the
//               browser's retry loop can act on Venice's hint. The streaming
//               sibling (streamChat) is the project's final attractor and
//               does not move yet.
//
// The handlers are intentionally thin: request/response shaping, the Venice
// call, and the backfill orchestration live in ../_shared/* (pure, unit-tested
// offline). This file owns only the glue - CORS, routing, auth, sourcing the
// shared key, and error mapping.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  veniceComplete,
  veniceEmbed,
  veniceExtractText,
  veniceFetchModels,
  veniceFetchUsagePage,
  veniceGenerateImage,
  VeniceError,
} from '../_shared/venice.ts';
import { EMBED_SOURCES } from '../_shared/embed-input.ts';
import {
  runBackfill,
  VENICE_EMBEDDING_MODEL,
  type BackfillDeps,
} from '../_shared/backfill.ts';
import { streamChannelName } from '../_shared/venice-stream.ts';
import { getStreamingResponse } from './getStreamingResponse.ts';
import { retryWikiThread, runWikiSweepTick } from './agents/wiki.ts';
import { runWikiManualUpdate } from './agents/wiki_manual.ts';
import { runWikiRecordsSweepTick } from './agents/wiki_records.ts';
import { runReflectionSweepTick } from './agents/reflection.ts';
import { runCurationSweepTick } from './agents/curation.ts';
import { runBiasSweepTick } from './agents/bias.ts';
import { runSamskaraSweepTick } from './agents/samskara.ts';
import { runSamskaraEvaluationSweepTick } from './agents/samskara_evaluation.ts';
import {
  runWikiLibrarianManual,
  runWikiLibrarianSweepTick,
} from './agents/wiki_librarian.ts';
import { runRemManual, runRemSweepTick } from './agents/rem.ts';
import {
  runDeepSleepManual,
  runDeepSleepSweepTick,
} from './agents/deep_sleep.ts';
import { createAgentProgressPublisher } from '../_shared/agent-progress.ts';
import { createEdgeLogger } from '../_shared/edge-log.ts';
// Side-effect import: every tool module under ./tools/ calls
// registerTool() at module-load via this barrel, populating the
// performToolCall registry before the first /stream request lands.
import './tools/index.ts';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Backfill tunables. One invocation processes at most BACKFILL_MAX_ROWS rows or
// runs for at most BACKFILL_TIME_BUDGET_MS, whichever comes first, then returns;
// the */5 cron tick resumes from the same claim state. The budget sits well
// under the edge runtime's wall-clock limit - nearly all of it is spent
// awaiting Venice (I/O, not CPU). ROW_CLAIM_TTL_SECONDS is longer than a single
// invocation so an overlapping tick can't steal a row this one is still saving.
const BACKFILL_MAX_ROWS = 50;
const BACKFILL_TIME_BUDGET_MS = 25_000;
const ROW_CLAIM_TTL_SECONDS = 120;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/**
 * Build a service-role Supabase client from the env the edge runtime injects.
 * The service role bypasses RLS, which is what lets the function read the shared
 * app_config key and run the global (cross-member) backfill RPCs. Returns null
 * when the env is missing so callers can turn that into a 503.
 */
function adminClient(): SupabaseClient | null {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

/**
 * Read the project-global shared Venice key from app_config using the service
 * role (app_config has only an authenticated-read policy and no write policy;
 * the service role bypasses RLS). Returns null when the row is unseeded.
 */
async function readVeniceKey(admin: SupabaseClient): Promise<string | null> {
  const { data, error } = await admin
    .from('app_config')
    .select('venice_api_key')
    .eq('id', true)
    .maybeSingle();
  if (error || !data) return null;
  const key = (data as { venice_api_key?: string | null }).venice_api_key;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

// Handler preambles. Every route needs the admin client, and the
// Venice-proxy routes additionally need the shared key; both
// failures map to the same 503s everywhere. The `| Response` return
// lets call sites stay two lines (`if (x instanceof Response) return
// x`) instead of repeating the error mapping per handler.

/** Admin client or the 503 every handler returns when env is missing. */
function requireAdmin(): SupabaseClient | Response {
  const admin = adminClient();
  if (!admin) return json({ error: 'function env missing SUPABASE_* secrets' }, 503);
  return admin;
}

/** Admin client + shared Venice key, or the matching 503. */
async function requireVeniceEnv(): Promise<
  { admin: SupabaseClient; apiKey: string } | Response
> {
  const admin = requireAdmin();
  if (admin instanceof Response) return admin;
  const apiKey = await readVeniceKey(admin);
  if (!apiKey) {
    return json({ error: 'no Venice key configured (app_config unseeded)' }, 503);
  }
  return { admin, apiKey };
}

/**
 * True when the request is authenticated as the service role. The cron job
 * (pg_net) sends the project's service-role JWT as the bearer (the gateway
 * needs a JWT, so the cron secret is the legacy JWT key, not the modern opaque
 * `sb_secret_` one - same reason the local realtime stack rejects
 * `sb_publishable_`).
 *
 * We decode the bearer's `role` claim rather than string-comparing it to the
 * injected SUPABASE_SERVICE_ROLE_KEY. That equality check shipped first and
 * 403'd every cron call: the bearer must be a JWT for the gateway to accept it,
 * but SUPABASE_SERVICE_ROLE_KEY is not guaranteed to be the same string (legacy
 * JWT vs modern `sb_secret_`), so the bytes differ even though both grant the
 * service role. Checking the claim is robust to which key format the project
 * uses. SECURITY: this trusts the decoded payload, which is only safe because
 * the gateway's `verify_jwt` (on by default, per supabase/config.toml; no
 * per-route override) has already validated the signature. Do NOT disable
 * verify_jwt for this function without replacing this with signature
 * verification - otherwise a forged `role: service_role` token would pass.
 */
function isServiceRole(req: Request): boolean {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const parts = token.split('.');
  if (parts.length !== 3) return false; // not a JWT
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const payload = JSON.parse(atob(b64)) as { role?: unknown };
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

/**
 * Pull the authenticated user id from the request's bearer JWT.
 * Returns null when the bearer is absent, malformed, or carries no
 * `sub` claim. Same trust assumption as isServiceRole: the gateway's
 * verify_jwt has already validated the signature, so reading the
 * payload directly is safe. The streaming function lives or dies on
 * this id - every downstream DB write filters by it.
 */
function userIdFromJwt(req: Request): string | null {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const payload = JSON.parse(atob(b64)) as { sub?: unknown };
    return typeof payload.sub === 'string' && payload.sub.length > 0
      ? payload.sub
      : null;
  } catch {
    return null;
  }
}

/**
 * Hand off a promise to the Edge runtime so it continues executing
 * after the response returns. Wrapped to make local-runtime calls
 * (Deno without the Supabase edge globals, e.g. inside tests) a
 * no-op fallback: the promise still resolves, it just isn't watched
 * by a runtime. In production this is the load-bearing piece that
 * lets the streaming function survive the browser disconnect.
 */
function edgeWaitUntil(promise: Promise<unknown>): void {
  const er = (globalThis as {
    EdgeRuntime?: { waitUntil?(p: Promise<unknown>): void };
  }).EdgeRuntime;
  if (er && typeof er.waitUntil === 'function') {
    er.waitUntil(promise);
    return;
  }
  // Locally: keep a reference so the rejection isn't lost; the
  // top-level catch on getStreamingResponse handles failure modes,
  // but a stray rejection here surfaces during tests.
  promise.catch(() => {
    /* errors are surfaced via the END event on the channel */
  });
}

interface EmbedRequestBody {
  input?: string | string[];
  model?: string;
}

async function handleEmbed(req: Request): Promise<Response> {
  let body: EmbedRequestBody;
  try {
    body = (await req.json()) as EmbedRequestBody;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  if (!body.input || !body.model) {
    return json({ error: 'body must include `input` and `model`' }, 400);
  }

  const env = await requireVeniceEnv();
  if (env instanceof Response) return env;
  const { apiKey } = env;

  try {
    const result = await veniceEmbed({ apiKey, model: body.model, input: body.input });
    return json(result);
  } catch (err) {
    if (err instanceof VeniceError) {
      // Surface Venice's 429 as a 429 so the caller can apply its rate-limit
      // back-off; everything else collapses to 502 (bad upstream).
      return json({ error: err.message, kind: err.kind }, err.kind === 'rate_limit' ? 429 : 502);
    }
    return json({ error: (err as Error).message }, 500);
  }
}

interface UsageRequestBody {
  page?: number;
  limit?: number;
  sortOrder?: string;
  startDate?: string;
  endDate?: string;
  currency?: string;
}

/**
 * Browser-triggered single-page proxy for GET /billing/usage. The browser's
 * paging loop (src/lib/usage.ts) calls this once per page, so the per-page
 * progress indicator in the Usage pane keeps working - a single fat response
 * could not report page-by-page progress. Authenticated as the calling user:
 * the gateway's verify_jwt has already validated the session JWT (same model as
 * /embed, no service-role check). Usage is account-scoped, so any project member
 * sees the one shared key's usage - consistent with the shared-key trust model.
 *
 * Forwards one page to Venice with the shared key and relays the rows verbatim;
 * row coercion and the paging cap live in the browser loop, keeping this a thin
 * passthrough with no UsageRow knowledge.
 */
async function handleUsage(req: Request): Promise<Response> {
  let body: UsageRequestBody;
  try {
    body = (await req.json()) as UsageRequestBody;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const env = await requireVeniceEnv();
  if (env instanceof Response) return env;
  const { apiKey } = env;

  try {
    const result = await veniceFetchUsagePage({
      apiKey,
      params: {
        page: typeof body.page === 'number' ? body.page : 1,
        limit: typeof body.limit === 'number' ? body.limit : 500,
        sortOrder: typeof body.sortOrder === 'string' ? body.sortOrder : 'desc',
        startDate: body.startDate,
        endDate: body.endDate,
        currency: body.currency,
      },
    });
    return json(result);
  } catch (err) {
    if (err instanceof VeniceError) {
      // Mirror handleEmbed: surface Venice's 429 as a 429 so the browser loop
      // can back off; everything else collapses to 502 (bad upstream).
      return json({ error: err.message, kind: err.kind }, err.kind === 'rate_limit' ? 429 : 502);
    }
    return json({ error: (err as Error).message }, 500);
  }
}

/**
 * Browser-triggered proxy for GET /models?type=text. The Settings model
 * picker fetches this to populate the per-tier and vision model dropdowns
 * with the live Venice catalog. Authenticated as the calling user (the
 * gateway's verify_jwt has already validated the session JWT - same model
 * as /usage, no service-role check); the catalog is account-agnostic, so
 * any project member sees the same list against the one shared key.
 *
 * Thin passthrough: relays Venice's JSON verbatim and lets the browser
 * (src/lib/models/catalog.ts) flatten and coerce it, keeping this handler
 * free of CatalogModel knowledge. POST from the browser (functions.invoke
 * is always POST) even though the upstream call is a GET.
 */
async function handleModels(): Promise<Response> {
  const env = await requireVeniceEnv();
  if (env instanceof Response) return env;
  const { apiKey } = env;

  try {
    const result = await veniceFetchModels({ apiKey });
    return json(result);
  } catch (err) {
    if (err instanceof VeniceError) {
      return json({ error: err.message, kind: err.kind }, err.kind === 'rate_limit' ? 429 : 502);
    }
    return json({ error: (err as Error).message }, 500);
  }
}

/**
 * Browser-triggered thin proxy for POST /chat/completions. The browser
 * already builds Venice's wire-shape body via the exported buildChatBody
 * helper in src/lib/venice.ts; the function forwards it untouched with the
 * shared key attached and returns Venice's JSON verbatim. parseChatCompletion
 * on the browser side handles response shaping.
 *
 * Auth: verify_jwt on (the gateway has already validated the session JWT),
 * shared key from app_config via the service role - same model as /embed.
 * No service-role check, since this is user-triggered.
 *
 * Error relay: VeniceError carries kind + status; on rate_limit we also
 * include retryAfterMs in the JSON body so the browser's retry loop can
 * read Venice's Retry-After / x-ratelimit-reset-* hint rather than picking
 * a backoff blindly. Other VeniceErrors collapse to 502; non-VeniceError
 * exceptions to 500.
 */
async function handleComplete(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'body must be a JSON object' }, 400);
  }

  const env = await requireVeniceEnv();
  if (env instanceof Response) return env;
  const { apiKey } = env;

  try {
    const result = await veniceComplete({
      apiKey,
      body: body as Record<string, unknown>,
    });
    return json(result);
  } catch (err) {
    if (err instanceof VeniceError) {
      if (err.kind === 'rate_limit') {
        // Surface Retry-After / x-ratelimit-reset-* through the JSON body
        // so the browser's retry loop can act on Venice's hint - the
        // headers themselves do not survive the functions.invoke round
        // trip cleanly.
        return json(
          { error: err.message, kind: err.kind, retryAfterMs: err.retryAfterMs ?? null },
          429
        );
      }
      // Reaching here means veniceComplete exhausted its transient-retry
      // schedule (or hit a non-retryable kind), so the 502 reflects a
      // sustained upstream Venice failure, not a blip. Log the cause: the
      // Supabase edge gateway records only the 502 status code, not this
      // body, so without this line an upstream failure is opaque from
      // `supabase logs` / the MCP get_logs view - you'd have to catch the
      // response live in the browser. err.message already embeds Venice's
      // status + a body snippet for kind='http'.
      console.error(
        `[venice/complete] upstream failure kind=${err.kind} status=${err.status ?? 'n/a'}: ${err.message}`,
      );
      return json({ error: err.message, kind: err.kind }, 502);
    }
    // Non-VeniceError here is an unexpected throw (a code bug, not an
    // upstream relay); log the whole thing - stack included - so it is
    // not a silent 500.
    console.error('[venice/complete] unexpected error:', err);
    return json({ error: (err as Error).message }, 500);
  }
}

interface ImageGenerateRequestBody {
  model?: string;
  prompt?: string;
  negativePrompt?: string;
  stylePreset?: string;
  width?: number;
  height?: number;
  seed?: number;
  steps?: number;
  cfgScale?: number;
  safeMode?: boolean;
  hideWatermark?: boolean;
  format?: 'webp' | 'png' | 'jpeg';
}

/**
 * Browser-triggered image-generation proxy for POST /image/generate. Mirrors
 * /embed's auth: the gateway's verify_jwt has already validated the session
 * JWT; we read the shared key from app_config via the service role. The body
 * keeps the camel-cased shape the browser's generate_image tool already uses;
 * veniceGenerateImage handles the snake_case translation Venice expects, the
 * variants=1 / return_binary=false defaults, and the content-policy header
 * check. Response is `{ imageBase64, mimeType }` ready to drop into a
 * message_attachments row.
 */
async function handleImageGenerate(req: Request): Promise<Response> {
  let body: ImageGenerateRequestBody;
  try {
    body = (await req.json()) as ImageGenerateRequestBody;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  if (typeof body.model !== 'string' || typeof body.prompt !== 'string') {
    return json({ error: 'body must include `model` and `prompt`' }, 400);
  }

  const env = await requireVeniceEnv();
  if (env instanceof Response) return env;
  const { apiKey } = env;

  try {
    const result = await veniceGenerateImage({
      apiKey,
      model: body.model,
      prompt: body.prompt,
      negativePrompt: body.negativePrompt,
      stylePreset: body.stylePreset,
      width: body.width,
      height: body.height,
      seed: body.seed,
      steps: body.steps,
      cfgScale: body.cfgScale,
      safeMode: body.safeMode,
      hideWatermark: body.hideWatermark,
      format: body.format,
    });
    return json(result);
  } catch (err) {
    if (err instanceof VeniceError) {
      return json({ error: err.message, kind: err.kind }, err.kind === 'rate_limit' ? 429 : 502);
    }
    return json({ error: (err as Error).message }, 500);
  }
}

/**
 * Browser-triggered text extraction proxy for POST /augment/text-parser. The
 * browser cannot reach this Venice endpoint directly - Venice CORS-enables
 * chat/image/embeddings but not text-parser, which surfaced as a confusing
 * "Failed to fetch" on any non-image attachment. Forwarding through the
 * function makes the call server-side where browser CORS does not apply and
 * the shared key already lives. Authenticated as the calling user (gateway's
 * verify_jwt has already validated the session JWT - same model as /embed,
 * no service-role check).
 *
 * Multipart in, JSON out: the request body is a multipart/form-data with a
 * `file` part (Blob + filename); the response is `{ text }`. Forwarding
 * preserves the file's filename so Venice's content-type sniffing still
 * works. Failures relay through the VeniceError -> { error, kind } shape the
 * other routes use; 429 surfaces as 429, everything else collapses to 502.
 */
async function handleTextParser(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: 'invalid multipart body' }, 400);
  }
  const filePart = form.get('file');
  // A File satisfies Blob (it extends Blob in the browser/Deno standard), so
  // the Blob check covers both - File-ness is checked separately only to
  // recover the original filename.
  if (!(filePart instanceof Blob)) {
    return json({ error: 'body must include a `file` part' }, 400);
  }
  const filename =
    filePart instanceof File && filePart.name ? filePart.name : 'attachment';

  const env = await requireVeniceEnv();
  if (env instanceof Response) return env;
  const { apiKey } = env;

  try {
    const text = await veniceExtractText({ apiKey, file: filePart, filename });
    return json({ text });
  } catch (err) {
    if (err instanceof VeniceError) {
      return json({ error: err.message, kind: err.kind }, err.kind === 'rate_limit' ? 429 : 502);
    }
    return json({ error: (err as Error).message }, 500);
  }
}

/**
 * Cron-driven server-side backfill. Claims pending rows across every embeddable
 * table, embeds them with the shared key, and writes the vectors back through
 * the service-definer claim/save RPCs. Bounded per invocation (see the tunables
 * above); the schedule resumes the drain.
 */
async function handleBackfill(req: Request): Promise<Response> {
  if (!isServiceRole(req)) return json({ error: 'forbidden' }, 403);

  const env = await requireVeniceEnv();
  if (env instanceof Response) return env;
  const { admin, apiKey } = env;

  // One holder id per invocation. The claim/save RPCs guard on it so an
  // overlapping invocation (a slow tick still running when the next fires)
  // can't save over a row this one claimed.
  const holderId = crypto.randomUUID();

  // Per-user drawer attribution. The claim RPCs return each row's
  // user_id; saves tally per owner so the tick can emit one
  // "embedded N item(s)" summary into each affected user's Logs
  // drawer. Keyed per source+id because ids are only unique within
  // a table.
  const rowOwner = new Map<string, string>();
  const embeddedByUser = new Map<string, number>();

  const deps: BackfillDeps = {
    claim: async (sourceIndex) => {
      const source = EMBED_SOURCES[sourceIndex];
      const { data, error } = await admin.rpc(source.claimRpc, {
        p_holder_id: holderId,
        p_ttl_seconds: ROW_CLAIM_TTL_SECONDS,
      });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
      if (!row) return null;
      if (typeof row.user_id === 'string') {
        rowOwner.set(`${sourceIndex}:${String(row.id)}`, row.user_id);
      }
      return { id: String(row.id), input: source.buildInput(row) };
    },
    embed: async (input) => {
      const resp = await veniceEmbed({ apiKey, model: VENICE_EMBEDDING_MODEL, input });
      return resp.data[0]?.embedding;
    },
    save: async (sourceIndex, id, embedding) => {
      const source = EMBED_SOURCES[sourceIndex];
      const { data, error } = await admin.rpc(source.saveRpc, {
        p_id: id,
        p_holder_id: holderId,
        p_embedding: embedding,
        p_embedding_model: VENICE_EMBEDDING_MODEL,
      });
      if (error) throw error;
      const saved = data === true;
      if (saved) {
        const owner = rowOwner.get(`${sourceIndex}:${id}`);
        if (owner) {
          embeddedByUser.set(owner, (embeddedByUser.get(owner) ?? 0) + 1);
        }
      }
      return saved;
    },
  };

  const summary = await runBackfill(deps, {
    sourceCount: EMBED_SOURCES.length,
    maxRows: BACKFILL_MAX_ROWS,
    timeBudgetMs: BACKFILL_TIME_BUDGET_MS,
    isRateLimit: (err) => err instanceof VeniceError && err.kind === 'rate_limit',
  });

  // One drawer line per affected user, after the drain settles. Most
  // ticks touch nobody (queues run empty) and emit nothing.
  for (const [userId, count] of embeddedByUser) {
    const log = createEdgeLogger(userId, 'embeddings');
    log.info(`embedded ${count} item(s) in the background`);
    await log.flush();
  }

  return json(summary);
}

// ---------------------------------------------------------------------------
// Fleet route factories. Every agent fleet exposes the same two route
// shapes - a cron-driven sweep and (for some) a user-triggered manual
// run - and the per-fleet variation is which tick/run function to
// call, not handler structure. The factories own the structure; each
// fleet contributes one line per route below. Fleet SEMANTICS
// (claim cadence, work-unit bounds, toggles) live with the tick/run
// functions in agents/*.ts, not here.
// ---------------------------------------------------------------------------

/**
 * Cron-driven sweep route: service-role only (pg_cron -> pg_net sends
 * the service JWT). The tick runs DETACHED under EdgeRuntime.waitUntil
 * and the response is an immediate `{accepted: true}`: an agent sweep
 * can outlive the HTTP window (pg_net's timeout is seconds; the local
 * gateway's is ~2.5 minutes), and a synchronous handler gets killed
 * with the dropped request - observed locally as a sweep that claimed
 * its row and died before reflecting it. Nothing reads the response
 * body anyway: pg_net ignores it, and tick outcomes reach the user's
 * Logs drawer through each fleet's edge logger.
 */
function sweepHandler(
  tick: (admin: SupabaseClient) => Promise<unknown>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    if (!isServiceRole(req)) return json({ error: 'forbidden' }, 403);
    const admin = requireAdmin();
    if (admin instanceof Response) return admin;
    // Ticks are non-throwing by contract (each fleet catches and
    // folds failures into its summary), so a rejection here is an
    // infrastructure bug. No user has been claimed yet at this layer,
    // so there is no drawer to notify - the function log is the
    // surface.
    edgeWaitUntil(
      tick(admin).catch((err) => {
        console.error(
          '[sweep] tick rejected:',
          err instanceof Error ? err.message : String(err),
        );
      }),
    );
    return json({ accepted: true });
  };
}

/**
 * Factory for a user-triggered manual fleet run. The run can outlive the
 * gateway's response window (~2.5 min), so awaiting the whole pass before
 * responding would draw a gateway 504 on a long one (a librarian reading
 * conversations over a multi-round tool loop): the function finishes and
 * the edits land, but the response and the trailing terminal broadcast
 * never reach the browser. So this runs the fleet function DETACHED under
 * EdgeRuntime.waitUntil (same shape as the sweep routes and chat /stream)
 * and responds {accepted:true} immediately. The outcome can no longer
 * ride the HTTP body, so it is published as a terminal `result` event on
 * the agent-runs channel; the browser's real backstop is the in-flight
 * lease (profiles realtime), which settles the UI even if this
 * fire-and-forget broadcast is dropped.
 *
 * runId is REQUIRED: without it there is no channel to carry the result.
 * The browser mints it and subscribes to its agent-runs channel BEFORE
 * posting (the pre-subscribe rule), so the events published here are
 * never raced. The `run` adapter pulls any fleet-specific fields off the
 * parsed body; agent-level failures and in-flight collisions come back
 * inside the fleet's result union, surfaced via the `result` event.
 */
function detachedManualRunHandler(
  logSource: string,
  run: (
    admin: SupabaseClient,
    userId: string,
    body: Record<string, unknown>,
    onProgress: ((event: Record<string, unknown>) => void) | undefined,
  ) => Promise<unknown>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const userId = userIdFromJwt(req);
    if (!userId) return json({ error: 'unauthorized' }, 401);
    const admin = requireAdmin();
    if (admin instanceof Response) return admin;

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ error: 'invalid JSON body' }, 400);
    }
    const runId =
      typeof body.runId === 'string' && body.runId.length > 0 && body.runId.length <= 64
        ? body.runId
        : null;
    if (!runId) {
      return json({ error: 'runId is required for a detached manual run' }, 400);
    }

    const publisher = createAgentProgressPublisher(userId, runId);
    edgeWaitUntil(
      (async () => {
        let result: unknown;
        try {
          result = await run(admin, userId, body, (event) => publisher.publish(event));
        } catch (err) {
          // The fleet functions fold expected failures into their result
          // unions, so a throw here is an infrastructure bug. Surface it
          // as an error result so the browser still settles, and log it
          // to the requesting user's drawer.
          const log = createEdgeLogger(userId, logSource);
          log.error(
            'detached manual run failed unexpectedly',
            err instanceof Error ? err : new Error(String(err)),
          );
          await log.flush();
          result = { kind: 'error', error: 'internal error during manual run' };
        }
        // Terminal event - the outcome the HTTP body used to carry.
        publisher.publish({ kind: 'result', result });
        await publisher.flush();
      })(),
    );
    return json({ accepted: true });
  };
}

// The fleet routing table. One line per route; the referenced
// tick/run functions carry the fleet semantics and their doc
// comments.
const handleWikiSweep = sweepHandler(runWikiSweepTick);
const handleWikiRecordsSweep = sweepHandler(runWikiRecordsSweepTick);
const handleWikiLibrarianSweep = sweepHandler(runWikiLibrarianSweepTick);
const handleRemSweep = sweepHandler(runRemSweepTick);
const handleDeepSleepSweep = sweepHandler(runDeepSleepSweepTick);
// Reflection's catch-up drain. The primary driver stays the chat
// turn's waitUntil tail in getStreamingResponse; this route exists so
// a user who stops conversing still gets their queue drained, and so
// reflection's trigger surface is visible in this routing table like
// every other fleet's.
const handleReflectionSweep = sweepHandler(runReflectionSweepTick);
// Curation catch-up drain (auto-title, thread topics, summaries,
// memory topics, recipe topics). The primary driver is the chat
// turn's waitUntil tail in getStreamingResponse, same dual-driver
// shape as reflection; this route is what drains work created
// server-side (rem / deep-sleep consolidations re-queue memory tags)
// or left behind by a failed tail attempt.
const handleCurationSweep = sweepHandler(runCurationSweepTick);
const handleBiasSweep = sweepHandler(runBiasSweepTick);
const handleSamskaraSweep = sweepHandler(runSamskaraSweepTick);
// Samskara evaluation sweep: the next-day retrospective judge that
// scores each fired samskara against the conversation it fired in
// (relevance-gated decay). Shadow mode in slice 1 - records verdicts
// + logs would-be health deltas, changes no health. See
// agents/samskara_evaluation.ts.
const handleSamskaraEvaluationSweep = sweepHandler(runSamskaraEvaluationSweepTick);
// All three manual fleet runs (wiki librarian, rem, deep-sleep) are
// detached: each pass can run minutes (conversation/memory reads over a
// multi-round loop) past the gateway window, so the route returns
// {accepted:true} and reports the outcome over the agent-runs channel +
// the in-flight lease.
const handleWikiLibrarianRun = detachedManualRunHandler('wiki-librarian', (admin, userId, body, onProgress) =>
  runWikiLibrarianManual(
    admin,
    userId,
    typeof body.instructions === 'string' ? body.instructions : null,
    onProgress,
  ),
);
const handleRemRun = detachedManualRunHandler('rem', (admin, userId, _body, onProgress) =>
  runRemManual(admin, userId, onProgress),
);
const handleDeepSleepRun = detachedManualRunHandler('deep-sleep', (admin, userId, _body, onProgress) =>
  runDeepSleepManual(admin, userId, onProgress),
);

/**
 * User-triggered retry of a wiki-skipped thread (the Wiki Skipped
 * panel's Retry button). Not a manual-run route: it has a required
 * threadId, no runId, and no progress channel. Authenticated as the
 * calling user; the gateway-validated id scopes every RPC the retry
 * makes. Responds with the WikiRetryResult union - agent-level
 * failures are an application outcome (kind: 'error'), not a
 * transport error, so the panel can render them without sniffing
 * status codes.
 */
async function handleWikiRetry(req: Request): Promise<Response> {
  const userId = userIdFromJwt(req);
  if (!userId) return json({ error: 'unauthorized' }, 401);
  const admin = requireAdmin();
  if (admin instanceof Response) return admin;

  let body: { threadId?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const threadId = typeof body.threadId === 'string' ? body.threadId : '';
  if (!threadId) return json({ error: 'threadId is required' }, 400);

  const result = await retryWikiThread(admin, userId, threadId);
  return json(result);
}

/**
 * User-triggered per-article manual wiki update (the "Ask agent to
 * update" panel on Wiki.svelte). Synchronous - one non-streaming JSON
 * completion, no tool loop - so it returns the preview in the response
 * body (no runId / progress channel, unlike the librarian's detached
 * run). Authenticated as the calling user; the gateway-validated id
 * scopes the article + record reads. Responds with the
 * WikiManualUpdateResult union; parse / read failures are an
 * application outcome (kind: 'error'), not a transport error, so the
 * browser turns them into a retry banner without sniffing status codes.
 */
async function handleWikiManualUpdate(req: Request): Promise<Response> {
  const userId = userIdFromJwt(req);
  if (!userId) return json({ error: 'unauthorized' }, 401);
  const admin = requireAdmin();
  if (admin instanceof Response) return admin;

  let body: { articleId?: unknown; instructions?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const articleId = typeof body.articleId === 'string' ? body.articleId : '';
  const instructions = typeof body.instructions === 'string' ? body.instructions : '';
  if (!articleId) return json({ error: 'articleId is required' }, 400);
  if (!instructions.trim()) return json({ error: 'instructions are required' }, 400);

  const result = await runWikiManualUpdate(admin, userId, { articleId, instructions });
  return json(result);
}

interface StreamRequestBody {
  threadId?: string;
  userMessageId?: string;
  /**
   * Full Venice wire body for the first round. The browser builds
   * this via buildChatBody() (src/lib/venice.ts) and ships it
   * verbatim; this route does not reshape it before getStreamingResponse
   * picks it up.
   */
  body?: Record<string, unknown>;
  /**
   * Reconnect-only flag. When true, the function does NOT start a new
   * completion - it returns the existing in-flight envelope (or a
   * no-stream marker when nothing is in flight) so the browser can
   * subscribe and observe. Set on reopen-thread / cross-device-ape paths.
   */
  reconnectOnly?: boolean;
  /**
   * Regenerate-from-here replace range: ids of the rows the new
   * completion replaces (the old assistant turn plus everything after
   * it, later user turns included). Forwarded to the terminal commit
   * RPC, which excludes them from its newer-user-message conflict
   * check and deletes them atomically with the commit. Absent on
   * plain sends.
   */
  supersededIds?: string[];
}

// Boundary check for StreamRequestBody.supersededIds entries. The
// commit RPC takes uuid[]; a non-uuid id slipping through would not
// fail here but minutes later, as a cast error that kills an
// otherwise-good turn at terminal commit.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StreamEnvelope {
  channelName: string;
  /**
   * Existing assistant row id on a reconnect path; null on a fresh
   * stream (the orchestrator creates the row lazily at the first
   * content delta and the browser learns its id via the messages
   * realtime subscription). Tests can also see null for an explicit
   * reconnect-only request that found no in-flight stream.
   */
  assistantRowId: string | null;
  /** Empty string on fresh; the streaming row's content on reconnect. */
  completedSoFar: string;
  /**
   * Set true when the caller asked for reconnect-only and no in-
   * flight stream was found. Lets the browser distinguish "this
   * stream is already over - render terminal state from the row"
   * from "subscribe and wait." Absent on every other path.
   */
  noStreamInFlight?: true;
}

/**
 * Shared front half of both stream handlers: thread ownership, the
 * channel name, and the in-flight probe (with its stale-row
 * janitor). Returns a Response on any early exit; otherwise the
 * resolved context plus `inFlight` - the envelope of an existing
 * stream when one is running, null when the thread is quiet. Both
 * callers branch on `inFlight` rather than re-probing, so the
 * duplicate-completion guard and the reconnect answer stay one
 * code path.
 */
async function resolveStreamContext(
  req: Request,
  threadId: string,
): Promise<
  | Response
  | {
    userId: string;
    admin: SupabaseClient;
    channelName: string;
    inFlight: StreamEnvelope | null;
  }
> {
  const userId = userIdFromJwt(req);
  if (!userId) {
    return json({ error: 'unauthenticated' }, 401);
  }

  const admin = requireAdmin();
  if (admin instanceof Response) return admin;

  // Ownership gate. The thread row's user_id is authoritative; we
  // never trust the body. Without this, a forged threadId in the
  // request would let a JWT-authenticated user kick a stream against
  // someone else's thread.
  const { data: thread, error: threadErr } = await admin
    .from('threads')
    .select('user_id')
    .eq('id', threadId)
    .maybeSingle();
  if (threadErr) {
    return json({ error: `thread lookup failed: ${threadErr.message}` }, 502);
  }
  if (!thread || thread.user_id !== userId) {
    // Same error shape for missing-thread and wrong-owner so a
    // probe can't distinguish them.
    return json({ error: 'thread not found' }, 404);
  }

  const channelName = streamChannelName(threadId);

  // In-flight probe: is there a streaming row on this thread? The
  // same answer drives same-device-reload, cross-device ape-mode,
  // and the explicit reconnect route. Surfacing the existing
  // envelope short-circuits a duplicate completion.
  const { data: streamingRow } = await admin
    .from('messages')
    .select('id, content, created_at')
    .eq('thread_id', threadId)
    .eq('status', 'streaming')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let inFlight: StreamEnvelope | null = null;
  if (streamingRow) {
    const row = streamingRow as {
      id: string;
      content?: string | null;
      created_at: string;
    };
    // Stale-row janitor. The orchestrator's WALL_DEADLINE_MS is 380s
    // and its finally block transitions the row to 'error' on
    // wall-timeout, so a healthy stream lives at most ~7 minutes. A
    // row still in 'streaming' status well past that ceiling is
    // orphaned: the function died ungracefully (container kill,
    // EdgeRuntime.waitUntil terminated by tab close before terminal
    // commit, hard crash) without finalising the row. Returning its
    // channel envelope would have the browser subscribe to a topic
    // no publisher feeds - the throbber stays up forever, the Stop
    // button shows on a stream that isn't running. Transition the
    // row to 'error', write a user-facing explanation onto
    // threads.last_error, and return noStreamInFlight so the
    // browser's reconnect path treats it as "nothing to observe."
    // STALE_THRESHOLD is twice the wall deadline to leave headroom
    // for a long generation that legitimately stretches past the
    // soft ceiling - false positives waste a turn; false negatives
    // hang the UI, and we'd rather take the wasted turn.
    const STALE_THRESHOLD_MS = 2 * 380_000; // 760 seconds (~12.7 min)
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    if (ageMs > STALE_THRESHOLD_MS) {
      // Best-effort cleanup. If either UPDATE fails we still report
      // no stream in flight - leaving the row in 'streaming' is the
      // worst case but the next reconnect will retry the same
      // janitor pass.
      try {
        await admin
          .from('messages')
          .update({ status: 'error' })
          .eq('id', row.id);
      } catch {
        // Swallowed by design - see jsdoc.
      }
      try {
        await admin
          .from('threads')
          .update({
            last_error: {
              kind: 'internal',
              message:
                "The previous response was lost mid-stream (the function ended before it could finalise the reply). Try again.",
              retryable: true,
              occurred_at: new Date().toISOString(),
            },
          })
          .eq('id', threadId);
      } catch {
        // Swallowed by design - see jsdoc.
      }
      // inFlight stays null: the janitored row no longer counts as a
      // running stream.
    } else {
      inFlight = {
        channelName,
        assistantRowId: row.id,
        completedSoFar: row.content ?? '',
      };
    }
  }

  return { userId, admin, channelName, inFlight };
}

/**
 * Browser-triggered streaming chat completion (the fresh-stream half
 * of /stream). POSTs threadId, userMessageId, and a Venice wire
 * body; the function returns the envelope synchronously and runs
 * the round chain in the background via EdgeRuntime.waitUntil. Live
 * events publish to the thread:<id>:stream Broadcast channel; the
 * row persistence happens server-side so a backgrounded mobile PWA
 * returns to find the assistant turn either complete or still in
 * flight regardless of whether the tab survived.
 *
 * Auth model: b-strict. Gateway's verify_jwt validates the session
 * JWT and the function extracts userId from the `sub` claim. Every
 * DB write is service-role; ownership is gated by the explicit
 * userId comparison against the thread row before anything starts.
 */
async function handleStreamFresh(
  req: Request,
  body: StreamRequestBody,
): Promise<Response> {
  if (typeof body.threadId !== 'string' || body.threadId.length === 0) {
    return json({ error: 'body.threadId is required' }, 400);
  }
  // userMessageId anchors the terminal commit's conflict check, so a
  // fresh stream must carry it.
  if (
    typeof body.userMessageId !== 'string' ||
    body.userMessageId.length === 0
  ) {
    return json({ error: 'body.userMessageId is required' }, 400);
  }
  if (!body.body || typeof body.body !== 'object') {
    return json({ error: 'body.body is required for fresh streams' }, 400);
  }

  const ctx = await resolveStreamContext(req, body.threadId);
  if (ctx instanceof Response) return ctx;

  // A stream is already running on this thread (double-send, or a
  // second device racing the first). Hand back its envelope instead
  // of spawning a duplicate completion.
  if (ctx.inFlight) return json(ctx.inFlight);

  const apiKey = await readVeniceKey(ctx.admin);
  if (!apiKey) {
    return json({ error: 'no Venice key configured (app_config unseeded)' }, 503);
  }

  // Kick off the orchestrator. It owns its own AbortController (the
  // wall deadline + the control channel cancel) - the request signal
  // is NOT passed in because the request returns immediately after
  // this envelope and the orchestrator must survive that disconnect.
  // Silently drop malformed entries rather than 400ing the whole
  // request: the browser filters synthetic-row sentinels before
  // sending, so anything non-uuid here is a stray, and failing the
  // turn over it punishes the user for a value they never typed.
  const supersededIds = Array.isArray(body.supersededIds)
    ? body.supersededIds.filter(
        (id): id is string => typeof id === 'string' && UUID_RE.test(id),
      )
    : [];
  const promise = getStreamingResponse({
    apiKey,
    threadId: body.threadId,
    userMessageId: body.userMessageId,
    userId: ctx.userId,
    supersededIds,
    bodyTemplate: body.body as Record<string, unknown>,
    adminClient: ctx.admin,
  });
  edgeWaitUntil(promise);

  const envelope: StreamEnvelope = {
    channelName: ctx.channelName,
    assistantRowId: null,
    completedSoFar: '',
  };
  return json(envelope);
}

/**
 * The reconnect-only half of /stream: observe an in-flight turn
 * without starting one. Drives reopen-thread and cross-device
 * ape-mode - the caller can't know which user message the original
 * sender anchored on, so no userMessageId (or wire body) is
 * required. Returns the in-flight envelope when a stream is
 * running, or the noStreamInFlight marker so the browser renders
 * terminal state from the row instead of subscribing to a topic no
 * publisher feeds.
 */
async function handleStreamReconnect(
  req: Request,
  body: StreamRequestBody,
): Promise<Response> {
  if (typeof body.threadId !== 'string' || body.threadId.length === 0) {
    return json({ error: 'body.threadId is required' }, 400);
  }

  const ctx = await resolveStreamContext(req, body.threadId);
  if (ctx instanceof Response) return ctx;

  if (ctx.inFlight) return json(ctx.inFlight);
  const envelope: StreamEnvelope = {
    channelName: ctx.channelName,
    assistantRowId: null,
    completedSoFar: '',
    noStreamInFlight: true,
  };
  return json(envelope);
}

/**
 * Wire-compat dispatcher for /stream. Fresh streams and reconnects
 * share the route (the browser flags reconnects with
 * `reconnectOnly: true` in the body), but they are two different
 * operations with different required fields and different return
 * semantics - so they are two handlers, and this shim only parses
 * the body once and picks one.
 */
async function handleStream(req: Request): Promise<Response> {
  let body: StreamRequestBody;
  try {
    body = (await req.json()) as StreamRequestBody;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  return body.reconnectOnly === true
    ? handleStreamReconnect(req, body)
    : handleStreamFresh(req, body);
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  // Route by the trailing path segment so a single function can host every
  // Venice endpoint. Deployed at /functions/v1/venice, so /functions/v1/venice/embed
  // lands here with a trailing `embed`.
  const route = new URL(req.url).pathname.split('/').filter(Boolean).pop();
  if (route === 'embed' && req.method === 'POST') return handleEmbed(req);
  if (route === 'usage' && req.method === 'POST') return handleUsage(req);
  if (route === 'models' && req.method === 'POST') return handleModels();
  if (route === 'backfill' && req.method === 'POST') return handleBackfill(req);
  if (route === 'wiki-sweep' && req.method === 'POST') return handleWikiSweep(req);
  if (route === 'wiki-records-sweep' && req.method === 'POST') return handleWikiRecordsSweep(req);
  if (route === 'reflection-sweep' && req.method === 'POST') return handleReflectionSweep(req);
  if (route === 'curation-sweep' && req.method === 'POST') return handleCurationSweep(req);
  if (route === 'bias-sweep' && req.method === 'POST') return handleBiasSweep(req);
  if (route === 'samskara-sweep' && req.method === 'POST') return handleSamskaraSweep(req);
  if (route === 'samskara-evaluation-sweep' && req.method === 'POST') {
    return handleSamskaraEvaluationSweep(req);
  }
  if (route === 'wiki-retry' && req.method === 'POST') return handleWikiRetry(req);
  if (route === 'wiki-manual-update' && req.method === 'POST') return handleWikiManualUpdate(req);
  if (route === 'wiki-librarian-sweep' && req.method === 'POST') return handleWikiLibrarianSweep(req);
  if (route === 'wiki-librarian-run' && req.method === 'POST') return handleWikiLibrarianRun(req);
  if (route === 'rem-sweep' && req.method === 'POST') return handleRemSweep(req);
  if (route === 'rem-run' && req.method === 'POST') return handleRemRun(req);
  if (route === 'deep-sleep-sweep' && req.method === 'POST') return handleDeepSleepSweep(req);
  if (route === 'deep-sleep-run' && req.method === 'POST') return handleDeepSleepRun(req);
  if (route === 'text-parser' && req.method === 'POST') return handleTextParser(req);
  if (route === 'image-generate' && req.method === 'POST') return handleImageGenerate(req);
  if (route === 'complete' && req.method === 'POST') return handleComplete(req);
  if (route === 'stream' && req.method === 'POST') return handleStream(req);

  return json({ error: 'not found' }, 404);
});
