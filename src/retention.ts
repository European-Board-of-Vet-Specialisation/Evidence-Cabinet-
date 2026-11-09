// The daily job (docs/spec.md §6.2): the 18-month rule, retention flags, reminders, the
// six-monthly summary, and housekeeping. Reminders name no case: the email says only that
// cases need attention, and the cabinet's case list shows which.

import type { Env } from './env'
import { dispose, fromHold, type CaseRow } from './cases'
import { queueEvent, deliverDue } from './outbox'
import { retentionAction, summaryDue, backstopAt, flagActive } from './policy'
import { addDays, nowIso } from './util'

/** Who receives retention notices: administrators and those designated to finalise. */
async function retentionRecipients(env: Env): Promise<string[]> {
  const rows = (await env.DB.prepare('SELECT sub FROM people WHERE active = 1 AND sub IS NOT NULL AND (is_admin = 1 OR can_finalise = 1)').all<{ sub: string }>()).results
  return [...new Set(rows.map(r => r.sub))].slice(0, 50)
}

export async function runDaily(env: Env, today = new Date()): Promise<Record<string, number>> {
  const now = nowIso(today)
  const tally = { deleted: 0, lapsed: 0, remindRetention: 0, remindDeletion: 0, incomplete: 0, summary: 0 }

  const open = (await env.DB.prepare('SELECT * FROM cases WHERE state = \'open\'').all<CaseRow>()).results
  for (const c of open) {
    const a = retentionAction(c, today)
    if (a.do === 'delete') { (await dispose(env, c.case_ref, 'backstop')) ? tally.deleted++ : tally.incomplete++ }
    else if (a.do === 'lapse_flag') {
      await env.DB.prepare('UPDATE cases SET retain_until = NULL, retain_reason = NULL, retain_by = NULL, reminded_retention_at = NULL, reminded_deletion_at = NULL WHERE case_ref = ?').bind(c.case_ref).run()
      await fromHold(env, c.case_ref)
      tally.lapsed++
    } else if (a.do === 'remind_retention') {
      await env.DB.prepare('UPDATE cases SET reminded_retention_at = ? WHERE case_ref = ?').bind(now, c.case_ref).run(); tally.remindRetention++
    } else if (a.do === 'remind_deletion') {
      await env.DB.prepare('UPDATE cases SET reminded_deletion_at = ? WHERE case_ref = ?').bind(now, c.case_ref).run(); tally.remindDeletion++
    }
  }

  const recipients = (tally.remindRetention || tally.remindDeletion || summaryDue(today, null)) ? await retentionRecipients(env) : []
  const notices: D1PreparedStatement[] = []
  if (recipients.length && tally.remindRetention) notices.push(queueEvent(env, 'reviewer.notification_requested', { kind: 'retention_review', recipients }))
  if (recipients.length && tally.remindDeletion) notices.push(queueEvent(env, 'reviewer.notification_requested', { kind: 'deletion_due', recipients }))

  // Six-monthly summary: numbers only, viewed in the cabinet.
  const last = await env.DB.prepare('SELECT period_end FROM summaries ORDER BY period_end DESC LIMIT 1').first<{ period_end: string }>()
  const period = summaryDue(today, last?.period_end ?? null)
  if (period) {
    const since = new Date(period); since.setUTCMonth(since.getUTCMonth() - 6)
    const stillOpen = (await env.DB.prepare('SELECT * FROM cases WHERE state = \'open\'').all<CaseRow>()).results
    const deleted = await env.DB.prepare('SELECT COUNT(*) AS n FROM cases WHERE state = \'disposed\' AND disposed_at >= ? AND disposed_at < ?').bind(since.toISOString(), period.toISOString()).first<{ n: number }>()
    const horizon = addDays(today, 6 * 31)
    notices.push(env.DB.prepare('INSERT INTO summaries (period_end, cases_held, cases_flagged, deleted_in_period, deletions_due, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
      period.toISOString(), stillOpen.length, stillOpen.filter(c => flagActive(c, today)).length, deleted?.n ?? 0,
      stillOpen.filter(c => !flagActive(c, today) && !c.ebvs_hold && backstopAt(c) <= horizon).length, now))
    const to = recipients.length ? recipients : await retentionRecipients(env)
    if (to.length) notices.push(queueEvent(env, 'reviewer.notification_requested', { kind: 'summary', recipients: to }))
    tally.summary = 1
  }
  if (notices.length) await env.DB.batch(notices)

  // Housekeeping: nothing here is needed once it has expired.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM nonces WHERE exp < ?').bind(Math.floor(today.getTime() / 1000) - 300),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM candidate_sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM pending_launches WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM challenges WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM enrolments WHERE expires_at < ? AND used_at IS NULL').bind(now),
  ])
  await deliverDue(env, 200)
  return tally
}

