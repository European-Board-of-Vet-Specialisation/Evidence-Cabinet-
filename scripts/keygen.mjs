// Make the College's event-signing key. Run on your own machine:
//   npm run keygen
// Put the PRIVATE key in the Worker as a secret (it never goes anywhere else):
//   npx wrangler secret put COLLEGE_SIGNING_KEY      ← paste the first line
// Paste the PUBLIC key into My College → College settings → Evidence handling.
import { generateKeyPairSync } from 'node:crypto'
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const priv = privateKey.export({ format: 'jwk' })
const pub = publicKey.export({ format: 'jwk' })
console.log('PRIVATE (secret COLLEGE_SIGNING_KEY — keep it, share it with no one):')
console.log(JSON.stringify(priv))
console.log('\nPUBLIC (paste into My College):')
console.log(JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x }))
