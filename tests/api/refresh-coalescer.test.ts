import { afterEach, describe, expect, it, vi } from 'vitest';

import { RefreshCoalescer } from '../../src/api';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: () => {
      resolvePromise?.();
    }
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RefreshCoalescer', () => {
  it('coalesces burst requests into one manual refresh tick', async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => undefined);
    const coalescer = new RefreshCoalescer({
      refreshSource: { tick },
      nowMs: () => Date.parse('2026-04-10T10:00:00.000Z'),
      coalesceWindowMs: 50
    });

    const first = coalescer.requestRefresh();
    const second = coalescer.requestRefresh();

    expect(first.coalesced).toBe(false);
    expect(second.coalesced).toBe(true);
    expect(tick).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(50);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenCalledWith('manual_refresh');
  });

  it('schedules a later tick after the coalescing window has elapsed', async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => undefined);
    const coalescer = new RefreshCoalescer({
      refreshSource: { tick },
      coalesceWindowMs: 10
    });

    coalescer.requestRefresh();
    await vi.advanceTimersByTimeAsync(10);
    coalescer.requestRefresh();
    await vi.advanceTimersByTimeAsync(10);

    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('guarantees one follow-up tick for requests accepted during an in-flight tick', async () => {
    vi.useFakeTimers();

    const currentTick = deferred();
    const tick = vi.fn(async () => await currentTick.promise);

    const coalescer = new RefreshCoalescer({
      refreshSource: { tick },
      coalesceWindowMs: 10
    });

    coalescer.requestRefresh();
    await vi.advanceTimersByTimeAsync(10);
    expect(tick).toHaveBeenCalledTimes(1);

    const duringRun = coalescer.requestRefresh();
    expect(duringRun.coalesced).toBe(true);

    currentTick.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);

    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('absorbs tick failures and continues processing future refresh requests', async () => {
    vi.useFakeTimers();

    const tick = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error('tick failed'))
      .mockResolvedValueOnce(undefined);

    const coalescer = new RefreshCoalescer({
      refreshSource: { tick },
      coalesceWindowMs: 10
    });

    coalescer.requestRefresh();
    await vi.advanceTimersByTimeAsync(10);

    coalescer.requestRefresh();
    await vi.advanceTimersByTimeAsync(10);

    expect(tick).toHaveBeenCalledTimes(2);
  });
});
