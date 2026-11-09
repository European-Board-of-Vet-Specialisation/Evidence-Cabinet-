// The cabinet's rules as pure functions, so they can be tested without a Worker.

import { addDays, addMonths } from './util'

// ── event delivery ───────────────────────────────────────────────────────────

const BACKOFF_MIN = [1, 5, 15, 60, 240, 720]   // then daily
/** After this many attempts an event stops retrying and waits for an administrator. About two months. */
export const MAX_ATTEMPTS = 66

export function nextAttempt(attempts: number, from: Date = new Date()): Date {
  const min = BACKOFF_MIN[attempts] ?? 1440
  return new Date(from.getTime() + min * 60_000)
}

/** What My College's answer means for an event (docs/interface.md, "My College endpoint"). */
export type Delivery = 'sent' | 'retry' | 'refused'
export function classify(status: number): Delivery {
  if (status >= 200 && status < 300) return 'sent'
  if (status === 429 || status >= 500 || status === 0) return 'retry'
  return 'refused'   // 400, 401, 404, 409, 413, 422: retrying the same event cannot succeed
}

// ── retention (docs/spec.md §6.2) ────────────────────────────────────────────

export const BACKSTOP_MONTHS = 18
export const FLAG_MONTHS = 6
export const REMIND_DAYS = 30

export interface RetentionCase {
  state: string
  ebvs_hold: number
  retain_until: string | null
  last_activity_at: string
  reminded_retention_at: string | null
  reminded_deletion_at: string | null
}

/** When RET-01 would delete this case. */
export const backstopAt = (c: Pick<RetentionCase, 'last_activity_at'>) => addMonths(new Date(c.last_activity_at), BACKSTOP_MONTHS)

export const flagActive = (c: Pick<RetentionCase, 'retain_until'>, today: Date) => !!c.retain_until && new Date(c.retain_until) > today

export type RetentionAction =
  | { do: 'none' }
  | { do: 'delete' }                       // RET-01: 18 months since last activity, no hold, no flag
  | { do: 'lapse_flag' }                   // RET-04: a flag expired unrenewed
  | { do: 'remind_retention' }             // RET-05: flag expires within 30 days
  | { do: 'remind_deletion' }              // RET-06: deletion within 30 days

/**
 * What the daily job does with one case. One action per case per day: a lapsed flag is lifted
 * today and the deletion rule looks at the case again tomorrow, after its reminder.
 */
export function retentionAction(c: RetentionCase, today: Date = new Date()): RetentionAction {
  if (c.state !== 'open' || c.ebvs_hold) return { do: 'none' }
  if (c.retain_until) {
    const until = new Date(c.retain_until)
    if (until <= today) return { do: 'lapse_flag' }
    if (until <= addDays(today, REMIND_DAYS) && !c.reminded_retention_at) return { do: 'remind_retention' }
    return { do: 'none' }
  }
  const due = backstopAt(c)
  if (due <= today) return c.reminded_deletion_at ? { do: 'delete' } : { do: 'remind_deletion' }
  if (due <= addDays(today, REMIND_DAYS) && !c.reminded_deletion_at) return { do: 'remind_deletion' }
  return { do: 'none' }
}

/** A flag set or renewed today runs six months. */
export const flagUntil = (today: Date = new Date()) => addMonths(today, FLAG_MONTHS)

/** Six-monthly summary: on 1 January and 1 July. */
export const summaryDue = (today: Date, lastPeriodEnd: string | null) => {
  const period = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() < 6 ? 0 : 6, 1))
  return (!lastPeriodEnd || new Date(lastPeriodEnd) < period) ? period : null
}
