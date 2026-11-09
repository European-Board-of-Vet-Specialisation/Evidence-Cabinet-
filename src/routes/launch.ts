// POST /launch — a one-use pass from My College, posted by the person's browser.
//
//   upload   the candidate: the pass is enough, for this one case, for an hour.
//   review   a reviewer, one case.       } The pass NAMES the person; it never admits them. They
//   inbox    a reviewer, their case list. } must also be signed in here, as the same person
//                                          (their `sub`), and for review hold a live assignment.

import type { Env } from '../env'
import { verifyFromMc, TYP, PASS_TTL, TrustError } from '../mc'
import { ensureCase } from '../cases'
import { staff, assigned, startCandidateSession, LAUNCH_COOKIE } from '../session'
import { isCaseRef, isSub, nowIso, randomId, sha256, setCookie, clearCookie, cookie } from '../util'
import { parseContext } from '../context'
import { page, notice } from '../ui/layout'

const redirect = (to: string, ...cookies: string[]) => {
  const h = new Headers({ Location: to, 'Cache-Control': 'no-store' })
  for (const c of cookies) h.append('Set-Cookie', c)
  return new Response(null, { status: 303, headers: h })
}
const refuse = (env: Env, why: string) => page(env, 'Cannot open', notice(`This link cannot be used: ${why}. Go back to My College and try again.`), 403)

export async function launch(req: Request, env: Env): Promise<Response> {
  const form = await req.formData().catch(() => null)
  const pass = form?.get('pass')
  if (typeof pass !== 'string') return refuse(env, 'no pass')

  let p: Record<string, unknown>
  try { p = await verifyFromMc(env, pass, TYP.launch, { maxAgeSec: PASS_TTL }) }
  catch (e) { return refuse(env, e instanceof TrustError && e.message === 'ERR_JWT_EXPIRED' ? 'it has expired' : 'it is not valid here') }

  const exp = Number(p.exp), iat = Number(p.iat)
  if (!Number.isFinite(exp) || !Number.isFinite(iat) || exp - iat > PASS_TTL) return refuse(env, 'it lives too long')
  if (typeof p.jti !== 'string' || p.jti.length > 64) return refuse(env, 'it has no nonce')
  if (!isSub(p.sub)) return refuse(env, 'it names nobody')
  const act = p.act
  if (act !== 'upload' && act !== 'review' && act !== 'inbox') return refuse(env, 'unknown action')
  const ref = act === 'inbox' ? null : p.case_ref
  if (act !== 'inbox' && !isCaseRef(ref)) return refuse(env, 'no case')
  if ((act === 'upload') !== (p.role === 'candidate')) return refuse(env, 'wrong role')

  // Redeem the nonce once, atomically. Expired nonces are pruned by the daily job.
  const fresh = await env.DB.prepare('INSERT INTO nonces (jti, exp) VALUES (?, ?) ON CONFLICT(jti) DO NOTHING').bind(p.jti, exp).run()
  if (!fresh.meta.changes) return refuse(env, 'it has already been used')

  if (act === 'upload') {
    const c = await ensureCase(env, ref as string, p.sub, parseContext(p.ctx))
    if (!c || c.state !== 'open') return page(env, 'Claim closed', notice('This claim is closed. Its evidence has been deleted.'))
    if (c.candidate_sub && c.candidate_sub !== p.sub) return refuse(env, 'it is for someone else')
    return redirect('/upload', await startCandidateSession(env, p.sub, ref as string))
  }

  // A review pass carries My College's current decision context for the case.
  if (act === 'review') {
    const c = await ensureCase(env, ref as string, null, parseContext(p.ctx))
    if (!c || c.state !== 'open') return page(env, 'Claim closed', notice('This case has been closed and its evidence deleted.'))
  }

  // review / inbox: hold the pass for ten minutes while the reviewer signs in, if they must.
  const id = randomId()
  await env.DB.prepare('INSERT INTO pending_launches (id_hash, sub, act, case_ref, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256(id), p.sub, act, ref, new Date(Date.now() + 600_000).toISOString()).run()
  return redirect('/launch/continue', setCookie(LAUNCH_COOKIE, id, 600))
}

/** GET /launch/continue — after sign-in (or straight away if already signed in). */
export async function launchContinue(req: Request, env: Env): Promise<Response> {
  const id = cookie(req, LAUNCH_COOKIE)
  if (!id) return redirect('/cases')
  const pending = await env.DB.prepare('SELECT sub, act, case_ref FROM pending_launches WHERE id_hash = ? AND expires_at > ?')
    .bind(await sha256(id), nowIso()).first<{ sub: string; act: string; case_ref: string | null }>()
  if (!pending) return redirect('/cases', clearCookie(LAUNCH_COOKIE))
  const me = await staff(req, env)
  if (!me) return redirect('/signin?next=/launch/continue')
  // Used either way: a mismatch must not be retried by someone else on this browser.
  await env.DB.prepare('DELETE FROM pending_launches WHERE id_hash = ?').bind(await sha256(id)).run()
  if (me.sub !== pending.sub) return page(env, 'Not you', notice('This link was issued to someone else. Sign out and sign in as yourself.'), 403)
  if (pending.act === 'inbox') return redirect('/cases', clearCookie(LAUNCH_COOKIE))
  if (!(await assigned(env, me.id, pending.case_ref!))) return page(env, 'Not assigned', notice('You are not assigned to this case. Ask your College administrator.'), 403)
  return redirect(`/case/${pending.case_ref}`, clearCookie(LAUNCH_COOKIE))
}
