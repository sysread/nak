/**
 * Browser entry point for Cooklang. The parser itself lives in
 * supabase/functions/_shared/cooklang-parse.ts (shared with the
 * recipe_save edge tool, which parses submissions to validate them);
 * this module re-exports it alongside the renderers and the authoring
 * validator so the frontend keeps one import surface.
 */

export { parseCooklang } from '$shared/cooklang-parse';
export type { Ingredient, Cookware, Timer, Step, Recipe } from '$shared/cooklang-parse';

// ---------------------------------------------------------------------------
// Renderer re-exports
// ---------------------------------------------------------------------------
// The HTML, plain-text, markdown, and TOC renderers live in
// `./cooklang-render`. They are re-exported here so existing consumers
// that import from `$lib/cooklang` don't break. New consumers can
// import from either module - the parser types (Recipe, Step, etc.)
// stay here, the renderers and their option types live there.

export { recipeToHtml, cooklangToHtml, recipeToc, recipeToPlainText, recipeToMarkdown, groceryCheckboxAriaLabel, ingredientRowsForRecipe } from './cooklang-render';
export type { RecipeHtmlOptions, RecipeTocSection, RecipeTocEntry } from './cooklang-render';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

// MAX_RECIPE_COOKLANG_CHARS and MAX_RECIPE_TITLE_CHARS used to live
// here. They moved to `./recipe-limits` so the always-on recipe-save
// tool schemas can reach them without dragging the parser into
// the main chunk. Cookbook.svelte and the recipe tools now import
// directly from `./recipe-limits`.

// ---------------------------------------------------------------------------
// Authoring validation
// ---------------------------------------------------------------------------

// Authoring-mistake checks the recipe_save tool runs before writing. The
// check list and its rationale live with the code in
// supabase/functions/_shared/cooklang-validate.ts.
export { validateCooklangSource } from '$shared/cooklang-validate';
