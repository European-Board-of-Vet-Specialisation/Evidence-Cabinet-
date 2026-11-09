// Signing in. College users have passkeys and nothing else: no passwords, no email codes, and no
// route by which EBVS could enrol anyone. An administrator gives a person a one-time enrolment
// link; the person creates a passkey on their own device. The first administrator is enrolled
// once, with the SETUP_TOKEN secret the College set when it deployed.

import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import type { Env } from '../env'
import { startStaffSession, endStaffSession, staff, STAFF_COOKIE } from '../session'
import { page, notice } from '../ui/layout'
import { cookie, setCookie, clearCookie, randomId, sha256, nowIso, esc, NO_STORE } from '../util'
import { publicJwk } from '../mc'

const CHALLENGE_COOKIE = '__Host-cab_ch'
const rp = (env: Env) => ({ id: new URL(env.CABINET_ORIGIN).hostname, name: `${env.COLLEGE} evidence cabinet`, origin: env.CABINET_ORIGIN })
const json = (status: number, body: unknown, ...cookies: string[]) => {
  const h = new Headers({ 'Content-Type': 'application/json', ...NO_STORE })
  for (const c of cookies) h.append('Set-Cookie', c)
  return new Response(JSON.stringify(body), { status, headers: h })
}

async function saveChallenge(env: Env, challenge: string, purpose: 'register' | 'authenticate', personId: number | null): Promise<string> {
  const id = randomId()
  await env.DB.prepare('INSERT INTO challenges (id, challenge, purpose, person_id, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256(id), challenge, purpose, personId, new Date(Date.now() + 300_000).toISOString()).run()
  return setCookie(CHALLENGE_COOKIE, id, 300)
}
async function takeChallenge(req: Request, env: Env, purpose: string): Promise<{ challenge: string; person_id: number | null } | null> {
  const id = cookie(req, CHALLENGE_COOKIE); if (!id) return null
  const h = await sha256(id)
  const row = await env.DB.prepare('SELECT challenge, person_id FROM challenges WHERE id = ? AND purpose = ? AND expires_at > ?').bind(h, purpose, nowIso()).first<{ challenge: string; person_id: number | null }>()
  await env.DB.prepare('DELETE FROM challenges WHERE id = ?').bind(h).run()   // single use, even on failure
  return row
}

// ── enrolment links ──────────────────────────────────────────────────────────

/** A one-time link to enrol a passkey, valid for seven days. */
export async function createEnrolment(env: Env, personId: number, by: number | null): Promise<string> {
  const token = randomId(32)
  const now = nowIso()
  await env.DB.batch([
    // Only the newest link works: an earlier one, forwarded or lost, can no longer add a passkey.
    env.DB.prepare('UPDATE enrolments SET expires_at = ? WHERE person_id = ? AND used_at IS NULL').bind(now, personId),
    env.DB.prepare('INSERT INTO enrolments (token_hash, person_id, created_by, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256(token), personId, by, new Date(Date.now() + 7 * 86_400_000).toISOString()),
  ])
  // The token is in the fragment: browsers never send it, so it is in no request log.
  return `${env.CABINET_ORIGIN}/enrol#${token}`
}

async function enrolmentFor(env: Env, token: string) {
  if (!/^[A-Za-z0-9_-]{30,60}$/.test(token)) return null
  return env.DB.prepare(`SELECT e.token_hash, p.id AS person_id, p.display_name FROM enrolments e JOIN people p ON p.id = e.person_id
      WHERE e.token_hash = ? AND e.used_at IS NULL AND e.expires_at > ? AND p.active = 1`).bind(await sha256(token), nowIso())
    .first<{ token_hash: string; person_id: number; display_name: string }>()
}

// ── pages ────────────────────────────────────────────────────────────────────

/** The page itself knows nothing: its script reads the token from the fragment and the API checks it. */
export async function enrolPage(env: Env): Promise<Response> {
  return page(env, 'Create your passkey', `
<div class="card"><p>This link sets up your sign-in to the ${esc(env.COLLEGE)} evidence cabinet. Your device creates a passkey and keeps it; you unlock it with your face, fingerprint or device PIN. There is no password.</p>
<p class="muted">Use your own device. The link works once, and only the newest link your administrator gave you works.</p>
<p><button id="register">Create passkey</button></p><p id="status" class="muted" role="status"></p></div>`, 200, { script: '/static/passkey.js' })
}

export async function signinPage(req: Request, env: Env): Promise<Response> {
  const next = safeNext(new URL(req.url).searchParams.get('next'))
  return page(env, 'Sign in', `
<div class="card"><p>Sign in with the passkey you created for the ${esc(env.COLLEGE)} evidence cabinet.</p>
<p><button id="signin" data-next="${esc(next)}">Sign in with a passkey</button></p><p id="status" class="muted" role="status"></p>
<p class="muted">No passkey yet? Ask your College administrator for an enrolment link.</p></div>`, 200, { script: '/static/passkey.js' })
}

const safeNext = (n: string | null) => (n && /^\/[A-Za-z0-9/_?=&.-]*$/.test(n) && !n.startsWith('//')) ? n : '/cases'

export async function signout(req: Request, env: Env): Promise<Response> {
  await endStaffSession(req, env)
  return new Response(null, { status: 303, headers: { Location: '/signin', 'Set-Cookie': clearCookie(STAFF_COOKIE), ...NO_STORE } })
}

// ── registration ─────────────────────────────────────────────────────────────

export async function registerOptions(req: Request, env: Env): Promise<Response> {
  const { token } = await req.json<{ token?: string }>().catch(() => ({ token: undefined }))
  const e = token ? await enrolmentFor(env, token) : null
  if (!e) return json(404, { ok: false, error: 'This enrolment link has expired or has been used.' })
  const existing = (await env.DB.prepare('SELECT id, transports FROM passkeys WHERE person_id = ?').bind(e.person_id).all<{ id: string; transports: string | null }>()).results
  const r = rp(env)
  const options = await generateRegistrationOptions({
    rpName: r.name, rpID: r.id, userName: e.display_name, userDisplayName: e.display_name,
    userID: new Uint8Array(new TextEncoder().encode(`cabinet-person-${e.person_id}`)),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: existing.map(c => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
  })
  return json(200, { ok: true, options }, await saveChallenge(env, options.challenge, 'register', e.person_id))
}

export async function registerVerify(req: Request, env: Env): Promise<Response> {
  const body = await req.json<{ token?: string; response?: unknown }>().catch(() => ({} as { token?: string; response?: unknown }))
  const e = body.token ? await enrolmentFor(env, body.token) : null
  const ch = await takeChallenge(req, env, 'register')
  if (!e || !ch || ch.person_id !== e.person_id) return json(400, { ok: false, error: 'This enrolment has expired. Open the link again.' })
  const r = rp(env)
  let v
  try {
    v = await verifyRegistrationResponse({ response: body.response as never, expectedChallenge: ch.challenge, expectedOrigin: r.origin, expectedRPID: r.id, requireUserVerification: true })
  } catch { return json(400, { ok: false, error: 'Your device did not create the passkey. Try again.' }) }
  if (!v.verified || !v.registrationInfo) return json(400, { ok: false, error: 'The passkey could not be verified.' })
  const c = v.registrationInfo.credential
  const now = nowIso()
  await env.DB.batch([
    env.DB.prepare('INSERT INTO passkeys (id, person_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(c.id, e.person_id, c.publicKey, c.counter, c.transports ? JSON.stringify(c.transports) : null, now),
    env.DB.prepare('UPDATE enrolments SET used_at = ? WHERE token_hash = ?').bind(now, e.token_hash),
  ])
  return json(200, { ok: true, next: '/cases' }, await startStaffSession(env, e.person_id), clearCookie(CHALLENGE_COOKIE))
}

// ── authentication ───────────────────────────────────────────────────────────

export async function authOptions(env: Env): Promise<Response> {
  const options = await generateAuthenticationOptions({ rpID: rp(env).id, userVerification: 'required', allowCredentials: [] })
  return json(200, { ok: true, options }, await saveChallenge(env, options.challenge, 'authenticate', null))
}

export async function authVerify(req: Request, env: Env): Promise<Response> {
  const body = await req.json<{ response?: { id?: string }; next?: string }>().catch(() => ({} as { response?: { id?: string }; next?: string }))
  const ch = await takeChallenge(req, env, 'authenticate')
  const id = body.response?.id
  if (!ch || typeof id !== 'string') return json(400, { ok: false, error: 'Sign-in expired. Try again.' })
  const cred = await env.DB.prepare(`SELECT k.id, k.person_id, k.public_key, k.counter, k.transports FROM passkeys k JOIN people p ON p.id = k.person_id
      WHERE k.id = ? AND p.active = 1`).bind(id).first<{ id: string; person_id: number; public_key: ArrayBuffer; counter: number; transports: string | null }>()
  if (!cred) return json(403, { ok: false, error: 'This passkey is not enrolled here, or its owner has been removed.' })
  const r = rp(env)
  let v
  try {
    v = await verifyAuthenticationResponse({
      response: body.response as never, expectedChallenge: ch.challenge, expectedOrigin: r.origin, expectedRPID: r.id, requireUserVerification: true,
      credential: { id: cred.id, publicKey: new Uint8Array(cred.public_key), counter: cred.counter, transports: cred.transports ? JSON.parse(cred.transports) : undefined },
    })
  } catch { return json(400, { ok: false, error: 'Your device did not confirm the sign-in.' }) }
  if (!v.verified) return json(403, { ok: false, error: 'The passkey could not be verified.' })
  await env.DB.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').bind(v.authenticationInfo.newCounter, nowIso(), cred.id).run()
  return json(200, { ok: true, next: safeNext(body.next ?? null) }, await startStaffSession(env, cred.person_id), clearCookie(CHALLENGE_COOKIE))
}

// ── setup wizard: the first administrator, once ──────────────────────────────

// Setup works only on an empty cabinet. Once anyone exists, recovery is by an administrator, not the token.
const hasAdmin = async (env: Env) => !!(await env.DB.prepare('SELECT 1 FROM people').first())

/** What the College needs to check and copy, before and after the first administrator exists. */
async function checks(env: Env): Promise<string> {
  const pub = await publicJwk(env).catch(() => null)
  const r2 = await env.EVIDENCE.list({ limit: 1 }).then(() => true).catch(() => false)
  const db = await env.DB.prepare('SELECT 1').first().then(() => true).catch(() => false)
  const origin = (() => { try { const u = new URL(env.CABINET_ORIGIN); return u.protocol === 'https:' && u.pathname === '/' && !u.search } catch { return false } })()
  const row = (ok: boolean, label: string, fix: string) => `<tr><td>${ok ? '✓' : '✗'}</td><td>${esc(label)}</td><td class="muted">${ok ? '' : esc(fix)}</td></tr>`
  return `<div class="card"><h2>Checks</h2><table>
${row(db, 'Database (D1) reachable', 'Create it with --jurisdiction eu and set database_id in wrangler.toml.')}
${row(r2, 'Evidence bucket (R2) reachable', 'Create it with --jurisdiction eu.')}
${row(origin, `Cabinet address: ${env.CABINET_ORIGIN}`, 'Set CABINET_ORIGIN to https://… with no path.')}
${row(env.COLLEGE !== 'CHANGE-ME' && /^[A-Z0-9_-]{2,20}$/.test(env.COLLEGE), `College: ${env.COLLEGE}`, 'Set COLLEGE to your College code as My College knows it.')}
${row(!!pub, 'College signing key set', 'Run npm run keygen and put the private key in the COLLEGE_SIGNING_KEY secret.')}
</table>
<p class="muted">Confirm EU jurisdiction for both in the Cloudflare dashboard: the Worker cannot read it from its bindings.</p></div>
${pub ? `<div class="card"><h2>For My College</h2><p>Paste these into My College → College settings → Evidence handling, under <b>A secure evidence cabinet</b>.</p>
<label>Cabinet address</label><input type="text" readonly value="${esc(env.CABINET_ORIGIN)}">
<label>Cabinet public key</label><input type="text" readonly value="${esc(JSON.stringify(pub.jwk))}">
<p class="muted">Key ID ${esc(pub.kid)}. This is the public half only.</p></div>` : ''}`
}

export async function setupPage(req: Request, env: Env, message = ''): Promise<Response> {
  if (await hasAdmin(env)) {
    const me = await staff(req, env)
    if (!me?.is_admin) return page(env, 'Set up', notice('This cabinet is set up. Sign in to manage it.'), 200, { nav: '<a href="/signin">Sign in</a>' })
    return page(env, 'Set up', await checks(env), 200, { nav: '<a href="/cases">Cases</a> <a href="/admin">Administration</a>' })
  }
  return page(env, 'Set up this cabinet', `${message}${await checks(env)}
<form class="card" method="post" action="/setup">
  <h2>First administrator</h2>
  <p class="muted">You become the cabinet's first administrator and can then add the second, and the reviewers.</p>
  <label for="token">Setup token</label><input id="token" name="token" type="text" autocomplete="off" required>
  <label for="name">Your name</label><input id="name" name="name" type="text" required maxlength="120">
  <label for="sub">Your ID from My College (optional now)</label><input id="sub" name="sub" type="text" placeholder="p_…" maxlength="60">
  <p class="muted">My College lists it under College settings → Evidence handling → Reviewer IDs.</p>
  <p><button type="submit">Continue to create your passkey</button></p>
</form>`)
}

export async function setupPost(req: Request, env: Env): Promise<Response> {
  if (await hasAdmin(env)) return setupPage(req, env)
  const f = await req.formData()
  const token = String(f.get('token') ?? '')
  const name = String(f.get('name') ?? '').trim().slice(0, 120)
  const sub = String(f.get('sub') ?? '').trim() || null
  if (!env.SETUP_TOKEN || env.SETUP_TOKEN.length < 20) return setupPage(req, env, notice('Set the SETUP_TOKEN secret (at least 20 characters) first.', 'bad'))
  const a = new TextEncoder().encode(await sha256(token)), b = new TextEncoder().encode(await sha256(env.SETUP_TOKEN))
  if (!crypto.subtle.timingSafeEqual(a, b)) return setupPage(req, env, notice('That setup token is not right.', 'bad'))
  if (!name) return setupPage(req, env, notice('Enter your name.', 'bad'))
  if (sub && !/^p_[A-Za-z0-9_-]{16,40}$/.test(sub)) return setupPage(req, env, notice('That does not look like a My College ID (p_…).', 'bad'))
  const p = await env.DB.prepare('INSERT INTO people (sub, display_name, is_admin, can_finalise, can_retain, created_at) VALUES (?, ?, 1, 0, 1, ?) RETURNING id').bind(sub, name, nowIso()).first<{ id: number }>()
  const link = await createEnrolment(env, p!.id, null)
  return new Response(null, { status: 303, headers: { Location: new URL(link).pathname + new URL(link).hash, ...NO_STORE } })
}

