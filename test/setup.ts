import { applyD1Migrations, env } from 'cloudflare:test'
const e = env as unknown as { DB: D1Database; TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }
await applyD1Migrations(e.DB, e.TEST_MIGRATIONS)

// My College is not there in tests: background deliveries get "unavailable" and stay queued.
// Tests that care about delivery replace this with mockMc().
const real = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith('https://mc.test/')) return new Response('{"ok":false,"error":"unavailable"}', { status: 503 })
  return real(input, init)
}) as typeof fetch
