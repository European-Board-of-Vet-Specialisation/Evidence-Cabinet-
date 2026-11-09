// The cabinet sets up its own database. On the first request (or cron run) in each isolate it
// applies any migration not yet recorded in `d1_migrations` — the same table, and the same names,
// that `wrangler d1 migrations apply` uses — so the two never disagree. A College's build can run
// any deploy command; the schema is right before anything else runs.

import type { Env } from './env'
import { MIGRATIONS } from './schema.gen'

let ready: Promise<void> | null = null

/** Drop `--` comments (whole-line or trailing), leaving anything inside quotes alone. */
function stripComments(sql: string): string {
  let out = '', quote: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!
    if (quote) { out += c; if (c === quote) quote = null; continue }
    if (c === "'" || c === '"') { quote = c; out += c; continue }
    if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; out += '\n'; continue }
    out += c
  }
  return out
}

/** Statements of a migration file: comments dropped, split on semicolons outside quotes. */
export function statements(sql: string): string[] {
  const parts: string[] = []
  let cur = '', quote: string | null = null
  for (const c of stripComments(sql)) {
    if (quote) { if (c === quote) quote = null }
    else if (c === "'" || c === '"') quote = c
    else if (c === ';') { parts.push(cur); cur = ''; continue }
    cur += c
  }
  parts.push(cur)
  return parts.map(p => p.trim()).filter(Boolean)
}

async function apply(env: Env): Promise<void> {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS "d1_migrations"(
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`).run()
  const done = new Set((await env.DB.prepare('SELECT name FROM d1_migrations').all<{ name: string }>()).results.map(r => r.name))
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue
    try {
      // One batch per file: it applies whole, with its record, or not at all.
      await env.DB.batch([...statements(m.sql).map(s => env.DB.prepare(s)), env.DB.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(m.name)])
    } catch (e) {
      // Another isolate applied it at the same moment: fine. Anything else is a real failure.
      const now = await env.DB.prepare('SELECT 1 FROM d1_migrations WHERE name = ?').bind(m.name).first()
      if (!now) throw e
    }
  }
}

export function ensureSchema(env: Env): Promise<void> {
  if (!ready) ready = apply(env).catch(e => { ready = null; throw e })
  return ready
}
