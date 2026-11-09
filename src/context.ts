// The decision context My College sends in a review pass (claim `ctx`), and the structured
// adjustments the cabinet can offer. My College validates every decision again on receipt; this
// is so the screen offers only what it will accept.

export const ADJUSTMENT_TYPES = ['extension', 'deferral', 'extra_time', 'separate_room', 'rest_breaks', 'reduced_target', 'other'] as const
export type AdjustmentType = typeof ADJUSTMENT_TYPES[number]

export const ADJUSTMENT_LABEL: Record<AdjustmentType, string> = {
  extension: 'Extension', deferral: 'Deferral', extra_time: 'Additional examination time',
  separate_room: 'Separate room', rest_breaks: 'Rest breaks', reduced_target: 'Reduced target', other: 'Other approved',
}

export interface CaseContext {
  relates_to: string
  subject: string | null
  types: AdjustmentType[]
  cycles: Array<{ id: number; label: string }>
  codes: Array<{ code: string; label: string }>
}

/** Read `ctx` from a pass. Anything unexpected is dropped; a missing ctx offers every type. */
export function parseContext(raw: unknown): CaseContext | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const str = (v: unknown, max = 200) => typeof v === 'string' ? v.slice(0, max) : null
  const types = Array.isArray(r.types) ? r.types.filter((t): t is AdjustmentType => (ADJUSTMENT_TYPES as readonly string[]).includes(t as string)) : [...ADJUSTMENT_TYPES]
  const cycles = Array.isArray(r.cycles) ? r.cycles.slice(0, 50).flatMap(c => {
    const o = c as Record<string, unknown>; const id = Number(o?.id)
    return Number.isInteger(id) && typeof o.label === 'string' ? [{ id, label: o.label.slice(0, 120) }] : []
  }) : []
  const codes = Array.isArray(r.codes) ? r.codes.slice(0, 100).flatMap(c => {
    const o = c as Record<string, unknown>
    return typeof o?.code === 'string' && /^[A-Z0-9_-]{1,24}$/.test(o.code) && typeof o.label === 'string' ? [{ code: o.code, label: o.label.slice(0, 120) }] : []
  }) : []
  return { relates_to: str(r.relates_to, 40) ?? 'other', subject: str(r.subject), types, cycles, codes }
}

export interface Adjustment { type: AdjustmentType; params: Record<string, unknown> }

/** Build one adjustment from form fields `adj.<type>.<param>`. Returns null if not chosen. */
export function adjustmentFromForm(type: AdjustmentType, f: (k: string) => string): Adjustment | { error: string } | null {
  const v = (k: string) => f(`adj.${type}.${k}`).trim()
  if (v('on') !== '1') return null
  const int = (k: string, lo: number, hi: number) => { const n = Number(v(k)); return Number.isInteger(n) && n >= lo && n <= hi ? n : null }
  switch (type) {
    case 'extension': {
      const months = v('months') ? int('months', 1, 36) : null, until = v('until')
      if (months == null && !/^\d{4}-\d{2}-\d{2}$/.test(until)) return { error: 'An extension needs months (1–36) or a new deadline.' }
      return { type, params: months != null ? { months } : { until } }
    }
    case 'deferral': { const id = int('cycle_id', 1, 1e9); return id == null ? { error: 'Choose the diet to defer to.' } : { type, params: { cycle_id: id } } }
    case 'extra_time': {
      const minutes = v('minutes') ? int('minutes', 1, 600) : null, percent = v('percent') ? int('percent', 1, 200) : null
      if ((minutes == null) === (percent == null)) return { error: 'Additional time is minutes or a percentage.' }
      return { type, params: minutes != null ? { minutes } : { percent } }
    }
    case 'separate_room': return { type, params: { required: true } }
    case 'rest_breaks': {
      const count = int('count', 1, 20), minutes = int('minutes', 1, 120)
      return count == null || minutes == null ? { error: 'Rest breaks need a number (1–20) and minutes (1–120).' } : { type, params: { count, minutes } }
    }
    case 'reduced_target': { const m = int('months', 1, 60); return m == null ? { error: 'A reduced target needs the months lost (1–60).' } : { type, params: { months: m } } }
    case 'other': { const code = v('code'); return /^[A-Z0-9_-]{1,24}$/.test(code) ? { type, params: { code } } : { error: 'Choose an approved adjustment.' } }
  }
}

export function describe(a: Adjustment, ctx: CaseContext | null): string {
  const p = a.params
  switch (a.type) {
    case 'extension': return p.months ? `Extension of ${p.months} month${p.months === 1 ? '' : 's'}` : `Extension to ${p.until}`
    case 'deferral': return `Deferral to ${ctx?.cycles.find(c => c.id === p.cycle_id)?.label ?? `diet ${p.cycle_id}`}`
    case 'extra_time': return p.minutes ? `Additional time: ${p.minutes} minutes per paper` : `Additional time: ${p.percent}%`
    case 'separate_room': return 'Separate room'
    case 'rest_breaks': return `Rest breaks: ${p.count} × ${p.minutes} minutes`
    case 'reduced_target': return `Points target reduced for ${p.months} months lost`
    case 'other': return ctx?.codes.find(c => c.code === p.code)?.label ?? `Other approved: ${p.code}`
  }
}
