// The browser half of passkeys, served at /static/passkey.js. Plain script, no libraries:
// the page's Content-Security-Policy allows scripts from this origin only.

export const PASSKEY_JS = String.raw`(() => {
  const b64u = {
    dec: s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)).buffer,
    enc: b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  }
  const status = t => { const el = document.getElementById('status'); if (el) el.textContent = t }
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })
    const j = await r.json().catch(() => ({ ok: false, error: 'No answer from the cabinet.' }))
    if (!j.ok) throw new Error(j.error || 'Something went wrong.')
    return j
  }
  const credJSON = c => {
    const r = c.response, out = { id: c.id, rawId: b64u.enc(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment, response: { clientDataJSON: b64u.enc(r.clientDataJSON) } }
    if (r.attestationObject) { out.response.attestationObject = b64u.enc(r.attestationObject); out.response.transports = r.getTransports ? r.getTransports() : [] }
    if (r.authenticatorData) { out.response.authenticatorData = b64u.enc(r.authenticatorData); out.response.signature = b64u.enc(r.signature); out.response.userHandle = r.userHandle ? b64u.enc(r.userHandle) : undefined }
    return out
  }
  const reg = document.getElementById('register')
  if (reg && !location.hash.slice(1)) { reg.disabled = true; status('This page needs the full link your administrator gave you.') }
  if (reg) reg.addEventListener('click', async () => {
    reg.disabled = true; status('Follow your device’s prompt…')
    try {
      const token = location.hash.slice(1)
      const { options: o } = await post('/api/passkey/register/options', { token })
      const cred = await navigator.credentials.create({ publicKey: { ...o, challenge: b64u.dec(o.challenge), user: { ...o.user, id: b64u.dec(o.user.id) },
        excludeCredentials: (o.excludeCredentials || []).map(c => ({ ...c, id: b64u.dec(c.id) })) } })
      const j = await post('/api/passkey/register/verify', { token, response: credJSON(cred) })
      status('Done. Opening the cabinet…'); location.assign(j.next)
    } catch (e) { status(e.message || 'The passkey was not created.'); reg.disabled = false }
  })
  const sig = document.getElementById('signin')
  if (sig) sig.addEventListener('click', async () => {
    sig.disabled = true; status('Follow your device’s prompt…')
    try {
      const { options: o } = await post('/api/passkey/auth/options', {})
      const cred = await navigator.credentials.get({ publicKey: { ...o, challenge: b64u.dec(o.challenge), allowCredentials: (o.allowCredentials || []).map(c => ({ ...c, id: b64u.dec(c.id) })) } })
      const j = await post('/api/passkey/auth/verify', { response: credJSON(cred), next: sig.dataset.next })
      location.assign(j.next)
    } catch (e) { status(e.message || 'Sign-in did not complete.'); sig.disabled = false }
  })
})()`
