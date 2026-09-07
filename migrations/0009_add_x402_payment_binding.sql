ALTER TABLE request_payments ADD COLUMN pay_to TEXT;
ALTER TABLE request_payments ADD COLUMN payment_requirements_json TEXT;
ALTER TABLE request_payments ADD COLUMN payment_proof_fingerprint TEXT;

CREATE UNIQUE INDEX idx_request_payments_proof_fingerprint
  ON request_payments(payment_proof_fingerprint)
  WHERE payment_proof_fingerprint IS NOT NULL;

CREATE INDEX idx_request_payments_reconciliation
  ON request_payments(state, settled_at, updated_at);
