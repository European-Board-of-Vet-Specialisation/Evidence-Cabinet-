import { describe, it, expect } from 'vitest'
import { call, pass, signal, postForm, cookiesOf, newRef, env, ORIGIN, PDF, collegeVerify, mcSign } from './helpers'
import { TYP } from '../src/mc'

async function caseWithEvidence() {
  const ref = newRef()
  const launch = await call(postForm('/launch', { pass: await pass('upload', ref) }))
  const up = await call(postForm('/upload', { statement: 'My account.', files: new File([PDF], 'letter.pdf') }, cookiesOf(launch)))
  expect(await up.text()).toContain('Received')
  return ref
}
const objects = async (prefix: string) => (await env.EVIDENCE.list({ prefix })).objects.length
const post = (path: string, body: string) => call(new Request(ORIGIN + path, { method: 'POST', body, headers: { 'Content-Type': 'application/jose' } }))

describe('signals', () => {
  it('case.closed deletes objects and sensitive records, and queues evidence.deleted', async () => {
    const ref = await caseWithEvidence()
    expect(await objects(`cases/${ref}/`)).toBe(1)
    const s = await signal('case.closed', ref)
    expect((await post('/api/signals', s)).status).toBe(200)
    expect(await objects(`cases/${ref}/`)).toBe(0)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM evidence_versions WHERE case_ref = ?').bind(ref).first('n')).toBe(0)
    const c = await env.DB.prepare('SELECT state, candidate_sub FROM cases WHERE case_ref = ?').bind(ref).first<{ state: string; candidate_sub: string | null }>()
    expect(c).toEqual({ state: 'disposed', candidate_sub: null })
    const ev = await env.DB.prepare('SELECT type FROM outbox WHERE body LIKE ? ORDER BY id').bind(`%${ref}%`).all<{ type: string }>()
    expect(ev.results.map((r: { type: string }) => r.type)).toEqual(['evidence.received', 'evidence.deleted'])
    // The same signal again changes nothing (acceptance test 7).
    const again = await post('/api/signals', s)
    expect(await again.json()).toEqual({ ok: true, result: 'duplicate' })
  })
  it('appeal.hold moves the case to hold/, appeal.release deletes both (acceptance test 8)', async () => {
    const ref = await caseWithEvidence()
    await post('/api/signals', await signal('appeal.hold', ref))
    expect(await objects(`cases/${ref}/`)).toBe(0)
    expect(await objects(`hold/${ref}/`)).toBe(1)
    await post('/api/signals', await signal('appeal.release', ref))
    expect(await objects(`hold/${ref}/`)).toBe(0)
    expect(await env.DB.prepare('SELECT state FROM cases WHERE case_ref = ?').bind(ref).first('state')).toBe('disposed')
  })
  it('refuses a launch pass replayed as a signal, and a stale signal', async () => {
    const ref = newRef()
    expect((await post('/api/signals', await pass('upload', ref))).status).toBe(401)
    const old = await mcSign(TYP.signal, { event_id: crypto.randomUUID(), type: 'case.closed', case_ref: ref }, { iat: Math.floor(Date.now() / 1000) - 3600, ttl: 7200 })
    expect((await post('/api/signals', old)).status).toBe(401)
  })
})

describe('pairing', () => {
  it('answers a signed test with the same nonce, signed by the College', async () => {
    const t = await mcSign(TYP.pair, { type: 'pairing.test', nonce: 'n-123' }, { ttl: 60 })
    const res = await post('/api/pair', t)
    expect(res.status).toBe(200)
    const { body, header } = await collegeVerify(new TextDecoder().decode(await res.arrayBuffer()))
    expect(header.typ).toBe('ec-event+jwt')
    expect(body).toMatchObject({ type: 'pairing.ack', nonce: 'n-123', iss: ORIGIN, aud: 'https://mc.test/ec', college: 'ECVN' })
  })
})
