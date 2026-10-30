/**
 * Double-quoted ILIKE pattern for a value riding INSIDE a PostgREST
 * `.or(...)` (or `.and(...)`) logic tree. Deno-island copy of
 * ilikeLogicTreePattern in src/lib/supabase/query-utils.ts.
 * Deliberately duplicated, not imported: the edge function cannot
 * load browser modules (see supabase/functions/README.md). Keep in
 * sync with the browser original, which is canonical.
 *
 * PostgREST's `.or(...)` grammar treats commas as condition
 * separators and parens as grouping. An unquoted comma in the value
 * (a chatty search query like "release notes, monthly") splits the
 * value into a second, malformed condition and the whole request
 * fails with "failed to parse logic tree". Backslash-escaping does
 * NOT work - the parser does not honour the backslash, so the comma
 * still terminates the value - the only correct carrier is wrapping
 * the whole value in double quotes. Inside a quoted value a literal
 * double-quote or backslash must itself be backslash-escaped.
 *
 * The surrounding `%` are intentional substring wildcards and live
 * inside the quotes; ILIKE sees them after PostgREST strips the
 * quotes (quote-stripping only happens inside a logic tree). A `%`
 * or `_` typed by the caller stays a wildcard, matching the browser
 * side's behaviour.
 *
 * Do NOT use this builder for a standalone `.ilike(col, value)`
 * filter. PostgREST does not strip quotes there, so the pattern
 * would hunt for literal double-quote characters in the column and
 * innocent queries stop matching (the recipe_record_search preamble
 * documents that exact bug class).
 */

export function ilikeLogicTreePattern(query: string): string {
  const escaped = query.replace(/(["\\])/g, '\\$1');
  return `"%${escaped}%"`;
}
