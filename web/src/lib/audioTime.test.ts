import { describe, expect, it } from 'vitest';
import { audioToPerfTime, clockMapping } from './audioTime';

describe('audioToPerfTime', () => {
  it('converts audio seconds to performance ms through the mapping', () => {
    const m = { contextTime: 10, performanceTime: 5000 };
    expect(audioToPerfTime(10, m)).toBe(5000);
    expect(audioToPerfTime(10.5, m)).toBe(5500);
    expect(audioToPerfTime(9.9, m)).toBeCloseTo(4900);
  });

  it('is exact for future scheduled times (the sequencer lead window)', () => {
    const m = { contextTime: 2.0, performanceTime: 1000 };
    // 120 ms ahead on the audio clock → 120 ms ahead on the perf clock.
    expect(audioToPerfTime(2.12, m)).toBeCloseTo(1120);
  });
});

describe('clockMapping', () => {
  it('uses getOutputTimestamp when it returns a valid pair', () => {
    const ctx = {
      currentTime: 3,
      getOutputTimestamp: () => ({ contextTime: 2.95, performanceTime: 7000 }),
    };
    expect(clockMapping(ctx)).toEqual({ contextTime: 2.95, performanceTime: 7000 });
  });

  it('falls back to currentTime/performance.now() without getOutputTimestamp', () => {
    const before = performance.now();
    const m = clockMapping({ currentTime: 4.2 });
    const after = performance.now();
    expect(m.contextTime).toBe(4.2);
    expect(m.performanceTime).toBeGreaterThanOrEqual(before);
    expect(m.performanceTime).toBeLessThanOrEqual(after);
  });

  it('falls back when getOutputTimestamp returns an empty dict (suspended context)', () => {
    const m = clockMapping({ currentTime: 1.5, getOutputTimestamp: () => ({}) });
    expect(m.contextTime).toBe(1.5);
    expect(Number.isFinite(m.performanceTime)).toBe(true);
  });
});
