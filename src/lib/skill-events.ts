/**
 * Window-level event bus for cross-surface notification of skill
 * writes. Mirrors `memory-events.ts`. Emitters: the Skills panel's
 * direct edits (save / create / delete) and the realtime relay in
 * Chat.svelte (SupabaseService.subscribeToSkillChanges ->
 * emitSkillChange), which is how the server-side skills chat tool -
 * running in the venice edge function - reaches an open panel.
 *
 * Payload-free by design: the relay event is coarse ("something in
 * the skills table changed"), so consumers re-fetch what they need
 * (the sidebar's listing, the panel's open skill) rather than
 * trusting a payload that would have to stay in lockstep with the
 * table shape. The panel additionally classifies DELETE vs UPDATE
 * by refetching the open skill (see Skills.svelte).
 *
 * Consumers: the Skills panel, which on each event refreshes the
 * listing and reclassifies the open skill (a refetch distinguishes
 * DELETE from UPDATE; see Skills.svelte).
 */
const SKILL_CHANGE_EVENT = 'nak:skill-change';

export function emitSkillChange(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SKILL_CHANGE_EVENT));
}

export function onSkillChange(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (): void => handler();
  window.addEventListener(SKILL_CHANGE_EVENT, listener);
  return () => window.removeEventListener(SKILL_CHANGE_EVENT, listener);
}
