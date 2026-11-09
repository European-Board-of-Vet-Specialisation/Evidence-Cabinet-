// POST /api/signals — case.closed, appeal.hold, appeal.release from My College.
// Idempotent by event_id: a signal applied once answers 200 every time after.

import type { Env } from '../env'
import { verifyFromMc, TYP, TrustError, bodyToken } from '../mc'
import { dispose, toHold, fromHold, getCase } from '../cases'
import { deliverDue } from '../outbox'
import { isCaseRef, nowIso, NO_STORE } from '../util'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...NO_STORE } })

export async function signals(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const token = await bodyToken(req)
  let p: Record<string, unknown>
  try { p = await verifyFromMc(env, token, TYP.signal, { maxAgeSec: 600 }) }
  catch (e) { return json(401, { ok: false, error: e instanceof TrustError ? e.message : 'invalid' }) }

  const eventId = p.event_id, type = p.type, ref = p.case_ref
  if (typeof eventId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(eventId)) return json(400, { ok: false, error: 'event_id' })
  if (!isCaseRef(ref)) return json(400, { ok: false, error: 'case_ref' })
  if (type !== 'case.closed' && type !== 'appeal.hold' && type !== 'appeal.release') return json(400, { ok: false, error: 'type' })

  const seen = await env.DB.prepare('SELECT 1 FROM signals_seen WHERE event_id = ?').bind(eventId).first()
  if (seen) return json(200, { ok: true, result: 'duplicate' })

  if (type === 'appeal.hold') {
    await env.DB.prepare('UPDATE cases SET ebvs_hold = 1 WHERE case_ref = ? AND state = \'open\'').bind(ref).run()
    await toHold(env, ref)
  } else {
    // case.closed: the candidate withdrew (or, for a College not deciding here, the claim closed).
    // appeal.release: the EBVS appeal is over.
    const c = await getCase(env, ref)
    if (type === 'appeal.release' && c) {
      await env.DB.prepare('UPDATE cases SET ebvs_hold = 0 WHERE case_ref = ?').bind(ref).run()
      await fromHold(env, ref)
    }
    // Not yet fully deleted: answer 503 so My College retries the same signal.
    if (!(await dispose(env, ref, type === 'case.closed' ? 'withdrawn' : 'released'))) return json(503, { ok: false, error: 'deletion incomplete' })
  }
  await env.DB.prepare('INSERT INTO signals_seen (event_id, type, case_ref, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(eventId, type, ref, nowIso()).run()
  ctx.waitUntil(deliverDue(env))
  return json(200, { ok: true, result: 'applied' })
}
