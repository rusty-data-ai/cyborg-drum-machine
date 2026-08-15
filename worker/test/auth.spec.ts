import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { APP_ORIGIN, BASE, getSetCookies, signIn } from './helpers';

describe('health', () => {
  it('responds without auth', async () => {
    const res = await SELF.fetch(`${BASE}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

describe('OAuth sign-in (fake provider, real routing/sessions/D1)', () => {
  it('start redirects to the provider with a state cookie', async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/google/start`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc).toContain('fake-oauth.invalid/google/authorize');
    expect(loc).toContain(encodeURIComponent(`${BASE}/api/auth/google/callback`));
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^oauth_state=[0-9a-f]{32}/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    // https origin → Secure attribute present.
    expect(cookie).toContain('Secure');
  });

  it('unknown provider path 404s', async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/facebook/start`, { redirect: 'manual' });
    expect(res.status).toBe(404);
  });

  it('full dance: callback sets a session cookie and /api/me identifies the user', async () => {
    const cookie = await signIn('alice', 'alice@example.com');
    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { id: string; provider: string; email: string } };
    expect(body.user.provider).toBe('google');
    expect(body.user.email).toBe('alice@example.com');
    expect(body.user.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('signing in twice with the same provider identity reuses the account', async () => {
    const c1 = await signIn('bob', 'bob@example.com');
    const c2 = await signIn('bob', 'bob-new@example.com');
    const id = async (cookie: string) => {
      const res = await SELF.fetch(`${BASE}/api/me`, { headers: { cookie } });
      return ((await res.json()) as { user: { id: string; email: string } }).user;
    };
    const u1 = await id(c1);
    const u2 = await id(c2);
    expect(u2.id).toBe(u1.id);
    expect(u2.email).toBe('bob-new@example.com'); // email refreshed on sign-in
  });

  it('same identity via a different provider is a separate account (plan §8 v1 call)', async () => {
    const g = await signIn('carol', 'carol@example.com', 'google');
    const h = await signIn('carol', 'carol@example.com', 'github');
    const id = async (cookie: string) => {
      const res = await SELF.fetch(`${BASE}/api/me`, { headers: { cookie } });
      return ((await res.json()) as { user: { id: string } }).user.id;
    };
    expect(await id(g)).not.toBe(await id(h));
  });

  it('rejects a state mismatch without creating a session', async () => {
    const res = await SELF.fetch(
      `${BASE}/api/auth/google/callback?code=fake:mallory&state=deadbeef`,
      { headers: { cookie: 'oauth_state=cafebabe' }, redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${APP_ORIGIN}/#auth-error`);
    expect(getSetCookies(res.headers).some((c) => c.startsWith('session='))).toBe(false);
  });

  it('rejects a failed code exchange', async () => {
    const start = await SELF.fetch(`${BASE}/api/auth/github/start`, { redirect: 'manual' });
    const state = /oauth_state=([^;]+)/.exec(start.headers.get('set-cookie')!)![1];
    const res = await SELF.fetch(
      `${BASE}/api/auth/github/callback?code=not-a-fake-code&state=${state}`,
      { headers: { cookie: `oauth_state=${state}` }, redirect: 'manual' },
    );
    expect(res.headers.get('location')).toBe(`${APP_ORIGIN}/#auth-error`);
  });
});

describe('sessions', () => {
  it('me without a cookie is 401', async () => {
    const res = await SELF.fetch(`${BASE}/api/me`);
    expect(res.status).toBe(401);
  });

  it('signout revokes the session server-side and clears the cookie', async () => {
    const cookie = await signIn('dave');
    const out = await SELF.fetch(`${BASE}/api/auth/signout`, {
      method: 'POST',
      headers: { cookie, origin: APP_ORIGIN },
    });
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toContain('session=;');
    // The old cookie value is dead even if the browser kept it.
    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { cookie } });
    expect(me.status).toBe(401);
  });

  it('expired sessions are rejected and deleted', async () => {
    const cookie = await signIn('erin');
    const id = cookie.split('=')[1];
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1000, id)
      .run();
    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { cookie } });
    expect(me.status).toBe(401);
    const row = await env.DB.prepare('SELECT id FROM sessions WHERE id = ?').bind(id).first();
    expect(row).toBeNull();
  });

  it('slides the 90-day expiry once it has aged, and re-sets the cookie', async () => {
    const cookie = await signIn('faye');
    const id = cookie.split('=')[1];
    // Fresh session: no refresh, no set-cookie.
    const fresh = await SELF.fetch(`${BASE}/api/me`, { headers: { cookie } });
    expect(fresh.headers.get('set-cookie')).toBeNull();
    // Age it by 2 days.
    const aged = Date.now() + 88 * 24 * 3600 * 1000;
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').bind(aged, id).run();
    const res = await SELF.fetch(`${BASE}/api/me`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain(`session=${id}`);
    const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE id = ?')
      .bind(id)
      .first<{ expires_at: number }>();
    expect(row!.expires_at).toBeGreaterThan(aged + 24 * 3600 * 1000);
  });
});

describe('origin check on state-changing requests', () => {
  it('rejects cross-origin POSTs', async () => {
    const cookie = await signIn('greg');
    const res = await SELF.fetch(`${BASE}/api/sync/examples`, {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });
});
