import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Integration tests run the real worker inside workerd with a local D1
 * (SQLite) — no Cloudflare account involved. FAKE_OAUTH swaps the provider
 * layer for the self-describing fake (src/providers.ts); everything else
 * (routing, sessions, D1, merge logic) is the production code.
 */
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(
        new URL('./migrations', import.meta.url).pathname,
      );
      return {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            FAKE_OAUTH: '1',
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
