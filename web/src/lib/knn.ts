import type { DrumClass } from './types';
import { DRUM_CLASSES } from './types';

/**
 * Cosine KNN over user-recorded example embeddings — the personalization layer.
 * Examples persist in IndexedDB keyed by model version (a model change invalidates
 * stored embeddings, since they come from a different space).
 */

export interface UserExample {
  id: number;
  label: DrumClass;
  embedding: Float32Array;
  modelVersion: string;
  createdAt: number;
}

const DB_NAME = 'beatbox';
const STORE = 'examples';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export class KnnProfile {
  private examples: UserExample[] = [];
  private normalized: Float32Array[] = [];
  readonly k = 5;

  get size(): number {
    return this.examples.length;
  }

  countsByClass(): Record<DrumClass, number> {
    const counts = Object.fromEntries(DRUM_CLASSES.map((c) => [c, 0])) as Record<
      DrumClass,
      number
    >;
    for (const e of this.examples) counts[e.label]++;
    return counts;
  }

  list(): readonly UserExample[] {
    return this.examples;
  }

  async load(modelVersion: string): Promise<void> {
    const db = await openDb();
    const all = await new Promise<UserExample[]>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as UserExample[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    this.examples = all
      .filter((e) => e.modelVersion === modelVersion)
      .map((e) => ({ ...e, embedding: new Float32Array(e.embedding) }));
    this.normalized = this.examples.map((e) => normalize(e.embedding));
  }

  async add(label: DrumClass, embedding: Float32Array, modelVersion: string): Promise<void> {
    const example: Omit<UserExample, 'id'> = {
      label,
      // Store as plain array for structured-clone friendliness across browsers.
      embedding: Array.from(embedding) as unknown as Float32Array,
      modelVersion,
      createdAt: Date.now(),
    };
    const db = await openDb();
    const id = await new Promise<number>((resolve, reject) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).add(example);
      req.onsuccess = () => resolve(req.result as number);
      req.onerror = () => reject(req.error);
    });
    db.close();
    const stored = { ...example, id, embedding: new Float32Array(embedding) };
    this.examples.push(stored);
    this.normalized.push(normalize(stored.embedding));
  }

  async remove(id: number): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    db.close();
    const idx = this.examples.findIndex((e) => e.id === id);
    if (idx >= 0) {
      this.examples.splice(idx, 1);
      this.normalized.splice(idx, 1);
    }
  }

  async clear(): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    db.close();
    this.examples = [];
    this.normalized = [];
  }

  /** Distance-weighted k-nearest vote. Returns null with no examples. */
  classify(embedding: Float32Array): Record<DrumClass, number> | null {
    if (this.examples.length === 0) return null;
    const q = normalize(embedding);
    const sims = this.normalized.map((e, i) => {
      let dot = 0;
      for (let j = 0; j < q.length; j++) dot += q[j] * e[j];
      return { sim: dot, label: this.examples[i].label };
    });
    sims.sort((a, b) => b.sim - a.sim);
    const top = sims.slice(0, Math.min(this.k, sims.length));
    const votes = Object.fromEntries(DRUM_CLASSES.map((c) => [c, 0])) as Record<
      DrumClass,
      number
    >;
    let total = 0;
    for (const { sim, label } of top) {
      const wgt = Math.max(0, sim) ** 4; // sharpen: near neighbours dominate
      votes[label] += wgt;
      total += wgt;
    }
    if (total <= 0) return null;
    for (const c of DRUM_CLASSES) votes[c] /= total;
    return votes;
  }
}
