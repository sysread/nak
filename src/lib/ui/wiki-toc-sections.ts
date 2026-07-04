/**
 * ToC assembly for the wiki article view (src/screens/Wiki.svelte):
 * the heading-outline tree, the visibility gates, and the anchor ids +
 * link list for the appended sections (Sources, See also, Records).
 * Pure - the Wiki.svelte ToC nav and the section elements both consume
 * the anchor constants so the `#anchor` links and the `id=` scroll
 * targets always agree.
 *
 * The ids are prefixed (`wiki-*`) rather than bare ("sources") so they
 * can't collide with a content-heading slug - the heading slugger emits
 * bare slugs, so an article with a literal "## Sources" heading would
 * otherwise produce two `id="sources"` nodes.
 */

import type { HeadingEntry } from '$lib/markdown';

// ---------------------------------------------------------------
// Heading outline
// ---------------------------------------------------------------

/** One node of the nested ToC outline - a heading plus the headings
 *  that sit under it in the document hierarchy. */
export interface TocNode extends HeadingEntry {
  children: TocNode[];
}

/**
 * Stack-based flat-to-tree fold. Each new heading hangs off the
 * nearest preceding heading with a strictly lower level; jumps in
 * the document outline (H1 -> H3 directly, no H2 between) attach
 * to whichever ancestor is closest rather than synthesising a
 * placeholder, which keeps the UI honest about the source.
 */
export function nestHeadings(items: HeadingEntry[]): TocNode[] {
  const root: TocNode = { level: 0, text: '', slug: '', children: [] };
  const stack: TocNode[] = [root];
  for (const h of items) {
    while (stack.length > 1 && stack[stack.length - 1].level >= h.level) {
      stack.pop();
    }
    const node: TocNode = { ...h, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}

/** Whether the heading outline renders at all: two or more headings.
 *  A one-item outline is more visual chrome than navigation. Also
 *  gates the divider between the outline and the section links. */
export function headingOutlineVisible(headingCount: number): boolean {
  return headingCount >= 2;
}

/**
 * Whether the ToC panel renders at all. The section links relax the
 * two-heading outline gate - a short article with records (or
 * sources / neighbors) still gets navigation to those sections even
 * though its heading outline alone wouldn't earn a ToC.
 */
export function tocVisible(
  headingCount: number,
  sectionLinkCount: number,
): boolean {
  return headingOutlineVisible(headingCount) || sectionLinkCount > 0;
}

/**
 * Strip inline markdown formatting characters from a heading's text
 * before slugging. Mirrors the cleaning step in `extractHeadings`
 * ($lib/markdown): the ToC computes slugs off the markdown source
 * while the post-render effect computes them off the DOM's
 * textContent, and the anchors only resolve when both clean the same
 * way - a heading that carried inline `*` / `_` / `` ` `` markers in
 * the source would otherwise slug differently on the two sides.
 */
export function cleanHeadingText(raw: string): string {
  return raw.replace(/[*_`~]/g, '').trim();
}

// ---------------------------------------------------------------
// Appended-section links
// ---------------------------------------------------------------

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
