import { describe, it, expect } from 'vitest'
import { env, mockMc, newRef } from './helpers'
import { queueEvent, deliverDue, retryEvent } from '../src/outbox'

const queue = async (fields: Record<string, unknown>, decisionId: number | null = null) => {
  await env.DB.batch([queueEvent(env, 'claim.decision_finalised', fields, decisionId)])
  return env.DB.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 1').first<{ id: number; event_id: string }>()
}
const row = (id: number) => env.DB.prepare('SELECT state, attempts, last_error FROM outbox WHERE id = ?').bind(id).first()

describe('event delivery', () => {
  it('signs each attempt afresh with the same event ID, and marks a decision recorded', async () => {
    const ref = newRef()
    const d = await env.DB.prepare('INSERT INTO decisions (case_ref, version, decision_type, outcome, mc_state) VALUES (?, 1, \'initial\', \'upheld\', \'pending\') RETURNING id').bind(ref).first<{ id: number }>()
    const ev = await queue({ case_ref: ref, version: 1 }, d!.id)
    let calls = 0
    const mc = mockMc(() => (++calls === 1 ? { status: 503 } : { status: 200, json: { ok: true, result: 'recorded', version: 1 } }))
    try {
      await deliverDue(env)
      expect(await row(ev!.id)).toMatchObject({ state: 'pending', attempts: 1 })
      await env.DB.prepare('UPDATE outbox SET next_attempt_at = ? WHERE id = ?').bind(new Date(0).toISOString(), ev!.id).run()
      await deliverDue(env)
      expect(await row(ev!.id)).toMatchObject({ state: 'sent', attempts: 2 })
      expect(mc.seen.map(b => b.event_id)).toEqual([ev!.event_id, ev!.event_id])
      expect(mc.seen[0]).toMatchObject({ iss: 'https://cabinet.test', aud: 'https://mc.test/ec', college: 'ECVN', type: 'claim.decision_finalised' })
      expect(await env.DB.prepare('SELECT mc_state FROM decisions WHERE id = ?').bind(d!.id).first('mc_state')).toBe('recorded')
    } finally { mc.restore() }
  })
  it('stops on a refusal, shows why, and retries only when an administrator asks', async () => {
    const ref = newRef()
    const d = await env.DB.prepare('INSERT INTO decisions (case_ref, version, decision_type, outcome, mc_state) VALUES (?, 1, \'initial\', \'upheld\', \'pending\') RETURNING id').bind(ref).first<{ id: number }>()
    const ev = await queue({ case_ref: ref, version: 1 }, d!.id)
    const mc = mockMc(() => ({ status: 422, json: { ok: false, error: 'adjustments: Additional examination time does not apply' } }))
    try {
      await deliverDue(env)
      expect(await row(ev!.id)).toMatchObject({ state: 'refused' })
      expect(await env.DB.prepare('SELECT mc_state, mc_detail FROM decisions WHERE id = ?').bind(d!.id).first()).toEqual({ mc_state: 'refused', mc_detail: 'adjustments: Additional examination time does not apply' })
      await deliverDue(env)
      expect(mc.seen.length).toBe(1)
      await retryEvent(env, ev!.id)
      expect(await row(ev!.id)).toMatchObject({ state: 'pending', attempts: 0 })
    } finally { mc.restore() }
  })
})
