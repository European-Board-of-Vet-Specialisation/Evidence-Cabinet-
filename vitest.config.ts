import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { generateKeyPairSync } from 'node:crypto'

// Tests run inside workerd with a local D1 and R2. The College's signing key is made fresh for
// each run; My College's keys are made inside the tests (test/helpers.ts).
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations')
  const { privateKey } = generateKeyPairSync('ed25519')
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          COLLEGE: 'ECVN',
          CABINET_ORIGIN: 'https://cabinet.test',
          MC_BASE: 'https://mc.test',
          MC_ISSUER: 'https://mc.test/ec',
          COLLEGE_SIGNING_KEY: JSON.stringify(privateKey.export({ format: 'jwk' })),
          SETUP_TOKEN: 'test-setup-token-0123456789',
        },
      },
    })],
    test: { setupFiles: ['./test/setup.ts'] },
  }
})
