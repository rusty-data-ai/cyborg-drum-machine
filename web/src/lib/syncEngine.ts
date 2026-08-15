import type { UserExample } from './knn';
import { planMerge } from './profileFile';
import type { SyncApi, WireExample } from './syncApi';

/**
 * Examples sync engine (accounts plan §3): pull once on load, push on change
 * debounced ~10 s, IndexedDB stays the source of truth — the app never blocks
 * on the network. Merge is union-by-uuid with tombstones; deletions made on
 * this device are remembered in localStorage until a push confirms them.
 */

const TOMBSTONE_KEY = 'beatbox-sync-tombstones';
const MAX_TOMBSTONES = 2000;
export const DEFAULT_DEBOUNCE_MS = 10_000;

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'synced' | 'error';
  detail?: string;
}

export interface SyncEngineDeps {
  api: Pick<SyncApi, 'pull' | 'push'>;
  modelVersion: () => string;
  /** Current local profile (source of truth). */
  listLocal: () => readonly UserExample[];
  /** Write server examples into IndexedDB (KnnProfile.importExamples). */
  importLocal: (examples: WireExample[], modelVersion: string) => Promise<void>;
  /** Remove local rows whose uuid the server has tombstoned. */
  removeLocalByUuids: (uuids: string[]) => Promise<void>;
  onStatus?: (status: SyncStatus) => void;
  storage?: Storage;
  debounceMs?: number;
}

export function exampleToWire(e: UserExample): WireExample | null {
  if (!e.uuid) return null;
  return {
    uuid: e.uuid,
    label: e.label,
    embedding: Array.from(e.embedding),
    ...(e.modelProbs ? { modelProbs: [...e.modelProbs] } : {}),
    createdAt: e.createdAt,
  };
}

export function loadTombstones(storage?: Storage): string[] {
  try {
    const raw = storage?.getItem(TOMBSTONE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

export function saveTombstones(uuids: string[], storage?: Storage): void {
  try {
    storage?.setItem(TOMBSTONE_KEY, JSON.stringify(uuids.slice(-MAX_TOMBSTONES)));
  } catch {
    // storage full/blocked — tombstones simply won't survive a reload
  }
}

export class SyncEngine {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pushing = false;
  private deps: SyncEngineDeps;

  constructor(deps: SyncEngineDeps) {
    this.deps = deps;
  }

  private get storage(): Storage | undefined {
    return this.deps.storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  }

  private status(s: SyncStatus): void {
    this.deps.onStatus?.(s);
  }

  /** Remember deletions so they win on other devices too (plan §3). */
  recordTombstones(uuids: string[]): void {
    if (uuids.length === 0) return;
    const cur = loadTombstones(this.storage);
    const merged = [...new Set([...cur, ...uuids])];
    saveTombstones(merged, this.storage);
  }

  /**
   * Pull the server state and reconcile into IndexedDB: server tombstones
   * remove local rows; unseen server examples are imported (uuid + content
   * dedup via planMerge); rows this device deleted stay deleted.
   */
  async pullOnce(): Promise<void> {
    this.status({ state: 'syncing' });
    try {
      const modelVersion = this.deps.modelVersion();
      const { examples, tombstones } = await this.deps.api.pull(modelVersion);
      const dead = new Set([...tombstones, ...loadTombstones(this.storage)]);
      const localDead = this.deps
        .listLocal()
        .filter((e) => e.uuid && tombstones.includes(e.uuid))
        .map((e) => e.uuid!);
      if (localDead.length > 0) await this.deps.removeLocalByUuids(localDead);
      const incoming = examples.filter((e) => !dead.has(e.uuid));
      const plan = planMerge(this.deps.listLocal(), incoming);
      if (plan.toAdd.length > 0) {
        await this.deps.importLocal(plan.toAdd as WireExample[], modelVersion);
      }
      this.status({ state: 'synced' });
    } catch (err) {
      this.status({ state: 'error', detail: err instanceof Error ? err.message : 'sync failed' });
    }
  }

  /** Debounced push — a teach session lands as one batch, not per capture. */
  schedulePush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pushNow();
    }, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  /**
   * Push everything local (idempotent server-side: union by uuid) plus pending
   * tombstones; confirmed tombstones are dropped from the retry list.
   */
  async pushNow(): Promise<void> {
    if (this.pushing) {
      this.schedulePush(); // try again after the in-flight push
      return;
    }
    this.pushing = true;
    this.status({ state: 'syncing' });
    try {
      const deletes = loadTombstones(this.storage);
      const upserts = this.deps
        .listLocal()
        .map(exampleToWire)
        .filter((e): e is WireExample => e !== null);
      const res = await this.deps.api.push(this.deps.modelVersion(), upserts, deletes);
      if (!res.ok) {
        this.status({ state: 'error', detail: res.error ?? 'push rejected' });
        return;
      }
      // Only drop the tombstones we actually sent; new ones may have arrived.
      const sent = new Set(deletes);
      saveTombstones(
        loadTombstones(this.storage).filter((u) => !sent.has(u)),
        this.storage,
      );
      this.status({ state: 'synced' });
    } catch (err) {
      this.status({ state: 'error', detail: err instanceof Error ? err.message : 'sync failed' });
    } finally {
      this.pushing = false;
    }
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
