// Unit coverage for the MCP OAuth module (Deno island). The module
// is designed for fetch-injection: every outbound HTTP call routes
// through a `FetchLike` parameter so tests pin discovery, exchange,
// refresh, and tool-list flows against a fake server with no network.
//
// The pure helpers (normalizeResource, parseScopeFromHeader,
// parseResourceMetadataFromHeader, buildAuthzUrl) get direct
// behavioral coverage. The fetch-injectable functions
// (discoverMetadata, listMcpTools, exchangeCode, refreshToken) get
// end-to-end coverage with a mock fetch that returns canned responses.
import {
  assertEquals,
  assertRejects,
} from 'jsr:@std/assert';
import {
  normalizeResource,
  parseScopeFromHeader,
  parseResourceMetadataFromHeader,
  buildAuthzUrl,
  discoverMetadata,
  listMcpTools,
  exchangeCode,
  refreshToken,
  type FetchLike,
  type AuthServerMetadata,
} from '../venice/mcp/oauth.ts';
import { VeniceError } from '../_shared/venice.ts';

// --- normalizeResource ------------------------------------------------------

Deno.test('normalizeResource: trims path trailing slash', () => {
  assertEquals(
    normalizeResource('https://host/mcp/'),
    'https://host/mcp',
  );
});

Deno.test('normalizeResource: preserves sub-path without slash', () => {
  assertEquals(
    normalizeResource('https://api.fastmail.com/mcp'),
    'https://api.fastmail.com/mcp',
  );
});

Deno.test('normalizeResource: strips multiple trailing slashes on path', () => {
  assertEquals(
    normalizeResource('https://host/mcp///'),
    'https://host/mcp',
  );
});

Deno.test('normalizeResource: degrades on non-URL input', () => {
  assertEquals(normalizeResource('not-a-url/'), 'not-a-url');
});

// --- parseScopeFromHeader ---------------------------------------------------

Deno.test('parseScopeFromHeader: extracts quoted scope', () => {
  const header = 'Bearer resource_metadata="https://host/.well-known/x" scope="https://www.fastmail.com/dev/mcp"';
  assertEquals(parseScopeFromHeader(header), 'https://www.fastmail.com/dev/mcp');
});

Deno.test('parseScopeFromHeader: extracts bare scope', () => {
  const header = 'Bearer scope=read';
  assertEquals(parseScopeFromHeader(header), 'read');
});

Deno.test('parseScopeFromHeader: returns null when no scope param', () => {
  const header = 'Bearer resource_metadata="https://host/.well-known/x"';
  assertEquals(parseScopeFromHeader(header), null);
});

Deno.test('parseScopeFromHeader: returns null on null input', () => {
  assertEquals(parseScopeFromHeader(null), null);
});

// --- parseResourceMetadataFromHeader ----------------------------------------

Deno.test('parseResourceMetadataFromHeader: extracts quoted URL', () => {
  const header = 'Bearer resource_metadata="https://host/.well-known/oauth-protected-resource/mcp"';
  assertEquals(
    parseResourceMetadataFromHeader(header),
    'https://host/.well-known/oauth-protected-resource/mcp',
  );
});

Deno.test('parseResourceMetadataFromHeader: extracts bare URL', () => {
  const header = 'Bearer resource_metadata=https://host/.well-known/x';
  assertEquals(
    parseResourceMetadataFromHeader(header),
    'https://host/.well-known/x',
  );
});

Deno.test('parseResourceMetadataFromHeader: returns null when absent', () => {
  assertEquals(parseResourceMetadataFromHeader('Bearer realm="foo"'), null);
  assertEquals(parseResourceMetadataFromHeader(null), null);
});

// --- buildAuthzUrl ----------------------------------------------------------

Deno.test('buildAuthzUrl: assembles a complete OAuth 2.1 + PKCE + RFC 8707 URL', () => {
  const meta: AuthServerMetadata = {
    issuer: 'https://auth.example.com',
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    raw: {},
  };
  const url = buildAuthzUrl(
    meta,
    'client-123',
    'https://nak.example.com/callback',
    ['https://www.fastmail.com/dev/mcp'],
    'challenge-abc',
    'state-xyz',
    'https://api.fastmail.com/mcp',
  );
  const parsed = new URL(url);
  assertEquals(parsed.origin + parsed.pathname, 'https://auth.example.com/authorize');
  assertEquals(parsed.searchParams.get('client_id'), 'client-123');
  assertEquals(parsed.searchParams.get('redirect_uri'), 'https://nak.example.com/callback');
  assertEquals(parsed.searchParams.get('response_type'), 'code');
  assertEquals(parsed.searchParams.get('scope'), 'https://www.fastmail.com/dev/mcp');
  assertEquals(parsed.searchParams.get('code_challenge'), 'challenge-abc');
  assertEquals(parsed.searchParams.get('code_challenge_method'), 'S256');
  assertEquals(parsed.searchParams.get('state'), 'state-xyz');
  assertEquals(parsed.searchParams.get('resource'), 'https://api.fastmail.com/mcp');
});

Deno.test('buildAuthzUrl: throws when no authorization_endpoint', async () => {
  const meta: AuthServerMetadata = {
    issuer: 'https://auth.example.com',
    raw: {},
  };
  await assertRejects(
    async () => buildAuthzUrl(meta, 'c', 'r', ['s'], 'ch', 'st', 'res'),
    VeniceError,
  );
});

// --- mock fetch -------------------------------------------------------------

/** Build a mock fetch that returns canned responses in call order. */
function mockFetch(
  responses: Array<{
    status: number;
    body: string;
    headers?: Record<string, string>;
  }>,
): FetchLike {
  let idx = 0;
  return (async (input: Parameters<FetchLike>[0]) => {
    const resp = responses[idx++];
    if (!resp) {
      const url = typeof input === 'string' ? input : input.toString();
      throw new Error(`mock fetch: no more responses (call #${idx} for ${url})`);
    }
    return new Response(resp.body, {
      status: resp.status,
      headers: resp.headers,
    }) as unknown as globalThis.Response;
  }) as FetchLike;
}

// --- discoverMetadata (fetch-injected) --------------------------------------

Deno.test('discoverMetadata: returns authNotRequired when server responds 200', async () => {
  const fetchFn = mockFetch([
    { status: 200, body: '{}' },
  ]);
  const result = await discoverMetadata('https://host/mcp', fetchFn);
  assertEquals(result.authNotRequired, true);
  assertEquals(result.authServers, []);
  assertEquals(result.supportsDcr, false);
});

Deno.test('discoverMetadata: follows the 401 -> RFC 9728 -> RFC 8414 chain', async () => {
  const fetchFn = mockFetch([
    {
      status: 401,
      body: '',
      headers: {
        'WWW-Authenticate':
          'Bearer resource_metadata="https://host/.well-known/oauth-protected-resource/mcp" scope="https://scope.test"',
      },
    },
    {
      status: 200,
      body: JSON.stringify({
        resource: 'https://host/mcp',
        authorization_servers: ['https://auth.host'],
      }),
    },
    {
      status: 200,
      body: JSON.stringify({
        issuer: 'https://auth.host',
        authorization_endpoint: 'https://auth.host/authorize',
        token_endpoint: 'https://auth.host/token',
        registration_endpoint: 'https://auth.host/register',
        scopes_supported: ['https://scope.test'],
      }),
    },
  ]);
  const result = await discoverMetadata('https://host/mcp', fetchFn);
  assertEquals(result.resource, 'https://host/mcp');
  assertEquals(result.requiredScope, 'https://scope.test');
  assertEquals(result.authServers.length, 1);
  assertEquals(result.authServers[0].issuer, 'https://auth.host');
  assertEquals(result.authServers[0].authorization_endpoint, 'https://auth.host/authorize');
  assertEquals(result.supportsDcr, true);
});

Deno.test('discoverMetadata: supportsDcr=false when no registration_endpoint', async () => {
  const fetchFn = mockFetch([
    {
      status: 401,
      body: '',
      headers: {
        'WWW-Authenticate':
          'Bearer resource_metadata="https://host/.well-known/oauth-protected-resource/mcp"',
      },
    },
    {
      status: 200,
      body: JSON.stringify({
        resource: 'https://host/mcp',
        authorization_servers: ['https://auth.host'],
      }),
    },
    {
      status: 200,
      body: JSON.stringify({
        issuer: 'https://auth.host',
        authorization_endpoint: 'https://auth.host/authorize',
        token_endpoint: 'https://auth.host/token',
      }),
    },
  ]);
  const result = await discoverMetadata('https://host/mcp', fetchFn);
  assertEquals(result.supportsDcr, false);
});

// --- listMcpTools (fetch-injected) ------------------------------------------

Deno.test('listMcpTools: initialize + tools/list returns descriptors', async () => {
  const fetchFn = mockFetch([
    {
      status: 200,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2025-06-18', capabilities: {} },
      }),
      headers: { 'Mcp-Session-Id': 'sess-123' },
    },
    {
      status: 200,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: [
            {
              name: 'search_email',
              description: "Search the user's mailbox",
              inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
            },
            {
              name: 'send_email',
              description: 'Send an email',
              inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
            },
          ],
        },
      }),
    },
  ]);
  const tools = await listMcpTools('https://host/mcp', 'token-abc', fetchFn);
  assertEquals(tools.length, 2);
  assertEquals(tools[0].name, 'search_email');
  assertEquals(tools[1].name, 'send_email');
});

Deno.test('listMcpTools: throws auth error on 401', async () => {
  const fetchFn = mockFetch([
    { status: 401, body: '' },
  ]);
  await assertRejects(
    () => listMcpTools('https://host/mcp', 'bad-token', fetchFn),
    VeniceError,
  );
});

// --- exchangeCode (fetch-injected) ------------------------------------------

Deno.test('exchangeCode: returns tokens on success', async () => {
  const fetchFn = mockFetch([
    {
      status: 200,
      body: JSON.stringify({
        access_token: 'at-123',
        refresh_token: 'rt-456',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'https://scope.test',
      }),
    },
  ]);
  const tokens = await exchangeCode(
    'https://auth.host/token',
    'client-123',
    'https://nak.example.com/callback',
    'code-abc',
    'verifier-xyz',
    'https://host/mcp',
    fetchFn,
  );
  assertEquals(tokens.access_token, 'at-123');
  assertEquals(tokens.refresh_token, 'rt-456');
  assertEquals(tokens.expires_in, 3600);
});

Deno.test('exchangeCode: throws on invalid_grant', async () => {
  const fetchFn = mockFetch([
    {
      status: 400,
      body: JSON.stringify({
        error: 'invalid_grant',
        error_description: 'code already used',
      }),
    },
  ]);
  await assertRejects(
    () => exchangeCode(
      'https://auth.host/token',
      'c',
      'r',
      'bad-code',
      'v',
      'res',
      fetchFn,
    ),
    VeniceError,
  );
});

// --- refreshToken (fetch-injected) ------------------------------------------

Deno.test('refreshToken: returns new tokens on success', async () => {
  const fetchFn = mockFetch([
    {
      status: 200,
      body: JSON.stringify({
        access_token: 'at-new',
        refresh_token: 'rt-rotated',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    },
  ]);
  const tokens = await refreshToken(
    'https://auth.host/token',
    'client-123',
    'rt-old',
    fetchFn,
  );
  assertEquals(tokens.access_token, 'at-new');
  assertEquals(tokens.refresh_token, 'rt-rotated');
});

Deno.test('refreshToken: throws invalid_grant on revoked grant', async () => {
  const fetchFn = mockFetch([
    {
      status: 400,
      body: JSON.stringify({
        error: 'invalid_grant',
        error_description: 'refresh token revoked',
      }),
    },
  ]);
  await assertRejects(
    () => refreshToken('https://auth.host/token', 'c', 'dead-rt', fetchFn),
    VeniceError,
  );
});
