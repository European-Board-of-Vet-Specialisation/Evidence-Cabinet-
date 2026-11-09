-- The cabinet's database. EU jurisdiction (wrangler d1 create --jurisdiction eu).
--
-- What is sensitive, and so deleted with the case: the candidate's statement, the files' rows,
-- comments, decisions (drafts and rationale), reads and the view log. What survives disposal:
-- the bare case row (reference, disposed_at), so a late signal is answered correctly and the
-- deletion can be confirmed.

-- People the College admits: reviewers and administrators. `sub` is the per-College ID My
-- College puts in their passes (College settings → Evidence handling lists it).
CREATE TABLE people (
  id            INTEGER PRIMARY KEY,
  sub           TEXT UNIQUE,                 -- null until the administrator enters it
  display_name  TEXT NOT NULL,               -- for the watermark and the audit trail, College-side only
  is_admin      INTEGER NOT NULL DEFAULT 0,
  can_finalise  INTEGER NOT NULL DEFAULT 0,  -- designated to finalise decisions (normally the chair)
  can_retain    INTEGER NOT NULL DEFAULT 0,  -- may flag a case for retention
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  removed_at    TEXT
);

CREATE TABLE passkeys (
  id            TEXT PRIMARY KEY,            -- credential ID, base64url
  person_id     INTEGER NOT NULL REFERENCES people(id),
  public_key    BLOB NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
CREATE INDEX passkeys_person ON passkeys(person_id);

-- One-time links an administrator gives a person to enrol a passkey. Stored hashed.
CREATE TABLE enrolments (
  token_hash    TEXT PRIMARY KEY,
  person_id     INTEGER NOT NULL REFERENCES people(id),
  created_by    INTEGER,
  expires_at    TEXT NOT NULL,
  used_at       TEXT
);

-- Signed-in College users. The cookie holds a random ID; only its hash is stored.
CREATE TABLE sessions (
  id_hash       TEXT PRIMARY KEY,
  person_id     INTEGER NOT NULL REFERENCES people(id),
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

-- A candidate's short session after an upload pass: one case, one person, no sign-in.
CREATE TABLE candidate_sessions (
  id_hash       TEXT PRIMARY KEY,
  sub           TEXT NOT NULL,
  case_ref      TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

-- WebAuthn challenges, single use.
CREATE TABLE challenges (
  id            TEXT PRIMARY KEY,
  challenge     TEXT NOT NULL,
  purpose       TEXT NOT NULL,               -- 'register' | 'authenticate'
  person_id     INTEGER,
  expires_at    TEXT NOT NULL
);

-- Launch-pass nonces, redeemed once. Kept until the pass would have expired anyway.
CREATE TABLE nonces (
  jti           TEXT PRIMARY KEY,
  exp           INTEGER NOT NULL
);

-- Signals from My College already applied (idempotency by event_id).
CREATE TABLE signals_seen (
  event_id      TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  case_ref      TEXT NOT NULL,
  at            TEXT NOT NULL
);

CREATE TABLE cases (
  case_ref        TEXT PRIMARY KEY,
  candidate_sub   TEXT,
  state           TEXT NOT NULL DEFAULT 'open',   -- open | disposed
  location        TEXT NOT NULL DEFAULT 'cases',  -- cases | hold  (R2 prefix)
  ebvs_hold       INTEGER NOT NULL DEFAULT 0,
  retain_until    TEXT,                           -- retention flag, six months at a time
  retain_reason   TEXT,
  retain_by       INTEGER,
  created_at      TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  reminded_retention_at TEXT,
  reminded_deletion_at  TEXT,
  disposed_at     TEXT,
  disposed_why    TEXT                            -- withdrawn | closed | released | retention | backstop
);

CREATE TABLE evidence_versions (
  case_ref      TEXT NOT NULL,
  version       INTEGER NOT NULL,
  statement     TEXT,
  complete      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  completed_at  TEXT,
  PRIMARY KEY (case_ref, version)
);

CREATE TABLE files (
  id            TEXT PRIMARY KEY,
  case_ref      TEXT NOT NULL,
  version       INTEGER NOT NULL,
  kind          TEXT NOT NULL,               -- pdf | png | jpeg
  size          INTEGER NOT NULL,
  label         TEXT NOT NULL,               -- "Document 1": never the uploaded filename
  created_at    TEXT NOT NULL
);
CREATE INDEX files_case ON files(case_ref);

CREATE TABLE assignments (
  case_ref      TEXT NOT NULL,
  person_id     INTEGER NOT NULL REFERENCES people(id),
  assigned_by   INTEGER,
  assigned_at   TEXT NOT NULL,
  revoked_at    TEXT,
  PRIMARY KEY (case_ref, person_id)
);

CREATE TABLE comments (
  id            INTEGER PRIMARY KEY,
  case_ref      TEXT NOT NULL,
  person_id     INTEGER NOT NULL REFERENCES people(id),
  body          TEXT NOT NULL,
  file_id       TEXT,                        -- an evidence item already held
  corrects_id   INTEGER,                     -- a correction preserves the original
  created_at    TEXT NOT NULL
);
CREATE INDEX comments_case ON comments(case_ref);

CREATE TABLE reads (
  case_ref      TEXT NOT NULL,
  person_id     INTEGER NOT NULL,
  last_read_at  TEXT NOT NULL,
  PRIMARY KEY (case_ref, person_id)
);

CREATE TABLE decisions (
  id              INTEGER PRIMARY KEY,
  case_ref        TEXT NOT NULL,
  version         INTEGER,                   -- null while a draft
  decision_type   TEXT NOT NULL,             -- initial | correction | appeal
  outcome         TEXT,                      -- upheld | not_upheld
  adjustments     TEXT NOT NULL DEFAULT '[]',
  dates           TEXT NOT NULL DEFAULT '{}',
  rationale       TEXT,                      -- stays here; never sent
  evidence_considered TEXT NOT NULL DEFAULT '[]',
  supersedes      INTEGER,
  drafted_by      INTEGER,
  drafted_at      TEXT,
  finalised_by    INTEGER,
  finalised_at    TEXT,
  mc_state        TEXT,                      -- pending | recorded | superseded | refused
  mc_detail       TEXT,
  UNIQUE (case_ref, version)
);

-- Signed events waiting for My College, saved in the same batch as what they report.
CREATE TABLE outbox (
  id            INTEGER PRIMARY KEY,
  event_id      TEXT NOT NULL UNIQUE,
  type          TEXT NOT NULL,
  body          TEXT NOT NULL,               -- payload fields except iss/aud/college/iat
  decision_id   INTEGER,
  state         TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | refused | dead
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_status   INTEGER,
  last_error    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX outbox_due ON outbox(state, next_attempt_at);

CREATE TABLE view_log (
  id            INTEGER PRIMARY KEY,
  case_ref      TEXT NOT NULL,
  file_id       TEXT NOT NULL,
  person_id     INTEGER NOT NULL,
  country       TEXT,
  at            TEXT NOT NULL
);
CREATE INDEX view_log_case ON view_log(case_ref);

-- Six-monthly summaries: numbers only.
CREATE TABLE summaries (
  id            INTEGER PRIMARY KEY,
  period_end    TEXT NOT NULL,
  cases_held    INTEGER NOT NULL,
  cases_flagged INTEGER NOT NULL,
  deleted_in_period INTEGER NOT NULL,
  deletions_due INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);

-- A review or inbox pass that arrived before the reviewer signed in. Held for ten minutes, then
-- matched against whoever signs in: the pass names the person; the sign-in proves it is them.
CREATE TABLE pending_launches (
  id_hash       TEXT PRIMARY KEY,
  sub           TEXT NOT NULL,
  act           TEXT NOT NULL,               -- review | inbox
  case_ref      TEXT,
  expires_at    TEXT NOT NULL
);
