/**
 * Cookie + D1 sessions (accounts plan §1): server-side rows referenced by an
 * HttpOnly cookie carrying a random 128-bit id. 90 days, sliding — refreshed
 * at most ~daily so reads don't burn a D1 write per request. Not JWTs
 * (revocation and account deletion must actually work), not KV (1k writes/day
 * is the scarcest free-tier number).
 */

export const SESSION_COOKIE = 'session';
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Slide the expiry only when it has aged at least this much. */
const REFRESH_GRANULARITY_MS = 24 * 60 * 60 * 1000;
const STATE_COOKIE = 'oauth_state';

export function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export interface SessionUser {
  sessionId: string;
  userId: string;
  provider: string;
  email: string | null;
  /** True when the sliding expiry was extended (cookie should be re-set). */
  refreshed: boolean;
}

export async function createSession(db: D1Database, userId: string, now: number): Promise<string> {
  const id = randomHex(16); // 128 bits
  await db
    .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(id, userId, now, now + SESSION_TTL_MS)
    .run();
  return id;
}

/** Resolve the cookie to a live session+user; expired rows are deleted. */
export async function getSessionUser(
  db: D1Database,
  request: Request,
  now: number,
): Promise<SessionUser | null> {
  const id = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  if (!id || !/^[0-9a-f]{32}$/.test(id)) return null;
  const row = await db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.provider, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .bind(id)
    .first<{
      session_id: string;
      expires_at: number;
      user_id: string;
      provider: string;
      email: string | null;
    }>();
  if (!row) return null;
  if (row.expires_at <= now) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return null;
  }
  let refreshed = false;
  if (row.expires_at - now < SESSION_TTL_MS - REFRESH_GRANULARITY_MS) {
    await db
      .prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .bind(now + SESSION_TTL_MS, id)
      .run();
    refreshed = true;
  }
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    provider: row.provider,
    email: row.email,
    refreshed,
  };
}

export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
}

// ---- cookies ----

/** `Secure` only over https, so wrangler dev on http://localhost still works. */
export function cookieSecurity(url: URL): string {
  return url.protocol === 'https:' ? '; Secure' : '';
}

export function sessionCookie(id: string, url: URL): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${id}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${cookieSecurity(url)}`;
}

export function clearSessionCookie(url: URL): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${cookieSecurity(url)}`;
}

export function stateCookie(state: string, url: URL): string {
  return `${STATE_COOKIE}=${state}; Max-Age=600; Path=/; HttpOnly; SameSite=Lax${cookieSecurity(url)}`;
}

export function clearStateCookie(url: URL): string {
  return `${STATE_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${cookieSecurity(url)}`;
}

export function readStateCookie(request: Request): string | null {
  return readCookie(request.headers.get('cookie'), STATE_COOKIE);
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
