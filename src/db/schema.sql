-- ===========================================================================
-- AI Revenue Recovery Agent — schema
--
-- Conventions enforced throughout:
--   * All money is INTEGER paise. No REAL columns for amounts, anywhere.
--   * All timestamps are TEXT, ISO-8601 UTC.
--   * Idempotency is a database constraint, not application etiquette.
--   * The audit log is append-only, enforced by triggers rather than by
--     convention, so no code path can rewrite history.
--   * No aggregate totals are stored. Every metric is derived at query time
--     from these rows, which is what structurally prevents double-counting
--     recovered revenue.
-- ===========================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id                        TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  email                     TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  lifetime_value_paise      INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_value_paise >= 0),
  successful_payments_count INTEGER NOT NULL DEFAULT 0 CHECK (successful_payments_count >= 0),
  failed_payments_count     INTEGER NOT NULL DEFAULT 0 CHECK (failed_payments_count >= 0),
  last_successful_payment_at TEXT
);

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                 TEXT PRIMARY KEY,
  customer_id        TEXT NOT NULL REFERENCES customers(id),
  amount_paise       INTEGER NOT NULL CHECK (amount_paise > 0),
  currency           TEXT NOT NULL DEFAULT 'INR',
  status             TEXT NOT NULL,
  method             TEXT NOT NULL,
  failure_code       TEXT,
  failure_reason_raw TEXT,
  attempt_number     INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number >= 1),
  provider           TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments(status);

-- ---------------------------------------------------------------------------
-- Raw inbound events.
-- Written once on receipt and never mutated. The UNIQUE idempotency_key is
-- what makes duplicate webhook delivery a no-op rather than a second case.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_events (
  id              TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  type            TEXT NOT NULL,
  payment_id      TEXT,
  customer_id     TEXT,
  payload_json    TEXT NOT NULL,
  received_at     TEXT NOT NULL,
  processed_at    TEXT,
  case_id         TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_payment ON payment_events(payment_id);
CREATE INDEX IF NOT EXISTS idx_events_type    ON payment_events(type);

-- ---------------------------------------------------------------------------
-- Recovery cases.
-- payment_id is UNIQUE: one payment can never spawn two recovery cases,
-- however many times its failure event is delivered.
--
-- recovered_amount_paise is written in exactly one place in the codebase
-- (OutcomeTracker, on a confirmed successful payment status) and is NULL
-- for every case that has not actually been recovered.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recovery_cases (
  id                     TEXT PRIMARY KEY,
  payment_id             TEXT NOT NULL UNIQUE REFERENCES payments(id),
  customer_id            TEXT NOT NULL REFERENCES customers(id),
  amount_paise           INTEGER NOT NULL CHECK (amount_paise > 0),
  currency               TEXT NOT NULL DEFAULT 'INR',
  state                  TEXT NOT NULL,
  diagnosis              TEXT,
  recoverability         TEXT,
  confidence             REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  cycle_count            INTEGER NOT NULL DEFAULT 0 CHECK (cycle_count >= 0),
  opened_at              TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  next_evaluation_at     TEXT,
  closed_at              TEXT,
  recovered_at           TEXT,
  recovered_amount_paise INTEGER CHECK (recovered_amount_paise IS NULL OR recovered_amount_paise > 0),

  -- Revenue may only be marked recovered by a case that is actually RECOVERED.
  CHECK (
    (state = 'RECOVERED' AND recovered_amount_paise IS NOT NULL AND recovered_at IS NOT NULL)
    OR
    (state <> 'RECOVERED' AND recovered_amount_paise IS NULL AND recovered_at IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_cases_state    ON recovery_cases(state);
CREATE INDEX IF NOT EXISTS idx_cases_customer ON recovery_cases(customer_id);
CREATE INDEX IF NOT EXISTS idx_cases_next_eval ON recovery_cases(next_evaluation_at);

-- ---------------------------------------------------------------------------
-- Agent decisions. One row per evaluation cycle, immutable.
-- decision_source records whether the LLM, a fixture, or the deterministic
-- fallback produced it, so a heuristic decision is never displayed as an
-- LLM decision.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recovery_decisions (
  id                 TEXT PRIMARY KEY,
  case_id            TEXT NOT NULL REFERENCES recovery_cases(id),
  cycle              INTEGER NOT NULL CHECK (cycle >= 1),
  diagnosis          TEXT NOT NULL,
  recoverability     TEXT NOT NULL,
  confidence         REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  recommended_action TEXT NOT NULL,
  reasoning_summary  TEXT NOT NULL,
  expected_value_paise INTEGER NOT NULL DEFAULT 0,
  decision_source    TEXT NOT NULL,
  model              TEXT,
  latency_ms         INTEGER,
  context_json       TEXT NOT NULL,
  raw_response_json  TEXT,
  created_at         TEXT NOT NULL,
  UNIQUE (case_id, cycle)
);
CREATE INDEX IF NOT EXISTS idx_decisions_case ON recovery_decisions(case_id);

-- ---------------------------------------------------------------------------
-- Policy evaluations. Every approval AND every block is recorded, with the
-- rule that decided it. original_action vs effective_action is how an
-- override by the policy layer stays visible.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS policy_evaluations (
  id               TEXT PRIMARY KEY,
  case_id          TEXT NOT NULL REFERENCES recovery_cases(id),
  decision_id      TEXT REFERENCES recovery_decisions(id),
  cycle            INTEGER NOT NULL,
  approved         INTEGER NOT NULL CHECK (approved IN (0, 1)),
  original_action  TEXT NOT NULL,
  effective_action TEXT,
  rule_code        TEXT NOT NULL,
  reason           TEXT NOT NULL,
  restrictions_json TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_policy_case  ON policy_evaluations(case_id);
CREATE INDEX IF NOT EXISTS idx_policy_rule  ON policy_evaluations(rule_code);

-- ---------------------------------------------------------------------------
-- Executed actions.
-- The UNIQUE idempotency_key means the same intervention cannot be executed
-- twice: no duplicate charges, no duplicate payment links, no duplicate
-- messages, even if the executor is invoked repeatedly.
-- provider records who actually carried it out (simulated vs razorpay_test),
-- so test-mode work is never presented as anything else.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recovery_actions (
  id                TEXT PRIMARY KEY,
  case_id           TEXT NOT NULL REFERENCES recovery_cases(id),
  cycle             INTEGER NOT NULL,
  action            TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL,
  provider          TEXT NOT NULL,
  external_ref      TEXT,
  request_json      TEXT,
  result_json       TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL,
  completed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_actions_case   ON recovery_actions(case_id);
CREATE INDEX IF NOT EXISTS idx_actions_action ON recovery_actions(action);
CREATE INDEX IF NOT EXISTS idx_actions_status ON recovery_actions(status);

-- ---------------------------------------------------------------------------
-- Outbound customer messages. Reminders and payment links land here first,
-- which is what makes the communication limits observable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbox_messages (
  id              TEXT PRIMARY KEY,
  case_id         TEXT NOT NULL REFERENCES recovery_cases(id),
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  action_id       TEXT REFERENCES recovery_actions(id),
  channel         TEXT NOT NULL,
  recipient       TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  payment_link_url TEXT,
  transport       TEXT NOT NULL,
  sent_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_case     ON outbox_messages(case_id);
CREATE INDEX IF NOT EXISTS idx_outbox_customer ON outbox_messages(customer_id);

-- ---------------------------------------------------------------------------
-- Every state change, in order. This is the case timeline.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS case_state_transitions (
  id         TEXT PRIMARY KEY,
  case_id    TEXT NOT NULL REFERENCES recovery_cases(id),
  from_state TEXT NOT NULL,
  to_state   TEXT NOT NULL,
  trigger    TEXT NOT NULL,
  detail     TEXT,
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transitions_case ON case_state_transitions(case_id);

-- ---------------------------------------------------------------------------
-- Append-only audit log. Answers "why did the agent take this action?".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  case_id     TEXT,
  event       TEXT NOT NULL,
  actor       TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_case ON audit_log(case_id);
CREATE INDEX IF NOT EXISTS idx_audit_at   ON audit_log(at);

-- History is immutable. These triggers make that a property of the database
-- rather than a rule the application is trusted to follow.
CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: updates are forbidden');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: deletes are forbidden');
END;

CREATE TRIGGER IF NOT EXISTS transitions_no_update
BEFORE UPDATE ON case_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'case_state_transitions is append-only: updates are forbidden');
END;

CREATE TRIGGER IF NOT EXISTS transitions_no_delete
BEFORE DELETE ON case_state_transitions
BEGIN
  SELECT RAISE(ABORT, 'case_state_transitions is append-only: deletes are forbidden');
END;

CREATE TRIGGER IF NOT EXISTS decisions_no_update
BEFORE UPDATE ON recovery_decisions
BEGIN
  SELECT RAISE(ABORT, 'recovery_decisions is append-only: updates are forbidden');
END;
