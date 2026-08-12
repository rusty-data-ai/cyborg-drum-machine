export interface Env {
  DB: D1Database;
  /** Origin of the web app: post-OAuth redirect target + Origin check on writes. */
  APP_ORIGIN: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /**
   * Test-only: "1" swaps both OAuth providers for a fake that mints identities
   * from the authorization code itself (see providers.ts). Never set in
   * production config — real providers require their client id/secret.
   */
  FAKE_OAUTH?: string;
}
