/**
 * Sync/accounts feature detection (accounts plan Phase 1). The API base comes
 * from the VITE_SYNC_API_URL build-time env ("/api" once the worker is routed
 * on the same origin — plan §9). Unset (the default, and the deployed static
 * site until go-live) → null → all account/sync UI stays hidden and the app
 * is exactly the zero-backend product it was.
 */
export function syncApiBase(): string | null {
  const v = import.meta.env?.VITE_SYNC_API_URL as string | undefined;
  if (!v || typeof v !== 'string') return null;
  return v.replace(/\/+$/, '');
}
