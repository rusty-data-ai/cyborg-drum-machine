import type { Env } from './env';

/**
 * OAuth provider layer (accounts plan §1): hand-rolled — two redirects + a
 * code exchange per provider, ~50 lines each, no library. The interface is
 * the seam that lets integration tests run a fake provider with the real
 * routing/session/DB code around it.
 */

export type ProviderName = 'google' | 'github';
export const PROVIDER_NAMES: readonly ProviderName[] = ['google', 'github'];

export interface ProviderIdentity {
  providerId: string;
  email: string | null;
}

export interface OAuthProvider {
  readonly name: ProviderName;
  /** Where to send the user's browser to consent. */
  authorizeUrl(redirectUri: string, state: string): string;
  /** Server-to-server code exchange → stable provider identity. */
  exchange(code: string, redirectUri: string): Promise<ProviderIdentity>;
}

export function googleProvider(clientId: string, clientSecret: string): OAuthProvider {
  return {
    name: 'google',
    authorizeUrl(redirectUri, state) {
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email',
        state,
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
    },
    async exchange(code, redirectUri) {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      if (!res.ok) throw new Error(`google token exchange failed (${res.status})`);
      const data = (await res.json()) as { id_token?: string };
      if (!data.id_token) throw new Error('google token exchange: no id_token');
      // The id_token came straight from Google over TLS, so its signature
      // needs no verification here — decode the payload.
      const payload = decodeJwtPayload(data.id_token) as { sub?: string; email?: string };
      if (!payload.sub) throw new Error('google id_token: no sub');
      return { providerId: payload.sub, email: payload.email ?? null };
    },
  };
}

export function githubProvider(clientId: string, clientSecret: string): OAuthProvider {
  return {
    name: 'github',
    authorizeUrl(redirectUri, state) {
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'read:user user:email',
        state,
      });
      return `https://github.com/login/oauth/authorize?${q}`;
    },
    async exchange(code, redirectUri) {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }),
      });
      if (!res.ok) throw new Error(`github token exchange failed (${res.status})`);
      const data = (await res.json()) as { access_token?: string };
      if (!data.access_token) throw new Error('github token exchange: no access_token');
      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          authorization: `Bearer ${data.access_token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'cyborg-drum-machine-api', // required by the GitHub API
        },
      });
      if (!userRes.ok) throw new Error(`github user fetch failed (${userRes.status})`);
      const user = (await userRes.json()) as { id?: number; email?: string | null };
      if (user.id === undefined) throw new Error('github user: no id');
      return { providerId: String(user.id), email: user.email ?? null };
    },
  };
}

/**
 * Test-only provider: authorization codes are self-describing —
 * `fake:<providerId>[:<email>]`. Anything else fails the exchange, which is
 * how tests exercise the failure path.
 */
export function fakeProvider(name: ProviderName): OAuthProvider {
  return {
    name,
    authorizeUrl(redirectUri, state) {
      const q = new URLSearchParams({ redirect_uri: redirectUri, state });
      return `https://fake-oauth.invalid/${name}/authorize?${q}`;
    },
    exchange(code) {
      const m = /^fake:([^:]+)(?::(.+))?$/.exec(code);
      if (!m) return Promise.reject(new Error('fake exchange: bad code'));
      return Promise.resolve({ providerId: m[1], email: m[2] ?? null });
    },
  };
}

/** Providers available given the configured secrets (absent = not offered). */
export function providersFromEnv(env: Env): Partial<Record<ProviderName, OAuthProvider>> {
  if (env.FAKE_OAUTH === '1') {
    return { google: fakeProvider('google'), github: fakeProvider('github') };
  }
  const out: Partial<Record<ProviderName, OAuthProvider>> = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    out.google = googleProvider(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  }
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    out.github = githubProvider(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET);
  }
  return out;
}

function decodeJwtPayload(jwt: string): unknown {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');
  const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(b64));
}
