/**
 * Pure UI-behavior primitives for the offline surfaces - message
 * selection and label transforms the offline indicator and the detail
 * views need. No reactive state, no IndexedDB; that lives in
 * `offline-sync.svelte.ts`. Kept here so the wording decisions are
 * unit-testable and a port to another framework would reuse them
 * verbatim.
 */

/**
 * Message for a detail pane whose record resolved to null. Three
 * mutually-exclusive cases, in priority order:
 *   - still resolving -> a loading line;
 *   - offline and not cached -> the record was never saved for offline
 *     use, so reconnecting is the only way in;
 *   - online and still missing -> it genuinely isn't there (deleted, or
 *     an id that never existed).
 * `noun` is the record kind ("article" / "recipe") so the same logic
 * serves both panes.
 */
export function missingRecordMessage(args: {
  fetching: boolean;
  online: boolean;
  noun: string;
}): string {
  if (args.fetching) return `Loading ${args.noun}…`;
  if (!args.online) {
    return `This ${args.noun} isn't saved for offline use. Reconnect to open it.`;
  }
  return `That ${args.noun} couldn't be found. It may have been deleted.`;
}

/**
 * Banner copy for the offline indicator. Returns null when online (the
 * banner doesn't render). When offline, names how much is reachable so
 * the user knows what they can still open rather than just "you're
 * offline". A zero-count device gets the explainer instead.
 */
export function offlineBannerText(args: {
  online: boolean;
  articleCount: number;
  recipeCount: number;
}): string | null {
  if (args.online) return null;
  if (args.articleCount + args.recipeCount === 0) {
    return "You're offline. Favorite an article or recipe to keep it available here.";
  }
  return `You're offline. ${countNoun(args.articleCount, 'article', 'articles')} and ${countNoun(args.recipeCount, 'recipe', 'recipes')} saved for offline use.`;
}

/** "1 article" / "3 articles" - a count with the correctly-pluralized noun. */
export function countNoun(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
