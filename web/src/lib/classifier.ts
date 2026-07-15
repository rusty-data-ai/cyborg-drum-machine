// wasm-only build: skips the 26 MB WebGPU (jsep) runtime we don't use.
import * as ort from 'onnxruntime-web/wasm';
import type { ClassifiedHit, DrumClass, OnsetEvent } from './types';
import { DRUM_CLASSES, MODEL_DRUM_CLASSES } from './types';
import { KnnProfile } from './knn';
import { blendProbs } from './blend';
import { resample, fitLength } from './resample';

/**
 * Per-hit classification: ONNX model (waveform in, logits + embedding out),
 * blended with the user's KNN profile when one exists.
 *
 * The model's 5th class is 'other' (breaths, coughs, speech) — such hits are
 * rejected, as are low-confidence ones.
 */

export interface ModelMeta {
  version: string;
  classes: string[]; // DRUM_CLASSES + 'other'
  sampleRate: number;
  patchLen: number;
  patchPreS: number;
  embeddingDim: number;
}

const DEFAULT_CONFIDENCE_FLOOR = 0.4;
const DEFAULT_PROFILE_WEIGHT = 0.85;

export interface ClassifierCall {
  drum: DrumClass;
  confidence: number;
  probs: Record<DrumClass, number>;
}

export class HitClassifier {
  private session: ort.InferenceSession | null = null;
  private meta: ModelMeta | null = null;
  readonly profile = new KnnProfile();
  /** Blended confidence below this → hit rejected. Settings-tunable. */
  confidenceFloor = DEFAULT_CONFIDENCE_FLOOR;
  /** Cap on the KNN blend weight ("trust my profile"). Settings-tunable. */
  profileWeight = DEFAULT_PROFILE_WEIGHT;

  get ready(): boolean {
    return this.session !== null;
  }

  get modelVersion(): string {
    return this.meta?.version ?? 'unknown';
  }

  async load(baseUrl = '/models'): Promise<void> {
    ort.env.wasm.numThreads = 1; // tiny model: threads buy nothing, SAB costs COOP/COEP
    const metaRes = await fetch(`${baseUrl}/beatbox.json`);
    this.meta = (await metaRes.json()) as ModelMeta;
    this.session = await ort.InferenceSession.create(`${baseUrl}/beatbox.onnx`, {
      executionProviders: ['wasm'],
    });
    await this.profile.load(this.meta.version);
    // Warm up: first run pays JIT/init cost.
    await this.infer(new Float32Array(this.meta.patchLen));
  }

  /** Raw model call on an already-prepared patch (16 kHz, patchLen samples). */
  async infer(patch: Float32Array): Promise<{ probs: number[]; embedding: Float32Array }> {
    if (!this.session || !this.meta) throw new Error('classifier not loaded');
    const input = new ort.Tensor('float32', patch, [1, this.meta.patchLen]);
    const out = await this.session.run({ waveform: input });
    const logits = out.logits.data as Float32Array;
    const embedding = new Float32Array(out.embedding.data as Float32Array);
    return { probs: softmax(Array.from(logits)), embedding };
  }

  /** Prepare a raw mic segment: resample to model rate, fix length, peak-cap. */
  preparePatch(pcm: Float32Array, sourceRate: number): Float32Array {
    if (!this.meta) throw new Error('classifier not loaded');
    const wave = fitLength(resample(pcm, sourceRate, this.meta.sampleRate), this.meta.patchLen);
    // Mirror training normalization: scale so peak is 0.8, but never amplify.
    let peak = 0;
    for (let i = 0; i < wave.length; i++) peak = Math.max(peak, Math.abs(wave[i]));
    if (peak > 0.8) {
      const s = 0.8 / peak;
      for (let i = 0; i < wave.length; i++) wave[i] *= s;
    }
    return wave;
  }

  /**
   * Blend + rejection on already-computed model outputs; stores nothing.
   * Returns null when the hit would be rejected ('other' wins, or blended
   * confidence below the floor). Used by classify() and by the teach flow's
   * live feedback / test mode.
   */
  decide(probs: number[], embedding: Float32Array): ClassifierCall | null {
    const blended = blendProbs(
      probs,
      this.profile.classify(embedding),
      this.profile.countsByClass(),
      this.profile.size,
      this.profileWeight,
    );

    // Rejection: 'other' judged on the *global* model only (KNN has no other class).
    const otherProb = probs[MODEL_DRUM_CLASSES.length] ?? 0;
    if (otherProb > 0.5) return null;

    let best: DrumClass = 'kick';
    for (const c of DRUM_CLASSES) if (blended[c] > blended[best]) best = c;
    if (blended[best] < this.confidenceFloor) return null;

    return { drum: best, confidence: blended[best], probs: blended };
  }

  /** Classify a mic segment. Returns null when the hit is rejected. */
  async classify(
    onset: OnsetEvent,
    pcm: Float32Array,
    sourceRate: number,
  ): Promise<ClassifiedHit | null> {
    const patch = this.preparePatch(pcm, sourceRate);
    const { probs, embedding } = await this.infer(patch);
    const call = this.decide(probs, embedding);
    if (!call) return null;
    return { ...onset, ...call, embedding };
  }
}

function softmax(logits: number[]): number[] {
  const m = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - m));
  const s = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / s);
}
