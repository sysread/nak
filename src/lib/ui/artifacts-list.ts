/**
 * UI-behavior primitives for the Artifacts drawer tab: the filter/sort
 * option lists, the status/empty labels, and the kind predicate. Pure
 * functions and constant tables - the decision logic the .svelte file would
 * otherwise inline in template cascades lives here so a framework port
 * wouldn't have to rewrite it.
 */
import type { ArtifactKind, ArtifactSort } from '../artifacts-store.svelte';
import { isImageMimeType } from '../attachments';

/**
 * Debounce window between the last filename keystroke and the reload. Same
 * 200ms the other drawer listings use, so typing-burst latency feels uniform.
 */
export const ARTIFACTS_SEARCH_DEBOUNCE_MS = 200;

/** Segmented kind filter, in display order. */
export const ARTIFACT_KIND_OPTIONS: ReadonlyArray<{ value: ArtifactKind; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'image', label: 'Images' },
  { value: 'file', label: 'Files' },
];

/** Sort options, in display order. */
export const ARTIFACT_SORT_OPTIONS: ReadonlyArray<{ value: ArtifactSort; label: string }> = [
  { value: 'newest', label: 'Newest' },
  { value: 'largest', label: 'Largest' },
];

/** Scanner label while a load is in flight - framing differs by active filter. */
export function artifactsScannerLabel(query: string): string {
  return query.trim().length > 0 ? 'Searching files' : 'Loading files';
}

/**
 * Empty-listing message. An active filter (filename query or a non-"all"
 * kind) with no hits reads differently from a genuinely empty store.
 */
export function artifactsEmptyMessage(query: string, kind: ArtifactKind): string {
  if (query.trim().length > 0 || kind !== 'all') return 'No files match this filter.';
  return 'No files yet. Attachments you add to conversations show up here.';
}

/** True when a row should render an image thumbnail (vs a file glyph). */
export function isImageArtifact(row: { mime_type: string }): boolean {
  return isImageMimeType(row.mime_type);
}
