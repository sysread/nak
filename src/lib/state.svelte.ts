/**
 * App-state facade. The single reactive `app` object and everything
 * that reads or writes it used to live here; it grew enough reasons-to-
 * change (root state, in-memory setters, persistence, server-blob
 * hydration, lifecycle transitions, service construction) that it split
 * into `./app-state/`:
 *
 *   - `app-state/root.svelte.ts`     - the `$state` root + its shape +
 *                                      the phase-state-machine docs.
 *   - `app-state/settings.ts`        - in-memory setters, the
 *                                      persist-with-rollback wrappers,
 *                                      and `applyServerSettings`.
 *   - `app-state/lifecycle.ts`       - activate / sign-out / setup
 *                                      transitions + service construction.
 *
 * This module stays as the import surface (`$lib/state.svelte`) so the
 * ~28 consumers keep one place to reach for. Add re-exports here when a
 * new symbol in those modules needs to be public.
 */
export type { AppPhase } from './app-state/root.svelte';
export { app } from './app-state/root.svelte';
export {
  setTheme,
  persistDefaultModel,
  persistTierModels,
  persistDefaultReasoningEffort,
  persistDefaultVerbosity,
  persistDefaultLogLevel,
  persistEmphasisMarkdown,
  persistNotifyOnComplete,
  persistUserName,
  persistUserLocation,
  persistWikiAutomaticEnabled,
  persistWikiRecordExtractionEnabled,
  persistWikiLibrarianEnabled,
  persistMemoryLibrarianEnabled,
  persistDisplayTimezone,
  persistTheme,
  persistSystemPrompts,
  applyServerSettings,
} from './app-state/settings';
export {
  activate,
  haltBackgroundWork,
  enterSetup,
  resetForSignOut,
} from './app-state/lifecycle';
