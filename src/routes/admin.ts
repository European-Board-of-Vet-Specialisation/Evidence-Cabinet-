// Administration, for the College's own administrators: people (reviewers, finalisers,
// administrators) and their enrolment links; assignments; retention flags; events My College
// has not accepted; the six-monthly summaries. An administrator sees no evidence here: to read a
// case they assign themselves, which is recorded like any other assignment.

import type { Env } from '../env'
import { staff, assigned, type Person } from '../session'
import { nav } from './cases'
import { createEnrolment } from './auth'
import { getCase, toHold, fromHold, dispose } from '../cases'
import { retryEvent, deliverDue } from '../outbox'
import { flagUntil } from '../policy'
import { page, notice } from '../ui/layout'
import { esc, isCaseRef, isSub, nowIso } from '../util'
import { parseContext } from '../context'

const when = (iso: string | null) => iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Brussels' }) : '—'
const back = (to: string) => new Response(null, { status: 303, headers: { Location: to, 'Cache-Control': 'no-store' } })

async function admin(req: Request, env: Env): Promise<Person | Response> {
  const me = await staff(req, env)
  if (!me) return back(`/signin?next=${encodeURIComponent(new URL(req.url).pathname)}`)
  if (!me.is_admin) return page(env, 'Administrators only', notice('This page is for the College\'s cabinet administrators.', 'bad'), 403, { nav: nav(me) })
  return me
}

export async function adminHome(req: Request, env: Env, message = ''): Promise<Response> {
  const me = await admin(req, env); if (me instanceof Response) return me
  const [people, cases, failed, summaries] = await Promise.all([
    env.DB.prepare(`SELECT p.*, (SELECT COUNT(*) FROM passkeys k WHERE k.person_id = p.id) AS keys FROM people p ORDER BY p.active DESC, p.display_name`).all<Person & { keys: number; removed_at: string | null }>(),
    env.DB.prepare(`SELECT c.case_ref, c.context, c.candidate_name, c.last_activity_at, c.retain_until, c.ebvs_hold,
        (SELECT GROUP_CONCAT(p.display_name, ', ') FROM assignments a JOIN people p ON p.id = a.person_id WHERE a.case_ref = c.case_ref AND a.revoked_at IS NULL) AS reviewers
      FROM cases c WHERE c.state = 'open' ORDER BY c.last_activity_at DESC`).all<{ case_ref: string; context: string | null; candidate_name: string | null; last_activity_at: string; retain_until: string | null; ebvs_hold: number; reviewers: string | null }>(),
    env.DB.prepare(`SELECT id, type, state, attempts, last_status, last_error, created_at FROM outbox WHERE state IN ('refused', 'dead') OR (state = 'pending' AND attempts >= 3) ORDER BY id DESC LIMIT 50`).all<{ id: number; type: string; state: string; attempts: number; last_status: number | null; last_error: string | null; created_at: string }>(),
    env.DB.prepare('SELECT * FROM summaries ORDER BY period_end DESC LIMIT 4').all<{ period_end: string; cases_held: number; cases_flagged: number; deleted_in_period: number; deletions_due: number }>(),
  ])
  const admins = people.results.filter(p => p.active && p.is_admin).length
  return page(env, 'Administration', `${message}
${admins < 2 ? notice('Name a second administrator, so the College never depends on one person (spec §12).', 'warn') : ''}
<h2>People</h2>
<div class="card"><table><tr><th>Name</th><th>My College ID</th><th>Roles</th><th>Passkeys</th><th></th></tr>
${people.results.map(p => `<tr${p.active ? '' : ' class="muted"'}><td>${esc(p.display_name)}${p.active ? '' : ' (removed)'}</td><td style="font-family:monospace;font-size:12px">${esc(p.sub ?? '— not set')}</td>
  <td>${[p.is_admin ? 'administrator' : '', p.can_finalise ? 'finalises' : '', p.can_retain ? 'retains' : '', 'reviewer'].filter(Boolean).join(', ')}</td><td>${p.keys}</td>
  <td>${p.active ? `<a href="/admin/person/${p.id}">Change</a>` : ''}</td></tr>`).join('')}
</table></div>
<form class="card" method="post" action="/admin/person">
  <h2>Add a person</h2>
  <label for="name">Name</label><input id="name" name="name" type="text" maxlength="120" required>
  <label for="sub">Their ID from My College</label><input id="sub" name="sub" type="text" placeholder="p_…" maxlength="60">
  <p class="muted">My College → College settings → Evidence handling lists each committee member's ID. Without it, passes from My College cannot be matched to this person.</p>
  <div class="row"><label style="font-weight:400"><input type="checkbox" name="can_finalise" value="1"> Finalises decisions</label>
  <label style="font-weight:400"><input type="checkbox" name="can_retain" value="1"> May flag cases for retention</label>
  <label style="font-weight:400"><input type="checkbox" name="is_admin" value="1"> Administrator</label></div>
  <p><button type="submit">Add and make an enrolment link</button></p>
</form>
<h2>Cases</h2>
${cases.results.length ? `<div class="card"><table><tr><th>Case</th><th>About</th><th>Reviewers</th><th>Kept</th><th></th></tr>${cases.results.map(c => {
  const ctx = parseContext(c.context ? JSON.parse(c.context) : null)
  return `<tr><td>${esc(c.candidate_name ?? 'Candidate')}<br><span class="muted">${esc(c.case_ref.slice(3, 11).toUpperCase())}</span></td><td>${esc(ctx?.subject ?? ctx?.relates_to ?? '')}</td>
  <td>${esc(c.reviewers ?? 'none')}</td><td>${c.ebvs_hold ? 'EBVS appeal hold' : c.retain_until ? `flagged until ${esc(when(c.retain_until))}` : `last activity ${esc(when(c.last_activity_at))}`}</td>
  <td><a href="/admin/case/${esc(c.case_ref)}">Manage</a></td></tr>`
}).join('')}</table></div>` : '<p class="muted">No open cases.</p>'}
<h2>Events My College has not accepted</h2>
${failed.results.length ? `<div class="card"><table><tr><th>Event</th><th>State</th><th>Answer</th><th></th></tr>${failed.results.map(e => `<tr><td>${esc(e.type)}<br><span class="muted">${esc(when(e.created_at))}</span></td><td>${esc(e.state)}, ${e.attempts} attempt${e.attempts === 1 ? '' : 's'}</td><td>${esc(e.last_error ?? '')}</td>
  <td>${e.state === 'pending' ? '<span class="muted">retrying</span>' : `<form method="post" action="/admin/event/${e.id}/retry"><button class="secondary" type="submit">Retry</button></form>`}</td></tr>`).join('')}</table></div>` : '<p class="muted">None. Everything has been accepted.</p>'}
<h2>Six-monthly summaries</h2>
${summaries.results.length ? `<div class="card"><table><tr><th>Period ending</th><th>Cases held</th><th>Flagged</th><th>Deleted in period</th><th>Due for deletion</th></tr>${summaries.results.map(s => `<tr><td>${esc(when(s.period_end))}</td><td>${s.cases_held}</td><td>${s.cases_flagged}</td><td>${s.deleted_in_period}</td><td>${s.deletions_due}</td></tr>`).join('')}</table></div>` : '<p class="muted">The first summary is made on 1 January or 1 July.</p>'}
<p><a href="/setup">Set-up checks and the values for My College</a></p>`, 200, { nav: nav(me) })
}

// ── people ───────────────────────────────────────────────────────────────────

export async function addPerson(req: Request, env: Env): Promise<Response> {
  const me = await admin(req, env); if (me instanceof Response) return me
  const f = await req.formData()
  const name = String(f.get('name') ?? '').trim().slice(0, 120)
  const sub = String(f.get('sub') ?? '').trim() || null
  if (!name) return adminHome(req, env, notice('Enter a name.', 'bad'))
  if (sub && !isSub(sub)) return adminHome(req, env, notice('That does not look like a My College ID (p_…).', 'bad'))
  if (sub && await env.DB.prepare('SELECT 1 FROM people WHERE sub = ?').bind(sub).first()) return adminHome(req, env, notice('Someone here already has that ID.', 'bad'))
  const p = await env.DB.prepare('INSERT INTO people (sub, display_name, is_admin, can_finalise, can_retain, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(sub, name, f.get('is_admin') ? 1 : 0, f.get('can_finalise') ? 1 : 0, f.get('can_retain') ? 1 : 0, nowIso()).first<{ id: number }>()
  return enrolmentShown(req, env, me, p!.id, name)
}

async function enrolmentShown(_req: Request, env: Env, me: Person, personId: number, name: string): Promise<Response> {
  const link = await createEnrolment(env, personId, me.id)
  return page(env, 'Enrolment link', `<div class="card"><p>Give this link to ${esc(name)} yourself, by a route you trust. It works once, for seven days, and creates a passkey on their own device.</p>
<input type="text" readonly value="${esc(link)}"><p class="muted">The cabinet does not send it: it has no email, by design.</p></div><p><a href="/admin">Back to administration</a></p>`, 200, { nav: nav(me) })
}

export async function personPage(req: Request, env: Env, id: number, message = ''): Promise<Response> {
  const me = await admin(req, env); if (me instanceof Response) return me
  const p = await env.DB.prepare('SELECT * FROM people WHERE id = ? AND active = 1').bind(id).first<Person>()
  if (!p) return adminHome(req, env, notice('No such person.', 'bad'))
  return page(env, p.display_name, `${message}<form class="card" method="post" action="/admin/person/${p.id}">
  <label for="sub">My College ID</label><input id="sub" name="sub" type="text" value="${esc(p.sub ?? '')}" maxlength="60">
  <div class="row"><label style="font-weight:400"><input type="checkbox" name="can_finalise" value="1" ${p.can_finalise ? 'checked' : ''}> Finalises decisions</label>
  <label style="font-weight:400"><input type="checkbox" name="can_retain" value="1" ${p.can_retain ? 'checked' : ''}> May flag cases for retention</label>
  <label style="font-weight:400"><input type="checkbox" name="is_admin" value="1" ${p.is_admin ? 'checked' : ''}> Administrator</label></div>
  <p class="row"><button type="submit" name="go" value="save">Save</button><button class="secondary" type="submit" name="go" value="enrol">New enrolment link</button>
  <button class="danger" type="submit" name="go" value="remove">Remove from the cabinet</button></p>
  <p class="muted">Removing ends their sessions and assignments at once; their passkeys stop working. Their comments stay with the cases.</p>
</form><p><a href="/admin">Back</a></p>`, 200, { nav: nav(me) })
}

export async function personPost(req: Request, env: Env, id: number): Promise<Response> {
  const me = await admin(req, env); if (me instanceof Response) return me
  const p = await env.DB.prepare('SELECT * FROM people WHERE id = ? AND active = 1').bind(id).first<Person>()
  if (!p) return adminHome(req, env, notice('No such person.', 'bad'))
  const f = await req.formData()
  const go = String(f.get('go') ?? '')
  const activeAdmins = (await env.DB.prepare('SELECT COUNT(*) AS n FROM people WHERE is_admin = 1 AND active = 1').first<{ n: number }>())?.n ?? 0
  const losesAdmin = p.is_admin && (go === 'remove' || !f.get('is_admin'))
  if (losesAdmin && activeAdmins <= 1) return personPage(req, env, id, notice('The cabinet must keep at least one administrator. Add another first.', 'bad'))
  if (go === 'enrol') return enrolmentShown(req, env, me, p.id, p.display_name)
  if (go === 'remove') {
    const now = nowIso()
    await env.DB.batch([
      env.DB.prepare('UPDATE people SET active = 0, removed_at = ? WHERE id = ?').bind(now, id),
      env.DB.prepare('DELETE FROM sessions WHERE person_id = ?').bind(id),
      env.DB.prepare('UPDATE assignments SET revoked_at = ? WHERE person_id = ? AND revoked_at IS NULL').bind(now, id),
      env.DB.prepare('DELETE FROM passkeys WHERE person_id = ?').bind(id),
      env.DB.prepare('UPDATE enrolments SET expires_at = ? WHERE person_id = ? AND used_at IS NULL').bind(now, id),
    ])
    return adminHome(req, env, notice(`${p.display_name} has been removed.`, 'good'))
  }
  const sub = String(f.get('sub') ?? '').trim() || null
  if (sub && !isSub(sub)) return personPage(req, env, id, notice('That does not look like a My College ID (p_…).', 'bad'))
  if (sub && await env.DB.prepare('SELECT 1 FROM people WHERE sub = ? AND id != ?').bind(sub, id).first()) return personPage(req, env, id, notice('Someone else here has that ID.', 'bad'))
  await env.DB.prepare('UPDATE people SET sub = ?, is_admin = ?, can_finalise = ?, can_retain = ? WHERE id = ?')
    .bind(sub, f.get('is_admin') ? 1 : 0, f.get('can_finalise') ? 1 : 0, f.get('can_retain') ? 1 : 0, id).run()
  return personPage(req, env, id, notice('Saved.', 'good'))
}

// ── a case: assignments and retention ────────────────────────────────────────

export async function adminCase(req: Request, env: Env, ref: string, message = ''): Promise<Response> {
  const me = await admin(req, env); if (me instanceof Response) return me
  const c = isCaseRef(ref) ? await getCase(env, ref) : null
  if (!c || c.state !== 'open') return adminHome(req, env, notice('That case is closed or does not exist.', 'bad'))
  const ctx = parseContext(c.context ? JSON.parse(c.context) : null)
  const people = (await env.DB.prepare(`SELECT p.id, p.display_name, p.sub, a.assigned_at, a.revoked_at FROM people p
      LEFT JOIN assignments a ON a.person_id = p.id AND a.case_ref = ? WHERE p.active = 1 ORDER BY p.display_name`).bind(ref)
    .all<{ id: number; display_name: string; sub: string | null; assigned_at: string | null; revoked_at: string | null }>()).results
  const canRetain = me.can_retain || me.is_admin
  return page(env, c.candidate_name ?? 'Case', `${message}
<p class="muted">Case ${esc(ref.slice(3, 11).toUpperCase())} · ${esc(ctx?.subject ?? ctx?.relates_to ?? '')} · last activity ${esc(when(c.last_activity_at))}</p>
<h2>Reviewers</h2>
<form class="card" method="post" action="/admin/case/${esc(ref)}/assign"><table>
${people.map(p => {
  const on = p.assigned_at && !p.revoked_at
  return `<tr><td>${esc(p.display_name)}${p.sub ? '' : ' <span class="muted">(no My College ID)</span>'}</td><td>${on ? `assigned ${esc(when(p.assigned_at))}` : p.revoked_at ? `revoked ${esc(when(p.revoked_at))}` : ''}</td>
  <td><button class="${on ? 'danger' : 'secondary'}" type="submit" name="${on ? 'revoke' : 'assign'}" value="${p.id}">${on ? 'Revoke' : 'Assign'}</button></td></tr>`
}).join('')}</table><p class="muted">Revoking takes effect on the person's next request, even mid-session.</p></form>
<h2>Retention</h2>
<div class="card">
${c.ebvs_hold ? '<p>Under an EBVS appeal hold: kept until EBVS releases it.</p>' : ''}
${c.retain_until ? `<p>Flagged for retention until <b>${esc(when(c.retain_until))}</b>. Reason: ${esc(c.retain_reason ?? '')}</p>` : '<p>Not flagged. The 18-month rule deletes the case 18 months after its last activity, after a reminder.</p>'}
${canRetain ? `<form method="post" action="/case/${esc(ref)}/retain">
  <label for="reason">${c.retain_until ? 'Renew for six months: reason' : 'Flag for six months: reason'}</label><input id="reason" name="reason" type="text" maxlength="300" required>
  <p class="row"><button type="submit" name="go" value="flag">${c.retain_until ? 'Renew the flag' : 'Flag for retention'}</button>${c.retain_until ? '<button class="secondary" type="submit" name="go" value="clear" formnovalidate>Remove the flag</button>' : ''}</p>
</form>` : '<p class="muted">Only people allowed to retain cases can flag one.</p>'}
</div>
<h2>Dispose of the case</h2>
<form class="card" method="post" action="/admin/case/${esc(ref)}/dispose">
  <p>Once the appeal window has passed with no appeal, delete the evidence, the discussion, the drafts and the rationale now, and tell My College. This cannot be undone.</p>
  ${c.ebvs_hold ? '<p class="muted">Not while EBVS holds it for an appeal.</p>' : `<label style="font-weight:400"><input type="checkbox" name="confirm" value="1" required> I confirm the College's retention policy allows deleting this case now.</label>
  <p><button class="danger" type="submit">Dispose of the case</button></p>`}
</form><p><a href="/admin">Back</a></p>`, 200, { nav: nav(me) })
}

/** Spec §6 step 9: the College disposes of a case under its retention policy. */
export async function disposePost(req: Request, env: Env, ctx: ExecutionContext, ref: string): Promise<Response> {
  const me = await admin(req, env); if (me instanceof Response) return me
  const c = isCaseRef(ref) ? await getCase(env, ref) : null
  if (!c || c.state !== 'open') return adminHome(req, env, notice('That case is already closed.', 'bad'))
  if (c.ebvs_hold) return adminCase(req, env, ref, notice('EBVS holds this case for an appeal. It is deleted when EBVS releases it.', 'bad'))
  if ((await req.formData()).get('confirm') !== '1') return adminCase(req, env, ref, notice('Tick the confirmation first.', 'bad'))
  const done = await dispose(env, ref, 'closed')
  ctx.waitUntil(deliverDue(env))
  return adminHome(req, env, done ? notice('The case is disposed of. My College is being told.', 'good') : notice('Some files could not be deleted yet. Try again shortly.', 'bad'))
}

export async function assignPost(req: Request, env: Env, ref: string): Promise<Response> {
  const me = await admin(req, env); if (me instanceof Response) return me
  const f = await req.formData()
  const now = nowIso()
  const assign = Number(f.get('assign')), revoke = Number(f.get('revoke'))
  if (Number.isInteger(assign) && assign > 0) {
    await env.DB.prepare(`INSERT INTO assignments (case_ref, person_id, assigned_by, assigned_at) SELECT ?, id, ?, ? FROM people WHERE id = ? AND active = 1
        ON CONFLICT(case_ref, person_id) DO UPDATE SET revoked_at = NULL, assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at`).bind(ref, me.id, now, assign).run()
  } else if (Number.isInteger(revoke) && revoke > 0) {
    await env.DB.prepare('UPDATE assignments SET revoked_at = ? WHERE case_ref = ? AND person_id = ? AND revoked_at IS NULL').bind(now, ref, revoke).run()
  }
  return back(`/admin/case/${ref}`)
}

/** RET-03: an administrator, or an assigned committee member allowed to retain. */
export async function retainPost(req: Request, env: Env, ref: string): Promise<Response> {
  const me = await staff(req, env)
  if (!me) return back('/signin')
  const allowed = me.is_admin || (me.can_retain && await assigned(env, me.id, ref))
  if (!allowed) return page(env, 'Not allowed', notice('You cannot flag this case for retention.', 'bad'), 403, { nav: nav(me) })
  const done = (msg: string, kind: 'good' | 'bad') => me.is_admin ? adminCase(req, env, ref, notice(msg, kind)) : back(`/case/${ref}`)
  const f = await req.formData()
  if (f.get('go') === 'clear') {
    // Keeping a case is open to those allowed to retain; ending the flag is an administrator's.
    if (!me.is_admin) return page(env, 'Not allowed', notice('Only an administrator can remove a retention flag.', 'bad'), 403, { nav: nav(me) })
    await env.DB.prepare('UPDATE cases SET retain_until = NULL, retain_reason = NULL, retain_by = NULL, reminded_retention_at = NULL WHERE case_ref = ?').bind(ref).run()
    await fromHold(env, ref)
    return done('The flag is removed. The 18-month rule applies again.', 'good')
  }
  const reason = String(f.get('reason') ?? '').trim().slice(0, 300)
  if (!reason) return done('Give the reason for keeping it.', 'bad')
  await env.DB.prepare('UPDATE cases SET retain_until = ?, retain_reason = ?, retain_by = ?, reminded_retention_at = NULL, reminded_deletion_at = NULL WHERE case_ref = ? AND state = \'open\'')
    .bind(flagUntil().toISOString(), reason, me.id, ref).run()
  await toHold(env, ref)
  return done('Flagged for six months. You will be reminded 30 days before it lapses.', 'good')
}

export async function retryEventPost(req: Request, env: Env, ctx: ExecutionContext, id: number): Promise<Response> {
  const me = await admin(req, env); if (me instanceof Response) return me
  await retryEvent(env, id)
  ctx.waitUntil(deliverDue(env))
  return back('/admin')
}
