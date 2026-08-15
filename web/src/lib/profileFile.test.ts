import { describe, expect, it } from 'vitest';
import type { UserExample } from './knn';
import {
  PROFILE_FORMAT_VERSION,
  encodeProfileFile,
  exampleContentKey,
  parseProfileFile,
  planMerge,
  profileFilename,
  type ProfileFileExample,
} from './profileFile';
import { DEFAULT_SETTINGS } from './settings';

function emb(seed: number): number[] {
  return Array.from({ length: 128 }, (_, i) => Math.sin(seed + i * 0.13));
}

function userExample(over: Partial<UserExample> = {}): UserExample {
  return {
    id: 1,
    uuid: 'uuid-1',
    label: 'kick',
    embedding: Float32Array.from(emb(1)),
    modelVersion: 'v2',
    createdAt: 1700000000000,
    ...over,
  };
}

function fileExample(over: Partial<ProfileFileExample> = {}): ProfileFileExample {
  return {
    uuid: 'uuid-f1',
    label: 'snare',
    embedding: emb(2),
    createdAt: 1700000001000,
    ...over,
  };
}

describe('profileFilename', () => {
  it('formats as beatbox-profile-YYYYMMDD.json', () => {
    expect(profileFilename(new Date(2026, 6, 29))).toBe('beatbox-profile-20260729.json');
    expect(profileFilename(new Date(2026, 0, 5))).toBe('beatbox-profile-20260105.json');
  });
});

describe('encode → parse round-trip', () => {
  it('preserves examples, settings, and model version', () => {
    const examples = [
      userExample({ uuid: 'a', label: 'kick', modelProbs: [0.7, 0.1, 0.1, 0.05, 0.05] }),
      userExample({ id: 2, uuid: 'b', label: 'tom', embedding: Float32Array.from(emb(3)) }),
    ];
    const settings = { ...DEFAULT_SETTINGS, kitVolume: 0.5 };
    const parsed = parseProfileFile(encodeProfileFile('v2', examples, settings));
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.file.formatVersion).toBe(PROFILE_FORMAT_VERSION);
    expect(parsed.file.modelVersion).toBe('v2');
    expect(parsed.file.examples).toHaveLength(2);
    expect(parsed.file.examples[0]).toMatchObject({
      uuid: 'a',
      label: 'kick',
      createdAt: 1700000000000,
      modelProbs: [0.7, 0.1, 0.1, 0.05, 0.05],
    });
    expect(parsed.file.examples[1].modelProbs).toBeUndefined();
    // Embeddings survive the float32 → JSON → float32 trip byte-identically.
    expect(exampleContentKey('kick', parsed.file.examples[0].embedding)).toBe(
      exampleContentKey('kick', examples[0].embedding),
    );
    expect(parsed.file.settings).toEqual(settings);
  });

  it('assigns a uuid when exporting a legacy example without one', () => {
    const legacy = userExample({ uuid: undefined });
    const parsed = parseProfileFile(encodeProfileFile('v2', [legacy], DEFAULT_SETTINGS));
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.file.examples[0].uuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('clamps out-of-range settings through the settings parser', () => {
    const raw = encodeProfileFile('v2', [], { ...DEFAULT_SETTINGS, kitVolume: 99 });
    const parsed = parseProfileFile(raw);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.file.settings?.kitVolume).toBe(1);
  });
});

describe('parseProfileFile rejection', () => {
  it('rejects non-JSON and non-objects', () => {
    expect(parseProfileFile('not json {')).toHaveProperty('error');
    expect(parseProfileFile('42')).toHaveProperty('error');
    expect(parseProfileFile('null')).toHaveProperty('error');
  });

  it('rejects unknown format versions', () => {
    const raw = JSON.stringify({ formatVersion: 2, modelVersion: 'v2', examples: [] });
    const res = parseProfileFile(raw);
    expect(res).toHaveProperty('error');
    if ('error' in res) expect(res.error).toContain('version 2');
  });

  it('rejects missing model version or examples', () => {
    expect(
      parseProfileFile(JSON.stringify({ formatVersion: 1, examples: [] })),
    ).toHaveProperty('error');
    expect(
      parseProfileFile(JSON.stringify({ formatVersion: 1, modelVersion: 'v2' })),
    ).toHaveProperty('error');
  });

  it('rejects malformed examples (bad label, bad embedding, bad createdAt)', () => {
    const base = { formatVersion: 1, modelVersion: 'v2' };
    const bad = (example: unknown) =>
      parseProfileFile(JSON.stringify({ ...base, examples: [example] }));
    expect(bad({ ...fileExample(), label: 'cowbell' })).toHaveProperty('error');
    expect(bad({ ...fileExample(), embedding: [] })).toHaveProperty('error');
    expect(bad({ ...fileExample(), embedding: [1, 'x'] })).toHaveProperty('error');
    expect(bad({ ...fileExample(), embedding: [1, Infinity] })).toHaveProperty('error');
    expect(bad({ ...fileExample(), createdAt: 'yesterday' })).toHaveProperty('error');
    expect(bad({ ...fileExample(), uuid: '' })).toHaveProperty('error');
    expect(bad({ ...fileExample(), modelProbs: ['a'] })).toHaveProperty('error');
  });

  it('tolerates a missing settings key (server exports before Phase 2)', () => {
    const raw = JSON.stringify({ formatVersion: 1, modelVersion: 'v2', examples: [] });
    const parsed = parseProfileFile(raw);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.file.settings).toBeUndefined();
  });
});

describe('planMerge', () => {
  it('adds new examples and skips uuid matches', () => {
    const existing = [userExample({ uuid: 'a' })];
    const incoming = [
      fileExample({ uuid: 'a', label: 'kick', embedding: emb(9) }), // uuid dup
      fileExample({ uuid: 'b' }),
    ];
    const plan = planMerge(existing, incoming);
    expect(plan.toAdd.map((e) => e.uuid)).toEqual(['b']);
    expect(plan.duplicates).toBe(1);
  });

  it('dedups by label + identical embedding bytes even with different uuids', () => {
    const shared = emb(5);
    const existing = [
      userExample({ uuid: 'a', label: 'clap', embedding: Float32Array.from(shared) }),
    ];
    const incoming = [
      fileExample({ uuid: 'x', label: 'clap', embedding: [...shared] }), // same content
      fileExample({ uuid: 'y', label: 'tom', embedding: [...shared] }), // other label: kept
    ];
    const plan = planMerge(existing, incoming);
    expect(plan.toAdd.map((e) => e.uuid)).toEqual(['y']);
    expect(plan.duplicates).toBe(1);
  });

  it('collapses duplicates within the incoming file itself', () => {
    const shared = emb(7);
    const incoming = [
      fileExample({ uuid: 'x', label: 'kick', embedding: [...shared] }),
      fileExample({ uuid: 'x', label: 'snare', embedding: emb(8) }), // uuid dup in-file
      fileExample({ uuid: 'z', label: 'kick', embedding: [...shared] }), // content dup in-file
    ];
    const plan = planMerge([], incoming);
    expect(plan.toAdd.map((e) => e.uuid)).toEqual(['x']);
    expect(plan.duplicates).toBe(2);
  });

  it('a full re-import of an export is a no-op', () => {
    const existing = [
      userExample({ uuid: 'a', label: 'kick' }),
      userExample({ id: 2, uuid: 'b', label: 'snare', embedding: Float32Array.from(emb(2)) }),
    ];
    const raw = encodeProfileFile('v2', existing, DEFAULT_SETTINGS);
    const parsed = parseProfileFile(raw);
    if ('error' in parsed) throw new Error(parsed.error);
    const plan = planMerge(existing, parsed.file.examples);
    expect(plan.toAdd).toEqual([]);
    expect(plan.duplicates).toBe(2);
  });

  it('re-importing a pre-uuid export (fresh uuids each time) still dedups by content', () => {
    const legacy = userExample({ uuid: undefined });
    // Two exports of the same legacy row would carry different generated uuids.
    const p1 = parseProfileFile(encodeProfileFile('v2', [legacy], DEFAULT_SETTINGS));
    const p2 = parseProfileFile(encodeProfileFile('v2', [legacy], DEFAULT_SETTINGS));
    if ('error' in p1 || 'error' in p2) throw new Error('parse failed');
    expect(p1.file.examples[0].uuid).not.toBe(p2.file.examples[0].uuid);
    const plan1 = planMerge([], p1.file.examples);
    expect(plan1.toAdd).toHaveLength(1);
    // Simulate having imported p1, then importing p2: content key matches.
    const afterFirst = [
      userExample({ uuid: p1.file.examples[0].uuid }),
    ];
    const plan2 = planMerge(afterFirst, p2.file.examples);
    expect(plan2.toAdd).toEqual([]);
    expect(plan2.duplicates).toBe(1);
  });
});
