// One plain page frame. No external scripts, fonts or images: the Content-Security-Policy
// allows only this origin, so nothing on a page can call out with what it shows.

import type { Env } from '../env'
import { esc, NO_STORE } from '../util'

const CSS = `
:root{--ink:#1b2a3a;--muted:#5a6a7e;--line:#dfe6ef;--bg:#f6f8fb;--accent:#1b3a6b;--warn:#a65a00;--bad:#a52a2a;--good:#1b6e3a}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:var(--bg)}
header{background:#fff;border-bottom:1px solid var(--line);padding:12px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header b{color:var(--accent)}header nav{margin-left:auto;display:flex;gap:14px;flex-wrap:wrap}
a{color:var(--accent)}main{max-width:960px;margin:0 auto;padding:24px 16px 60px}
h1{font-size:22px;margin:0 0 12px}h2{font-size:17px;margin:22px 0 8px}
.card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:16px;margin:0 0 14px}
.muted{color:var(--muted);font-size:13.5px}.notice{background:#fff;border-left:4px solid var(--accent);padding:12px 14px;border-radius:6px}
.warn{border-left-color:var(--warn)}.bad{border-left-color:var(--bad)}.good{border-left-color:var(--good)}
label{display:block;font-weight:600;margin:12px 0 4px}input[type=text],input[type=number],input[type=date],select,textarea{width:100%;padding:8px 10px;border:1px solid #c5d0de;border-radius:6px;font:inherit}
textarea{min-height:120px}button,.btn{display:inline-block;background:var(--accent);color:#fff;border:0;border-radius:6px;padding:8px 16px;font:600 14px/1.4 inherit;cursor:pointer;text-decoration:none}
button.secondary,.btn.secondary{background:#fff;color:var(--accent);border:1px solid #c5d0de}button.danger{background:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:8px 6px;border-top:1px solid var(--line);vertical-align:top}
.tag{font-size:12px;padding:2px 9px;border-radius:999px;background:#e8eef7;color:var(--accent);white-space:nowrap}
.unread{background:#fff4e0;color:var(--warn)}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
@media (max-width:600px){header nav{margin-left:0}}
`

export function page(env: Env, title: string, body: string, status = 200, opts: { nav?: string; script?: string } = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)} · ${esc(env.COLLEGE)} evidence cabinet</title><style>${CSS}</style></head>
<body><header><b>${esc(env.COLLEGE)} evidence cabinet</b>${opts.nav ? `<nav>${opts.nav}</nav>` : ''}</header>
<main><h1>${esc(title)}</h1>${body}</main>
<footer style="max-width:960px;margin:0 auto;padding:0 16px 24px" class="muted"><a href="${esc(env.SOURCE_URL || SOURCE_DEFAULT)}" rel="noopener noreferrer">Source code</a> · AGPL-3.0</footer>${opts.script ? `<script src="${esc(opts.script)}"></script>` : ''}</body></html>`
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE, ...SECURITY_HEADERS } })
}

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob: data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000',
}

/** The published source. A College running a modified version sets SOURCE_URL to its own. */
const SOURCE_DEFAULT = 'https://github.com/European-Board-of-Vet-Specialisation/Evidence-Cabinet-'

export const notice = (text: string, kind: '' | 'warn' | 'bad' | 'good' = '') => `<p class="notice ${kind}">${esc(text)}</p>`
