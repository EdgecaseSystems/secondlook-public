CREATE TABLE idempotent_requests (
  request_id TEXT PRIMARY KEY,
  caller_key TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  execution_context TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'inference_running', 'completed', 'failed_before_inference', 'ambiguous')),
  owner_token TEXT,
  decision_id TEXT,
  response_json TEXT,
  failure_code TEXT,
  inference_started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (caller_key, idempotency_key_hash),
  FOREIGN KEY (decision_id) REFERENCES decisions(id)
);

CREATE INDEX idx_idempotent_requests_expiry ON idempotent_requests(expires_at);
CREATE INDEX idx_idempotent_requests_decision ON idempotent_requests(decision_id);
