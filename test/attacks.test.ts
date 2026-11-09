// Attacks, as tests: each one is something an outsider, a candidate, a reviewer on another case,
// a removed person or a hostile web page might try. Every one must fail.

import { describe, it, expect } from 'vitest'
import { SignJWT } from 'jose'
import { call, get, postForm, person, assign, caseWithEvidence, pass, signal, mcSign, env, ORIGIN, newRef, cookiesOf, PDF } from './helpers'
import { TYP } from '../src/mc'

const fileOf = (ref: string) => env.DB.prepare('SELECT id FROM files WHERE case_ref = ?').bind(ref).first<string>('id')
const viewer = { 'X-Cabinet-Viewer': '1' }
const registerOptions = (token: string) => call(new Request(ORIGIN + '/api/passkey/register/options', { method: 'POST', body: JSON.stringify({ token }), headers: { 'Content-Type': 'application/json' } }))

describe('a reviewer on one case reaching another', () => {
  it('cannot open, view, comment on, decide or flag a case they are not assigned to', async () => {
    const mine = await caseWithEvidence(), theirs = await caseWithEvidence()
    const r = await person({ finalise: true, retain: true }); await assign(mine, r.id)
    const f = await fileOf(theirs)
    expect((await get(`/case/${theirs}`, r.cookie)).status).toBe(403)
    expect((await get(`/case/${theirs}/file/${f}`, r.cookie)).status).toBe(403)
    expect((await get(`/case/${theirs}/file/${f}/raw`, r.cookie, { headers: viewer })).status).toBe(403)
    expect((await call(postForm(`/case/${theirs}/comment`, { body: 'x' }, r.cookie))).status).toBe(403)
    expect((await call(postForm(`/case/${theirs}/decision/draft`, { outcome: 'upheld', go: 'save' }, r.cookie))).status).toBe(403)
    expect((await call(postForm(`/case/${theirs}/retain`, { go: 'clear' }, r.cookie))).status).toBe(403)
  })
  it('cannot fetch another case’s file through their own case', async () => {
    const mine = await caseWithEvidence(), theirs = await caseWithEvidence()
    const r = await person(); await assign(mine, r.id)
    const f = await fileOf(theirs)
    const ie = { cf: { country: 'IE' } } as never
    expect((await get(`/case/${mine}/file/${f}/raw`, r.cookie, { headers: viewer, cf: { country: 'IE' } } as never)).status).toBe(404)
    expect((await get(`/case/${mine}/file/${f}`, r.cookie, ie)).status).toBe(404)
    // …nor tag a comment with it.
    expect(await (await call(postForm(`/case/${mine}/comment`, { body: 'x', file_id: f! }, r.cookie))).text()).toContain('not in this case')
  })
})

describe('the candidate', () => {
  it('cannot reach reviewer pages, other cases or administration with an upload session', async () => {
    const ref = newRef(), other = await caseWithEvidence()
    const launch = await call(postForm('/launch', { pass: await pass('upload', ref) }))
    const c = cookiesOf(launch)
    expect((await get(`/case/${ref}`, c)).headers.get('location')).toContain('/signin')
    expect((await get(`/case/${other}`, c)).headers.get('location')).toContain('/signin')
    expect((await get('/admin', c)).headers.get('location')).toContain('/signin')
  })
  it('cannot store HTML or script as evidence, whatever the file is called', async () => {
    const ref = newRef()
    const launch = await call(postForm('/launch', { pass: await pass('upload', ref) }))
    for (const body of ['<html><script>alert(1)</script></html>', '%PDF-1.4\n<script>alert(1)</script>']) {
      const res = await call(postForm('/upload', { name: 'A', statement: 'B', files: new File([body], 'x.pdf', { type: 'application/pdf' }) }, cookiesOf(launch)))
      expect(await res.text()).toContain('Nothing was sent')
    }
  })
})

describe('injection through what candidates and reviewers write', () => {
  it('escapes names, statements and comments everywhere they are shown', async () => {
    const ref = newRef()
    const launch = await call(postForm('/launch', { pass: await pass('upload', ref) }))
    const evil = '<img src=x onerror=alert(1)>"\'><script>alert(2)</script>'
    await call(postForm('/upload', { name: evil, statement: evil, files: new File([PDF], 'a.pdf') }, cookiesOf(launch)))
    const r = await person({ name: evil, admin: true }); await assign(ref, r.id)
    await call(postForm(`/case/${ref}/comment`, { body: evil }, r.cookie))
    for (const path of [`/case/${ref}`, '/cases', '/admin', `/admin/case/${ref}`]) {
      const html = await (await get(path, r.cookie)).text()
      expect(html, path).not.toContain('<script>alert')
      expect(html, path).not.toContain('<img src=x')
    }
    const f = await fileOf(ref)
    const v = await (await get(`/case/${ref}/file/${f}`, r.cookie, { cf: { country: 'IE' } } as never)).text()
    expect(v).not.toContain('<img src=x')
  })
  it('serves evidence with a sandbox policy and never as HTML', async () => {
    const ref = await caseWithEvidence()
    const r = await person(); await assign(ref, r.id)
    const res = await get(`/case/${ref}/file/${await fileOf(ref)}/raw`, r.cookie, { headers: viewer, cf: { country: 'IE' } } as never)
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox')
    expect(res.headers.get('Content-Type')).not.toContain('html')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
})

describe('signed messages', () => {
  it('refuses a token signed with a shared secret (HS256) or with no signature', async () => {
    const ref = newRef()
    const hs = await new SignJWT({ iss: 'https://mc.test/ec', aud: ORIGIN, college: 'ECVN', sub: 'p_' + 'A'.repeat(24), role: 'candidate', act: 'upload', case_ref: ref, jti: crypto.randomUUID() })
      .setProtectedHeader({ alg: 'HS256', typ: TYP.launch }).setIssuedAt().setExpirationTime('2m').sign(new TextEncoder().encode('secret'))
    const none = `${btoa(JSON.stringify({ alg: 'none', typ: TYP.launch })).replace(/=+$/, '')}.${hs.split('.')[1]}.`
    for (const p of [hs, none]) expect((await call(postForm('/launch', { pass: p }))).status).toBe(403)
  })
  it('refuses a signal used as a pass, and a pairing test used as a signal', async () => {
    const ref = newRef()
    expect((await call(postForm('/launch', { pass: await signal('case.closed', ref) }))).status).toBe(403)
    const pairTok = await mcSign(TYP.pair, { type: 'pairing.test', nonce: 'n', event_id: crypto.randomUUID(), case_ref: ref })
    expect((await call(new Request(ORIGIN + '/api/signals', { method: 'POST', body: pairTok }))).status).toBe(401)
  })
  it('refuses a signal for another College or another cabinet', async () => {
    const ref = await caseWithEvidence()
    for (const over of [{ college: 'ECVSMR' }, { aud: 'https://other.test' }]) {
      const res = await call(new Request(ORIGIN + '/api/signals', { method: 'POST', body: await signal('case.closed', ref, over) }))
      expect(res.status).toBe(401)
    }
    expect(await env.DB.prepare('SELECT state FROM cases WHERE case_ref = ?').bind(ref).first('state')).toBe('open')
  })
})

describe('a hostile web page', () => {
  it('cannot post to the cabinet on a signed-in reviewer’s behalf', async () => {
    const ref = await caseWithEvidence()
    const admin = await person({ admin: true }), r = await person()
    const cross = (path: string, fields: Record<string, string>) => {
      const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.append(k, v)
      return call(new Request(ORIGIN + path, { method: 'POST', body: fd, headers: { cookie: admin.cookie, origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' } }))
    }
    expect((await cross(`/admin/case/${ref}/assign`, { assign: String(r.id) })).status).toBe(403)
    expect((await cross('/admin/person', { name: 'Mallory', is_admin: '1' })).status).toBe(403)
    expect((await cross(`/admin/case/${ref}/dispose`, { confirm: '1' })).status).toBe(403)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM people WHERE display_name = ?').bind('Mallory').first('n')).toBe(0)
  })
  it('cannot frame the cabinet', async () => {
    const res = await get('/signin')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
  })
  it('cannot use sign-in as an open redirect', async () => {
    for (const next of ['https://evil.test', '//evil.test', '/\\evil.test', 'javascript:alert(1)']) {
      const html = await (await get(`/signin?next=${encodeURIComponent(next)}`)).text()
      expect(html).toContain('data-next="/cases"')
    }
  })
})

describe('people who should no longer get in', () => {
  it('a removed person: no session, no enrolment link, no assignment', async () => {
    const ref = await caseWithEvidence()
    const admin = await person({ admin: true }), r = await person(); await assign(ref, r.id)
    const link = await (await call(postForm(`/admin/person/${r.id}`, { go: 'enrol' }, admin.cookie))).text()
    const token = /\/enrol#([A-Za-z0-9_-]+)/.exec(link)![1]!
    await call(postForm(`/admin/person/${r.id}`, { go: 'remove' }, admin.cookie))
    expect((await get(`/case/${ref}`, r.cookie)).headers.get('location')).toContain('/signin')
    expect((await registerOptions(token)).status).toBe(404)
  })
  it('a used enrolment link cannot be used again', async () => {
    const admin = await person({ admin: true }), r = await person()
    const link = await (await call(postForm(`/admin/person/${r.id}`, { go: 'enrol' }, admin.cookie))).text()
    const token = /\/enrol#([A-Za-z0-9_-]+)/.exec(link)![1]!
    const { sha256 } = await import('../src/util')
    await env.DB.prepare('UPDATE enrolments SET used_at = ? WHERE token_hash = ?').bind(new Date().toISOString(), await sha256(token)).run()
    expect((await registerOptions(token)).status).toBe(404)
  })
  it('a non-administrator gets no administration', async () => {
    const r = await person({ finalise: true, retain: true })
    expect((await get('/admin', r.cookie)).status).toBe(403)
    expect((await call(postForm('/admin/person', { name: 'X', is_admin: '1' }, r.cookie))).status).toBe(403)
    expect((await call(postForm(`/admin/person/${r.id}`, { is_admin: '1', go: 'save' }, r.cookie))).status).toBe(403)
  })
})

describe('fixes from the independent review', () => {
  const ctx = { relates_to: 'examination', subject: 'Examination', types: ['extra_time'], cycles: [], codes: [] }
  it('finalises only what was previewed: a re-save after the check is refused', async () => {
    const ref = await caseWithEvidence(ctx)
    const chair = await person({ finalise: true }), other = await person()
    await assign(ref, chair.id); await assign(ref, other.id)
    await call(postForm(`/case/${ref}/decision/draft`, { decision_type: 'initial', outcome: 'upheld', go: 'save' }, chair.cookie))
    const row = await env.DB.prepare('SELECT id, drafted_at FROM decisions WHERE case_ref = ? AND version IS NULL').bind(ref).first<{ id: number; drafted_at: string }>()
    await new Promise(r => setTimeout(r, 5))
    await call(postForm(`/case/${ref}/decision/draft`, { decision_type: 'initial', outcome: 'not_upheld', go: 'save' }, other.cookie))
    const res = await call(postForm(`/case/${ref}/decision/finalise`, { draft: String(row!.id), version: '1', saved: row!.drafted_at }, chair.cookie))
    expect(await res.text()).toContain('changed after your check')
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM outbox WHERE type = ? AND body LIKE ?').bind('claim.decision_finalised', `%${ref}%`).first('n')).toBe(0)
  })
  it('keeps nothing from an upload that finishes after the case was deleted', async () => {
    const ref = newRef()
    const launch = await call(postForm('/launch', { pass: await pass('upload', ref) }))
    // The race: the case is disposed of at the moment the file lands in storage, mid-upload.
    const { dispose } = await import('../src/cases')
    const racing = {
      ...env,
      EVIDENCE: {
        put: async (...a: Parameters<R2Bucket['put']>) => { const r = await env.EVIDENCE.put(...a); await dispose(env, ref, 'withdrawn'); return r },
        get: (...a: Parameters<R2Bucket['get']>) => env.EVIDENCE.get(...a),
        delete: (...a: Parameters<R2Bucket['delete']>) => env.EVIDENCE.delete(...a),
        list: (...a: Parameters<R2Bucket['list']>) => env.EVIDENCE.list(...a),
      } as unknown as R2Bucket,
    }
    const worker = (await import('../src/index')).default
    const { createExecutionContext, waitOnExecutionContext } = await import('cloudflare:test')
    const c = createExecutionContext()
    const req = postForm('/upload', { name: 'A', statement: 'My account', files: new File([PDF], 'a.pdf') }, cookiesOf(launch))
    const res = await worker.fetch(new Request(req, { cf: { country: 'IE' } } as RequestInit), racing, c); await waitOnExecutionContext(c)
    expect(await res.text()).toContain('nothing was kept')
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM evidence_versions WHERE case_ref = ?').bind(ref).first('n')).toBe(0)
    expect(await env.DB.prepare('SELECT candidate_name FROM cases WHERE case_ref = ?').bind(ref).first('candidate_name')).toBeNull()
    expect((await env.EVIDENCE.list({ prefix: `cases/${ref}/` })).objects.length).toBe(0)
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type = 'evidence.received' AND body LIKE ?").bind(`%${ref}%`).first('n')).toBe(0)
  })
  it('lets only an administrator remove a retention flag', async () => {
    const ref = await caseWithEvidence()
    const m = await person({ retain: true }); await assign(ref, m.id)
    await call(postForm(`/case/${ref}/retain`, { go: 'flag', reason: 'Litigation' }, m.cookie))
    expect((await call(postForm(`/case/${ref}/retain`, { go: 'clear' }, m.cookie))).status).toBe(403)
    expect(await env.DB.prepare('SELECT retain_reason FROM cases WHERE case_ref = ?').bind(ref).first('retain_reason')).toBe('Litigation')
  })
  it('refuses a launch pass dated in the future', async () => {
    const p = await pass('upload', newRef(), {}, { iat: Math.floor(Date.now() / 1000) + 3600 })
    expect((await call(postForm('/launch', { pass: p }))).status).toBe(403)
  })
  it('keeps an EBVS hold that arrives before any upload', async () => {
    const ref = newRef()
    await call(new Request(ORIGIN + '/api/signals', { method: 'POST', body: await signal('appeal.hold', ref) }))
    const launch = await call(postForm('/launch', { pass: await pass('upload', ref) }))
    await call(postForm('/upload', { name: 'A', statement: 'B', files: new File([PDF], 'a.pdf') }, cookiesOf(launch)))
    expect(await env.DB.prepare('SELECT ebvs_hold, location FROM cases WHERE case_ref = ?').bind(ref).first()).toEqual({ ebvs_hold: 1, location: 'hold' })
    expect((await env.EVIDENCE.list({ prefix: `hold/${ref}/` })).objects.length).toBe(1)
  })
  it('applies the country rule to statements and discussion, not only files', async () => {
    const ref = await caseWithEvidence()
    const r = await person(); await assign(ref, r.id)
    expect((await get(`/case/${ref}`, r.cookie, { cf: { country: 'US' } } as never)).status).toBe(403)
    expect((await get(`/case/${ref}/decision`, r.cookie, { cf: { country: 'US' } } as never)).status).toBe(403)
  })
  it('makes only the newest enrolment link work, and keeps the token out of the URL path', async () => {
    const admin = await person({ admin: true }), r = await person()
    const first = /\/enrol#([A-Za-z0-9_-]+)/.exec(await (await call(postForm(`/admin/person/${r.id}`, { go: 'enrol' }, admin.cookie))).text())![1]!
    const second = /\/enrol#([A-Za-z0-9_-]+)/.exec(await (await call(postForm(`/admin/person/${r.id}`, { go: 'enrol' }, admin.cookie))).text())![1]!
    expect((await registerOptions(first)).status).toBe(404)
    expect((await registerOptions(second)).status).toBe(200)
  })
  it('caps a case at 20 submissions', async () => {
    const ref = newRef()
    const launch = await call(postForm('/launch', { pass: await pass('upload', ref) }))
    for (let v = 1; v <= 20; v++) await env.DB.prepare('INSERT INTO evidence_versions (case_ref, version, statement, complete, created_at) VALUES (?, ?, ?, 1, ?)').bind(ref, v, 's', new Date().toISOString()).run()
    const res = await call(postForm('/upload', { name: 'A', statement: 'B', files: new File([PDF], 'a.pdf') }, cookiesOf(launch)))
    expect(await res.text()).toContain('already has 20 submissions')
  })
})
