// Small helpers with no knowledge of cases.

export const nowIso = (d: Date = new Date()) => d.toISOString()
export const nowSec = () => Math.floor(Date.now() / 1000)

export function addDays(d: Date, days: number): Date {
  const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + days); return x
}
export function addMonths(d: Date, months: number): Date {
  const x = new Date(d.getTime()); x.setUTCMonth(x.getUTCMonth() + months); return x
}

const B64URL = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const randomId = (bytes = 24) => B64URL(crypto.getRandomValues(new Uint8Array(bytes)))

export async function sha256(s: string): Promise<string> {
  return B64URL(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))
}

/** Case references are My College's: `ec-` + 26 characters of its alphabet. */
export const isCaseRef = (v: unknown): v is string => typeof v === 'string' && /^ec-[a-km-np-z2-9]{26}$/.test(v)
/** A per-College person ID from My College. */
export const isSub = (v: unknown): v is string => typeof v === 'string' && /^p_[A-Za-z0-9_-]{16,40}$/.test(v)

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

// Cookies are __Host- prefixed and Secure: bound to this origin, https only. A local test run on
// http://localhost cannot set those, so there — and only there — the prefix and Secure are
// dropped. Set per request from CABINET_ORIGIN (index.ts); any deployment is https.
let localHttp = false
export const setLocalHttp = (origin: string) => { localHttp = /^http:\/\/localhost(:\d+)?$/.test(origin) }
const named = (name: string) => localHttp ? name.replace(/^__Host-/, '') : name
const secure = () => localHttp ? '' : ' Secure;'

export function cookie(req: Request, name: string): string | null {
  const n = named(name)
  const m = (req.headers.get('cookie') ?? '').split(/;\s*/).find(p => p.startsWith(`${n}=`))
  return m ? decodeURIComponent(m.slice(n.length + 1)) : null
}
export const setCookie = (name: string, value: string, maxAgeSec: number) =>
  `${named(name)}=${encodeURIComponent(value)}; Path=/;${secure()} HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`
export const clearCookie = (name: string) => `${named(name)}=; Path=/;${secure()} HttpOnly; SameSite=Lax; Max-Age=0`

/** Every response is private and uncached; evidence most of all. */
export const NO_STORE = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }
