/**
 * Wire-format validation + BLOB codecs. The JSON example shape matches the
 * Phase 0 profile file (web/src/lib/profileFile.ts) — that file format is the
 * sync/export wire format, versioned there as formatVersion 1. Embeddings
 * travel as JSON numbers but are stored as float32 LE BLOBs (512 B vs ~1 KB;
 * plan §6).
 */

/** Mirrors web/src/lib/types.ts DRUM_CLASSES (worker is a separate package). */
export const DRUM_CLASSES = ['kick', 'snare', 'hihat_closed', 'hihat_open', 'clap', 'tom'] as const;

export interface WireExample {
  uuid: string;
  label: string;
  embedding: number[];
  modelProbs?: number[];
  createdAt: number;
}

const MAX_EMBEDDING_DIM = 4096;
const MAX_PROBS_LEN = 64;

export function validateWireExample(v: unknown): WireExample | null {
  if (typeof v !== 'object' || v === null) return null;
  const e = v as Record<string, unknown>;
  if (typeof e.uuid !== 'string' || e.uuid.length === 0 || e.uuid.length > 64) return null;
  if (!(DRUM_CLASSES as readonly string[]).includes(e.label as string)) return null;
  if (!isFiniteNumberArray(e.embedding, MAX_EMBEDDING_DIM)) return null;
  if (e.modelProbs !== undefined && !isFiniteNumberArray(e.modelProbs, MAX_PROBS_LEN)) return null;
  if (typeof e.createdAt !== 'number' || !Number.isFinite(e.createdAt)) return null;
  return {
    uuid: e.uuid,
    label: e.label as string,
    embedding: e.embedding as number[],
    ...(e.modelProbs !== undefined ? { modelProbs: e.modelProbs as number[] } : {}),
    createdAt: e.createdAt,
  };
}

export function isUuidList(v: unknown, maxLen: number): v is string[] {
  return (
    Array.isArray(v) &&
    v.length <= maxLen &&
    v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 64)
  );
}

export function f32ToBlob(nums: readonly number[]): ArrayBuffer {
  return Float32Array.from(nums).buffer as ArrayBuffer;
}

/** D1 has returned BLOBs as ArrayBuffer or number[] across versions — take both. */
export function blobToF32(blob: unknown): number[] {
  if (blob instanceof ArrayBuffer) return Array.from(new Float32Array(blob));
  if (ArrayBuffer.isView(blob)) {
    const u8 = new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
    return Array.from(new Float32Array(u8.slice().buffer));
  }
  if (Array.isArray(blob)) {
    return Array.from(new Float32Array(Uint8Array.from(blob as number[]).buffer));
  }
  throw new Error('unexpected BLOB representation');
}

function isFiniteNumberArray(v: unknown, maxLen: number): v is number[] {
  return (
    Array.isArray(v) && v.length > 0 && v.length <= maxLen && v.every((x) => Number.isFinite(x))
  );
}
