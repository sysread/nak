/**
 * Guardrail: every content-addressed Storage bucket in
 * `supabase/schema.sql` must carry all FOUR `storage.objects` RLS
 * policies (select / insert / update / delete), each enforcing the
 * self-prefix predicate.
 *
 * Content-addressed keys (`<user_id>/<sha256>`) map the same bytes to
 * the same object forever, and the client uploads with
 * `upsert: true` - so every re-upload of already-stored bytes takes
 * the UPDATE path. The upload sites that set this up:
 * `uploadRecipeImageObject` in src/lib/supabase/cookbook.ts and
 * `uploadGroceryItemImageObject` in src/lib/supabase/grocery.ts. A
 * bucket missing the update policy turns that re-upload into an RLS
 * refusal that leaks the raw Postgres string ("new row violates
 * row-level security policy") into the UI. The recipe-images bucket
 * shipped that way (its migration mirrored the attachments
 * migration's three-policy shape without accounting for the shared
 * object key) and the defect was live in production until fixed;
 * this test exists so the whole defect class fails the gate instead
 * of waiting for a user to re-pick a photo.
 *
 * Row-id-keyed buckets (`documents`, `attachments`,
 * `wiki-record-files`) are deliberately NOT held to the four-op
 * standard: a re-upload there gets a distinct key, so their uploads
 * never take the UPDATE path.
 *
 * Like tests/schema-grants.test.ts, this is a conservative scanner,
 * not a SQL parser; floor and canary assertions keep a refactor that
 * blinds the scanner failing loudly instead of passing vacuously.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const SCHEMA = readFileSync(join(ROOT, 'supabase', 'schema.sql'), 'utf8');

/** Strip -- line comments and /* block comments *\/ so scanner text is SQL only. */
function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** Buckets whose object keys are `<user_id>/<sha256>` - re-uploads hit the UPDATE path. */
const CONTENT_ADDRESSED_BUCKETS = ['recipe-images', 'grocery-item-images'];

const REQUIRED_OPS = ['select', 'insert', 'update', 'delete'] as const;

const SELF_PREFIX = "and (storage.foldername(name))[1] = auth.uid()::text";

describe('schema storage policy guardrail', () => {
  const sql = stripComments(SCHEMA);

  // One entry per `create policy ... on storage.objects` statement.
  const policies = [...sql.matchAll(/create\s+policy\s+"([^"]+)"\s+on\s+storage\.objects\s+([\s\S]*?);/gi)].map(
    (m) => ({
      name: m[1],
      body: m[2].replace(/\s+/g, ' ').toLowerCase(),
      idx: m.index!,
    })
  );

  const opOf = (body: string): string | null => {
    const m = body.match(/for\s+(select|insert|update|delete)\s+to\s+\w+/);
    return m ? m[1] : null;
  };

  it('scanner actually sees the storage policies (parses non-vacuously)', () => {
    // Five buckets x the original three policies + two update policies.
    // Raise the floor as buckets are added; a scanner that matches
    // only some subset fails loudly here instead of passing vacuously.
    expect(policies.length).toBeGreaterThanOrEqual(17);
    const names = policies.map((p) => p.name);
    expect(names.some((n) => n.includes('recipe-images')), 'scanner lost the recipe-images policies').toBe(true);
    expect(names.some((n) => n.includes('documents')), 'scanner lost the documents policies').toBe(true);
  });

  for (const bucket of CONTENT_ADDRESSED_BUCKETS) {
    it(`${bucket} carries select/insert/update/delete, each with the self-prefix predicate`, () => {
      const bucketPolicies = policies.filter((p) => p.body.includes(`bucket_id = '${bucket}'`));
      const found = new Map(bucketPolicies.map((p) => [opOf(p.body), p]));

      const missing = REQUIRED_OPS.filter((op) => !found.has(op));
      expect(
        missing,
        `the ${bucket} bucket is missing storage.objects policies for: ${missing.join(', ')}. ` +
          'Its keys are content-addressed (<user_id>/<sha256>) and the client uploads with ' +
          "upsert: true, so re-uploading stored bytes takes the UPDATE path - without the " +
          'update policy that re-upload RLS-fails and leaks the raw Postgres error to the UI. ' +
          'Mirror "recipe-images bucket is self-updatable" for this bucket.',
      ).toEqual([]);

      const prefixless = [...found.values()].filter((p) => !p.body.includes(SELF_PREFIX));
      expect(
        prefixless.map((p) => p.name),
        'storage policies dropped the self-prefix predicate - every object key must start ' +
          'with the caller\'s own <user_id> folder or the bucket is readable/writable across ' +
          'users. Restore `(storage.foldername(name))[1] = auth.uid()::text`.',
      ).toEqual([]);
    });
  }
});
