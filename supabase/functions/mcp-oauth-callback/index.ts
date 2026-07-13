// Public OAuth callback shim for hosted MCP integrations. Supabase's
// `venice` function keeps verify_jwt on and cannot receive Fastmail's
// browser redirect directly, so this tiny public function accepts the
// provider callback, validates the app return URL, and forwards the
// query payload back to the PWA where the existing sessionStorage
// state + PKCE exchange flow completes.

const ALLOWED_HTTPS_RETURNS = [
  { host: 'sysread.github.io', pathPrefix: '/nak/' },
] as const;

const DEFAULT_RETURN_URL = 'https://sysread.github.io/nak/';

function isLoopbackReturn(url: URL): boolean {
  return url.protocol === 'http:' && (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]'
  );
}

function isAllowedReturnUrl(raw: string | null): URL | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (isLoopbackReturn(url)) return url;
  if (url.protocol !== 'https:') return null;
  for (const allowed of ALLOWED_HTTPS_RETURNS) {
    if (url.hostname === allowed.host && url.pathname.startsWith(allowed.pathPrefix)) {
      return url;
    }
  }
  return null;
}

Deno.serve((req) => {
  if (req.method !== 'GET') {
    return new Response('method not allowed', { status: 405 });
  }

  const incoming = new URL(req.url);
  const returnUrl = isAllowedReturnUrl(
    incoming.searchParams.get('return_url') ?? DEFAULT_RETURN_URL,
  );
  if (!returnUrl) {
    return new Response('invalid return_url', { status: 400 });
  }

  for (const key of ['code', 'state', 'error', 'error_description', 'iss']) {
    const value = incoming.searchParams.get(key);
    if (value) returnUrl.searchParams.set(key, value);
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: returnUrl.toString(),
      'Cache-Control': 'no-store',
    },
  });
});
