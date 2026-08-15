import { describe, expect, it } from 'vitest';
import {
  MAX_RECOIL_MS,
  MAX_WINDUP_MS,
  planStrike,
  stepDurationMs,
} from './drummerTiming';

describe('stepDurationMs', () => {
  it('is the 16th-note duration', () => {
    expect(stepDurationMs(60)).toBe(250);
    expect(stepDurationMs(120)).toBe(125);
    expect(stepDurationMs(200)).toBe(75);
  });
});

describe('planStrike', () => {
  it('uses the full wind-up at slow tempos (60 bpm)', () => {
    const plan = planStrike(10_000, stepDurationMs(60));
    expect(plan.startTime).toBe(10_000 - MAX_WINDUP_MS);
    expect(plan.duration).toBe(MAX_WINDUP_MS + MAX_RECOIL_MS);
  });

  it('clamps recoil to the step at 120 bpm', () => {
    const plan = planStrike(10_000, stepDurationMs(120));
    expect(plan.startTime).toBe(10_000 - 120); // windup still fits (125 > 120)
    expect(plan.duration).toBe(120 + 125);
  });

  it('clamps both phases to the step at 200 bpm so impacts stay on the grid', () => {
    const step = stepDurationMs(200); // 75 ms
    const plan = planStrike(10_000, step);
    expect(plan.startTime).toBe(10_000 - 75);
    expect(plan.duration).toBe(150);
    // A retrigger on the very next step starts exactly when this recoil ends.
    expect(plan.startTime + plan.duration).toBe(10_000 + step);
  });

  it('always lands the impact keyframe exactly on the requested time', () => {
    for (const bpm of [60, 90, 120, 160, 200]) {
      const plan = planStrike(5_000, stepDurationMs(bpm));
      expect(plan.startTime + plan.impactOffset * plan.duration).toBeCloseTo(5_000, 6);
      expect(plan.impactOffset).toBeGreaterThan(0);
      expect(plan.impactOffset).toBeLessThan(1);
    }
  });

  it('never shrinks a phase below the visibility floor', () => {
    const plan = planStrike(1_000, 10); // absurdly fast "tempo"
    expect(plan.duration).toBe(80); // 40 + 40
  });
});
