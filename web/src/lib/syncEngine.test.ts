import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserExample } from './knn';
import type { PullResult, PushResult, WireExample } from './syncApi';
import {
  DEFAULT_DEBOUNCE_MS,
  exampleToWire,
  loadTombstones,
  saveTombstones,
  SyncEngine,
  type SyncStatus,
} from './syncEngine';

function memStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

function local(uuid: string, label = 'kick', seed = 1): UserExample {
  return {
    id: seed,
    uuid,
    label: label as UserExample['label'],
    embedding: Float32Array.from([seed, seed + 1, seed + 2]),
    modelVersion: 'v2',
    createdAt: 1000 + seed,
  };
}

function wire(uuid: string, label = 'snare', seed = 50): WireExample {
  return {
    uuid,
    label: label as WireExample['label'],
    embedding: [seed, seed + 1, seed + 2],
    createdAt: 1000 + seed,
  };
}

interface Harness {
  engine: SyncEngine;
  storage: Storage;
  locals: UserExample[];
  imported: WireExample[][];
  removed: string[][];
  pushes: { modelVersion: string; upserts: WireExample[]; deletes: string[] }[];
  statuses: SyncStatus[];
  pullResult: PullResult;
  pushResult: PushResult;
}

function makeHarness(locals: UserExample[]): Harness {
  const h = {
    storage: memStorage(),
    locals,
    imported: [] as WireExample[][],
    removed: [] as string[][],
    pushes: [] as Harness['pushes'],
    statuses: [] as SyncStatus[],
    pullResult: { examples: [], tombstones: [] } as PullResult,
    pushResult: { ok: true, total: 0 } as PushResult,
  } as Harness;
  const engine = new SyncEngine({
    api: {
      pull: () => Promise.resolve(h.pullResult),
      push: (modelVersion, upserts, deletes) => {
        h.pushes.push({ modelVersion, upserts, deletes });
        return Promise.resolve(h.pushResult);
      },
    },
    modelVersion: () => 'v2',
    listLocal: () => h.locals,
    importLocal: (examples) => {
      h.imported.push(examples);
      return Promise.resolve();
    },
    removeLocalByUuids: (uuids) => {
      h.removed.push(uuids);
      h.locals = h.locals.filter((e) => !uuids.includes(e.uuid!));
      return Promise.resolve();
    },
    onStatus: (s) => h.statuses.push(s),
    storage: h.storage,
  });
  h.engine = engine;
  return h;
}

describe('exampleToWire', () => {
  it('converts and drops uuid-less rows', () => {
    const e = local('u1');
    expect(exampleToWire(e)).toEqual({
      uuid: 'u1',
      label: 'kick',
      embedding: [1, 2, 3],
      createdAt: 1001,
    });
    expect(exampleToWire({ ...e, uuid: undefined })).toBeNull();
  });
});

describe('tombstone store', () => {
  it('round-trips, dedups via recordTombstones, and survives junk', () => {
    const storage = memStorage();
    saveTombstones(['a', 'b'], storage);
    expect(loadTombstones(storage)).toEqual(['a', 'b']);
    storage.setItem('beatbox-sync-tombstones', 'not json');
    expect(loadTombstones(storage)).toEqual([]);
  });

  it('recordTombstones merges without duplicates', () => {
    const h = makeHarness([]);
    h.engine.recordTombstones(['a']);
    h.engine.recordTombstones(['a', 'b']);
    expect(loadTombstones(h.storage)).toEqual(['a', 'b']);
  });
});

describe('pullOnce', () => {
  it('imports unseen server examples and removes server-tombstoned local rows', async () => {
    const h = makeHarness([local('keep', 'kick', 1), local('dead', 'snare', 2)]);
    h.pullResult = {
      examples: [wire('new-1'), { ...wire('keep-copy'), embedding: [1, 2, 3], label: 'kick' }],
      tombstones: ['dead'],
    };
    await h.engine.pullOnce();
    expect(h.removed).toEqual([['dead']]);
    // 'keep-copy' has the same label+embedding bytes as local 'keep' → deduped.
    expect(h.imported).toEqual([[h.pullResult.examples[0]]]);
    expect(h.statuses.at(-1)).toEqual({ state: 'synced' });
  });

  it('does not resurrect examples this device deleted (pending tombstones)', async () => {
    const h = makeHarness([]);
    h.engine.recordTombstones(['deleted-here']);
    h.pullResult = { examples: [wire('deleted-here'), wire('fresh')], tombstones: [] };
    await h.engine.pullOnce();
    expect(h.imported).toEqual([[h.pullResult.examples[1]]]);
  });

  it('reports errors without touching local data', async () => {
    const h = makeHarness([local('a')]);
    h.engine = new SyncEngine({
      api: {
        pull: () => Promise.reject(new Error('offline')),
        push: () => Promise.resolve({ ok: true }),
      },
      modelVersion: () => 'v2',
      listLocal: () => h.locals,
      importLocal: () => Promise.reject(new Error('should not import')),
      removeLocalByUuids: () => Promise.reject(new Error('should not remove')),
      onStatus: (s) => h.statuses.push(s),
      storage: h.storage,
    });
    await h.engine.pullOnce();
    expect(h.statuses.at(-1)).toEqual({ state: 'error', detail: 'offline' });
  });
});

describe('push', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces schedulePush into a single batch after ~10 s', async () => {
    const h = makeHarness([local('a')]);
    h.engine.schedulePush();
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS - 1000);
    h.engine.schedulePush(); // restart the timer — still no push
    expect(h.pushes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS + 10);
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0].upserts.map((u) => u.uuid)).toEqual(['a']);
  });

  it('pushNow sends locals + pending tombstones and clears confirmed tombstones', async () => {
    const h = makeHarness([local('a')]);
    h.engine.recordTombstones(['gone-1', 'gone-2']);
    await h.engine.pushNow();
    expect(h.pushes[0]).toMatchObject({
      modelVersion: 'v2',
      deletes: ['gone-1', 'gone-2'],
    });
    expect(loadTombstones(h.storage)).toEqual([]);
    expect(h.statuses.at(-1)).toEqual({ state: 'synced' });
  });

  it('keeps tombstones for retry when the push fails', async () => {
    const h = makeHarness([local('a')]);
    h.engine.recordTombstones(['gone']);
    h.pushResult = { ok: false, error: 'profile full (cap 1000 examples)' };
    await h.engine.pushNow();
    expect(loadTombstones(h.storage)).toEqual(['gone']);
    expect(h.statuses.at(-1)).toEqual({
      state: 'error',
      detail: 'profile full (cap 1000 examples)',
    });
  });

  it('skips rows without uuids instead of failing', async () => {
    const h = makeHarness([local('a'), { ...local('b', 'snare', 2), uuid: undefined }]);
    await h.engine.pushNow();
    expect(h.pushes[0].upserts.map((u) => u.uuid)).toEqual(['a']);
  });
});
