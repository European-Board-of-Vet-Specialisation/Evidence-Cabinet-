import { describe, it, expect } from 'vitest'
import { env } from './helpers'
import { MIGRATIONS } from '../src/schema.gen'
import { statements, ensureSchema } from '../src/migrate'

describe('the cabinet sets up its own database', () => {
  it('splits each migration into whole statements', () => {
    for (const m of MIGRATIONS) {
      const parts = statements(m.sql)
      // One statement per CREATE / ALTER / INSERT in the file, and nothing cut short.
      const expected = (m.sql.replace(/--.*$/gm, '').match(/^\s*(CREATE|ALTER|INSERT|DROP|UPDATE)\b/gm) ?? []).length
      expect(parts.length, m.name).toBe(expected)
      for (const s of parts) expect(s.split('(').length, `${m.name}: ${s.slice(0, 40)}`).toBe(s.split(')').length)
      for (const s of parts) expect(s, m.name).toMatch(/^(CREATE|ALTER|INSERT|DROP|UPDATE)\b/)
    }
  })
  it('records migrations under the same names Wrangler uses, so the two agree', async () => {
    await ensureSchema(env)
    const names = (await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()).results.map(r => r.name)
    expect(names).toEqual(MIGRATIONS.map(m => m.name))
  })
})
