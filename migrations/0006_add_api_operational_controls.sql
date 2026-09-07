CREATE TABLE api_service_control (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  inference_enabled INTEGER NOT NULL CHECK (inference_enabled IN (0, 1)),
  global_daily_inference_limit INTEGER NOT NULL CHECK (global_daily_inference_limit > 0),
  global_concurrent_inference_limit INTEGER NOT NULL CHECK (global_concurrent_inference_limit > 0),
  provider_failure_threshold INTEGER NOT NULL CHECK (provider_failure_threshold > 0),
  provider_circuit_seconds INTEGER NOT NULL CHECK (provider_circuit_seconds > 0),
  consecutive_provider_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_provider_failures >= 0),
  circuit_open_until INTEGER,
  updated_at TEXT NOT NULL
);

INSERT INTO api_service_control (
  singleton_id, inference_enabled, global_daily_inference_limit, global_concurrent_inference_limit,
  provider_failure_threshold, provider_circuit_seconds, consecutive_provider_failures, circuit_open_until, updated_at
) VALUES (1, 1, 250, 3, 3, 60, 0, NULL, '2026-08-28T00:00:00.000Z');

CREATE TABLE api_caller_usage (
  caller_key TEXT PRIMARY KEY,
  burst_window_start INTEGER NOT NULL,
  burst_count INTEGER NOT NULL CHECK (burst_count >= 0),
  minute_window_start INTEGER NOT NULL,
  minute_count INTEGER NOT NULL CHECK (minute_count >= 0),
  day_window_start TEXT NOT NULL,
  day_count INTEGER NOT NULL CHECK (day_count >= 0),
  last_request_at TEXT NOT NULL
);

CREATE TABLE api_global_usage (
  day TEXT PRIMARY KEY,
  inference_count INTEGER NOT NULL CHECK (inference_count >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE api_inference_leases (
  lease_id TEXT PRIMARY KEY,
  caller_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_api_inference_leases_expiry ON api_inference_leases(expires_at);
