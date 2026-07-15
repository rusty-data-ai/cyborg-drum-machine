/** Classes the global ONNX model outputs — must match ml/dataset.py CLASSES order (minus 'other'). */
export const MODEL_DRUM_CLASSES = ['kick', 'snare', 'hihat_closed', 'hihat_open'] as const;
export type ModelDrumClass = (typeof MODEL_DRUM_CLASSES)[number];

/**
 * Pad classes shown in the grid. clap/tom are KNN-only: the global model never
 * saw them, so they are classifiable only from the user's taught profile.
 */
export const DRUM_CLASSES = [
  'kick',
  'snare',
  'hihat_closed',
  'hihat_open',
  'clap',
  'tom',
] as const;
export type DrumClass = (typeof DRUM_CLASSES)[number];

export function isModelDrumClass(c: DrumClass): c is ModelDrumClass {
  return (MODEL_DRUM_CLASSES as readonly string[]).includes(c);
}

export const DRUM_LABELS: Record<DrumClass, string> = {
  kick: 'Kick',
  snare: 'Snare',
  hihat_closed: 'Closed Hat',
  hihat_open: 'Open Hat',
  clap: 'Clap',
  tom: 'Tom',
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
  /** Embedding, kept so hits can be re-classified when the user profile changes. */
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
    grid: Object.fromEntries(
      DRUM_CLASSES.map((c) => [c, new Array(steps).fill(0)]),
    ) as Record<DrumClass, number[]>,
  };
}
