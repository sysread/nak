// Service-role bearer check for the cron-facing routes. The pg_cron jobs in
// supabase/schema.sql read the vault secret `service_role_key` and POST it to
// the function gateway as the Authorization bearer; every function that
// exposes a service-role-only route (the venice function's sweep routes and
// the standalone GC functions) decides admission here.
//
// Two bearer shapes are accepted, because the vault secret and the
// platform-injected SUPABASE_SERVICE_ROLE_KEY env value are not guaranteed to
// be the same format:
//
// - a service_role JWT - what the local dev stack's cron shim sends (its
//   gateway rejects the modern opaque key) and what a not-yet-migrated
//   project's vault still holds.
// - the modern `sb_secret_` service key, matched by string equality against
//   the injected env - the hosted project, whose gateway resolves the opaque
//   key server-side before the function code runs.
//
// A single check cannot cover both: equality against the env 403s whenever
// the vault secret and the env key differ in format (legacy JWT in the vault,
// modern key in the env - the half-migrated state), and a claim-only decode
// 403s the hosted project once its vault moves to the modern key. Both
// branches coexist so either key format works.
//
// SECURITY: the string match is safe because matching the env value proves
// possession of the service secret. The JWT branch trusts the decoded `role`
// claim only because the gateway's `verify_jwt` (on by default, per
// supabase/config.toml; no per-function override) has already validated the
// signature before the function code ran. Do NOT disable verify_jwt without
// replacing the JWT branch with signature verification - otherwise a forged
// `role: service_role` token would pass.
export function isServiceRole(req: Request): boolean {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const envKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (envKey !== undefined && envKey.length > 0 && token === envKey) return true;
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
