/**
 * Query-building helpers shared across the data layer's domain slices
 * (../supabase.ts and ./\<domain\>.ts): the topics-filter clause the
 * thread / memory / recipe list+search paths all ride, the two ILIKE
 * pattern builders whose quoting rules differ by PostgREST context,
 * and the base64 decoder the Storage upload paths share. Pure
 * functions; no client, no state.
 */
import { UNTAGGED_TOPIC_SENTINEL } from './types';

/**
 * Decode a base64 string to raw bytes for a Storage upload. Kept local
 * to the data layer (rather than importing from `attachments.ts`)
 * because that module imports types from here - the dependency must
 * not become a cycle.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Split a selectedTopics list into the two predicates the query
 * builder needs: real topics for the `&&` overlap test, plus a
 * boolean for "also include rows with no topics at all". Centralised
 * so the three list paths (recent / older / archived) and the search
 * path stay in lockstep on the sentinel.
 */
export function partitionSelectedTopics(selected: readonly string[]): {
  topics: string[];
  includeUntagged: boolean;
} {
  let includeUntagged = false;
  const topics: string[] = [];
  for (const t of selected) {
    if (t === UNTAGGED_TOPIC_SENTINEL) includeUntagged = true;
    else topics.push(t);
  }
  return { topics, includeUntagged };
}

/**
 * PostgREST `or(...)` clause matching the active topic filter. Returns
 * null when no filter is active (caller skips the predicate entirely),
 * or a string suitable for `.or()` otherwise. The two halves:
 *
 *   - "topics && {a,b}" — at least one of the selected real topics is
 *     in the row's array. PostgREST encodes array literals as
 *     {a,b,c}.
 *   - "topics.eq.{}" — the row has no topics at all (the
 *     "(untagged)" sentinel was selected).
 *
 * An OR of the two is the union the drawer's checkbox semantics
 * promise. When only one half is active we emit only that half, which
 * keeps the URL shorter and the query plan less branchy.
 *
 * `cs` (contains) vs `ov` (overlap): `ov` is the array-overlap
 * operator (`&&`) which is what we want for OR semantics across
 * multiple topics. `cs` would require ALL of the listed topics to be
 * present, which is AND semantics.
 */
export function topicsFilterClause(selected: readonly string[]): string | null {
  if (selected.length === 0) return null;
  const { topics, includeUntagged } = partitionSelectedTopics(selected);
  const parts: string[] = [];
  if (topics.length > 0) {
    // PostgREST array literal: {a,b,c}. Topic strings are alphanumeric
    // by the agent prompt (no commas, no braces) so no escaping is
    // needed; if a stray punctuation char ever sneaks in, PostgREST's
    // own quoting would reject the query before it reached the DB
    // rather than mis-parse it.
    parts.push(`topics.ov.{${topics.join(',')}}`);
  }
  if (includeUntagged) {
    // Empty-array equality: a row whose topics column is `'{}'`. This
    // is what "untagged" means in the UI.
    parts.push('topics.eq.{}');
  }
  // Single predicate doesn't need an or() wrapper at the caller, but
  // the .or() builder accepts a single comma-free clause too.
  return parts.join(',');
}

/**
 * Build a double-quoted ILIKE pattern for a user-supplied substring query
 * that rides INSIDE a `.or('col.ilike.<pattern>,...')` (or `.and(…)`) logic
 * tree. Do NOT use it for a standalone `.ilike(col, value)` filter - see
 * `ilikeFilterPattern` for why the quoting is wrong there.
 *
 * PostgREST's `.or(…)` grammar treats commas as condition separators and
 * parens as grouping. An unquoted comma in the value (e.g. a chatty
 * recall query like "...simmering liquid, so they'll...") splits the
 * value into a second, malformed condition and the whole request fails
 * with "failed to parse logic tree". Backslash-escaping those chars does
 * NOT work - the parser does not honour the backslash, so the comma
 * still terminates the value - the only correct carrier is to wrap the
 * whole value in double quotes. Inside a quoted value a literal
 * double-quote or backslash must itself be backslash-escaped.
 *
 * The surrounding `%` are intentional substring wildcards and live
 * inside the quotes; ILIKE sees them after PostgREST strips the quotes
 * (quote-stripping only happens inside a logic tree). A `%` or `_` typed
 * by the user stays a wildcard, matching the prior behaviour.
 */
export function ilikeLogicTreePattern(query: string): string {
  const escaped = query.replace(/(["\\])/g, '\\$1');
  return `"%${escaped}%"`;
}

/**
 * Build an ILIKE substring pattern for a STANDALONE `.ilike(col, value)`
 * filter. Plain `%query%`, no quoting, no escaping.
 *
 * supabase-js sends the value as its own URL-encoded query parameter, read
 * verbatim to the end of that parameter, so the comma/paren reserved-char
 * problem that forces quoting in a `.or(…)` logic tree simply does not
 * exist here. Crucially, PostgREST strips surrounding double quotes ONLY
 * inside a logic tree, not in a standalone horizontal filter - so reusing
 * the quoted `ilikeLogicTreePattern` here makes ILIKE hunt for literal
 * double-quote characters in the title, and a query like "Joy" stops
 * matching a recipe titled "Joy's Favorite Bread" (returns an empty list).
 * The `%`/`_` the user types stay wildcards by design.
 */
export function ilikeFilterPattern(query: string): string {
  return `%${query}%`;
}
