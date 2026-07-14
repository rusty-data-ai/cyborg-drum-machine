import type { ClassifiedHit, Pattern } from './types';
import { emptyPattern } from './types';

/**
 * Tempo estimation + quantization of classified hits onto a 16th-note grid.
 *
 * Tempo is found by scoring candidate BPMs with the circular-statistics
 * resultant of onset phases: for a candidate 16th-note period T, hits that
 * all fall near grid positions have tightly clustered phases (t mod T), giving
 * a resultant length near 1. A mild lognormal prior around ~105 BPM breaks
 * ties between metrical harmonics (e.g. 80 vs 160 BPM).
 */

export interface QuantizeOptions {
  /** If set (metronome mode), skip tempo estimation. */
  knownBpm?: number;
  minBpm?: number;
  maxBpm?: number;
}

export interface TempoEstimate {
  bpm: number;
  /** Grid origin (seconds): time of step 0. */
  origin: number;
  /** 0..1 — resultant length; how well onsets fit the grid. */
  gridFit: number;
}

const STEPS_PER_BAR = 16;
const MAX_BARS = 4;

export function estimateTempo(
  times: number[],
  weights: number[],
  minBpm = 65,
  maxBpm = 185,
): TempoEstimate {
  if (times.length < 2) {
    return { bpm: 100, origin: times[0] ?? 0, gridFit: 0 };
  }
  let best = { bpm: 100, score: -Infinity, phase: 0, r: 0 };
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.25) {
    const period = 15 / bpm; // 16th-note duration
    let sx = 0;
    let sy = 0;
    let wsum = 0;
    for (let i = 0; i < times.length; i++) {
      const ph = ((times[i] % period) / period) * 2 * Math.PI;
      const w = weights[i];
      sx += w * Math.cos(ph);
      sy += w * Math.sin(ph);
      wsum += w;
    }
    const r = Math.hypot(sx, sy) / (wsum || 1);
    // Lognormal-ish prior centred near 105 BPM to disambiguate harmonics.
    const prior = Math.exp(-0.5 * ((Math.log2(bpm / 105) / 0.9) ** 2));
    const score = r * (0.75 + 0.25 * prior);
    if (score > best.score) {
      best = { bpm, score, phase: Math.atan2(sy, sx), r };
    }
  }
  const period = 15 / best.bpm;
  // Circular-mean phase → grid offset; anchor the origin at/just before the first hit.
  const offset = ((best.phase / (2 * Math.PI)) * period + period) % period;
  const first = Math.min(...times);
  const origin = first - ((((first - offset) % period) + period) % period);
  return { bpm: best.bpm, origin, gridFit: best.r };
}

/** Snap hits to a 16th grid, producing a looping Pattern. */
export function quantizeHits(hits: ClassifiedHit[], opts: QuantizeOptions = {}): Pattern {
  if (hits.length === 0) return emptyPattern(opts.knownBpm ?? 100);

  const times = hits.map((h) => h.time);
  const weights = hits.map((h) => 0.3 + 0.7 * clamp01(h.strength));

  let tempo: TempoEstimate;
  if (opts.knownBpm) {
    tempo = { bpm: opts.knownBpm, origin: Math.min(...times), gridFit: 1 };
  } else {
    tempo = estimateTempo(times, weights, opts.minBpm, opts.maxBpm);
  }

  const period = 15 / tempo.bpm;
  const rawSteps = hits.map((h) => Math.round((h.time - tempo.origin) / period));
  const minStep = Math.min(...rawSteps);
  const shifted = rawSteps.map((s) => s - minStep);
  const span = Math.max(...shifted) + 1;
  const bars = Math.min(MAX_BARS, Math.max(1, Math.ceil(span / STEPS_PER_BAR)));
  const steps = bars * STEPS_PER_BAR;

  const maxStrength = Math.max(...hits.map((h) => h.strength), 1e-6);
  const pattern = emptyPattern(roundBpm(tempo.bpm), steps);
  hits.forEach((h, i) => {
    const step = ((shifted[i] % steps) + steps) % steps;
    const vel = 0.4 + 0.6 * clamp01(h.strength / maxStrength);
    pattern.grid[h.drum][step] = Math.max(pattern.grid[h.drum][step], vel);
  });

  return rotateToDownbeat(pattern);
}

/**
 * Rotate the loop so a plausible downbeat is step 0: prefer the strongest
 * kick among the earliest hits; fall back to the first occupied step.
 */
function rotateToDownbeat(p: Pattern): Pattern {
  const occupied: number[] = [];
  for (let s = 0; s < p.steps; s++) {
    if (Object.values(p.grid).some((row) => row[s] > 0)) occupied.push(s);
  }
  if (occupied.length === 0) return p;
  let anchor = occupied[0];
  // If a kick lands within the first quarter-bar of activity, anchor there.
  for (const s of occupied.slice(0, 4)) {
    if (p.grid.kick[s] > 0) {
      anchor = s;
      break;
    }
  }
  if (anchor === 0) return p;
  const rotated = emptyPattern(p.bpm, p.steps);
  for (const drum of Object.keys(p.grid) as (keyof Pattern['grid'])[]) {
    for (let s = 0; s < p.steps; s++) {
      rotated.grid[drum][s] = p.grid[drum][(s + anchor) % p.steps];
    }
  }
  return rotated;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function roundBpm(bpm: number): number {
  return Math.round(bpm * 2) / 2;
}
