CREATE TABLE pilot_api_keys (
  key_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  review_attempt_limit INTEGER NOT NULL CHECK (review_attempt_limit >= 0),
  review_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (review_attempt_count >= 0)
);

ALTER TABLE decisions ADD COLUMN pilot_customer_id TEXT;
ALTER TABLE decisions ADD COLUMN pilot_project_id TEXT;
ALTER TABLE decisions ADD COLUMN pilot_api_key_id TEXT;
ALTER TABLE outcomes ADD COLUMN pilot_customer_id TEXT;
ALTER TABLE outcomes ADD COLUMN pilot_project_id TEXT;
ALTER TABLE outcomes ADD COLUMN pilot_api_key_id TEXT;

CREATE INDEX idx_pilot_api_keys_customer_project ON pilot_api_keys(customer_id, project_id);
CREATE INDEX idx_decisions_pilot_ownership ON decisions(pilot_customer_id, pilot_project_id);
CREATE INDEX idx_outcomes_pilot_ownership ON outcomes(pilot_customer_id, pilot_project_id);
