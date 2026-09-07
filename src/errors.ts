export type ClientErrorCode =
  | "invalid_json_body"
  | "unsupported_media_type"
  | "request_too_large"
  | "invalid_idempotency_key"
  | "missing_idempotency_key"
  | "malformed_payment_proof"
  | "invalid_payment_binding"
  | "missing_service_use_jurisdiction"
  | "invalid_service_use_jurisdiction"
  | "invalid_secondlook_request"
  | "invalid_constraint_context"
  | "invalid_outcome_request"
  | "decision_not_found"
  | "pilot_model_override_not_allowed"
  | "unsupported_model_override";

export type ModelResponseErrorCode =
  | "invalid_model_payload"
  | "missing_model_output"
  | "model_refusal"
  | "invalid_model_json"
  | "invalid_gate_schema"
  | "invalid_gate_object"
  | "invalid_clear_reason_consistency"
  | "invalid_material_unknown_consistency"
  | "invalid_review_status"
  | "invalid_reason"
  | "invalid_key_risks"
  | "invalid_missing_information";

export class ClientInputError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
    readonly status = 400,
    readonly errorName = "invalid_request",
  ) {
    super(message);
    this.name = "ClientInputError";
  }
}

export class ModelResponseError extends Error {
  constructor(
    readonly code: ModelResponseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelResponseError";
  }
}

export type CommercialEligibilityErrorCode =
  | "missing_service_use_jurisdiction"
  | "invalid_service_use_jurisdiction"
  | "service_region_unavailable";

export class CommercialEligibilityError extends Error {
  constructor(
    readonly code: CommercialEligibilityErrorCode,
    message: string,
    readonly status: 400 | 403,
    readonly category: "caller" | "access",
  ) {
    super(message);
    this.name = "CommercialEligibilityError";
  }
}

export type ServiceBoundaryErrorCode =
  | "service_disabled"
  | "rate_limit_reached"
  | "daily_request_limit_reached"
  | "inference_capacity_reached"
  | "daily_inference_limit_reached"
  | "financial_capacity_reached";

export class ServiceBoundaryError extends Error {
  constructor(
    readonly code: ServiceBoundaryErrorCode,
    message: string,
    readonly status: 429 | 503,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ServiceBoundaryError";
  }
}

export class ProviderFailureError extends Error {
  constructor(
    readonly code: "provider_timeout" | "provider_unavailable",
    readonly providerCause?: unknown,
  ) {
    super(code === "provider_timeout" ? "The model provider timed out." : "The model provider is unavailable.");
    this.name = "ProviderFailureError";
  }
}

export type IdempotencyLifecycleErrorCode =
  | "idempotency_key_conflict"
  | "idempotency_in_progress"
  | "idempotency_state_ambiguous";

export class IdempotencyLifecycleError extends Error {
  constructor(
    readonly code: IdempotencyLifecycleErrorCode,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(
      code === "idempotency_key_conflict"
        ? "The idempotency key is already bound to a different logical request."
        : code === "idempotency_in_progress"
          ? "The original request is still in progress."
          : "A prior inference may have occurred, but no replayable result is available.",
    );
    this.name = "IdempotencyLifecycleError";
  }
}

export type PaymentLifecycleErrorCode =
  | "payment_not_found"
  | "payment_requirement_conflict"
  | "payment_in_progress"
  | "payment_request_processing"
  | "payment_proof_conflict"
  | "payment_verification_unavailable"
  | "payment_failed"
  | "payment_ambiguous"
  | "payment_state_conflict";

export class PaymentLifecycleError extends Error {
  constructor(
    readonly code: PaymentLifecycleErrorCode,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "PaymentLifecycleError";
  }
}

export class PilotUsageLimitError extends Error {
  constructor() { super("Pilot review-attempt limit reached."); this.name = "PilotUsageLimitError"; }
}
