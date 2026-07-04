/**
 * The single source of truth for the diagnostic-pill column - the
 * recall / intuition / bias / samskara-mood / intents glance cues that
 * sit bottom-right of the messages pane on desktop and inside the
 * composer's drop-up "wharf" on mobile.
 *
 * Both surfaces are rendered by `src/components/DiagnosticPills.svelte`,
 * which loops the ordered `DIAGNOSTIC_PILLS` array below. Because both
 * the desktop column and the mobile wharf derive their pills, order, and
 * labels from this one list, the two surfaces cannot drift apart - the
 * failure mode the old design had, where five standalone components plus
 * a duplicated wharf plus a styles.css hide-list all had to be kept in
 * sync by hand. Add a pill here (and give it a render branch in the
 * component) and it appears on both surfaces in the right slot.
 *
 * This module is rune-free and DOM-free on purpose (the
 * "decision-logic lives in src/lib/ui" rule, see
 * docs/dev/frontend-organization.md): it is the list-assembly +
 * label-derivation layer, unit-tested in tests/diagnostic-pills.test.ts.
 * The `.svelte` file owns the framework-coupled rendering.
 */
import type { ContextRecallPayload } from '../context-recall';
import type { IntuitionPayload } from '../intuition';
import type { Modal } from '../routing.svelte';
import { DEFAULT_EMOJI, type MoodVisual } from './samskara-toasts';

/**
 * Everything the pills need to decide presence, enabled state, glyph,
 * and labels. Assembled by the component from its payload props and the
 * shared `moodState`; passed to every descriptor function so the
 * descriptors stay pure.
 */
export interface DiagnosticPillContext {
  recall: ContextRecallPayload | null;
  intuition: IntuitionPayload | null;
  moodVisual: MoodVisual | null;
  intentsEnabled: boolean;
}

export type DiagnosticPillId =
  | 'recall'
  | 'intuition'
  | 'bias'
  | 'samskara'
  | 'intents';

export interface DiagnosticPillDescriptor {
  id: DiagnosticPillId;
  /** Diagnostics modal this pill opens via `navigate({ modal })`. */
  modal: Modal;
  /** Whether the pill occupies a slot at all. recall/intuition/bias/
   *  intents are always present (recall/intuition merely render
   *  disabled when their payload is missing; the intents pill hosts
   *  follow-ups too, which every account has); samskara is present only
   *  on an active thread. */
  present: (ctx: DiagnosticPillContext) => boolean;
  /** Whether the pill is interactive. A present-but-disabled pill still
   *  holds its slot but ignores clicks (no data to open yet). */
  enabled: (ctx: DiagnosticPillContext) => boolean;
  /** The glyph to show. Static for most; derived from the live mood for
   *  samskara. */
  emoji: (ctx: DiagnosticPillContext) => string;
  /** tooltip / `title` text. */
  title: (ctx: DiagnosticPillContext) => string;
  /** `aria-label` - distinct from title so the no-data state reads
   *  differently to a screen reader. */
  ariaLabel: (ctx: DiagnosticPillContext) => string;
}

/** A recall payload only counts as openable once it carries a note. */
function recallHasData(ctx: DiagnosticPillContext): boolean {
  return ctx.recall !== null && ctx.recall.note.trim().length > 0;
}

/**
 * The pills, in column order top-to-bottom: recall at the top, intents
 * at the bottom (directly above the scroll-to-bottom arrow). The mobile
 * wharf reads the same order top-to-bottom. Changing this order is the
 * one edit that reorders BOTH surfaces.
 */
export const DIAGNOSTIC_PILLS: readonly DiagnosticPillDescriptor[] = [
  {
    id: 'recall',
    modal: 'recall',
    present: () => true,
    enabled: recallHasData,
    emoji: () => '\u{1F4A1}', // electric light bulb
    title: (ctx) =>
      recallHasData(ctx)
        ? 'View recall - what Nak remembered before the next reply'
        : 'Recall - no data for this conversation yet',
    ariaLabel: (ctx) =>
      recallHasData(ctx)
        ? 'Open recall diagnostics'
        : 'Recall diagnostics (no data yet)',
  },
  {
    id: 'intuition',
    modal: 'intuition',
    present: () => true,
    enabled: (ctx) => ctx.intuition !== null,
    emoji: () => '\u{1F9E0}', // brain
    title: (ctx) =>
      ctx.intuition !== null
        ? 'View intuition - perception, drives, synthesis'
        : 'Intuition - no data for this conversation yet',
    ariaLabel: (ctx) =>
      ctx.intuition !== null
        ? 'Open intuition diagnostics'
        : 'Intuition diagnostics (no data yet)',
  },
  {
    id: 'bias',
    modal: 'bias-profile',
    // Always present and enabled: the modal carries useful chrome (the
    // full bias catalog with priors) even before the worker has observed
    // anything, so there's never a "no data" disabled state.
    present: () => true,
    enabled: () => true,
    emoji: () => '\u{1F4C8}', // chart increasing
    title: () => 'View bias profile - observed patterns across conversations',
    ariaLabel: () => 'Open bias profile diagnostics',
  },
  {
    id: 'samskara',
    modal: 'samskara-mood',
    // Present only on an active thread. moodVisual is null exactly when
    // there's no cid to scope a mood to (brand-new-chat screen), so the
    // glance would be lying - suppress it. On both surfaces.
    present: (ctx) => ctx.moodVisual !== null,
    enabled: () => true,
    emoji: (ctx) =>
      ctx.moodVisual === null || ctx.moodVisual.isDefault
        ? DEFAULT_EMOJI
        : ctx.moodVisual.emoji,
    title: (ctx) =>
      ctx.moodVisual === null || ctx.moodVisual.isDefault
        ? 'Samskara - no mood data yet for this conversation'
        : `feelin' ${ctx.moodVisual.label} - open Samskara diagnostics`,
    ariaLabel: (ctx) =>
      ctx.moodVisual === null || ctx.moodVisual.isDefault
        ? 'Open Samskara diagnostics. No mood data yet for this conversation.'
        : `Samskara mood: ${ctx.moodVisual.label} (tier ${ctx.moodVisual.tier}). Open diagnostics.`,
  },
  {
    id: 'intents',
    modal: 'intents',
    // Always present: the modal hosts follow-ups (pending questions Nak
    // saved to ask later) for every account, alongside the opt-in
    // working intentions. The copy adapts so a user who never enabled
    // intents isn't promised a feature they don't have.
    present: () => true,
    enabled: () => true,
    emoji: () => '\u{1F331}', // seedling
    title: (ctx) =>
      ctx.intentsEnabled
        ? 'View working intentions and follow-ups - what Nak is working toward and waiting to hear about'
        : 'View follow-ups - questions Nak saved to ask you later',
    ariaLabel: (ctx) =>
      ctx.intentsEnabled
        ? 'Open working intentions and follow-ups inspector'
        : 'Open follow-ups inspector',
  },
];

/**
 * A present pill annotated with the CSS `bottom` value the desktop
 * column positions it at. The column is bottom-anchored above the
 * scroll-to-bottom arrow: the lowest visible pill sits at 3.6rem and
 * each pill above it steps up one 2.1rem-pill + 0.4rem-gap = 2.5rem
 * increment. Computing the offset from the visible set (rather than a
 * fixed per-pill value) means an absent pill simply collapses its slot
 * - no gap opens, and there's no `--diag-base` toggle to keep in sync.
 */
export interface PositionedDiagnosticPill {
  descriptor: DiagnosticPillDescriptor;
  /** CSS length for the desktop pill's `bottom`, e.g. "3.6rem". */
  bottom: string;
}

/** Lowest pill's offset above the messages-pane bottom (clears the
 *  scroll-to-bottom arrow, which is 1rem + a 2.2rem footprint). */
const COLUMN_BASE_REM = 3.6;
/** 2.1rem pill height + 0.4rem inter-pill gap. */
const COLUMN_STEP_REM = 2.5;

/**
 * The pills that should render right now, top-to-bottom, each with its
 * desktop `bottom`. Filters out absent pills (intents when off, samskara
 * with no active thread) and assigns offsets from the bottom up so the
 * column stays flush with the scroll arrow in every combination.
 */
export function visibleDiagnosticPills(
  ctx: DiagnosticPillContext
): PositionedDiagnosticPill[] {
  const present = DIAGNOSTIC_PILLS.filter((p) => p.present(ctx));
  const lastIndex = present.length - 1;
  return present.map((descriptor, i) => ({
    descriptor,
    // i counts from the top; invert so the bottom-most present pill is
    // step 0 at COLUMN_BASE_REM.
    bottom: `${COLUMN_BASE_REM + (lastIndex - i) * COLUMN_STEP_REM}rem`,
  }));
}
