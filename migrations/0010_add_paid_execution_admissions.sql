ALTER TABLE request_payments ADD COLUMN authorization_payer TEXT;
ALTER TABLE request_payments ADD COLUMN authorization_nonce TEXT;

CREATE UNIQUE INDEX idx_request_payments_authorization_identity
  ON request_payments(network, asset, authorization_payer, authorization_nonce)
  WHERE authorization_payer IS NOT NULL AND authorization_nonce IS NOT NULL;

CREATE TABLE paid_execution_admissions (
  request_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'settling', 'accepted', 'ambiguous', 'consumed', 'released')),
  admission_day TEXT NOT NULL,
  capacity_day TEXT NOT NULL,
  owner_token TEXT,
  lease_kind TEXT CHECK (lease_kind IN ('settlement', 'inference') OR lease_kind IS NULL),
  lease_expires_at INTEGER,
  settlement_authorized_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (request_id) REFERENCES idempotent_requests(request_id) ON DELETE CASCADE,
  CHECK ((lease_kind IS NULL AND lease_expires_at IS NULL) OR (lease_kind IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (state NOT IN ('reserved', 'settling') OR (owner_token IS NOT NULL AND lease_kind = 'settlement')),
  CHECK (state != 'reserved' OR settlement_authorized_at IS NULL),
  CHECK (state != 'settling' OR settlement_authorized_at IS NOT NULL),
  CHECK (state NOT IN ('ambiguous', 'released') OR (owner_token IS NULL AND lease_kind IS NULL AND lease_expires_at IS NULL))
);

CREATE INDEX idx_paid_execution_admissions_capacity ON paid_execution_admissions(capacity_day, state);
CREATE INDEX idx_paid_execution_admissions_lease ON paid_execution_admissions(lease_expires_at, state);
CREATE INDEX idx_paid_execution_admissions_unresolved ON paid_execution_admissions(state, updated_at);
