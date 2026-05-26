#!/usr/bin/env node
// mise run config-set — set the project-global Venice API key in the
// app_config table on the linked Supabase project.
//
// The key is shared by every member of the project (the owner plus anyone
// they invite onto the same Supabase project), so this writes a single row
// that both the embeddings edge function and the browser read - rather than
// each user supplying their own key. See
// docs/dev/in-progress/venice-edge-functions/ for the broader plan.
//
// Project ref resolves from SUPABASE_PROJECT_REF or .nak/state.json, and the
// access token from SUPABASE_ACCESS_TOKEN or the supabase CLI login - the
// same path as `mise run sync` and `mise run user-edit`. The upsert runs
// through the Management API (service role), which is why app_config carries
// no RLS write policy.
//
// Args (optional; missing key is prompted):
//   --key <key>   skip the prompt; visible to `ps` and shell history, so
//                 prefer the interactive prompt or VENICE_API_KEY in the
//                 environment for anything you intend to keep.
import { banner, step, info, ok, warn, bail, ask, style } from './lib/ui.mjs';
import { supaAvailable, readAccessToken, runSql } from './lib/supabase.mjs';
import { loadState } from './lib/state-file.mjs';

function parseArgs() {
  let key = null;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    const next = process.argv[i + 1];
    if (arg === '--key' && next) {
      key = next;
      i++;
    } else if (arg === '-h' || arg === '--help') {
      console.log(
        'Usage: mise run config-set -- [--key <venice-api-key>]\n' +
          '\n' +
          'Sets the project-global Venice API key in the app_config table on\n' +
          'the linked Supabase project. Missing key is prompted; VENICE_API_KEY\n' +
          'in the environment is also honored.'
      );
      process.exit(0);
    } else {
      bail(`Unknown arg: ${arg}`, 'Usage: mise run config-set -- [--key <venice-api-key>]');
    }
  }
  return { argKey: key };
}

async function resolveProjectRef() {
  // Mirror sync.mjs: when SUPABASE_PROJECT_REF is set we trust it directly and
  // skip both the CLI binary check and the .nak/state.json lookup - the env
  // creds are an automation path that doesn't need the interactive login.
  const ciRef = process.env.SUPABASE_PROJECT_REF?.trim() || null;
  if (!ciRef && !(await supaAvailable())) {
    bail(
      'supabase CLI not found.',
      'Run `mise install`, or install from https://supabase.com/docs/guides/cli.'
    );
  }
  if (!(await readAccessToken())) {
    bail(
      'No Supabase access token.',
      'Run `mise run supabase-init` first, or export SUPABASE_ACCESS_TOKEN.'
    );
  }
  const ref = ciRef || (await loadState())?.supabase?.projectRef;
  if (!ref) {
    bail(
      'No linked Supabase project.',
      'Run `mise run supabase-init` first to create or link one.'
    );
  }
  return ref;
}

async function collectKey(argKey) {
  const envKey = process.env.VENICE_API_KEY?.trim() || null;
  let key = argKey ?? envKey;
  if (key) {
    warn(
      argKey
        ? 'Using --key from the command line; remember to clear your shell history.'
        : 'Using VENICE_API_KEY from the environment.'
    );
  } else {
    key = await ask('Venice API key', { secret: true });
  }
  key = key?.trim();
  if (!key) bail('A Venice API key is required.');
  // Reject control characters - a pasted key should never contain them, and
  // they would corrupt the SQL literal in writeConfig. Checked by code point
  // rather than a regex literal so this source file stays printable-ASCII.
  if ([...key].some((c) => c.charCodeAt(0) < 0x20)) {
    bail('The key contains control characters; re-copy it and retry.');
  }
  return key;
}

async function writeConfig(ref, key) {
  // Escape single quotes by doubling them, the correct escape for Postgres
  // standard-conforming strings (on by default since 9.1; backslashes are
  // literal, so no further escaping is needed). The Management API query
  // endpoint takes a raw SQL string with no parameter binding, so the
  // literal is built here.
  const escaped = key.replace(/'/g, "''");
  const sql = `
    insert into public.app_config (id, venice_api_key)
    values (true, '${escaped}')
    on conflict (id) do update
      set venice_api_key = excluded.venice_api_key,
          updated_at = now();
  `;
  try {
    await runSql(ref, sql);
  } catch (err) {
    bail(`Could not write app_config: ${err.message}`);
  }
}

const { argKey } = parseArgs();

banner('Nak — config-set');

const projectRef = await resolveProjectRef();
info(`Project: ${style.bold(projectRef)}`);

step(1, 'Collect the Venice API key');
const key = await collectKey(argKey);

step(2, 'Write app_config');
await writeConfig(projectRef, key);
ok('Venice API key stored in app_config.');
