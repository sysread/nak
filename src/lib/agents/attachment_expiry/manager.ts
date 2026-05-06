/**
 * Main-thread supervisor for the attachment-expiry Web Worker.
 * Lifecycle plumbing (cross-tab lock, start / stop, log routing,
 * auth bridging) lives in `BaseWorkerManager`; this file carries
 * only the attachment-expiry-specific payload + timing.
 *
 * Cross-tab singleton via
 * `navigator.locks.request('nak:attachment-expiry-worker')`. Runs
 * concurrently with the other agent workers via separate
 * `worker_kind` partitioning of the shared `worker_leases` table.
 *
 * Unlike the other agent managers, this worker doesn't talk to
 * Venice - it just calls the `expire_old_attachments` RPC on a
 * poll. No Venice API key is passed through; only the Supabase
 * auth bits.
 */
import type { Session } from '@supabase/supabase-js';
import { BaseWorkerManager, type BaseStartOpts } from '../base-manager';

/**
 * Keep these field names identical to the worker's StartMessage -
 * mismatched names cross structured-clone without a type error and
 * show up as silent undefineds at runtime.
 *
 * Timing constants:
 *   - leaseTtlSeconds 45 / leaseHeartbeatMs 20_000: same shape as
 *     the other workers; two attempts per expiry window.
 *   - leasePollMs 20_000: match the heartbeat cadence.
 *   - idleIntervalMs 3_600_000 (1 hour): expirations are a 30-day
 *     deadline; hour-granularity is more than precise enough and
 *     keeps the worker effectively free when idle.
 *   - errorBackoffMs 60_000: a transient Supabase failure
 *     shouldn't spin - the work isn't time-sensitive.
 *   - expiryDays 30: hardcoded retention. Matches the user doc
 *     and the comment on `message_attachments.expired_at`.
 *   - batchLimit 500: matches the RPC's own `limit`, but the
 *     constant is kept client-side so tests can dial it down.
 */
const WORKER_DEFAULTS = {
  leaseTtlSeconds: 45,
  leaseHeartbeatMs: 20_000,
  leasePollMs: 20_000,
  idleIntervalMs: 60 * 60 * 1000,
  errorBackoffMs: 60_000,
  expiryDays: 30,
  batchLimit: 500,
};

class AttachmentExpiryManager extends BaseWorkerManager {
  protected readonly lockName = 'nak:attachment-expiry-worker';
  protected readonly loggerSource = 'attachment-expiry-worker';

  protected createWorker(): Worker {
    return new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'nak-attachment-expiry',
    });
  }

  protected buildStartPayload(opts: BaseStartOpts, session: Session): Record<string, unknown> {
    return {
      supabaseUrl: opts.config.supabaseUrl,
      supabaseAnonKey: opts.config.supabaseAnonKey,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      ...WORKER_DEFAULTS,
    };
  }
}

/**
 * Single app-wide instance. Imported by state.svelte.ts and nowhere
 * else.
 */
export const attachmentExpiryManager = new AttachmentExpiryManager();
