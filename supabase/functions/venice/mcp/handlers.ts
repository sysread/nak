// MCP route handler implementations, extracted from the main router
// (index.ts) so the router stays a thin dispatch table. The OAuth
// helpers (discoverMetadata, registerClient, exchangeCode, etc.) and
// the token store (storeTokens, updateIntegrationStatus, etc.) are
// imported from their sibling modules. The router helpers (json,
// userIdFromJwt, requireAdmin, createEdgeLogger) are passed in via
// McpRouteCtx so this module does not reach back into the router.
//
// Every handler is user-auth (the gateway verified the session JWT)
// and service-role writes carry `// RLS OFF: filter by userId` per
// docs/dev/edge-function-auth.md.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildAuthzUrl,
  discoverMetadata,
  exchangeCode,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  listMcpTools,
  refreshToken as refreshOauthToken,
  registerClient,
  type DiscoveredMetadata,
} from '../mcp/oauth.ts';
import {
  getIntegration,
  listIntegrations,
  storeToolCatalog,
  storeTokens,
  updateIntegrationStatus,
  type McpIntegrationMetadata,
} from '../mcp/token-store.ts';
import { createEdgeLogger, type EdgeLogger } from '../../_shared/edge-log.ts';
import { VeniceError } from '../../_shared/venice.ts';

/** Router helpers the handlers need. Passed in by the router. */
export interface McpRouteCtx {
  json(body: unknown, status?: number): Response;
  userIdFromJwt(req: Request): string | null;
  requireAdmin(): SupabaseClient | Response;
  createEdgeLogger(userId: string, source: string): EdgeLogger;
}

// Re-export so the router can pass it through.
export { createEdgeLogger };

interface McpDiscoverBody {
  serverUrl?: string;
}

interface McpRegisterBody {
  serverUrl?: string;
  label?: string;
  redirectUri?: string;
  clientId?: string;
  scopes?: string[];
  integrationId?: string;
  discovered?: DiscoveredMetadata;
}

interface McpTokenExchangeBody {
  integrationId?: string;
  code?: string;
  codeVerifier?: string;
  state?: string;
  redirectUri?: string;
}

interface McpRefreshBody {
  integrationId?: string;
}

interface McpByIdBody {
  integrationId?: string;
}

// ---------------------------------------------------------------------------
// MCP integration routes (user-auth)
// ---------------------------------------------------------------------------
//
// The browser Settings -> Integrations pane orchestrates the OAuth
// flow across these seven routes. Sequence:
//   1. mcp-discover    - user pastes server URL; this returns the
//                        discovered endpoints + whether DCR is supported.
//                        No DB write yet (the browser needs metadata
//                        first to decide its UX branch).
//   2. mcp-register    - insert the integration row + (if DCR) mint a
//                        client_id; return the authz URL + state so the
//                        browser can redirect the user.
//   3. browser redirects to the authz URL; the OAuth provider bounces
//      back to the browser with a `?code=`; browser forwards to:
//      mcp-token-exchange - exchange code for tokens, store them,
//                        list the MCP server's tool catalog, return
//                        the count so the UI can show "X tools enabled."
//   4. mcp-refresh     - manual force-refresh of the token (settings UI
//                        "retry" affordance for an integration whose
//                        refresh path keep failing).
//   5. mcp-list       - return the user's integrations (admin reads
//                        because the browser's publishable key + RLS
//                        view of mcp_integrations cannot surface the
//                        auth_status patch from server-side
//                        transitions reliably).
//   6. mcp-delete     - fully delete the integration (cascade-cleans
//                        the token + tool rows).
//   7. mcp-disconnect - keep the integration row but mark
//                        auth_status='revoked' + delete the token row
//                        so the user can re-authorize without re-pasting
//                        the URL + label.

async function handleMcpDiscover(req: Request, ctx: McpRouteCtx): Promise<Response> {
  const userId = ctx.userIdFromJwt(req);
  if (!userId) return ctx.json({ error: 'unauthorized' }, 401);

  let body: McpDiscoverBody;
  try {
    body = (await req.json()) as McpDiscoverBody;
  } catch {
    return ctx.json({ error: 'invalid JSON body' }, 400);
  }
  if (typeof body.serverUrl !== 'string' || body.serverUrl.length === 0) {
    return ctx.json({ error: 'body must include `serverUrl`' }, 400);
  }
  let url: URL;
  try {
    url = new URL(body.serverUrl);
  } catch {
    return ctx.json({ error: 'invalid serverUrl' }, 400);
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    // MCP Authorization spec mandates HTTPS for all OAuth endpoints;
    // localhost is the spec-permitted exception for development.
    return ctx.json({ error: 'serverUrl must be HTTPS (localhost exception for dev)' }, 400);
  }

  try {
    const discovered = await discoverMetadata(body.serverUrl);
    return ctx.json({ discovered });
  } catch (err) {
    if (err instanceof VeniceError) {
      return ctx.json({ error: err.message, kind: err.kind }, err.status ?? 502);
    }
    return ctx.json({ error: (err as Error).message }, 502);
  }
}

/**
 * Insert-or-update the integration row, run RFC 7591 DCR when the
 * server advertises it, and assemble the authz URL + PKCE pair the
 * browser uses to bounce the user through OAuth. Returns
 *   { integrationId, authzUrl, codeVerifier, state, resource }
 * so the browser keeps `codeVerifier` + `state` in pending-OAuth
 * session state and re-sends them on mcp-token-exchange.
 *
 * The browser supplies the `discovered` object cached from its
 * earlier mcp-discover call so we do NOT refetch on this route -
 * the discovery chain can take seconds and surfacing a URL the user
 * is staring at should feel like one click, not two round trips.
 */
async function handleMcpRegister(req: Request, ctx: McpRouteCtx): Promise<Response> {
  const userId = ctx.userIdFromJwt(req);
  if (!userId) return ctx.json({ error: 'unauthorized' }, 401);

  let body: McpRegisterBody;
  try {
    body = (await req.json()) as McpRegisterBody;
  } catch {
    return ctx.json({ error: 'invalid JSON body' }, 400);
  }
  const mcpLog = ctx.createEdgeLogger(userId, 'mcp-register');
  mcpLog.info(`register: serverUrl=${body.serverUrl} redirectUri=${body.redirectUri} label=${body.label} integrationId=${body.integrationId ?? 'none'} clientId=${body.clientId ? 'provided' : 'none'}`);
  if (typeof body.serverUrl !== 'string' || body.serverUrl.length === 0) {
    return ctx.json({ error: 'body must include `serverUrl`' }, 400);
  }
  if (typeof body.redirectUri !== 'string' || body.redirectUri.length === 0) {
    return ctx.json({ error: 'body must include `redirectUri`' }, 400);
  }
  if (typeof body.label !== 'string' || body.label.length === 0) {
    return ctx.json({ error: 'body must include `label`' }, 400);
  }
  const scopes = Array.isArray(body.scopes)
    ? body.scopes.filter((s): s is string => typeof s === 'string')
    : [];

  const admin = ctx.requireAdmin();
  if (admin instanceof Response) return admin;

  // Label doubles as the toolbox name under the mcp:<label> prefix;
  // colons would break the prefix-based name-parsing contract the
  // toggle handler and dispatch share with the browser.
  if (body.label.includes(':')) {
    return ctx.json({ error: 'label must not contain colons' }, 400);
  }

  // Label must be unique per user so two integrations don't collide
  // on the same mcp:<label> toolbox name. Skip the self-check on
  // update (same label on the same integration is a no-op).
  {
    const { data: clash } = await admin
      .from('mcp_integrations')
      .select('id')
      .eq('user_id', userId)
      .eq('label', body.label)
      .maybeSingle();
    if (clash && clash.id !== body.integrationId) {
      return ctx.json({ error: 'label already in use' }, 409);
    }
  }

  // Discover if the browser did not pass the cached discover result
  // back (defensive: keeps the route usable standalone for tests).
  let discovered: DiscoveredMetadata;
  if (body.discovered && typeof body.discovered === 'object' && 'resource' in body.discovered) {
    discovered = body.discovered;
  } else {
    try {
      discovered = await discoverMetadata(body.serverUrl);
    } catch (err) {
      if (err instanceof VeniceError) {
        return ctx.json({ error: err.message, kind: err.kind }, err.status ?? 502);
      }
      return ctx.json({ error: (err as Error).message }, 502);
    }
  }

  // Scope resolution, mirroring the MCP SDK's three-tier priority:
  //   1. `scope` from the 401's WWW-Authenticate header (exact MCP gate)
  //   2. `scopes_supported` from the RFC 9728 protected-resource metadata
  //   3. `scopes_supported` from the RFC 8414 auth-server metadata
  // The Authorization URL uses the resolved scope exactly; Fastmail
  // rejects `offline_access` alongside the MCP scope even though its
  // protected-resource metadata advertises both.
  if (scopes.length === 0) {
    const primary = (() => {
      if (discovered.requiredScope) return discovered.requiredScope.split(' ').filter((s) => s.length > 0);
      const rmScopes = Array.isArray(discovered.resourceMetadata?.scopes_supported)
        ? (discovered.resourceMetadata.scopes_supported as unknown[]).filter(
            (s): s is string => typeof s === 'string' && s.length > 0,
          )
        : [];
      if (rmScopes.length > 0) return rmScopes;
      const asScopes: string[] = [];
      for (const as of discovered.authServers) {
        for (const s of as.scopes_supported ?? []) {
          if (s.length > 0) asScopes.push(s);
        }
      }
      return asScopes;
    })();
    for (const s of primary) {
      if (s.length === 0) continue;
      scopes.push(s);
    }
  }

  let integrationId = typeof body.integrationId === 'string' && body.integrationId.length > 0
    ? body.integrationId
    : null;

  // DCR if supported. We register against the FIRST auth server that
  // advertised a registration_endpoint; v1 does not do multi-AS
  // negotiation. The registered client_id persists on the integration
  // row so future re-authorizations reuse it (the OAuth implicit
  // contract is: a server that minted a client_id for us accepts it
  // for the life of the grant).
  const manualClientId = typeof body.clientId === 'string' && body.clientId.trim().length > 0
    ? body.clientId.trim()
    : null;
  let clientId: string | null = manualClientId;
  if (!clientId && discovered.supportsDcr) {
    const asWithReg = discovered.authServers.find(
      (s) => typeof s.registration_endpoint === 'string' &&
        s.registration_endpoint.length > 0 &&
        !s.raw.__unreachable,
    );
    if (!asWithReg) {
      return ctx.json({ error: 'discovery advertised DCR but no reachable auth server has a registration_endpoint' }, 502);
    }
    try {
      mcpLog.info(`DCR: registering with ${asWithReg.registration_endpoint} redirect_uri=${body.redirectUri} scope=${scopes.join(' ')}`);
      const reg = await registerClient(asWithReg, body.redirectUri, body.label, undefined, scopes);
      clientId = reg.client_id;
      mcpLog.info(`DCR: registered client_id=${clientId?.slice(0, 8)}...`);
    } catch (err) {
      mcpLog.error(`DCR failed: ${(err as Error).message}`);
      if (err instanceof VeniceError) {
        return ctx.json({ error: err.message, kind: err.kind }, err.status ?? 502);
      }
      return ctx.json({ error: (err as Error).message }, 502);
    }
  } else if (clientId) {
    mcpLog.info('DCR: skipped, using provided client_id');
  } else {
    return ctx.json({ error: 'server requires manual client registration; provide a client_id' }, 400);
  }

  // Authz URL needs a reachable auth server's authorization_endpoint.
  const asWithAuthz = discovered.authServers.find(
    (s) => typeof s.authorization_endpoint === 'string' &&
      s.authorization_endpoint.length > 0 &&
      !s.raw.__unreachable,
  );
  if (!asWithAuthz) {
    return ctx.json({ error: 'no reachable authorization endpoint in discovery metadata' }, 502);
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();
  const authzUrl = buildAuthzUrl(
    asWithAuthz,
    clientId ?? 'mcp-pending',
    body.redirectUri,
    scopes,
    codeChallenge,
    state,
    discovered.resource,
  );

  // Persist the integration row. Insert on a new flow; update the
  // existing on a re-paste of the same URL (the unique constraint on
  // (user_id, server_url) maps the second paste to the first row).
  // RLS OFF: filter by userId.
  if (integrationId) {
    // Updating an existing integration with a fresh registration: we
    // refresh the discovered_metadata cache, reset auth_status to
    // 'pending' (the user is re-running OAuth), and stamp the new
    // client_id + redirect URI.
    const { error } = await admin
      .from('mcp_integrations')
      .update({
        label: body.label,
        registered_redirect_uri: body.redirectUri,
        client_id: clientId,
        supports_dcr: discovered.supportsDcr,
        discovered_metadata: discovered as unknown as McpIntegrationMetadata,
        // auth_status will flip to 'authorized' on the exchange step;
        // we reset to 'pending' so a stale 'revoked' state from a prior
        // disconnect doesn't surface as "still authorized" mid-flow.
        auth_status: 'pending',
        updated_at: new Date().toISOString(),
      })
      .eq('id', integrationId)
      .eq('user_id', userId);
    if (error) {
      if (error.code === '23505') {
        return ctx.json(
          { error: 'An integration with this name or server URL already exists.' },
          409,
        );
      }
      return ctx.json({ error: `integration update failed: ${error.message}` }, 500);
    }
  } else {
    const { data, error } = await admin
      .from('mcp_integrations')
      .insert({
        user_id: userId,
        label: body.label,
        server_url: body.serverUrl,
        supports_dcr: discovered.supportsDcr,
        client_id: clientId,
        registered_redirect_uri: body.redirectUri,
        auth_status: 'pending',
        discovered_metadata: discovered as unknown as McpIntegrationMetadata,
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') {
        return ctx.json(
          { error: 'An integration with this name or server URL already exists.' },
          409,
        );
      }
      return ctx.json({ error: `integration insert failed: ${error.message}` }, 500);
    }
    integrationId = (data as { id: string }).id;
  }

  return ctx.json({
    integrationId,
    authzUrl,
    codeVerifier,
    state,
    resource: discovered.resource,
    supportsDcr: discovered.supportsDcr,
    clientId,
  });
}

/**
 * Complete the OAuth flow: validate `state`, exchange `code` for
 * tokens, persist them, list the MCP server's tools, and persist the
 * tool catalog. Returns `{ integrationId, toolCount }` so the UI can
 * render "Fastmail connected: 12 tools available" without an extra
 * round trip.
 */
async function handleMcpTokenExchange(req: Request, ctx: McpRouteCtx): Promise<Response> {
  const userId = ctx.userIdFromJwt(req);
  if (!userId) return ctx.json({ error: 'unauthorized' }, 401);

  let body: McpTokenExchangeBody;
  try {
    body = (await req.json()) as McpTokenExchangeBody;
  } catch {
    return ctx.json({ error: 'invalid JSON body' }, 400);
  }
  if (typeof body.integrationId !== 'string' || body.integrationId.length === 0) {
    return ctx.json({ error: 'body must include `integrationId`' }, 400);
  }
  if (typeof body.code !== 'string' || body.code.length === 0) {
    return ctx.json({ error: 'body must include `code`' }, 400);
  }
  if (typeof body.codeVerifier !== 'string' || body.codeVerifier.length === 0) {
    return ctx.json({ error: 'body must include `codeVerifier`' }, 400);
  }
  if (typeof body.redirectUri !== 'string' || body.redirectUri.length === 0) {
    return ctx.json({ error: 'body must include `redirectUri`' }, 400);
  }
  // `state` is browser-tracked; the browser already validated it on
  // the redirect before forwarding. We surface it back in the audit
  // log but do not independently validate (we have no shared store
  // for it - the browser holds it client-side).

  const admin = ctx.requireAdmin();
  if (admin instanceof Response) return admin;

  const integration = await getIntegration(admin, userId, body.integrationId);
  if (!integration) return ctx.json({ error: 'integration not found' }, 404);
  if (integration.auth_status !== 'pending' && integration.auth_status !== 'revoked') {
    return ctx.json({ error: `integration is in unexpected state: ${integration.auth_status}` }, 409);
  }
  if (!integration.client_id) {
    return ctx.json({ error: 'integration has no client_id (was registration skipped?)' }, 409);
  }

  const meta = integration.discovered_metadata;
  const tokenEndpoint = meta?.authServers?.find(
    (s) => typeof s.token_endpoint === 'string' && !s.raw.__unreachable,
  )?.token_endpoint;
  if (!tokenEndpoint) {
    return ctx.json({ error: 'no reachable token_endpoint in cached discovery metadata' }, 502);
  }
  if (!meta || typeof meta.resource !== 'string') {
    return ctx.json({ error: 'cached discovery metadata missing resource' }, 502);
  }

  let tokens;
  try {
    tokens = await exchangeCode(
      tokenEndpoint,
      integration.client_id,
      body.redirectUri,
      body.code,
      body.codeVerifier,
      meta.resource,
    );
  } catch (err) {
    if (err instanceof VeniceError) {
      return ctx.json({ error: err.message, kind: err.kind }, err.status ?? 502);
    }
    return ctx.json({ error: (err as Error).message }, 502);
  }

  try {
    await storeTokens(
      admin,
      userId,
      body.integrationId,
      tokens.access_token,
      tokens.refresh_token,
      tokens.expires_in,
    );
  } catch (err) {
    return ctx.json({ error: `token persistence failed: ${(err as Error).message}` }, 500);
  }

  try {
    await updateIntegrationStatus(admin, userId, body.integrationId, 'authorized', {
      granted_scopes:
        typeof tokens.scope === 'string'
          ? tokens.scope.split(' ').filter((s) => s.length > 0)
          : integration.granted_scopes,
    });
  } catch (err) {
    return ctx.json({ error: `auth_status update failed: ${(err as Error).message}` }, 500);
  }

  // Pull the tool catalog so the model can route the mcp:<id>:<tool>
  // wire names. A tools/list failure here does NOT revert the
  // authorization - the integration is usable for stretches like
  // ping/list-tools that the model can fall back to; we surface the
  // count = 0 + the error so the UI shows a partial-success state.
  let toolCount = 0;
  try {
    const tools = await listMcpTools(integration.server_url, tokens.access_token);
    await storeToolCatalog(admin, userId, body.integrationId, tools);
    toolCount = tools.length;
  } catch (err) {
    const message = err instanceof VeniceError ? err.message : (err as Error).message;
    return ctx.json({
      integrationId: body.integrationId,
      toolCount: 0,
      warning: `authorized, but tool catalog refresh failed: ${message}`,
    });
  }

  return ctx.json({ integrationId: body.integrationId, toolCount });
}

/** Manually force-refresh the token row; the dispatcher otherwise does this lazily. */
async function handleMcpRefresh(req: Request, ctx: McpRouteCtx): Promise<Response> {
  const userId = ctx.userIdFromJwt(req);
  if (!userId) return ctx.json({ error: 'unauthorized' }, 401);

  let body: McpRefreshBody;
  try {
    body = (await req.json()) as McpRefreshBody;
  } catch {
    return ctx.json({ error: 'invalid JSON body' }, 400);
  }
  if (typeof body.integrationId !== 'string' || body.integrationId.length === 0) {
    return ctx.json({ error: 'body must include `integrationId`' }, 400);
  }
  const admin = ctx.requireAdmin();
  if (admin instanceof Response) return admin;

  // Force-refresh: read the token row directly, refresh via the
  // cached token endpoint, and write the new tokens. The dispatcher's
  // shared `getValidAccessToken` helper would no-op on a still-fresh
  // token; this route is the user's "retry anyway" affordance for a
  // dead integration, so we deliberately skip the freshness check.
  // RLS OFF: filter by userId.
  const { data: tokenRow, error: readErr } = await admin
    .from('mcp_oauth_tokens')
    .select('access_token, refresh_token, access_token_expires_at')
    .eq('integration_id', body.integrationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (readErr) return ctx.json({ error: `token read failed: ${readErr.message}` }, 500);
  if (!tokenRow) return ctx.json({ error: 'no token row for integration (re-authorize)' }, 404);
  if (!tokenRow.refresh_token) {
    return ctx.json({ error: 'no refresh_token; integration needs re-authorization' }, 409);
  }

  const integration = await getIntegration(admin, userId, body.integrationId);
  if (!integration) return ctx.json({ error: 'integration not found' }, 404);
  if (!integration.client_id) {
    return ctx.json({ error: 'integration has no client_id' }, 409);
  }
  const meta = integration.discovered_metadata;
  const tokenEndpoint = meta?.authServers?.find(
    (s) => typeof s.token_endpoint === 'string' && !s.raw.__unreachable,
  )?.token_endpoint;
  if (!tokenEndpoint) {
    return ctx.json({ error: 'no cached token_endpoint in discovery metadata' }, 502);
  }

  try {
    const refreshed = await refreshOauthToken(
      tokenEndpoint,
      integration.client_id,
      tokenRow.refresh_token,
    );
    await storeTokens(
      admin,
      userId,
      body.integrationId,
      refreshed.access_token,
      refreshed.refresh_token,
      refreshed.expires_in,
    );
    return ctx.json({ ok: true, expires_in: refreshed.expires_in });
  } catch (err) {
    if (err instanceof VeniceError) {
      return ctx.json({ error: err.message, kind: err.kind }, err.status ?? 502);
    }
    return ctx.json({ error: (err as Error).message }, 502);
  }
}

/** List the user's integrations (the Settings UI's source of truth). */
async function handleMcpList(req: Request, ctx: McpRouteCtx): Promise<Response> {
  const userId = ctx.userIdFromJwt(req);
  if (!userId) return ctx.json({ error: 'unauthorized' }, 401);
  const admin = ctx.requireAdmin();
  if (admin instanceof Response) return admin;

  try {
    const integrations = await listIntegrations(admin, userId);
    return ctx.json({
      integrations: integrations.map((i) => ({
        id: i.id,
        label: i.label,
        server_url: i.server_url,
        auth_status: i.auth_status,
        supports_dcr: i.supports_dcr,
        granted_scopes: i.granted_scopes ?? [],
        created_at: i.created_at,
        updated_at: i.updated_at,
      })),
    });
  } catch (err) {
    return ctx.json({ error: (err as Error).message }, 500);
  }
}

/** Delete an integration and cascade its token + tool rows. */
async function handleMcpDelete(req: Request, ctx: McpRouteCtx): Promise<Response> {
  const userId = ctx.userIdFromJwt(req);
  if (!userId) return ctx.json({ error: 'unauthorized' }, 401);
  let body: McpByIdBody;
  try {
    body = (await req.json()) as McpByIdBody;
  } catch {
    return ctx.json({ error: 'invalid JSON body' }, 400);
  }
  if (typeof body.integrationId !== 'string' || body.integrationId.length === 0) {
    return ctx.json({ error: 'body must include `integrationId`' }, 400);
  }
  const admin = ctx.requireAdmin();
  if (admin instanceof Response) return admin;

  // RLS OFF: filter by userId. The FK cascade on integration_id handles
  // mcp_oauth_tokens + mcp_integration_tools; we delete the integration
  // row only.
  const { error } = await admin
    .from('mcp_integrations')
    .delete()
    .eq('id', body.integrationId)
    .eq('user_id', userId);
  if (error) return ctx.json({ error: `delete failed: ${error.message}` }, 500);
  return ctx.json({ ok: true });
}

/**
 * Mark an integration revoked but keep the integration row so the
 * user can re-authorize from the same pasted URL without losing the
 * label. Drops the cached token row so a stale refresh can't silently
 * succeed against a server that already revoked the grant.
 */
async function handleMcpDisconnect(req: Request, ctx: McpRouteCtx): Promise<Response> {
  const userId = ctx.userIdFromJwt(req);
  if (!userId) return ctx.json({ error: 'unauthorized' }, 401);
  let body: McpByIdBody;
  try {
    body = (await req.json()) as McpByIdBody;
  } catch {
    return ctx.json({ error: 'invalid JSON body' }, 400);
  }
  if (typeof body.integrationId !== 'string' || body.integrationId.length === 0) {
    return ctx.json({ error: 'body must include `integrationId`' }, 400);
  }
  const admin = ctx.requireAdmin();
  if (admin instanceof Response) return admin;

  try {
    await updateIntegrationStatus(admin, userId, body.integrationId, 'revoked');
  } catch (err) {
    return ctx.json({ error: `auth_status update failed: ${(err as Error).message}` }, 500);
  }
  // RLS OFF: filter by userId.
  const { error } = await admin
    .from('mcp_oauth_tokens')
    .delete()
    .eq('integration_id', body.integrationId)
    .eq('user_id', userId);
  if (error) return ctx.json({ error: `token delete failed: ${error.message}` }, 500);
  return ctx.json({ ok: true });
}

const MCP_ROUTES: Record<string, (req: Request, ctx: McpRouteCtx) => Promise<Response>> = {
  'mcp-discover': handleMcpDiscover,
  'mcp-register': handleMcpRegister,
  'mcp-token-exchange': handleMcpTokenExchange,
  'mcp-refresh': handleMcpRefresh,
  'mcp-list': handleMcpList,
  'mcp-delete': handleMcpDelete,
  'mcp-disconnect': handleMcpDisconnect,
};

/**
 * Dispatch an MCP route. Returns null if the route is not an MCP
 * route so the caller can continue its dispatch chain.
 */
export function dispatchMcpRoute(
  route: string,
  req: Request,
  ctx: McpRouteCtx,
): Promise<Response> | null {
  if (req.method !== 'POST') return null;
  const handler = MCP_ROUTES[route];
  return handler ? handler(req, ctx) : null;
}
