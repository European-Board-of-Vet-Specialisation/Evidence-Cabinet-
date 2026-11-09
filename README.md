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
npm run typecheck
```

## Set up for a College

1. Create the College's Cloudflare account and a Git organisation. Name a second administrator.
2. `npx wrangler d1 create cabinet --jurisdiction eu` and paste the ID into `wrangler.toml`.
3. `npx wrangler r2 bucket create cabinet-evidence --jurisdiction eu`
4. The lifecycle backstop (spec RET-02): delete objects under `cases/` 548 days after upload.
   `npx wrangler r2 bucket lifecycle add cabinet-evidence backstop cases/ --expire-days 548 --jurisdiction eu`
5. Set `COLLEGE`, `CABINET_ORIGIN` and `PRIVACY_NOTICE_URL` in `wrangler.toml`.
6. `npm run keygen`, then `npx wrangler secret put COLLEGE_SIGNING_KEY` with the private key.
7. `npx wrangler secret put SETUP_TOKEN` with a long random string.
8. `npm run migrate && npm run deploy`
9. Open `/setup` on the cabinet, enter the setup token and create the first administrator's passkey.
   Then delete the secret: `npx wrangler secret delete SETUP_TOKEN`. Setup only ever works on an
   empty cabinet.
10. In My College → College settings → Evidence handling: choose *A secure evidence cabinet*,
    enter the cabinet's address and the **public** key, run the signed test and switch it on.
11. In the cabinet, add a second administrator.

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

