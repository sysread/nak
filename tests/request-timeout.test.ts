/**
 * Contract tests for the shared request bound
 * (src/lib/request-timeout.ts): a promise that settles under the
 * bound resolves normally; one that never settles rejects at the
 * bound - `AbortSignal.timeout` timers do not hold the event loop,
 * so an injected short bound ends the test cleanly.
 */
import { describe, expect, it } from 'vitest';
import { withRequestTimeout } from '../src/lib/request-timeout';

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe('withRequestTimeout', () => {
  it('passes a settling promise through untouched', async () => {
    await expect(withRequestTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });

  it('rejects a never-settling promise at the bound', async () => {
    const started = Date.now();
    await expect(withRequestTimeout(never(), 25)).rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('propagates the wrapped promise\'s own rejection', async () => {
    await expect(
      withRequestTimeout(Promise.reject(new Error('network gone')), 1000)
    ).rejects.toThrow('network gone');
  });
});
