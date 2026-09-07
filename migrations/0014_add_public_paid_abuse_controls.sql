CREATE TABLE public_paid_service_control (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  new_settlement_enabled INTEGER NOT NULL DEFAULT 1 CHECK (new_settlement_enabled IN (0, 1)),
  max_daily_ambiguity_fulfillments INTEGER NOT NULL DEFAULT 3
    CHECK (max_daily_ambiguity_fulfillments > 0),
  max_unresolved_ambiguity_fulfillments_per_payer INTEGER NOT NULL DEFAULT 1
    CHECK (max_unresolved_ambiguity_fulfillments_per_payer > 0),
  facilitator_transport_failure_threshold INTEGER NOT NULL DEFAULT 3
    CHECK (facilitator_transport_failure_threshold > 0),
  consecutive_facilitator_transport_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_facilitator_transport_failures >= 0),
  last_facilitator_transport_failure_code TEXT,
  disabled_at TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO public_paid_service_control (
  singleton_id, new_settlement_enabled, max_daily_ambiguity_fulfillments,
  max_unresolved_ambiguity_fulfillments_per_payer,
  facilitator_transport_failure_threshold,
  consecutive_facilitator_transport_failures,
  last_facilitator_transport_failure_code, disabled_at, updated_at
) VALUES (1, 1, 3, 1, 3, 0, NULL, NULL, '2026-09-03T00:00:00.000Z');

CREATE INDEX idx_request_payments_ambiguity_payer
  ON request_payments(authorization_payer, state, request_id);

CREATE INDEX idx_payment_remediation_events_ambiguity_fulfillment
  ON payment_remediation_events(event_type, reason_code, occurred_at, request_id);
