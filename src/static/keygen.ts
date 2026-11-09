// The College signing key, made in the administrator's own browser (served at /static/keygen.js).
// The private half is shown once, to paste into the Worker's secrets in the College's own
// Cloudflare dashboard. It is never sent to the cabinet, to EBVS or anywhere else.

export const KEYGEN_JS = String.raw`(() => {
  const btn = document.getElementById('keygen'), out = document.getElementById('keyout'), status = document.getElementById('keystatus')
  if (!btn) return
  btn.addEventListener('click', async () => {
    try {
      const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
      const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
      const priv = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d })
      document.getElementById('privkey').value = priv
      out.hidden = false; btn.disabled = true
      status.textContent = ''
    } catch (e) {
      status.textContent = 'This browser cannot make the key. Use a current Chrome, Edge, Firefox or Safari, or run "npm run keygen" on a computer with Node.js.'
    }
  })
  const copy = document.getElementById('copykey')
  if (copy) copy.addEventListener('click', () => { const t = document.getElementById('privkey'); t.select(); navigator.clipboard && navigator.clipboard.writeText(t.value); copy.textContent = 'Copied' })
})()`
