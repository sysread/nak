/**
 * Main-thread supervisor for the deep-sleep Web Worker. Same shape
 * as wiki-librarian/manager.ts but with the deep-sleep lock name and
 * the deep-sleep model id.
 *
 * Activation is gated on `app.memoryLibrarianEnabled`; state.svelte.ts
 * starts/stops this worker (and the rem worker) together when the
 * user toggles the setting.
 */
import type { Session } from '@supabase/supabase-js';
import { agentModel } from '../../models';
import { emitMemoryChange } from '../../memory-events';
import { BaseWorkerManager, type BaseStartOpts } from '../base-manager';
import { deepSleepRunner } from './runner.svelte';

const WORKER_DEFAULTS = {
  leaseTtlSeconds: 300,
  leaseHeartbeatMs: 90_000,
  minIntervalSeconds: 12 * 3600,
  leasePollMs: 60_000,
  idleIntervalMs: 60 * 60_000,
  errorBackoffMs: 30_000,
};

class DeepSleepManager extends BaseWorkerManager<BaseStartOpts> {
  protected readonly lockName = 'nak:deep-sleep-worker';
  protected readonly loggerSource = 'deep-sleep-worker';

  protected createWorker(): Worker {
    return new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'nak-deep-sleep',
    });
  }

  protected buildStartPayload(
    opts: BaseStartOpts,
    session: Session
  ): Record<string, unknown> {
    return {
      supabaseUrl: opts.config.supabaseUrl,
      supabasePublishableKey: opts.config.supabasePublishableKey,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      userId: session.user.id,
      veniceApiKey: opts.config.veniceApiKey,
      deepSleepModel: agentModel('deepSleep').id,
      ...WORKER_DEFAULTS,
    };
  }

  /**
   * Bubble `progress: 'reviewed'` to the memory change-event bus so
   * an open Memories drawer / panel refetches when deep-sleep
   * actually moves memories around. `busy` brackets agent.run() so
   * the manual-trigger button can gray out while the scheduled run
   * holds the floor.
   */
  protected onWorkerMessage(data: Record<string, unknown>): boolean {
    if (data.type === 'progress' && data.result === 'reviewed') {
      emitMemoryChange();
      return true;
    }
    if (data.type === 'busy' && typeof data.busy === 'boolean') {
      deepSleepRunner.setWorkerBusy(data.busy);
      return true;
    }
    return false;
  }

  override stop(): void {
    deepSleepRunner.setWorkerBusy(false);
    super.stop();
  }
}

export const deepSleepManager = new DeepSleepManager();
