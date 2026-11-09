// What the Worker is given. Vars are in wrangler.toml; the two secrets are set with
// `wrangler secret put` and never leave the College's account.

export interface Env {
  DB: D1Database
  EVIDENCE: R2Bucket
  COLLEGE: string
  CABINET_ORIGIN: string
  MC_BASE: string
  MC_ISSUER: string
  PRIVACY_NOTICE_URL: string
  VIEW_COUNTRIES: string
  /** Where this deployment's source can be had (AGPL §13). Change it if you run a modified version. */
  SOURCE_URL?: string
  /** The College's event-signing PRIVATE key, an Ed25519 JWK. */
  COLLEGE_SIGNING_KEY: string
  /** Enrols the first administrator, once. */
  SETUP_TOKEN?: string
}
