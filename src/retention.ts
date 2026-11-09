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
  const remindRetention: string[] = [], remindDeletion: string[] = []
  for (const c of open) {
    // One case at a time, each on its own: a case that fails (a slow move, a platform limit) is
    // tried again tomorrow and never stops the rest.
    try {
      const a = retentionAction(c, today)
      if (a.do === 'delete') { (await dispose(env, c.case_ref, 'backstop')) ? tally.deleted++ : tally.incomplete++ }
      else if (a.do === 'lapse_flag') {
        await env.DB.prepare('UPDATE cases SET retain_until = NULL, retain_reason = NULL, retain_by = NULL, reminded_retention_at = NULL, reminded_deletion_at = NULL WHERE case_ref = ?').bind(c.case_ref).run()
        await fromHold(env, c.case_ref)
        tally.lapsed++
      } else if (a.do === 'remind_retention') remindRetention.push(c.case_ref)
      else if (a.do === 'remind_deletion') remindDeletion.push(c.case_ref)
      else if (c.location === 'hold' && !c.ebvs_hold && !flagActive(c, today)) await fromHold(env, c.case_ref)   // an interrupted move back resumes
    } catch { tally.incomplete++ }
  }
  tally.remindRetention = remindRetention.length; tally.remindDeletion = remindDeletion.length

  // A reminder is marked sent ONLY in the same batch that queues the notice: if anything fails,
  // neither happens, and tomorrow's run tries again. The case is never deleted unwarned.
  const recipients = await retentionRecipients(env)
  const notices: D1PreparedStatement[] = []
  const stamp = (col: string, refs: string[]) => refs.map(r => env.DB.prepare(`UPDATE cases SET ${col} = ? WHERE case_ref = ?`).bind(now, r))
  if (recipients.length && remindRetention.length) notices.push(...stamp('reminded_retention_at', remindRetention), queueEvent(env, 'reviewer.notification_requested', { kind: 'retention_review', recipients }))
  if (recipients.length && remindDeletion.length) notices.push(...stamp('reminded_deletion_at', remindDeletion), queueEvent(env, 'reviewer.notification_requested', { kind: 'deletion_due', recipients }))

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
    if (recipients.length) notices.push(queueEvent(env, 'reviewer.notification_requested', { kind: 'summary', recipients }))
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
    // Delivered events are kept a month for the administrator's view, then dropped.
    env.DB.prepare('DELETE FROM outbox WHERE state = \'sent\' AND created_at < ?').bind(new Date(today.getTime() - 30 * 86_400_000).toISOString()),
  ])
  await deliverDue(env, 200)
  return tally
}

