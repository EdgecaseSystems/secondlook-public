import { ClientInputError, PaymentLifecycleError, ServiceBoundaryError } from "./errors";
import type { PaymentRequirement, PaymentState } from "./payments";
import type { AppEnv } from "./types";
import type { PublicCommercialJurisdiction, PublicMainnetConfiguration } from "./public-mainnet";
import { PAYMENT_PROCESSING_STALE_SECONDS } from "./lifecycle-constants";

export type CommercialExposureState = "reserved" | "authorized" | "accepted" | "ambiguous" | "failed" | "released";
export type CommercialEventType =
  | "financial_exposure_reserved"
  | "financial_exposure_released"
  | "settlement_authorized"
  | "settlement_accepted"
  | "settlement_failed"
  | "settlement_ambiguous";

export interface CommercialFinancialLimits {
  dailySettlementLimit: number;
  dailyAcceptedPaymentLimit: number;
  dailySettledAtomicLimit: number;
  monthlyFacilitatorLimit: number;
  dailyPaidInferenceLimit: number;
}

export interface CommercialPaymentContext {
  requirement: PaymentRequirement;
  facilitator: string;
  configurationFingerprint: string;
  limits: CommercialFinancialLimits;
  publicMainnet: (PublicMainnetConfiguration & { jurisdiction: PublicCommercialJurisdiction }) | null;
}

type CommercialExposureRow = {
  request_id: string;
  state: CommercialExposureState;
  network: string;
  asset: string;
  amount_atomic: string;
  pay_to: string;
  facilitator: string;
  configuration_fingerprint: string;
  settlement_authorized_at: string | null;
  resolved_at: string | null;
  created_at: string;
};

type PaymentAccountingRow = {
  state: PaymentState;
  payer_identity: string | null;
  external_reference: string | null;
  settled_at: string | null;
};

const EXPOSURE_METADATA_MAX = 256;
export const COMMERCIAL_STALE_CLEANUP_LIMIT = 8;

function safelyReleasableReservationSql(exposureAlias: string): string {
  return `(${exposureAlias}.state = 'reserved'
    AND ${exposureAlias}.settlement_authorized_at IS NULL
    AND EXISTS (
      SELECT 1 FROM request_payments stale_payment
      JOIN paid_execution_admissions stale_admission
        ON stale_admission.request_id = stale_payment.request_id
      WHERE stale_payment.request_id = ${exposureAlias}.request_id
        AND stale_admission.state = 'reserved'
        AND stale_admission.owner_token IS NOT NULL
        AND stale_admission.lease_kind = 'settlement'
        AND stale_admission.lease_expires_at <= ?
        AND (
          stale_payment.state = 'required'
          OR (
            stale_payment.state = 'processing'
            AND stale_payment.updated_at <= ?
            AND stale_payment.attempt_owner_token = stale_admission.owner_token
          )
        )
    ))`;
}

function validateBounded(value: string, name: string, maximum = EXPOSURE_METADATA_MAX): void {
  if (value.length === 0 || value.length > maximum) throw new Error(`${name} must be 1-${maximum} characters.`);
}

function validateContext(context: CommercialPaymentContext): void {
  validateBounded(context.requirement.network, "Commercial network", 128);
  validateBounded(context.requirement.asset, "Commercial asset", 128);
  validateBounded(context.requirement.payTo, "Commercial recipient");
  validateBounded(context.facilitator, "Commercial facilitator");
  if (!/^[1-9][0-9]*$/.test(context.requirement.amountAtomic)) throw new Error("Commercial amount must be canonical and positive.");
  if (!/^[0-9a-f]{64}$/.test(context.configurationFingerprint)) throw new Error("Commercial configuration fingerprint is invalid.");
  for (const [name, value] of Object.entries(context.limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer.`);
  }
  if (context.publicMainnet) {
    validateBounded(context.publicMainnet.policyVersion, "Public commercial policy version", 64);
    validateBounded(context.publicMainnet.geographyPolicyVersion, "Geography policy version", 64);
    validateBounded(context.publicMainnet.termsVersion, "Terms version", 64);
    validateBounded(context.publicMainnet.privacyVersion, "Privacy version", 64);
    if (!Number.isSafeInteger(context.publicMainnet.maxOutstandingPaidObligations) || context.publicMainnet.maxOutstandingPaidObligations <= 0) {
      throw new Error("Public outstanding-obligation limit is invalid.");
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createCommercialPaymentContext(input: {
  requirement: PaymentRequirement;
  facilitator: string;
  limits: CommercialFinancialLimits;
  publicMainnet?: PublicMainnetConfiguration & { jurisdiction: PublicCommercialJurisdiction };
}): Promise<CommercialPaymentContext> {
  const normalized = {
    contract: "commercial-accounting-v3",
    network: input.requirement.network,
    asset: input.requirement.asset.toLowerCase(),
    amount_atomic: input.requirement.amountAtomic,
    pay_to: input.requirement.payTo.toLowerCase(),
    facilitator: input.facilitator,
    limits: input.limits,
    public_commercial: input.publicMainnet ? {
      max_outstanding_paid_obligations: input.publicMainnet.maxOutstandingPaidObligations,
      policy_version: input.publicMainnet.policyVersion,
      geography_policy_version: input.publicMainnet.geographyPolicyVersion,
      terms_version: input.publicMainnet.termsVersion,
      privacy_version: input.publicMainnet.privacyVersion,
      service_use_country: input.publicMainnet.jurisdiction.serviceUseCountry,
      service_use_region: input.publicMainnet.jurisdiction.serviceUseRegion,
    } : null,
  };
  const context = {
    ...input,
    publicMainnet: input.publicMainnet ?? null,
    configurationFingerprint: await sha256Hex(canonicalJson(normalized)),
  };
  validateContext(context);
  return context;
}

export async function assertCommercialPaymentCapacity(
  env: AppEnv,
  context: Pick<CommercialPaymentContext, "requirement" | "limits">,
  now = new Date(),
): Promise<void> {
  if (!/^[1-9][0-9]*$/.test(context.requirement.amountAtomic)) throw new Error("Commercial amount must be canonical and positive.");
  const timestamp = now.toISOString();
  const day = timestamp.slice(0, 10);
  const month = timestamp.slice(0, 7);
  const epochSeconds = Math.floor(now.getTime() / 1000);
  const paymentStaleBefore = new Date(now.getTime() - PAYMENT_PROCESSING_STALE_SECONDS * 1000).toISOString();
  const capacity = await env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM commercial_payment_exposures exposure
       WHERE admission_day = ? AND state IN ('reserved', 'authorized', 'accepted', 'ambiguous', 'failed')
         AND NOT ${safelyReleasableReservationSql("exposure")}) AS settlement_count,
      (SELECT COUNT(*) FROM commercial_payment_exposures exposure
       WHERE admission_day = ? AND (
         state IN ('reserved', 'authorized', 'accepted') OR (
           state = 'ambiguous' AND NOT EXISTS (
              SELECT 1 FROM payment_remediation_cases remediation
              WHERE remediation.request_id = exposure.request_id
                AND remediation.reconciliation_status = 'confirmed_not_paid'
                AND remediation.remediation_status = 'closed_without_refund'
            )
          )
       ) AND NOT ${safelyReleasableReservationSql("exposure")}) AS accepted_count,
      COALESCE((SELECT SUM(CAST(amount_atomic AS INTEGER)) FROM commercial_payment_exposures exposure
       WHERE admission_day = ? AND (
         state IN ('reserved', 'authorized', 'accepted') OR (
           state = 'ambiguous' AND NOT EXISTS (
             SELECT 1 FROM payment_remediation_cases remediation
             WHERE remediation.request_id = exposure.request_id
               AND remediation.reconciliation_status = 'confirmed_not_paid'
               AND remediation.remediation_status = 'closed_without_refund'
           )
         )
       ) AND NOT ${safelyReleasableReservationSql("exposure")}), 0) AS settled_atomic,
      (SELECT COUNT(*) FROM commercial_payment_exposures exposure
       WHERE admission_month = ? AND state IN ('reserved', 'authorized', 'accepted', 'ambiguous', 'failed')
         AND NOT ${safelyReleasableReservationSql("exposure")}) AS facilitator_count,
      (SELECT COUNT(*) FROM commercial_payment_exposures exposure
       WHERE admission_day = ? AND (
         state IN ('reserved', 'authorized', 'accepted') OR (
           state = 'ambiguous' AND EXISTS (
             SELECT 1 FROM payment_remediation_events ambiguity_fulfillment
             WHERE ambiguity_fulfillment.request_id = exposure.request_id
               AND ambiguity_fulfillment.event_type = 'fulfillment_recovery_available'
               AND ambiguity_fulfillment.reason_code = 'public_mainnet_ambiguity_honored'
           )
         )
       )
         AND NOT ${safelyReleasableReservationSql("exposure")}) AS paid_inference_count`,
  ).bind(
    day, epochSeconds, paymentStaleBefore,
    day, epochSeconds, paymentStaleBefore,
    day, epochSeconds, paymentStaleBefore,
    month, epochSeconds, paymentStaleBefore,
    day, epochSeconds, paymentStaleBefore,
  ).first<{
    settlement_count: number;
    accepted_count: number;
    settled_atomic: number;
    facilitator_count: number;
    paid_inference_count: number;
  }>();
  if (
    (capacity?.settlement_count ?? 0) >= context.limits.dailySettlementLimit ||
    (capacity?.accepted_count ?? 0) >= context.limits.dailyAcceptedPaymentLimit ||
    (capacity?.settled_atomic ?? 0) + Number(context.requirement.amountAtomic) > context.limits.dailySettledAtomicLimit ||
    (capacity?.facilitator_count ?? 0) >= context.limits.monthlyFacilitatorLimit ||
    (capacity?.paid_inference_count ?? 0) >= context.limits.dailyPaidInferenceLimit
  ) {
    throw new ServiceBoundaryError("financial_capacity_reached", "The paid service financial safety limit has been reached.", 503, true, 60);
  }
}

function eventId(requestId: string, eventType: CommercialEventType): string {
  return `${requestId}:${eventType}`;
}

async function appendEvent(
  env: AppEnv,
  requestId: string,
  eventType: CommercialEventType,
  occurredAt: string,
  verifiedPayer: string | null = null,
  transactionReference: string | null = null,
): Promise<void> {
  if (verifiedPayer !== null) validateBounded(verifiedPayer, "Verified payer");
  if (transactionReference !== null) validateBounded(transactionReference, "Transaction reference");
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO commercial_payment_events (
      event_id, request_id, event_type, occurred_at, network, asset, amount_atomic,
      pay_to, facilitator, verified_payer, transaction_reference, configuration_fingerprint, created_at
    ) SELECT ?, request_id, ?, ?, network, asset, amount_atomic, pay_to, facilitator, ?, ?, configuration_fingerprint, ?
      FROM commercial_payment_exposures WHERE request_id = ?`,
  ).bind(
    eventId(requestId, eventType), eventType, occurredAt,
    verifiedPayer, transactionReference, occurredAt, requestId,
  ).run();
  if (inserted.meta.changes === 1) return;
  const existing = await env.DB.prepare(
    "SELECT event_id FROM commercial_payment_events WHERE request_id = ? AND event_type = ?",
  ).bind(requestId, eventType).first<{ event_id: string }>();
  if (!existing || existing.event_id !== eventId(requestId, eventType)) {
    throw new PaymentLifecycleError("payment_state_conflict", false);
  }
}

export async function repairCommercialAccountingEvidence(
  env: AppEnv,
  requestId: string,
): Promise<void> {
  const exposure = await env.DB.prepare(
    `SELECT request_id, state, settlement_authorized_at, resolved_at, created_at
     FROM commercial_payment_exposures WHERE request_id = ?`,
  ).bind(requestId).first<Pick<CommercialExposureRow,
    "request_id" | "state" | "settlement_authorized_at" | "resolved_at" | "created_at"
  >>();
  if (!exposure) throw new PaymentLifecycleError("payment_state_conflict", false);

  await appendEvent(env, requestId, "financial_exposure_reserved", exposure.created_at);
  if (exposure.settlement_authorized_at !== null) {
    await appendEvent(env, requestId, "settlement_authorized", exposure.settlement_authorized_at);
  }
  if (exposure.state === "released") {
    if (exposure.resolved_at === null) throw new PaymentLifecycleError("payment_state_conflict", false);
    await appendEvent(env, requestId, "financial_exposure_released", exposure.resolved_at);
  }
}

export async function findExpiredCommercialReservationCandidates(
  env: AppEnv,
  now = new Date(),
): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT exposure.request_id
     FROM commercial_payment_exposures exposure INDEXED BY idx_commercial_exposures_state_updated
     WHERE ${safelyReleasableReservationSql("exposure")}
     ORDER BY exposure.updated_at
     LIMIT ?`,
  ).bind(
    Math.floor(now.getTime() / 1000),
    new Date(now.getTime() - PAYMENT_PROCESSING_STALE_SECONDS * 1000).toISOString(),
    COMMERCIAL_STALE_CLEANUP_LIMIT,
  ).all<{ request_id: string }>();
  return result.results.map((row) => row.request_id);
}

export async function reserveCommercialPaymentExposure(
  env: AppEnv,
  requestId: string,
  lifecycleOwnerToken: string,
  admissionOwnerToken: string,
  context: CommercialPaymentContext,
  now = new Date(),
): Promise<void> {
  validateContext(context);
  const timestamp = now.toISOString();
  const day = timestamp.slice(0, 10);
  const month = timestamp.slice(0, 7);
  const result = await env.DB.prepare(
    `INSERT INTO commercial_payment_exposures (
      request_id, admission_day, admission_month, network, asset, amount_atomic, pay_to,
      facilitator, state, configuration_fingerprint, public_commercial_policy_version, geography_policy_version,
      terms_version, privacy_version, service_use_country, service_use_region, edge_country, edge_region, settlement_authorized_at,
      accepted_at, resolved_at, created_at, updated_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM idempotent_requests
        WHERE request_id = ? AND owner_token = ? AND state = 'reserved'
      )
      AND EXISTS (
        SELECT 1 FROM request_payments
        WHERE request_id = ? AND state = 'required' AND network = ? AND asset = ?
          AND amount_atomic = ? AND pay_to = ?
      )
      AND EXISTS (
        SELECT 1 FROM paid_execution_admissions
        WHERE request_id = ? AND state = 'reserved' AND owner_token = ?
          AND lease_kind = 'settlement' AND lease_expires_at > ?
      )
      AND (SELECT COUNT(*) FROM commercial_payment_exposures
        WHERE request_id <> ? AND admission_day = ? AND state IN ('reserved', 'authorized', 'accepted', 'ambiguous', 'failed')) < ?
      AND (SELECT COUNT(*) FROM commercial_payment_exposures
        WHERE request_id <> ? AND admission_day = ? AND (
          state IN ('reserved', 'authorized', 'accepted') OR (
            state = 'ambiguous' AND NOT EXISTS (
              SELECT 1 FROM payment_remediation_cases remediation
              WHERE remediation.request_id = commercial_payment_exposures.request_id
                AND remediation.reconciliation_status = 'confirmed_not_paid'
                AND remediation.remediation_status = 'closed_without_refund'
            )
          )
        )) < ?
      AND COALESCE((SELECT SUM(CAST(amount_atomic AS INTEGER)) FROM commercial_payment_exposures
        WHERE request_id <> ? AND admission_day = ? AND (
          state IN ('reserved', 'authorized', 'accepted') OR (
            state = 'ambiguous' AND NOT EXISTS (
              SELECT 1 FROM payment_remediation_cases remediation
              WHERE remediation.request_id = commercial_payment_exposures.request_id
                AND remediation.reconciliation_status = 'confirmed_not_paid'
                AND remediation.remediation_status = 'closed_without_refund'
            )
          )
        )), 0) + CAST(? AS INTEGER) <= ?
      AND (SELECT COUNT(*) FROM commercial_payment_exposures
        WHERE request_id <> ? AND admission_month = ? AND state IN ('reserved', 'authorized', 'accepted', 'ambiguous', 'failed')) < ?
      AND (SELECT COUNT(*) FROM commercial_payment_exposures
        WHERE request_id <> ? AND admission_day = ? AND state IN ('reserved', 'authorized', 'accepted')) < ?
    ON CONFLICT(request_id) DO UPDATE SET
      admission_day = excluded.admission_day,
      admission_month = excluded.admission_month,
      network = excluded.network,
      asset = excluded.asset,
      amount_atomic = excluded.amount_atomic,
      pay_to = excluded.pay_to,
      facilitator = excluded.facilitator,
      state = 'reserved',
      configuration_fingerprint = excluded.configuration_fingerprint,
      public_commercial_policy_version = excluded.public_commercial_policy_version,
      geography_policy_version = excluded.geography_policy_version,
      terms_version = excluded.terms_version,
      privacy_version = excluded.privacy_version,
      service_use_country = excluded.service_use_country,
      service_use_region = excluded.service_use_region,
      settlement_authorized_at = NULL,
      accepted_at = NULL,
      resolved_at = NULL,
      updated_at = excluded.updated_at
    WHERE commercial_payment_exposures.state = 'released'
      AND (
        excluded.public_commercial_policy_version IS NULL
        OR commercial_payment_exposures.configuration_fingerprint = excluded.configuration_fingerprint
      )`,
  ).bind(
    requestId, day, month, context.requirement.network, context.requirement.asset,
    context.requirement.amountAtomic, context.requirement.payTo, context.facilitator,
    context.configurationFingerprint,
    context.publicMainnet?.policyVersion ?? null,
    context.publicMainnet?.geographyPolicyVersion ?? null,
    context.publicMainnet?.termsVersion ?? null,
    context.publicMainnet?.privacyVersion ?? null,
    context.publicMainnet?.jurisdiction.serviceUseCountry ?? null,
    context.publicMainnet?.jurisdiction.serviceUseRegion ?? null,
    context.publicMainnet?.jurisdiction.edgeCountry ?? null,
    context.publicMainnet?.jurisdiction.edgeRegion ?? null,
    timestamp, timestamp,
    requestId, lifecycleOwnerToken,
    requestId, context.requirement.network, context.requirement.asset,
    context.requirement.amountAtomic, context.requirement.payTo,
    requestId, admissionOwnerToken, Math.floor(now.getTime() / 1000),
    requestId, day, context.limits.dailySettlementLimit,
    requestId, day, context.limits.dailyAcceptedPaymentLimit,
    requestId, day, context.requirement.amountAtomic, context.limits.dailySettledAtomicLimit,
    requestId, month, context.limits.monthlyFacilitatorLimit,
    requestId, day, context.limits.dailyPaidInferenceLimit,
  ).run();
  if (result.meta.changes !== 1) {
    if (context.publicMainnet) {
      const existing = await env.DB.prepare(
        "SELECT state, configuration_fingerprint FROM commercial_payment_exposures WHERE request_id = ?",
      ).bind(requestId).first<{ state: CommercialExposureState; configuration_fingerprint: string }>();
      if (existing?.state === "released" && existing.configuration_fingerprint !== context.configurationFingerprint) {
        throw new ClientInputError(
          "invalid_payment_binding",
          "The caller-declared commercial jurisdiction does not match this logical paid request.",
          409,
        );
      }
    }
    throw new ServiceBoundaryError(
      "financial_capacity_reached",
      "The paid service financial safety limit has been reached.",
      503,
      true,
      60,
    );
  }
  await repairCommercialAccountingEvidence(env, requestId);
}

export async function releaseCommercialPaymentExposure(
  env: AppEnv,
  requestId: string,
  now = new Date(),
): Promise<void> {
  const timestamp = now.toISOString();
  const released = await env.DB.prepare(
    `UPDATE commercial_payment_exposures SET state = 'released', resolved_at = ?, updated_at = ?
     WHERE request_id = ? AND state = 'reserved'
       AND NOT EXISTS (
         SELECT 1 FROM paid_execution_admissions
         WHERE request_id = ? AND state IN ('settling', 'accepted', 'ambiguous', 'consumed')
       )`,
  ).bind(timestamp, timestamp, requestId, requestId).run();
  if (released.meta.changes !== 1) {
    const current = await env.DB.prepare(
      "SELECT state FROM commercial_payment_exposures WHERE request_id = ?",
    ).bind(requestId).first<{ state: CommercialExposureState }>();
    if (current?.state !== "released") throw new PaymentLifecycleError("payment_state_conflict", false);
  }
  await repairCommercialAccountingEvidence(env, requestId);
}

export async function authorizeCommercialSettlement(
  env: AppEnv,
  requestId: string,
  attemptOwnerToken: string,
  now = new Date(),
): Promise<void> {
  const timestamp = now.toISOString();
  const authorized = await env.DB.prepare(
    `UPDATE commercial_payment_exposures SET state = 'authorized', settlement_authorized_at = ?, updated_at = ?
     WHERE request_id = ? AND state = 'reserved'
       AND EXISTS (
         SELECT 1 FROM request_payments
         WHERE request_id = ? AND state = 'processing' AND attempt_owner_token = ?
       )
       AND EXISTS (
         SELECT 1 FROM paid_execution_admissions
         WHERE request_id = ? AND state = 'settling' AND owner_token = ?
       )`,
  ).bind(timestamp, timestamp, requestId, requestId, attemptOwnerToken, requestId, attemptOwnerToken).run();
  if (authorized.meta.changes !== 1) throw new PaymentLifecycleError("payment_state_conflict", false);
  await repairCommercialAccountingEvidence(env, requestId);
  const boundary = await env.DB.prepare(
    `SELECT exposure.request_id FROM commercial_payment_exposures exposure
     WHERE exposure.request_id = ? AND exposure.state = 'authorized'
       AND EXISTS (SELECT 1 FROM commercial_payment_events WHERE request_id = ? AND event_type = 'settlement_authorized')
       AND EXISTS (SELECT 1 FROM request_payments WHERE request_id = ? AND state = 'processing' AND attempt_owner_token = ?)
       AND EXISTS (SELECT 1 FROM paid_execution_admissions WHERE request_id = ? AND state = 'settling' AND owner_token = ?)`,
  ).bind(requestId, requestId, requestId, attemptOwnerToken, requestId, attemptOwnerToken).first<{ request_id: string }>();
  if (!boundary) throw new PaymentLifecycleError("payment_state_conflict", false);
}

export async function synchronizeCommercialAccountingFromPayment(
  env: AppEnv,
  requestId: string,
  now = new Date(),
): Promise<void> {
  const payment = await env.DB.prepare(
    "SELECT state, payer_identity, external_reference, settled_at FROM request_payments WHERE request_id = ?",
  ).bind(requestId).first<PaymentAccountingRow>();
  const exposure = await env.DB.prepare(
    `SELECT request_id, state, network, asset, amount_atomic, pay_to, facilitator, configuration_fingerprint,
      settlement_authorized_at, resolved_at, created_at
     FROM commercial_payment_exposures WHERE request_id = ?`,
  ).bind(requestId).first<CommercialExposureRow>();
  if (!payment) throw new PaymentLifecycleError("payment_not_found", false);
  if (!exposure) {
    if (payment.state === "required") return;
    throw new PaymentLifecycleError("payment_state_conflict", false);
  }
  await repairCommercialAccountingEvidence(env, requestId);

  const timestamp = now.toISOString();
  let target: CommercialExposureState | null = null;
  let event: CommercialEventType | null = null;
  if (payment.state === "accepted") { target = "accepted"; event = "settlement_accepted"; }
  else if (payment.state === "failed") { target = "failed"; event = "settlement_failed"; }
  else if (payment.state === "ambiguous") { target = "ambiguous"; event = "settlement_ambiguous"; }
  else if (payment.state === "required" && exposure.state === "reserved") {
    const admission = await env.DB.prepare(
      "SELECT state FROM paid_execution_admissions WHERE request_id = ?",
    ).bind(requestId).first<{ state: string }>();
    if (admission?.state === "released") {
      await releaseCommercialPaymentExposure(env, requestId, now);
    }
    return;
  } else return;

  const eventTime = target === "accepted" ? (payment.settled_at ?? timestamp) : timestamp;
  await appendEvent(env, requestId, event, eventTime, payment.payer_identity, payment.external_reference);
  const acceptedAt = target === "accepted" ? (payment.settled_at ?? timestamp) : null;
  const resolvedAt = target === "accepted" ? null : timestamp;
  const updated = await env.DB.prepare(
    `UPDATE commercial_payment_exposures SET state = ?, accepted_at = ?, resolved_at = ?, updated_at = ?
     WHERE request_id = ? AND state IN ('reserved', 'authorized', ?)`,
  ).bind(target, acceptedAt, resolvedAt, timestamp, requestId, target).run();
  if (updated.meta.changes !== 1) {
    const current = await env.DB.prepare(
      "SELECT state FROM commercial_payment_exposures WHERE request_id = ?",
    ).bind(requestId).first<{ state: CommercialExposureState }>();
    if (current?.state !== target) throw new PaymentLifecycleError("payment_state_conflict", false);
  }
}
