import { applyD1Migrations, env } from 'cloudflare:test';

// Runs once per isolated-storage scope: bring the local D1 up to schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
