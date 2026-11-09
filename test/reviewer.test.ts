import { describe, it, expect } from 'vitest'
import { call, get, postForm, person, assign, caseWithEvidence, env, ORIGIN, mockMc } from './helpers'

const outboxOf = async (type: string) => (await env.DB.prepare('SELECT body FROM outbox WHERE type = ? ORDER BY id DESC').bind(type).all<{ body: string }>()).results.map(r => JSON.parse(r.body))

describe('setup wizard', () => {
  it('needs the setup token, then sends the first administrator to enrol a passkey, once', async () => {
    const page = await (await get('/setup')).text()
    expect(page).toContain('First administrator')
    expect(page).toContain('Cabinet public key')
    const wrong = await call(postForm('/setup', { token: 'wrong', name: 'Ada' }))
    expect(await wrong.text()).toContain('not right')
    const ok = await call(postForm('/setup', { token: 'test-setup-token-0123456789', name: 'Ada' }))
    expect(ok.status).toBe(303)
    const enrol = await get(ok.headers.get('location')!)
    expect(await enrol.text()).toContain('Create your passkey')
    const opts = await call(new Request(ORIGIN + '/api/passkey/register/options', { method: 'POST', body: JSON.stringify({ token: ok.headers.get('location')!.split('/').pop() }), headers: { 'Content-Type': 'application/json' } }))
    const j = await opts.json<{ ok: boolean; options: { rp: { id: string }; authenticatorSelection: { userVerification: string } } }>()
    expect(j.options.rp.id).toBe('cabinet.test')
    expect(j.options.authenticatorSelection.userVerification).toBe('required')
    // Once an administrator exists, the token does nothing.
    expect(await (await call(postForm('/setup', { token: 'test-setup-token-0123456789', name: 'Eve' }))).text()).toContain('set up')
  })
})

describe('discussion (DISC-01 to DISC-04)', () => {
  it('notifies the other assigned reviewers, never the author, with no case or text', async () => {
    const ref = await caseWithEvidence()
    const [a, b, c] = [await person(), await person(), await person()]
    for (const p of [a, b, c]) await assign(ref, p.id)
    const res = await call(postForm(`/case/${ref}/comment`, { body: 'The letter covers the exam week.' }, a.cookie))
    expect(res.status).toBe(303)
    const n = (await outboxOf('reviewer.notification_requested'))[0]
    expect(n.kind).toBe('comment')
    expect(new Set(n.recipients)).toEqual(new Set([b.sub, c.sub]))
    expect(JSON.stringify(n)).not.toContain('letter')
    expect(JSON.stringify(n)).not.toContain(ref)
    const page = await (await get(`/case/${ref}`, b.cookie)).text()
    expect(page).toContain('The letter covers the exam week.')
  })
  it('keeps the original when a comment is corrected, and lets only the author correct', async () => {
    const ref = await caseWithEvidence()
    const [a, b] = [await person({ name: 'Ann' }), await person({ name: 'Bob' })]
    await assign(ref, a.id); await assign(ref, b.id)
    await call(postForm(`/case/${ref}/comment`, { body: 'Original remark.' }, a.cookie))
    const id = await env.DB.prepare('SELECT id FROM comments WHERE case_ref = ? ORDER BY id DESC').bind(ref).first<number>('id')
    expect(await (await call(postForm(`/case/${ref}/comment/${id}/correct`, { body: 'Bob edits.' }, b.cookie))).text()).toContain('only your own')
    await call(postForm(`/case/${ref}/comment/${id}/correct`, { body: 'Corrected remark.' }, a.cookie))
    const page = await (await get(`/case/${ref}`, b.cookie)).text()
    expect(page).toContain('Original remark.')
    expect(page).toContain('Corrected remark.')
    expect(page).toContain('correction by Ann')
  })
  it('refuses the case, its discussion and its evidence once the assignment is revoked', async () => {
    const ref = await caseWithEvidence()
    const a = await person(); await assign(ref, a.id)
    expect((await get(`/case/${ref}`, a.cookie)).status).toBe(200)
    await env.DB.prepare('UPDATE assignments SET revoked_at = ? WHERE person_id = ?').bind(new Date().toISOString(), a.id).run()
    expect((await get(`/case/${ref}`, a.cookie)).status).toBe(403)
    expect((await call(postForm(`/case/${ref}/comment`, { body: 'x' }, a.cookie))).status).toBe(403)
  })
})

describe('evidence viewer (spec §8)', () => {
  it('serves bytes only to the viewer, from an allowed country, and logs each view', async () => {
    const ref = await caseWithEvidence()
    const a = await person(); await assign(ref, a.id)
    const file = await env.DB.prepare('SELECT id FROM files WHERE case_ref = ?').bind(ref).first<string>('id')
    const raw = `/case/${ref}/file/${file}/raw`
    const viewer = await get(`/case/${ref}/file/${file}`, a.cookie, { cf: { country: 'IE' } })
    expect(await viewer.text()).toContain('data-mark="Reviewer')
    expect((await get(raw, a.cookie, { cf: { country: 'IE' } })).status).toBe(400)   // a plain link
    expect((await get(raw, a.cookie, { cf: { country: 'US' }, headers: { 'X-Cabinet-Viewer': '1' } })).status).toBe(403)
    const ok = await get(raw, a.cookie, { cf: { country: 'IE' }, headers: { 'X-Cabinet-Viewer': '1' } })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('Cache-Control')).toBe('private, no-store')
    expect(ok.headers.get('Content-Type')).toBe('application/pdf')
    expect(await env.DB.prepare('SELECT country FROM view_log WHERE case_ref = ? AND person_id = ?').bind(ref, a.id).first('country')).toBe('IE')
  })
})

describe('decisions (spec §6.1)', () => {
  const ctx = { relates_to: 'examination', subject: 'Examination — 2027 diet', types: ['deferral', 'extra_time', 'other'], cycles: [{ id: 12, label: 'Diet 2028' }], codes: [{ code: 'SCRIBE', label: 'Scribe' }] }
  it('drafts by any reviewer, finalises by the designated person, and sends no rationale', async () => {
    const ref = await caseWithEvidence(ctx)
    const reviewer = await person(), chair = await person({ finalise: true })
    await assign(ref, reviewer.id); await assign(ref, chair.id)
    const form = { decision_type: 'initial', outcome: 'upheld', 'adj.deferral.on': '1', 'adj.deferral.cycle_id': '12', rationale: 'Hospital letter is convincing.', considered: '1' }
    const draft = await call(postForm(`/case/${ref}/decision/draft`, { ...form, go: 'save' }, reviewer.cookie))
    expect(await draft.text()).toContain('Draft saved')
    expect(await (await call(postForm(`/case/${ref}/decision/draft`, { ...form, go: 'preview' }, reviewer.cookie))).text()).toContain('designates')
    const preview = await (await call(postForm(`/case/${ref}/decision/draft`, { ...form, go: 'preview' }, chair.cookie))).text()
    expect(preview).toContain('&quot;cycle_id&quot;: 12')
    expect(preview).not.toContain('Hospital letter')
    const draftId = await env.DB.prepare('SELECT id FROM decisions WHERE case_ref = ? AND version IS NULL').bind(ref).first<number>('id')
    const mc = mockMc(() => ({ status: 200, json: { ok: true, result: 'recorded', version: 1 } }))
    try {
      const fin = await call(postForm(`/case/${ref}/decision/finalise`, { draft: String(draftId), version: '1' }, chair.cookie))
      expect(fin.status).toBe(303)
      const sent = mc.seen.find(b => b.type === 'claim.decision_finalised')!
      expect(sent).toMatchObject({ case_ref: ref, version: 1, decision_type: 'initial', outcome: 'upheld', adjustments: [{ type: 'deferral', params: { cycle_id: 12 } }] })
      expect(JSON.stringify(sent)).not.toContain('Hospital')
      expect(await (await get(`/case/${ref}/decision`, reviewer.cookie)).text()).toContain('Recorded in My College')
    } finally { mc.restore() }
    // A stale form cannot finalise the same version twice.
    expect(await (await call(postForm(`/case/${ref}/decision/finalise`, { draft: String(draftId), version: '1' }, chair.cookie))).text()).toContain('changed')
  })
  it('makes a correction a new version linked to the one before', async () => {
    const ref = await caseWithEvidence(ctx)
    const chair = await person({ finalise: true }); await assign(ref, chair.id)
    const fin = async (outcome: string, type: string) => {
      await call(postForm(`/case/${ref}/decision/draft`, { decision_type: type, outcome, go: 'save' }, chair.cookie))
      const id = await env.DB.prepare('SELECT id FROM decisions WHERE case_ref = ? AND version IS NULL').bind(ref).first<number>('id')
      const v = ((await env.DB.prepare('SELECT MAX(version) AS v FROM decisions WHERE case_ref = ?').bind(ref).first<number>('v')) ?? 0) + 1
      return call(postForm(`/case/${ref}/decision/finalise`, { draft: String(id), version: String(v) }, chair.cookie))
    }
    await fin('not_upheld', 'initial'); await fin('upheld', 'appeal')
    const rows = (await env.DB.prepare('SELECT id, version, decision_type, supersedes FROM decisions WHERE case_ref = ? ORDER BY version').bind(ref).all<{ id: number; version: number; decision_type: string; supersedes: number | null }>()).results
    expect(rows.map(r => [r.version, r.decision_type])).toEqual([[1, 'initial'], [2, 'appeal']])
    expect(rows[1]!.supersedes).toBe(rows[0]!.id)
  })
})

describe('administration', () => {
  it('assigns and revokes, and removing a person ends their session at once', async () => {
    const ref = await caseWithEvidence()
    const admin = await person({ admin: true }), r = await person()
    await call(postForm(`/admin/case/${ref}/assign`, { assign: String(r.id) }, admin.cookie))
    expect((await get(`/case/${ref}`, r.cookie)).status).toBe(200)
    await call(postForm(`/admin/case/${ref}/assign`, { revoke: String(r.id) }, admin.cookie))
    expect((await get(`/case/${ref}`, r.cookie)).status).toBe(403)
    await call(postForm(`/admin/person/${r.id}`, { go: 'remove' }, admin.cookie))
    expect((await get('/cases', r.cookie)).headers.get('location')).toContain('/signin')
  })
  it('never removes the last administrator', async () => {
    await env.DB.prepare('UPDATE people SET active = 0 WHERE is_admin = 1').run()
    const admin = await person({ admin: true })
    expect(await (await call(postForm(`/admin/person/${admin.id}`, { go: 'remove' }, admin.cookie))).text()).toContain('at least one administrator')
  })
  it('lets an assigned member allowed to retain flag a case, which moves it to hold/', async () => {
    const ref = await caseWithEvidence()
    const m = await person({ retain: true }); await assign(ref, m.id)
    expect((await call(postForm(`/case/${ref}/retain`, { go: 'flag', reason: 'Pending litigation' }, m.cookie))).status).toBe(303)
    expect(await env.DB.prepare('SELECT retain_reason FROM cases WHERE case_ref = ?').bind(ref).first('retain_reason')).toBe('Pending litigation')
    expect((await env.EVIDENCE.list({ prefix: `hold/${ref}/` })).objects.length).toBe(1)
    const outsider = await person({ retain: true })
    expect((await call(postForm(`/case/${ref}/retain`, { go: 'clear' }, outsider.cookie))).status).toBe(403)
  })
  it('lets an administrator dispose of a case, which tells My College', async () => {
    const ref = await caseWithEvidence()
    const admin = await person({ admin: true })
    expect(await (await call(postForm(`/admin/case/${ref}/dispose`, {}, admin.cookie))).text()).toContain('Tick the confirmation')
    await call(postForm(`/admin/case/${ref}/dispose`, { confirm: '1' }, admin.cookie))
    expect(await env.DB.prepare('SELECT state, disposed_why FROM cases WHERE case_ref = ?').bind(ref).first()).toEqual({ state: 'disposed', disposed_why: 'closed' })
    expect((await outboxOf('evidence.deleted')).some(b => b.case_ref === ref)).toBe(true)
  })
})
