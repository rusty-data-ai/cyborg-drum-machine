/** Drum classes — must match the training pipeline's class order (ml/). */
export const DRUM_CLASSES = ['kick', 'snare', 'hihat_closed', 'hihat_open'] as const;
export type DrumClass = (typeof DRUM_CLASSES)[number];

export const DRUM_LABELS: Record<DrumClass, string> = {
  kick: 'Kick',
  snare: 'Snare',
  hihat_closed: 'Closed Hat',
  hihat_open: 'Open Hat',
};

/** A detected onset, before classification. Times are AudioContext time (seconds). */
export interface OnsetEvent {
  /** Precise onset time in AudioContext time. */
  time: number;
  /** Peak strength of the detection function (for velocity mapping). */
  strength: number;
}

/** An onset that has been classified. */
export interface ClassifiedHit extends OnsetEvent {
  drum: DrumClass;
  /** Softmax probability of the winning class. */
  confidence: number;
  probs: Record<DrumClass, number>;
  /** 64-d embedding, kept so hits can be re-classified when the user profile changes. */
  embedding?: Float32Array;
}

/** A quantized step-sequencer pattern. */
export interface Pattern {
  bpm: number;
  /** Number of steps (16 per bar). */
  steps: number;
  /** grid[drum][step] = velocity 0..1, 0 = off. */
  grid: Record<DrumClass, number[]>;
}

export function emptyPattern(bpm = 100, steps = 16): Pattern {
  return {
    bpm,
    steps,
    grid: {
      kick: new Array(steps).fill(0),
      snare: new Array(steps).fill(0),
      hihat_closed: new Array(steps).fill(0),
      hihat_open: new Array(steps).fill(0),
    },
  };
}
