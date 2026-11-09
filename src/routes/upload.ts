// The candidate's page: the College's privacy notice, a statement, and files. Each submission is
// a new version; earlier versions remain. Nothing is recorded until every file is stored, and
// the receipt to My College is queued in the same batch as the record.

import type { Env } from '../env'
import { candidate } from '../session'
import { getCase, objectKey, touchStmt } from '../cases'
import { queueEvent, deliverDue } from '../outbox'
import { checkFile, CONTENT_TYPE, MAX_FILES, MAX_STATEMENT, type Kind } from '../filetype'
import { page, notice } from '../ui/layout'
import { esc, nowIso } from '../util'

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Brussels' })

async function receipts(env: Env, ref: string): Promise<string> {
  const rows = (await env.DB.prepare(`SELECT v.version, v.completed_at, COUNT(f.id) AS n FROM evidence_versions v
      LEFT JOIN files f ON f.case_ref = v.case_ref AND f.version = v.version
      WHERE v.case_ref = ? AND v.complete = 1 GROUP BY v.version ORDER BY v.version`).bind(ref).all<{ version: number; completed_at: string; n: number }>()).results
  if (!rows.length) return ''
  return `<div class="card"><h2>Received</h2><table>${rows.map(r =>
    `<tr><td>Submission ${r.version}</td><td>${r.n} document${r.n === 1 ? '' : 's'} and your account</td><td class="muted">${esc(when(r.completed_at))}</td></tr>`).join('')}</table>
    <p class="muted">Only ${esc(env.COLLEGE)}'s assigned reviewers can open what you sent. You can add more below; earlier submissions are kept.</p></div>`
}

export async function uploadPage(req: Request, env: Env, message = ''): Promise<Response> {
  const me = await candidate(req, env)
  if (!me) return page(env, 'Session ended', notice('Open your claim in My College again and select Submit evidence.', 'warn'), 401)
  const c = await getCase(env, me.case_ref)
  if (!c || c.state !== 'open') return page(env, 'Claim closed', notice('This claim is closed. Its evidence has been deleted.'))
  return page(env, 'Submit your evidence', `${message}
<div class="card">
  <p>Your account and documents go only to ${esc(env.COLLEGE)}. They are stored in the EU and may pass briefly through Cloudflare servers in other countries. Read the <a href="${esc(env.PRIVACY_NOTICE_URL)}" rel="noopener noreferrer" target="_blank">${esc(env.COLLEGE)} privacy notice</a> before you send anything.</p>
</div>
${await receipts(env, me.case_ref)}
<form class="card" method="post" action="/upload" enctype="multipart/form-data">
  <label for="name">Your name</label>
  <input id="name" name="name" type="text" maxlength="120" required value="${esc(c.candidate_name ?? '')}" autocomplete="name">
  <label for="statement">Your account</label>
  <p class="muted">What happened and how it affected you. ${esc(env.COLLEGE)} reads this with your documents.</p>
  <textarea id="statement" name="statement" maxlength="${MAX_STATEMENT}" required></textarea>
  <label for="files">Supporting documents</label>
  <p class="muted">PDF, PNG or JPEG, up to 20 MB each, up to ${MAX_FILES} at a time.</p>
  <input id="files" name="files" type="file" accept="application/pdf,image/png,image/jpeg" multiple>
  <p><button type="submit">Send to ${esc(env.COLLEGE)}</button></p>
</form>`)
}

export async function uploadPost(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const me = await candidate(req, env)
  if (!me) return page(env, 'Session ended', notice('Open your claim in My College again and select Submit evidence.', 'warn'), 401)
  const c = await getCase(env, me.case_ref)
  if (!c || c.state !== 'open') return page(env, 'Claim closed', notice('This claim is closed. Its evidence has been deleted.'))

  const form = await req.formData().catch(() => null)
  if (!form) return uploadPage(req, env, notice('The upload did not arrive complete. Try again.', 'bad'))
  const name = String(form.get('name') ?? '').trim().slice(0, 120)
  if (!name) return uploadPage(req, env, notice('Enter your name, so the College knows whose claim this is.', 'bad'))
  const statement = String(form.get('statement') ?? '').trim()
  if (!statement) return uploadPage(req, env, notice('Write your account before sending.', 'bad'))
  if (statement.length > MAX_STATEMENT) return uploadPage(req, env, notice('Your account is too long.', 'bad'))
  const files = form.getAll('files').filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f && (f as File).size > 0)
  if (files.length > MAX_FILES) return uploadPage(req, env, notice(`Send up to ${MAX_FILES} documents at a time.`, 'bad'))

  // Check every file before storing any. Errors name the position, never the filename.
  const checked: Array<{ bytes: Uint8Array; kind: Kind }> = []
  for (const [i, f] of files.entries()) {
    const bytes = new Uint8Array(await f.arrayBuffer())
    const r = checkFile(bytes)
    if (!r.ok) return uploadPage(req, env, notice(`Document ${i + 1} ${r.error}. Nothing was sent.`, 'bad'))
    checked.push({ bytes, kind: r.kind })
  }

  const last = await env.DB.prepare('SELECT MAX(version) AS v FROM evidence_versions WHERE case_ref = ?').bind(me.case_ref).first<{ v: number | null }>()
  const version = (last?.v ?? 0) + 1
  const stored: string[] = []
  const ids: Array<{ id: string; kind: Kind; size: number }> = []
  try {
    for (const f of checked) {
      const id = crypto.randomUUID()
      const key = objectKey(c.location, me.case_ref, version, id)
      await env.EVIDENCE.put(key, f.bytes, { httpMetadata: { contentType: CONTENT_TYPE[f.kind] } })
      stored.push(key); ids.push({ id, kind: f.kind, size: f.bytes.length })
    }
  } catch {
    // Interrupted: nothing is recorded, and what was stored is removed. The submission stays incomplete.
    if (stored.length) await env.EVIDENCE.delete(stored).catch(() => {})
    return uploadPage(req, env, notice('The upload was interrupted. Nothing was sent. Try again.', 'bad'))
  }

  const now = nowIso()
  const label = (n: number) => `Submission ${version}, document ${n}`
  try { await env.DB.batch([
    env.DB.prepare('INSERT INTO evidence_versions (case_ref, version, statement, complete, created_at, completed_at) VALUES (?, ?, ?, 1, ?, ?)').bind(me.case_ref, version, statement, now, now),
    ...ids.map((f, i) => env.DB.prepare('INSERT INTO files (id, case_ref, version, kind, size, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(f.id, me.case_ref, version, f.kind, f.size, label(i + 1), now)),
    touchStmt(env, me.case_ref),
    env.DB.prepare('UPDATE cases SET candidate_name = ? WHERE case_ref = ?').bind(name, me.case_ref),
    queueEvent(env, 'evidence.received', { case_ref: me.case_ref, version, status: 'received', at: now }),
  ]) } catch {
    // Another submission took this version number at the same moment: keep nothing of this one.
    await env.EVIDENCE.delete(stored).catch(() => {})
    return uploadPage(req, env, notice('Another submission arrived at the same time. Nothing was sent from this one. Try again.', 'bad'))
  }
  ctx.waitUntil(deliverDue(env))
  return uploadPage(req, env, notice(`Received. Submission ${version}, with ${ids.length} document${ids.length === 1 ? '' : 's'}, is with ${env.COLLEGE}.`, 'good'))
}
