import type { Env } from './env';
import { providersFromEnv, type ProviderName } from './providers';
import {
  clearSessionCookie,
  clearStateCookie,
  createSession,
  deleteSession,
  getSessionUser,
  randomHex,
  readStateCookie,
  sessionCookie,
  stateCookie,
  type SessionUser,
} from './sessions';
import {
  deleteAccount,
  exportProfile,
  pullExamples,
  pushExamples,
} from './sync';
import { isUuidList, validateWireExample, type WireExample } from './wire';

/**
 * Accounts + sync API (accounts plan Phase 1). Mounted under /api/* on the
 * SAME origin as the static app — the SameSite=Lax session cookie and the
 * absence of CORS headers are deliberate; a cross-origin deployment would
 * need both revisited (plan §1/§9).
 */

/** Request bodies above this are rejected outright (plan §7 abuse caps). */
const MAX_BODY_BYTES = 2_000_000;
const MAX_UPSERTS_PER_PUSH = 1000;
const MAX_DELETES_PER_PUSH = 2000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      console.error('unhandled', err);
      return json({ error: 'internal error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/health' && method === 'GET') {
    return json({ ok: true, service: 'cyborg-drum-machine-api' });
  }

  const authMatch = /^\/api\/auth\/(google|github)\/(start|callback)$/.exec(pathname);
  if (authMatch && method === 'GET') {
    const provider = authMatch[1] as ProviderName;
    return authMatch[2] === 'start'
      ? authStart(env, url, provider)
      : authCallback(request, env, url, provider);
  }

  // State-changing endpoints: browsers send an Origin header on POST/DELETE;
  // when present it must match the app (belt to SameSite=Lax's braces).
  if (method === 'POST' || method === 'DELETE') {
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== env.APP_ORIGIN) {
      return json({ error: 'cross-origin request rejected' }, 403);
    }
  }

  const now = Date.now();
  if (pathname === '/api/auth/signout' && method === 'POST') {
    const session = await getSessionUser(env.DB, request, now);
    if (session) await deleteSession(env.DB, session.sessionId);
    return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie(url) });
  }

  // Everything below requires a session.
  const session = await getSessionUser(env.DB, request, now);
  if (!session) {
    if (pathname === '/api/me' && method === 'GET') return json({ user: null }, 401);
    if (isKnownAuthedRoute(pathname, method)) return json({ error: 'signed out' }, 401);
    return json({ error: 'not found' }, 404);
  }
  const refresh: Record<string, string> = session.refreshed
    ? { 'set-cookie': sessionCookie(session.sessionId, url) }
    : {};

  if (pathname === '/api/me' && method === 'GET') {
    return json(
      { user: { id: session.userId, provider: session.provider, email: session.email } },
      200,
      refresh,
    );
  }

  if (pathname === '/api/sync/examples' && method === 'GET') {
    const modelVersion = url.searchParams.get('modelVersion');
    if (!modelVersion) return json({ error: 'modelVersion required' }, 400);
    return json(await pullExamples(env.DB, session.userId, modelVersion), 200, refresh);
  }

  if (pathname === '/api/sync/examples' && method === 'POST') {
    return syncPush(request, env, session, refresh, now);
  }

  if (pathname === '/api/export' && method === 'GET') {
    const file = await exportProfile(env.DB, session.userId);
    const stamp = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
    return new Response(JSON.stringify(file), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="beatbox-profile-${stamp}.json"`,
        ...refresh,
      },
    });
  }

  if (pathname === '/api/account' && method === 'DELETE') {
    await deleteAccount(env.DB, session.userId);
    return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie(url) });
  }

  return json({ error: 'not found' }, 404);
}

function isKnownAuthedRoute(pathname: string, method: string): boolean {
  if (pathname === '/api/sync/examples') return method === 'GET' || method === 'POST';
  if (pathname === '/api/export') return method === 'GET';
  if (pathname === '/api/account') return method === 'DELETE';
  return false;
}

// ---- OAuth ----

function authStart(env: Env, url: URL, name: ProviderName): Response {
  const provider = providersFromEnv(env)[name];
  if (!provider) return json({ error: `${name} sign-in is not configured` }, 404);
  const state = randomHex(16);
  const redirectUri = `${url.origin}/api/auth/${name}/callback`;
  return new Response(null, {
    status: 302,
    headers: {
      location: provider.authorizeUrl(redirectUri, state),
      'set-cookie': stateCookie(state, url),
    },
  });
}

async function authCallback(
  request: Request,
  env: Env,
  url: URL,
  name: ProviderName,
): Promise<Response> {
  const provider = providersFromEnv(env)[name];
  if (!provider) return json({ error: `${name} sign-in is not configured` }, 404);
  const errorRedirect = () =>
    new Response(null, {
      status: 302,
      headers: {
        location: `${env.APP_ORIGIN}/#auth-error`,
        'set-cookie': clearStateCookie(url),
      },
    });

  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const cookieState = readStateCookie(request);
  if (!state || !code || !cookieState || state !== cookieState) return errorRedirect();

  let identity;
  try {
    identity = await provider.exchange(code, `${url.origin}/api/auth/${name}/callback`);
  } catch (err) {
    console.warn(`${name} exchange failed`, err);
    return errorRedirect();
  }

  const now = Date.now();
  // Upsert the user. Account linking across providers is out of scope for v1
  // (plan §8): the same human on Google and GitHub is two accounts.
  let user = await env.DB.prepare('SELECT id FROM users WHERE provider = ? AND provider_id = ?')
    .bind(name, identity.providerId)
    .first<{ id: string }>();
  if (!user) {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO users (id, provider, provider_id, email, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(id, name, identity.providerId, identity.email, now)
      .run();
    user = { id };
  } else if (identity.email) {
    await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?')
      .bind(identity.email, user.id)
      .run();
  }

  const sessionId = await createSession(env.DB, user.id, now);
  const headers = new Headers({ location: `${env.APP_ORIGIN}/` });
  headers.append('set-cookie', sessionCookie(sessionId, url));
  headers.append('set-cookie', clearStateCookie(url));
  return new Response(null, { status: 302, headers });
}

// ---- sync push ----

async function syncPush(
  request: Request,
  env: Env,
  session: SessionUser,
  refresh: Record<string, string>,
  now: number,
): Promise<Response> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'payload too large' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  if (typeof body !== 'object' || body === null) return json({ error: 'invalid body' }, 400);
  const b = body as Record<string, unknown>;
  if (typeof b.modelVersion !== 'string' || b.modelVersion.length === 0 || b.modelVersion.length > 128) {
    return json({ error: 'modelVersion required' }, 400);
  }
  const rawUpserts = Array.isArray(b.upserts) ? b.upserts : [];
  if (rawUpserts.length > MAX_UPSERTS_PER_PUSH) return json({ error: 'too many upserts' }, 413);
  const upserts: WireExample[] = [];
  for (const u of rawUpserts) {
    const valid = validateWireExample(u);
    if (!valid) return json({ error: 'malformed example' }, 400);
    upserts.push(valid);
  }
  const deletes = b.deletes ?? [];
  if (!isUuidList(deletes, MAX_DELETES_PER_PUSH)) return json({ error: 'malformed deletes' }, 400);

  const outcome = await pushExamples(env.DB, session.userId, b.modelVersion, upserts, deletes, now);
  return json(outcome, outcome.ok ? 200 : 409, refresh);
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
