/**
 * Recipe length limits. Lifted out of `cooklang.ts` so the always-on
 * `recipe_save` / `recipe_update` tool schemas can reach them without
 * pulling the 14 kB Cooklang parser into the main chunk - the parser
 * is needed only on the Cookbook screen (lazy) and at recipe-save
 * time (also reached via lazy tool impls).
 *
 * Caps mirror what callers enforced before the extraction:
 *   - source length is a pragmatic ceiling that keeps the
 *     recipe_list tool's response under context budget even with a
 *     few dozen recipes. A typical recipe is 1-3 KiB of Cooklang;
 *     20 KiB is headroom for a long multi-stage bread recipe with
 *     extensive prose. Larger than that probably means the LLM
 *     dumped prose into `cooklang` instead of parsing it to
 *     Cooklang - rejecting is better than silently storing HTML.
 *   - title cap mirrors the memory label cap.
 */
export const MAX_RECIPE_COOKLANG_CHARS = 20_000;
export const MAX_RECIPE_TITLE_CHARS = 160;
