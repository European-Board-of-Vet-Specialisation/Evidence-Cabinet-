// GET /case/:ref/file/:id        the viewer page
// GET /case/:ref/file/:id/raw    the bytes, for the viewer only
//
// Both re-check the signed-in reviewer and their assignment. The bytes also check the reviewer's
// country and are logged: reviewer, case, file, time, country (spec §8).

import type { Env } from '../env'
import { forCase, nav, countryAllowed } from './cases'
import { objectKey } from '../cases'
import { page, notice } from '../ui/layout'
import { esc, nowIso, NO_STORE } from '../util'

const VIEWER_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"

async function fileOf(env: Env, ref: string, id: string) {
  return /^[0-9a-f-]{36}$/.test(id) ? env.DB.prepare('SELECT id, version, kind, label FROM files WHERE id = ? AND case_ref = ?').bind(id, ref).first<{ id: string; version: number; kind: string; label: string }>() : null
}

export async function viewerPage(req: Request, env: Env, ref: string, id: string): Promise<Response> {
  const g = await forCase(req, env, ref); if (g instanceof Response) return g
  const f = await fileOf(env, ref, id)
  if (!f) return page(env, 'Not found', notice('There is no such document in this case.'), 404, { nav: nav(g.me) })
  if (!countryAllowed(req, env)) return page(env, 'Not available here', notice(`Evidence cannot be viewed from your current country under ${env.COLLEGE}'s rules.`, 'bad'), 403, { nav: nav(g.me) })
  const mark = `${g.me.display_name} · ${new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Brussels' })} · ${env.COLLEGE}`
  const res = page(env, f.label, `<p><a href="/case/${esc(ref)}">← Back to the case</a></p>
<p class="muted">Every view is logged. Do not copy, photograph or share this document.</p>
<p id="status" class="muted" role="status">Opening…</p>
<div id="viewer" data-src="/case/${esc(ref)}/file/${esc(id)}/raw" data-mark="${esc(mark)}"></div>
<script type="module" src="/static/viewer.js"></script>`, 200, { nav: nav(g.me) })
  res.headers.set('Content-Security-Policy', VIEWER_CSP)
  return res
}

export async function viewerRaw(req: Request, env: Env, ref: string, id: string): Promise<Response> {
  const deny = (s: number) => new Response(null, { status: s, headers: NO_STORE })
  // Only the viewer asks for bytes; a pasted link or a plain navigation gets nothing.
  if (req.headers.get('X-Cabinet-Viewer') !== '1' || req.headers.get('Sec-Fetch-Dest') === 'document') return deny(400)
  const g = await forCase(req, env, ref); if (g instanceof Response) return deny(g.status === 303 ? 401 : g.status)
  if (!countryAllowed(req, env)) return deny(403)
  const f = await fileOf(env, ref, id); if (!f) return deny(404)
  const c = g.c
  const obj = await env.EVIDENCE.get(objectKey(c.location, ref, f.version, f.id))
  if (!obj) return deny(404)
  const country = (req as Request & { cf?: { country?: string } }).cf?.country ?? null
  await env.DB.prepare('INSERT INTO view_log (case_ref, file_id, person_id, country, at) VALUES (?, ?, ?, ?, ?)').bind(ref, f.id, g.me.id, country, nowIso()).run()
  return new Response(obj.body, { status: 200, headers: {
    ...NO_STORE, 'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
    'Content-Disposition': 'inline', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'; sandbox",
  } })
}
