import type { DrumClass } from './types';
import { DRUM_CLASSES, MODEL_DRUM_CLASSES, isModelDrumClass } from './types';

/**
 * Blend of global-model softmax and personal-KNN votes, over all pad classes.
 * Pure logic, extracted from HitClassifier so it is testable without ONNX.
 *
 * KNN-only classes (clap, tom) have no global-model output: they can only win
 * via the KNN, and only once taught at least MIN_KNN_EXAMPLES examples.
 */

/** Taught-only pads need this many examples before transcription may emit them. */
export const MIN_KNN_EXAMPLES = 4;

export function blendProbs(
  modelProbs: number[], // softmax over MODEL_DRUM_CLASSES + 'other'
  knnVotes: Record<DrumClass, number> | null,
  counts: Record<DrumClass, number>,
  profileSize: number,
  profileWeight: number,
): Record<DrumClass, number> {
  const drumProbs = modelProbs.slice(0, MODEL_DRUM_CLASSES.length);
  const drumSum = drumProbs.reduce((a, b) => a + b, 0) || 1;

  // Untaught KNN-only classes are ineligible: zero their vote and renormalize.
  let knn: Record<DrumClass, number> | null = knnVotes ? { ...knnVotes } : null;
  if (knn) {
    let mass = 0;
    for (const c of DRUM_CLASSES) {
      if (!isModelDrumClass(c) && counts[c] < MIN_KNN_EXAMPLES) knn[c] = 0;
      mass += knn[c];
    }
    if (mass > 0) for (const c of DRUM_CLASSES) knn[c] /= mass;
    else knn = null;
  }

  // Held-out-user eval: KNN dominates once the profile is populated, so let
  // alpha run up to the user's profileWeight cap.
  const alpha = knn ? Math.min(profileWeight, profileSize / 24) : 0;
  const blended = {} as Record<DrumClass, number>;
  for (const c of DRUM_CLASSES) {
    const mi = (MODEL_DRUM_CLASSES as readonly string[]).indexOf(c);
    const global = mi >= 0 ? drumProbs[mi] / drumSum : 0;
    blended[c] = alpha * (knn ? knn[c] : 0) + (1 - alpha) * global;
  }
  return blended;
}
