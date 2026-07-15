import { describe, expect, it } from 'vitest';
import { MIN_KNN_EXAMPLES, blendProbs } from './blend';
import type { DrumClass } from './types';
import { DRUM_CLASSES } from './types';

function counts(partial: Partial<Record<DrumClass, number>> = {}): Record<DrumClass, number> {
  return Object.fromEntries(DRUM_CLASSES.map((c) => [c, partial[c] ?? 0])) as Record<
    DrumClass,
    number
  >;
}

function votes(partial: Partial<Record<DrumClass, number>>): Record<DrumClass, number> {
  return counts(partial);
}

// Model softmax: kick, snare, hihat_closed, hihat_open, other.
const KICKY = [0.7, 0.1, 0.1, 0.05, 0.05];

describe('blendProbs', () => {
  it('reduces to the renormalized global softmax with no profile', () => {
    const blended = blendProbs(KICKY, null, counts(), 0, 0.85);
    expect(blended.kick).toBeCloseTo(0.7 / 0.95);
    expect(blended.clap).toBe(0);
    expect(blended.tom).toBe(0);
  });

  it('never emits mass for an untaught KNN-only class', () => {
    // KNN votes clap hard, but only 2 clap examples exist (< MIN_KNN_EXAMPLES).
    const blended = blendProbs(
      KICKY,
      votes({ clap: 0.9, kick: 0.1 }),
      counts({ clap: 2, kick: 8, snare: 8, hihat_closed: 8 }),
      26,
      0.85,
    );
    expect(blended.clap).toBe(0);
    // The surviving KNN mass renormalizes onto eligible classes.
    const best = DRUM_CLASSES.reduce((a, b) => (blended[b] > blended[a] ? b : a));
    expect(best).toBe('kick');
  });

  it('lets a taught KNN-only class win purely via KNN', () => {
    const blended = blendProbs(
      KICKY,
      votes({ clap: 0.95, kick: 0.05 }),
      counts({ clap: MIN_KNN_EXAMPLES, kick: 8, snare: 8, hihat_closed: 8 }),
      28,
      0.85,
    );
    const best = DRUM_CLASSES.reduce((a, b) => (blended[b] > blended[a] ? b : a));
    expect(best).toBe('clap');
    // Its global term is zero: everything comes from alpha·knn.
    expect(blended.clap).toBeCloseTo(0.85 * 0.95);
  });

  it('caps the KNN weight at profileWeight ("trust my profile")', () => {
    const full = votes({ snare: 1 });
    const c = counts({ snare: 48 });
    const trusting = blendProbs(KICKY, full, c, 48, 1);
    const distrusting = blendProbs(KICKY, full, c, 48, 0);
    expect(trusting.snare).toBeCloseTo(1);
    // profileWeight 0 → pure global model.
    expect(distrusting.snare).toBeCloseTo(0.1 / 0.95);
    expect(distrusting.kick).toBeCloseTo(0.7 / 0.95);
  });

  it('falls back to the global model when all KNN mass is ineligible', () => {
    const blended = blendProbs(
      KICKY,
      votes({ tom: 1 }),
      counts({ tom: MIN_KNN_EXAMPLES - 1 }),
      3,
      0.85,
    );
    expect(blended.tom).toBe(0);
    expect(blended.kick).toBeCloseTo(0.7 / 0.95);
  });
});
