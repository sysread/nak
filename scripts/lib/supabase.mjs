// Wrappers for the Supabase CLI and Management API.
//
// Why both? The CLI covers login/project-create/db-push cleanly. But the CLI
// does not expose the auth URL allowlist (Site URL / Redirect URLs), so we
// talk to the Management API directly with the access token the CLI stores.
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCapture, runInherit, which } from './shell.mjs';

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
 * Run arbitrary SQL against a linked project via the CLI. Requires that
 * `supabase link --project-ref <ref>` has been run (or that the repo has
 * a `supabase/config.toml` + linked state).
 */
export async function applySchemaViaCli(sqlPath) {
  const res = await runCapture('supabase', ['db', 'execute', '--file', sqlPath]);
  if (res.code !== 0) {
    // Older CLI versions use `db remote` or `db push`. Fall back.
    return runCapture('supabase', ['db', 'push', '--include-seed', 'false']);
  }
  return res;
}

/**
 * Run SQL against a project via the Management API `query` endpoint. This
 * avoids needing a `supabase link`, which helps idempotency across machines.
 */
export async function runSql(ref, sql) {
  return mgmt('POST', `/v1/projects/${ref}/database/query`, { query: sql });
}
