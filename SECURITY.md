# Security

The evidence cabinet holds health data about candidates. Please report anything that could
expose evidence, discussion or reasoning, admit someone who should not be admitted, or stop
evidence being deleted when it should be.

## Reporting a problem

Email **it-support@ebvs.eu** with "Evidence cabinet security" in the subject. Do not open a
public issue. Include what you found, how to reproduce it, and the version (the commit or
release tag) you looked at. We acknowledge reports within five working days.

Please test only against your own deployment, with made-up data. Never test against a College's
live cabinet or use real evidence.

## What the design relies on

- **My College's signatures.** Launch passes, signals and pairing tests are verified against
  My College's published keys (`/api/ec/keys`): EdDSA only, with issuer, audience (this
  cabinet), College, type and time checked. A pass names a person; it never admits a reviewer
  on its own.
- **The College's own sign-in.** Reviewers and administrators use passkeys enrolled through
  one-time links that an administrator issues. EBVS has no route to enrol anyone.
- **Re-checking on every request.** Assignment, removal and revocation take effect on the next
  request, including within an open session.
- **Keys and data in the College's account.** Nothing secret is in this repository: the
  College's signing key, the setup token, the database and the evidence all live in the
  College's Cloudflare account.

## Updates

Each release is tagged. A College approves a release before deploying it; EBVS never deploys
into a College's account.
