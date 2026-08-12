import type { DrumClass } from './types';

/**
 * Thin fetch client for the worker API (worker/src/index.ts). Cookie-based
 * sessions ride along automatically — the worker is same-origin by design
 * (plan §1: SameSite=Lax). Every method either resolves or throws; 401 is
 * mapped to null/false rather than thrown so "signed out" isn't an error.
 */

export interface SyncUser {
  id: string;
  provider: string;
  email: string | null;
}

/** Same example shape as the Phase 0 profile file (the sync wire format). */
export interface WireExample {
  uuid: string;
  label: DrumClass;
  embedding: number[];
  modelProbs?: number[];
  createdAt: number;
}

export interface PullResult {
  examples: WireExample[];
  tombstones: string[];
}

export interface PushResult {
  ok: boolean;
  error?: string;
  total?: number;
}

export class SyncApi {
  readonly base: string;
  private fetchFn: typeof fetch;

  constructor(base: string, fetchFn: typeof fetch = (...args) => fetch(...args)) {
    this.base = base;
    this.fetchFn = fetchFn;
  }

  signInUrl(provider: 'google' | 'github'): string {
    return `${this.base}/auth/${provider}/start`;
  }

  exportUrl(): string {
    return `${this.base}/export`;
  }

  /** null = signed out (or worker unreachable — treated the same by the UI). */
  async me(): Promise<SyncUser | null> {
    try {
      const res = await this.fetchFn(`${this.base}/me`, { credentials: 'include' });
      if (!res.ok) return null;
      const body = (await res.json()) as { user: SyncUser | null };
      return body.user;
    } catch {
      return null;
    }
  }

  async signOut(): Promise<void> {
    await this.fetchFn(`${this.base}/auth/signout`, {
      method: 'POST',
      credentials: 'include',
    });
  }

  async pull(modelVersion: string): Promise<PullResult> {
    const res = await this.fetchFn(
      `${this.base}/sync/examples?modelVersion=${encodeURIComponent(modelVersion)}`,
      { credentials: 'include' },
    );
    if (!res.ok) throw new Error(`pull failed (${res.status})`);
    return (await res.json()) as PullResult;
  }

  async push(
    modelVersion: string,
    upserts: WireExample[],
    deletes: string[],
  ): Promise<PushResult> {
    const res = await this.fetchFn(`${this.base}/sync/examples`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelVersion, upserts, deletes }),
    });
    const body = (await res.json().catch(() => ({}))) as PushResult;
    if (!res.ok) return { ok: false, error: body.error ?? `push failed (${res.status})` };
    return body;
  }

  async deleteAccount(): Promise<boolean> {
    const res = await this.fetchFn(`${this.base}/account`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return res.ok;
  }
}
