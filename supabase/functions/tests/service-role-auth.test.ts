// Offline unit tests for the cron-route service-role bearer check
// (../_shared/service-role-auth.ts). The check reads the
// SUPABASE_SERVICE_ROLE_KEY env var, so each case pins that variable (or
// deletes it) and restores whatever the surrounding environment had
// afterwards - no network, no running stack.
import { assertEquals } from '@std/assert';
import { isServiceRole } from '../_shared/service-role-auth.ts';

const ENV_KEY = 'SUPABASE_SERVICE_ROLE_KEY';

function b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// The check decodes the payload only; the signature segment is never read,
// so any non-empty string stands in for it.
function jwt(role: string): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ role })}.sig`;
}

function bearer(token: string): Request {
  return new Request('http://localhost/cron-route', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// Run fn with ENV_KEY forced to value (deleted when undefined), restoring
// the original environment afterwards so one case cannot contaminate the
// next (or the host shell's real value).
function withEnv(value: string | undefined, fn: () => void): void {
  const original = Deno.env.get(ENV_KEY);
  if (value === undefined) Deno.env.delete(ENV_KEY);
  else Deno.env.set(ENV_KEY, value);
  try {
    fn();
  } finally {
    if (original === undefined) Deno.env.delete(ENV_KEY);
    else Deno.env.set(ENV_KEY, original);
  }
}

Deno.test('accepts a service_role JWT while the env holds the modern key', () => {
  // The half-migrated state: the vault bearer is the legacy JWT, the
  // injected env holds the modern opaque key. An equality-only check
  // rejects exactly this combination, which is the failure that motivated
  // accepting both shapes.
  withEnv('sb_secret_env_key', () => {
    assertEquals(isServiceRole(bearer(jwt('service_role'))), true);
  });
});

Deno.test('accepts a service_role JWT with the env var absent', () => {
  withEnv(undefined, () => {
    assertEquals(isServiceRole(bearer(jwt('service_role'))), true);
  });
});

Deno.test('accepts a bearer equal to the injected env service key', () => {
  withEnv('sb_secret_env_key', () => {
    assertEquals(isServiceRole(bearer('sb_secret_env_key')), true);
  });
});

Deno.test('rejects a bearer that matches nothing', () => {
  withEnv('sb_secret_env_key', () => {
    assertEquals(isServiceRole(bearer('sb_secret_some_other_key')), false);
  });
  withEnv(undefined, () => {
    assertEquals(isServiceRole(bearer('sb_secret_some_other_key')), false);
  });
});

Deno.test('rejects a JWT whose role claim is not service_role', () => {
  withEnv(undefined, () => {
    assertEquals(isServiceRole(bearer(jwt('authenticated'))), false);
  });
});

Deno.test('rejects an empty or absent bearer', () => {
  withEnv('sb_secret_env_key', () => {
    assertEquals(isServiceRole(bearer('')), false);
    assertEquals(isServiceRole(new Request('http://localhost/cron-route')), false);
  });
});
