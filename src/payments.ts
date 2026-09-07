import { PaymentLifecycleError } from "./errors";
import {
  authorizeCommercialSettlement,
  findExpiredCommercialReservationCandidates,
  releaseCommercialPaymentExposure,
  reserveCommercialPaymentExposure,
  synchronizeCommercialAccountingFromPayment,
  type CommercialPaymentContext,
} from "./commercial-accounting";
import {
  assertPublicPaidNewSettlementsEnabled,
  FACILITATOR_TRANSPORT_FAILURE_CODE,
  INFERENCE_LEASE_SECONDS,
  publicPaidNewSettlementsEnabled,
  recordPublicFacilitatorTransportResult,
  releasePaidSettlementAdmission,
  reservePaidSettlementAdmission,
  type PaidExecutionLease,
} from "./operations";
import { ensurePaymentAmbiguityCase } from "./remediation";
import type { AppEnv } from "./types";
import { PAYMENT_PROCESSING_STALE_SECONDS } from "./lifecycle-constants";

export { PAYMENT_PROCESSING_STALE_SECONDS } from "./lifecycle-constants";

export type PaymentState = "required" | "processing" | "accepted" | "failed" | "ambiguous";

export interface PaymentRequirement {
  provider: string;
  protocol: string;
  amountAtomic: string;
  asset: string;
  network: string;
  payTo: string;
  requirementsJson: string;
}

export type PaymentAttemptResult =
  | {
      outcome: "accepted";
      payerIdentity: string;
      externalReference: string;
      verifiedAt: string;
      settledAt: string;
    }
  | {
      outcome: "failed";
      failureCode: string;
    }
  | {
      outcome: "unavailable";
      failureCode: string;
    }
  | {
      outcome: "ambiguous";
      failureCode: string;
      payerIdentity?: string;
      externalReference?: string;
      verifiedAt?: string;
    };

export interface PaymentProviderAdapter<Authorization> {
  attemptAcceptance(input: {
    requestId: string;
    requirement: PaymentRequirement;
    authorization: Authorization;
  }): Promise<PaymentAttemptResult>;
}

export interface PaymentAuthorizationIdentity {
  payer: string;
  nonce: string;
}

type PaymentRow = {
  request_id: string;
  provider: string;
  protocol: string;
  state: PaymentState;
  amount_atomic: string;
  asset: string;
  network: string;
  pay_to: string | null;
  payment_requirements_json: string | null;
  payment_proof_fingerprint: string | null;
  authorization_payer: string | null;
  authorization_nonce: string | null;
  payer_identity: string | null;
  external_reference: string | null;
  failure_code: string | null;
  verified_at: string | null;
  settled_at: string | null;
  updated_at: string;
  attempt_owner_token: string | null;
  attempt_started_at: string | null;
};

export interface AcceptedPayment {
  requestId: string;
  provider: string;
  protocol: string;
  amountAtomic: string;
  asset: string;
  network: string;
  payTo: string;
  paymentProofFingerprint: string;
  payerIdentity: string;
  externalReference: string;
  verifiedAt: string;
  settledAt: string;
}

export type PaymentAcceptance =
  | { kind: "accepted"; payment: AcceptedPayment }
  | { kind: "already_accepted"; payment: AcceptedPayment };

function validateMetadata(value: string, name: string, maximumLength: number): void {
  if (value.length === 0 || value.length > maximumLength) {
    throw new Error(`${name} must be 1-${maximumLength} characters.`);
  }
}

function validateRequirement(requirement: PaymentRequirement): void {
  validateMetadata(requirement.provider, "Payment provider", 64);
  validateMetadata(requirement.protocol, "Payment protocol", 64);
  validateMetadata(requirement.asset, "Payment asset", 128);
  validateMetadata(requirement.network, "Payment network", 128);
  validateMetadata(requirement.payTo, "Payment recipient", 256);
  validateMetadata(requirement.requirementsJson, "Payment requirements", 4096);
  if (!/^[1-9][0-9]*$/.test(requirement.amountAtomic) || requirement.amountAtomic.length > 78) {
    throw new Error("Payment amount must be a canonical positive atomic-unit integer.");
  }
}

function requirementFromRow(row: PaymentRow): PaymentRequirement {
  return {
    provider: row.provider,
    protocol: row.protocol,
    amountAtomic: row.amount_atomic,
    asset: row.asset,
    network: row.network,
    payTo: row.pay_to ?? "",
    requirementsJson: row.payment_requirements_json ?? "",
  };
}

function acceptedFromRow(row: PaymentRow): AcceptedPayment {
  if (!row.payer_identity || !row.external_reference || !row.verified_at || !row.settled_at || !row.payment_proof_fingerprint) {
    throw new PaymentLifecycleError("payment_ambiguous", false);
  }
  return {
    requestId: row.request_id,
    ...requirementFromRow(row),
    paymentProofFingerprint: row.payment_proof_fingerprint,
    payerIdentity: row.payer_identity,
    externalReference: row.external_reference,
    verifiedAt: row.verified_at,
    settledAt: row.settled_at,
  };
}

async function readPayment(env: AppEnv, requestId: string): Promise<PaymentRow> {
  const row = await env.DB.prepare(
    `SELECT request_id, provider, protocol, state, amount_atomic, asset, network, pay_to,
      payment_requirements_json, payment_proof_fingerprint, authorization_payer, authorization_nonce,
      payer_identity, external_reference, failure_code, verified_at, settled_at, updated_at,
      attempt_owner_token, attempt_started_at
     FROM request_payments WHERE request_id = ?`,
  ).bind(requestId).first<PaymentRow>();
  if (!row) throw new PaymentLifecycleError("payment_not_found", false);
  return row;
}

export async function createPaymentRequirement(
  env: AppEnv,
  requestId: string,
  lifecycleOwnerToken: string,
  requirement: PaymentRequirement,
  now = new Date(),
): Promise<void> {
  validateRequirement(requirement);
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO request_payments (
      request_id, provider, protocol, state, amount_atomic, asset, network, pay_to,
      payment_requirements_json, created_at, updated_at
    ) SELECT ?, ?, ?, 'required', ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM idempotent_requests
        WHERE request_id = ? AND owner_token = ? AND state = 'reserved'
      )`,
  ).bind(
    requestId,
    requirement.provider,
    requirement.protocol,
    requirement.amountAtomic,
    requirement.asset,
    requirement.network,
    requirement.payTo,
    requirement.requirementsJson,
    now.toISOString(),
    now.toISOString(),
    requestId,
    lifecycleOwnerToken,
  ).run();
  if (inserted.meta.changes === 1) return;

  const existing = await readPayment(env, requestId);
  const sameRequirement = JSON.stringify(requirementFromRow(existing)) === JSON.stringify(requirement);
  if (!sameRequirement) throw new PaymentLifecycleError("payment_requirement_conflict", false);
}

async function claimPaymentAttempt(
  env: AppEnv,
  requestId: string,
  lifecycleOwnerToken: string,
  admission: PaidExecutionLease,
  proofFingerprint: string,
  identity: PaymentAuthorizationIdentity,
  now: Date,
): Promise<{ ownerToken: string; requirement: PaymentRequirement } | { accepted: AcceptedPayment }> {
  const ownerToken = admission.ownerToken;
  const startedAt = now.toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE request_payments SET state = 'processing', attempt_owner_token = ?, attempt_started_at = ?,
      payment_proof_fingerprint = ?, authorization_payer = ?, authorization_nonce = ?,
      failure_code = NULL, updated_at = ?
     WHERE request_id = ? AND state = 'required'
       AND (payment_proof_fingerprint IS NULL OR payment_proof_fingerprint = ?) AND EXISTS (
       SELECT 1 FROM idempotent_requests
       WHERE request_id = ? AND owner_token = ? AND state = 'reserved'
     ) AND EXISTS (
       SELECT 1 FROM paid_execution_admissions
       WHERE request_id = ? AND state = 'reserved' AND owner_token = ?
         AND lease_kind = 'settlement' AND lease_expires_at > ?
     )`,
  ).bind(
    ownerToken, startedAt, proofFingerprint, identity.payer, identity.nonce, startedAt,
    requestId, proofFingerprint, requestId, lifecycleOwnerToken,
    requestId, ownerToken, Math.floor(now.getTime() / 1000),
  ).run();
  if (claimed.meta.changes === 1) {
    const row = await readPayment(env, requestId);
    return { ownerToken, requirement: requirementFromRow(row) };
  }

  let row = await readPayment(env, requestId);
  if (row.payment_proof_fingerprint && row.payment_proof_fingerprint !== proofFingerprint) {
    throw new PaymentLifecycleError("payment_proof_conflict", false);
  }
  if (row.state === "accepted") return { accepted: acceptedFromRow(row) };
  if (row.state === "ambiguous") throw new PaymentLifecycleError("payment_ambiguous", false);
  if (row.state === "failed") throw new PaymentLifecycleError("payment_failed", false);

  if (row.state === "processing") {
    const staleBefore = new Date(now.getTime() - PAYMENT_PROCESSING_STALE_SECONDS * 1000).toISOString();
    if (row.updated_at <= staleBefore) {
      await env.DB.prepare(
        `UPDATE request_payments SET state = 'ambiguous', failure_code = 'stale_payment_processing',
          attempt_owner_token = NULL, updated_at = ?
         WHERE request_id = ? AND state = 'processing' AND updated_at <= ?`,
      ).bind(startedAt, requestId, staleBefore).run();
      row = await readPayment(env, requestId);
      if (row.state === "ambiguous") throw new PaymentLifecycleError("payment_ambiguous", false);
    }
    throw new PaymentLifecycleError("payment_in_progress", true, 5);
  }

  throw new PaymentLifecycleError("payment_state_conflict", false);
}

async function repairOrRejectStalePaymentState(
  env: AppEnv,
  row: PaymentRow,
  now: Date,
): Promise<void> {
  const admission = await env.DB.prepare(
    `SELECT state, owner_token, lease_expires_at FROM paid_execution_admissions WHERE request_id = ?`,
  ).bind(row.request_id).first<{ state: string; owner_token: string | null; lease_expires_at: number | null }>();
  if (!admission) {
    if (row.state === "processing") throw new PaymentLifecycleError("payment_ambiguous", false);
    return;
  }

  if (row.state === "failed" && admission.state === "settling") {
    await env.DB.prepare(
      `UPDATE paid_execution_admissions SET state = 'released', owner_token = NULL,
        lease_kind = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE request_id = ? AND state = 'settling'
         AND EXISTS (SELECT 1 FROM request_payments WHERE request_id = ? AND state = 'failed')`,
    ).bind(now.toISOString(), row.request_id, row.request_id).run();
    return;
  }
  if (row.state === "ambiguous" && admission.state === "settling") {
    await env.DB.prepare(
      `UPDATE paid_execution_admissions SET state = 'ambiguous', owner_token = NULL,
        lease_kind = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE request_id = ? AND state = 'settling'
         AND EXISTS (SELECT 1 FROM request_payments WHERE request_id = ? AND state = 'ambiguous')`,
    ).bind(now.toISOString(), row.request_id, row.request_id).run();
    return;
  }

  const epochSeconds = Math.floor(now.getTime() / 1000);
  const staleBefore = new Date(now.getTime() - PAYMENT_PROCESSING_STALE_SECONDS * 1000).toISOString();
  const expiredReserved = admission.state === "reserved" && (admission.lease_expires_at ?? 0) <= epochSeconds;

  if (row.state === "required" && expiredReserved) {
    const released = await env.DB.prepare(
      `UPDATE paid_execution_admissions SET state = 'released', owner_token = NULL,
        lease_kind = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE request_id = ? AND state = 'reserved' AND owner_token = ? AND lease_expires_at <= ?
         AND EXISTS (SELECT 1 FROM request_payments WHERE request_id = ? AND state = 'required')`,
    ).bind(now.toISOString(), row.request_id, admission.owner_token, epochSeconds, row.request_id).run();
    if (released.meta.changes === 1) throw new PaymentLifecycleError("payment_in_progress", true, 1);
    throw new PaymentLifecycleError("payment_state_conflict", true, 1);
  }

  if (row.state !== "processing") return;
  if (row.updated_at > staleBefore) throw new PaymentLifecycleError("payment_in_progress", true, 5);

  if (expiredReserved && admission.owner_token === row.attempt_owner_token) {
    const released = await env.DB.prepare(
      `UPDATE paid_execution_admissions SET state = 'released', owner_token = NULL,
        lease_kind = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE request_id = ? AND state = 'reserved' AND owner_token = ? AND lease_expires_at <= ?
         AND EXISTS (
           SELECT 1 FROM request_payments
           WHERE request_id = ? AND state = 'processing' AND attempt_owner_token = ? AND updated_at <= ?
         )`,
    ).bind(
      now.toISOString(), row.request_id, admission.owner_token, epochSeconds,
      row.request_id, row.attempt_owner_token, staleBefore,
    ).run();
    if (released.meta.changes !== 1) throw new PaymentLifecycleError("payment_state_conflict", true, 1);
    const reset = await env.DB.prepare(
      `UPDATE request_payments SET state = 'required', attempt_owner_token = NULL, attempt_started_at = NULL,
        payment_proof_fingerprint = NULL, authorization_payer = NULL, authorization_nonce = NULL,
        failure_code = 'settlement_not_authorized', updated_at = ?
       WHERE request_id = ? AND state = 'processing' AND attempt_owner_token = ?
         AND EXISTS (SELECT 1 FROM paid_execution_admissions WHERE request_id = ? AND state = 'released')`,
    ).bind(now.toISOString(), row.request_id, row.attempt_owner_token, row.request_id).run();
    if (reset.meta.changes !== 1) throw new PaymentLifecycleError("payment_state_conflict", true, 1);
    throw new PaymentLifecycleError("payment_in_progress", true, 1);
  }

  if (admission.state === "settling" && admission.owner_token === row.attempt_owner_token) {
    const ambiguous = await env.DB.prepare(
      `UPDATE request_payments SET state = 'ambiguous', failure_code = 'stale_payment_processing',
        attempt_owner_token = NULL, updated_at = ?
       WHERE request_id = ? AND state = 'processing' AND attempt_owner_token = ? AND updated_at <= ?
         AND EXISTS (
           SELECT 1 FROM paid_execution_admissions
           WHERE request_id = ? AND state = 'settling' AND owner_token = ?
         )`,
    ).bind(
      now.toISOString(), row.request_id, row.attempt_owner_token, staleBefore,
      row.request_id, admission.owner_token,
    ).run();
    if (ambiguous.meta.changes === 1) {
      await env.DB.prepare(
        `UPDATE paid_execution_admissions SET state = 'ambiguous', owner_token = NULL,
          lease_kind = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE request_id = ? AND state = 'settling' AND owner_token = ?
           AND EXISTS (SELECT 1 FROM request_payments WHERE request_id = ? AND state = 'ambiguous')`,
      ).bind(now.toISOString(), row.request_id, admission.owner_token, row.request_id).run();
    }
    throw new PaymentLifecycleError("payment_ambiguous", false);
  }

  throw new PaymentLifecycleError("payment_ambiguous", false);
}

export async function repairExistingPaymentState(
  env: AppEnv,
  requestId: string,
  now = new Date(),
): Promise<void> {
  const current = await readPayment(env, requestId);
  try {
    await repairOrRejectStalePaymentState(env, current, now);
  } catch (error) {
    try { await synchronizeCommercialAccountingFromPayment(env, requestId, now); }
    catch { /* Payment truth remains authoritative when the accounting projection lags. */ }
    if (error instanceof PaymentLifecycleError && error.code === "payment_ambiguous") {
      await synchronizePaymentAmbiguityRemediation(env, requestId, now);
    }
    throw error;
  }
}

export async function cleanupAbandonedCommercialReservations(
  env: AppEnv,
  now = new Date(),
): Promise<void> {
  const candidates = await findExpiredCommercialReservationCandidates(env, now);
  for (const requestId of candidates) {
    let payment: PaymentRow;
    try {
      payment = await readPayment(env, requestId);
    } catch (error) {
      if (error instanceof PaymentLifecycleError && error.code === "payment_not_found") continue;
      throw error;
    }

    try {
      await repairOrRejectStalePaymentState(env, payment, now);
    } catch (error) {
      if (!(error instanceof PaymentLifecycleError)) throw error;
      if (!["payment_in_progress", "payment_state_conflict", "payment_ambiguous"].includes(error.code)) throw error;
    }
    await synchronizeCommercialAccountingFromPayment(env, requestId, now);
    const refreshed = await readPayment(env, requestId);
    if (refreshed.state === "ambiguous") await synchronizePaymentAmbiguityRemediation(env, requestId, now);
  }
}

async function synchronizePaymentAmbiguityRemediation(
  env: AppEnv,
  requestId: string,
  now = new Date(),
): Promise<void> {
  try {
    await ensurePaymentAmbiguityCase(env, requestId, now);
  } catch {
    console.error("SecondLook payment ambiguity remediation synchronization failed", {
      idempotency_request_id: requestId,
    });
  }
}

async function authorizeSettlement(
  env: AppEnv,
  requestId: string,
  lifecycleOwnerToken: string,
  admission: PaidExecutionLease,
  proofFingerprint: string,
  identity: PaymentAuthorizationIdentity,
  requirePublicPaidSalesEnabled: boolean,
  now: Date,
): Promise<void> {
  const authorized = await env.DB.prepare(
    `UPDATE paid_execution_admissions SET state = 'settling', settlement_authorized_at = ?, updated_at = ?
     WHERE request_id = ? AND state = 'reserved' AND owner_token = ?
       AND lease_kind = 'settlement' AND lease_expires_at > ?
       AND EXISTS (
         SELECT 1 FROM request_payments
         WHERE request_id = ? AND state = 'processing' AND attempt_owner_token = ?
           AND payment_proof_fingerprint = ? AND authorization_payer = ? AND authorization_nonce = ?
       )
       AND EXISTS (
         SELECT 1 FROM idempotent_requests
         WHERE request_id = ? AND owner_token = ? AND state = 'reserved'
       )
       AND (? = 0 OR EXISTS (
         SELECT 1 FROM public_paid_service_control
         WHERE singleton_id = 1 AND new_settlement_enabled = 1
       ))`,
  ).bind(
    now.toISOString(), now.toISOString(), requestId, admission.ownerToken,
    Math.floor(now.getTime() / 1000), requestId, admission.ownerToken,
    proofFingerprint, identity.payer, identity.nonce, requestId, lifecycleOwnerToken,
    requirePublicPaidSalesEnabled ? 1 : 0,
  ).run();
  if (authorized.meta.changes === 1) return;

  const rolledBack = await env.DB.prepare(
    `UPDATE request_payments SET state = 'required', attempt_owner_token = NULL, attempt_started_at = NULL,
      payment_proof_fingerprint = NULL, authorization_payer = NULL, authorization_nonce = NULL,
      failure_code = 'settlement_not_authorized', updated_at = ?
     WHERE request_id = ? AND state = 'processing' AND attempt_owner_token = ?
       AND EXISTS (SELECT 1 FROM paid_execution_admissions WHERE request_id = ? AND state = 'reserved' AND owner_token = ?)`,
  ).bind(now.toISOString(), requestId, admission.ownerToken, requestId, admission.ownerToken).run();
  if (rolledBack.meta.changes === 1) {
    await releasePaidSettlementAdmission(env, admission, now);
    if (requirePublicPaidSalesEnabled && !(await publicPaidNewSettlementsEnabled(env))) {
      await assertPublicPaidNewSettlementsEnabled(env);
    }
    throw new PaymentLifecycleError("payment_state_conflict", true, 5);
  }
  throw new PaymentLifecycleError("payment_ambiguous", false);
}

async function synchronizeAdmission(
  env: AppEnv,
  requestId: string,
  attemptOwnerToken: string,
  lifecycleOwnerToken: string,
  paymentState: "accepted" | "failed" | "ambiguous",
  now: Date,
): Promise<void> {
  const epochSeconds = Math.floor(now.getTime() / 1000);
  const admissionState = paymentState === "failed" ? "released" : paymentState;
  const result = await env.DB.prepare(
    `UPDATE paid_execution_admissions SET state = ?,
      owner_token = CASE WHEN ? = 'accepted' AND lease_expires_at > ? THEN ? ELSE NULL END,
      lease_kind = CASE WHEN ? = 'accepted' AND lease_expires_at > ? THEN 'inference' ELSE NULL END,
      lease_expires_at = CASE WHEN ? = 'accepted' AND lease_expires_at > ? THEN ? ELSE NULL END,
      updated_at = ?
     WHERE request_id = ? AND state = 'settling' AND owner_token = ?
       AND EXISTS (SELECT 1 FROM request_payments WHERE request_id = ? AND state = ?)`,
  ).bind(
    admissionState,
    paymentState, epochSeconds, lifecycleOwnerToken,
    paymentState, epochSeconds,
    paymentState, epochSeconds, epochSeconds + INFERENCE_LEASE_SECONDS,
    now.toISOString(), requestId, attemptOwnerToken, requestId, paymentState,
  ).run();
  if (result.meta.changes !== 1) throw new PaymentLifecycleError("payment_state_conflict", false);
}

async function markPaymentAmbiguous(
  env: AppEnv,
  requestId: string,
  ownerToken: string,
  result: Extract<PaymentAttemptResult, { outcome: "ambiguous" }>,
  now: Date,
): Promise<void> {
  const updated = await env.DB.prepare(
    `UPDATE request_payments SET state = 'ambiguous', payer_identity = ?, external_reference = ?,
      failure_code = ?, verified_at = ?, attempt_owner_token = NULL, updated_at = ?
     WHERE request_id = ? AND state = 'processing' AND attempt_owner_token = ?`,
  ).bind(
    result.payerIdentity ?? null,
    result.externalReference ?? null,
    result.failureCode,
    result.verifiedAt ?? null,
    now.toISOString(),
    requestId,
    ownerToken,
  ).run();
  if (updated.meta.changes !== 1) throw new PaymentLifecycleError("payment_ambiguous", false);
}

export async function attemptPaymentAcceptance<Authorization>(
  env: AppEnv,
  requestId: string,
  lifecycleOwnerToken: string,
  proofFingerprint: string,
  authorizationIdentity: PaymentAuthorizationIdentity,
  authorization: Authorization,
  adapter: PaymentProviderAdapter<Authorization>,
  now = new Date(),
  commercialContext?: CommercialPaymentContext,
): Promise<PaymentAcceptance> {
  validateMetadata(proofFingerprint, "Payment proof fingerprint", 64);
  if (!/^0x[0-9a-f]{40}$/.test(authorizationIdentity.payer) || !/^0x[0-9a-f]{64}$/.test(authorizationIdentity.nonce)) {
    throw new PaymentLifecycleError("payment_state_conflict", false);
  }
  const current = await readPayment(env, requestId);
  try {
    await repairOrRejectStalePaymentState(env, current, now);
  } catch (error) {
    if (commercialContext) {
      try { await synchronizeCommercialAccountingFromPayment(env, requestId, now); }
      catch { /* Preserve the authoritative payment lifecycle result; repair remains available on recovery. */ }
    }
    await synchronizePaymentAmbiguityRemediation(env, requestId, now);
    throw error;
  }
  if (commercialContext) await synchronizeCommercialAccountingFromPayment(env, requestId, now);
  if (current.payment_proof_fingerprint && current.payment_proof_fingerprint !== proofFingerprint) {
    throw new PaymentLifecycleError("payment_proof_conflict", false);
  }
  if (current.state === "accepted") return { kind: "already_accepted", payment: acceptedFromRow(current) };
  if (current.state === "ambiguous") {
    await synchronizePaymentAmbiguityRemediation(env, requestId, now);
    throw new PaymentLifecycleError("payment_ambiguous", false);
  }
  if (current.state === "failed") throw new PaymentLifecycleError("payment_failed", false);
  const reused = await env.DB.prepare(
    "SELECT request_id FROM request_payments WHERE payment_proof_fingerprint = ? AND request_id <> ?",
  ).bind(proofFingerprint, requestId).first<{ request_id: string }>();
  if (reused) throw new PaymentLifecycleError("payment_proof_conflict", false);
  const reusedAuthorization = await env.DB.prepare(
    `SELECT request_id FROM request_payments
     WHERE network = (SELECT network FROM request_payments WHERE request_id = ?)
       AND asset = (SELECT asset FROM request_payments WHERE request_id = ?)
       AND authorization_payer = ? AND authorization_nonce = ? AND request_id <> ?`,
  ).bind(requestId, requestId, authorizationIdentity.payer, authorizationIdentity.nonce, requestId).first<{ request_id: string }>();
  if (reusedAuthorization) throw new PaymentLifecycleError("payment_proof_conflict", false);

  const admission = await reservePaidSettlementAdmission(
    env,
    requestId,
    lifecycleOwnerToken,
    now,
    commercialContext?.publicMainnet?.maxOutstandingPaidObligations,
  );
  if (commercialContext) {
    try {
      await reserveCommercialPaymentExposure(
        env,
        requestId,
        lifecycleOwnerToken,
        admission.ownerToken,
        commercialContext,
        now,
      );
    } catch (error) {
      try { await releaseCommercialPaymentExposure(env, requestId, now); }
      catch { /* A partial financial reservation remains fail-closed and repairable. */ }
      try { await releasePaidSettlementAdmission(env, admission, now); }
      catch { /* Preserve the financial admission failure when the execution admission no longer remains reserved. */ }
      throw error;
    }
  }

  let claim: Awaited<ReturnType<typeof claimPaymentAttempt>>;
  try {
    claim = await claimPaymentAttempt(env, requestId, lifecycleOwnerToken, admission, proofFingerprint, authorizationIdentity, now);
  } catch (error) {
    if (commercialContext) {
      try { await releaseCommercialPaymentExposure(env, requestId, now); }
      catch { /* Preserve the authoritative payment claim error. */ }
    }
    try { await releasePaidSettlementAdmission(env, admission, now); }
    catch { /* Preserve the authoritative payment error when the admission no longer remains reserved. */ }
    if (error instanceof PaymentLifecycleError) throw error;
    const conflict = await env.DB.prepare(
      "SELECT request_id FROM request_payments WHERE payment_proof_fingerprint = ? AND request_id <> ?",
    ).bind(proofFingerprint, requestId).first<{ request_id: string }>();
    if (conflict) throw new PaymentLifecycleError("payment_proof_conflict", false);
    const authorizationConflict = await env.DB.prepare(
      `SELECT request_id FROM request_payments
       WHERE network = (SELECT network FROM request_payments WHERE request_id = ?)
         AND asset = (SELECT asset FROM request_payments WHERE request_id = ?)
         AND authorization_payer = ? AND authorization_nonce = ? AND request_id <> ?`,
    ).bind(requestId, requestId, authorizationIdentity.payer, authorizationIdentity.nonce, requestId).first<{ request_id: string }>();
    if (authorizationConflict) throw new PaymentLifecycleError("payment_proof_conflict", false);
    throw error;
  }
  if ("accepted" in claim) {
    if (commercialContext) await synchronizeCommercialAccountingFromPayment(env, requestId, now);
    try { await releasePaidSettlementAdmission(env, admission, now); }
    catch { /* An accepted payment remains authoritative. */ }
    return { kind: "already_accepted", payment: claim.accepted };
  }

  try {
    await authorizeSettlement(
      env, requestId, lifecycleOwnerToken, admission, proofFingerprint, authorizationIdentity,
      commercialContext?.publicMainnet !== null && commercialContext?.publicMainnet !== undefined,
      now,
    );
  } catch (error) {
    if (commercialContext) {
      try { await releaseCommercialPaymentExposure(env, requestId, now); }
      catch { /* Preserve the settlement-authorization error; a partial reservation remains fail-closed. */ }
    }
    throw error;
  }
  if (commercialContext) {
    try {
      await authorizeCommercialSettlement(env, requestId, claim.ownerToken, now);
    } catch {
      await markPaymentAmbiguous(env, requestId, claim.ownerToken, {
        outcome: "ambiguous",
        failureCode: "commercial_settlement_authorization_incomplete",
      }, now);
      await synchronizeCommercialAccountingFromPayment(env, requestId, now);
      await synchronizeAdmission(env, requestId, claim.ownerToken, lifecycleOwnerToken, "ambiguous", now);
      await synchronizePaymentAmbiguityRemediation(env, requestId, now);
      throw new PaymentLifecycleError("payment_ambiguous", false);
    }
  }

  let result: PaymentAttemptResult;
  try {
    result = await adapter.attemptAcceptance({ requestId, requirement: claim.requirement, authorization });
  } catch {
    result = { outcome: "ambiguous", failureCode: "payment_provider_outcome_unknown" };
  }

  if (commercialContext?.publicMainnet) {
    const failureCode = result.outcome === "ambiguous" ? result.failureCode : null;
    try {
      await recordPublicFacilitatorTransportResult(env, failureCode, now);
    } catch {
      console.error("SecondLook public payment safety control update failed", {
        idempotency_request_id: requestId,
        outcome: result.outcome,
      });
      if (result.outcome === "ambiguous" && failureCode === FACILITATOR_TRANSPORT_FAILURE_CODE) {
        result = { ...result, failureCode: "public_paid_safety_control_unavailable" };
      }
    }
  }

  if (result.outcome === "failed") {
    const updated = await env.DB.prepare(
      `UPDATE request_payments SET state = 'failed', failure_code = ?, attempt_owner_token = NULL, updated_at = ?
       WHERE request_id = ? AND state = 'processing' AND attempt_owner_token = ?`,
    ).bind(result.failureCode, now.toISOString(), requestId, claim.ownerToken).run();
    if (updated.meta.changes !== 1) throw new PaymentLifecycleError("payment_ambiguous", false);
    if (commercialContext) await synchronizeCommercialAccountingFromPayment(env, requestId, now);
    await synchronizeAdmission(env, requestId, claim.ownerToken, lifecycleOwnerToken, "failed", now);
    throw new PaymentLifecycleError("payment_failed", false);
  }

  if (result.outcome === "unavailable") {
    result = { outcome: "ambiguous", failureCode: result.failureCode };
  }

  if (result.outcome === "ambiguous") {
    await markPaymentAmbiguous(env, requestId, claim.ownerToken, result, now);
    if (commercialContext) await synchronizeCommercialAccountingFromPayment(env, requestId, now);
    await synchronizeAdmission(env, requestId, claim.ownerToken, lifecycleOwnerToken, "ambiguous", now);
    await synchronizePaymentAmbiguityRemediation(env, requestId, now);
    throw new PaymentLifecycleError("payment_ambiguous", false);
  }

  validateMetadata(result.payerIdentity, "Verified payer identity", 256);
  validateMetadata(result.externalReference, "External payment reference", 256);
  if (result.payerIdentity.toLowerCase() !== authorizationIdentity.payer) {
    await markPaymentAmbiguous(env, requestId, claim.ownerToken, {
      outcome: "ambiguous",
      failureCode: "payment_settlement_payer_mismatch",
      payerIdentity: result.payerIdentity,
      externalReference: result.externalReference,
      verifiedAt: result.verifiedAt,
    }, now);
    if (commercialContext) await synchronizeCommercialAccountingFromPayment(env, requestId, now);
    await synchronizeAdmission(env, requestId, claim.ownerToken, lifecycleOwnerToken, "ambiguous", now);
    await synchronizePaymentAmbiguityRemediation(env, requestId, now);
    throw new PaymentLifecycleError("payment_ambiguous", false);
  }
  const accepted = await env.DB.prepare(
    `UPDATE request_payments SET state = 'accepted', payer_identity = ?, external_reference = ?,
      failure_code = NULL, verified_at = ?, settled_at = ?, attempt_owner_token = NULL, updated_at = ?
     WHERE request_id = ? AND state = 'processing' AND attempt_owner_token = ?`,
  ).bind(
    result.payerIdentity,
    result.externalReference,
    result.verifiedAt,
    result.settledAt,
    now.toISOString(),
    requestId,
    claim.ownerToken,
  ).run();
  if (accepted.meta.changes !== 1) {
    await markPaymentAmbiguous(env, requestId, claim.ownerToken, {
      outcome: "ambiguous",
      failureCode: "durable_payment_confirmation_lost",
      payerIdentity: result.payerIdentity,
      externalReference: result.externalReference,
      verifiedAt: result.verifiedAt,
    }, now);
    if (commercialContext) await synchronizeCommercialAccountingFromPayment(env, requestId, now);
    await synchronizeAdmission(env, requestId, claim.ownerToken, lifecycleOwnerToken, "ambiguous", now);
    await synchronizePaymentAmbiguityRemediation(env, requestId, now);
    throw new PaymentLifecycleError("payment_ambiguous", false);
  }
  if (commercialContext) await synchronizeCommercialAccountingFromPayment(env, requestId, now);
  await synchronizeAdmission(env, requestId, claim.ownerToken, lifecycleOwnerToken, "accepted", now);
  return { kind: "accepted", payment: acceptedFromRow(await readPayment(env, requestId)) };
}

export interface PaymentSnapshot extends PaymentRequirement {
  requestId: string;
  state: PaymentState;
  paymentProofFingerprint: string | null;
  authorizationPayer: string | null;
  authorizationNonce: string | null;
  payerIdentity: string | null;
  externalReference: string | null;
  failureCode: string | null;
  verifiedAt: string | null;
  settledAt: string | null;
}

export async function getPaymentSnapshot(env: AppEnv, requestId: string): Promise<PaymentSnapshot> {
  const row = await readPayment(env, requestId);
  return {
    requestId: row.request_id,
    state: row.state,
    ...requirementFromRow(row),
    paymentProofFingerprint: row.payment_proof_fingerprint,
    authorizationPayer: row.authorization_payer,
    authorizationNonce: row.authorization_nonce,
    payerIdentity: row.payer_identity,
    externalReference: row.external_reference,
    failureCode: row.failure_code,
    verifiedAt: row.verified_at,
    settledAt: row.settled_at,
  };
}
