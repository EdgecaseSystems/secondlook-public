CREATE TABLE payment_remediation_cases (
  case_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  case_kind TEXT NOT NULL CHECK (case_kind IN ('payment_ambiguity', 'paid_fulfillment')),
  network TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount_atomic TEXT NOT NULL CHECK (
    length(amount_atomic) > 0 AND
    amount_atomic NOT GLOB '*[^0-9]*' AND
    amount_atomic NOT LIKE '0%'
  ),
  seller_recipient TEXT NOT NULL,
  facilitator_identifier TEXT NOT NULL,
  commercial_configuration_fingerprint TEXT NOT NULL,
  authorization_payer TEXT,
  authorization_nonce TEXT,
  facilitator_verified_payer TEXT,
  chain_confirmed_payer TEXT,
  original_transaction_reference TEXT,
  reconciled_transaction_reference TEXT,
  reconciliation_status TEXT NOT NULL CHECK (
    reconciliation_status IN ('not_required', 'pending', 'confirmed_paid', 'confirmed_not_paid', 'unresolved')
  ),
  fulfillment_status TEXT NOT NULL CHECK (
    fulfillment_status IN ('not_started', 'recovery_available', 'completed', 'inference_ambiguous', 'unavailable')
  ),
  remediation_status TEXT NOT NULL CHECK (
    remediation_status IN (
      'none', 'refund_review_required', 'refund_approved', 'refund_submitted',
      'refund_confirmed', 'refund_failed', 'closed_without_refund'
    )
  ),
  refund_recipient TEXT,
  refund_transaction_reference TEXT,
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  FOREIGN KEY (request_id) REFERENCES commercial_payment_exposures(request_id),
  CHECK (case_kind != 'payment_ambiguity' OR reconciliation_status != 'not_required'),
  CHECK (case_kind != 'paid_fulfillment' OR reconciliation_status = 'not_required'),
  CHECK (remediation_status NOT IN ('refund_approved', 'refund_submitted', 'refund_confirmed', 'refund_failed') OR refund_recipient IS NOT NULL),
  CHECK (remediation_status NOT IN ('refund_submitted', 'refund_confirmed', 'refund_failed') OR refund_transaction_reference IS NOT NULL),
  CHECK (closed_at IS NULL OR remediation_status IN ('refund_confirmed', 'closed_without_refund'))
);

CREATE TABLE payment_remediation_events (
  event_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'case_opened', 'fulfillment_recovery_available', 'fulfillment_unavailable', 'fulfillment_completed',
    'inference_ambiguous', 'reconciliation_confirmed_paid',
    'reconciliation_confirmed_not_paid', 'reconciliation_unresolved',
    'refund_review_required', 'refund_approved', 'refund_submitted',
    'refund_confirmed', 'refund_failed', 'closed_without_refund'
  )),
  occurred_at TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('system', 'operator')),
  reason_code TEXT,
  reconciliation_source TEXT,
  evidence_fingerprint TEXT,
  network TEXT,
  transaction_reference TEXT,
  block_number INTEGER,
  payer TEXT,
  recipient TEXT,
  amount_atomic TEXT,
  operation_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (case_id) REFERENCES payment_remediation_cases(case_id)
);

CREATE INDEX idx_payment_remediation_cases_reconciliation
  ON payment_remediation_cases(reconciliation_status, updated_at);
CREATE INDEX idx_payment_remediation_cases_remediation
  ON payment_remediation_cases(remediation_status, updated_at);
CREATE INDEX idx_payment_remediation_cases_open
  ON payment_remediation_cases(updated_at)
  WHERE closed_at IS NULL;
CREATE INDEX idx_payment_remediation_events_case
  ON payment_remediation_events(case_id, occurred_at);
CREATE INDEX idx_payment_remediation_events_request
  ON payment_remediation_events(request_id, occurred_at);
CREATE INDEX idx_payment_remediation_events_transaction
  ON payment_remediation_events(network, transaction_reference)
  WHERE transaction_reference IS NOT NULL;
