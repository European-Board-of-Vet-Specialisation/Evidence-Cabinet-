# Evidence cabinet

A College-owned store for extenuating-circumstances evidence, connected to My College. The
candidate's account and documents, the committee's discussion and its reasoning stay in the
College's own Cloudflare account. EBVS supplies this software and holds no key that can read
anything in it. My College keeps only the claim, its outcome and the adjustments granted.

- What it must do: [`docs/spec.md`](docs/spec.md) (functional specification v0.4)
- How it talks to My College: [`docs/interface.md`](docs/interface.md)

## Status

Built and tested:

- **Trust with My College.** Launch passes, signals and pairing tests are verified against My
  College's published keys: EdDSA only, issuer, audience, College, type and time. Events are
  signed with the College's key; a retry is re-signed with the same event ID.
- **Launch.** Upload passes admit a candidate to one case for an hour. Review and inbox passes
  name a reviewer but never admit them: they must also be signed in here as that person and,
  for a case, hold a live assignment. Nonces are redeemed once.
- **Upload.** PDF, PNG and JPEG only, judged by their bytes; 20 MB each, 10 at a time; each
  submission a new version; nothing recorded until every file is stored; the receipt queued in
  the same batch.
- **Signals.** `case.closed` and `appeal.release` delete both prefixes, confirm they are empty,
  delete the sensitive records and queue `evidence.deleted`. `appeal.hold` moves the case to
  `hold/`. Idempotent by event ID.
- **Pairing.** The signed two-way test.
- **Event outbox.** Saved with what it reports; retried 1, 5, 15, 60, 240, 720 minutes, then
  daily; refusals stop and show why.
- **Daily job.** The 18-month rule with its reminder, retention flags and their lapse, the
  six-monthly summary, housekeeping.
- **Sign-in.** Passkeys only, enrolled with a one-time link from an administrator; the first
  administrator through the setup wizard and the SETUP_TOKEN secret. No passwords, no email.
- **Setup wizard** (`/setup`). Checks the bindings, the address, the College code and the
  signing key, and shows the values to paste into My College.
- **Cases.** A reviewer's assigned cases, unread activity first; one case with its evidence and
  discussion together. Comments record author and time; corrections keep the original. A comment
  asks My College to email the other assigned reviewers, naming no one and no case.
- **Viewer.** PDF.js in the browser, no download or print control, the reviewer's name and the
  time over every page; bytes only to the viewer, from an allowed country, every view logged.
- **Decisions.** Any assigned reviewer drafts; the people the College designates finalise after
  seeing exactly what My College will receive. The rationale stays here. Corrections and appeal
  outcomes are new versions linked to the one before. My College's acknowledgement is shown, and
  an administrator re-sends without the chair re-entering anything.
- **Administration.** People and enrolment links, assignments and revocation, retention flags,
  events My College has not accepted, six-monthly summaries. Removing a person ends their
  sessions, assignments and passkeys at once; the last administrator cannot be removed.

Next: an end-to-end run against My College in test mode, then a pilot deployment.

## Develop

There is no global install: everything runs through npm.

```sh
npm install
npm test           # runs inside the Workers runtime with a local D1 and R2
npm run dev        # the cabinet on http://localhost:8787 (put SETUP_TOKEN in .dev.vars)
npm run typecheck
```

## Set up for a College

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/European-Board-of-Vet-Specialisation/Evidence-Cabinet-)

Do this signed in to the **College's own** Cloudflare account and the College's own GitHub or
GitLab account. EBVS needs no access to either.

1. **Press the button.** Cloudflare copies this code into a new repository in the College's
   GitHub or GitLab, and creates the database and the evidence bucket.
   - Name the Worker, for example `ecvsmr-evidence-cabinet`.
   - **SETUP_TOKEN:** make up a long random string (20+ characters) and keep it for step 5.
   - Accept the build and deploy commands it suggests (`npm run build`, `npm run deploy`).
2. **Check both stores are in the EU** (Storage & Databases): the D1 database and the R2 bucket
   must show *EU* jurisdiction. If either does not, nothing is in it yet: create an EU one in the
   dashboard, put its name (and, for D1, its ID) into `wrangler.toml` in the College's
   repository, and delete the other.
3. **Edit `wrangler.toml`** in the College's repository (the GitHub or GitLab web editor is
   fine) and set `COLLEGE` (e.g. `ECVSMR`), `CABINET_ORIGIN` (the address Cloudflare gave the
   Worker, e.g. `https://ecvsmr-evidence-cabinet.<you>.workers.dev`, no trailing slash) and
   `PRIVACY_NOTICE_URL`. Saving redeploys it.
4. **The 18-month backstop** (spec RET-02): R2 → the bucket → Settings → Object lifecycle rules →
   add a rule for prefix `cases/` that deletes objects 548 days after upload.
5. **Open `/setup` on the cabinet.**
   - Make the **College signing key** there, in your browser, and add it as the secret
     `COLLEGE_SIGNING_KEY` (Workers & Pages → the cabinet → Settings → Variables and Secrets).
     Reload `/setup`.
   - Enter the setup token and create the first administrator's **passkey**.
   - Then delete the `SETUP_TOKEN` secret. Setup only ever works on an empty cabinet.
6. **Pair with My College:** College settings → Evidence handling → *A secure evidence cabinet*.
   Paste the cabinet address and the public key from `/setup`, run the signed test, switch on.
7. **Add a second administrator** in the cabinet's Administration page.

Every check on `/setup` should then be green, apart from anything you have chosen to leave.

### By hand, with Wrangler

`npx wrangler d1 create cabinet --jurisdiction eu` (ID into `wrangler.toml`),
`npx wrangler r2 bucket create cabinet-evidence --jurisdiction eu`, the lifecycle rule
(`npx wrangler r2 bucket lifecycle add cabinet-evidence backstop cases/ --expire-days 548 --jurisdiction eu`),
`npx wrangler secret put SETUP_TOKEN`, then `npm run deploy`, and steps 3, 5–7 above.
`npm run keygen` makes the signing key on a computer instead of in the browser.

## Rotating the College's signing key

1. `npm run keygen` for a new pair.
2. In My College, paste the new **public** key as the *next* key. My College now trusts both.
3. `npx wrangler secret put COLLEGE_SIGNING_KEY` with the new private key. Events are signed
   with it from now on.
4. In My College, make the new key the current one and remove the old one.

## Licence

GNU Affero General Public License v3.0 only (`LICENSE`). Colleges may use, study, change and run
it. If a College runs a modified version, the people who use it are entitled to its source:
every page links to it, from `SOURCE_URL` in `wrangler.toml`. Security reports: `SECURITY.md`.

