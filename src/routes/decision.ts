// Decisions (spec §6.1). Prepare: any assigned reviewer drafts. Record: separate fields for the
// internal rationale and the administrative outcome. Preview and finalise: the person designated
// to finalise sees exactly what My College will receive, then locks the version; the event is
// queued in the same batch. Confirm: the page shows My College's acknowledgement. Correct or
// appeal: a new version linked to the one before.

import type { Env } from '../env'
import { forCase, nav } from './cases'
import { touchStmt } from '../cases'
import { queueEvent, deliverDue, retryEvent } from '../outbox'
import { page, notice } from '../ui/layout'
import { esc, nowIso } from '../util'
import { parseContext, adjustmentFromForm, describe, ADJUSTMENT_LABEL, ADJUSTMENT_TYPES, type Adjustment, type CaseContext, type AdjustmentType } from '../context'

interface DecisionRow {
  id: number; case_ref: string; version: number | null; decision_type: string; outcome: string | null
  adjustments: string; dates: string; rationale: string | null; evidence_considered: string; supersedes: number | null
  drafted_by: number | null; drafted_at: string | null; finalised_by: number | null; finalised_at: string | null
  mc_state: string | null; mc_detail: string | null
}

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Brussels' })

/** Exactly what goes to My College. The preview shows this object; the event sends it. */
export function decisionPayload(d: Pick<DecisionRow, 'case_ref' | 'version' | 'decision_type' | 'outcome' | 'adjustments' | 'dates'>, finalisedAt: string) {
  return {
    case_ref: d.case_ref, version: d.version, decision_type: d.decision_type, outcome: d.outcome,
    adjustments: d.outcome === 'upheld' ? (JSON.parse(d.adjustments) as Adjustment[]).map(a => ({ type: a.type, params: a.params })) : [],
    dates: JSON.parse(d.dates) as Record<string, string>,
    finalised_at: finalisedAt,
  }
}

const draftOf = (env: Env, ref: string) => env.DB.prepare('SELECT * FROM decisions WHERE case_ref = ? AND version IS NULL').bind(ref).first<DecisionRow>()
const finalised = (env: Env, ref: string) => env.DB.prepare('SELECT d.*, p.display_name AS by_name FROM decisions d LEFT JOIN people p ON p.id = d.finalised_by WHERE d.case_ref = ? AND d.version IS NOT NULL ORDER BY d.version DESC').bind(ref).all<DecisionRow & { by_name: string | null }>()

function adjustmentFields(ctx: CaseContext | null, chosen: Adjustment[]): string {
  // "Other approved" needs the College's list; with none, there is nothing to choose.
  const types = (ctx?.types.length ? ctx.types : [...ADJUSTMENT_TYPES]).filter(t => t !== 'other' || !!ctx?.codes.length)
  const has = (t: AdjustmentType) => chosen.find(a => a.type === t)
  const val = (t: AdjustmentType, k: string) => esc(String(has(t)?.params[k] ?? ''))
  const box = (t: AdjustmentType, inner: string) => `<div class="card"><label><input type="checkbox" name="adj.${t}.on" value="1" ${has(t) ? 'checked' : ''}> ${esc(ADJUSTMENT_LABEL[t])}</label>${inner}</div>`
  return types.map(t => {
    switch (t) {
      case 'extension': return box(t, `<div class="row"><span>Months</span><input type="number" min="1" max="36" name="adj.extension.months" value="${val(t, 'months')}" style="width:100px"><span>or new deadline</span><input type="date" name="adj.extension.until" value="${val(t, 'until')}" style="width:180px"></div>`)
      case 'deferral': return box(t, ctx?.cycles.length ? `<select name="adj.deferral.cycle_id"><option value="">Choose the diet</option>${ctx.cycles.map(c => `<option value="${c.id}" ${has(t)?.params.cycle_id === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>` : '<p class="muted">My College sent no open diets for this claim.</p>')
      case 'extra_time': return box(t, `<div class="row"><span>Minutes per paper</span><input type="number" min="1" max="600" name="adj.extra_time.minutes" value="${val(t, 'minutes')}" style="width:100px"><span>or percent</span><input type="number" min="1" max="200" name="adj.extra_time.percent" value="${val(t, 'percent')}" style="width:100px"></div>`)
      case 'separate_room': return box(t, '')
      case 'rest_breaks': return box(t, `<div class="row"><span>Number</span><input type="number" min="1" max="20" name="adj.rest_breaks.count" value="${val(t, 'count')}" style="width:90px"><span>minutes each</span><input type="number" min="1" max="120" name="adj.rest_breaks.minutes" value="${val(t, 'minutes')}" style="width:90px"></div>`)
      case 'reduced_target': return box(t, `<div class="row"><span>Months lost</span><input type="number" min="1" max="60" name="adj.reduced_target.months" value="${val(t, 'months')}" style="width:100px"></div>`)
      case 'other': return box(t, ctx?.codes.length ? `<select name="adj.other.code"><option value="">Choose</option>${ctx.codes.map(c => `<option value="${esc(c.code)}" ${has(t)?.params.code === c.code ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>` : '<p class="muted">The College has no approved list in My College.</p>')
    }
  }).join('')
}

export async function decisionPage(req: Request, env: Env, ref: string, message = ''): Promise<Response> {
  const g = await forCase(req, env, ref); if (g instanceof Response) return g
  const { me, c } = g
  const ctx = parseContext(c.context ? JSON.parse(c.context) : null)
  const [draft, done, versions] = await Promise.all([
    draftOf(env, ref), finalised(env, ref),
    env.DB.prepare('SELECT version FROM evidence_versions WHERE case_ref = ? AND complete = 1 ORDER BY version').bind(ref).all<{ version: number }>(),
  ])
  const latest = done.results[0]
  const chosen = draft ? JSON.parse(draft.adjustments) as Adjustment[] : []
  const considered = new Set(draft ? JSON.parse(draft.evidence_considered) as number[] : versions.results.map(v => v.version))
  const history = done.results.length ? `<h2>Decisions</h2>${done.results.map(d => `<div class="card">
    <div class="row"><b>Version ${d.version}</b><span class="tag">${esc(d.decision_type)}</span><span>${d.outcome === 'upheld' ? 'Upheld' : 'Not upheld'}</span><span class="muted">finalised by ${esc(d.by_name ?? '—')}, ${esc(when(d.finalised_at!))}</span></div>
    ${d.outcome === 'upheld' && (JSON.parse(d.adjustments) as Adjustment[]).length ? `<ul>${(JSON.parse(d.adjustments) as Adjustment[]).map(a => `<li>${esc(describe(a, ctx))}</li>`).join('')}</ul>` : ''}
    <p class="muted">Rationale (stays in the cabinet): ${esc(d.rationale ?? '—')}</p>
    <p class="notice ${d.mc_state === 'recorded' ? 'good' : d.mc_state === 'refused' ? 'bad' : d.mc_state === 'superseded' ? '' : 'warn'}">${
      d.mc_state === 'recorded' ? 'Recorded in My College.'
      : d.mc_state === 'superseded' ? 'Kept in My College\'s history; a later version stands.'
      : d.mc_state === 'refused' ? `My College refused this version: ${esc(d.mc_detail ?? '')}. Correct it as a new version.`
      : 'Decision recorded · awaiting My College confirmation.'}</p>
    ${me.is_admin && d.mc_state !== 'recorded' && d.mc_state !== 'superseded' ? `<form method="post" action="/case/${esc(ref)}/decision/${d.id}/retry"><button class="secondary" type="submit">Send to My College again</button></form>` : ''}
  </div>`).join('')}` : ''

  const type = latest ? (draft?.decision_type && draft.decision_type !== 'initial' ? draft.decision_type : 'correction') : 'initial'
  const form = `<form class="card" method="post" action="/case/${esc(ref)}/decision/draft">
  <h2>${latest ? 'New version' : 'Draft the decision'}</h2>
  ${latest ? `<label>This version is</label><select name="decision_type"><option value="correction" ${type === 'correction' ? 'selected' : ''}>a correction of version ${latest.version}</option><option value="appeal" ${type === 'appeal' ? 'selected' : ''}>the outcome of an appeal against version ${latest.version}</option></select>` : '<input type="hidden" name="decision_type" value="initial">'}
  <label>Outcome</label>
  <div class="row"><label style="font-weight:400"><input type="radio" name="outcome" value="upheld" ${draft?.outcome === 'upheld' ? 'checked' : ''}> Upheld</label>
  <label style="font-weight:400"><input type="radio" name="outcome" value="not_upheld" ${draft?.outcome === 'not_upheld' ? 'checked' : ''}> Not upheld</label></div>
  <label>Adjustments, if upheld</label><p class="muted">Each describes what changes, never why.${ctx?.subject ? ` This claim relates to: ${esc(ctx.subject)}.` : ''}</p>
  ${adjustmentFields(ctx, chosen)}
  <label for="effective_from">Effective from (optional)</label><input id="effective_from" type="date" name="effective_from" value="${esc((draft ? JSON.parse(draft.dates).effective_from : '') ?? '')}" style="max-width:200px">
  <label for="rationale">Rationale</label><p class="muted">The committee's reasoning. It stays in the cabinet with the evidence considered and is never sent to My College.</p>
  <textarea id="rationale" name="rationale" maxlength="20000">${esc(draft?.rationale ?? '')}</textarea>
  <label>Evidence considered</label>${versions.results.map(v => `<label style="font-weight:400"><input type="checkbox" name="considered" value="${v.version}" ${considered.has(v.version) ? 'checked' : ''}> Submission ${v.version}</label>`).join('') || '<p class="muted">No submissions.</p>'}
  <p class="row"><button type="submit" name="go" value="save">Save draft</button>${me.can_finalise ? '<button type="submit" name="go" value="preview" class="secondary">Preview and finalise</button>' : '<span class="muted">The people your College designates finalise decisions.</span>'}</p>
  ${draft?.drafted_at ? `<p class="muted">Draft saved ${esc(when(draft.drafted_at))}.</p>` : ''}
</form>`
  return page(env, 'Decision', `${message}<p><a href="/case/${esc(ref)}">← Back to the case</a></p>${history}${form}`, 200, { nav: nav(me) })
}

/** Save the draft; with go=preview, show what My College will receive. */
export async function saveDraft(req: Request, env: Env, ref: string): Promise<Response> {
  const g = await forCase(req, env, ref); if (g instanceof Response) return g
  const ctx = parseContext(g.c.context ? JSON.parse(g.c.context) : null)
  const f = await req.formData()
  const s = (k: string) => String(f.get(k) ?? '')
  const outcome = s('outcome') === 'upheld' || s('outcome') === 'not_upheld' ? s('outcome') : null
  const latest = await env.DB.prepare('SELECT MAX(version) AS v FROM decisions WHERE case_ref = ?').bind(ref).first<{ v: number | null }>()
  const decisionType = !latest?.v ? 'initial' : s('decision_type') === 'appeal' ? 'appeal' : 'correction'
  const adjustments: Adjustment[] = []
  for (const t of (ctx?.types.length ? ctx.types : [...ADJUSTMENT_TYPES])) {
    const a = adjustmentFromForm(t, s)
    if (a && 'error' in a) return decisionPage(req, env, ref, notice(a.error, 'bad'))
    if (a) adjustments.push(a)
  }
  if (adjustments.some(a => a.type === 'extension') && adjustments.some(a => a.type === 'reduced_target')) return decisionPage(req, env, ref, notice('Give an extension or a reduced target, not both.', 'bad'))
  const eff = s('effective_from')
  const dates = /^\d{4}-\d{2}-\d{2}$/.test(eff) ? { effective_from: eff } : {}
  const considered = f.getAll('considered').map(Number).filter(n => Number.isInteger(n) && n > 0)
  const rationale = s('rationale').slice(0, 20000)
  const now = nowIso()
  const draft = await draftOf(env, ref)
  const supersedes = latest?.v ? (await env.DB.prepare('SELECT id FROM decisions WHERE case_ref = ? AND version = ?').bind(ref, latest.v).first<{ id: number }>())?.id ?? null : null
  if (draft) {
    await env.DB.prepare('UPDATE decisions SET decision_type = ?, outcome = ?, adjustments = ?, dates = ?, rationale = ?, evidence_considered = ?, supersedes = ?, drafted_by = ?, drafted_at = ? WHERE id = ?')
      .bind(decisionType, outcome, JSON.stringify(adjustments), JSON.stringify(dates), rationale, JSON.stringify(considered), supersedes, g.me.id, now, draft.id).run()
  } else {
    await env.DB.prepare('INSERT INTO decisions (case_ref, decision_type, outcome, adjustments, dates, rationale, evidence_considered, supersedes, drafted_by, drafted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(ref, decisionType, outcome, JSON.stringify(adjustments), JSON.stringify(dates), rationale, JSON.stringify(considered), supersedes, g.me.id, now).run()
  }
  if (s('go') !== 'preview') return decisionPage(req, env, ref, notice('Draft saved.', 'good'))
  return preview(req, env, ref)
}

async function preview(req: Request, env: Env, ref: string): Promise<Response> {
  const g = await forCase(req, env, ref); if (g instanceof Response) return g
  if (!g.me.can_finalise) return decisionPage(req, env, ref, notice('Only the people your College designates can finalise.', 'bad'))
  const d = await draftOf(env, ref)
  if (!d?.outcome) return decisionPage(req, env, ref, notice('Choose the outcome before finalising.', 'bad'))
  if (d.outcome === 'not_upheld' && (JSON.parse(d.adjustments) as Adjustment[]).length) return decisionPage(req, env, ref, notice('A claim not upheld grants no adjustment. Untick the adjustments.', 'bad'))
  const latest = await env.DB.prepare('SELECT MAX(version) AS v FROM decisions WHERE case_ref = ?').bind(ref).first<{ v: number | null }>()
  const body = decisionPayload({ ...d, version: (latest?.v ?? 0) + 1 }, '(the time you finalise)')
  // Every field My College receives, in words, built from the same object the event sends.
  const ctx = parseContext(g.c.context ? JSON.parse(g.c.context) : null)
  const prior = (body.version ?? 1) - 1
  const TYPE: Record<string, string> = { initial: 'the first decision', correction: `a correction of version ${prior}`, appeal: `the outcome of an appeal against version ${prior}` }
  const DATE: Record<string, string> = { effective_from: 'Effective from' }
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  const row = (k: string, v: string) => `<tr><th style="width:34%">${esc(k)}</th><td>${v}</td></tr>`
  const dates = Object.entries(body.dates)
  return page(env, 'Check before finalising', `
<div class="card"><h2>My College will record</h2><table>
${row('Outcome', `<b>${body.outcome === 'upheld' ? 'Upheld' : 'Not upheld'}</b>`)}
${row('This decision is', `${esc(TYPE[body.decision_type] ?? body.decision_type)} (version ${body.version})`)}
${row('Adjustments', body.adjustments.length ? body.adjustments.map(a => `<b>${esc(describe(a as Adjustment, ctx))}</b>`).join('<br>') : 'None')}
${dates.length ? dates.map(([k, v]) => row(DATE[k] ?? k, esc(day(v)))).join('') : row('Dates', 'None')}
${row('Case', esc(ref.slice(3, 11).toUpperCase()))}
</table>
<p class="muted">My College records the time you finalise. It applies the adjustments (for example a recertification extension, or extra examination time) and sends the candidate the outcome with your College's appeals notice.</p></div>
<div class="card"><h2>Stays in the cabinet</h2><p>Your rationale, the evidence considered, the discussion and the candidate's account. None of it is sent.</p></div>
<details class="card"><summary class="muted">The exact message, for administrators</summary><pre style="white-space:pre-wrap;font-size:12px">${esc(JSON.stringify(body, null, 2))}</pre></details>
<p class="muted">Once finalised, this version is locked. A mistake is put right with a new version, and the candidate is told again.</p>
<form method="post" action="/case/${esc(ref)}/decision/finalise" class="row">
  <input type="hidden" name="draft" value="${d.id}"><input type="hidden" name="version" value="${body.version}">
  <button type="submit">Finalise version ${body.version}</button><a class="btn secondary" href="/case/${esc(ref)}/decision">Back to the draft</a>
</form>`, 200, { nav: nav(g.me) })
}

export async function finalise(req: Request, env: Env, ctx: ExecutionContext, ref: string): Promise<Response> {
  const g = await forCase(req, env, ref); if (g instanceof Response) return g
  if (!g.me.can_finalise) return decisionPage(req, env, ref, notice('Only the people your College designates can finalise.', 'bad'))
  const f = await req.formData()
  const d = await draftOf(env, ref)
  const version = Number(f.get('version'))
  if (!d || String(d.id) !== String(f.get('draft')) || !d.outcome) return decisionPage(req, env, ref, notice('The draft changed. Check it again before finalising.', 'bad'))
  const latest = await env.DB.prepare('SELECT MAX(version) AS v FROM decisions WHERE case_ref = ?').bind(ref).first<{ v: number | null }>()
  if (version !== (latest?.v ?? 0) + 1) return decisionPage(req, env, ref, notice('Another version was finalised meanwhile. Check the draft again.', 'bad'))
  const at = nowIso()
  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE decisions SET version = ?, finalised_by = ?, finalised_at = ?, mc_state = \'pending\' WHERE id = ? AND version IS NULL').bind(version, g.me.id, at, d.id),
      queueEvent(env, 'claim.decision_finalised', decisionPayload({ ...d, version }, at), d.id),
      touchStmt(env, ref),
    ])
  } catch {
    return decisionPage(req, env, ref, notice('Another version was finalised meanwhile. Check the draft again.', 'bad'))
  }
  ctx.waitUntil(deliverDue(env))
  return new Response(null, { status: 303, headers: { Location: `/case/${ref}/decision`, 'Cache-Control': 'no-store' } })
}

/** An administrator re-sends a version My College has not acknowledged. The chair re-enters nothing. */
export async function retryDecision(req: Request, env: Env, ctx: ExecutionContext, ref: string, id: number): Promise<Response> {
  const g = await forCase(req, env, ref); if (g instanceof Response) return g
  if (!g.me.is_admin) return decisionPage(req, env, ref, notice('Administrators re-send decisions.', 'bad'))
  const ev = await env.DB.prepare('SELECT o.id FROM outbox o JOIN decisions d ON d.id = o.decision_id WHERE d.id = ? AND d.case_ref = ?').bind(id, ref).first<{ id: number }>()
  if (ev) await retryEvent(env, ev.id)
  ctx.waitUntil(deliverDue(env))
  return new Response(null, { status: 303, headers: { Location: `/case/${ref}/decision`, 'Cache-Control': 'no-store' } })
}
