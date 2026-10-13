/**
 * Recipe-records export: a single record or a whole recipe + its
 * cooking log, as Markdown. Mirrors src/lib/wiki-export.ts (the
 * article-typed twin): pure Markdown builders here are unit-testable;
 * the download + zip wrappers touch the DOM and fflate and run
 * browser-only.
 *
 * DIVERGENCE from the twin, deliberate: the Records section's Export
 * all fetches an UNFILTERED log at export time (the full diary),
 * while the wiki twin exports whatever `load()` already filtered by
 * date/tag. The section routes the fetch; this module just packs what
 * it is handed.
 */
import { zipSync, strToU8 } from 'fflate';
import { downloadText } from './download';
import { parseCooklang, recipeToMarkdown } from './cooklang';
import type { Recipe, RecipeRecord } from './supabase';
import { recordExportFilename } from './ui/recipe-records';

/**
 * One record as a standalone Markdown document: a small YAML-ish
 * front-matter block (date, tags, outcome) followed by the record's
 * Markdown body, emitted verbatim - it is already Markdown. Tags and
 * outcome lines are omitted when unset so an unclassified,
 * untagged record's front matter is just the date.
 */
export function buildRecipeRecordMarkdown(record: RecipeRecord): string {
  const lines: string[] = ['---', `date: ${record.date}`];
  if (record.tags.length > 0) {
    lines.push(`tags: [${record.tags.join(', ')}]`);
  }
  if (record.outcome) {
    lines.push(`outcome: ${record.outcome}`);
  }
  lines.push('---', '', record.content.trimEnd(), '');
  return lines.join('\n');
}

/** Download one record as `yyyy-mm-dd-<slug>.md`. */
export function downloadRecipeRecordMarkdown(record: RecipeRecord): void {
  downloadText(recordExportFilename(record), buildRecipeRecordMarkdown(record));
}

/**
 * Slugify a recipe title for the ZIP filename. Mirrors the wiki twin's
 * articleSlug rules (lowercase, alphanumerics + hyphens) but operates
 * on the recipe title.
 */
export function recipeSlug(recipe: Pick<Recipe, 'id' | 'title'>): string {
  const base = recipe.title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base || recipe.id.slice(0, 8);
}

/**
 * The recipe itself as Markdown for the ZIP's `recipe.md` entry -
 * title, source line, metadata, ingredients, instructions via the
 * shared renderer (same output as the detail pane's Copy-as-Markdown).
 */
export function buildRecipeMarkdown(recipe: Recipe): string {
  const parsed = parseCooklang(recipe.cooklang);
  return recipeToMarkdown(recipe.title, parsed, {
    source: recipe.source,
    sourceUrl: recipe.source_url,
  });
}

/**
 * Build the in-memory ZIP for a recipe + its cooking log:
 *   recipe.md
 *   records/yyyy-mm-dd-<slug>.md   (one per record)
 *
 * Pure (returns the zipped bytes); the download wrapper below triggers
 * the browser save. Duplicate record filenames (two records that slug
 * identically on the same date) get a numeric suffix starting at -2 so
 * none are silently dropped from the archive.
 */
export function buildRecipeRecordZip(
  recipe: Recipe,
  records: readonly RecipeRecord[]
): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'recipe.md': strToU8(buildRecipeMarkdown(recipe)),
  };
  const used = new Set<string>(['recipe.md']);
  for (const record of records) {
    let name = `records/${recordExportFilename(record)}`;
    if (used.has(name)) {
      // Disambiguate collisions with a numeric suffix before the
      // extension so every record lands in the archive.
      const stem = name.replace(/\.md$/, '');
      let i = 2;
      while (used.has(`${stem}-${i}.md`)) i += 1;
      name = `${stem}-${i}.md`;
    }
    used.add(name);
    files[name] = strToU8(buildRecipeRecordMarkdown(record));
  }
  return zipSync(files);
}

/** Download a recipe + its records as a ZIP. Browser-only. */
export function downloadRecipeRecordZip(
  recipe: Recipe,
  records: readonly RecipeRecord[]
): void {
  const bytes = buildRecipeRecordZip(recipe, records);
  // Slice into a fresh ArrayBuffer-backed view so the Blob constructor
  // gets a plain Uint8Array regardless of fflate's internal buffer.
  const blob = new Blob([bytes.slice()], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${recipeSlug(recipe)}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
