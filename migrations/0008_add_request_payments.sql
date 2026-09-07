CREATE TABLE request_payments (
  request_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  protocol TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('required', 'processing', 'accepted', 'failed', 'ambiguous')),
  amount_atomic TEXT NOT NULL CHECK (
    length(amount_atomic) > 0 AND
    amount_atomic NOT GLOB '*[^0-9]*' AND
    amount_atomic NOT LIKE '0%'
  ),
  asset TEXT NOT NULL,
  network TEXT NOT NULL,
  payer_identity TEXT,
  external_reference TEXT,
  attempt_owner_token TEXT,
  failure_code TEXT,
  attempt_started_at TEXT,
  verified_at TEXT,
  settled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (request_id) REFERENCES idempotent_requests(request_id) ON DELETE CASCADE,
  UNIQUE (provider, external_reference),
  CHECK (state != 'processing' OR (attempt_owner_token IS NOT NULL AND attempt_started_at IS NOT NULL)),
  CHECK (state != 'accepted' OR (
    payer_identity IS NOT NULL AND external_reference IS NOT NULL AND
    verified_at IS NOT NULL AND settled_at IS NOT NULL AND failure_code IS NULL
  )),
  CHECK (state NOT IN ('failed', 'ambiguous') OR failure_code IS NOT NULL)
);

CREATE INDEX idx_request_payments_state ON request_payments(state, updated_at);
