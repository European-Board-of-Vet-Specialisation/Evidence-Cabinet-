// The cabinet Worker. Routes:
//
//   POST /launch, GET /launch/continue   passes from My College (routes/launch)
//   POST /api/signals, POST /api/pair    My College → cabinet (routes/signals, routes/pair)
//   GET|POST /upload                     the candidate's page (routes/upload)
//   scheduled                            the daily job (retention) and event retries

import type { Env } from './env'
import { launch, launchContinue } from './routes/launch'
import { signals } from './routes/signals'
import { pair } from './routes/pair'
import { uploadPage, uploadPost } from './routes/upload'
import { runDaily } from './retention'
import { deliverDue } from './outbox'
import { page, notice } from './ui/layout'

// A form post from another site may only reach /launch, and only with a pass. Everything else
// that changes state must come from this origin.
function sameOrigin(req: Request, env: Env): boolean {
  const o = req.headers.get('origin')
  return !o || o === env.CABINET_ORIGIN
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url)
    const { pathname: path } = url
    const m = req.method
    try {
      if (m === 'POST' && path === '/launch') return await launch(req, env)
      if (m === 'GET' && path === '/launch/continue') return await launchContinue(req, env)
      if (m === 'POST' && path === '/api/signals') return await signals(req, env, ctx)
      if (m === 'POST' && path === '/api/pair') return await pair(req, env)
      if (m === 'POST' && !sameOrigin(req, env)) return page(env, 'Refused', notice('That request came from another site.', 'bad'), 403)
      if (m === 'GET' && path === '/upload') return await uploadPage(req, env)
      if (m === 'POST' && path === '/upload') return await uploadPost(req, env, ctx)
      if (m === 'GET' && path === '/') return page(env, 'Evidence cabinet', notice(`Open a claim from My College to use the ${env.COLLEGE} evidence cabinet.`))
      return page(env, 'Not found', notice('There is nothing here.'), 404)
    } catch (e) {
      // Never the request, the body or a token: a short code only.
      console.error('[cabinet] error', path, e instanceof Error ? e.name : 'unknown')
      return page(env, 'Something went wrong', notice('Try again. If it keeps happening, tell your College administrator.', 'bad'), 500)
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDaily(env).then(t => console.log('[cabinet] daily', JSON.stringify(t))).catch(e => console.error('[cabinet] daily failed', e instanceof Error ? e.name : 'unknown')))
  },
} satisfies ExportedHandler<Env>

export { deliverDue }
