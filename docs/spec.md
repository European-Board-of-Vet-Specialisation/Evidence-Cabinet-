# College evidence cabinet: functional specification v0.4

9 November 2026 · Proposed for pilot · Supersedes v0.3 and the additional specification for committee
discussion, notifications and decision reporting · Technical contract: `docs/ec-cabinet-interface.md`

## 1. Purpose

A candidate applies in My College for extenuating personal circumstances to be considered for an upcoming
decision. My College records the claim, its administrative outcome and the adjustments granted. Everything
else (the candidate's account, the supporting documents, the committee's discussion, draft decisions and
the reasoning) stays with the College. No evidence or discussion passes through an EBVS server, and EBVS
holds no key that can read it.

Each College chooses how evidence reaches it (My College → College settings → Evidence handling):

- **A secure evidence cabinet.** Candidates upload into a system the College controls. The committee
  reads, discusses and decides there. This specification describes that cabinet.
- **The College's own process.** The College collects evidence its own way and publishes instructions to
  candidates. Its chair or administrator records the outcome in My College. Nothing in this specification
  applies.

The cabinet described here is EBVS's reference implementation, built on Cloudflare. Cloudflare is not a
requirement: any system that implements the interface in section 7 may connect.

## 2. Roles

- **College:** data controller for the evidence, the discussion, the decision and its reasoning. Owns the
  cabinet account, the Git organisation, the keys, the reviewer identities, the assignments and the retention
  settings.
- **EBVS:** software supplier, and administrator of the minimal claim record in My College. Publishes the
  source, deployment template, releases and support, using synthetic cases only. Has no credential for any
  College account.
- **EBVS appeals:** EBVS runs its own cabinet and is controller only for appeals made to EBVS.

## 3. Data held

### 3.1 My College

- Candidate and College.
- An opaque, random, College-scoped case reference.
- What the claim relates to: recertification, examination, credentialing, residency or another programme
  stage.
- Status and dates.
- Each decision version received from the cabinet: version number, type (initial, correction, appeal),
  outcome (upheld or not upheld), structured adjustments, named dates, time of finalisation. The version in
  force is the highest received.
- Hold state for an EBVS appeal.
- Neutral notification records: event, recipient ID, kind, delivery state.

My College holds no reason, no category of circumstance, no description of relief sought, no comment, no
draft and no rationale.

### 3.2 Structured adjustments

Each adjustment is a fixed type with typed parameters. There is no free-text field.

| Type | Parameters | Applies to |
|---|---|---|
| Extension | months (1–36) or a new deadline date | all; recertification takes months only |
| Deferral | the diet deferred to | examination |
| Additional examination time | minutes per paper or a percentage | examination |
| Separate room | yes | examination |
| Rest breaks | number and length in minutes | examination |
| Reduced target | months lost, so the points target is pro-rated | recertification |
| Other approved | a code from the College's own list | all |

Codes in the College's list describe the adjustment, never the circumstance. An extension and a reduced
target are never granted together.

### 3.3 The cabinet

The candidate's account; the original files and their versions; reviewer assignments; the discussion
thread; draft recommendations; decision versions with their rationale and the evidence versions
considered; the view log; retention flags and holds; the event outbox. All of it is held in the College's
account.

## 4. Architecture

- **Worker:** serves the upload page, the case list, the case view (evidence and discussion together),
  the decision screen and the API. Verifies passes, enforces assignments on every request, logs views,
  manages holds, retention and deletion, and sends signed events.
- **R2 bucket:** private, EU jurisdiction, public access disabled, reached only through the Worker binding.
- **D1 database:** EU jurisdiction. Cases, assignments, nonce redemption, comments, unread markers,
  decisions, retention flags, the event outbox and the view log.
- **Scheduled job (Worker cron, daily):** the retention rule, reminders and the event outbox retries.
- **Reviewer identity:** a College-controlled identity provider or College-enrolled passkeys.

### 4.1 Object layout

- `cases/{case_ref}/{version}/{file_id}`: live evidence.
- `hold/{case_ref}/{version}/{file_id}`: evidence under an EBVS appeal hold or a retention flag.

Moving to `hold/` is a copy then delete, performed by the Worker.

## 5. Committee discussion

| ID | Requirement |
|---|---|
| DISC-01 | Each claim has a private, chronological discussion thread. Assigned reviewers read the evidence and discuss it in the same case view. |
| DISC-02 | The College controls assignments. The cabinet checks the current assignment whenever anyone opens a thread, posts a comment or reads evidence. Revocation takes effect on the next request, including within an existing session. |
| DISC-03 | Candidates see their own submission and its receipt. Comments, drafts and the rationale are visible only to authorised College users. Any formal communication to the candidate is a separate action. |
| DISC-04 | Each comment records its author and time. A comment may reference an evidence item already held. A correction preserves the original entry and records who corrected it and when. |
| DISC-05 | The discussion, drafts and rationale stay in D1; files stay in R2. A hold, a retention flag and disposal each cover both stores. |

On entering the cabinet, a reviewer sees their assigned cases, those with unread activity first. That is
where the neutral notification email leads (section 6.3).

## 6. Workflow

1. **Open claim.** The candidate makes a claim in My College, which creates the case reference. My College
   asks for no reason.
2. **Submit evidence.** The candidate selects Submit evidence. My College issues a launch pass (`upload`).
   The cabinet verifies it, shows the College's privacy notice and accepts a statement and files.
3. **Validate.** The Worker checks size, reads the file signature to confirm a PDF or permitted image type,
   and rejects anything else. Interrupted uploads stay incomplete.
4. **Confirm receipt.** After durable storage the cabinet confirms to the candidate and sends
   `evidence.received`. Further files create a new version; earlier versions remain.
5. **Review and discuss.** A reviewer opens the case from My College (`review` pass for one case, or
   `inbox` for their list). The Worker verifies the pass, the reviewer's College identity and the live
   assignment. Reviewers read and comment (section 5). Each new comment asks My College to notify the other
   assigned reviewers (6.3).
6. **Decide** (6.1).
7. **College appeal.** Heard in the cabinet as a new decision version of type `appeal`, linked to the
   original. While it runs the cabinet keeps the case; no signal is needed.
8. **EBVS appeal.** My College sends `appeal.hold`; the Worker moves the case to `hold/`. The appellant
   submits fresh evidence to the EBVS cabinet. When the EBVS appeal closes, My College sends
   `appeal.release`.
9. **Close and dispose.** The cabinet decides when a case is disposed of, under the College's retention
   policy, normally once the appeal window has passed with no appeal. My College does not close a case on a
   timer for a College that decides in its cabinet. It sends `case.closed` only when the candidate withdraws.
   On disposal, `case.closed` or `appeal.release`, the Worker deletes the case's objects and its sensitive
   D1 records (account, comments, drafts, rationale, view log entries), confirms both prefixes are empty and
   sends `evidence.deleted`. My College then closes the claim and keeps its administrative record under its
   own policy.
10. **Backstop** (6.2).

### 6.1 Decision and reporting

1. **Prepare.** An assigned reviewer may draft a recommendation. The College designates who may finalise,
   normally the committee chair or an authorised delegate.
2. **Record.** The decision screen has separate fields for the internal rationale and the administrative
   outcome. The rationale stays in the cabinet with the evidence versions considered. The outcome is upheld
   or not upheld. Adjustments use the structured types in 3.2, with dates where relevant.
3. **Preview and finalise.** Before confirming, the person finalising sees the exact fields My College will
   receive. Finalising locks the version, records the officer and time in the cabinet, and queues
   `claim.decision_finalised` in the same transaction. Free text never goes into the payload.
4. **Confirm.** The cabinet shows *Decision recorded · awaiting My College confirmation* until My College
   acknowledges that version, then *Recorded in My College*. A failed transfer stays visible to the College
   administrator and can be retried without the chair entering the decision again. My College refuses an
   adjustment that does not fit the claim, for example additional examination time on a recertification
   claim. The cabinet shows the refusal so the decision can be corrected as a new version.
5. **Correct or hear an appeal.** An authorised officer creates a new version linked to the original. My
   College keeps every version, shows the highest as in force, and never lets a delayed earlier version
   replace a later one. The reason for the change stays in the cabinet.
6. **Effects in My College.** On the version in force, My College applies the adjustments: the
   recertification cycle moves or its target is pro-rated; additional time goes into the ExamSoft export;
   separate room and rest breaks show on the Concierge roster. Other adjustments are recorded for the College
   to act on. Writing an extended due date into CiviCRM waits for a College administrator to confirm it in My
   College. If a later version changes an extension already written to CiviCRM, the administrator is told to
   correct the due date there. The candidate receives the standard outcome email, with the appeal closing
   date and the College's appeals notice.

*Example.* The committee upholds a claim and grants deferral to the next diet. My College receives the case
reference, version 1, initial, upheld, deferral to that diet, and the time of finalisation. The medical
letter, the reviewers' exchange and the chair's reasoning remain in the cabinet. The chair completes the
decision once.

### 6.2 Retention and deletion

| ID | Requirement |
|---|---|
| RET-01 | **18-month rule.** The daily job deletes a case (objects and sensitive D1 records) 18 months after its last activity (the latest upload, comment or decision version), whatever its state, unless it is under an EBVS appeal hold or a retention flag. |
| RET-02 | **Lifecycle backstop.** An R2 lifecycle rule deletes objects under `cases/` 18 months after upload, as a net if the daily job fails. `hold/` is excluded. A case that must be kept past that point is flagged (RET-03), which moves it to `hold/`. |
| RET-03 | **Retention flag.** An authorised committee member may flag a case for retention, recording the reason in the cabinet. Flagging moves its objects to `hold/`. |
| RET-04 | **Flags expire.** A flag lasts six months. It can be renewed, which records who renewed it and why. An expired flag lapses: the case returns to `cases/` and RET-01 applies again. |
| RET-05 | **Retention review reminder.** 30 days before a flag expires, the cabinet asks My College to notify the College's administrators and the people designated to finalise (`retention_review`). |
| RET-06 | **Deletion reminder.** 30 days before RET-01 would delete a case, the cabinet asks My College to notify the same people (`deletion_due`), so a committee can flag a case that must be kept. |
| RET-07 | **Six-monthly summary.** Every six months the cabinet prepares a summary for the College administrator: cases held, cases flagged, deletions in the period and deletions due. It holds numbers only and is viewed in the cabinet. My College sends a `summary` notice. |
| RET-08 | Disposal under any rule ends with `evidence.deleted`. |

### 6.3 Notifications

The cabinet has no email service. It asks My College to send neutral emails, using the same signed pairing
it uses for receipts. No College email domain, sending service or recipient verification is needed.

- **Recipients** are named by the per-College reviewer ID their passes carry (section 7.1), never by
  name or address. My College sends only to people who are currently members of a committee holding the
  Extenuating circumstances area, or (for retention, deletion and summary notices) College administrators.
  Anyone else is skipped, so a reviewer removed from the committee receives nothing.
- **For a comment,** the cabinet names the other currently assigned reviewers and excludes the author.
- **Content.** The event and the email carry no candidate name, case reference, comment text, evidence link,
  attachment or reviewer name. They say, for example, "You have an unread committee comment. Sign in to My
  College to review it", with a link to the signed-in portal page. From there, *Open your committee cases*
  enters the cabinet.
- **Kinds:** `comment`, `retention_review`, `deletion_due`, `summary`.
- **Delivery.** My College records one row per event and recipient before sending. A retried event sends
  nothing twice. Acknowledgement means My College has accepted responsibility for the emails.

## 7. Interface contract

Any system connecting to My College implements these. The technical detail is in
`docs/ec-cabinet-interface.md`.

### 7.1 Launch pass (My College → browser → cabinet)

A signed assertion bound to issuer, audience (the cabinet), College, subject (a per-College pseudonym),
role, action (`upload`, `review`, or `inbox` with no case reference), expiry of no more than two minutes
and a unique nonce. The cabinet redeems the nonce once, atomically. Passes are sent by form POST, never in
query strings or logs. A valid pass alone never opens evidence or discussion.

### 7.2 Signals (My College → cabinet)

`case.closed` (the candidate withdrew; or, for a College not deciding in its cabinet, the appeal window
passed or an officer closed the claim), `appeal.hold` and `appeal.release` (EBVS appeals). Each is signed,
has an event ID and timestamp, and is idempotent.

### 7.3 Events (cabinet → My College)

| Event | Trigger | Payload | My College answer |
|---|---|---|---|
| `evidence.received` | Durable storage of a version | case reference, version, time | applied, duplicate or stale |
| `evidence.deleted` | Both prefixes confirmed empty | case reference, time | applied |
| `reviewer.notification_requested` | A comment, or a retention reminder | kind, recipient IDs | accepted, with counts sent and skipped |
| `claim.decision_finalised` | A decision version is finalised | case reference, version, decision type, outcome, adjustments, named dates, finalised time | recorded, superseded (kept in history) or duplicate, with the version |

Each event is signed with the College's key and carries its event ID. A retry reuses the event ID and is
re-signed with a fresh issue time. The cabinet saves the record (comment, decision) and its pending event in
the same transaction, and retries until acknowledged. My College verifies the signature, validates every
field, and refuses and records any event naming a claim that is not the College's.

### 7.4 Keys

My College holds its launch-signing private key. The College holds its event-signing private key. Public
keys are exchanged at pairing. Both sides support rotation.

## 8. Viewing controls

- Files are served inline with `Cache-Control: private, no-store`.
- PDFs render in a PDF.js viewer in the reviewer's browser, with no download or print control.
- An overlay watermark shows the reviewer's name and the time on every page.
- Every view is logged in D1 with reviewer, case, file and time.
- An optional country allow-list uses the request country, defaulting to EEA and adequacy countries.
- Revoking an assignment blocks the next request, including within an open session, for evidence and
  discussion alike.

A browser can always capture what it displays. The watermark, the log and the reviewer's undertaking make
leaks traceable.

## 9. Plan tiers

The template works on the free plan and enables extra features when it detects the paid plan.

| Capability | Free | Workers Paid (recommended) |
|---|---|---|
| Content-based type check, size limit | Yes | Yes |
| Access control, view log, discussion, decisions, holds, retention, deletion | Yes | Yes |
| In-browser viewer with overlay watermark | Yes | Yes |
| Watermark stamped into the PDF on the server | No | Yes |
| Image re-encoding to strip embedded content | No | Yes |

No external malware-scanning service is used; it would become a sub-processor with sight of the evidence.

## 10. Data location

The template creates an EU-jurisdiction R2 bucket and D1 database and verifies the bindings before enabling
uploads. Worker execution is not location-pinned without Cloudflare Enterprise. The upload page shows the
College's privacy notice: files are stored in the EU and may pass briefly through Cloudflare servers
elsewhere.

## 11. Reviewer identity

Reviewer identity is College-controlled. EBVS administrators have no route to enrol a reviewer, change an
assignment, reset a credential or deploy Worker code. My College lists each reviewer's per-College ID under
College settings → Evidence handling, for the College to enter against that person's own login.

## 12. Deployment

| Step | College administrator | EBVS |
|---|---|---|
| Ownership | Create the College Cloudflare account and Git organisation; name a second administrator | Publish the template, permissions list and setup guide |
| Install | Select Deploy to Cloudflare; approve resources | Provide the Worker, R2, D1, lifecycle rule, daily job and plan detection |
| Location | Confirm EU jurisdiction | Validate bindings in the setup wizard |
| Pair | In My College choose *A secure evidence cabinet*, register the origin and exchange public keys | Signed two-way test; access denied until pairing and identity succeed |
| Activate | Enrol reviewers, designate who may finalise, confirm the appeal window in My College (College settings → Appeals) and the retention settings, run a synthetic case to deletion | Report pass or fail without evidence content |
| Maintain | Approve each release into production; remove outgoing officers | Publish releases and migration notes; no automatic path into College production |

## 13. Pilot acceptance tests

1. A College officer deploys, pairs, updates and recovers the installation with no EBVS credential in any
   College account.
2. My College stores no reason, category, relief sought, comment or rationale; adjustments are structured
   only.
3. A copied URL, expired or replayed pass, cross-College reference, wrong action or unmatched reviewer
   identity fails. A valid EBVS pass alone cannot read evidence or discussion.
4. An EBVS administrator cannot read evidence or discussion, change assignments or reset reviewer
   credentials.
5. Revoking an assignment blocks the next request in an open session, for evidence and discussion.
6. Non-permitted file types, renamed files and oversized files are rejected; interrupted uploads stay
   incomplete.
7. Duplicate or out-of-order events never duplicate or reverse a receipt.
8. `appeal.hold` moves files to `hold/`; the lifecycle rule leaves them; `appeal.release` deletes them.
9. A case with no activity for 18 months and no flag is deleted with no signal, objects and D1 records
   alike, and My College receives `evidence.deleted`.
10. A flagged case survives 18 months; its flag expires after six months unless renewed; the retention
    review and deletion reminders arrive 30 days ahead, as neutral emails.
11. Logs, analytics, emails and error reports contain no filenames, tokens, evidence or comment content.
12. The template runs end to end on the free plan and enables paid features when upgraded.
13. A signing key rotation and an officer handover are rehearsed before live cases.
14. A reviewer comments on a case with three assigned reviewers: the other two receive individual neutral
    emails, the author none. The event, the email and My College's logs hold no comment text or candidate
    detail.
15. A reviewer removed after receiving an email follows the link and gets no access to that case, its
    discussion or its evidence.
16. My College is unavailable when the chair finalises: the cabinet keeps the decision, shows it pending,
    and delivers it after recovery with no further action by the chair.
17. My College receives the same event twice: each reviewer gets one email per comment; a decision appears
    once per version.
18. An appeal changes a decision and the original event arrives late: My College shows the appeal outcome
    and keeps the original in its history.
19. A validly signed event names another College's claim: My College refuses it and records the failure.
20. The College disposes of a case: evidence, comments, drafts and rationale are deleted under the College's
    retention policy; My College keeps the administrative record under its own policy.
