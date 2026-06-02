/**
 * Supervisor worker - cycle driver for the consolidated work fleet.
 *
 * Owns one lease (worker_kind = 'supervisor') and one heartbeat,
 * then rotates through a fixed list of WorkUnits. Each unit is a
 * thin adapter around an existing per-feature loop.ts runOneCycle
 * - the supervisor passes in a fake LeaseCoordinator that always
 * reports `isHolding=true`, so the per-feature loop's first-block
 * acquire/heartbeat path is a no-op. All actual lease coordination
 * happens on the supervisor's own coordinator.
 *
 * Why one supervisor instead of N independent workers: the per-
 * feature workers each ran their own auth setup + lease + heartbeat
 * + Web Lock, which at 12 workers stacked into ~12/min of heartbeat
 * traffic, 12 auth/v1/user calls per fresh page load, and 12 rows
 * in worker_leases. The work itself doesn't need per-feature lease
 * granularity at single-tab personal-scale use - if one tab dies,
 * another picks up everything together rather than feature-by-
 * feature. One supervisor amortises all that overhead.
 *
 * Scope: this supervisor takes the six simple claim-based workers
 * (auto_title, summary, reflection, topics, memory_topics,
 * recipe_topics). Embeddings, bias, samskara,
 * wiki, and wiki-librarian stay standalone - the first three
 * because they have their own multi-phase complexity, the last
 * two because they accept main-thread `setProfile` / `setTimezone`
 * messages that would need a passthrough channel design here.
 *
 * The rotation pattern mirrors the bias and samskara outer loops:
 * walk every unit per rotation; if any unit reports 'progress',
 * skip the idle nap and rotate again immediately; if all units
 * report 'empty-phase', sleep idleIntervalMs.
 */
import type { SupabaseService } from '../../supabase';
import type { LeaseCoordinator } from '../../embeddings/lease';
import { createLogger } from '../../logger.svelte';

import { runOneCycle as runReflection } from '../reflection/loop';
import { runOneCycle as runAutoTitle } from '../auto_title/loop';
import { runOneCycle as runSummary } from '../summary/loop';
import { runOneCycle as runTopics } from '../topics/loop';
import { runOneCycle as runMemoryTopics } from '../memory_topics/loop';
import { runOneCycle as runRecipeTopics } from '../recipe_topics/loop';

import type { ReflectionAgent } from '../reflection/agent';
import type { SummaryAgent } from '../summary/agent';
import type { TopicsAgent } from '../topics/agent';
import type { MemoryTopicsAgent } from '../memory_topics/agent';
import type { RecipeTopicsAgent } from '../recipe_topics/agent';

const log = createLogger('supervisor-worker');

/**
 * Normalised return value across all units. Each per-feature loop
 * has its own result enum (reflected / titled / tagged / expired /
 * empty-queue / error / etc.); the adapters fold those into a
 * smaller alphabet the rotation driver can act on.
 */
export type SupervisorCycleResult =
  /** Supervisor just took the lease. Caller recurses immediately. */
  | 'acquired-lease'
  /** Someone else holds the supervisor lease. */
  | 'polling'
  /** A unit did real work (claimed a row, ran an agent, saved). */
  | 'progress'
  /** A unit had nothing to do this rotation. */
  | 'empty-phase'
  /** A unit reported a transient error. Outer loop applies back-off. */
  | 'error';

export interface SupervisorTunables {
  /** Per-thread claim TTL for the claim-based units (seconds). */
  threadClaimTtlSeconds: number;
}

export interface SupervisorContext {
  supabase: SupabaseService;
  coordinator: LeaseCoordinator;
  holderId: string;
  userId: string;
  /**
   * User's display timezone (IANA), live-updateable. Read on every
   * unit cycle so a Settings edit that mutates the holder cell
   * reaches the next claim without restarting the worker. The
   * reflection unit threads it into its claim RPC's day-gate;
   * other units ignore it for now (auto_title, summary, topics
   * don't have day-gates).
   */
  timezone: { value: string | null };
  signal: AbortSignal;
  onLeaseLost: () => void;
  agents: {
    reflection: ReflectionAgent;
    summary: SummaryAgent;
    topics: TopicsAgent;
    memoryTopics: MemoryTopicsAgent;
    recipeTopics: RecipeTopicsAgent;
  };
  tunables: SupervisorTunables;
}

/**
 * Coordinator stub for per-unit cycle calls. The per-feature loop's
 * top-of-cycle `if (!coordinator.isHolding) { acquire... return }`
 * block becomes a no-op when isHolding reports true unconditionally,
 * which is exactly what we want - the supervisor owns lease
 * acquisition and heartbeats on its own coordinator, units must
 * never touch the lease layer.
 */
const heldCoordinator = {
  get isHolding() {
    return true;
  },
  acquire: async () => true,
  startHeartbeat: () => {},
  stopHeartbeat: () => {},
  release: async () => {},
} as unknown as LeaseCoordinator;

/** No-op for per-unit onLeaseLost - supervisor owns the lease. */
const noLeaseLost = (): void => {};

export interface WorkUnit {
  name: string;
  run(ctx: SupervisorContext): Promise<SupervisorCycleResult>;
}

/**
 * Ordered list of work units the supervisor walks per rotation.
 * Order is roughly "cheapest probe first" so an unfortunate
 * supervisor signal-abort drains as few unit cycles as possible:
 * the title/topic units each cost one claim RPC, and
 * reflection/summary do the most work-per-cycle (Venice round-trips)
 * so they sit at the bottom.
 */
export const UNITS: readonly WorkUnit[] = [
  { name: 'auto_title', run: runAutoTitleUnit },
  { name: 'topics', run: runTopicsUnit },
  { name: 'memory_topics', run: runMemoryTopicsUnit },
  { name: 'recipe_topics', run: runRecipeTopicsUnit },
  { name: 'summary', run: runSummaryUnit },
  { name: 'reflection', run: runReflectionUnit },
];

// --- Unit adapters ------------------------------------------------------
//
// Each adapter constructs the per-unit CycleContext from the shared
// SupervisorContext, calls the unit's runOneCycle, and folds the
// per-unit result into a SupervisorCycleResult. The fake coordinator
// + no-op onLeaseLost ensure the unit's lease-management code path
// is a no-op.

async function runAutoTitleUnit(
  ctx: SupervisorContext
): Promise<SupervisorCycleResult> {
  const result = await runAutoTitle({
    supabase: ctx.supabase,
    coordinator: heldCoordinator,
    holderId: ctx.holderId,
    threadClaimTtlSeconds: ctx.tunables.threadClaimTtlSeconds,
    signal: ctx.signal,
    onLeaseLost: noLeaseLost,
  });
  if (result === 'titled' || result === 'no-title' || result === 'claim-lost') return 'progress';
  if (result === 'error') return 'error';
  return 'empty-phase';
}

async function runReflectionUnit(
  ctx: SupervisorContext
): Promise<SupervisorCycleResult> {
  const result = await runReflection({
    agent: ctx.agents.reflection,
    supabase: ctx.supabase,
    coordinator: heldCoordinator,
    holderId: ctx.holderId,
    userId: ctx.userId,
    threadClaimTtlSeconds: ctx.tunables.threadClaimTtlSeconds,
    timezone: ctx.timezone.value,
    signal: ctx.signal,
    onLeaseLost: noLeaseLost,
  });
  if (result === 'reflected' || result === 'claim-lost') return 'progress';
  if (result === 'error') return 'error';
  return 'empty-phase';
}

async function runSummaryUnit(
  ctx: SupervisorContext
): Promise<SupervisorCycleResult> {
  const result = await runSummary({
    agent: ctx.agents.summary,
    supabase: ctx.supabase,
    coordinator: heldCoordinator,
    holderId: ctx.holderId,
    userId: ctx.userId,
    threadClaimTtlSeconds: ctx.tunables.threadClaimTtlSeconds,
    signal: ctx.signal,
    onLeaseLost: noLeaseLost,
  });
  if (result === 'summarised' || result === 'claim-lost') return 'progress';
  if (result === 'error') return 'error';
  return 'empty-phase';
}

async function runTopicsUnit(
  ctx: SupervisorContext
): Promise<SupervisorCycleResult> {
  const result = await runTopics({
    agent: ctx.agents.topics,
    supabase: ctx.supabase,
    coordinator: heldCoordinator,
    holderId: ctx.holderId,
    userId: ctx.userId,
    threadClaimTtlSeconds: ctx.tunables.threadClaimTtlSeconds,
    signal: ctx.signal,
    onLeaseLost: noLeaseLost,
  });
  if (result === 'tagged' || result === 'claim-lost') return 'progress';
  if (result === 'error') return 'error';
  return 'empty-phase';
}

async function runMemoryTopicsUnit(
  ctx: SupervisorContext
): Promise<SupervisorCycleResult> {
  const result = await runMemoryTopics({
    agent: ctx.agents.memoryTopics,
    supabase: ctx.supabase,
    coordinator: heldCoordinator,
    holderId: ctx.holderId,
    userId: ctx.userId,
    memoryClaimTtlSeconds: ctx.tunables.threadClaimTtlSeconds,
    signal: ctx.signal,
    onLeaseLost: noLeaseLost,
  });
  if (result === 'tagged' || result === 'claim-lost') return 'progress';
  if (result === 'error') return 'error';
  return 'empty-phase';
}

async function runRecipeTopicsUnit(
  ctx: SupervisorContext
): Promise<SupervisorCycleResult> {
  const result = await runRecipeTopics({
    agent: ctx.agents.recipeTopics,
    supabase: ctx.supabase,
    coordinator: heldCoordinator,
    holderId: ctx.holderId,
    userId: ctx.userId,
    recipeClaimTtlSeconds: ctx.tunables.threadClaimTtlSeconds,
    signal: ctx.signal,
    onLeaseLost: noLeaseLost,
  });
  if (result === 'tagged' || result === 'claim-lost') return 'progress';
  if (result === 'error') return 'error';
  return 'empty-phase';
}

// --- Supervisor cycle ---------------------------------------------------

/**
 * Drive exactly one supervisor cycle. Handles lease acquisition on
 * the supervisor's own coordinator first; once held, rotates
 * through every unit in UNITS order. Returns the aggregate result:
 * 'progress' if any unit made forward progress, 'empty-phase' if
 * all units were empty, 'error' if any unit erred (and no unit
 * made progress).
 */
export async function runOneCycle(ctx: SupervisorContext): Promise<SupervisorCycleResult> {
  if (ctx.signal.aborted) return 'empty-phase';

  if (!ctx.coordinator.isHolding) {
    const acquired = await ctx.coordinator.acquire();
    if (!acquired) return 'polling';
    ctx.coordinator.startHeartbeat(ctx.onLeaseLost);
    log.info('supervisor lease acquired');
    return 'acquired-lease';
  }

  let aggregate: SupervisorCycleResult = 'empty-phase';
  for (const unit of UNITS) {
    if (ctx.signal.aborted) return aggregate;
    let result: SupervisorCycleResult;
    try {
      result = await unit.run(ctx);
    } catch (err) {
      // A throwing unit doesn't take down the whole supervisor -
      // we want every other unit to still get a turn. Treat the
      // unit's failure as an error result and continue.
      log.debug(`unit ${unit.name} threw`, err);
      result = 'error';
    }
    if (result === 'progress') {
      aggregate = 'progress';
    } else if (result === 'error' && aggregate === 'empty-phase') {
      aggregate = 'error';
    }
  }
  return aggregate;
}

export interface NapConfig {
  leasePollMs: number;
  idleIntervalMs: number;
  errorBackoffMs: number;
}

/**
 * Map cycle outcomes to sleep durations. Zero = run the next
 * cycle immediately (progress / acquired-lease). 'empty-phase'
 * sleeps idleIntervalMs - all units were idle, no point spinning.
 */
export function napForResult(result: SupervisorCycleResult, config: NapConfig): number {
  switch (result) {
    case 'acquired-lease':
    case 'progress':
      return 0;
    case 'polling':
      return config.leasePollMs;
    case 'empty-phase':
      return config.idleIntervalMs;
    case 'error':
      return config.errorBackoffMs;
  }
}
