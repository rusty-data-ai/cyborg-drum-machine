import { SELF } from 'cloudflare:test';
import { expect } from 'vitest';

export const BASE = 'https://app.local';
/** Matches APP_ORIGIN in wrangler.toml [vars] (tests inherit it). */
export const APP_ORIGIN = 'http://localhost:5173';

/** Complete the fake-provider OAuth dance; returns the session Cookie value. */
export async function signIn(
  providerId = 'alice',
  email: string | null = 'alice@example.com',
  provider: 'google' | 'github' = 'google',
): Promise<string> {
  const start = await SELF.fetch(`${BASE}/api/auth/${provider}/start`, { redirect: 'manual' });
  expect(start.status).toBe(302);
  const stateSet = start.headers.get('set-cookie') ?? '';
  const state = /oauth_state=([^;]+)/.exec(stateSet)?.[1];
  expect(state).toBeTruthy();
  const code = email === null ? `fake:${providerId}` : `fake:${providerId}:${email}`;
  const cb = await SELF.fetch(
    `${BASE}/api/auth/${provider}/callback?code=${encodeURIComponent(code)}&state=${state}`,
    { headers: { cookie: `oauth_state=${state}` }, redirect: 'manual' },
  );
  expect(cb.status).toBe(302);
  expect(cb.headers.get('location')).toBe(`${APP_ORIGIN}/`);
  const session = getSetCookies(cb.headers)
    .map((c) => /^session=([^;]+)/.exec(c)?.[1])
    .find((v) => v && v.length > 0);
  expect(session).toBeTruthy();
  return `session=${session}`;
}

/** Headers.getSetCookie exists in workerd; workers-types 4.x lacks the type. */
export function getSetCookies(headers: Headers): string[] {
  return (headers as Headers & { getSetCookie(): string[] }).getSetCookie();
}

export function wireExample(
  uuid: string,
  label = 'kick',
  seed = 1,
  dims = 8,
): { uuid: string; label: string; embedding: number[]; createdAt: number } {
  return {
    uuid,
    label,
    embedding: Array.from({ length: dims }, (_, i) => Math.fround(Math.sin(seed + i))),
    createdAt: 1700000000000 + seed,
  };
}

export async function push(
  cookie: string,
  body: unknown,
  origin: string | null = APP_ORIGIN,
): Promise<Response> {
  return SELF.fetch(`${BASE}/api/sync/examples`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      ...(origin !== null ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

export async function pull(cookie: string, modelVersion: string): Promise<Response> {
  return SELF.fetch(`${BASE}/api/sync/examples?modelVersion=${modelVersion}`, {
    headers: { cookie },
  });
}
