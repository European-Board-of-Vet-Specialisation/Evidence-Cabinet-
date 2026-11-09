// The cabinet Worker.
//
//   My College → cabinet   POST /launch, GET /launch/continue, POST /api/signals, POST /api/pair
//   candidate              GET|POST /upload
//   College users          /signin, /enrol (#token), /cases, /case/:ref (+ comments, viewer,
//                          decision, retention), /admin…, /setup
//   scheduled              the daily job (retention, reminders, summary) and event retries

import type { Env } from './env'
import { launch, launchContinue } from './routes/launch'
import { signals } from './routes/signals'
import { pair } from './routes/pair'
import { uploadPage, uploadPost } from './routes/upload'
import { enrolPage, signinPage, signout, registerOptions, registerVerify, authOptions, authVerify, setupPage, setupPost } from './routes/auth'
import { caseList, caseView, postComment, correctComment } from './routes/cases'
import { viewerPage, viewerRaw } from './routes/viewer'
import { decisionPage, saveDraft, finalise, retryDecision } from './routes/decision'
import { adminHome, addPerson, personPage, personPost, adminCase, assignPost, retainPost, retryEventPost, disposePost } from './routes/admin'
import { runDaily } from './retention'
import { page, notice, SECURITY_HEADERS } from './ui/layout'
import { PASSKEY_JS } from './static/passkey'
import { VIEWER_JS } from './static/viewer'
import { KEYGEN_JS } from './static/keygen'
import { setLocalHttp } from './util'

// A form post from another site may reach /launch only, and only with a pass. Everything else
// that changes state must come from this origin. Browsers say so by Origin, or — where a page's
// referrer policy makes them send "Origin: null" — by Sec-Fetch-Site. A request with neither is
// not from a browser, so carries no ambient cookies to abuse.
function sameOrigin(req: Request, env: Env): boolean {
  const o = req.headers.get('origin'), site = req.headers.get('sec-fetch-site')
  if (o && o !== 'null') return o === env.CABINET_ORIGIN
  return !site || site === 'same-origin' || site === 'none'
}
const js = (src: string) => new Response(src, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600', ...SECURITY_HEADERS } })
const REF = '(ec-[a-z0-9]{26})'

type Handler = (req: Request, env: Env, ctx: ExecutionContext, m: RegExpMatchArray) => Promise<Response> | Response
const routes: Array<[string, RegExp, Handler]> = [
  ['POST', /^\/launch$/, (r, e) => launch(r, e)],
  ['GET', /^\/launch\/continue$/, (r, e) => launchContinue(r, e)],
  ['POST', /^\/api\/signals$/, (r, e, c) => signals(r, e, c)],
  ['POST', /^\/api\/pair$/, (r, e) => pair(r, e)],
  ['GET', /^\/static\/passkey\.js$/, () => js(PASSKEY_JS)],
  ['GET', /^\/static\/viewer\.js$/, () => js(VIEWER_JS)],
  ['GET', /^\/static\/keygen\.js$/, () => js(KEYGEN_JS)],
  ['GET', /^\/upload$/, (r, e) => uploadPage(r, e)],
  ['POST', /^\/upload$/, (r, e, c) => uploadPost(r, e, c)],
  ['GET', /^\/setup$/, (r, e) => setupPage(r, e)],
  ['POST', /^\/setup$/, (r, e) => setupPost(r, e)],
  ['GET', /^\/signin$/, (r, e) => signinPage(r, e)],
  ['POST', /^\/signout$/, (r, e) => signout(r, e)],
  ['GET', /^\/enrol$/, (_r, e) => enrolPage(e)],
  ['POST', /^\/api\/passkey\/register\/options$/, (r, e) => registerOptions(r, e)],
  ['POST', /^\/api\/passkey\/register\/verify$/, (r, e) => registerVerify(r, e)],
  ['POST', /^\/api\/passkey\/auth\/options$/, (_r, e) => authOptions(e)],
  ['POST', /^\/api\/passkey\/auth\/verify$/, (r, e) => authVerify(r, e)],
  ['GET', /^\/cases$/, (r, e) => caseList(r, e)],
  ['GET', new RegExp(`^/case/${REF}$`), (r, e, _c, m) => caseView(r, e, m[1]!)],
  ['POST', new RegExp(`^/case/${REF}/comment$`), (r, e, c, m) => postComment(r, e, c, m[1]!)],
  ['POST', new RegExp(`^/case/${REF}/comment/(\\d+)/correct$`), (r, e, c, m) => correctComment(r, e, c, m[1]!, Number(m[2]))],
  ['GET', new RegExp(`^/case/${REF}/file/([0-9a-f-]{36})$`), (r, e, _c, m) => viewerPage(r, e, m[1]!, m[2]!)],
  ['GET', new RegExp(`^/case/${REF}/file/([0-9a-f-]{36})/raw$`), (r, e, _c, m) => viewerRaw(r, e, m[1]!, m[2]!)],
  ['GET', new RegExp(`^/case/${REF}/decision$`), (r, e, _c, m) => decisionPage(r, e, m[1]!)],
  ['POST', new RegExp(`^/case/${REF}/decision/draft$`), (r, e, _c, m) => saveDraft(r, e, m[1]!)],
  ['POST', new RegExp(`^/case/${REF}/decision/finalise$`), (r, e, c, m) => finalise(r, e, c, m[1]!)],
  ['POST', new RegExp(`^/case/${REF}/decision/(\\d+)/retry$`), (r, e, c, m) => retryDecision(r, e, c, m[1]!, Number(m[2]))],
  ['POST', new RegExp(`^/case/${REF}/retain$`), (r, e, _c, m) => retainPost(r, e, m[1]!)],
  ['GET', /^\/admin$/, (r, e) => adminHome(r, e)],
  ['POST', /^\/admin\/person$/, (r, e) => addPerson(r, e)],
  ['GET', /^\/admin\/person\/(\d+)$/, (r, e, _c, m) => personPage(r, e, Number(m[1]))],
  ['POST', /^\/admin\/person\/(\d+)$/, (r, e, _c, m) => personPost(r, e, Number(m[1]))],
  ['GET', new RegExp(`^/admin/case/${REF}$`), (r, e, _c, m) => adminCase(r, e, m[1]!)],
  ['POST', new RegExp(`^/admin/case/${REF}/assign$`), (r, e, _c, m) => assignPost(r, e, m[1]!)],
  ['POST', new RegExp(`^/admin/case/${REF}/dispose$`), (r, e, c, m) => disposePost(r, e, c, m[1]!)],
  ['POST', /^\/admin\/event\/(\d+)\/retry$/, (r, e, c, m) => retryEventPost(r, e, c, Number(m[1]))],
  ['GET', /^\/$/, (r) => new Response(null, { status: 303, headers: { Location: '/cases' } })],
]

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(req.url).pathname
    setLocalHttp(env.CABINET_ORIGIN)
    try {
      const exempt = path === '/launch' || path.startsWith('/api/signals') || path === '/api/pair'
      if (req.method === 'POST' && !exempt && !sameOrigin(req, env)) return page(env, 'Refused', notice('That request came from another site.', 'bad'), 403)
      for (const [method, re, h] of routes) {
        if (method !== req.method) continue
        const m = path.match(re)
        if (m) return await h(req, env, ctx, m)
      }
      return page(env, 'Not found', notice('There is nothing here.'), 404)
    } catch (e) {
      // Never the request, the body or a token: a short code only.
      console.error('[cabinet] error', path.replace(/ec-[a-z0-9]{26}/g, 'ec-…'), e instanceof Error ? e.name : 'unknown')
      return page(env, 'Something went wrong', notice('Try again. If it keeps happening, tell your College administrator.', 'bad'), 500)
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDaily(env).then(t => console.log('[cabinet] daily', JSON.stringify(t))).catch(e => console.error('[cabinet] daily failed', e instanceof Error ? e.name : 'unknown')))
  },
} satisfies ExportedHandler<Env>
