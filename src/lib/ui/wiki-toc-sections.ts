/**
 * Anchor ids and ToC-link assembly for the appended sections of a wiki
 * article view (Sources, See also, Records). Pure - the Wiki.svelte ToC
 * nav and the section elements both consume these constants so the
 * `#anchor` links and the `id=` scroll targets always agree.
 *
 * The ids are prefixed (`wiki-*`) rather than bare ("sources") so they
 * can't collide with a content-heading slug - the heading slugger emits
 * bare slugs, so an article with a literal "## Sources" heading would
 * otherwise produce two `id="sources"` nodes.
 */

export const WIKI_SOURCES_ANCHOR = 'wiki-sources';
export const WIKI_SEE_ALSO_ANCHOR = 'wiki-see-also';
export const WIKI_RECORDS_ANCHOR = 'wiki-records';

export interface TocSectionLink {
  readonly id: string;
  readonly label: string;
}

/**
 * Build the ordered list of section links shown at the bottom of the
 * article ToC, one per appended section that is actually present. Order
 * matches the document order of the sections themselves (Sources, then
 * See also, then Records). A section absent from the article contributes
 * no link, so a stub article with none of them yields an empty list and
 * the caller can suppress the whole group.
 */
export function buildSectionTocLinks(opts: {
  hasSources: boolean;
  hasSeeAlso: boolean;
  recordCount: number;
}): TocSectionLink[] {
  const links: TocSectionLink[] = [];
  if (opts.hasSources) links.push({ id: WIKI_SOURCES_ANCHOR, label: 'Sources' });
  if (opts.hasSeeAlso) links.push({ id: WIKI_SEE_ALSO_ANCHOR, label: 'See also' });
  // Records link appears once there is at least one record to jump to -
  // the section always renders (it carries the Add button even when
  // empty), but a ToC link to an empty list is noise.
  if (opts.recordCount > 0) links.push({ id: WIKI_RECORDS_ANCHOR, label: 'Records' });
  return links;
}
