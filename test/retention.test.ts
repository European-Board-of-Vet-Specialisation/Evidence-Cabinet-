import { describe, it, expect } from 'vitest'
import { env, newRef, mockMc, SUB } from './helpers'
import { runDaily } from '../src/retention'

const at = (iso: string) => new Date(iso)
async function caseAt(lastActivity: string, extra: Record<string, unknown> = {}) {
  const ref = newRef()
  await env.DB.prepare('INSERT INTO cases (case_ref, candidate_sub, created_at, last_activity_at) VALUES (?, ?, ?, ?)').bind(ref, SUB, lastActivity, lastActivity).run()
  for (const [k, v] of Object.entries(extra)) await env.DB.prepare(`UPDATE cases SET ${k} = ? WHERE case_ref = ?`).bind(v, ref).run()
  await env.DB.prepare('INSERT INTO evidence_versions (case_ref, version, statement, complete, created_at) VALUES (?, 1, \'account\', 1, ?)').bind(ref, lastActivity).run()
  await env.EVIDENCE.put(`cases/${ref}/1/f1`, 'x')
  return ref
}
const state = (ref: string) => env.DB.prepare('SELECT state, reminded_deletion_at, retain_until FROM cases WHERE case_ref = ?').bind(ref).first<{ state: string; reminded_deletion_at: string | null; retain_until: string | null }>()

describe('the daily job (acceptance tests 9 and 10)', () => {
  it('reminds, then deletes a case idle for 18 months, objects and records alike', async () => {
    await env.DB.prepare('INSERT INTO people (sub, display_name, is_admin, created_at) VALUES (?, \'Admin\', 1, ?)').bind(SUB, new Date().toISOString()).run()
    const ref = await caseAt('2026-01-01T00:00:00Z')
    const mc = mockMc(() => ({ status: 200 }))
    try {
      await runDaily(env, at('2027-07-10T00:00:00Z'))
      expect((await state(ref))?.state).toBe('open')
      expect((await state(ref))?.reminded_deletion_at).not.toBeNull()
      expect(mc.seen.some(b => b.type === 'reviewer.notification_requested' && b.kind === 'deletion_due' && !('case_ref' in b))).toBe(true)
      await runDaily(env, at('2027-07-11T00:00:00Z'))
      expect((await state(ref))?.state).toBe('disposed')
      expect((await env.EVIDENCE.list({ prefix: `cases/${ref}/` })).objects.length).toBe(0)
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM evidence_versions WHERE case_ref = ?').bind(ref).first('n')).toBe(0)
      expect(mc.seen.some(b => b.type === 'evidence.deleted' && b.case_ref === ref)).toBe(true)
    } finally { mc.restore() }
  })
  it('keeps a flagged case, and lapses the flag when it runs out', async () => {
    const ref = await caseAt('2026-01-01T00:00:00Z', { retain_until: '2027-09-01T00:00:00Z', location: 'hold' })
    await env.EVIDENCE.delete(`cases/${ref}/1/f1`); await env.EVIDENCE.put(`hold/${ref}/1/f1`, 'x')
    const mc = mockMc(() => ({ status: 200 }))
    try {
      await runDaily(env, at('2027-08-01T00:00:00Z'))
      expect((await state(ref))?.state).toBe('open')
      await runDaily(env, at('2027-09-02T00:00:00Z'))
      expect((await state(ref))?.retain_until).toBeNull()
      expect((await env.EVIDENCE.list({ prefix: `cases/${ref}/` })).objects.length).toBe(1)
    } finally { mc.restore() }
  })
})
