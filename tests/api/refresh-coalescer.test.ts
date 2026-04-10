import { afterEach, describe, expect, it, vi } from 'vitest';

import { RefreshCoalescer } from '../../src/api';

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
});
