// A case's life in the cabinet: created by the first upload pass, moved to hold/ and back,
// and disposed of — objects first, then the sensitive records, then the confirmation to My
// College. Object keys: {cases|hold}/{case_ref}/{version}/{file_id}.

import type { Env } from './env'
import { queueEvent } from './outbox'
import { nowIso } from './util'

export interface CaseRow {
  case_ref: string; candidate_sub: string | null; state: string; location: 'cases' | 'hold'; ebvs_hold: number
  retain_until: string | null; retain_reason: string | null; retain_by: number | null
  created_at: string; last_activity_at: string; reminded_retention_at: string | null; reminded_deletion_at: string | null
  disposed_at: string | null; disposed_why: string | null
  context: string | null; candidate_name: string | null
}

export const getCase = (env: Env, ref: string) => env.DB.prepare('SELECT * FROM cases WHERE case_ref = ?').bind(ref).first<CaseRow>()

/** First contact for a case: an upload pass. Idempotent; a disposed case is not revived. */
export async function ensureCase(env: Env, ref: string, sub: string | null, context: unknown = null): Promise<CaseRow | null> {
  const now = nowIso()
  const ctx = context ? JSON.stringify(context) : null
  await env.DB.batch([
    env.DB.prepare('INSERT INTO cases (case_ref, candidate_sub, created_at, last_activity_at, context) VALUES (?, ?, ?, ?, ?) ON CONFLICT(case_ref) DO NOTHING').bind(ref, sub, now, now, ctx),
    // The candidate is whoever first opened it to upload; the context is My College's latest.
    env.DB.prepare('UPDATE cases SET candidate_sub = COALESCE(candidate_sub, ?), context = COALESCE(?, context) WHERE case_ref = ? AND state = \'open\'').bind(sub, ctx, ref),
  ])
  return getCase(env, ref)
}

/** Activity restarts the 18-month clock and clears a deletion reminder that no longer applies. */
export const touchStmt = (env: Env, ref: string) =>
  env.DB.prepare('UPDATE cases SET last_activity_at = ?, reminded_deletion_at = NULL WHERE case_ref = ? AND state = \'open\'').bind(nowIso(), ref)

export const objectKey = (location: string, ref: string, version: number, fileId: string) => `${location}/${ref}/${version}/${fileId}`

async function keysUnder(env: Env, prefix: string): Promise<string[]> {
  const out: string[] = []
  let cursor: string | undefined
  do {
    const page = await env.EVIDENCE.list({ prefix, cursor })
    out.push(...page.objects.map(o => o.key))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out
}

/** Move every object between prefixes: copy, then delete the original. */
async function moveObjects(env: Env, ref: string, from: 'cases' | 'hold', to: 'cases' | 'hold'): Promise<void> {
  for (const key of await keysUnder(env, `${from}/${ref}/`)) {
    const obj = await env.EVIDENCE.get(key)
    if (!obj) continue
    await env.EVIDENCE.put(`${to}/${key.slice(from.length + 1)}`, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata })
    await env.EVIDENCE.delete(key)
  }
}

/** EBVS appeal hold or a retention flag: keep the case out of reach of the lifecycle rule. */
export async function toHold(env: Env, ref: string): Promise<void> {
  const c = await getCase(env, ref)
  if (!c || c.state !== 'open' || c.location === 'hold') return
  await moveObjects(env, ref, 'cases', 'hold')
  await env.DB.prepare('UPDATE cases SET location = \'hold\' WHERE case_ref = ?').bind(ref).run()
}

/** Back from hold when nothing keeps it there any more. */
export async function fromHold(env: Env, ref: string): Promise<void> {
  const c = await getCase(env, ref)
  if (!c || c.state !== 'open' || c.location !== 'hold' || c.ebvs_hold || (c.retain_until && new Date(c.retain_until) > new Date())) return
  await moveObjects(env, ref, 'hold', 'cases')
  await env.DB.prepare('UPDATE cases SET location = \'cases\' WHERE case_ref = ?').bind(ref).run()
}

export type DisposeWhy = 'withdrawn' | 'closed' | 'released' | 'retention' | 'backstop'

/**
 * Dispose of a case: delete its objects under both prefixes, confirm both are empty, delete its
 * sensitive records, and — in the same batch — queue evidence.deleted. If any object survives,
 * nothing is reported and the next run tries again: My College is never told "deleted" early.
 */
export async function dispose(env: Env, ref: string, why: DisposeWhy): Promise<boolean> {
  const c = await getCase(env, ref)
  if (!c) {
    // Never uploaded to: still answer, so My College can close the claim.
    await env.DB.batch([
      env.DB.prepare('INSERT INTO cases (case_ref, state, created_at, last_activity_at, disposed_at, disposed_why) VALUES (?, \'disposed\', ?, ?, ?, ?) ON CONFLICT(case_ref) DO NOTHING').bind(ref, nowIso(), nowIso(), nowIso(), why),
      queueEvent(env, 'evidence.deleted', { case_ref: ref, version: 0, status: 'deleted', at: nowIso() }),
    ])
    return true
  }
  if (c.state === 'disposed') return true
  for (const prefix of ['cases', 'hold']) {
    const keys = await keysUnder(env, `${prefix}/${ref}/`)
    for (let i = 0; i < keys.length; i += 1000) await env.EVIDENCE.delete(keys.slice(i, i + 1000))
  }
  const left = (await keysUnder(env, `cases/${ref}/`)).length + (await keysUnder(env, `hold/${ref}/`)).length
  if (left) return false
  const at = nowIso()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM evidence_versions WHERE case_ref = ?').bind(ref),
    env.DB.prepare('DELETE FROM files WHERE case_ref = ?').bind(ref),
    env.DB.prepare('DELETE FROM comments WHERE case_ref = ?').bind(ref),
    env.DB.prepare('DELETE FROM reads WHERE case_ref = ?').bind(ref),
    env.DB.prepare('DELETE FROM decisions WHERE case_ref = ?').bind(ref),
    env.DB.prepare('DELETE FROM view_log WHERE case_ref = ?').bind(ref),
    env.DB.prepare('DELETE FROM assignments WHERE case_ref = ?').bind(ref),
    env.DB.prepare('DELETE FROM candidate_sessions WHERE case_ref = ?').bind(ref),
    // Delivered events about it carry its outcome and adjustments: gone with the case. Undelivered
    // ones stay, so My College still learns of every decision.
    env.DB.prepare('DELETE FROM outbox WHERE state = \'sent\' AND json_extract(body, \'$.case_ref\') = ?').bind(ref),
    env.DB.prepare('UPDATE cases SET state = \'disposed\', candidate_sub = NULL, candidate_name = NULL, context = NULL, retain_reason = NULL, retain_until = NULL, disposed_at = ?, disposed_why = ? WHERE case_ref = ?').bind(at, why, ref),
    queueEvent(env, 'evidence.deleted', { case_ref: ref, version: 0, status: 'deleted', at }),
  ])
  return true
}
