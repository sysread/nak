/**
 * Natural-key dedup heuristics for upsert-style tools - Deno-island
 * copy of the browser-side src/lib/tools/upsert.ts resolveNaturalKeyMatch.
 * Deliberately duplicated, not imported: the edge function cannot load
 * browser modules (see supabase/functions/README.md). Keep in sync
 * with the browser original.
 *
 * The client surface is typed loosely (the raw postgrest chain is
 * thenable in awkward ways for structural typing); call sites cast
 * their SupabaseClient through unknown, matching the convention the
 * other tool files use for service-role queries.
 */

/**
 * Natural-key dedup heuristic for upsert tools whose resource has a
 * unique constraint the model might collide with when it forgets the
 * `id` (wiki title is the canonical case). Run BEFORE doCreate:
 *
 * - Exact match (case-insensitive) on the natural key: returns the
 *   existing row's id, signalling "treat this call as an update".
 *   The model's create-intent lands as an update of the row it
 *   demonstrably meant - no silent duplicate, no 23505 bounce.
 * - Fuzzy near-match (containment in either direction,
 *   case-insensitive): throws an agent-readable refusal naming the
 *   candidates, so the model can pass the id explicitly or rename.
 *   Creating "Maya Smith" when "Maya" exists should neither silently
 *   merge nor silently duplicate.
 * - No match: returns null, proceed with the create.
 *
 * `query` runs the single lookup: select the key column for the
 * user's rows, case-insensitively matching the probe value. Splitting
 * the query out keeps this module free of table knowledge - the
 * caller owns the table/column identity and the cast.
 */
export async function resolveNaturalKeyMatch(opts: {
  query: (
    pattern: string,
  ) => Promise<{ data: { id: string; key: string }[] | null }>;
  keyValue: string;
  fuzzy: boolean;
}): Promise<{ id: string; key: string } | null> {
  const { data } = await opts.query(opts.keyValue);
  if (!data || data.length === 0) return null;

  const probe = opts.keyValue.toLowerCase();
  const exact = data.find(
    (r) => typeof r.key === 'string' && r.key.toLowerCase() === probe,
  );
  if (exact) return { id: exact.id, key: exact.key };

  if (!opts.fuzzy) return null;

  const near = data.filter(
    (r) =>
      typeof r.key === 'string' &&
      (r.key.toLowerCase().includes(probe) || probe.includes(r.key.toLowerCase())),
  );
  if (near.length === 0) return null;
  const list = near.map((r) => `"${r.key}" (id ${r.id})`).join('; ');
  throw new Error(
    `a similar row already exists: ${list}. ` +
      'Pass its id to update it, or use a clearly different name to create new.',
  );
}
