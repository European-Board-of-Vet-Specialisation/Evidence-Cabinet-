// The reviewer's side: their cases, unread activity first; one case with its evidence and its
// discussion in the same view (DISC-01). Every request re-checks the signed-in person and their
// assignment (DISC-02), so removal or revocation takes effect on the next click.

import type { Env } from '../env'
import { staff, assigned, type Person } from '../session'
import { getCase, touchStmt, type CaseRow } from '../cases'
import { queueEvent, deliverDue } from '../outbox'
import { page, notice } from '../ui/layout'
import { esc, isCaseRef, nowIso } from '../util'
import { parseContext } from '../context'

export const MAX_COMMENT = 5000
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Brussels' })
const shortRef = (ref: string) => ref.slice(3, 11).toUpperCase()

export function nav(me: Person): string {
  return `<a href="/cases">My cases</a>${me.is_admin ? ' <a href="/admin">Administration</a>' : ''}
<form method="post" action="/signout" style="display:inline"><button class="secondary" type="submit">Sign out</button></form>`
}

/** The College's country rule (VIEW_COUNTRIES): applies to statements, discussion and decisions as well as files. */
export function countryAllowed(req: Request, env: Env): boolean {
  const allow = env.VIEW_COUNTRIES.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  if (!allow.length) return true
  const country = (req as Request & { cf?: { country?: string } }).cf?.country
  return !!country && allow.includes(country.toUpperCase())
}

const toSignin = (req: Request) => new Response(null, { status: 303, headers: { Location: `/signin?next=${encodeURIComponent(new URL(req.url).pathname)}`, 'Cache-Control': 'no-store' } })

/** Signed in, and assigned to this open case. Returns the refusal page otherwise. */
export async function forCase(req: Request, env: Env, ref: string): Promise<{ me: Person; c: CaseRow } | Response> {
  const me = await staff(req, env)
  if (!me) return toSignin(req)
  if (!isCaseRef(ref)) return page(env, 'Not found', notice('There is no such case.'), 404, { nav: nav(me) })
  if (!countryAllowed(req, env)) return page(env, 'Not available here', notice(`Cases cannot be opened from your current country under ${env.COLLEGE}'s rules.`, 'bad'), 403, { nav: nav(me) })
  if (!(await assigned(env, me.id, ref))) return page(env, 'Not assigned', notice('You are not assigned to this case. Ask your College administrator.'), 403, { nav: nav(me) })
  const c = await getCase(env, ref)
  if (!c || c.state !== 'open') return page(env, 'Case closed', notice('This case has been closed and its records deleted.'), 404, { nav: nav(me) })
  return { me, c }
}

// ── the list ─────────────────────────────────────────────────────────────────

export async function caseList(req: Request, env: Env): Promise<Response> {
  const me = await staff(req, env)
  if (!me) return toSignin(req)
  // Unread: a comment by someone else, a new submission or a new decision since this person
  // last opened the case — or never opened at all.
  const rows = (await env.DB.prepare(`
    SELECT c.case_ref, c.context, c.candidate_name, c.last_activity_at, c.retain_until, c.ebvs_hold, r.last_read_at,
      (SELECT COUNT(*) FROM comments k WHERE k.case_ref = c.case_ref AND k.person_id != ?1 AND (r.last_read_at IS NULL OR k.created_at > r.last_read_at)) AS new_comments,
      (SELECT COUNT(*) FROM evidence_versions v WHERE v.case_ref = c.case_ref AND v.complete = 1 AND (r.last_read_at IS NULL OR v.completed_at > r.last_read_at)) AS new_evidence,
      (SELECT COUNT(*) FROM decisions d WHERE d.case_ref = c.case_ref AND d.finalised_at IS NOT NULL AND (r.last_read_at IS NULL OR d.finalised_at > r.last_read_at)) AS new_decisions,
      (SELECT MAX(version) FROM decisions d WHERE d.case_ref = c.case_ref AND d.finalised_at IS NOT NULL) AS decided_version
    FROM assignments a JOIN cases c ON c.case_ref = a.case_ref
    LEFT JOIN reads r ON r.case_ref = c.case_ref AND r.person_id = ?1
    WHERE a.person_id = ?1 AND a.revoked_at IS NULL AND c.state = 'open'
    ORDER BY (new_comments + new_evidence + new_decisions) > 0 DESC, c.last_activity_at DESC`).bind(me.id)
    .all<{ case_ref: string; context: string | null; candidate_name: string | null; last_activity_at: string; retain_until: string | null; ebvs_hold: number; last_read_at: string | null; new_comments: number; new_evidence: number; new_decisions: number; decided_version: number | null }>()).results
  const body = rows.length
    ? `<div class="card"><table><tr><th>Case</th><th>About</th><th></th><th>Last activity</th></tr>${rows.map(r => {
        const ctx = parseContext(r.context ? JSON.parse(r.context) : null)
        const unread = r.new_comments + r.new_evidence + r.new_decisions
        const bits = [r.new_comments ? `${r.new_comments} new comment${r.new_comments === 1 ? '' : 's'}` : '', r.new_evidence ? 'new evidence' : '', r.new_decisions ? 'new decision' : ''].filter(Boolean).join(', ')
        return `<tr><td><a href="/case/${esc(r.case_ref)}">${esc(r.candidate_name ?? 'Candidate')}</a><br><span class="muted">${esc(shortRef(r.case_ref))}</span></td>
          <td>${esc(ctx?.subject ?? ctx?.relates_to ?? '')}</td>
          <td>${unread ? `<span class="tag unread">${esc(r.last_read_at ? bits : 'not opened')}</span>` : ''} ${r.decided_version ? `<span class="tag">decided</span>` : ''} ${r.ebvs_hold ? '<span class="tag">EBVS appeal hold</span>' : ''} ${r.retain_until ? '<span class="tag">retained</span>' : ''}</td>
          <td class="muted">${esc(when(r.last_activity_at))}</td></tr>`
      }).join('')}</table></div>`
    : notice('No cases are assigned to you. Your College administrator assigns cases here.')
  return page(env, 'My cases', body, 200, { nav: nav(me) })
}

// ── one case ─────────────────────────────────────────────────────────────────

export async function caseView(req: Request, env: Env, ref: string, message = ''): Promise<Response> {
  const g = await forCase(req, env, ref); if (g instanceof Response) return g
  const { me, c } = g
  const ctx = parseContext(c.context ? JSON.parse(c.context) : null)
  const [versions, files, comments, decision] = await Promise.all([
    env.DB.prepare('SELECT version, statement, completed_at FROM evidence_versions WHERE case_ref = ? AND complete = 1 ORDER BY version').bind(ref).all<{ version: number; statement: string; completed_at: string }>(),
    env.DB.prepare('SELECT id, version, kind, size, label FROM files WHERE case_ref = ? ORDER BY version, created_at').bind(ref).all<{ id: string; version: number; kind: string; size: number; label: string }>(),
    env.DB.prepare(`SELECT k.id, k.body, k.file_id, k.corrects_id, k.created_at, k.person_id, p.display_name FROM comments k JOIN people p ON p.id = k.person_id WHERE k.case_ref = ? ORDER BY k.created_at, k.id`).bind(ref)
      .all<{ id: number; body: string; file_id: string | null; corrects_id: number | null; created_at: string; person_id: number; display_name: string }>(),
    env.DB.prepare('SELECT version, decision_type, outcome, finalised_at, mc_state FROM decisions WHERE case_ref = ? AND finalised_at IS NOT NULL ORDER BY version DESC LIMIT 1').bind(ref)
      .first<{ version: number; decision_type: string; outcome: string; finalised_at: string; mc_state: string | null }>(),
  ])
  await env.DB.prepare('INSERT INTO reads (case_ref, person_id, last_read_at) VALUES (?, ?, ?) ON CONFLICT(case_ref, person_id) DO UPDATE SET last_read_at = excluded.last_read_at').bind(ref, me.id, nowIso()).run()

  const fileLabel = new Map(files.results.map(f => [f.id, f.label]))
  const corrected = new Map<number, typeof comments.results>()
  for (const k of comments.results) if (k.corrects_id != null) corrected.set(k.corrects_id, [...(corrected.get(k.corrects_id) ?? []), k])

  const evidence = versions.results.length ? versions.results.map(v => `
    <div class="card"><h2>Submission ${v.version} <span class="muted">· ${esc(when(v.completed_at))}</span></h2>
      <p style="white-space:pre-wrap">${esc(v.statement)}</p>
      ${files.results.filter(f => f.version === v.version).map(f => `<p><a class="btn secondary" href="/case/${esc(ref)}/file/${esc(f.id)}">View ${esc(f.label)}</a> <span class="muted">${esc(f.kind.toUpperCase())}, ${Math.ceil(f.size / 1024)} KB</span></p>`).join('')}
    </div>`).join('') : notice('The candidate has not submitted anything yet.', 'warn')

  const thread = comments.results.filter(k => k.corrects_id == null).map(k => {
    const fixes = corrected.get(k.id) ?? []
    return `<div class="card"><div class="row"><b>${esc(k.display_name)}</b><span class="muted">${esc(when(k.created_at))}</span>${k.file_id ? `<span class="tag">about ${esc(fileLabel.get(k.file_id) ?? 'a document')}</span>` : ''}</div>
      <p style="white-space:pre-wrap${fixes.length ? ';text-decoration:line-through;color:#8a97a8' : ''}">${esc(k.body)}</p>
      ${fixes.map(x => `<p style="white-space:pre-wrap"><span class="tag">correction by ${esc(x.display_name)}, ${esc(when(x.created_at))}</span><br>${esc(x.body)}</p>`).join('')}
      ${k.person_id === me.id ? `<details><summary class="muted">Correct this comment</summary>
        <form method="post" action="/case/${esc(ref)}/comment/${k.id}/correct"><textarea name="body" maxlength="${MAX_COMMENT}" required></textarea><p><button type="submit">Save correction</button></p></form></details>` : ''}
    </div>`
  }).join('')

  const status = decision
    ? `Decision version ${decision.version} (${esc(decision.decision_type)}): ${decision.outcome === 'upheld' ? 'upheld' : 'not upheld'} · ${decision.mc_state === 'recorded' ? 'Recorded in My College' : decision.mc_state === 'refused' ? 'My College refused it: see the decision page' : 'Decision recorded · awaiting My College confirmation'}`
    : 'No decision yet.'

  return page(env, c.candidate_name ?? 'Case', `${message}
<p class="muted">Case ${esc(shortRef(ref))} · ${esc(ctx?.subject ?? ctx?.relates_to ?? 'Claim')}${c.ebvs_hold ? ' · under EBVS appeal hold' : ''}${c.retain_until ? ` · retained until ${esc(when(c.retain_until))}` : ''}</p>
<div class="card row"><span>${status}</span><a class="btn secondary" href="/case/${esc(ref)}/decision">Decision</a></div>
<h2>Evidence</h2>${evidence}
${me.can_retain && !me.is_admin ? `<details class="card"><summary>Retention</summary>
  <p class="muted">${c.retain_until ? `Flagged until ${esc(when(c.retain_until))}.` : 'Not flagged: deleted 18 months after its last activity, after a reminder.'}</p>
  <form method="post" action="/case/${esc(ref)}/retain"><label for="reason">Reason to keep it for six months</label><input id="reason" name="reason" type="text" maxlength="300" required>
  <p><button type="submit" name="go" value="flag">${c.retain_until ? 'Renew the flag' : 'Flag for retention'}</button></p></form></details>` : ''}
<h2>Discussion</h2>
<p class="muted">Only the reviewers assigned to this case read this. It stays in the cabinet and is deleted with the case.</p>
${thread || '<p class="muted">No comments yet.</p>'}
<form class="card" method="post" action="/case/${esc(ref)}/comment">
  <label for="body">Add a comment</label><textarea id="body" name="body" maxlength="${MAX_COMMENT}" required></textarea>
  ${files.results.length ? `<label for="file">About a document (optional)</label><select id="file" name="file_id"><option value="">—</option>${files.results.map(f => `<option value="${esc(f.id)}">${esc(f.label)}</option>`).join('')}</select>` : ''}
  <p><button type="submit">Post comment</button></p>
  <p class="muted">The other assigned reviewers get an email saying there is an unread comment. It names no one and no case.</p>
</form>`, 200, { nav: nav(me) })
}

// ── comments ─────────────────────────────────────────────────────────────────

/** Other reviewers currently assigned, by their My College ID — whom to notify. */
async function othersToNotify(env: Env, ref: string, author: number): Promise<string[]> {
  const rows = (await env.DB.prepare(`SELECT p.sub FROM assignments a JOIN people p ON p.id = a.person_id
      WHERE a.case_ref = ? AND a.revoked_at IS NULL AND p.active = 1 AND p.sub IS NOT NULL AND p.id != ?`).bind(ref, author).all<{ sub: string }>()).results
  return [...new Set(rows.map(r => r.sub))].slice(0, 50)
}

async function addComment(env: Env, ctx: ExecutionContext, ref: string, me: Person, body: string, fileId: string | null, corrects: number | null): Promise<void> {
  const now = nowIso()
  const recipients = await othersToNotify(env, ref, me.id)
  // The comment and its notification are saved together (spec 6.3, delivery).
  await env.DB.batch([
    env.DB.prepare('INSERT INTO comments (case_ref, person_id, body, file_id, corrects_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(ref, me.id, body, fileId, corrects, now),
    env.DB.prepare('INSERT INTO reads (case_ref, person_id, last_read_at) VALUES (?, ?, ?) ON CONFLICT(case_ref, person_id) DO UPDATE SET last_read_at = excluded.last_read_at').bind(ref, me.id, now),
    touchStmt(env, ref),
    ...(recipients.length ? [queueEvent(env, 'reviewer.notification_requested', { kind: 'comment', recipients })] : []),
  ])
  ctx.waitUntil(deliverDue(env))
}

export async function postComment(req: Request, env: Env, ctx: ExecutionContext, ref: string): Promise<Response> {
  const g = await forCase(req, env, ref); if (g instanceof Response) return g
  const f = await req.formData()
  const body = String(f.get('body') ?? '').trim()
  if (!body || body.length > MAX_COMMENT) return caseView(req, env, ref, notice(`A comment is 1 to ${MAX_COMMENT} characters.`, 'bad'))
  const fileId = String(f.get('file_id') ?? '') || null
  if (fileId && !(await env.DB.prepare('SELECT 1 FROM files WHERE id = ? AND case_ref = ?').bind(fileId, ref).first())) return caseView(req, env, ref, notice('That document is not in this case.', 'bad'))
  await addComment(env, ctx, ref, g.me, body, fileId, null)
  return new Response(null, { status: 303, headers: { Location: `/case/${ref}#body`, 'Cache-Control': 'no-store' } })
}

/** DISC-04: a correction is a new entry; the original stays, struck through. Authors only. */
export async function correctComment(req: Request, env: Env, ctx: ExecutionContext, ref: string, id: number): Promise<Response> {
  const g = await forCase(req, env, ref); if (g instanceof Response) return g
  const orig = await env.DB.prepare('SELECT person_id, file_id FROM comments WHERE id = ? AND case_ref = ? AND corrects_id IS NULL').bind(id, ref).first<{ person_id: number; file_id: string | null }>()
  if (!orig || orig.person_id !== g.me.id) return caseView(req, env, ref, notice('You can correct only your own comments.', 'bad'))
  const body = String((await req.formData()).get('body') ?? '').trim()
  if (!body || body.length > MAX_COMMENT) return caseView(req, env, ref, notice(`A correction is 1 to ${MAX_COMMENT} characters.`, 'bad'))
  await addComment(env, ctx, ref, g.me, body, orig.file_id, id)
  return new Response(null, { status: 303, headers: { Location: `/case/${ref}`, 'Cache-Control': 'no-store' } })
}
