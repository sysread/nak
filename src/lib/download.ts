/**
 * Browser download helpers shared by the export features (wiki export,
 * conversation transcript export). DOM-touching and browser-only - the
 * pure content builders live beside their features (wiki-export.ts,
 * ui/transcript-export.ts) and stay testable without a DOM.
 */

/** Trigger a browser download of a text blob. Browser-only. */
export function downloadText(
  filename: string,
  text: string,
  mime = 'text/markdown',
): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
