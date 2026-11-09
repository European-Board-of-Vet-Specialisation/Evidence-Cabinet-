import { describe, it, expect } from 'vitest'
import { retentionAction, classify, nextAttempt, summaryDue, flagUntil } from '../src/policy'
import { checkFile, sniff } from '../src/filetype'
import { PDF, PNG } from './helpers'

const base = { state: 'open', ebvs_hold: 0, retain_until: null, reminded_retention_at: null, reminded_deletion_at: null }
const today = new Date('2028-06-01T00:00:00Z')
const monthsAgo = (m: number, d = 0) => { const x = new Date(today); x.setUTCMonth(x.getUTCMonth() - m); x.setUTCDate(x.getUTCDate() - d); return x.toISOString() }

describe('retention (RET-01 to RET-06)', () => {
  it('leaves a recent case alone', () => expect(retentionAction({ ...base, last_activity_at: monthsAgo(6) }, today).do).toBe('none'))
  it('reminds 30 days before the 18-month rule, then deletes', () => {
    expect(retentionAction({ ...base, last_activity_at: monthsAgo(17, 5) }, today).do).toBe('remind_deletion')
    expect(retentionAction({ ...base, last_activity_at: monthsAgo(18, 1), reminded_deletion_at: monthsAgo(1) }, today).do).toBe('delete')
  })
  it('never deletes without the reminder first', () => expect(retentionAction({ ...base, last_activity_at: monthsAgo(24) }, today).do).toBe('remind_deletion'))
  it('keeps a flagged or EBVS-held case past 18 months', () => {
    expect(retentionAction({ ...base, last_activity_at: monthsAgo(30), retain_until: flagUntil(today).toISOString() }, today).do).toBe('none')
    expect(retentionAction({ ...base, last_activity_at: monthsAgo(30), ebvs_hold: 1 }, today).do).toBe('none')
  })
  it('reminds before a flag expires, and lapses it when it does', () => {
    const soon = new Date(today); soon.setUTCDate(soon.getUTCDate() + 20)
    expect(retentionAction({ ...base, last_activity_at: monthsAgo(30), retain_until: soon.toISOString() }, today).do).toBe('remind_retention')
    expect(retentionAction({ ...base, last_activity_at: monthsAgo(30), retain_until: monthsAgo(0, 1) }, today).do).toBe('lapse_flag')
  })
  it('ignores disposed cases', () => expect(retentionAction({ ...base, state: 'disposed', last_activity_at: monthsAgo(40) }, today).do).toBe('none'))
  it('summarises on 1 January and 1 July', () => {
    expect(summaryDue(today, null)?.toISOString()).toBe('2028-01-01T00:00:00.000Z')
    expect(summaryDue(today, '2028-01-01T00:00:00.000Z')).toBeNull()
    expect(summaryDue(new Date('2028-07-02T00:00:00Z'), '2028-01-01T00:00:00.000Z')?.toISOString()).toBe('2028-07-01T00:00:00.000Z')
  })
})

describe('delivery', () => {
  it('retries outages, stops on refusals', () => {
    expect(classify(200)).toBe('sent'); expect(classify(503)).toBe('retry'); expect(classify(0)).toBe('retry'); expect(classify(429)).toBe('retry')
    for (const s of [400, 401, 404, 409, 413, 422]) expect(classify(s)).toBe('refused')
  })
  it('backs off 1, 5, 15, 60, 240, 720 minutes, then daily', () => {
    const t = new Date('2028-01-01T00:00:00Z')
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(n => (nextAttempt(n, t).getTime() - t.getTime()) / 60000)).toEqual([1, 5, 15, 60, 240, 720, 1440, 1440])
  })
})

describe('file checks (acceptance test 6)', () => {
  it('accepts PDF and images by their bytes', () => {
    expect(checkFile(PDF)).toEqual({ ok: true, kind: 'pdf' })
    expect(checkFile(PNG)).toEqual({ ok: true, kind: 'png' })
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
  })
  it('refuses a renamed file, an empty one and a truncated PDF', () => {
    expect(checkFile(new TextEncoder().encode('MZ\x90\x00 this is an exe called letter.pdf')).ok).toBe(false)
    expect(checkFile(new Uint8Array()).ok).toBe(false)
    expect(checkFile(new TextEncoder().encode('%PDF-1.7\n1 0 obj<<>>')).ok).toBe(false)
  })
  it('refuses an oversized file', () => {
    const big = new Uint8Array(20 * 1024 * 1024 + 1); big.set(PDF.subarray(0, 8))
    expect(checkFile(big)).toEqual({ ok: false, error: 'is larger than 20 MB' })
  })
})
