-- Accounts + profile sync schema, exactly per docs/accounts-plan.md §3.
-- settings/beats are created now (schema accommodates Phase 2) but only
-- examples sync in Phase 1.

CREATE TABLE users (
  id          TEXT PRIMARY KEY,          -- uuidv4
  provider    TEXT NOT NULL,             -- 'google' | 'github'
  provider_id TEXT NOT NULL,
  email       TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (provider, provider_id)
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,           -- random 128-bit, cookie value
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE examples (
  uuid          TEXT PRIMARY KEY,        -- client-generated uuidv4
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_version TEXT NOT NULL,           -- mirrors KnnProfile.load filtering
  label         TEXT NOT NULL,           -- DrumClass ('' on pure tombstones)
  embedding     BLOB NOT NULL,           -- 128 × float32 LE = 512 B
  model_probs   BLOB,                    -- 5 × float32 = 20 B; NULL for legacy rows
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER                  -- tombstone; NULL = live
);
CREATE INDEX examples_user_version ON examples (user_id, model_version);

CREATE TABLE settings (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  json       TEXT NOT NULL,              -- AppSettings; client clamps on read anyway
  updated_at INTEGER NOT NULL            -- last-write-wins
);

CREATE TABLE beats (
  uuid       TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  payload    TEXT NOT NULL,              -- share.ts base64url (versioned codec)
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
