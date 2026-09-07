CREATE TABLE commercial_payment_exposures (
  request_id TEXT PRIMARY KEY,
  admission_day TEXT NOT NULL CHECK (length(admission_day) = 10),
  admission_month TEXT NOT NULL CHECK (length(admission_month) = 7),
  network TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount_atomic TEXT NOT NULL CHECK (
    length(amount_atomic) > 0 AND
    amount_atomic NOT GLOB '*[^0-9]*' AND
    amount_atomic NOT LIKE '0%'
  ),
  pay_to TEXT NOT NULL,
  facilitator TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'authorized', 'accepted', 'ambiguous', 'failed', 'released')),
  configuration_fingerprint TEXT NOT NULL,
  settlement_authorized_at TEXT,
  accepted_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (state != 'reserved' OR settlement_authorized_at IS NULL),
  CHECK (state != 'authorized' OR settlement_authorized_at IS NOT NULL),
  CHECK (state != 'accepted' OR accepted_at IS NOT NULL),
  CHECK (state NOT IN ('ambiguous', 'failed', 'released') OR resolved_at IS NOT NULL)
);

CREATE TABLE commercial_payment_events (
  event_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  network TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  facilitator TEXT NOT NULL,
  verified_payer TEXT,
  transaction_reference TEXT,
  configuration_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (request_id) REFERENCES commercial_payment_exposures(request_id),
  UNIQUE (request_id, event_type)
);

CREATE INDEX idx_commercial_exposures_day_state
  ON commercial_payment_exposures(admission_day, state);
CREATE INDEX idx_commercial_exposures_month_state
  ON commercial_payment_exposures(admission_month, state);
CREATE INDEX idx_commercial_exposures_state_updated
  ON commercial_payment_exposures(state, updated_at);
CREATE INDEX idx_commercial_events_request
  ON commercial_payment_events(request_id, occurred_at);
CREATE INDEX idx_commercial_events_type
  ON commercial_payment_events(event_type, occurred_at);
CREATE INDEX idx_commercial_events_transaction
  ON commercial_payment_events(transaction_reference)
  WHERE transaction_reference IS NOT NULL;
