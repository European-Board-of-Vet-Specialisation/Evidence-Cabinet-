// My College, played by the tests: its own key pair, passes and signals signed with it.

import { env as rawEnv, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { generateKeyPair, exportJWK, calculateJwkThumbprint, SignJWT, createLocalJWKSet, compactVerify, importJWK, type JWK } from 'jose'
import worker from '../src/index'
import { setMcKeysForTest, TYP } from '../src/mc'
import type { Env } from '../src/env'

/** The test runtime's env, typed as the cabinet's. */
export const env = rawEnv as unknown as Env

export const ORIGIN = 'https://cabinet.test'
export const SUB = 'p_' + 'A'.repeat(24)
export const SUB2 = 'p_' + 'B'.repeat(24)
const B32 = 'abcdefghijkmnpqrstuvwxyz23456789'
export const newRef = () => 'ec-' + Array.from(crypto.getRandomValues(new Uint8Array(26)), b => B32[b & 31]).join('')

let mc: { key: CryptoKey; kid: string } | null = null
export async function mcKeys() {
  if (mc) return mc
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true })
  const pub = await exportJWK(publicKey)
  const kid = await calculateJwkThumbprint(pub, 'sha256')
  setMcKeysForTest(createLocalJWKSet({ keys: [{ ...pub, kid, alg: 'EdDSA', use: 'sig' }] }), 'https://mc.test/api/ec/keys')
  mc = { key: privateKey as CryptoKey, kid }
  return mc
}

/** Something My College would sign. `over` replaces any claim, including iss/aud/college. */
export async function mcSign(typ: string, claims: Record<string, unknown>, over: { ttl?: number; iat?: number; key?: CryptoKey } = {}) {
  const k = await mcKeys()
  const iat = over.iat ?? Math.floor(Date.now() / 1000)
  return new SignJWT({ iss: 'https://mc.test/ec', aud: ORIGIN, college: 'ECVN', ...claims })
    .setProtectedHeader({ alg: 'EdDSA', typ, kid: k.kid })
    .setIssuedAt(iat).setExpirationTime(iat + (over.ttl ?? 120))
    .sign(over.key ?? k.key)
}

export const pass = (act: 'upload' | 'review' | 'inbox', ref: string | null, over: Record<string, unknown> = {}, opt: { ttl?: number; iat?: number; key?: CryptoKey } = {}) =>
  mcSign(TYP.launch, { sub: SUB, role: act === 'upload' ? 'candidate' : 'reviewer', act, ...(ref ? { case_ref: ref } : {}), jti: crypto.randomUUID(), ...over }, opt)

export const signal = (type: string, ref: string, over: Record<string, unknown> = {}) =>
  mcSign(TYP.signal, { event_id: crypto.randomUUID(), type, case_ref: ref, at: new Date().toISOString(), ...over })

export async function call(req: Request) {
  await mcKeys()
  if (!(req as Request & { cf?: unknown }).cf) req = new Request(req, { cf: { country: 'IE' } } as RequestInit)
  const ctx = createExecutionContext()
  const res = await worker.fetch(req, env, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

export const postForm = (path: string, fields: Record<string, string | Blob>, cookie = '') => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  return new Request(ORIGIN + path, { method: 'POST', body: fd, headers: cookie ? { cookie } : {} })
}

export const cookiesOf = (res: Response) => res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')

/** The College's public key, to check what the cabinet signs. */
export async function collegeVerify(token: string) {
  const jwk = JSON.parse(env.COLLEGE_SIGNING_KEY) as JWK
  const key = await importJWK({ kty: 'OKP', crv: 'Ed25519', x: jwk.x }, 'EdDSA')
  const { payload, protectedHeader } = await compactVerify(token, key)
  return { body: JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>, header: protectedHeader }
}

/** Intercept calls to My College's events endpoint. */
export function mockMc(answer: (body: Record<string, unknown>) => { status: number; json?: unknown }) {
  const seen: Array<Record<string, unknown>> = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('https://mc.test/api/ec/events/')) {
      const { body } = await collegeVerify(typeof init?.body === 'string' ? init.body : new TextDecoder().decode(init?.body as ArrayBuffer))
      seen.push(body)
      const a = answer(body)
      return new Response(JSON.stringify(a.json ?? { ok: true, result: 'applied' }), { status: a.status })
    }
    return real(input, init)
  }) as typeof fetch
  return { seen, restore: () => { globalThis.fetch = real } }
}

export const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

/** A College user with a live session. */
export async function person(opts: { sub?: string | null; admin?: boolean; finalise?: boolean; retain?: boolean; name?: string } = {}) {
  const { startStaffSession } = await import('../src/session')
  const p = await env.DB.prepare('INSERT INTO people (sub, display_name, is_admin, can_finalise, can_retain, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(opts.sub === undefined ? 'p_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24) : opts.sub, opts.name ?? 'Reviewer', opts.admin ? 1 : 0, opts.finalise ? 1 : 0, opts.retain ? 1 : 0, new Date().toISOString()).first<{ id: number }>()
  const cookie = (await startStaffSession(env, p!.id)).split(';')[0]!
  const sub = await env.DB.prepare('SELECT sub FROM people WHERE id = ?').bind(p!.id).first<string>('sub')
  return { id: p!.id, cookie, sub }
}
export const assign = (ref: string, personId: number) =>
  env.DB.prepare('INSERT INTO assignments (case_ref, person_id, assigned_at) VALUES (?, ?, ?)').bind(ref, personId, new Date().toISOString()).run()

/** A case with one submission (statement + a PDF), uploaded by the candidate through a pass. */
export async function caseWithEvidence(ctx: Record<string, unknown> | null = null) {
  const ref = newRef()
  const launch = await call(postForm('/launch', { pass: await pass('upload', ref, ctx ? { ctx } : {}) }))
  const up = await call(postForm('/upload', { name: 'Test Candidate', statement: 'My account.', files: new File([PDF], 'letter.pdf') }, cookiesOf(launch)))
  if (!(await up.text()).includes('Received')) throw new Error('upload failed')
  return ref
}
export const get = (path: string, cookie = '', init: RequestInit & { cf?: Record<string, unknown> } = {}) =>
  call(new Request(ORIGIN + path, { ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string> ?? {}) } }))
