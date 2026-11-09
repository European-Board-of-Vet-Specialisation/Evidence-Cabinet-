# Evidence cabinet interface

How a College's evidence cabinet connects to My College. This is the contract in section 7 of
*College evidence cabinet: functional specification v0.4* (`docs/ec-cabinet-spec.md`, 9 November
2026). Any system that implements it can connect: the EBVS Cloudflare template, or a College's own.
It applies to a College that chose *A secure evidence cabinet* under College settings → Evidence
handling; a College using its own process has no cabinet and nothing here applies.

My College's side is in `lib/ec/` and is the reference for every rule below.

## What My College holds

It holds the claim, its status, the outcome and the adjustments, and nothing else. It holds no
reason, no category of circumstance and no description of the relief sought. Adjustments are
fixed types with typed parameters (`lib/ec/model.ts`):

| Type | Parameters | Applies to |
|---|---|---|
| `extension` | `months` (1–36) or `until` (YYYY-MM-DD) | all; recertification takes months only |
| `deferral` | `cycle_id`: the diet deferred to | examination |
| `extra_time` | `minutes` (1–600, per paper) or `percent` (1–200) | examination |
| `separate_room` | `required: true` | examination |
| `rest_breaks` | `count` (1–20), `minutes` (1–120) | examination |
| `reduced_target` | `months` lost (1–60): the points target is pro-rated | recertification |
| `other` | `code` from the College's list | all |

`reduced_target` is an addition to the v0.3 table, for the recertification accommodation that
already existed. An extension and a reduced target are never granted together.

## Messages

Every message is a **compact JWS** signed with **EdDSA (Ed25519)**:

- `kid` is the RFC 7638 SHA-256 thumbprint of the signing public key.
- `typ` names the kind of message. A verifier must check it, so one kind can never be replayed as another.

| `typ` | Direction | Purpose |
|---|---|---|
| `ec-launch+jwt` | My College → browser → cabinet | Open the upload page, one case, or the reviewer's case list |
| `ec-signal+jwt` | My College → cabinet | `case.closed`, `appeal.hold`, `appeal.release` |
| `ec-pair+jwt` | My College → cabinet | Pairing test |
| `ec-event+jwt` | cabinet → My College | `evidence.received`, `evidence.deleted`, `reviewer.notification_requested`, `claim.decision_finalised`, `pairing.ack` |

Verifiers accept `alg: EdDSA` only, whatever the header says. Clock skew of up to 60 seconds is
tolerated.

### Keys

- **My College's public keys:** `GET https://help.ebvs.eu/api/ec/keys` returns a JWKS of the current key and, during a rotation, the next one. Cabinets may cache it for an hour.
- **The College's event-signing key** is generated inside the cabinet and never leaves it. The College admin pastes the **public** JWK (`{"kty":"OKP","crv":"Ed25519","x":"…"}`) into My College → College settings → Evidence handling. A pasted private key is refused.
- **Rotation, both sides:** publish the next key alongside the current one, wait for the other side to trust it, switch, then remove the old key.

Identifiers:

- **Issuer:** `https://help.ebvs.eu/ec`. This is `iss` on everything My College signs, and `aud` on everything a cabinet signs.
- **Cabinet origin:** for example `https://evidence.college.org`, with no path. It is `aud` on everything My College signs and `iss` on everything the cabinet signs.
- **`college`:** the College code, for example `ECVN`, on every message. A cabinet serves exactly one College.

## Cabinet endpoints

### `POST {origin}/launch`

A form post from the person's browser, with one field: `pass`. The pass is never sent in a query
string. It contains:

```json
{ "iss": "https://help.ebvs.eu/ec", "aud": "https://evidence.college.org", "college": "ECVN",
  "sub": "p_…", "role": "candidate|reviewer", "case_ref": "ec-…", "act": "upload|review|inbox",
  "iat": 1762600000, "exp": 1762600120, "jti": "uuid" }
```

The cabinet must:

1. Verify the signature against My College's JWKS and check `typ` `ec-launch+jwt`.
2. Check `iss`, `aud`, `college`, and that `exp` is no later than `iat` + 120.
3. Redeem `jti` **once, atomically** (D1). A replay fails.
4. **upload:** show the College's privacy notice, then accept a statement and files for `case_ref`.
5. **review:** require the College's own reviewer sign-in. The signed-in reviewer must map to `sub` in the cabinet's reviewer list and hold a live assignment to `case_ref`. **A valid pass alone never opens evidence.**
6. **inbox:** the pass has no `case_ref`. After the same sign-in, show the reviewer their own assigned cases, unread activity first. This is where a neutral notification email leads.

`sub` is a per-College pseudonym: `p_` followed by a base64url HMAC. It is stable for one person
at one College, different at another College, and reveals no ID or email address. My College
lists each reviewer's ID under College settings → Evidence handling, so the College can enter it
against that person's own login. My College never adds, assigns or removes a reviewer.

### `POST {origin}/api/signals`

Body: the JWS (`Content-Type: application/jose`). Payload:

```json
{ "iss": "https://help.ebvs.eu/ec", "aud": "…origin…", "college": "ECVN",
  "event_id": "uuid", "type": "case.closed|appeal.hold|appeal.release",
  "case_ref": "ec-…", "at": "ISO time", "iat": 1762600000 }
```

The cabinet answers 2xx once it has applied the signal or already did; anything else is retried
with backoff (1, 5, 15, 60, 240 and 720 minutes, then daily, for about three weeks). Handling must be
idempotent by `event_id`.

- `case.closed`: delete `cases/{case_ref}/` and the case's sensitive D1 records (account, comments, drafts, rationale), confirm the prefix is empty, then send `evidence.deleted`. For a College that decides in its cabinet, My College sends it **only when the candidate withdraws**: the cabinet hears College appeals and disposes of cases itself under the College's retention policy (spec 6.2).
- `appeal.hold` (EBVS appeal): copy `cases/{case_ref}/` to `hold/{case_ref}/`, then delete the original. The 18-month rules do not touch `hold/`.
- `appeal.release`: delete both prefixes, then send `evidence.deleted`.

### `POST {origin}/api/pair`

The signed two-way test. Body: a JWS with `typ` `ec-pair+jwt` and payload `{ iss, aud, college,
type: "pairing.test", nonce, iat, exp }`. The cabinet verifies it against My College's JWKS and
answers 200 with a body that is a JWS (`typ` `ec-event+jwt`) signed with the College's key:

```json
{ "iss": "…origin…", "aud": "https://help.ebvs.eu/ec", "college": "ECVN",
  "type": "pairing.ack", "nonce": "…the same nonce…", "iat": 1762600001 }
```

My College switches the cabinet on only after this passes. Changing the address or a key switches
it off until the test passes again.

## My College endpoint

### `POST https://help.ebvs.eu/api/ec/events/{COLLEGE}`

Body: a JWS with `typ` `ec-event+jwt`, signed with the College's current or next key, at most 16 KB.
Payload:

```json
{ "iss": "…origin…", "aud": "https://help.ebvs.eu/ec", "college": "ECVN",
  "event_id": "uuid", "type": "evidence.received|evidence.deleted",
  "case_ref": "ec-…", "version": 2, "status": "received|deleted", "at": "ISO time", "iat": 1762600000 }
```

The same endpoint takes `reviewer.notification_requested` and `claim.decision_finalised`, below.

- Send `evidence.received` after durable storage, once per version, with `version` 1, 2, …
- Send `evidence.deleted` after both prefixes are confirmed empty, whatever caused the disposal.
- Retries reuse `event_id`. **Re-sign each retry with a fresh `iat`**: My College accepts an `iat` up to seven days old, so a retry carrying the original time would be refused after a long outage.
- Save the record (comment, decision) and its pending event in the same transaction, and retry until acknowledged.

### `reviewer.notification_requested`

Asks My College to email people that something is waiting. The cabinet names them by their `sub`
and says what kind of notice it is; nothing else.

```json
{ "iss": "…origin…", "aud": "https://help.ebvs.eu/ec", "college": "ECVN",
  "event_id": "uuid", "type": "reviewer.notification_requested",
  "kind": "comment|retention_review|deletion_due|summary",
  "recipients": ["p_…", "p_…"], "iat": 1762600000 }
```

- At most 50 recipients. A `case_ref`, `text`, `comment`, `name` or `subject` field is refused (400).
- For `comment`, name the other currently assigned reviewers and exclude the author.
- My College sends only to people who are currently on a committee holding the Extenuating circumstances area, or, for the other kinds, College administrators. Others are skipped.
- One email per event and recipient, ever. Answer: `200 { result: "accepted", accepted: n, skipped: m }`, meaning My College has taken responsibility for sending.

The email: "You have an unread committee comment. Sign in to My College to review it." (or the
equivalent for the kind), with a link to the signed-in claims page. No name, case or text.

### `claim.decision_finalised`

The administrative outcome of a decision finalised in the cabinet. Never the rationale.

```json
{ "iss": "…origin…", "aud": "https://help.ebvs.eu/ec", "college": "ECVN",
  "event_id": "uuid", "type": "claim.decision_finalised",
  "case_ref": "ec-…", "version": 2, "decision_type": "initial|correction|appeal",
  "outcome": "upheld|not_upheld",
  "adjustments": [{ "type": "deferral", "params": { "cycle_id": 12 } }],
  "dates": { "effective_from": "2026-12-01" },
  "finalised_at": "ISO time", "iat": 1762600000 }
```

- `adjustments` use the types and parameters in the table above, validated exactly as a decision made in My College, as at `finalised_at`. A claim not upheld carries none. Unknown fields are dropped.
- `dates`: up to eight named ISO dates (`yyyy-mm-dd`).
- The **version** is the idempotency key: the same version twice is one decision, whatever its event ID. Only a version higher than any received becomes the claim's outcome; a lower one is kept in the history.
- An `initial` or `correction` version starts the College's appeal window from `finalised_at`; an `appeal` version ends it.

| Answer | Meaning |
|---|---|
| 200 `recorded` + `version` | This version is now the claim's outcome |
| 200 `superseded` + `version` | Kept in the history; a higher version stands |
| 200 `duplicate` + `version` | This version was already recorded |
| 404 | No such claim at this College. Refused and recorded. |
| 409 | This College does not decide in a cabinet |
| 422 | A field failed validation, with the reason. Correct it as a new version. |

| Answer | Meaning |
|---|---|
| 200 `applied` | The event changed the claim |
| 200 `duplicate` | This `event_id` was seen before |
| 200 `stale` | The event would move the claim backwards, for example a receipt after a deletion. It is ignored. |
| 401 | Bad signature, wrong address or out of time. Do not retry until fixed. |
| 404 | Unknown case at this College, or no paired cabinet |
| 503 | Retry |

## What must never appear

No filename, statement, evidence content, comment, rationale, pass or token in any log,
analytics, email or error report, on either side. My College's mail to a candidate says only that a
claim exists, its status and the adjustments granted, with a link to the portal. Its mail to
reviewers and administrators names no person and no case.

## My College behaviour, for reference

- **Claims:** a candidate opens a claim against something they hold live: a recertification cycle, an exam entry in a diet that is not archived, a credential, a residency, or "another programme stage".
- **Decisions, cabinet mode:** the committee decides in the cabinet; My College records each version, applies the one in force and sends the candidate the standard outcome email with the College's appeals notice. My College's own Decide, College appeal and Close buttons are withdrawn. A CiviCRM due-date change waits for an administrator to confirm it.
- **Decisions, own process:** the College's administrator, or the chair of a committee holding the Extenuating circumstances area, records `upheld` or `not_upheld` and the adjustments in My College. My College closes the claim when the appeal window passes.
- **Appeal window:** College settings → Appeals, 30 days by default, the same for every adverse outcome.
- **Effects:**
  - A recertification extension moves the cycle end and CEE_due; a reduced target lowers the target.
  - Exam additional time goes into the ExamSoft export's Extra Time column.
  - Separate room and rest breaks show on the Concierge candidate list.
  - Every other adjustment is recorded for the College to act on.
- **EBVS appeal:** an EBVS admin sends `appeal.hold` to the College's cabinet and opens a linked claim under EBVS, for fresh evidence in EBVS's own cabinet. Closing the EBVS appeal sends `appeal.release`.
- **Pairing:** only the College's own administrator can pair the College's cabinet. EBVS administrators cannot; they pair only EBVS's own cabinet.
