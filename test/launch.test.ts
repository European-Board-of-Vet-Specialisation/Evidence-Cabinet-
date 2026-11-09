import { describe, it, expect } from 'vitest'
import { generateKeyPair } from 'jose'
import { call, pass, postForm, cookiesOf, newRef, env, SUB, SUB2, ORIGIN } from './helpers'
import { startStaffSession } from '../src/session'

async function reviewer(sub = SUB) {
  const p = await env.DB.prepare('INSERT INTO people (sub, display_name, created_at) VALUES (?, ?, ?) RETURNING id').bind(sub, 'Reviewer', new Date().toISOString()).first<{ id: number }>()
  return { id: p!.id, cookie: (await startStaffSession(env, p!.id)).split(';')[0]! }
}

describe('upload pass (acceptance test 3)', () => {
  it('admits the candidate to one case, once', async () => {
    const ref = newRef(), p = await pass('upload', ref)
    const ok = await call(postForm('/launch', { pass: p }))
    expect(ok.status).toBe(303)
    expect(ok.headers.get('location')).toBe('/upload')
    const page = await call(new Request(ORIGIN + '/upload', { headers: { cookie: cookiesOf(ok) } }))
    expect(await page.text()).toContain('Submit your evidence')
    const replay = await call(postForm('/launch', { pass: p }))
    expect(replay.status).toBe(403)
    expect(await replay.text()).toContain('already been used')
  })
  it('refuses a forged, misaddressed, foreign-College, long-lived or expired pass', async () => {
    const ref = newRef()
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
    const bad = [
      await pass('upload', ref, {}, { key: privateKey as CryptoKey }),
      await pass('upload', ref, { aud: 'https://other-cabinet.test' }),
      await pass('upload', ref, { college: 'ECVSMR' }),
      await pass('upload', ref, {}, { ttl: 600 }),
      await pass('upload', ref, {}, { iat: Math.floor(Date.now() / 1000) - 600 }),
      await pass('upload', ref, { role: 'reviewer' }),
      await pass('upload', 'ec-notacase'),
    ]
    for (const p of bad) expect((await call(postForm('/launch', { pass: p }))).status).toBe(403)
  })
  it('refuses a pass for a case another person opened', async () => {
    const ref = newRef()
    await call(postForm('/launch', { pass: await pass('upload', ref) }))
    expect((await call(postForm('/launch', { pass: await pass('upload', ref, { sub: SUB2 }) }))).status).toBe(403)
  })
})

describe('review pass: the pass names, the sign-in admits (acceptance tests 3 and 5)', () => {
  it('sends a reviewer who is not signed in to sign in first', async () => {
    const res = await call(postForm('/launch', { pass: await pass('review', newRef()) }))
    const cont = await call(new Request(ORIGIN + '/launch/continue', { headers: { cookie: cookiesOf(res) } }))
    expect(cont.headers.get('location')).toBe('/signin?next=/launch/continue')
  })
  it('opens the case only for the named, assigned reviewer', async () => {
    const ref = newRef(), me = await reviewer()
    const go = async (cookie: string) => {
      const res = await call(postForm('/launch', { pass: await pass('review', ref) }))
      return call(new Request(ORIGIN + '/launch/continue', { headers: { cookie: `${cookie}; ${cookiesOf(res)}` } }))
    }
    expect((await go(me.cookie)).status).toBe(403)   // not assigned
    await env.DB.prepare('INSERT INTO assignments (case_ref, person_id, assigned_at) VALUES (?, ?, ?)').bind(ref, me.id, new Date().toISOString()).run()
    const ok = await go(me.cookie)
    expect(ok.headers.get('location')).toBe(`/case/${ref}`)
    await env.DB.prepare('UPDATE assignments SET revoked_at = ? WHERE case_ref = ?').bind(new Date().toISOString(), ref).run()
    expect((await go(me.cookie)).status).toBe(403)   // revoked: refused on the next request
  })
  it('refuses someone signed in as a different person', async () => {
    const other = await reviewer(SUB2)
    const res = await call(postForm('/launch', { pass: await pass('inbox', null) }))
    const cont = await call(new Request(ORIGIN + '/launch/continue', { headers: { cookie: `${other.cookie}; ${cookiesOf(res)}` } }))
    expect(cont.status).toBe(403)
  })
})

describe('cross-site protection', () => {
  const req = (h: Record<string, string>) => call(new Request(ORIGIN + '/setup', { method: 'POST', body: new URLSearchParams({ token: 'x', name: 'y' }), headers: h }))
  it('accepts this origin, and Origin: null when the browser marks it same-origin', async () => {
    expect((await req({ origin: ORIGIN })).status).toBe(200)
    expect((await req({ origin: 'null', 'sec-fetch-site': 'same-origin' })).status).toBe(200)
  })
  it('refuses another site, however it presents', async () => {
    expect((await req({ origin: 'https://evil.test' })).status).toBe(403)
    expect((await req({ origin: 'null', 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await req({ 'sec-fetch-site': 'same-site' })).status).toBe(403)
  })
})
