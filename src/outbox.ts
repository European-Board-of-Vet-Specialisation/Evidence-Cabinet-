// Events to My College. Each is written in the SAME D1 batch as the record it reports (a
// receipt, a comment, a decision), so neither can exist without the other; then delivered and
// retried until My College acknowledges it. A retry carries the same event_id and a fresh iat.

import type { Env } from './env'
import { signEvent, eventsUrl } from './mc'
import { classify, nextAttempt, MAX_ATTEMPTS } from './policy'
import { nowIso } from './util'

export type EventType = 'evidence.received' | 'evidence.deleted' | 'reviewer.notification_requested' | 'claim.decision_finalised'

/** A prepared insert, to put in the caller's batch. */
export function queueEvent(env: Env, type: EventType, fields: Record<string, unknown>, decisionId: number | null = null): D1PreparedStatement {
  const eventId = crypto.randomUUID()
  const now = nowIso()
  return env.DB.prepare('INSERT INTO outbox (event_id, type, body, decision_id, state, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, \'pending\', 0, ?, ?)')
    .bind(eventId, type, JSON.stringify({ ...fields, event_id: eventId, type }), decisionId, now, now)
}

interface Row { id: number; event_id: string; type: string; body: string; decision_id: number | null; attempts: number }

/** Deliver what is due. Safe to run concurrently with itself: a row is claimed before it is sent. */
export async function deliverDue(env: Env, limit = 25): Promise<{ sent: number; failed: number }> {
  const now = nowIso()
  const due = (await env.DB.prepare('SELECT id, event_id, type, body, decision_id, attempts FROM outbox WHERE state = \'pending\' AND next_attempt_at <= ? ORDER BY id LIMIT ?').bind(now, limit).all<Row>()).results
  let sent = 0, failed = 0
  for (const row of due) {
    // Claim: push the next attempt out first, so a parallel run skips this row.
    const claim = await env.DB.prepare('UPDATE outbox SET next_attempt_at = ? WHERE id = ? AND next_attempt_at <= ? AND state = \'pending\'')
      .bind(nextAttempt(row.attempts).toISOString(), row.id, now).run()
    if (!claim.meta.changes) continue
    const ok = await deliverOne(env, row)
    ok ? sent++ : failed++
  }
  return { sent, failed }
}

async function deliverOne(env: Env, row: Row): Promise<boolean> {
  let status = 0, answer: Record<string, unknown> = {}
  try {
    const token = await signEvent(env, JSON.parse(row.body))
    const res = await fetch(eventsUrl(env), { method: 'POST', headers: { 'Content-Type': 'application/jose' }, body: token, signal: AbortSignal.timeout(15_000) })
    status = res.status
    answer = await res.json<Record<string, unknown>>().catch(() => ({}))
  } catch { status = 0 }
  const kind = classify(status)
  const attempts = row.attempts + 1
  // Only My College's short, content-free answer is kept: a result word or an error code.
  const detail = String(answer.result ?? answer.error ?? (status ? `HTTP ${status}` : 'unreachable')).slice(0, 200)
  const state = kind === 'sent' ? 'sent' : kind === 'refused' ? 'refused' : attempts >= MAX_ATTEMPTS ? 'dead' : 'pending'
  const stmts = [env.DB.prepare('UPDATE outbox SET state = ?, attempts = ?, last_status = ?, last_error = ? WHERE id = ?')
    .bind(state, attempts, status || null, kind === 'sent' ? null : detail, row.id)]
  if (row.decision_id != null && kind !== 'retry') {
    // "Decision recorded · awaiting My College confirmation" becomes "Recorded in My College",
    // or shows why My College refused it.
    const mc = kind === 'refused' ? 'refused' : answer.result === 'superseded' ? 'superseded' : 'recorded'
    stmts.push(env.DB.prepare('UPDATE decisions SET mc_state = ?, mc_detail = ? WHERE id = ?').bind(mc, kind === 'sent' ? null : detail, row.decision_id))
  }
  await env.DB.batch(stmts)
  return kind === 'sent'
}

/** An administrator retries a refused or dead event once the cause is fixed. Same event_id. */
export async function retryEvent(env: Env, id: number): Promise<void> {
  await env.DB.prepare('UPDATE outbox SET state = \'pending\', next_attempt_at = ?, attempts = 0 WHERE id = ? AND state IN (\'refused\', \'dead\')').bind(nowIso(), id).run()
  const row = await env.DB.prepare('SELECT decision_id FROM outbox WHERE id = ?').bind(id).first<{ decision_id: number | null }>()
  if (row?.decision_id != null) await env.DB.prepare('UPDATE decisions SET mc_state = \'pending\', mc_detail = NULL WHERE id = ?').bind(row.decision_id).run()
}

