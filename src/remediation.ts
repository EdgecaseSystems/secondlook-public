import type { AppEnv } from "./types";
import { X402_BASE_MAINNET } from "./x402";

export type RemediationCaseKind = "payment_ambiguity" | "paid_fulfillment";
export type ReconciliationStatus = "not_required" | "pending" | "confirmed_paid" | "confirmed_not_paid" | "unresolved";
export type FulfillmentStatus = "not_started" | "recovery_available" | "completed" | "inference_ambiguous" | "unavailable";
export type RemediationStatus =
  | "none"
  | "refund_review_required"
  | "refund_approved"
  | "refund_submitted"
  | "refund_confirmed"
  | "refund_failed"
  | "closed_without_refund";

type ReconciliationEvidenceFields = {
  source: "base_receipt" | "base_authorization_cancellation" | "base_log_search";
  evidenceFingerprint: string;
  network: string;
  asset?: string;
  transactionReference?: string;
  blockNumber?: number;
  blockHash?: string;
  payer?: string;
  recipient?: string;
  amountAtomic?: string;
  authorizationLogIndex?: number;
  transferLogIndex?: number;
  reasonCode: string;
};

export type ReconciliationEvidence = ReconciliationEvidenceFields & (
  | { classification: "confirmed_paid" | "confirmed_not_paid"; authorizationNonce: string }
  | { classification: "unresolved"; authorizationNonce?: undefined }
);

export type ValidatedRefundEvidence = {
  outcome: "confirmed" | "failed";
  source: "base_receipt";
  evidenceFingerprint: string;
  network: string;
  asset: string;
  transactionReference: string;
  blockNumber?: number;
  payer: string;
  recipient: string;
  amountAtomic: string;
  reasonCode: string;
};

export type RemediationCase = {
  case_id: string;
  request_id: string;
  case_kind: RemediationCaseKind;
  network: string;
  asset: string;
  amount_atomic: string;
  seller_recipient: string;
  facilitator_identifier: string;
  commercial_configuration_fingerprint: string;
  authorization_payer: string | null;
  authorization_nonce: string | null;
  facilitator_verified_payer: string | null;
  chain_confirmed_payer: string | null;
  original_transaction_reference: string | null;
  reconciled_transaction_reference: string | null;
  reconciliation_status: ReconciliationStatus;
  fulfillment_status: FulfillmentStatus;
  remediation_status: RemediationStatus;
  refund_recipient: string | null;
  refund_transaction_reference: string | null;
  opened_at: string;
  updated_at: string;
  closed_at: string | null;
};

type CaseFacts = {
  request_id: string;
  network: string;
  asset: string;
  amount_atomic: string;
  pay_to: string;
  facilitator: string;
  configuration_fingerprint: string;
  payment_state: string;
  authorization_payer: string | null;
  authorization_nonce: string | null;
  payer_identity: string | null;
  external_reference: string | null;
  lifecycle_state: string | null;
};

type EventInput = {
  eventType: string;
  actorKind: "system" | "operator";
  operationId: string;
  occurredAt: string;
  reasonCode?: string;
  reconciliationSource?: string;
  evidenceFingerprint?: string;
  network?: string;
  transactionReference?: string;
  blockNumber?: number;
  payer?: string;
  recipient?: string;
  amountAtomic?: string;
};

const METADATA_MAX = 256;
const OPERATION_ID_MAX = 128;

export class RemediationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemediationStateError";
  }
}

function validateBounded(value: string, label: string, maximum = METADATA_MAX): void {
  if (value.length === 0 || value.length > maximum) throw new RemediationStateError(`${label} must be 1-${maximum} characters.`);
}

function validateOperationId(value: string): void {
  validateBounded(value, "Operation ID", OPERATION_ID_MAX);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) throw new RemediationStateError("Operation ID contains unsupported characters.");
}

function validateAddress(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new RemediationStateError(`${label} must be an EVM address.`);
  return value.toLowerCase();
}

function validateTransactionReference(value: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new RemediationStateError("Transaction reference must be a 32-byte EVM hash.");
  return value.toLowerCase();
}

function validateAuthorizationNonce(value: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new RemediationStateError("Authorization nonce must be 32-byte hex.");
  return value.toLowerCase();
}

function validateBytes32(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new RemediationStateError(`${label} must be 32-byte hex.`);
  return value.toLowerCase();
}

function validateEvidenceFingerprint(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new RemediationStateError("Evidence fingerprint must be lowercase SHA-256 hex.");
}

function validateEvidenceBlock(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RemediationStateError("Evidence block number must be a safe nonnegative integer.");
  }
}

function validateEvidenceLogIndex(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new RemediationStateError(`${label} must be a safe nonnegative integer.`);
  }
  return value;
}

function validateAtomic(value: string, label: string): void {
  if (!/^[1-9][0-9]*$/.test(value)) throw new RemediationStateError(`${label} must be a canonical positive integer.`);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function terminalReconciliationProjection(evidence: ReconciliationEvidence): Record<string, unknown> {
  if (evidence.classification === "unresolved") {
    throw new RemediationStateError("Terminal reconciliation fingerprint requires a terminal classification.");
  }
  const common = {
    classification: evidence.classification,
    source: evidence.source,
    reasonCode: evidence.reasonCode,
    network: evidence.network,
    asset: validateAddress(evidence.asset ?? "", "Evidence asset"),
    authorizationPayer: validateAddress(evidence.payer ?? "", "Evidence payer"),
    authorizationNonce: validateAuthorizationNonce(evidence.authorizationNonce),
    transactionReference: validateTransactionReference(evidence.transactionReference ?? ""),
    blockNumber: evidence.blockNumber,
    ...(evidence.blockHash !== undefined ? { blockHash: validateBytes32(evidence.blockHash, "Evidence block hash") } : {}),
    authorizationLogIndex: validateEvidenceLogIndex(evidence.authorizationLogIndex, "Authorization log index"),
  };
  validateEvidenceBlock(common.blockNumber);
  if (common.blockNumber === undefined) throw new RemediationStateError("Terminal reconciliation evidence requires a confirmed block.");
  if (evidence.classification === "confirmed_paid") {
    const amountAtomic = evidence.amountAtomic ?? "";
    validateAtomic(amountAtomic, "Evidence amount");
    return {
      ...common,
      sellerRecipient: validateAddress(evidence.recipient ?? "", "Evidence recipient"),
      amountAtomic,
      transferLogIndex: validateEvidenceLogIndex(evidence.transferLogIndex, "Transfer log index"),
    };
  }
  return common;
}

export async function deriveTerminalReconciliationFingerprint(evidence: ReconciliationEvidence): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(terminalReconciliationProjection(evidence))));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requireMatchingTerminalFingerprint(evidence: ReconciliationEvidence): Promise<string> {
  const derived = await deriveTerminalReconciliationFingerprint(evidence);
  if (evidence.evidenceFingerprint !== derived) {
    throw new RemediationStateError("Evidence fingerprint does not match the normalized terminal evidence.");
  }
  return derived;
}

function caseId(requestId: string): string {
  return `remediation:${requestId}`;
}

function systemOperation(requestId: string, eventType: string): string {
  return `system:${requestId}:${eventType}`;
}

async function readCaseFacts(env: AppEnv, requestId: string): Promise<CaseFacts | null> {
  return env.DB.prepare(
    `SELECT exposure.request_id, exposure.network, exposure.asset, exposure.amount_atomic,
      exposure.pay_to, exposure.facilitator, exposure.configuration_fingerprint,
      payment.state AS payment_state, payment.authorization_payer, payment.authorization_nonce,
      payment.payer_identity, payment.external_reference, lifecycle.state AS lifecycle_state
     FROM commercial_payment_exposures exposure
     JOIN request_payments payment ON payment.request_id = exposure.request_id
     LEFT JOIN idempotent_requests lifecycle ON lifecycle.request_id = exposure.request_id
     WHERE exposure.request_id = ?`,
  ).bind(requestId).first<CaseFacts>();
}

export async function readRemediationCase(env: AppEnv, requestId: string): Promise<RemediationCase | null> {
  return env.DB.prepare(
    `SELECT case_id, request_id, case_kind, network, asset, amount_atomic, seller_recipient,
      facilitator_identifier, commercial_configuration_fingerprint, authorization_payer,
      authorization_nonce, facilitator_verified_payer, chain_confirmed_payer,
      original_transaction_reference, reconciled_transaction_reference,
      reconciliation_status, fulfillment_status, remediation_status, refund_recipient,
      refund_transaction_reference, opened_at, updated_at, closed_at
     FROM payment_remediation_cases WHERE request_id = ?`,
  ).bind(requestId).first<RemediationCase>();
}

async function appendEvent(env: AppEnv, remediationCase: RemediationCase, input: EventInput): Promise<void> {
  validateOperationId(input.operationId);
  validateBounded(input.eventType, "Event type", 64);
  if (input.reasonCode) validateBounded(input.reasonCode, "Reason code", 128);
  if (input.reconciliationSource) validateBounded(input.reconciliationSource, "Reconciliation source", 64);
  if (input.evidenceFingerprint && !/^[0-9a-f]{64}$/.test(input.evidenceFingerprint)) {
    throw new RemediationStateError("Evidence fingerprint must be lowercase SHA-256 hex.");
  }
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO payment_remediation_events (
      event_id, case_id, request_id, event_type, occurred_at, actor_kind, reason_code,
      reconciliation_source, evidence_fingerprint, network, transaction_reference,
      block_number, payer, recipient, amount_atomic, operation_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), remediationCase.case_id, remediationCase.request_id, input.eventType,
    input.occurredAt, input.actorKind, input.reasonCode ?? null,
    input.reconciliationSource ?? null, input.evidenceFingerprint ?? null,
    input.network ?? null, input.transactionReference ?? null, input.blockNumber ?? null,
    input.payer ?? null, input.recipient ?? null, input.amountAtomic ?? null,
    input.operationId, new Date().toISOString(),
  ).run();
  if (result.meta.changes === 1) return;
  const existing = await env.DB.prepare(
    "SELECT case_id, request_id, event_type FROM payment_remediation_events WHERE operation_id = ?",
  ).bind(input.operationId).first<{ case_id: string; request_id: string; event_type: string }>();
  if (!existing || existing.case_id !== remediationCase.case_id || existing.request_id !== remediationCase.request_id || existing.event_type !== input.eventType) {
    throw new RemediationStateError("Remediation operation ID conflicts with another event.");
  }
}

async function operationAlreadyRecorded(
  env: AppEnv,
  requestId: string,
  operationId: string,
  eventType: string,
): Promise<boolean> {
  validateOperationId(operationId);
  const existing = await env.DB.prepare(
    "SELECT request_id, event_type FROM payment_remediation_events WHERE operation_id = ?",
  ).bind(operationId).first<{ request_id: string; event_type: string }>();
  if (!existing) return false;
  if (existing.request_id !== requestId || existing.event_type !== eventType) {
    throw new RemediationStateError("Remediation operation ID conflicts with another event.");
  }
  return true;
}

async function ensureCase(
  env: AppEnv,
  facts: CaseFacts,
  kind: RemediationCaseKind,
  reconciliationStatus: ReconciliationStatus,
  fulfillmentStatus: FulfillmentStatus,
  remediationStatus: RemediationStatus,
  now: Date,
): Promise<RemediationCase> {
  const timestamp = now.toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO payment_remediation_cases (
      case_id, request_id, case_kind, network, asset, amount_atomic, seller_recipient,
      facilitator_identifier, commercial_configuration_fingerprint, authorization_payer,
      authorization_nonce, facilitator_verified_payer, original_transaction_reference,
      reconciliation_status, fulfillment_status, remediation_status, opened_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    caseId(facts.request_id), facts.request_id, kind, facts.network, facts.asset,
    facts.amount_atomic, facts.pay_to, facts.facilitator, facts.configuration_fingerprint,
    facts.authorization_payer, facts.authorization_nonce, facts.payer_identity,
    facts.external_reference, reconciliationStatus, fulfillmentStatus, remediationStatus,
    timestamp, timestamp,
  ).run();
  const current = await readRemediationCase(env, facts.request_id);
  if (!current || current.case_kind !== kind) throw new RemediationStateError("Remediation case identity conflicts with durable state.");
  await appendEvent(env, current, {
    eventType: "case_opened",
    actorKind: "system",
    operationId: systemOperation(facts.request_id, "case_opened"),
    occurredAt: current.opened_at,
  });
  return current;
}

async function appendSystemStatusEvent(
  env: AppEnv,
  remediationCase: RemediationCase,
  eventType: string,
  now: Date,
  reasonCode?: string,
): Promise<void> {
  await appendEvent(env, remediationCase, {
    eventType,
    actorKind: "system",
    operationId: systemOperation(remediationCase.request_id, eventType),
    occurredAt: now.toISOString(),
    reasonCode,
  });
}

export async function ensurePaymentAmbiguityCase(env: AppEnv, requestId: string, now = new Date()): Promise<void> {
  const facts = await readCaseFacts(env, requestId);
  if (!facts) return;
  if (facts.payment_state !== "ambiguous") throw new RemediationStateError("Payment ambiguity case requires historical ambiguous payment state.");
  await ensureCase(env, facts, "payment_ambiguity", "pending", "not_started", "none", now);
}

export async function authorizePublicMainnetAmbiguityFulfillment(
  env: AppEnv,
  requestId: string,
  now = new Date(),
): Promise<boolean> {
  const timestamp = now.toISOString();
  const dayStart = `${timestamp.slice(0, 10)}T00:00:00.000Z`;
  const dayEnd = new Date(Date.parse(dayStart) + 86_400_000).toISOString();
  const eligible = await env.DB.prepare(
    `SELECT 1 AS present FROM payment_remediation_cases remediation
     JOIN request_payments payment ON payment.request_id = remediation.request_id
     JOIN commercial_payment_exposures exposure ON exposure.request_id = remediation.request_id
     WHERE remediation.request_id = ? AND remediation.case_kind = 'payment_ambiguity'
       AND remediation.fulfillment_status IN ('not_started', 'recovery_available')
       AND remediation.reconciliation_status IN ('pending', 'unresolved')
       AND remediation.remediation_status = 'none'
       AND payment.state = 'ambiguous' AND payment.failure_code <> 'public_paid_safety_control_unavailable'
       AND exposure.state = 'ambiguous'
       AND remediation.network = ?
       AND payment.network = remediation.network AND exposure.network = remediation.network
       AND payment.asset = remediation.asset AND exposure.asset = remediation.asset
       AND payment.amount_atomic = remediation.amount_atomic AND exposure.amount_atomic = remediation.amount_atomic
       AND payment.pay_to = remediation.seller_recipient AND exposure.pay_to = remediation.seller_recipient
       AND exposure.public_commercial_policy_version IS NOT NULL`,
  ).bind(requestId, X402_BASE_MAINNET).first<{ present: number }>();
  if (eligible?.present !== 1) return false;
  const operationId = systemOperation(requestId, "fulfillment_recovery_available");
  const results = await env.DB.batch([
    env.DB.prepare(
    `UPDATE payment_remediation_cases SET fulfillment_status = 'recovery_available', updated_at = ?
     WHERE request_id = ? AND case_kind = 'payment_ambiguity'
       AND fulfillment_status IN ('not_started', 'recovery_available')
       AND reconciliation_status IN ('pending', 'unresolved')
       AND remediation_status = 'none'
       AND network = ?
       AND EXISTS (
         SELECT 1 FROM request_payments payment
         JOIN commercial_payment_exposures exposure ON exposure.request_id = payment.request_id
         WHERE payment.request_id = ? AND payment.state = 'ambiguous'
           AND payment.failure_code <> 'public_paid_safety_control_unavailable'
           AND exposure.state = 'ambiguous'
           AND payment.network = payment_remediation_cases.network
           AND exposure.network = payment_remediation_cases.network
           AND payment.asset = payment_remediation_cases.asset
           AND exposure.asset = payment_remediation_cases.asset
           AND payment.amount_atomic = payment_remediation_cases.amount_atomic
           AND exposure.amount_atomic = payment_remediation_cases.amount_atomic
           AND payment.pay_to = payment_remediation_cases.seller_recipient
           AND exposure.pay_to = payment_remediation_cases.seller_recipient
           AND payment.authorization_payer IS NOT NULL
           AND exposure.public_commercial_policy_version IS NOT NULL
       )
       AND EXISTS (
         SELECT 1 FROM public_paid_service_control control
         WHERE control.singleton_id = 1 AND control.new_settlement_enabled = 1
           AND (
             SELECT COUNT(*) FROM payment_remediation_events daily_event
             WHERE daily_event.event_type = 'fulfillment_recovery_available'
               AND daily_event.reason_code = 'public_mainnet_ambiguity_honored'
               AND daily_event.occurred_at >= ? AND daily_event.occurred_at < ?
           ) < control.max_daily_ambiguity_fulfillments
           AND (
             SELECT COUNT(*)
             FROM payment_remediation_events prior_event
             JOIN payment_remediation_cases prior_case ON prior_case.request_id = prior_event.request_id
             JOIN request_payments prior_payment ON prior_payment.request_id = prior_event.request_id
             JOIN request_payments current_payment ON current_payment.request_id = ?
             WHERE prior_event.event_type = 'fulfillment_recovery_available'
               AND prior_event.reason_code = 'public_mainnet_ambiguity_honored'
               AND prior_event.request_id <> ?
               AND prior_case.case_kind = 'payment_ambiguity'
               AND prior_case.reconciliation_status IN ('pending', 'unresolved')
               AND prior_payment.state = 'ambiguous'
               AND prior_payment.authorization_payer = current_payment.authorization_payer
           ) < control.max_unresolved_ambiguity_fulfillments_per_payer
       )`,
    ).bind(timestamp, requestId, X402_BASE_MAINNET, requestId, dayStart, dayEnd, requestId, requestId),
    env.DB.prepare(
    `INSERT OR IGNORE INTO payment_remediation_events (
       event_id, case_id, request_id, event_type, occurred_at, actor_kind, reason_code,
       operation_id, created_at
     ) SELECT ?, case_id, request_id, 'fulfillment_recovery_available', ?, 'system',
       'public_mainnet_ambiguity_honored', ?, ?
       FROM payment_remediation_cases
       WHERE request_id = ? AND fulfillment_status = 'recovery_available'`,
    ).bind(crypto.randomUUID(), timestamp, operationId, timestamp, requestId),
  ]);
  if (results[0]?.meta.changes !== 1) return false;
  const event = await env.DB.prepare(
    `SELECT 1 AS present FROM payment_remediation_events
     WHERE request_id = ? AND event_type = 'fulfillment_recovery_available'
       AND reason_code = 'public_mainnet_ambiguity_honored' AND operation_id = ?`,
  ).bind(requestId, operationId).first<{ present: number }>();
  return event?.present === 1;
}

export async function isCompletedPublicMainnetAmbiguityFulfillment(env: AppEnv, requestId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS present FROM payment_remediation_cases remediation
     JOIN commercial_payment_exposures exposure ON exposure.request_id = remediation.request_id
     JOIN request_payments payment ON payment.request_id = remediation.request_id
     WHERE remediation.request_id = ? AND remediation.case_kind = 'payment_ambiguity'
       AND remediation.fulfillment_status = 'completed'
       AND remediation.network = ?
       AND payment.network = remediation.network AND exposure.network = remediation.network
       AND payment.asset = remediation.asset AND exposure.asset = remediation.asset
       AND payment.amount_atomic = remediation.amount_atomic AND exposure.amount_atomic = remediation.amount_atomic
       AND payment.pay_to = remediation.seller_recipient AND exposure.pay_to = remediation.seller_recipient
       AND exposure.public_commercial_policy_version IS NOT NULL
       AND payment.state = 'ambiguous'
       AND EXISTS (SELECT 1 FROM payment_remediation_events event
         WHERE event.request_id = remediation.request_id
           AND event.event_type = 'fulfillment_recovery_available'
           AND event.reason_code = 'public_mainnet_ambiguity_honored')`,
  ).bind(requestId, X402_BASE_MAINNET).first<{ present: number }>();
  return row?.present === 1;
}

export async function markPublicMainnetAmbiguityInferenceUncertain(
  env: AppEnv,
  requestId: string,
  now = new Date(),
): Promise<void> {
  const timestamp = now.toISOString();
  const updated = await env.DB.prepare(
    `UPDATE payment_remediation_cases SET fulfillment_status = 'inference_ambiguous',
       remediation_status = 'refund_review_required', updated_at = ?
     WHERE request_id = ? AND case_kind = 'payment_ambiguity'
       AND fulfillment_status = 'recovery_available'`,
  ).bind(timestamp, requestId).run();
  if (updated.meta.changes !== 1) return;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO payment_remediation_events (
       event_id, case_id, request_id, event_type, occurred_at, actor_kind, reason_code,
       operation_id, created_at
     ) SELECT ?, case_id, request_id, 'inference_ambiguous', ?, 'system',
       'ambiguity_honor_inference_uncertain', ?, ?
       FROM payment_remediation_cases WHERE request_id = ?`,
  ).bind(
    crypto.randomUUID(), timestamp,
    systemOperation(requestId, "inference_ambiguous"), timestamp, requestId,
  ).run();
}

export async function ensurePaidFulfillmentCase(
  env: AppEnv,
  requestId: string,
  fulfillmentStatus: "recovery_available" | "inference_ambiguous" | "unavailable",
  now = new Date(),
): Promise<void> {
  const facts = await readCaseFacts(env, requestId);
  if (!facts) return;
  if (facts.payment_state !== "accepted") throw new RemediationStateError("Paid fulfillment case requires accepted payment.");
  const desiredRemediation = fulfillmentStatus === "recovery_available" ? "none" : "refund_review_required";
  let current = await ensureCase(env, facts, "paid_fulfillment", "not_required", fulfillmentStatus, desiredRemediation, now);
  const updated = await env.DB.prepare(
    `UPDATE payment_remediation_cases SET fulfillment_status = ?,
      remediation_status = CASE WHEN remediation_status = 'none' THEN ? ELSE remediation_status END,
      updated_at = ?, closed_at = NULL
     WHERE request_id = ? AND case_kind = 'paid_fulfillment'
       AND (
         fulfillment_status = ?
         OR (fulfillment_status = 'recovery_available' AND ? IN ('inference_ambiguous', 'unavailable'))
         OR (fulfillment_status = 'inference_ambiguous' AND ? = 'unavailable')
       )`,
  ).bind(
    fulfillmentStatus,
    desiredRemediation,
    now.toISOString(),
    requestId,
    fulfillmentStatus,
    fulfillmentStatus,
    fulfillmentStatus,
  ).run();
  if (updated.meta.changes === 1) current = (await readRemediationCase(env, requestId)) ?? current;
  if (current.fulfillment_status !== fulfillmentStatus) return;
  const eventType = fulfillmentStatus === "recovery_available"
    ? "fulfillment_recovery_available"
    : fulfillmentStatus === "unavailable"
      ? "fulfillment_unavailable"
      : "inference_ambiguous";
  await appendSystemStatusEvent(env, current, eventType, now);
  if (desiredRemediation === "refund_review_required") {
    await appendSystemStatusEvent(env, current, "refund_review_required", now, "paid_inference_unavailable");
  }
}

export async function synchronizeCompletedFulfillment(env: AppEnv, requestId: string, now = new Date()): Promise<void> {
  const current = await readRemediationCase(env, requestId);
  if (!current) return;
  const completed = await env.DB.prepare(
    `UPDATE payment_remediation_cases SET fulfillment_status = 'completed',
      remediation_status = CASE
        WHEN case_kind = 'paid_fulfillment' AND remediation_status IN ('none', 'refund_review_required') THEN 'closed_without_refund'
        WHEN case_kind = 'payment_ambiguity' AND reconciliation_status = 'confirmed_paid'
          AND remediation_status IN ('none', 'refund_review_required') THEN 'closed_without_refund'
        ELSE remediation_status
      END,
      closed_at = CASE
        WHEN case_kind = 'paid_fulfillment' AND remediation_status IN ('none', 'refund_review_required') THEN ?
        WHEN case_kind = 'payment_ambiguity' AND reconciliation_status = 'confirmed_paid'
          AND remediation_status IN ('none', 'refund_review_required') THEN ?
        ELSE closed_at
      END,
      updated_at = ?
     WHERE request_id = ? AND EXISTS (
       SELECT 1 FROM idempotent_requests WHERE request_id = ? AND state = 'completed'
     )`,
  ).bind(now.toISOString(), now.toISOString(), now.toISOString(), requestId, requestId).run();
  if (completed.meta.changes !== 1) return;
  const refreshed = (await readRemediationCase(env, requestId))!;
  await appendSystemStatusEvent(env, refreshed, "fulfillment_completed", now);
  if (refreshed.remediation_status === "closed_without_refund") {
    await appendSystemStatusEvent(env, refreshed, "closed_without_refund", now, "durable_fulfillment_completed");
  }
}

export async function preserveRemediationBeforeExpiredLifecycleDeletion(
  env: AppEnv,
  cutoffEpochSeconds: number,
  now = new Date(),
): Promise<void> {
  const timestamp = now.toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO payment_remediation_cases (
      case_id, request_id, case_kind, network, asset, amount_atomic, seller_recipient,
      facilitator_identifier, commercial_configuration_fingerprint, authorization_payer,
      authorization_nonce, facilitator_verified_payer, original_transaction_reference,
      reconciliation_status, fulfillment_status, remediation_status, opened_at, updated_at
    )
    SELECT 'remediation:' || lifecycle.request_id, lifecycle.request_id,
      CASE WHEN payment.state = 'ambiguous' THEN 'payment_ambiguity' ELSE 'paid_fulfillment' END,
      exposure.network, exposure.asset, exposure.amount_atomic, exposure.pay_to,
      exposure.facilitator, exposure.configuration_fingerprint, payment.authorization_payer,
      payment.authorization_nonce, payment.payer_identity, payment.external_reference,
      CASE WHEN payment.state = 'ambiguous' THEN 'pending' ELSE 'not_required' END,
      CASE
        WHEN payment.state = 'ambiguous' THEN 'not_started'
        WHEN lifecycle.state IN ('inference_running', 'ambiguous') THEN 'inference_ambiguous'
        ELSE 'recovery_available'
      END,
      CASE
        WHEN payment.state = 'accepted' AND lifecycle.state IN ('inference_running', 'ambiguous') THEN 'refund_review_required'
        ELSE 'none'
      END,
      ?, ?
    FROM idempotent_requests lifecycle
    JOIN request_payments payment ON payment.request_id = lifecycle.request_id
    JOIN commercial_payment_exposures exposure ON exposure.request_id = lifecycle.request_id
    WHERE lifecycle.expires_at <= ? AND lifecycle.state <> 'completed'
      AND payment.state IN ('accepted', 'ambiguous')`,
  ).bind(timestamp, timestamp, cutoffEpochSeconds).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO payment_remediation_events (
      event_id, case_id, request_id, event_type, occurred_at, actor_kind, operation_id, created_at
    )
    SELECT 'event:' || cases.case_id || ':case_opened', cases.case_id, cases.request_id,
      'case_opened', cases.opened_at, 'system',
      'system:' || cases.request_id || ':case_opened', ?
    FROM payment_remediation_cases cases
    WHERE NOT EXISTS (
      SELECT 1 FROM payment_remediation_events events
      WHERE events.operation_id = 'system:' || cases.request_id || ':case_opened'
    )`,
  ).bind(timestamp).run();
}

export async function recordPaymentReconciliation(
  env: AppEnv,
  requestId: string,
  evidence: ReconciliationEvidence,
  operationId: string,
  now = new Date(),
): Promise<void> {
  const eventType = evidence.classification === "confirmed_paid"
    ? "reconciliation_confirmed_paid"
    : evidence.classification === "confirmed_not_paid"
      ? "reconciliation_confirmed_not_paid"
      : "reconciliation_unresolved";
  validateBounded(evidence.reasonCode, "Reason code", 128);
  validateEvidenceFingerprint(evidence.evidenceFingerprint);
  validateEvidenceBlock(evidence.blockNumber);
  if (await operationAlreadyRecorded(env, requestId, operationId, eventType)) return;
  const current = await readRemediationCase(env, requestId);
  if (!current || current.case_kind !== "payment_ambiguity") throw new RemediationStateError("Payment reconciliation requires an ambiguity case.");
  if (evidence.network !== current.network) throw new RemediationStateError("Reconciliation evidence network does not match the case.");
  let terminalFingerprint: string | undefined;
  if (evidence.classification === "confirmed_paid") {
    if (evidence.source !== "base_receipt" || !evidence.asset || !evidence.payer || !evidence.authorizationNonce || !evidence.recipient || !evidence.amountAtomic || !evidence.transactionReference || evidence.blockNumber === undefined) {
      throw new RemediationStateError("Confirmed payment evidence requires a complete validated Base receipt.");
    }
    const evidenceAsset = validateAddress(evidence.asset, "Evidence asset");
    const payer = validateAddress(evidence.payer, "Chain-confirmed payer");
    const authorizationNonce = validateAuthorizationNonce(evidence.authorizationNonce);
    const recipient = validateAddress(evidence.recipient, "Evidence recipient");
    validateAtomic(evidence.amountAtomic, "Evidence amount");
    const transaction = validateTransactionReference(evidence.transactionReference);
    if (
      !current.authorization_payer || !current.authorization_nonce ||
      payer !== current.authorization_payer.toLowerCase() || authorizationNonce !== current.authorization_nonce.toLowerCase() ||
      evidenceAsset !== current.asset.toLowerCase() || recipient !== current.seller_recipient.toLowerCase() ||
      evidence.amountAtomic !== current.amount_atomic
    ) {
      throw new RemediationStateError("Confirmed payment evidence does not match the durable payment facts.");
    }
    terminalFingerprint = await requireMatchingTerminalFingerprint(evidence);
    await env.DB.prepare(
      `UPDATE payment_remediation_cases SET reconciliation_status = 'confirmed_paid',
        chain_confirmed_payer = ?, reconciled_transaction_reference = ?,
        remediation_status = CASE WHEN fulfillment_status = 'completed' THEN 'closed_without_refund' ELSE 'refund_review_required' END,
        closed_at = CASE WHEN fulfillment_status = 'completed' THEN ? ELSE NULL END,
        updated_at = ?
       WHERE request_id = ? AND case_kind = 'payment_ambiguity'
         AND reconciliation_status IN ('pending', 'unresolved', 'confirmed_paid')`,
    ).bind(payer, transaction, now.toISOString(), now.toISOString(), requestId).run();
  } else if (evidence.classification === "confirmed_not_paid") {
    if (
      evidence.source !== "base_authorization_cancellation" || !evidence.asset || !evidence.payer ||
      !evidence.authorizationNonce || !evidence.transactionReference || evidence.blockNumber === undefined
    ) throw new RemediationStateError("Confirmed nonpayment requires a complete validated authorization cancellation receipt.");
    const evidenceAsset = validateAddress(evidence.asset, "Evidence asset");
    const payer = validateAddress(evidence.payer, "Cancellation payer");
    const authorizationNonce = validateAuthorizationNonce(evidence.authorizationNonce);
    if (
      !current.authorization_payer || !current.authorization_nonce ||
      payer !== current.authorization_payer.toLowerCase() || authorizationNonce !== current.authorization_nonce.toLowerCase() ||
      evidenceAsset !== current.asset.toLowerCase()
    ) throw new RemediationStateError("Cancellation evidence does not match the durable authorization facts.");
    terminalFingerprint = await requireMatchingTerminalFingerprint(evidence);
    await env.DB.prepare(
      `UPDATE payment_remediation_cases SET reconciliation_status = 'confirmed_not_paid',
        reconciled_transaction_reference = ?, remediation_status = 'closed_without_refund',
        closed_at = ?, updated_at = ?
       WHERE request_id = ? AND case_kind = 'payment_ambiguity'
         AND reconciliation_status IN ('pending', 'unresolved', 'confirmed_not_paid')`,
    ).bind(evidence.transactionReference ? validateTransactionReference(evidence.transactionReference) : null,
      now.toISOString(), now.toISOString(), requestId).run();
  } else {
    await env.DB.prepare(
      `UPDATE payment_remediation_cases SET reconciliation_status = 'unresolved', updated_at = ?
       WHERE request_id = ? AND case_kind = 'payment_ambiguity'
         AND reconciliation_status IN ('pending', 'unresolved')`,
    ).bind(now.toISOString(), requestId).run();
  }
  const refreshed = await readRemediationCase(env, requestId);
  if (!refreshed || refreshed.reconciliation_status !== evidence.classification) {
    throw new RemediationStateError("Reconciliation transition conflicts with current case state.");
  }
  await appendEvent(env, refreshed, {
    eventType,
    actorKind: "operator",
    operationId,
    occurredAt: now.toISOString(),
    reasonCode: evidence.reasonCode,
    reconciliationSource: evidence.source,
    evidenceFingerprint: terminalFingerprint ?? evidence.evidenceFingerprint,
    network: evidence.network,
    transactionReference: evidence.transactionReference,
    blockNumber: evidence.blockNumber,
    payer: evidence.payer,
    recipient: evidence.recipient,
    amountAtomic: evidence.amountAtomic,
  });
  if (refreshed.remediation_status === "refund_review_required") {
    await appendSystemStatusEvent(env, refreshed, "refund_review_required", now, "confirmed_paid_without_fulfillment");
  } else if (refreshed.remediation_status === "closed_without_refund") {
    await appendSystemStatusEvent(env, refreshed, "closed_without_refund", now, "confirmed_not_paid");
  }
}

export async function markRefundReviewRequired(
  env: AppEnv,
  requestId: string,
  operationId: string,
  reasonCode: string,
  now = new Date(),
): Promise<void> {
  validateBounded(reasonCode, "Reason code", 128);
  if (await operationAlreadyRecorded(env, requestId, operationId, "refund_review_required")) return;
  const result = await env.DB.prepare(
    `UPDATE payment_remediation_cases SET remediation_status = 'refund_review_required',
      closed_at = NULL, updated_at = ?
     WHERE request_id = ? AND remediation_status = 'none'
       AND reconciliation_status <> 'confirmed_not_paid' AND fulfillment_status <> 'completed'`,
  ).bind(now.toISOString(), requestId).run();
  const current = await readRemediationCase(env, requestId);
  if (result.meta.changes !== 1 && current?.remediation_status !== "refund_review_required") {
    throw new RemediationStateError("Refund review is not valid from the current case state.");
  }
  await appendEvent(env, current!, {
    eventType: "refund_review_required", actorKind: "operator", operationId,
    occurredAt: now.toISOString(), reasonCode,
  });
}

function trustedRefundRecipient(remediationCase: RemediationCase): string {
  if (remediationCase.case_kind === "paid_fulfillment" && remediationCase.facilitator_verified_payer) {
    return validateAddress(remediationCase.facilitator_verified_payer, "Facilitator-verified payer");
  }
  if (remediationCase.reconciliation_status === "confirmed_paid" && remediationCase.chain_confirmed_payer) {
    return validateAddress(remediationCase.chain_confirmed_payer, "Chain-confirmed payer");
  }
  throw new RemediationStateError("No trusted payer evidence is available for a refund recipient.");
}

export async function approveRefund(env: AppEnv, requestId: string, operationId: string, reasonCode: string, now = new Date()): Promise<void> {
  validateBounded(reasonCode, "Reason code", 128);
  if (await operationAlreadyRecorded(env, requestId, operationId, "refund_approved")) return;
  const current = await readRemediationCase(env, requestId);
  if (!current) throw new RemediationStateError("Remediation case not found.");
  const recipient = trustedRefundRecipient(current);
  const result = await env.DB.prepare(
    `UPDATE payment_remediation_cases SET remediation_status = 'refund_approved',
      refund_recipient = ?, refund_transaction_reference = NULL, closed_at = NULL, updated_at = ?
     WHERE request_id = ? AND remediation_status IN ('refund_review_required', 'refund_failed')`,
  ).bind(recipient, now.toISOString(), requestId).run();
  const refreshed = await readRemediationCase(env, requestId);
  if (result.meta.changes !== 1 && refreshed?.remediation_status !== "refund_approved") {
    throw new RemediationStateError("Refund approval is not valid from the current case state.");
  }
  await appendEvent(env, refreshed!, {
    eventType: "refund_approved", actorKind: "operator", operationId,
    occurredAt: now.toISOString(), reasonCode, network: refreshed!.network,
    payer: refreshed!.seller_recipient, recipient, amountAtomic: refreshed!.amount_atomic,
  });
}

export async function recordRefundSubmitted(
  env: AppEnv,
  requestId: string,
  transactionReference: string,
  operationId: string,
  now = new Date(),
): Promise<void> {
  if (await operationAlreadyRecorded(env, requestId, operationId, "refund_submitted")) return;
  const transaction = validateTransactionReference(transactionReference);
  const result = await env.DB.prepare(
    `UPDATE payment_remediation_cases SET remediation_status = 'refund_submitted',
      refund_transaction_reference = ?, updated_at = ?
     WHERE request_id = ? AND remediation_status = 'refund_approved' AND refund_recipient IS NOT NULL`,
  ).bind(transaction, now.toISOString(), requestId).run();
  const current = await readRemediationCase(env, requestId);
  if (result.meta.changes !== 1 && !(current?.remediation_status === "refund_submitted" && current.refund_transaction_reference === transaction)) {
    throw new RemediationStateError("Refund submission is not valid from the current case state.");
  }
  await appendEvent(env, current!, {
    eventType: "refund_submitted", actorKind: "operator", operationId,
    occurredAt: now.toISOString(), network: current!.network, transactionReference: transaction,
    payer: current!.seller_recipient, recipient: current!.refund_recipient!, amountAtomic: current!.amount_atomic,
  });
}

export async function recordRefundEvidence(
  env: AppEnv,
  requestId: string,
  evidence: ValidatedRefundEvidence,
  operationId: string,
  now = new Date(),
): Promise<void> {
  const eventType = evidence.outcome === "confirmed" ? "refund_confirmed" : "refund_failed";
  validateBounded(evidence.reasonCode, "Reason code", 128);
  validateEvidenceFingerprint(evidence.evidenceFingerprint);
  validateEvidenceBlock(evidence.blockNumber);
  if (evidence.blockNumber === undefined) throw new RemediationStateError("Refund evidence requires a confirmed receipt block.");
  if (await operationAlreadyRecorded(env, requestId, operationId, eventType)) return;
  const current = await readRemediationCase(env, requestId);
  if (!current || current.remediation_status !== "refund_submitted" || !current.refund_recipient || !current.refund_transaction_reference) {
    throw new RemediationStateError("Refund evidence requires a submitted refund.");
  }
  validateAtomic(evidence.amountAtomic, "Refund amount");
  if (
    evidence.source !== "base_receipt" ||
    evidence.network !== current.network ||
    validateAddress(evidence.asset, "Refund asset") !== current.asset.toLowerCase() ||
    validateTransactionReference(evidence.transactionReference) !== current.refund_transaction_reference ||
    validateAddress(evidence.payer, "Refund source") !== current.seller_recipient.toLowerCase() ||
    validateAddress(evidence.recipient, "Refund recipient") !== current.refund_recipient.toLowerCase() ||
    evidence.amountAtomic !== current.amount_atomic
  ) throw new RemediationStateError("Refund evidence does not match the approved exact refund.");
  const target = eventType;
  await env.DB.prepare(
    `UPDATE payment_remediation_cases SET remediation_status = ?, closed_at = ?, updated_at = ?
     WHERE request_id = ? AND remediation_status = 'refund_submitted'`,
  ).bind(target, evidence.outcome === "confirmed" ? now.toISOString() : null, now.toISOString(), requestId).run();
  const refreshed = await readRemediationCase(env, requestId);
  if (!refreshed || refreshed.remediation_status !== target) throw new RemediationStateError("Refund evidence transition conflicts with current case state.");
  await appendEvent(env, refreshed, {
    eventType: target, actorKind: "operator", operationId, occurredAt: now.toISOString(),
    reasonCode: evidence.reasonCode, reconciliationSource: "base_receipt",
    evidenceFingerprint: evidence.evidenceFingerprint, network: evidence.network,
    transactionReference: evidence.transactionReference, blockNumber: evidence.blockNumber,
    payer: evidence.payer, recipient: evidence.recipient, amountAtomic: evidence.amountAtomic,
  });
}

export async function closeEligibleWithoutRefund(
  env: AppEnv,
  requestId: string,
  operationId: string,
  reasonCode: string,
  now = new Date(),
): Promise<void> {
  validateBounded(reasonCode, "Reason code", 128);
  if (await operationAlreadyRecorded(env, requestId, operationId, "closed_without_refund")) return;
  const result = await env.DB.prepare(
    `UPDATE payment_remediation_cases SET remediation_status = 'closed_without_refund',
      closed_at = ?, updated_at = ?
     WHERE request_id = ?
       AND (
         reconciliation_status = 'confirmed_not_paid'
         OR (
           fulfillment_status = 'completed'
           AND remediation_status IN ('none', 'refund_review_required', 'refund_approved', 'refund_failed')
         )
       )`,
  ).bind(now.toISOString(), now.toISOString(), requestId).run();
  const current = await readRemediationCase(env, requestId);
  if (result.meta.changes !== 1 && current?.remediation_status !== "closed_without_refund") {
    throw new RemediationStateError("Case is not eligible to close without refund.");
  }
  await appendEvent(env, current!, {
    eventType: "closed_without_refund", actorKind: "operator", operationId,
    occurredAt: now.toISOString(), reasonCode,
  });
}
