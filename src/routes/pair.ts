// POST /api/pair — the signed two-way test. My College signs a nonce for this cabinet; the
// cabinet answers with the same nonce signed by the College's key. Both directions proved.

import type { Env } from '../env'
import { verifyFromMc, signEvent, TYP, TrustError, bodyToken } from '../mc'
import { NO_STORE } from '../util'

export async function pair(req: Request, env: Env): Promise<Response> {
  let p: Record<string, unknown>
  try { p = await verifyFromMc(env, await bodyToken(req), TYP.pair, { maxAgeSec: 300 }) }
  catch (e) { return new Response(JSON.stringify({ ok: false, error: e instanceof TrustError ? e.message : 'invalid' }), { status: 401, headers: { 'Content-Type': 'application/json', ...NO_STORE } }) }
  if (p.type !== 'pairing.test' || typeof p.nonce !== 'string' || p.nonce.length > 100) {
    return new Response(JSON.stringify({ ok: false, error: 'pairing.test' }), { status: 400, headers: { 'Content-Type': 'application/json', ...NO_STORE } })
  }
  const ack = await signEvent(env, { type: 'pairing.ack', nonce: p.nonce })
  return new Response(ack, { status: 200, headers: { 'Content-Type': 'application/jose', ...NO_STORE } })
}
