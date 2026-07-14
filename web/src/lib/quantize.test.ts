import { describe, expect, it } from 'vitest';
import { estimateTempo, quantizeHits } from './quantize';
import type { ClassifiedHit, DrumClass } from './types';

function hit(time: number, drum: DrumClass, strength = 1): ClassifiedHit {
  return {
    time,
    strength,
    drum,
    confidence: 0.9,
    probs: { kick: 0.9, snare: 0.03, hihat_closed: 0.03, hihat_open: 0.04 },
  };
}

/** Generate hits on a 16th grid at the given bpm with optional timing noise. */
function gridHits(
  bpm: number,
  events: Array<[stepIndex: number, drum: DrumClass]>,
  noiseMs = 0,
  origin = 0.5,
): ClassifiedHit[] {
  const period = 15 / bpm;
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31 - 0.5;
  };
  return events.map(([s, d]) => hit(origin + s * period + (rand() * noiseMs * 2) / 1000, d));
}

const ROCK_BEAT: Array<[number, DrumClass]> = [
  [0, 'kick'],
  [0, 'hihat_closed'],
  [2, 'hihat_closed'],
  [4, 'snare'],
  [4, 'hihat_closed'],
  [6, 'hihat_closed'],
  [8, 'kick'],
  [8, 'hihat_closed'],
  [10, 'kick'],
  [10, 'hihat_closed'],
  [12, 'snare'],
  [12, 'hihat_closed'],
  [14, 'hihat_open'],
];

describe('estimateTempo', () => {
  it('recovers a clean 100bpm grid', () => {
    const hits = gridHits(100, ROCK_BEAT);
    const est = estimateTempo(
      hits.map((h) => h.time),
      hits.map(() => 1),
    );
    // Metrical harmonics (half/double) would also be acceptable musically,
    // but a clean grid should lock the true tempo.
    expect(Math.abs(est.bpm - 100)).toBeLessThan(2);
    expect(est.gridFit).toBeGreaterThan(0.9);
  });

  it('tolerates ±15ms of human timing noise', () => {
    const hits = gridHits(95, ROCK_BEAT, 15);
    const est = estimateTempo(
      hits.map((h) => h.time),
      hits.map(() => 1),
    );
    const ratio = est.bpm / 95;
    const nearHarmonic = [0.5, 1, 2].some((h) => Math.abs(ratio - h) < 0.06);
    expect(nearHarmonic).toBe(true);
  });

  it('handles fewer than two hits gracefully', () => {
    expect(estimateTempo([], []).bpm).toBe(100);
    expect(estimateTempo([1.5], [1]).origin).toBe(1.5);
  });
});

describe('quantizeHits', () => {
  it('reconstructs the pattern on the grid (metronome mode)', () => {
    const hits = gridHits(100, ROCK_BEAT, 8, 0.5);
    const pat = quantizeHits(hits, { knownBpm: 100, origin: 0.5 });
    expect(pat.bpm).toBe(100);
    expect(pat.steps).toBe(16);
    expect(pat.grid.kick[0]).toBeGreaterThan(0);
    expect(pat.grid.snare[4]).toBeGreaterThan(0);
    expect(pat.grid.snare[12]).toBeGreaterThan(0);
    expect(pat.grid.hihat_open[14]).toBeGreaterThan(0);
    // Nothing invented where nothing was played.
    expect(pat.grid.kick[1]).toBe(0);
    expect(pat.grid.snare[0]).toBe(0);
  });

  it('free mode reproduces relative structure', () => {
    const hits = gridHits(112, ROCK_BEAT, 5);
    const pat = quantizeHits(hits);
    // Kick anchored at step 0 after downbeat rotation.
    expect(pat.grid.kick[0]).toBeGreaterThan(0);
    // Snare backbeat lands mid-bar (allow the est. grid to be at 1x or 2x).
    const snareSteps = pat.grid.snare
      .map((v, i) => (v > 0 ? i : -1))
      .filter((i) => i >= 0);
    expect(snareSteps.length).toBeGreaterThan(0);
    const total = Object.values(pat.grid)
      .flat()
      .filter((v) => v > 0).length;
    expect(total).toBeGreaterThanOrEqual(10); // most of the 13 events survive
  });

  it('returns an empty pattern for no hits', () => {
    const pat = quantizeHits([]);
    expect(Object.values(pat.grid).flat().every((v) => v === 0)).toBe(true);
  });

  it('maps strength to velocity', () => {
    const hits = [hit(0.5, 'kick', 1), hit(0.8, 'kick', 0.2)];
    const pat = quantizeHits(hits, { knownBpm: 100, origin: 0.5 });
    const vels = pat.grid.kick.filter((v) => v > 0);
    expect(Math.max(...vels)).toBeGreaterThan(Math.min(...vels));
  });
});
