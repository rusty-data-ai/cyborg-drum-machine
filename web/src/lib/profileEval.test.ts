import { describe, expect, it } from 'vitest';
import { blendProbs } from './blend';
import type { UserExample } from './knn';
import {
  evalProgress,
  evaluateProfile,
  hasModelProbs,
  knnVoteExcluding,
} from './profileEval';
import type { DrumClass } from './types';
import { DRUM_CLASSES } from './types';

let nextId = 1;
function ex(label: DrumClass, embedding: number[], modelProbs?: number[]): UserExample {
  return {
    id: nextId++,
    label,
    embedding: Float32Array.from(embedding),
    modelVersion: 'test',
    createdAt: 0,
    ...(modelProbs ? { modelProbs } : {}),
  };
}

const UNIFORM = [0.25, 0.25, 0.25, 0.25, 0];
const KICKISH = [0.7, 0.1, 0.1, 0.05, 0.05];
const SNAREISH = [0.1, 0.7, 0.1, 0.05, 0.05];

function onCircle(deg: number): number[] {
  return [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
}

describe('hasModelProbs / evalProgress', () => {
  it('requires a finite 5-vector', () => {
    expect(hasModelProbs(ex('kick', [1, 0], KICKISH))).toBe(true);
    expect(hasModelProbs(ex('kick', [1, 0]))).toBe(false);
    expect(hasModelProbs(ex('kick', [1, 0], [0.5, 0.5]))).toBe(false);
    expect(hasModelProbs(ex('kick', [1, 0], [NaN, 0, 0, 0, 1]))).toBe(false);
  });

  it('counts evaluable examples and their distinct classes', () => {
    const examples = [
      ex('kick', [1, 0], KICKISH),
      ex('kick', [1, 0.1], KICKISH),
      ex('snare', [0, 1], SNAREISH),
      ex('snare', [0.1, 1]), // legacy: no modelProbs
    ];
    expect(evalProgress(examples)).toEqual({ n: 3, classes: 2 });
  });
});

describe('evaluateProfile — gating', () => {
  it('returns null below 6 evaluable examples or below 2 classes', () => {
    const five = [
      ex('kick', [1, 0], KICKISH),
      ex('kick', [1, 0.1], KICKISH),
      ex('kick', [1, -0.1], KICKISH),
      ex('snare', [0, 1], SNAREISH),
      ex('snare', [0.1, 1], SNAREISH),
    ];
    expect(evaluateProfile(five, 0.85)).toBeNull();
    const sixOneClass = Array.from({ length: 6 }, (_, i) => ex('kick', [1, i / 10], KICKISH));
    expect(evaluateProfile(sixOneClass, 0.85)).toBeNull();
    expect(evaluateProfile([...five, ex('snare', [0.2, 1], SNAREISH)], 0.85)).not.toBeNull();
  });
});

describe('evaluateProfile — known-answer clusters', () => {
  it('perfect clusters + correct global probs → both legs 100%', () => {
    const examples = [
      ex('kick', [1, 0, 0], KICKISH),
      ex('kick', [1, 0.05, 0], KICKISH),
      ex('kick', [1, -0.05, 0], KICKISH),
      ex('kick', [0.95, 0, 0.05], KICKISH),
      ex('snare', [0, 1, 0], SNAREISH),
      ex('snare', [0.05, 1, 0], SNAREISH),
      ex('snare', [0, 1, 0.05], SNAREISH),
      ex('snare', [0, 0.95, 0.05], SNAREISH),
    ];
    const r = evaluateProfile(examples, 0.85)!;
    expect(r.nEvaluable).toBe(8);
    expect(r.globalAcc).toBe(1);
    expect(r.blendedAcc).toBe(1);
  });

  it('KNN rescues a global model that leans the wrong way', () => {
    const kickWrong = [0.3, 0.34, 0.18, 0.13, 0.05]; // global argmax: snare
    const examples = [
      ex('kick', [1, 0, 0], kickWrong),
      ex('kick', [1, 0.05, 0], kickWrong),
      ex('kick', [1, -0.05, 0], kickWrong),
      ex('kick', [0.95, 0, 0.05], kickWrong),
      ex('snare', [0, 1, 0], SNAREISH),
      ex('snare', [0.05, 1, 0], SNAREISH),
      ex('snare', [0, 1, 0.05], SNAREISH),
      ex('snare', [0, 0.95, 0.05], SNAREISH),
    ];
    const r = evaluateProfile(examples, 0.85)!;
    expect(r.globalAcc).toBe(0.5); // all kicks misread as snare
    expect(r.blendedAcc).toBe(1); // the profile fixes them
  });
});

describe('evaluateProfile — leave-one-out honesty', () => {
  it('an example cannot vote for itself', () => {
    const examples = [
      ex('tom', [0, 0, 1], UNIFORM), // the only tom in the profile
      ex('kick', [1, 0, 0.2], KICKISH),
      ex('kick', [1, 0.1, 0.2], KICKISH),
      ex('kick', [1, -0.1, 0.2], KICKISH),
    ];
    const normalized = examples.map((e) => {
      const v = Array.from(e.embedding);
      const n = Math.hypot(...v) || 1;
      return Float64Array.from(v.map((x) => x / n));
    });
    const labels = examples.map((e) => e.label);
    const votes = knnVoteExcluding(normalized, labels, 0)!;
    expect(votes.tom).toBe(0); // only its own embedding could have voted tom
    expect(votes.kick).toBe(1);
  });

  it('differs from a deliberately-leaky implementation on a crafted fixture', () => {
    // Six examples on a circle, 50° apart, alternating labels: every
    // example's only meaningful neighbours have the *other* label, but its
    // own embedding (cosine 1, weight 1 after ^4) would dominate them all.
    const labels: DrumClass[] = ['kick', 'snare', 'kick', 'snare', 'kick', 'snare'];
    const examples = labels.map((l, i) => ex(l, onCircle(i * 50), UNIFORM));
    const normalized = examples.map((e) => Float64Array.from(e.embedding));

    // Honest LOO: every example is misled by its opposite-label neighbours.
    const r = evaluateProfile(examples, 0.85)!;
    expect(r.blendedAcc).toBe(0);

    // Leaky variant (self included in the vote and in counts/size): the
    // self-similarity of 1 out-votes the neighbours → a flattering 100%.
    let leakyRight = 0;
    const counts = Object.fromEntries(DRUM_CLASSES.map((c) => [c, 0])) as Record<
      DrumClass,
      number
    >;
    for (const l of labels) counts[l]++;
    examples.forEach((exm, i) => {
      const sims = normalized.map((e, j) => {
        let dot = 0;
        for (let k = 0; k < e.length; k++) dot += e[k] * normalized[i][k];
        return { sim: dot, label: labels[j] };
      });
      sims.sort((a, b) => b.sim - a.sim);
      const votes = Object.fromEntries(DRUM_CLASSES.map((c) => [c, 0])) as Record<
        DrumClass,
        number
      >;
      let total = 0;
      for (const { sim, label } of sims.slice(0, 5)) {
        const w = Math.max(0, sim) ** 4;
        votes[label] += w;
        total += w;
      }
      for (const c of DRUM_CLASSES) votes[c] /= total;
      const blended = blendProbs(exm.modelProbs!, votes, counts, examples.length, 0.85);
      let best: DrumClass = DRUM_CLASSES[0];
      for (const c of DRUM_CLASSES) if (blended[c] > blended[best]) best = c;
      if (best === exm.label) leakyRight++;
    });
    expect(leakyRight / examples.length).toBe(1);
    expect(r.blendedAcc).not.toBe(leakyRight / examples.length);
  });
});

describe('evaluateProfile — legacy examples (no modelProbs)', () => {
  it('are excluded from the test set but still vote as neighbours', () => {
    // K0 sits nearer the snare cluster than its own: LOO gets it wrong...
    const evaluable = [
      ex('kick', onCircle(50), UNIFORM), // K0, stranded between the clusters
      ex('kick', onCircle(0), UNIFORM),
      ex('kick', onCircle(5), UNIFORM),
      ex('snare', onCircle(90), UNIFORM),
      ex('snare', onCircle(95), UNIFORM),
      ex('snare', onCircle(100), UNIFORM),
    ];
    const without = evaluateProfile(evaluable, 0.85)!;
    expect(without.nEvaluable).toBe(6);
    expect(without.blendedAcc).toBeCloseTo(5 / 6);

    // ...until legacy kick voters near K0 (taught pre-modelProbs) rescue it.
    const legacy = [ex('kick', onCircle(48)), ex('kick', onCircle(51)), ex('kick', onCircle(53))];
    const withLegacy = evaluateProfile([...evaluable, ...legacy], 0.85)!;
    expect(withLegacy.nEvaluable).toBe(6); // legacy not tested
    expect(withLegacy.blendedAcc).toBe(1); // but they voted
  });
});

describe('evaluateProfile — KNN-only classes (clap/tom)', () => {
  it('global leg can never credit tom; the blended leg can once taught', () => {
    const tomProbs = [0.4, 0.3, 0.2, 0.05, 0.05]; // global argmax: kick
    const examples = [
      ex('tom', [0, 0, 1], tomProbs),
      ex('tom', [0, 0.05, 1], tomProbs),
      ex('tom', [0.05, 0, 1], tomProbs),
      ex('tom', [0, -0.05, 1], tomProbs),
      ex('tom', [-0.05, 0, 1], tomProbs), // 5 toms: LOO still leaves ≥ MIN_KNN_EXAMPLES
      ex('kick', [1, 0, 0], KICKISH),
      ex('kick', [1, 0.05, 0], KICKISH),
      ex('kick', [1, -0.05, 0], KICKISH),
      ex('kick', [0.95, 0, 0], KICKISH),
    ];
    const r = evaluateProfile(examples, 0.85)!;
    expect(r.globalAcc).toBeCloseTo(4 / 9); // only the kicks can ever be right
    expect(r.blendedAcc).toBe(1); // teaching tom is exactly what fixes this
  });
});
