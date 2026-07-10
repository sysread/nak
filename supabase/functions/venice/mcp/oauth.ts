// oauth -----------------------------------------------------------------------
//
// MCP Authorization (spec 2025-06-18) over the streamable-HTTP transport.
// Pure helpers + a typed discovery result; every outbound HTTP call routes
// through the injected `fetch` so tests can pin discovery / exchange /
// refresh / tool-list flows against a fake server with no network.
//
// Discovery chain (spec-mandated order; see docs/dev/in-progress for the
// full rationale this file documents):
//   1. POST an MCP `initialize` JSON-RPC request to the server URL with
//      no Authorization header. Spec-conformant servers reply 401 and
//      carry a `WWW-Authenticate: Bearer resource_metadata="..."`
//      header pointing at their RFC 9728 Protected Resource Metadata.
//   2. Fetch the RFC 9728 document at `resource_metadata`. It lists one
//      or more `authorization_servers` issuers.
//   3. For each issuer, fetch RFC 8414
//      `/.well-known/oauth-authorization-server` metadata.
//   4. If any auth server advertises `registration_endpoint`, RFC 7591
//      Dynamic Client Registration is supported - nak self-mints the
//      `client_id` (`registerClient`) so the user gets the guided
//      paste-URL runway instead of a per-vendor portal ceremony.
//   5. Standard OAuth 2.1 Authorization Code + PKCE S256, with the
//      RFC 8707 `resource` parameter (the canonical MCP server URI) on
//      BOTH the authz URL and the token-exchange request.
//
// The `resource` value MUST be the canonical MCP server URL with no
// trailing slash on the host root (RFC 8707 + MCP Authorization spec
// §4.1). Tokens are audience-bound to that URI; a stray `/` makes
// servers reject the audience claim. `normalizeResource` enforces it.
//
// Why no `resource` on refresh_token (RFC 8707 §2.2 says SHOULD, not
// MUST): the spec leaves refresh-time audience to the authorization
// server.servers (Fastmail's MCP server is fine without; we minimize
// surface). If a future server requires it, the integration's
// `discovered_metadata.resource` is cached and a follow-up can thread
// it through `refreshToken` without a schema change.

import { VeniceError } from '../../_shared/venice.ts';

// ---------------------------------------------------------------------------
// Fetch injection
// ---------------------------------------------------------------------------

/**
 * The shape every outbound HTTP helper accepts. Defaults to the global
 * `fetch` so production callers can omit it; tests pass a stub that
 * returns canned Responses matching the discovery / token / tools-list
 * shapes this module expects.
 */
export type FetchLike = typeof fetch;

const defaultFetch: FetchLike = fetch;

// ---------------------------------------------------------------------------
// PKCE (RFC 7636) + state helpers
// ---------------------------------------------------------------------------

/**
 * URL-safe base64 with no padding. RFC 7636/8707 use this encoding for
 * the PKCE verifier and challenge; we apply it everywhere here so the
 * functions are interchangeable and the helper is one place.
 */
function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A PKCE code verifier (RFC 7636 §4.1). 32 random bytes base64url-
 * encoded produces a 43-char string in the legal 43-128 range. The
 * model never sees this; the browser keeps the verifier in the
 * integration's pending OAuth state across the redirect.
 */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/**
 * The S256 code challenge derived from a verifier (RFC 7636 §4.2).
 * Sent alongside the authz URL; the server recomputes it during the
 * token exchange to prove the verifier was not tampered with in
 * transit. SHA-256 over the verifier bytes, base64url-encoded.
 */
export async function generateCodeChallenge(
  verifier: string,
): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64url(digest);
}

/** A 22-char opaque state token base64url-encoded from 16 random bytes. */
export function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

// ---------------------------------------------------------------------------
// Resource (RFC 8707) canonicalization
// ---------------------------------------------------------------------------

/**
 * Canonicalize the MCP server URL for use as the RFC 8707 `resource`
 * parameter. RFC 8707 §2.1 defines the resource parameter as an
 * absolute URI; MCP Authorization §4.1 additionally requires the host
 * root to carry NO trailing slash so audience comparison at the
 * server is byte-exact. A trailing slash on `https://host/mcp` is
 * trimmed; `https://host/` collapses to `https://host`.
 */
export function normalizeResource(serverUrl: string): string {
  let s = serverUrl.trim();
  // RFC 3986 lets URIs carry a trailing slash on the path; MCP
  // Authorization §4.1 forbids it on the host root. Walk the path
  // portion only so we never strip a meaningful slash mid-path.
  // Host root (`https://host` or `https://host/`) -> `https://host`;
  // a sub-path (`https://host/mcp/`) -> `https://host/mcp`.
  try {
    const u = new URL(s);
    let path = u.pathname;
    while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    u.pathname = path;
    s = u.toString();
  } catch {
    // Fall back to a naive strip so a non-URL input still degrades
    // (callers validate the URL upstream).
    while (s.length > 0 && s.endsWith('/')) s = s.slice(0, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Plucked + raw RFC 8414 OAuth Authorization Server Metadata. We carry
 * the raw object so fields we have not anticipated (e.g. a server's
 * non-standard `introspection_endpoint`) survive the round trip into
 * the integration row's `discovered_metadata` cache without a schema
 * change every time a new field lands in the spec.
 */
export interface AuthServerMetadata {
  /** Issuer URL (RFC 8414 `issuer`). */
  issuer: string;
  /** Authorization endpoint URL. */
  authorization_endpoint?: string;
  /** Token endpoint URL - required for OAuth 2.1 to function. */
  token_endpoint?: string;
  /** RFC 7591 DCR endpoint. Presence is what `DiscoveredMetadata.supportsDcr` checks. */
  registration_endpoint?: string;
  revocation_endpoint?: string;
  /** Scopes the server claims to support. */
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
  /** `['none']` = public PKCE-only client, the common MCP-server shape. */
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
  /** Pass-through of the entire metadata document for unknown fields. */
  raw: Record<string, unknown>;
}

/**
 * The full discovery result - one RFC 9728 Protected Resource Metadata
 * document plus one RFC 8414 entry per issuer in its
 * `authorization_servers`. Cached on the integration row as
 * `discovered_metadata` so the edge function does not refetch on
 * every tool-dispatch refresh.
 */
export interface DiscoveredMetadata {
  /** Canonical MCP server URL (no host-root trailing slash). RFC 8707 `resource` value. */
  resource: string;
  /** Raw RFC 9728 metadata, including `authorization_servers: string[]`. */
  resourceMetadata: Record<string, unknown>;
  /** One entry per `authorization_servers` issuer, with plucked RFC 8414 fields + raw. */
  authServers: AuthServerMetadata[];
  /** True when any auth server advertised `registration_endpoint` (RFC 7591 DCR). */
  supportsDcr: boolean;
  /**
   * True when the server answered the unauthenticated `initialize`
   * POST with 200 - no OAuth flow required. `authServers` is empty;
   * the caller may call `listMcpTools` directly with no token.
   */
  authNotRequired: boolean;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RegisteredClient {
  client_id: string;
  /** Present only when the server minted a secret; null for public PKCE-only clients. */
  client_secret?: string | null;
}

export interface TokenSet {
  access_token: string;
  /** Servers MAY rotate the refresh token per OAuth 2.1; null when not returned. */
  refresh_token: string | null;
  /** Seconds until the access token expires. Null when the server omitted it. */
  expires_in: number | null;
  /** Space-delimited granted scope string, as the server echoed it. */
  scope: string | null;
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC payloads
// ---------------------------------------------------------------------------

// Protocol version we advertise in the `initialize` request. Pinned to
// the spec snapshot version we target; bumping is a coordinated change
// with the server's reported `protocolVersion` in the initialize
// response, which we currently ignore (stateless consumption).
const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_CLIENT_NAME = 'nak';
const MCP_CLIENT_VERSION = '1';

function mcpInitializeRequest(): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    },
  };
}

function mcpToolsListRequest(): unknown {
  return { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
}

function mcpToolsCallRequest(
  id: number,
  name: string,
  args: Record<string, unknown>,
): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Parse a `WWW-Authenticate: Bearer resource_metadata="..."`
 * (or bare-URL variant) header into the resource-metadata document URL.
 * Returns null when the header is absent or carries no URL we can
 * extract, signaling the caller to fall back to the well-known path.
 */
export function parseResourceMetadataFromHeader(
  headerValue: string | null,
): string | null {
  if (!headerValue) return null;
  // The MCP Authorization spec exemplar is
  //   Bearer resource_metadata="https://host/.well-known/..."
  // but RFC 7235 lets the auth-scheme params drift; the regex is
  // tolerant of commas, spaces, and the optional "Bearer " prefix
  // while still requiring a quoted URL so it doesn't grab `realm=`
  // strings.
  const quoted = headerValue.match(/resource_metadata="([^"]+)"/i);
  if (quoted && quoted[1]) return quoted[1];
  // Tolerate an unquoted absolute URI as the only token.
  const bare = headerValue.match(/resource_metadata=([^\s,]+)/i);
  if (bare && bare[1]) return bare[1];
  return null;
}

/**
 * Derive the RFC 9728 well-known URL for an MCP server that did NOT
 * advertise its resource-metadata URL in the 401 header (older
 * servers, or proxies that strip it). Spec says the well-known path
 * lives at `/.well-known/oauth-protected-resource` off the resource
 * root; we preserve the host + path of the server URL.
 */
function wellKnownResourceUrl(serverUrl: string): string {
  const u = new URL(serverUrl);
  // RFC 9728 §4 mandates the path literal
  // /.well-known/oauth-protected-resource. Append it to the server
  // URL's directory: a server at https://host/mcp serves its
  // resource metadata at https://host/mcp/.well-known/... (the
  // well-known segment is relative to the resource, not the host
  // root, per RFC 9728 §4.1).
  let base = u.origin + u.pathname;
  while (base.endsWith('/')) base = base.slice(0, -1);
  return `${base}/.well-known/oauth-protected-resource`;
}

function wellKnownAuthServerUrl(issuer: string): string {
  let base = issuer.trim();
  while (base.endsWith('/')) base = base.slice(0, -1);
  return `${base}/.well-known/oauth-authorization-server`;
}

/**
 * Run the MCP Authorization discovery chain against `serverUrl`.
 * Never throws for "auth not required"; throws a typed VeniceError
 * (`kind: 'auth'`) when no 401 + no WWW-Authenticate surfaced AND
 * the well-known direct fetch also fails, so the caller can surface
 * "this MCP server's auth is not discoverable" distinctly from a
 * network blip (`kind: 'network'`).
 */
export async function discoverMetadata(
  serverUrl: string,
  fetchFn: FetchLike = defaultFetch,
): Promise<DiscoveredMetadata> {
  const resource = normalizeResource(serverUrl);

  // Step 1: probe the server unauthenticated. A spec-conformant
  // server returns 401 with `WWW-Authenticate`; an unprotected
  // server returns 200 (or the initialized handshake response) and
  // no further discovery is needed.
  const probe = await fetchFn(resource, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(mcpInitializeRequest()),
  });

  if (probe.ok) {
    // No auth required for this MCP server. Surfacing the metadata
    // as `authNotRequired: true` lets the registration step skip and
    // the caller proceed straight to `listMcpTools` with no token.
    return {
      resource,
      resourceMetadata: {},
      authServers: [],
      supportsDcr: false,
      authNotRequired: true,
    };
  }

  if (probe.status !== 401) {
    throw new VeniceError(
      `MCP server returned ${probe.status} (expected 401 to start OAuth discovery)`,
      'http',
      probe.status,
    );
  }

  // Step 2: resolve the RFC 9728 resource metadata URL - from the
  // header preferentially, fall back to the well-known direct fetch.
  const fromHeader = parseResourceMetadataFromHeader(
    probe.headers.get('WWW-Authenticate'),
  );
  const resourceMetadataUrl = fromHeader ?? wellKnownResourceUrl(resource);

  const rmResp = await fetchFn(resourceMetadataUrl, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!rmResp.ok) {
    throw new VeniceError(
      `RFC 9728 resource metadata fetch failed: ${rmResp.status} for ${resourceMetadataUrl}`,
      'http',
      rmResp.status,
    );
  }
  const resourceMetadata = (await rmResp.json()) as Record<string, unknown>;
  // RFC 9728 §3 names an array of issuer URLs in
  // `authorization_servers`. The MCP Authorization spec makes this
  // the canonical entry point for an MCP server's auth surface.
  const authorizationServers = Array.isArray(resourceMetadata.authorization_servers)
    ? (resourceMetadata.authorization_servers as unknown[])
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];
  if (authorizationServers.length === 0) {
    throw new VeniceError(
      `RFC 9728 resource metadata at ${resourceMetadataUrl} advertised no \`authorization_servers\``,
      'parse',
    );
  }

  // Step 3: fetch RFC 8414 metadata for each auth server issuer.
  // We eagerly resolve every issuer; nak currently registers
  // against the first that supports DCR but advertises the full
  // set back to the browser so a future "which AS do you want?"
  // UI doesn't need a re-discovery round trip.
  const authServers: AuthServerMetadata[] = [];
  for (const issuer of authorizationServers) {
    let asResp: Response;
    try {
      asResp = await fetchFn(wellKnownAuthServerUrl(issuer), {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      // A single issuer being unreachable is a soft failure; the
      // caller picks another from `authServers`. We re-throw only
      // when ALL issuers failed.
      authServers.push({
        issuer,
        raw: { __unreachable: String((err as Error).message ?? err) },
      });
      continue;
    }
    if (!asResp.ok) {
      authServers.push({
        issuer,
        raw: { __unreachable: `HTTP ${asResp.status}` },
      });
      continue;
    }
    const raw = (await asResp.json()) as Record<string, unknown>;
    authServers.push({
      issuer,
      authorization_endpoint: typeof raw.authorization_endpoint === 'string'
        ? raw.authorization_endpoint
        : undefined,
      token_endpoint: typeof raw.token_endpoint === 'string'
        ? raw.token_endpoint
        : undefined,
      registration_endpoint: typeof raw.registration_endpoint === 'string'
        ? raw.registration_endpoint
        : undefined,
      revocation_endpoint: typeof raw.revocation_endpoint === 'string'
        ? raw.revocation_endpoint
        : undefined,
      scopes_supported: Array.isArray(raw.scopes_supported)
        ? (raw.scopes_supported as unknown[]).filter(
            (s): s is string => typeof s === 'string',
          )
        : undefined,
      response_types_supported: Array.isArray(raw.response_types_supported)
        ? (raw.response_types_supported as unknown[]).filter(
            (s): s is string => typeof s === 'string',
          )
        : undefined,
      grant_types_supported: Array.isArray(raw.grant_types_supported)
        ? (raw.grant_types_supported as unknown[]).filter(
            (s): s is string => typeof s === 'string',
          )
        : undefined,
      token_endpoint_auth_methods_supported: Array.isArray(
        raw.token_endpoint_auth_methods_supported,
      )
        ? (raw.token_endpoint_auth_methods_supported as unknown[]).filter(
            (s): s is string => typeof s === 'string',
          )
        : undefined,
      code_challenge_methods_supported: Array.isArray(
        raw.code_challenge_methods_supported,
      )
        ? (raw.code_challenge_methods_supported as unknown[]).filter(
            (s): s is string => typeof s === 'string',
          )
        : undefined,
      raw,
    });
  }

  const reachable = authServers.filter(
    (s) => !s.raw.__unreachable,
  );
  if (reachable.length === 0) {
    throw new VeniceError(
      `all ${authServers.length} advertised authorization server(s) for ${resource} were unreachable`,
      'network',
    );
  }

  const supportsDcr = reachable.some(
    (s) => typeof s.registration_endpoint === 'string' &&
      s.registration_endpoint.length > 0,
  );

  return {
    resource,
    resourceMetadata,
    authServers,
    supportsDcr,
    authNotRequired: false,
  };
}

// ---------------------------------------------------------------------------
// RFC 7591 Dynamic Client Registration
// ---------------------------------------------------------------------------

/**
 * Self-register a public OAuth client against an auth server that
 * advertises RFC 7591 DCR (`registration_endpoint` in its RFC 8414
 * metadata). The registration body matches the MCP Authorization
 * spec's recommended public-client shape: PKCE-only
 * (`token_endpoint_auth_method: 'none'`), Authorization Code +
 * refresh_token grants, single redirect URI, an `offline_access`
 * scope request so the issued grant carries a refresh token.
 *
 * Returns the `client_id` (and `client_secret` when the server minted
 * one, which PKCE-only servers typically do not). Throws a VeniceError
 * on any non-success status - the discoverability contract is that
 * servers advertising a `registration_endpoint` are expected to
 * accept the registration; a 4xx here is a server-side surprise, not
 * a "user typed the wrong URL" case.
 */
export async function registerClient(
  authServerMetadata: AuthServerMetadata,
  redirectUri: string,
  fetchFn: FetchLike = defaultFetch,
): Promise<RegisteredClient> {
  if (!authServerMetadata.registration_endpoint) {
    throw new VeniceError(
      `auth server ${authServerMetadata.issuer} advertised no \`registration_endpoint\``,
      'auth',
    );
  }
  const resp = await fetchFn(authServerMetadata.registration_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'offline_access',
    }),
  });
  if (!resp.ok) {
    let bodyText = '';
    try {
      bodyText = await resp.text();
    } catch {
      /* keep bodyText empty; the status line is the actionable detail */
    }
    throw new VeniceError(
      `RFC 7591 registration failed: ${resp.status}` +
        (bodyText ? ` - ${bodyText.slice(0, 400)}` : ''),
      'http',
      resp.status,
    );
  }
  const json = (await resp.json()) as Record<string, unknown>;
  const clientId = typeof json.client_id === 'string' ? json.client_id : null;
  if (!clientId) {
    throw new VeniceError(
      'RFC 7591 registration response missing `client_id`',
      'parse',
    );
  }
  const clientSecret =
    typeof json.client_secret === 'string' ? json.client_secret : null;
  return { client_id: clientId, client_secret: clientSecret };
}

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

/**
 * Assemble the Authorization Code flow URL the browser navigates to.
 * Required parameters per OAuth 2.1 + RFC 7636 + RFC 8707 +
 * MCP Authorization §6.2:
 *
 *   - client_id, redirect_uri, response_type=code
 *   - scope (server may add more; `offline_access` carries the refresh grant)
 *   - code_challenge (S256-derived from the verifier the browser keeps)
 *   - code_challenge_method=S256
 *   - state (CSRF/binding token; the browser round-trips it through the
 *     redirect and we verify on /mcp-token-exchange)
 *   - resource (RFC 8707) - canonical MCP server URI, audience-binding
 *     the issued token to this exact server so a stolen token from one
 *     integration cannot be replayed against another
 *
 * Pure string assembly; no I/O.
 */
export function buildAuthzUrl(
  authServerMetadata: AuthServerMetadata,
  clientId: string,
  redirectUri: string,
  scopes: string[],
  codeChallenge: string,
  state: string,
  resource: string,
): string {
  if (!authServerMetadata.authorization_endpoint) {
    throw new VeniceError(
      `auth server ${authServerMetadata.issuer} advertised no \`authorization_endpoint\``,
      'auth',
    );
  }
  const u = new URL(authServerMetadata.authorization_endpoint);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  // Prepend `offline_access` if the caller didn't ask for it; MCP
  // Authorization §6.2 makes the refresh grant depend on the
  // `offline_access` scope and we never want a re-authorization
  // cycle just because a settings UI omitted it.
  const scopeSet = new Set([
    'offline_access',
    ...scopes.filter((s) => s.length > 0),
  ]);
  u.searchParams.set('scope', Array.from(scopeSet).join(' '));
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  u.searchParams.set('resource', resource);
  return u.toString();
}

// ---------------------------------------------------------------------------
// Token exchange + refresh
// ---------------------------------------------------------------------------

async function postForm(
  url: string,
  params: Record<string, string>,
  fetchFn: FetchLike,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(params).toString();
  const resp = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });
  let payload: Record<string, unknown> = {};
  if (resp.status === 204) {
    // No-body success - some non-RFC servers return 204 on refresh.
    return {};
  }
  const text = await resp.text();
  if (text.length > 0) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // A few OAuth servers (rare) return form-urlencoded for JSON
      // claiming `application/json`; tolerate it.
      try {
        const parsed = new URLSearchParams(text);
        for (const [k, v] of parsed.entries()) payload[k] = v;
      } catch {
        // Fall through to the status-based error path with an empty
        // payload; the caller's error will cite the status.
      }
    }
  }
  if (!resp.ok) {
    const err = (payload.error as string | undefined) ?? '';
    const errDesc = (payload.error_description as string | undefined) ?? '';
    throw new VeniceError(
      `token endpoint ${url} returned ${resp.status}` +
        (err ? `: ${err}` : '') +
        (errDesc ? ` - ${errDesc}` : ''),
      err === 'invalid_grant' ? 'auth' : 'http',
      resp.status,
    );
  }
  return payload;
}

/**
 * Exchange an authorization code for the first access + refresh token
 * pair (OAuth 2.1 Authorization Code grant). The `resource` parameter
 * is mandatory per RFC 8707 §2.1 and MUST match the value on the
 * authz URL; the server audience-binds the issued token to that
 * resource.
 *
 * Public PKCE-only client (no Authorization header). The
 * `code_verifier` is the original PKCE verifier bound to the
 * `code_challenge` in the authz URL; the server recomputes the
 * challenge from this verifier and rejects on mismatch.
 */
export async function exchangeCode(
  tokenEndpoint: string,
  clientId: string,
  redirectUri: string,
  code: string,
  codeVerifier: string,
  resource: string,
  fetchFn: FetchLike = defaultFetch,
): Promise<TokenSet> {
  const payload = await postForm(
    tokenEndpoint,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
      resource,
    },
    fetchFn,
  );
  return pluckTokenSet(payload);
}

/**
 * Refresh an expiring access token using the stored refresh token
 * (OAuth 2.1 refresh_token grant). RFC 8707 §2.2 names `resource`
 * on the refresh grant as SHOULD rather than MUST; this signature
 * omits it deliberately - the auth server's audience binding
 * survives the grant per RFC 8707 §2.2 in practice across the
 * MCP servers nak targets today (Fastmail's MCP server is happy
 * without it). If a future server requires it, thread the cached
 * `discovered_metadata.resource` here without touching the schema.
 *
 * Servers MAY rotate the refresh token on every refresh (OAuth 2.1
 * public-client default; Fastmail's MCP OAuth does). Caller MUST
 * persist the returned `refresh_token` when present and treat the
 * old one as invalidated-on-reuse.
 */
export async function refreshToken(
  tokenEndpoint: string,
  clientId: string,
  oldRefreshToken: string,
  fetchFn: FetchLike = defaultFetch,
): Promise<TokenSet> {
  const payload = await postForm(
    tokenEndpoint,
    {
      grant_type: 'refresh_token',
      refresh_token: oldRefreshToken,
      client_id: clientId,
    },
    fetchFn,
  );
  return pluckTokenSet(payload);
}

function pluckTokenSet(payload: Record<string, unknown>): TokenSet {
  const access_token = payload.access_token;
  if (typeof access_token !== 'string' || access_token.length === 0) {
    throw new VeniceError(
      'token endpoint response missing `access_token`',
      'parse',
    );
  }
  return {
    access_token,
    refresh_token:
      typeof payload.refresh_token === 'string' ? payload.refresh_token : null,
    expires_in:
      typeof payload.expires_in === 'number' ? payload.expires_in : null,
    scope: typeof payload.scope === 'string' ? payload.scope : null,
  };
}

// ---------------------------------------------------------------------------
// MCP tool list / tool call
// ---------------------------------------------------------------------------

/**
 * Probe an MCP server with a bearer token and return its `tools/list`
 * catalog. Performs the MCP Authorization §3.2 streamable-HTTP
 * handshake: a single `initialize` POST followed by `tools/list`.
 * Stateful-protocol-session MCP servers (which nak does not run
 * against) require an `initialized` notification; remote streamable
 * HTTP servers treat each request independently and accept the
 * `initialize` + `tools/list` pair on a fresh connection.
 *
 * Each tool descriptor carries the server's `name`, `description`,
 * and `inputSchema` verbatim. The caller is responsible for
 * namespacing the wire name (`mcp:<integrationId>:<serverToolName>`)
 * so an MCP tool from one integration cannot collide with another's.
 */
export async function listMcpTools(
  serverUrl: string,
  accessToken: string,
  fetchFn: FetchLike = defaultFetch,
): Promise<McpToolDescriptor[]> {
  const resource = normalizeResource(serverUrl);
  const headers = (extra?: Record<string, string>): Record<string, string> => ({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${accessToken}`,
    ...extra,
  });

  // initialize - we treat an HTTP failure here as terminal (the
  // token is rejected, the server is down, or the URL is wrong).
  // A 200 with an MCP error payload means the server is up but the
  // request itself failed; we surface that as a parse error so the
  // caller can tell "couldn't list tools" from "token rejected".
  const initResp = await fetchFn(resource, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(mcpInitializeRequest()),
  });
  if (!initResp.ok) {
    throw new VeniceError(
      `MCP \`initialize\` against ${resource} failed: ${initResp.status}`,
      initResp.status === 401 ? 'auth' : 'http',
      initResp.status,
    );
  }
  await drainMcpResponse(initResp);

  const listResp = await fetchFn(resource, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(mcpToolsListRequest()),
  });
  if (!listResp.ok) {
    throw new VeniceError(
      `MCP \`tools/list\` against ${resource} failed: ${listResp.status}`,
      listResp.status === 401 ? 'auth' : 'http',
      listResp.status,
    );
  }
  const result = await readMcpResult(listResp);
  const tools = (result?.tools ?? []) as unknown[];
  return tools
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .map((t) => ({
      name: typeof t.name === 'string' ? t.name : '',
      description: typeof t.description === 'string' ? t.description : '',
      inputSchema:
        (t.inputSchema as Record<string, unknown> | undefined) ?? {},
    }))
    .filter((t) => t.name.length > 0);
}

/**
 * One item in an MCP `tools/call` result `content` array. The shape is
 * open per spec (`type: 'text'`, `type: 'image'`, `type: 'resource'`,
 * etc.) - we keep it as a loose record and let the caller decide
 * how to project it back onto the chat-loop's tool-result row.
 */
export type McpToolResultContentItem = Record<string, unknown>;

/**
 * Run one MCP tool call. Resolves with the raw `content` array and the
 * `isError` flag the server returned. We do NOT throw on `isError:
 * true` - that is a tool-level error (e.g. "no rows matched"), and the
 * chat model should see it rather than be told the dispatch itself
 * failed. We DO throw on HTTP / transport / auth errors, so the
 * chat-loop's tool-error path surfaces the failure distinctly.
 */
export async function callMcpTool(
  serverUrl: string,
  accessToken: string,
  serverToolName: string,
  args: Record<string, unknown>,
  fetchFn: FetchLike = defaultFetch,
): Promise<{
  content: McpToolResultContentItem[];
  isError: boolean;
}> {
  const resource = normalizeResource(serverUrl);
  const id = Math.floor(Math.random() * 1_000_000) + 1;
  const resp = await fetchFn(resource, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(mcpToolsCallRequest(id, serverToolName, args)),
  });
  if (!resp.ok) {
    throw new VeniceError(
      `MCP \`tools/call\` to ${resource} failed: ${resp.status}`,
      resp.status === 401 ? 'auth' : 'http',
      resp.status,
    );
  }
  const result = await readMcpResult(resp);
  if (result && typeof result.isError === 'boolean' && result.isError) {
    return {
      content: (result.content as McpToolResultContentItem[]) ?? [],
      isError: true,
    };
  }
  return {
    content: (result?.content as McpToolResultContentItem[]) ?? [],
    isError: false,
  };
}

/**
 * The MCP streamable-HTTP transport may answer with either a single
 * JSON body or an SSE stream of `event: message` frames (per the
 * MCP Authorization spec §3.2). Read both paths and return the
 * parsed JSON-RPC `result` object.
 */
async function readMcpResult(
  resp: Response,
): Promise<Record<string, unknown> | null> {
  // The fresh `initialize` POST we don't care about the body for;
  // caller uses drainMcpResponse. For stateful handshakes we'd need
  // the negotiated `protocolVersion`, but remote streamable HTTP
  // servers we target are stateless and accept any pinned version,
  // so we discard the initialization payload.
  const contentType = resp.headers.get('Content-Type') ?? '';
  if (contentType.includes('text/event-stream')) {
    return await readSseResult(resp);
  }
  const text = await resp.text();
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VeniceError(
      `MCP response was not valid JSON: ${text.slice(0, 200)}`,
      'parse',
    );
  }
  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    const err = (parsed as Record<string, unknown>).error as
      | Record<string, unknown>
      | undefined;
    throw new VeniceError(
      `MCP JSON-RPC error${err?.message ? `: ${err.message}` : ''}`,
      'http',
    );
  }
  if (parsed && typeof parsed === 'object' && 'result' in parsed) {
    return (parsed as Record<string, unknown>).result as
      | Record<string, unknown>
      | null;
  }
  return parsed as Record<string, unknown> | null;
}

/** Consume the initialize response's body without inspecting it. */
async function drainMcpResponse(resp: Response): Promise<void> {
  try {
    await resp.body?.cancel();
  } catch {
    /* swallow; the body is consumed-on-already-read in some shims */
  }
}

/**
 * Parse the `event: message` SSE frames an MCP streamable-HTTP
 * server may emit until the first frame carrying a JSON-RPC
 * `result`. The `id` we set on the request matches the response's
 * `id` so a single-stream multi-request client could demux; we run
 * one request per connection so any result frame ends the read.
 */
async function readSseResult(
  resp: Response,
): Promise<Record<string, unknown> | null> {
  const reader = resp.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let buf = '';
  let result: Record<string, unknown> | null = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      // SSE frames are separated by blank lines; parse greedily.
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const dataLines = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim());
        if (dataLines.length === 0) continue;
        const json = dataLines.join('\n');
        try {
          const parsed = JSON.parse(json);
          if (parsed && typeof parsed === 'object' && 'result' in parsed) {
            result = (parsed as Record<string, unknown>).result as
              | Record<string, unknown>
              | null;
            return result;
          }
          if (parsed && typeof parsed === 'object' && 'error' in parsed) {
            const err = (parsed as Record<string, unknown>).error as
              | Record<string, unknown>
              | undefined;
            throw new VeniceError(
              `MCP JSON-RPC error${err?.message ? `: ${err.message}` : ''}`,
              'http',
            );
          }
        } catch (e) {
          if (e instanceof VeniceError) throw e;
          // Non-JSON data frame - skip; MCP control frames use this shape.
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  return result;
}