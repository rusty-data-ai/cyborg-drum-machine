import type { UserExample } from './knn';
import { parseSettings, type AppSettings } from './settings';
import type { DrumClass } from './types';
import { DRUM_CLASSES } from './types';
import { newUuid } from './uuid';

/**
 * Profile file codec + merge logic (accounts plan Phase 0, docs/accounts-plan.md §7).
 *
 * `beatbox-profile-YYYYMMDD.json` is the backup/transfer format *and* the future
 * sync/export wire format, so it is versioned from day one: any change to the
 * meaning of existing fields bumps `formatVersion`, and parsing rejects versions
 * it doesn't know rather than half-reading them.
 *
 * Pure module — no DOM, no IndexedDB — so codec and merge are unit-testable.
 */

export const PROFILE_FORMAT_VERSION = 1;

export interface ProfileFileExample {
  uuid: string;
  label: DrumClass;
  /** 128-d embedding as plain numbers (JSON). Stored/compared as float32. */
  embedding: number[];
  /** Global-model softmax captured at teach time; absent on legacy rows. */
  modelProbs?: number[];
  createdAt: number;
}

export interface ProfileFile {
  formatVersion: number;
  modelVersion: string;
  examples: ProfileFileExample[];
  /** Absent in server exports before settings sync ships (Phase 2). */
  settings?: AppSettings;
  /** Reserved for Phase 2 (saved beats: {uuid, name, payload, createdAt}). */
  beats?: unknown[];
}

/** `beatbox-profile-YYYYMMDD.json` (local date — it names a user-facing file). */
export function profileFilename(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `beatbox-profile-${y}${m}${day}.json`;
}

/** Serialize the loaded profile + settings. Examples lacking a uuid get one. */
export function encodeProfileFile(
  modelVersion: string,
  examples: readonly UserExample[],
  settings: AppSettings,
): string {
  const file: ProfileFile = {
    formatVersion: PROFILE_FORMAT_VERSION,
    modelVersion,
    examples: examples.map((e) => ({
      uuid: e.uuid ?? newUuid(),
      label: e.label,
      embedding: Array.from(e.embedding),
      ...(e.modelProbs ? { modelProbs: [...e.modelProbs] } : {}),
      createdAt: e.createdAt,
    })),
    settings,
  };
  return JSON.stringify(file);
}

const MAX_EMBEDDING_DIM = 4096;

function isFiniteNumberArray(v: unknown, maxLen: number): v is number[] {
  return (
    Array.isArray(v) && v.length > 0 && v.length <= maxLen && v.every((x) => Number.isFinite(x))
  );
}

/**
 * Strict parse: returns the file or a human-readable error. Unknown top-level
 * keys are ignored (forward compatibility); unknown formatVersions, unknown
 * labels, or malformed examples reject the whole file — a backup restore
 * should never half-succeed silently.
 */
export function parseProfileFile(raw: string): { file: ProfileFile } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: 'not a JSON file' };
  }
  if (typeof data !== 'object' || data === null) return { error: 'not a profile file' };
  const obj = data as Record<string, unknown>;
  if (obj.formatVersion !== PROFILE_FORMAT_VERSION) {
    return { error: `unsupported profile format (version ${String(obj.formatVersion)})` };
  }
  if (typeof obj.modelVersion !== 'string' || obj.modelVersion.length === 0) {
    return { error: 'missing model version' };
  }
  if (!Array.isArray(obj.examples)) return { error: 'missing examples' };
  const examples: ProfileFileExample[] = [];
  for (const e of obj.examples) {
    if (typeof e !== 'object' || e === null) return { error: 'malformed example' };
    const ex = e as Record<string, unknown>;
    if (typeof ex.uuid !== 'string' || ex.uuid.length === 0 || ex.uuid.length > 64) {
      return { error: 'malformed example (uuid)' };
    }
    if (!(DRUM_CLASSES as readonly string[]).includes(ex.label as string)) {
      return { error: `unknown drum label ${JSON.stringify(ex.label)}` };
    }
    if (!isFiniteNumberArray(ex.embedding, MAX_EMBEDDING_DIM)) {
      return { error: 'malformed example (embedding)' };
    }
    if (ex.modelProbs !== undefined && !isFiniteNumberArray(ex.modelProbs, 64)) {
      return { error: 'malformed example (modelProbs)' };
    }
    if (typeof ex.createdAt !== 'number' || !Number.isFinite(ex.createdAt)) {
      return { error: 'malformed example (createdAt)' };
    }
    examples.push({
      uuid: ex.uuid,
      label: ex.label as DrumClass,
      embedding: ex.embedding as number[],
      ...(ex.modelProbs !== undefined ? { modelProbs: ex.modelProbs as number[] } : {}),
      createdAt: ex.createdAt,
    });
  }
  const file: ProfileFile = {
    formatVersion: PROFILE_FORMAT_VERSION,
    modelVersion: obj.modelVersion,
    examples,
  };
  if (obj.settings !== undefined) {
    // Reuse the settings parser: unknown keys ignored, bad values → defaults, clamped.
    file.settings = parseSettings(JSON.stringify(obj.settings));
  }
  return { file };
}

/**
 * Content identity for dedup (plan §5): same label + identical embedding
 * *bytes* = one row. Both sides go through float32, so a JSON round-trip of a
 * stored Float32Array compares equal. No fuzzy dedup in v1.
 */
export function exampleContentKey(label: string, embedding: ArrayLike<number>): string {
  const f32 = embedding instanceof Float32Array ? embedding : Float32Array.from(embedding);
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return `${label}:${s}`;
}

export interface MergePlan {
  /** Incoming examples that are genuinely new (not present by uuid or content). */
  toAdd: ProfileFileExample[];
  /** Incoming examples skipped as duplicates (by uuid or label+embedding bytes). */
  duplicates: number;
}

/**
 * Merge = union by uuid, plus content dedup: an incoming example is skipped if
 * its uuid already exists locally *or* an example with the same label and
 * identical embedding bytes does (covers re-importing an export made before
 * uuids existed, and importing the same file twice). Also collapses duplicates
 * within the incoming file itself.
 */
export function planMerge(
  existing: readonly UserExample[],
  incoming: readonly ProfileFileExample[],
): MergePlan {
  const uuids = new Set<string>();
  const contents = new Set<string>();
  for (const e of existing) {
    if (e.uuid) uuids.add(e.uuid);
    contents.add(exampleContentKey(e.label, e.embedding));
  }
  const toAdd: ProfileFileExample[] = [];
  let duplicates = 0;
  for (const e of incoming) {
    const key = exampleContentKey(e.label, e.embedding);
    if (uuids.has(e.uuid) || contents.has(key)) {
      duplicates++;
      continue;
    }
    uuids.add(e.uuid);
    contents.add(key);
    toAdd.push(e);
  }
  return { toAdd, duplicates };
}
