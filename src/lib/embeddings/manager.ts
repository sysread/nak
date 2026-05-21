/**
 * Main-thread supervisor for the embeddings Web Worker. The
 * lifecycle plumbing (cross-tab Web Lock, start / stop, log routing,
 * auth-token forwarding, holder-id stamping) lives in the shared
 * `BaseWorkerManager` under `src/lib/agents/base-manager.ts`; this
 * file only carries the embedding-specific bits: the worker URL +
 * lock name, the `start` message payload, and the timing constants
 * the worker reads.
 *
 * Cross-tab singleton via `navigator.locks.request('nak:embed-worker')`.
 * The base resolves the held promise from `stop()` to release the
 * lock so a queued tab can take over. Web Locks queue natively; we
 * don't spin on acquisition.
 *
 * Embeddings runs concurrently with the other workers - they
 * partition `worker_leases` on `worker_kind`, so one device can
 * hold every lease at once without contention.
 */
import type { Session } from '@supabase/supabase-js';
import { BaseWorkerManager, type BaseStartOpts } from '../agents/base-manager';
import { VENICE_EMBEDDING_MODEL } from '../models';

/**
 * Match these with the worker's `StartMessage` shape - any drift
 * between the two is a silent bug the TypeScript compiler can't
 * catch (they cross a structured-clone boundary, not a function
 * call). Keep the field names identical so grep finds both ends
 * at once.
 *
 * Timing constants picked to match the lease protocol:
 *   - leaseTtlSeconds 300 / leaseHeartbeatMs 90_000: two attempts
 *     per TTL window; a single failed beat is inside the margin.
 *   - rowClaimTtlSeconds 120: longer than leaseTtl so a row
 *     claimed by a dying worker isn't instantly grabbed by the
 *     next lease holder; the old worker's in-flight Venice call
 *     has definitely returned before the claim expires.
 *   - leasePollMs 20_000: while we don't hold the lease, poll at
 *     the same cadence we would've heartbeated. Cheap SELECT.
 *   - idleIntervalMs 180_000: when we DO hold the lease and the
 *     queue is empty, this is the cadence the worker probes the
 *     claim RPC. A fresh memory written by the user surfaces in
 *     the recall index within at most 3 minutes, which is
 *     acceptable for a personal-scale app where the same person
 *     is unlikely to recall against a memory they just wrote.
 *     The right fix for true responsiveness is a postMessage
 *     wake from the main thread when new work gets queued; until
 *     that lands, this interval favours mobile battery life over
 *     near-real-time embedding.
 *   - rateLimitBackoffMs 30_000: Venice's 429 doesn't carry a
 *     standard retry-after; 30s is a polite default.
 */
const WORKER_DEFAULTS = {
  leaseTtlSeconds: 300,
  leaseHeartbeatMs: 90_000,
  rowClaimTtlSeconds: 120,
  leasePollMs: 20_000,
  idleIntervalMs: 180_000,
  errorBackoffMs: 5_000,
  rateLimitBackoffMs: 30_000,
};

class EmbeddingManager extends BaseWorkerManager {
  protected readonly lockName = 'nak:embed-worker';
  protected readonly loggerSource = 'embed-worker';

  protected createWorker(): Worker {
    return new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'nak-embeddings',
    });
  }

  protected buildStartPayload(opts: BaseStartOpts, session: Session): Record<string, unknown> {
    return {
      supabaseUrl: opts.config.supabaseUrl,
      supabaseAnonKey: opts.config.supabaseAnonKey,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      veniceApiKey: opts.config.veniceApiKey,
      embeddingModel: VENICE_EMBEDDING_MODEL,
      ...WORKER_DEFAULTS,
    };
  }
}

/**
 * Single app-wide instance. Imported by state.svelte.ts's
 * activate / lock transitions and nowhere else - the manager is
 * plumbing, not something other modules should poke at directly.
 */
export const embeddingManager = new EmbeddingManager();
