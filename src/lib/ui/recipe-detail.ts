/**
 * UI-behavior primitives for the cookbook detail pane. Pure
 * functions only - no runes, no Svelte imports, no DOM. The
 * companion `src/screens/Cookbook.svelte` composes these into its
 * detail-header markup.
 *
 * The `Recipe` row shape comes from `$lib/supabase`; that is a
 * domain type, not a framework type, so it is fair game to share
 * with a port.
 */
import type { Recipe } from '../supabase';

/**
 * Tagged union for the recipe's "source" line under the title.
 * `Cookbook.svelte` dispatches on `kind`:
 *
 *   - `none` - neither a source name nor a URL; the line is omitted.
 *   - `text` - a source name with no URL; plain text, no anchor.
 *   - `link` - a URL is present; rendered as a single short anchor
 *     whose visible text is `label`, never the raw URL.
 */
export type RecipeSourceLine =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'link'; label: string; url: string };

/**
 * Collapse a recipe's `source` / `source_url` pair into the source
 * line's view model.
 *
 * The visible anchor text is the source NAME when there is one
 * (markdown `[NYT Cooking](url)` style) and the literal "Source"
 * otherwise. We never render `source_url` verbatim: a bare recipe
 * URL is long enough to span the whole app width on a narrow
 * viewport, pushing the layout out and forcing a horizontal
 * scroll. A short label keeps the line bounded.
 *
 * Whitespace-only `source` is treated as absent so a row carrying
 * an empty string does not produce a blank link label.
 */
export function recipeSourceLine(recipe: Recipe): RecipeSourceLine {
  const name = recipe.source?.trim() || '';
  const url = recipe.source_url?.trim() || '';
  if (url) return { kind: 'link', label: name || 'Source', url };
  if (name) return { kind: 'text', text: name };
  return { kind: 'none' };
}
