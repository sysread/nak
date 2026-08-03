/**
 * Click-to-collapse guard for expanded message-card panels - the
 * reasoning block quote (ReasoningPanel.svelte) and the tool-call
 * detail (ToolCalls.svelte). A long expanded panel pushes its header
 * toggle far off-screen, so the panel body itself accepts a click to
 * collapse; this module decides which clicks count.
 *
 * Pure DOM predicate - no Svelte imports, no component state. Unit
 * tests at tests/collapse-click.test.ts.
 */

/**
 * Whether a click that landed inside an expanded panel body should
 * collapse the panel. Two exclusions:
 *
 * - Interactive descendants keep their own behavior. A link in a
 *   markdown-rendered tool result should navigate and the view-mode
 *   toggle should flip views without the panel snapping shut under
 *   the action. Matched via closest() so a click on a span INSIDE a
 *   link is excluded too, not just the link element itself.
 * - Finishing a drag-selection fires a click on mouseup when the
 *   press and release share an ancestor; collapsing then would
 *   destroy the text the user just selected to copy. Any
 *   non-collapsed selection means "leave the panel alone".
 */
export function clickShouldCollapse(
  target: EventTarget | null,
  selection: Pick<Selection, 'isCollapsed'> | null
): boolean {
  if (selection && !selection.isCollapsed) return false;
  if (
    target instanceof Element &&
    target.closest('a, button, input, textarea, select') !== null
  ) {
    return false;
  }
  return true;
}
