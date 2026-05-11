// Wrappers for the Supabase CLI and Management API.
//
// Why both? The CLI covers login/project-create/db-push cleanly. But the CLI
// does not expose the auth URL allowlist (Site URL / Redirect URLs), so we
// talk to the Management API directly with the access token the CLI stores.
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInherit, which } from './shell.mjs';

const MGMT_BASE = 'https://api.supabase.com';

export async function supaAvailable() {
  return (await which('supabase')) !== null;
}

/**
 * Returns the path where the Supabase CLI stores its access token. The CLI
 * writes this after `supabase login`.
 */
function accessTokenPath() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return null; // env overrides
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.supabase');
  return join(base, 'access-token');
}

export async function readAccessToken() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  const p = accessTokenPath();
  if (!p) return null;
  try {
    const raw = (await readFile(p, 'utf8')).trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export async function supaLoginInteractive() {
  await runInherit('supabase', ['login']);
}

async function mgmt(method, path, body = null) {
  const token = await readAccessToken();
  if (!token) throw new Error('No Supabase access token. Run `supabase login` first.');
  const res = await fetch(`${MGMT_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    // non-JSON
  }
  if (!res.ok) {
    const err = new Error(
      `Supabase Management API ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`
    );
    err.status = res.status;
    err.body = json ?? text;
    throw err;
  }
  return json;
}

export async function listOrgs() {
  return mgmt('GET', '/v1/organizations');
}

export async function listProjects() {
  return mgmt('GET', '/v1/projects');
}

export async function createProject({ name, orgId, region, dbPassword }) {
  return mgmt('POST', '/v1/projects', {
    name,
    organization_id: orgId,
    region,
    db_pass: dbPassword,
    plan: 'free',
  });
}

export async function getProjectApiKeys(ref) {
  return mgmt('GET', `/v1/projects/${ref}/api-keys`);
}

export async function getAuthConfig(ref) {
  return mgmt('GET', `/v1/projects/${ref}/config/auth`);
}

export async function updateAuthConfig(ref, patch) {
  return mgmt('PATCH', `/v1/projects/${ref}/config/auth`, patch);
}

/**
 * Wait for a freshly-created project to finish provisioning. Polls until
 * its status is ACTIVE_HEALTHY or a timeout is hit.
 */
export async function waitForProject(ref, { timeoutMs = 180_000, intervalMs = 5000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const projects = await listProjects();
    const p = projects.find((x) => x.id === ref);
    if (p && (p.status === 'ACTIVE_HEALTHY' || p.status === 'ACTIVE')) return p;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for project ${ref} to become healthy.`);
}

/**
 * Run SQL against a project via the Management API `query` endpoint. This
 * avoids needing a `supabase link`, which helps idempotency across machines.
 */
export async function runSql(ref, sql) {
  return mgmt('POST', `/v1/projects/${ref}/database/query`, { query: sql });
}

// ---------------------------------------------------------------------------
// Admin user helpers — these hit the project's own GoTrue endpoint, not the
// Management API, and require the project's service_role key. That key is
// extremely sensitive; callers must keep it in memory only for the duration
// of the wizard and never persist it.
// ---------------------------------------------------------------------------

async function gotrueAdmin(method, supabaseUrl, serviceRoleKey, path, body = null) {
  const res = await fetch(`${supabaseUrl}/auth/v1/admin${path}`, {
    method,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    // non-JSON body
  }
  if (!res.ok) {
    const err = new Error(
      `GoTrue admin ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`
    );
    err.status = res.status;
    err.body = json ?? text;
    throw err;
  }
  return json;
}

/**
 * Create a user with `email_confirm: true` so they can sign in immediately
 * without an email round-trip. Throws with `err.status === 422` if a user
 * with this email already exists — callers typically catch that to prompt
 * for a password reset instead.
 */
export async function adminCreateUser(supabaseUrl, serviceRoleKey, { email, password }) {
  return gotrueAdmin('POST', supabaseUrl, serviceRoleKey, '/users', {
    email,
    password,
    email_confirm: true,
  });
}

/**
 * List users. Used to find an existing user's id when we hit 422 on create.
 */
export async function adminListUsers(supabaseUrl, serviceRoleKey) {
  const res = await gotrueAdmin('GET', supabaseUrl, serviceRoleKey, '/users');
  // GoTrue returns either { users: [...] } or a bare array depending on version.
  if (Array.isArray(res)) return res;
  return res?.users ?? [];
}

/**
 * Reset a user's password by id. Used when the email already exists and the
 * user wants to re-seed credentials.
 */
export async function adminUpdateUserPassword(supabaseUrl, serviceRoleKey, userId, password) {
  return gotrueAdmin('PUT', supabaseUrl, serviceRoleKey, `/users/${userId}`, {
    password,
    email_confirm: true,
  });
}
