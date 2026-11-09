// Trust between this cabinet and My College (docs/interface.md).
//
//   inbound   launch passes, signals and pairing tests, signed by My College (EdDSA). Verified
//             against My College's published keys, and against THIS cabinet: issuer, audience
//             (our origin), College, type and time. EdDSA only, whatever a header claims.
//   outbound  events, signed with the College's key. My College verifies them against the public
//             key the College pasted into My College when it paired.

import { createRemoteJWKSet, jwtVerify, CompactSign, importJWK, calculateJwkThumbprint, type JWK, type JWTPayload, type JWTVerifyGetKey } from 'jose'
import type { Env } from './env'
import { nowSec } from './util'

export const TYP = { launch: 'ec-launch+jwt', signal: 'ec-signal+jwt', pair: 'ec-pair+jwt', event: 'ec-event+jwt' } as const
export const PASS_TTL = 120

export class TrustError extends Error {}

// My College's keys, cached per isolate. jose refetches on an unknown kid, so a rotation on
// My College's side is picked up without a redeploy here.
let jwks: { url: string; set: JWTVerifyGetKey } | null = null
function mcKeys(env: Env) {
  const url = `${env.MC_BASE.replace(/\/$/, '')}/api/ec/keys`
  if (!jwks || jwks.url !== url) jwks = { url, set: createRemoteJWKSet(new URL(url), { cacheMaxAge: 3_600_000, cooldownDuration: 30_000 }) }
  return jwks.set
}
/** Tests swap My College's keys for their own. */
export function setMcKeysForTest(set: JWTVerifyGetKey | null, url = '') { jwks = set ? { url, set } : null }

/** Verify something My College signed for this cabinet. Throws TrustError with a reason that is safe to log. */
export async function verifyFromMc(env: Env, token: string, typ: string, opts: { maxAgeSec?: number } = {}): Promise<JWTPayload & Record<string, unknown>> {
  if (typeof token !== 'string' || token.length > 4096 || token.split('.').length !== 3) throw new TrustError('malformed')
  let payload: JWTPayload
  try {
    ({ payload } = await jwtVerify(token, mcKeys(env), {
      algorithms: ['EdDSA'], typ, issuer: env.MC_ISSUER, audience: env.CABINET_ORIGIN, clockTolerance: 60,
      ...(opts.maxAgeSec ? { maxTokenAge: opts.maxAgeSec } : {}),
    }))
  } catch (e) {
    throw new TrustError(e instanceof Error ? (e as { code?: string }).code ?? 'invalid' : 'invalid')
  }
  if (payload.college !== env.COLLEGE) throw new TrustError('college')
  return payload as JWTPayload & Record<string, unknown>
}

// ── the College's signing key ────────────────────────────────────────────────

interface SigningKey { key: CryptoKey | Uint8Array; kid: string }
const keyCache = new Map<string, SigningKey>()

async function loadKey(raw: string): Promise<SigningKey> {
  const cached = keyCache.get(raw); if (cached) return cached
  let jwk: JWK
  try { jwk = JSON.parse(raw) } catch { throw new Error('COLLEGE_SIGNING_KEY is not JSON') }
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.d || !jwk.x) throw new Error('COLLEGE_SIGNING_KEY must be a private Ed25519 JWK')
  const kid = await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: jwk.x }, 'sha256')
  const k = { key: await importJWK({ ...jwk, alg: 'EdDSA' }, 'EdDSA'), kid }
  keyCache.set(raw, k)
  return k
}

/** The public half, for the setup wizard to show. */
export async function publicJwk(env: Env): Promise<{ jwk: JWK; kid: string } | null> {
  const raw = env.COLLEGE_SIGNING_KEY
  if (!raw) return null
  const j = JSON.parse(raw) as JWK
  return { jwk: { kty: 'OKP', crv: 'Ed25519', x: j.x }, kid: await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: j.x }, 'sha256') }
}

/** Sign an event for My College. `iat` is always now: a retry is re-signed, never replayed. */
export async function signEvent(env: Env, fields: Record<string, unknown>): Promise<string> {
  const k = await loadKey(env.COLLEGE_SIGNING_KEY)
  const body = { ...fields, iss: env.CABINET_ORIGIN, aud: env.MC_ISSUER, college: env.COLLEGE, iat: nowSec() }
  return new CompactSign(new TextEncoder().encode(JSON.stringify(body)))
    .setProtectedHeader({ alg: 'EdDSA', typ: TYP.event, kid: k.kid })
    .sign(k.key)
}

/** Where events go. */
export const eventsUrl = (env: Env) => `${env.MC_BASE.replace(/\/$/, '')}/api/ec/events/${encodeURIComponent(env.COLLEGE)}`

/** A signed body, read as bytes: it is ASCII, and the runtime warns on .text() for application/jose. */
export async function bodyToken(req: Request): Promise<string> {
  const buf = await req.arrayBuffer()
  return buf.byteLength > 16_384 ? '' : new TextDecoder().decode(buf).trim()
}
