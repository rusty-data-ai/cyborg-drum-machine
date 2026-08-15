import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { APP_ORIGIN, BASE, pull, push, signIn, wireExample } from './helpers';

const V = 'v2';

describe('examples sync', () => {
  it('requires auth', async () => {
    expect((await pull('', V)).status).toBe(401);
    expect((await push('', { modelVersion: V })).status).toBe(401);
  });

  it('push → pull round-trips examples with float32-exact embeddings', async () => {
    const cookie = await signIn('sync-1');
    const a = wireExample('uuid-a', 'kick', 1);
    const b = { ...wireExample('uuid-b', 'clap', 2), modelProbs: [0.5, 0.25, 0.125, 0.0625, 0.0625] };
    const res = await push(cookie, { modelVersion: V, upserts: [a, b] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, added: 2, deleted: 0, total: 2 });

    const got = (await (await pull(cookie, V)).json()) as {
      examples: (typeof a & { modelProbs?: number[] })[];
      tombstones: string[];
    };
    expect(got.tombstones).toEqual([]);
    expect(got.examples).toHaveLength(2);
    const gotA = got.examples.find((e) => e.uuid === 'uuid-a')!;
    expect(gotA.label).toBe('kick');
    expect(gotA.embedding).toEqual(a.embedding); // float32 in, float32 out
    expect(gotA.createdAt).toBe(a.createdAt);
    expect(gotA.modelProbs).toBeUndefined();
    const gotB = got.examples.find((e) => e.uuid === 'uuid-b')!;
    expect(gotB.modelProbs).toEqual([0.5, 0.25, 0.125, 0.0625, 0.0625]);
  });

  it('merge is union by uuid: re-pushing an existing uuid is ignored', async () => {
    const cookie = await signIn('sync-2');
    await push(cookie, { modelVersion: V, upserts: [wireExample('dup', 'kick', 1)] });
    const altered = { ...wireExample('dup', 'snare', 9), createdAt: 42 };
    const res = await push(cookie, { modelVersion: V, upserts: [altered] });
    expect((await res.json() as { added: number }).added).toBe(0);
    const got = (await (await pull(cookie, V)).json()) as {
      examples: { uuid: string; label: string; createdAt: number }[];
    };
    expect(got.examples).toHaveLength(1);
    expect(got.examples[0].label).toBe('kick'); // original row untouched
  });

  it('two devices union their uuids', async () => {
    const cookie = await signIn('sync-3');
    await push(cookie, { modelVersion: V, upserts: [wireExample('dev-a-1'), wireExample('dev-a-2')] });
    await push(cookie, { modelVersion: V, upserts: [wireExample('dev-a-2'), wireExample('dev-b-1')] });
    const got = (await (await pull(cookie, V)).json()) as { examples: { uuid: string }[] };
    expect(got.examples.map((e) => e.uuid).sort()).toEqual(['dev-a-1', 'dev-a-2', 'dev-b-1']);
  });

  it('tombstone beats live: a delete wins over a later push of the same uuid', async () => {
    const cookie = await signIn('sync-4');
    await push(cookie, { modelVersion: V, upserts: [wireExample('doomed')] });
    await push(cookie, { modelVersion: V, deletes: ['doomed'] });
    // Offline device pushes the same example again later.
    const res = await push(cookie, { modelVersion: V, upserts: [wireExample('doomed')] });
    expect((await res.json() as { added: number }).added).toBe(0);
    const got = (await (await pull(cookie, V)).json()) as {
      examples: unknown[];
      tombstones: string[];
    };
    expect(got.examples).toEqual([]);
    expect(got.tombstones).toEqual(['doomed']);
  });

  it('deleting a uuid the server never saw leaves a tombstone that still wins', async () => {
    const cookie = await signIn('sync-5');
    await push(cookie, { modelVersion: V, deletes: ['never-seen'] });
    await push(cookie, { modelVersion: V, upserts: [wireExample('never-seen')] });
    const got = (await (await pull(cookie, V)).json()) as {
      examples: unknown[];
      tombstones: string[];
    };
    expect(got.examples).toEqual([]);
    expect(got.tombstones).toEqual(['never-seen']);
  });

  it('rows are isolated per user and per model version', async () => {
    const alice = await signIn('sync-6a');
    const bob = await signIn('sync-6b');
    await push(alice, { modelVersion: V, upserts: [wireExample('alice-row')] });
    await push(bob, { modelVersion: V, upserts: [wireExample('bob-row')] });
    // Bob cannot tombstone or steal Alice's row.
    await push(bob, { modelVersion: V, deletes: ['alice-row'] });
    const aliceGot = (await (await pull(alice, V)).json()) as {
      examples: { uuid: string }[];
      tombstones: string[];
    };
    expect(aliceGot.examples.map((e) => e.uuid)).toEqual(['alice-row']);
    expect(aliceGot.tombstones).toEqual([]);
    const bobGot = (await (await pull(bob, V)).json()) as { examples: { uuid: string }[] };
    expect(bobGot.examples.map((e) => e.uuid)).toEqual(['bob-row']);
    // Model-version filtering mirrors KnnProfile.load.
    const v3 = (await (await pull(alice, 'v3')).json()) as { examples: unknown[] };
    expect(v3.examples).toEqual([]);
  });

  it('enforces the per-user example cap', async () => {
    const cookie = await signIn('sync-cap');
    const many = Array.from({ length: 1000 }, (_, i) => wireExample(`cap-${i}`, 'kick', i, 2));
    const ok = await push(cookie, { modelVersion: V, upserts: many });
    expect(ok.status).toBe(200);
    const over = await push(cookie, { modelVersion: V, upserts: [wireExample('cap-overflow')] });
    expect(over.status).toBe(409);
    expect(((await over.json()) as { error: string }).error).toContain('profile full');
    // Deleting frees room again.
    await push(cookie, { modelVersion: V, deletes: ['cap-0'] });
    const retry = await push(cookie, { modelVersion: V, upserts: [wireExample('cap-overflow')] });
    expect(retry.status).toBe(200);
  });

  it('rejects oversized payloads and malformed bodies', async () => {
    const cookie = await signIn('sync-junk');
    const big = await SELF.fetch(`${BASE}/api/sync/examples`, {
      method: 'POST',
      headers: { cookie, origin: APP_ORIGIN, 'content-type': 'application/json' },
      body: `{"modelVersion":"v2","upserts":[],"pad":"${'x'.repeat(2_100_000)}"}`,
    });
    expect(big.status).toBe(413);
    expect((await push(cookie, { upserts: [] })).status).toBe(400); // no modelVersion
    expect(
      (await push(cookie, { modelVersion: V, upserts: [{ uuid: 'x', label: 'cowbell', embedding: [1], createdAt: 1 }] }))
        .status,
    ).toBe(400);
    expect(
      (await push(cookie, { modelVersion: V, upserts: [{ uuid: 'x', label: 'kick', embedding: [], createdAt: 1 }] }))
        .status,
    ).toBe(400);
    expect((await push(cookie, { modelVersion: V, deletes: [42] })).status).toBe(400);
  });
});

describe('export', () => {
  it('serves everything as a Phase 0 profile file, newest model version primary', async () => {
    const cookie = await signIn('export-1');
    await push(cookie, { modelVersion: 'v2', upserts: [{ ...wireExample('old-1'), createdAt: 100 }] });
    await push(cookie, {
      modelVersion: 'v3',
      upserts: [
        { ...wireExample('new-1'), createdAt: 200 },
        { ...wireExample('new-dead'), createdAt: 201 },
      ],
    });
    await push(cookie, { modelVersion: 'v3', deletes: ['new-dead'] });
    const res = await SELF.fetch(`${BASE}/api/export`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(
      /attachment; filename="beatbox-profile-\d{8}\.json"/,
    );
    const file = (await res.json()) as {
      formatVersion: number;
      modelVersion: string;
      examples: { uuid: string }[];
      otherVersions: Record<string, { uuid: string }[]>;
    };
    expect(file.formatVersion).toBe(1);
    expect(file.modelVersion).toBe('v3');
    expect(file.examples.map((e) => e.uuid)).toEqual(['new-1']); // tombstones don't export
    expect(Object.keys(file.otherVersions)).toEqual(['v2']);
    expect(file.otherVersions.v2.map((e) => e.uuid)).toEqual(['old-1']);
  });

  it('exports an empty file for a fresh account', async () => {
    const cookie = await signIn('export-2');
    const file = (await (await SELF.fetch(`${BASE}/api/export`, { headers: { cookie } })).json()) as {
      formatVersion: number;
      examples: unknown[];
    };
    expect(file.formatVersion).toBe(1);
    expect(file.examples).toEqual([]);
  });
});

describe('account deletion', () => {
  it('deletes every row transactionally, tombstones included, and only for that user', async () => {
    const doomed = await signIn('del-1', 'doomed@example.com');
    const bystander = await signIn('del-2', 'bystander@example.com');
    await push(doomed, { modelVersion: V, upserts: [wireExample('d-live')] });
    await push(doomed, { modelVersion: V, deletes: ['d-dead'] });
    await push(bystander, { modelVersion: V, upserts: [wireExample('b-live')] });

    const userId = (
      (await (await SELF.fetch(`${BASE}/api/me`, { headers: { cookie: doomed } })).json()) as {
        user: { id: string };
      }
    ).user.id;
    const res = await SELF.fetch(`${BASE}/api/account`, {
      method: 'DELETE',
      headers: { cookie: doomed, origin: APP_ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('session=;');

    // Every trace is gone: user, sessions, examples (incl. tombstones).
    for (const [table, col] of [
      ['users', 'id'],
      ['sessions', 'user_id'],
      ['examples', 'user_id'],
      ['settings', 'user_id'],
      ['beats', 'user_id'],
    ] as const) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`)
        .bind(userId)
        .first<{ n: number }>();
      expect(row!.n).toBe(0);
    }
    expect((await SELF.fetch(`${BASE}/api/me`, { headers: { cookie: doomed } })).status).toBe(401);
    // The bystander's data is untouched.
    const b = (await (await pull(bystander, V)).json()) as { examples: { uuid: string }[] };
    expect(b.examples.map((e) => e.uuid)).toEqual(['b-live']);
  });
});
