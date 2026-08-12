import type { SyncUser } from '../lib/syncApi';
import type { SyncStatus } from '../lib/syncEngine';

/**
 * Opt-in account/sync UI (accounts plan Phase 1). Rendered only when a worker
 * API is configured (syncApiBase). The app is fully functional signed-out,
 * forever; signing in does not start syncing — the toggle does (plan §2).
 */

/** Privacy copy — verbatim from docs/accounts-plan.md §2. Do not reword. */
export const SYNC_PRIVACY_COPY =
  'Sync your profile: the sound-fingerprints (lists of numbers the AI derives from your ' +
  'taught examples), your settings, and your saved beats. Your audio itself never leaves ' +
  'this browser.';

interface Props {
  user: SyncUser | null;
  syncOn: boolean;
  status: SyncStatus | null;
  /** §5 first-sign-in choice pending: merge local examples up, or replace them. */
  migrationNeeded: boolean;
  localCount: number;
  signInUrl: (provider: 'google' | 'github') => string;
  exportUrl: string;
  onToggleSync: (on: boolean) => void;
  onMigrate: (mode: 'merge' | 'replace') => void;
  onSignOut: () => void;
  onDeleteAccount: () => void;
}

export function AccountPanel({
  user,
  syncOn,
  status,
  migrationNeeded,
  localCount,
  signInUrl,
  exportUrl,
  onToggleSync,
  onMigrate,
  onSignOut,
  onDeleteAccount,
}: Props) {
  return (
    <div className="account">
      <div className="account-head">Account</div>
      {!user ? (
        <div className="account-signedout">
          <p className="account-copy">
            Optional: sign in to back up your profile and use it on other devices.{' '}
            {SYNC_PRIVACY_COPY}
          </p>
          <div className="account-actions">
            <a className="btn subtle" href={signInUrl('google')}>
              sign in with Google
            </a>
            <a className="btn subtle" href={signInUrl('github')}>
              sign in with GitHub
            </a>
          </div>
        </div>
      ) : (
        <div className="account-signedin">
          <div className="account-who">
            signed in via {user.provider}
            {user.email ? ` as ${user.email}` : ''}
          </div>
          {migrationNeeded ? (
            <div className="account-migrate">
              <p className="account-copy">
                This device already has {localCount} taught example{localCount === 1 ? '' : 's'}.
                What should happen to them?
              </p>
              <div className="account-actions">
                <button className="btn subtle" onClick={() => onMigrate('merge')}>
                  keep &amp; merge into my account
                </button>
                <button className="btn subtle" onClick={() => onMigrate('replace')}>
                  replace with my account's profile
                </button>
              </div>
            </div>
          ) : (
            <label className="account-toggle">
              <input
                type="checkbox"
                checked={syncOn}
                onChange={(e) => onToggleSync(e.target.checked)}
              />
              <span className="account-copy">{SYNC_PRIVACY_COPY}</span>
            </label>
          )}
          <p className="account-copy account-scope-note">
            (Today this syncs your taught examples; settings &amp; saved-beats sync is coming
            next.)
          </p>
          {status && status.state !== 'idle' && (
            <div className={`account-status ${status.state}`}>
              {status.state === 'syncing' && 'syncing…'}
              {status.state === 'synced' && 'synced ✓'}
              {status.state === 'error' && `sync problem: ${status.detail ?? 'unknown'}`}
            </div>
          )}
          <div className="account-actions">
            <a className="btn subtle" href={exportUrl}>
              download my data
            </a>
            <button className="btn subtle" onClick={onSignOut}>
              sign out
            </button>
            <button className="btn subtle account-danger" onClick={onDeleteAccount}>
              delete account
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
