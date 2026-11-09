// Who is asking. College users (reviewers, administrators) sign in with a passkey and get a
// session; a candidate gets a short session bound to one case by an upload pass. Cookies hold a
// random ID; only its hash is stored.

import type { Env } from './env'
import { cookie, sha256, randomId, nowIso, setCookie } from './util'

export const STAFF_COOKIE = '__Host-cab_s'
export const CANDIDATE_COOKIE = '__Host-cab_c'
export const LAUNCH_COOKIE = '__Host-cab_l'
const STAFF_HOURS = 8
const CANDIDATE_MIN = 60

export interface Person {
  id: number; sub: string | null; display_name: string
  is_admin: number; can_finalise: number; can_retain: number; active: number
}

/** The signed-in College user, re-read on every request: removal takes effect at once. */
export async function staff(req: Request, env: Env): Promise<Person | null> {
  const id = cookie(req, STAFF_COOKIE); if (!id) return null
  return env.DB.prepare(`SELECT p.id, p.sub, p.display_name, p.is_admin, p.can_finalise, p.can_retain, p.active
      FROM sessions s JOIN people p ON p.id = s.person_id
      WHERE s.id_hash = ? AND s.expires_at > ? AND p.active = 1`).bind(await sha256(id), nowIso()).first<Person>()
}

export async function startStaffSession(env: Env, personId: number): Promise<string> {
  const id = randomId()
  const exp = new Date(Date.now() + STAFF_HOURS * 3_600_000).toISOString()
  await env.DB.prepare('INSERT INTO sessions (id_hash, person_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256(id), personId, nowIso(), exp).run()
  return setCookie(STAFF_COOKIE, id, STAFF_HOURS * 3600)
}

export async function endStaffSession(req: Request, env: Env): Promise<void> {
  const id = cookie(req, STAFF_COOKIE); if (id) await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await sha256(id)).run()
}

export async function candidate(req: Request, env: Env): Promise<{ sub: string; case_ref: string } | null> {
  const id = cookie(req, CANDIDATE_COOKIE); if (!id) return null
  return env.DB.prepare('SELECT sub, case_ref FROM candidate_sessions WHERE id_hash = ? AND expires_at > ?').bind(await sha256(id), nowIso()).first()
}

export async function startCandidateSession(env: Env, sub: string, ref: string): Promise<string> {
  const id = randomId()
  const exp = new Date(Date.now() + CANDIDATE_MIN * 60_000).toISOString()
  await env.DB.prepare('INSERT INTO candidate_sessions (id_hash, sub, case_ref, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256(id), sub, ref, exp).run()
  return setCookie(CANDIDATE_COOKIE, id, CANDIDATE_MIN * 60)
}

/** Is this person assigned to this case right now? Asked on every request that touches a case. */
export async function assigned(env: Env, personId: number, ref: string): Promise<boolean> {
  return !!(await env.DB.prepare('SELECT 1 FROM assignments WHERE case_ref = ? AND person_id = ? AND revoked_at IS NULL').bind(ref, personId).first())
}
