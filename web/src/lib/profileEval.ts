import { blendProbs } from './blend';
import type { UserExample } from './knn';
import type { DrumClass } from './types';
import { DRUM_CLASSES, MODEL_DRUM_CLASSES } from './types';

/**
 * Leave-one-out cross-validation over the user's stored profile examples:
 * "global model alone: X% → with your profile: Y%". Fully client-side and
 * cheap (n ≤ ~50 examples × 128-d cosine sims).
 *
 * Honesty rules:
 * - The tested example is excluded from its own KNN vote AND from the
 *   counts/profile-size fed to the blend (true leave-one-out — mirrors how
 *   the app decides *before* storing at capture time).
 * - Both legs are measured on the same test set: examples that carry
 *   modelProbs (captured at teach time). Older examples still *vote* as
 *   neighbours but are not tested, so the two numbers stay comparable.
 * - No rejection/confidence-floor logic: the metric is a stable accuracy,
 *   not entangled with the tunable floor.
 */

export const MIN_EVAL_EXAMPLES = 6;
export const MIN_EVAL_CLASSES = 2;

/** Mirrors KnnProfile.k. */
const K = 5;

export interface ProfileEvaluation {
  /** Fraction of evaluable examples the global model alone gets right. */
  globalAcc: number;
  /** Fraction the blended (global + leave-one-out KNN) classifier gets right. */
  blendedAcc: number;
  /** Size of the test set (examples that carry modelProbs). */
  nEvaluable: number;
}

/** Valid stored softmax: MODEL_DRUM_CLASSES + 'other', finite numbers. */
export function hasModelProbs(e: UserExample): boolean {
  return (
    Array.isArray(e.modelProbs) &&
    e.modelProbs.length === MODEL_DRUM_CLASSES.length + 1 &&
    e.modelProbs.every((v) => Number.isFinite(v))
  );
}

/** Progress toward unlocking the stat (for the "teach more" hint). */
export function evalProgress(examples: readonly UserExample[]): { n: number; classes: number } {
  const evaluable = examples.filter(hasModelProbs);
  return { n: evaluable.length, classes: new Set(evaluable.map((e) => e.label)).size };
}

function normalize(v: ArrayLike<number>): Float64Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/**
 * Pure re-implementation of KnnProfile.classify (L2-normalize, top-k=5,
 * max(0,sim)^4 weights) over an example array with one index excluded.
 */
export function knnVoteExcluding(
  normalized: readonly Float64Array[],
  labels: readonly DrumClass[],
  queryIdx: number,
): Record<DrumClass, number> | null {
  const q = normalized[queryIdx];
  const sims: { sim: number; label: DrumClass }[] = [];
  for (let i = 0; i < normalized.length; i++) {
    if (i === queryIdx) continue; // leave-one-out: never vote for yourself
    const e = normalized[i];
    let dot = 0;
    for (let j = 0; j < q.length; j++) dot += q[j] * e[j];
    sims.push({ sim: dot, label: labels[i] });
  }
  if (sims.length === 0) return null;
  sims.sort((a, b) => b.sim - a.sim);
  const top = sims.slice(0, Math.min(K, sims.length));
  const votes = Object.fromEntries(DRUM_CLASSES.map((c) => [c, 0])) as Record<DrumClass, number>;
  let total = 0;
  for (const { sim, label } of top) {
    const wgt = Math.max(0, sim) ** 4;
    votes[label] += wgt;
    total += wgt;
  }
  if (total <= 0) return null;
  for (const c of DRUM_CLASSES) votes[c] /= total;
  return votes;
}

/**
 * Returns null until the stat is meaningful (≥ MIN_EVAL_EXAMPLES evaluable
 * examples spanning ≥ MIN_EVAL_CLASSES classes).
 */
export function evaluateProfile(
  examples: readonly UserExample[],
  profileWeight: number,
): ProfileEvaluation | null {
  const evalIdx = examples
    .map((_, i) => i)
    .filter((i) => hasModelProbs(examples[i]));
  const evalLabels = new Set(evalIdx.map((i) => examples[i].label));
  if (evalIdx.length < MIN_EVAL_EXAMPLES || evalLabels.size < MIN_EVAL_CLASSES) return null;

  const normalized = examples.map((e) => normalize(e.embedding));
  const labels = examples.map((e) => e.label);
  const allCounts = Object.fromEntries(DRUM_CLASSES.map((c) => [c, 0])) as Record<
    DrumClass,
    number
  >;
  for (const l of labels) allCounts[l]++;

  let globalRight = 0;
  let blendedRight = 0;
  for (const i of evalIdx) {
    const ex = examples[i];
    const mp = ex.modelProbs!;

    // Global-only: argmax over the model's drum classes (renormalized without
    // 'other' — renormalization does not change the argmax). KNN-only classes
    // (clap/tom) can never be right here; that is the honest baseline.
    let gBest = 0;
    for (let c = 1; c < MODEL_DRUM_CLASSES.length; c++) if (mp[c] > mp[gBest]) gBest = c;
    if (MODEL_DRUM_CLASSES[gBest] === ex.label) globalRight++;

    // With-profile: the same blend the app uses, with this example excluded
    // from the vote, the per-class counts, and the profile size.
    const votes = knnVoteExcluding(normalized, labels, i);
    const counts = { ...allCounts };
    counts[ex.label]--;
    const blended = blendProbs(mp, votes, counts, examples.length - 1, profileWeight);
    let best: DrumClass = DRUM_CLASSES[0];
    for (const c of DRUM_CLASSES) if (blended[c] > blended[best]) best = c;
    if (best === ex.label) blendedRight++;
  }

  return {
    globalAcc: globalRight / evalIdx.length,
    blendedAcc: blendedRight / evalIdx.length,
    nEvaluable: evalIdx.length,
  };
}
