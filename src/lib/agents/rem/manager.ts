/**
 * Main-thread supervisor for the rem Web Worker. Same shape as
 * deep-sleep/manager.ts with a distinct lock name and model id.
 */
import type { Session } from '@supabase/supabase-js';
import { agentModel } from '../../models';
import { emitMemoryChange } from '../../memory-events';
import { BaseWorkerManager, type BaseStartOpts } from '../base-manager';
import { remRunner } from './runner.svelte';

const WORKER_DEFAULTS = {
  leaseTtlSeconds: 300,
  leaseHeartbeatMs: 90_000,
  minIntervalSeconds: 12 * 3600,
  leasePollMs: 60_000,
  idleIntervalMs: 60 * 60_000,
  errorBackoffMs: 30_000,
};

class RemManager extends BaseWorkerManager<BaseStartOpts> {
  protected readonly lockName = 'nak:rem-worker';
  protected readonly loggerSource = 'rem-worker';

  protected createWorker(): Worker {
    return new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'nak-rem',
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
      remModel: agentModel('rem').id,
      ...WORKER_DEFAULTS,
    };
  }

  protected onWorkerMessage(data: Record<string, unknown>): boolean {
    if (data.type === 'progress' && data.result === 'reviewed') {
      emitMemoryChange();
      return true;
    }
    if (data.type === 'busy' && typeof data.busy === 'boolean') {
      remRunner.setWorkerBusy(data.busy);
      return true;
    }
    return false;
  }

  override stop(): void {
    remRunner.setWorkerBusy(false);
    super.stop();
  }
}

export const remManager = new RemManager();
