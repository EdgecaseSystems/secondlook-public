import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import {
  approveRefund,
  authorizePublicMainnetAmbiguityFulfillment,
  closeEligibleWithoutRefund,
  deriveTerminalReconciliationFingerprint,
  ensurePaidFulfillmentCase,
  ensurePaymentAmbiguityCase,
  isCompletedPublicMainnetAmbiguityFulfillment,
  preserveRemediationBeforeExpiredLifecycleDeletion,
  readRemediationCase,
  recordPaymentReconciliation,
  recordRefundEvidence,
  recordRefundSubmitted,
  synchronizeCompletedFulfillment,
} from "../src/remediation";
import { assertCommercialPaymentCapacity, reserveCommercialPaymentExposure } from "../src/commercial-accounting";
import { fingerprintSecondLookRequest, markPaidInferenceRunning, reserveExistingPaidIdempotentRequest } from "../src/idempotency";
import {
  acquirePaidInferenceLease,
  assertPaidSettlementAvailability,
  FACILITATOR_TRANSPORT_FAILURE_CODE,
  markPaidAdmissionConsumed,
  publicPaidNewSettlementsEnabled,
  recordPublicFacilitatorTransportResult,
  reservePaidSettlementAdmission,
} from "../src/operations";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const payer = `0x${"11".repeat(20)}`;
const seller = `0x${"22".repeat(20)}`;
const asset = `0x${"33".repeat(20)}`;
const nonce = `0x${"44".repeat(32)}`;
const otherNonce = `0x${"45".repeat(32)}`;
const transaction = `0x${"55".repeat(32)}`;
const refundTransaction = `0x${"66".repeat(32)}`;
const fingerprint = "77".repeat(32);
const now = new Date("2026-08-30T12:00:00.000Z");

function clearGateResponse() {
  return {
    schema_version: "secondlook-gates-v1",
    gates: {
      authority_or_required_human_review: { triggered: false, reason: null },
      known_material_concern: { triggered: false, reason: null },
      material_unknown: { triggered: false, reason: null },
      inherent_human_accountability: { triggered: false, reason: null },
    },
    clear_reason: "The supplied facts support the action.",
    key_risks: [],
    missing_information: [],
  };
}

class D1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class D1DatabaseAdapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1Statement(this.database, sql);
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(join(root, "migrations")).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
    database.exec(readFileSync(join(root, "migrations", name), "utf8"));
  }
  return database;
}

function seedPaidRequest(database, requestId, paymentState, lifecycleState = "reserved", authorizationNonce = nonce, publicMainnet = false) {
  const timestamp = now.toISOString();
  database.prepare(
    `INSERT INTO idempotent_requests (
      request_id, caller_key, idempotency_key_hash, request_hash, execution_context,
      state, owner_token, created_at, updated_at, expires_at
    ) VALUES (?, 'paid:test', ?, ?, '{}', ?, 'owner', ?, ?, ?)`,
  ).run(requestId, `key-${requestId}`, `request-${requestId}`, lifecycleState, timestamp, timestamp, 1_800_000_000);
  database.prepare(
    `INSERT INTO request_payments (
      request_id, provider, protocol, state, amount_atomic, asset, network,
      payer_identity, external_reference, failure_code, verified_at, settled_at,
      created_at, updated_at, pay_to, authorization_payer, authorization_nonce
    ) VALUES (?, 'x402', 'x402-v2', ?, '50000', ?, 'eip155:8453', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    requestId,
    paymentState,
    asset,
    paymentState === "accepted" ? payer : null,
    paymentState === "accepted" ? transaction : null,
    paymentState === "ambiguous" ? "settlement_uncertain" : null,
    paymentState === "accepted" ? timestamp : null,
    paymentState === "accepted" ? timestamp : null,
    timestamp,
    timestamp,
    seller,
    payer,
    authorizationNonce,
  );
  database.prepare(
    `INSERT INTO commercial_payment_exposures (
      request_id, admission_day, admission_month, network, asset, amount_atomic, pay_to,
      facilitator, state, configuration_fingerprint, settlement_authorized_at,
      accepted_at, resolved_at, created_at, updated_at
    ) VALUES (?, '2026-08-30', '2026-08', 'eip155:8453', ?, '50000', ?,
      'https://api.cdp.coinbase.com/platform/v2/x402', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    requestId,
    asset,
    seller,
    paymentState === "accepted" ? "accepted" : "ambiguous",
    fingerprint,
    timestamp,
    paymentState === "accepted" ? timestamp : null,
    paymentState === "ambiguous" ? timestamp : null,
    timestamp,
    timestamp,
  );
  if (publicMainnet) {
    database.prepare(
      `UPDATE commercial_payment_exposures SET
        public_commercial_policy_version = 'public-commercial-v1',
        geography_policy_version = 'us-states-and-dc-v1',
        terms_version = '2026-09-02.1', privacy_version = '2026-08-30.3',
        service_use_country = 'US', service_use_region = 'TX',
        edge_country = 'US', edge_region = 'TX'
       WHERE request_id = ?`,
    ).run(requestId);
  }
}

function seedReservableRequest(database, requestId, lifecycleOwner = "lifecycle-owner", admissionOwner = undefined) {
  const timestamp = now.toISOString();
  database.prepare(
    `INSERT INTO idempotent_requests (
      request_id, caller_key, idempotency_key_hash, request_hash, execution_context,
      state, owner_token, created_at, updated_at, expires_at
    ) VALUES (?, 'paid:test', ?, ?, '{}', 'reserved', ?, ?, ?, ?)`,
  ).run(requestId, `key-${requestId}`, `request-${requestId}`, lifecycleOwner, timestamp, timestamp, 1_800_000_000);
  if (admissionOwner) {
    database.prepare(
      `INSERT INTO request_payments (
        request_id, provider, protocol, state, amount_atomic, asset, network,
        created_at, updated_at, pay_to
      ) VALUES (?, 'x402', 'x402-v2', 'required', '50000', ?, 'eip155:8453', ?, ?, ?)`,
    ).run(requestId, asset, timestamp, timestamp, seller);
    database.prepare(
      `INSERT INTO paid_execution_admissions (
        request_id, state, admission_day, capacity_day, owner_token, lease_kind,
        lease_expires_at, created_at, updated_at
      ) VALUES (?, 'reserved', '2026-08-30', '2026-08-30', ?, 'settlement', 1800000000, ?, ?)`,
    ).run(requestId, admissionOwner, timestamp, timestamp);
  }
}

function seedConsumedPaidInference(database, requestId, lifecycleState, lifecycleUpdatedAt = now.toISOString()) {
  seedPaidRequest(database, requestId, "accepted", lifecycleState);
  database.prepare(
    `INSERT INTO paid_execution_admissions (
      request_id, state, admission_day, capacity_day, owner_token, lease_kind,
      lease_expires_at, settlement_authorized_at, created_at, updated_at
    ) VALUES (?, 'consumed', '2026-08-30', '2026-08-30', NULL, NULL, NULL, ?, ?, ?)`,
  ).run(requestId, now.toISOString(), now.toISOString(), now.toISOString());
  database.prepare("UPDATE idempotent_requests SET updated_at = ? WHERE request_id = ?").run(lifecycleUpdatedAt, requestId);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function seedCapabilityBoundProcessing(database, requestId, key, updatedAt) {
  const keyHash = await sha256Hex(key);
  const requestHash = `request-hash-${requestId}`;
  const attemptOwner = `attempt-${requestId}`;
  database.prepare(
    `INSERT INTO idempotent_requests (
      request_id, caller_key, idempotency_key_hash, request_hash, execution_context,
      state, owner_token, created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, ?, '{}', 'reserved', 'old-owner', ?, ?, ?)`,
  ).run(requestId, `paid:${keyHash}`, keyHash, requestHash, updatedAt, updatedAt, 1_800_000_000);
  database.prepare(
    `INSERT INTO request_payments (
      request_id, provider, protocol, state, amount_atomic, asset, network, pay_to,
      payment_proof_fingerprint, authorization_payer, authorization_nonce,
      attempt_owner_token, attempt_started_at, created_at, updated_at
    ) VALUES (?, 'x402', 'x402-v2', 'processing', '50000', ?, 'eip155:8453', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(requestId, asset, seller, fingerprint, payer, nonce, attemptOwner, updatedAt, updatedAt, updatedAt);
  database.prepare(
    `INSERT INTO paid_execution_admissions (
      request_id, state, admission_day, capacity_day, owner_token, lease_kind,
      lease_expires_at, settlement_authorized_at, created_at, updated_at
    ) VALUES (?, 'settling', '2026-08-30', '2026-08-30', ?, 'settlement', ?, ?, ?, ?)`,
  ).run(requestId, attemptOwner, Math.floor(now.getTime() / 1000) + 30, updatedAt, updatedAt, updatedAt);
  database.prepare(
    `INSERT INTO commercial_payment_exposures (
      request_id, admission_day, admission_month, network, asset, amount_atomic, pay_to,
      facilitator, state, configuration_fingerprint, settlement_authorized_at,
      created_at, updated_at
    ) VALUES (?, '2026-08-30', '2026-08', 'eip155:8453', ?, '50000', ?,
      'https://api.cdp.coinbase.com/platform/v2/x402', 'authorized', ?, ?, ?, ?)`,
  ).run(requestId, asset, seller, fingerprint, updatedAt, updatedAt, updatedAt);
  return { auth: { kind: "paid", key_id: keyHash }, requestHash };
}

function env(database) {
  return { DB: new D1DatabaseAdapter(database) };
}

function commercialContext(limits = {}) {
  return {
    requirement: { network: "eip155:8453", asset, amountAtomic: "50000", payTo: seller },
    facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
    configurationFingerprint: fingerprint,
    limits: {
      dailySettlementLimit: 10,
      dailyAcceptedPaymentLimit: 10,
      dailySettledAtomicLimit: 500000,
      monthlyFacilitatorLimit: 10,
      dailyPaidInferenceLimit: 10,
      ...limits,
    },
  };
}

async function events(database, requestId) {
  return database.prepare(
    "SELECT event_type, actor_kind, operation_id FROM payment_remediation_events WHERE request_id = ? ORDER BY occurred_at, event_type",
  ).all(requestId);
}

async function withTerminalFingerprint(evidence) {
  const normalized = { ...evidence, evidenceFingerprint: "00".repeat(32) };
  return {
    ...normalized,
    evidenceFingerprint: await deriveTerminalReconciliationFingerprint(normalized),
  };
}

describe("payment remediation state machine on all current migrations", () => {
  let database;

  beforeEach(() => {
    database = migratedDatabase();
  });

  it("opens one idempotent ambiguity case without changing historical payment truth", async () => {
    seedPaidRequest(database, "ambiguous-one", "ambiguous");
    await ensurePaymentAmbiguityCase(env(database), "ambiguous-one", now);
    await ensurePaymentAmbiguityCase(env(database), "ambiguous-one", now);

    const remediation = await readRemediationCase(env(database), "ambiguous-one");
    expect(remediation).toMatchObject({
      case_kind: "payment_ambiguity",
      reconciliation_status: "pending",
      fulfillment_status: "not_started",
      remediation_status: "none",
      authorization_payer: payer,
      facilitator_verified_payer: null,
    });
    expect(database.prepare("SELECT state FROM request_payments WHERE request_id = ?").get("ambiguous-one").state).toBe("ambiguous");
    expect(await events(database, "ambiguous-one")).toHaveLength(1);
  });

  it("records cancellation-based nonpayment as an overlay and closes without refund", async () => {
    seedPaidRequest(database, "not-paid", "ambiguous");
    await ensurePaymentAmbiguityCase(env(database), "not-paid", now);
    await recordPaymentReconciliation(env(database), "not-paid", {
      classification: "unresolved",
      source: "base_log_search",
      evidenceFingerprint: fingerprint,
      network: "eip155:8453",
      reasonCode: "no_matching_authorization_event",
    }, "operator:not-paid:search-1", now);
    await recordPaymentReconciliation(env(database), "not-paid", await withTerminalFingerprint({
      classification: "confirmed_not_paid",
      source: "base_authorization_cancellation",
      network: "eip155:8453",
      asset,
      transactionReference: transaction,
      blockNumber: 123,
      payer,
      authorizationNonce: nonce,
      authorizationLogIndex: 1,
      reasonCode: "authorization_canceled",
    }), "operator:not-paid:cancellation-1", now);

    expect(await readRemediationCase(env(database), "not-paid")).toMatchObject({
      reconciliation_status: "confirmed_not_paid",
      remediation_status: "closed_without_refund",
      reconciled_transaction_reference: transaction,
    });
    expect(database.prepare("SELECT state FROM request_payments WHERE request_id = ?").get("not-paid").state).toBe("ambiguous");
  });

  it("rejects incomplete or mismatched operator evidence before changing case state", async () => {
    seedPaidRequest(database, "bad-evidence", "ambiguous");
    await ensurePaymentAmbiguityCase(env(database), "bad-evidence", now);
    await expect(recordPaymentReconciliation(env(database), "bad-evidence", await withTerminalFingerprint({
      classification: "confirmed_paid",
      source: "base_receipt",
      network: "eip155:8453",
      asset,
      transactionReference: transaction,
      blockNumber: 123,
      payer,
      authorizationNonce: nonce,
      recipient: seller,
      amountAtomic: "50001",
      authorizationLogIndex: 1,
      transferLogIndex: 2,
      reasonCode: "matching_authorization_and_transfer",
    }), "operator:bad-evidence:paid-1", now)).rejects.toThrow("does not match");
    await expect(recordPaymentReconciliation(env(database), "bad-evidence", {
      classification: "confirmed_not_paid",
      source: "base_log_search",
      evidenceFingerprint: fingerprint,
      network: "eip155:8453",
      asset,
      transactionReference: transaction,
      blockNumber: 123,
      payer,
      authorizationNonce: nonce,
      reasonCode: "searched_no_result",
    }, "operator:bad-evidence:not-paid-1", now)).rejects.toThrow("cancellation");
    expect(await readRemediationCase(env(database), "bad-evidence")).toMatchObject({
      reconciliation_status: "pending",
      remediation_status: "none",
    });
    expect(await events(database, "bad-evidence")).toHaveLength(1);
  });

  it("rejects missing or same-payer different-nonce confirmed-payment evidence without changing durable truth", async () => {
    seedPaidRequest(database, "nonce-bound-paid", "ambiguous");
    await ensurePaymentAmbiguityCase(env(database), "nonce-bound-paid", now);
    const evidence = {
      classification: "confirmed_paid",
      source: "base_receipt",
      evidenceFingerprint: fingerprint,
      network: "eip155:8453",
      asset,
      transactionReference: transaction,
      blockNumber: 123,
      payer,
      recipient: seller,
      amountAtomic: "50000",
      reasonCode: "matching_authorization_and_transfer",
    };
    await expect(recordPaymentReconciliation(
      env(database), "nonce-bound-paid", evidence,
      "operator:nonce-bound-paid:missing-nonce", now,
    )).rejects.toThrow("complete validated Base receipt");
    await expect(recordPaymentReconciliation(
      env(database), "nonce-bound-paid", { ...evidence, authorizationNonce: otherNonce },
      "operator:nonce-bound-paid:wrong-nonce", now,
    )).rejects.toThrow("does not match");

    expect(await readRemediationCase(env(database), "nonce-bound-paid")).toMatchObject({
      reconciliation_status: "pending",
      remediation_status: "none",
      chain_confirmed_payer: null,
      reconciled_transaction_reference: null,
      closed_at: null,
    });
    expect(await events(database, "nonce-bound-paid")).toHaveLength(1);

    seedReservableRequest(database, "paid-accepted-probe", "paid-accepted-owner", "paid-accepted-admission");
    await expect(reserveCommercialPaymentExposure(
      env(database), "paid-accepted-probe", "paid-accepted-owner", "paid-accepted-admission",
      commercialContext({ dailyAcceptedPaymentLimit: 1 }), now,
    )).rejects.toMatchObject({ code: "financial_capacity_reached" });
    seedReservableRequest(database, "paid-atomic-probe", "paid-atomic-owner", "paid-atomic-admission");
    await expect(reserveCommercialPaymentExposure(
      env(database), "paid-atomic-probe", "paid-atomic-owner", "paid-atomic-admission",
      commercialContext({ dailySettledAtomicLimit: 50000 }), now,
    )).rejects.toMatchObject({ code: "financial_capacity_reached" });
    seedReservableRequest(database, "paid-circuit-probe", "paid-circuit-owner");
    await expect(reservePaidSettlementAdmission(
      env(database), "paid-circuit-probe", "paid-circuit-owner", now,
    )).resolves.toMatchObject({ requestId: "paid-circuit-probe" });
  });

  it("rejects nonce-A fingerprint with otherwise valid nonce-B evidence before any durable mutation", async () => {
    seedPaidRequest(database, "fingerprint-bound-paid", "ambiguous", "reserved", otherNonce);
    await ensurePaymentAmbiguityCase(env(database), "fingerprint-bound-paid", now);
    const nonceAEvidence = await withTerminalFingerprint({
      classification: "confirmed_paid",
      source: "base_receipt",
      network: "eip155:8453",
      asset,
      transactionReference: transaction,
      blockNumber: 123,
      payer,
      authorizationNonce: nonce,
      recipient: seller,
      amountAtomic: "50000",
      authorizationLogIndex: 1,
      transferLogIndex: 2,
      reasonCode: "matching_authorization_and_transfer",
    });
    await expect(recordPaymentReconciliation(env(database), "fingerprint-bound-paid", {
      ...nonceAEvidence,
      authorizationNonce: otherNonce,
      evidenceFingerprint: "not-a-sha256",
    }, "operator:fingerprint-bound-paid:malformed", now)).rejects.toThrow("lowercase SHA-256");
    await expect(recordPaymentReconciliation(env(database), "fingerprint-bound-paid", {
      ...nonceAEvidence,
      authorizationNonce: otherNonce,
    }, "operator:fingerprint-bound-paid:confirm-1", now)).rejects.toThrow("fingerprint does not match");

    expect(await readRemediationCase(env(database), "fingerprint-bound-paid")).toMatchObject({
      reconciliation_status: "pending",
      remediation_status: "none",
      chain_confirmed_payer: null,
      reconciled_transaction_reference: null,
      closed_at: null,
    });
    expect(await events(database, "fingerprint-bound-paid")).toHaveLength(1);

    seedReservableRequest(database, "fingerprint-accepted-probe", "fingerprint-accepted-owner", "fingerprint-accepted-admission");
    await expect(reserveCommercialPaymentExposure(
      env(database), "fingerprint-accepted-probe", "fingerprint-accepted-owner", "fingerprint-accepted-admission",
      commercialContext({ dailyAcceptedPaymentLimit: 1 }), now,
    )).rejects.toMatchObject({ code: "financial_capacity_reached" });
    seedReservableRequest(database, "fingerprint-atomic-probe", "fingerprint-atomic-owner", "fingerprint-atomic-admission");
    await expect(reserveCommercialPaymentExposure(
      env(database), "fingerprint-atomic-probe", "fingerprint-atomic-owner", "fingerprint-atomic-admission",
      commercialContext({ dailySettledAtomicLimit: 50000 }), now,
    )).rejects.toMatchObject({ code: "financial_capacity_reached" });
    seedReservableRequest(database, "fingerprint-circuit-probe", "fingerprint-circuit-owner");
    await expect(reservePaidSettlementAdmission(
      env(database), "fingerprint-circuit-probe", "fingerprint-circuit-owner", now,
    )).resolves.toMatchObject({ requestId: "fingerprint-circuit-probe" });
  });

  it("rejects missing or same-payer different-nonce cancellation evidence without releasing capacity or ambiguity", async () => {
    seedPaidRequest(database, "nonce-bound-cancellation", "ambiguous");
    await ensurePaymentAmbiguityCase(env(database), "nonce-bound-cancellation", now);
    const evidence = {
      classification: "confirmed_not_paid",
      source: "base_authorization_cancellation",
      evidenceFingerprint: fingerprint,
      network: "eip155:8453",
      asset,
      transactionReference: transaction,
      blockNumber: 123,
      payer,
      reasonCode: "authorization_canceled",
    };
    await expect(recordPaymentReconciliation(
      env(database), "nonce-bound-cancellation", evidence,
      "operator:nonce-bound-cancellation:missing-nonce", now,
    )).rejects.toThrow("complete validated authorization cancellation");
    await expect(recordPaymentReconciliation(
      env(database), "nonce-bound-cancellation", { ...evidence, authorizationNonce: otherNonce },
      "operator:nonce-bound-cancellation:wrong-nonce", now,
    )).rejects.toThrow("does not match");

    expect(await readRemediationCase(env(database), "nonce-bound-cancellation")).toMatchObject({
      reconciliation_status: "pending",
      remediation_status: "none",
      chain_confirmed_payer: null,
      reconciled_transaction_reference: null,
      closed_at: null,
    });
    expect(await events(database, "nonce-bound-cancellation")).toHaveLength(1);

    seedReservableRequest(database, "cancellation-accepted-probe", "cancellation-accepted-owner", "cancellation-accepted-admission");
    await expect(reserveCommercialPaymentExposure(
      env(database), "cancellation-accepted-probe", "cancellation-accepted-owner", "cancellation-accepted-admission",
      commercialContext({ dailyAcceptedPaymentLimit: 1 }), now,
    )).rejects.toMatchObject({ code: "financial_capacity_reached" });
    seedReservableRequest(database, "cancellation-atomic-probe", "cancellation-atomic-owner", "cancellation-atomic-admission");
    await expect(reserveCommercialPaymentExposure(
      env(database), "cancellation-atomic-probe", "cancellation-atomic-owner", "cancellation-atomic-admission",
      commercialContext({ dailySettledAtomicLimit: 50000 }), now,
    )).rejects.toMatchObject({ code: "financial_capacity_reached" });
    seedReservableRequest(database, "cancellation-circuit-probe", "cancellation-circuit-owner");
    await expect(reservePaidSettlementAdmission(
      env(database), "cancellation-circuit-probe", "cancellation-circuit-owner", now,
    )).resolves.toMatchObject({ requestId: "cancellation-circuit-probe" });
  });

  it("keeps accepted fulfillment progression monotonic and closes only from durable completion", async () => {
    seedPaidRequest(database, "paid-recovery", "accepted");
    await ensurePaidFulfillmentCase(env(database), "paid-recovery", "recovery_available", now);
    await ensurePaidFulfillmentCase(env(database), "paid-recovery", "inference_ambiguous", now);
    await ensurePaidFulfillmentCase(env(database), "paid-recovery", "recovery_available", now);
    expect(await readRemediationCase(env(database), "paid-recovery")).toMatchObject({
      fulfillment_status: "inference_ambiguous",
      remediation_status: "refund_review_required",
      facilitator_verified_payer: payer,
    });

    database.prepare(
      "UPDATE idempotent_requests SET state = 'completed', response_json = '{}', completed_at = ? WHERE request_id = ?",
    ).run(now.toISOString(), "paid-recovery");
    await synchronizeCompletedFulfillment(env(database), "paid-recovery", now);
    expect(await readRemediationCase(env(database), "paid-recovery")).toMatchObject({
      fulfillment_status: "completed",
      remediation_status: "closed_without_refund",
      closed_at: now.toISOString(),
    });
  });

  it("does not close an unresolved payment-ambiguity case merely because fulfillment is durable", async () => {
    seedPaidRequest(database, "ambiguous-fulfilled", "ambiguous", "completed");
    await ensurePaymentAmbiguityCase(env(database), "ambiguous-fulfilled", now);
    await synchronizeCompletedFulfillment(env(database), "ambiguous-fulfilled", now);
    expect(await readRemediationCase(env(database), "ambiguous-fulfilled")).toMatchObject({
      reconciliation_status: "pending",
      fulfillment_status: "completed",
      remediation_status: "none",
      closed_at: null,
    });
  });

  it("installs closed-loop public paid abuse controls with conservative defaults", async () => {
    expect(database.prepare(
      `SELECT new_settlement_enabled, max_daily_ambiguity_fulfillments,
        max_unresolved_ambiguity_fulfillments_per_payer,
        facilitator_transport_failure_threshold, consecutive_facilitator_transport_failures
       FROM public_paid_service_control WHERE singleton_id = 1`,
    ).get()).toEqual({
      new_settlement_enabled: 1,
      max_daily_ambiguity_fulfillments: 3,
      max_unresolved_ambiguity_fulfillments_per_payer: 1,
      facilitator_transport_failure_threshold: 3,
      consecutive_facilitator_transport_failures: 0,
    });
  });

  it("allows only one unresolved ambiguity fulfillment per authorization payer", async () => {
    const seedEligible = async (requestId, authorizationPayer) => {
      seedPaidRequest(database, requestId, "ambiguous", "reserved", `${nonce.slice(0, -2)}${requestId.slice(-2)}`, true);
      database.prepare("UPDATE request_payments SET authorization_payer = ? WHERE request_id = ?")
        .run(authorizationPayer, requestId);
      database.prepare(
        `INSERT INTO paid_execution_admissions (
          request_id, state, admission_day, capacity_day, owner_token, lease_kind,
          lease_expires_at, settlement_authorized_at, created_at, updated_at
        ) VALUES (?, 'ambiguous', '2026-08-30', '2026-08-30', NULL, NULL, NULL, ?, ?, ?)`,
      ).run(requestId, now.toISOString(), now.toISOString(), now.toISOString());
      await ensurePaymentAmbiguityCase(env(database), requestId, now);
    };

    await seedEligible("payer-ambiguity-01", payer);
    await expect(authorizePublicMainnetAmbiguityFulfillment(env(database), "payer-ambiguity-01", now)).resolves.toBe(true);
    await seedEligible("payer-ambiguity-02", payer);
    await expect(authorizePublicMainnetAmbiguityFulfillment(env(database), "payer-ambiguity-02", now)).resolves.toBe(false);

    const otherPayer = `0x${"55".repeat(20)}`;
    await seedEligible("payer-ambiguity-03", otherPayer);
    await expect(authorizePublicMainnetAmbiguityFulfillment(env(database), "payer-ambiguity-03", now)).resolves.toBe(true);
  });

  it("caps ambiguity fulfillments globally per UTC day", async () => {
    database.prepare(
      "UPDATE public_paid_service_control SET max_unresolved_ambiguity_fulfillments_per_payer = 10 WHERE singleton_id = 1",
    ).run();
    for (let index = 0; index < 4; index += 1) {
      const requestId = `daily-ambiguity-0${index}`;
      seedPaidRequest(database, requestId, "ambiguous", "reserved", `${nonce.slice(0, -2)}0${index}`, true);
      database.prepare("UPDATE request_payments SET authorization_payer = ? WHERE request_id = ?")
        .run(`0x${String(index + 1).padStart(40, "0")}`, requestId);
      database.prepare(
        `INSERT INTO paid_execution_admissions (
          request_id, state, admission_day, capacity_day, owner_token, lease_kind,
          lease_expires_at, settlement_authorized_at, created_at, updated_at
        ) VALUES (?, 'ambiguous', '2026-08-30', '2026-08-30', NULL, NULL, NULL, ?, ?, ?)`,
      ).run(requestId, now.toISOString(), now.toISOString(), now.toISOString());
      await ensurePaymentAmbiguityCase(env(database), requestId, now);
      await expect(authorizePublicMainnetAmbiguityFulfillment(env(database), requestId, now))
        .resolves.toBe(index < 3);
    }
    expect(database.prepare(
      `SELECT COUNT(*) AS count FROM payment_remediation_events
       WHERE event_type = 'fulfillment_recovery_available'
         AND reason_code = 'public_mainnet_ambiguity_honored'`,
    ).get()).toEqual({ count: 3 });
  });

  it("suspends new public settlement after three consecutive facilitator transport failures", async () => {
    await expect(publicPaidNewSettlementsEnabled(env(database))).resolves.toBe(true);
    await recordPublicFacilitatorTransportResult(env(database), FACILITATOR_TRANSPORT_FAILURE_CODE, now);
    await recordPublicFacilitatorTransportResult(env(database), FACILITATOR_TRANSPORT_FAILURE_CODE, now);
    await expect(publicPaidNewSettlementsEnabled(env(database))).resolves.toBe(true);
    await recordPublicFacilitatorTransportResult(env(database), FACILITATOR_TRANSPORT_FAILURE_CODE, now);
    await expect(publicPaidNewSettlementsEnabled(env(database))).resolves.toBe(false);

    seedPaidRequest(database, "transport-circuit-ambiguity", "ambiguous", "reserved", nonce, true);
    database.prepare(
      `INSERT INTO paid_execution_admissions (
        request_id, state, admission_day, capacity_day, owner_token, lease_kind,
        lease_expires_at, settlement_authorized_at, created_at, updated_at
      ) VALUES (?, 'ambiguous', '2026-08-30', '2026-08-30', NULL, NULL, NULL, ?, ?, ?)`,
    ).run("transport-circuit-ambiguity", now.toISOString(), now.toISOString(), now.toISOString());
    await ensurePaymentAmbiguityCase(env(database), "transport-circuit-ambiguity", now);
    await expect(authorizePublicMainnetAmbiguityFulfillment(
      env(database), "transport-circuit-ambiguity", now,
    )).resolves.toBe(false);

    seedReservableRequest(database, "transport-circuit-probe", "transport-circuit-owner");
    await expect(reservePaidSettlementAdmission(
      env(database), "transport-circuit-probe", "transport-circuit-owner", now, 5,
    )).rejects.toMatchObject({ code: "service_disabled", retryable: true });

    await recordPublicFacilitatorTransportResult(env(database), null, now);
    expect(database.prepare(
      `SELECT new_settlement_enabled, consecutive_facilitator_transport_failures,
        last_facilitator_transport_failure_code
       FROM public_paid_service_control WHERE singleton_id = 1`,
    ).get()).toEqual({
      new_settlement_enabled: 0,
      consecutive_facilitator_transport_failures: 0,
      last_facilitator_transport_failure_code: null,
    });
  });

  it("honors exactly one public-mainnet ambiguity fulfillment without changing payment truth", async () => {
    seedPaidRequest(database, "ambiguity-honor", "ambiguous", "reserved", nonce, true);
    database.prepare(
      `INSERT INTO paid_execution_admissions (
        request_id, state, admission_day, capacity_day, owner_token, lease_kind,
        lease_expires_at, settlement_authorized_at, created_at, updated_at
      ) VALUES (?, 'ambiguous', '2026-08-30', '2026-08-30', NULL, NULL, NULL, ?, ?, ?)`,
    ).run("ambiguity-honor", now.toISOString(), now.toISOString(), now.toISOString());
    await ensurePaymentAmbiguityCase(env(database), "ambiguity-honor", now);

    await expect(authorizePublicMainnetAmbiguityFulfillment(env(database), "ambiguity-honor", now)).resolves.toBe(true);
    expect(await readRemediationCase(env(database), "ambiguity-honor")).toMatchObject({
      case_kind: "payment_ambiguity",
      reconciliation_status: "pending",
      fulfillment_status: "recovery_available",
    });

    const lease = await acquirePaidInferenceLease(env(database), "ambiguity-honor", "owner", true, now);
    await markPaidInferenceRunning(env(database), "ambiguity-honor", "owner", true, now);
    await markPaidAdmissionConsumed(env(database), lease, true, now);
    database.prepare(
      `UPDATE idempotent_requests SET state = 'completed', response_json = '{}',
        completed_at = ?, owner_token = NULL WHERE request_id = ? AND state = 'inference_running'`,
    ).run(now.toISOString(), "ambiguity-honor");
    await synchronizeCompletedFulfillment(env(database), "ambiguity-honor", now);

    await expect(isCompletedPublicMainnetAmbiguityFulfillment(env(database), "ambiguity-honor")).resolves.toBe(true);
    expect(database.prepare("SELECT state FROM request_payments WHERE request_id = ?").get("ambiguity-honor")).toEqual({ state: "ambiguous" });
    expect(database.prepare("SELECT state FROM commercial_payment_exposures WHERE request_id = ?").get("ambiguity-honor")).toEqual({ state: "ambiguous" });
    expect(database.prepare("SELECT state FROM paid_execution_admissions WHERE request_id = ?").get("ambiguity-honor")).toEqual({ state: "consumed" });
    expect(await readRemediationCase(env(database), "ambiguity-honor")).toMatchObject({
      reconciliation_status: "pending",
      fulfillment_status: "completed",
      remediation_status: "none",
      closed_at: null,
    });
    await expect(authorizePublicMainnetAmbiguityFulfillment(env(database), "ambiguity-honor", now)).resolves.toBe(false);

    seedReservableRequest(database, "allowed-after-ambiguity-honor", "next-owner");
    await expect(reservePaidSettlementAdmission(
      env(database), "allowed-after-ambiguity-honor", "next-owner", now, 5,
    )).resolves.toMatchObject({ requestId: "allowed-after-ambiguity-honor" });
  });

  it("never grants ambiguity fulfillment outside a public-commercial exposure", async () => {
    seedPaidRequest(database, "non-public-ambiguity", "ambiguous");
    await ensurePaymentAmbiguityCase(env(database), "non-public-ambiguity", now);
    await expect(authorizePublicMainnetAmbiguityFulfillment(env(database), "non-public-ambiguity", now)).resolves.toBe(false);
    expect(await readRemediationCase(env(database), "non-public-ambiguity")).toMatchObject({ fulfillment_status: "not_started" });
  });

  it("never grants public-mainnet ambiguity fulfillment to a non-mainnet lifecycle", async () => {
    seedPaidRequest(database, "non-mainnet-ambiguity", "ambiguous", "reserved", nonce, true);
    database.prepare("UPDATE request_payments SET network = 'eip155:84532' WHERE request_id = ?").run("non-mainnet-ambiguity");
    database.prepare("UPDATE commercial_payment_exposures SET network = 'eip155:84532' WHERE request_id = ?").run("non-mainnet-ambiguity");
    await ensurePaymentAmbiguityCase(env(database), "non-mainnet-ambiguity", now);

    await expect(authorizePublicMainnetAmbiguityFulfillment(env(database), "non-mainnet-ambiguity", now)).resolves.toBe(false);
    expect(await readRemediationCase(env(database), "non-mainnet-ambiguity")).toMatchObject({
      network: "eip155:84532",
      fulfillment_status: "not_started",
    });
  });

  it("returns one ambiguity-honored judgment and exact replay without another settlement or inference", async () => {
    const requestId = "ambiguity-honor-http";
    const key = "10000000-0000-4000-8000-0000000000a1";
    const input = { goal: "Review the existing ambiguous purchase.", proposed_action: "Perform the reviewed action." };
    const fingerprinted = await fingerprintSecondLookRequest(input, env(database), null);
    const keyHash = await sha256Hex(key);
    seedPaidRequest(database, requestId, "ambiguous", "reserved", nonce, true);
    database.prepare(
      `UPDATE idempotent_requests SET caller_key = ?, idempotency_key_hash = ?,
        request_hash = ?, execution_context = ? WHERE request_id = ?`,
    ).run(`paid:${keyHash}`, keyHash, fingerprinted.hash, fingerprinted.executionContext, requestId);
    database.prepare(
      `INSERT INTO paid_execution_admissions (
        request_id, state, admission_day, capacity_day, owner_token, lease_kind,
        lease_expires_at, settlement_authorized_at, created_at, updated_at
      ) VALUES (?, 'ambiguous', '2026-08-30', '2026-08-30', NULL, NULL, NULL, ?, ?, ?)`,
    ).run(requestId, now.toISOString(), now.toISOString(), now.toISOString());
    await ensurePaymentAmbiguityCase(env(database), requestId, now);

    const aiRun = vi.fn(async () => ({ response: clearGateResponse() }));
    const ai = Object.create(null);
    Object.defineProperty(ai, "run", { value: aiRun });
    const provider = { attemptAcceptance: vi.fn() };
    const worker = createWorker({ paymentAdapter: provider });
    const runtimeEnv = { ...env(database), AI: ai };
    const request = () => new Request("https://secondlook.example/v1/paid/second-look", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(input),
    });

    const fulfilled = await worker.fetch(request(), runtimeEnv);
    const fulfilledBody = await fulfilled.json();
    database.prepare(
      "UPDATE public_paid_service_control SET new_settlement_enabled = 0 WHERE singleton_id = 1",
    ).run();
    const replay = await worker.fetch(request(), runtimeEnv);

    expect(fulfilled.status).toBe(200);
    expect(fulfilled.headers.get("X-SecondLook-Payment-State")).toBe("ambiguous");
    expect(fulfilled.headers.get("X-SecondLook-Ambiguity-Honored")).toBe("true");
    expect(fulfilled.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(fulfilled.headers.get("Idempotency-Replayed")).toBe("false");
    expect(replay.status).toBe(200);
    expect(replay.headers.get("X-SecondLook-Payment-State")).toBe("ambiguous");
    expect(replay.headers.get("X-SecondLook-Ambiguity-Honored")).toBe("true");
    expect(replay.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.json()).toEqual(fulfilledBody);
    expect(provider.attemptAcceptance).not.toHaveBeenCalled();
    expect(aiRun).toHaveBeenCalledOnce();
    expect(database.prepare("SELECT state FROM request_payments WHERE request_id = ?").get(requestId)).toEqual({ state: "ambiguous" });
    expect(database.prepare("SELECT state FROM commercial_payment_exposures WHERE request_id = ?").get(requestId)).toEqual({ state: "ambiguous" });
  });

  it("serializes concurrent signature-free ambiguity recovery to one inference", async () => {
    const requestId = "ambiguity-honor-concurrent";
    const key = "10000000-0000-4000-8000-0000000000a2";
    const input = { goal: "Review the concurrent ambiguous purchase.", proposed_action: "Perform the reviewed action." };
    const fingerprinted = await fingerprintSecondLookRequest(input, env(database), null);
    const keyHash = await sha256Hex(key);
    seedPaidRequest(database, requestId, "ambiguous", "reserved", nonce, true);
    database.prepare(
      `UPDATE idempotent_requests SET caller_key = ?, idempotency_key_hash = ?,
        request_hash = ?, execution_context = ? WHERE request_id = ?`,
    ).run(`paid:${keyHash}`, keyHash, fingerprinted.hash, fingerprinted.executionContext, requestId);
    database.prepare(
      `INSERT INTO paid_execution_admissions (
        request_id, state, admission_day, capacity_day, owner_token, lease_kind,
        lease_expires_at, settlement_authorized_at, created_at, updated_at
      ) VALUES (?, 'ambiguous', '2026-08-30', '2026-08-30', NULL, NULL, NULL, ?, ?, ?)`,
    ).run(requestId, now.toISOString(), now.toISOString(), now.toISOString());
    await ensurePaymentAmbiguityCase(env(database), requestId, now);

    let releaseAi;
    const aiRun = vi.fn(() => new Promise((resolve) => {
      releaseAi = () => resolve({ response: clearGateResponse() });
    }));
    const ai = Object.create(null);
    Object.defineProperty(ai, "run", { value: aiRun });
    const provider = { attemptAcceptance: vi.fn() };
    const worker = createWorker({ paymentAdapter: provider });
    const runtimeEnv = { ...env(database), AI: ai };
    const request = () => new Request("https://secondlook.example/v1/paid/second-look", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(input),
    });

    const firstPromise = worker.fetch(request(), runtimeEnv);
    await vi.waitFor(() => expect(aiRun).toHaveBeenCalledOnce());
    const concurrent = await worker.fetch(request(), runtimeEnv);

    expect(concurrent.status).toBe(409);
    expect(await concurrent.json()).toMatchObject({ code: "payment_request_processing" });
    expect(provider.attemptAcceptance).not.toHaveBeenCalled();
    expect(aiRun).toHaveBeenCalledOnce();

    releaseAi();
    const fulfilled = await firstPromise;
    const fulfilledBody = await fulfilled.json();
    const replay = await worker.fetch(request(), runtimeEnv);

    expect(fulfilled.status).toBe(200);
    expect(fulfilled.headers.get("X-SecondLook-Ambiguity-Honored")).toBe("true");
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.json()).toEqual(fulfilledBody);
    expect(provider.attemptAcceptance).not.toHaveBeenCalled();
    expect(aiRun).toHaveBeenCalledOnce();
  });

  it("derives the refund recipient from trusted chain evidence and verifies an exact later transfer", async () => {
    seedPaidRequest(database, "paid-on-chain", "ambiguous");
    await ensurePaymentAmbiguityCase(env(database), "paid-on-chain", now);
    await recordPaymentReconciliation(env(database), "paid-on-chain", await withTerminalFingerprint({
      classification: "confirmed_paid",
      source: "base_receipt",
      network: "eip155:8453",
      asset,
      transactionReference: transaction,
      blockNumber: 124,
      payer,
      authorizationNonce: nonce,
      recipient: seller,
      amountAtomic: "50000",
      authorizationLogIndex: 1,
      transferLogIndex: 2,
      reasonCode: "matching_authorization_and_transfer",
    }), "operator:paid-on-chain:confirm-1", now);
    await approveRefund(env(database), "paid-on-chain", "operator:paid-on-chain:approve-1", "service_unfulfilled", now);
    await approveRefund(env(database), "paid-on-chain", "operator:paid-on-chain:approve-1", "service_unfulfilled", now);
    await recordRefundSubmitted(env(database), "paid-on-chain", refundTransaction, "operator:paid-on-chain:submitted-1", now);
    await recordRefundSubmitted(env(database), "paid-on-chain", refundTransaction, "operator:paid-on-chain:submitted-1", now);
    await recordRefundEvidence(env(database), "paid-on-chain", {
      outcome: "confirmed",
      source: "base_receipt",
      evidenceFingerprint: fingerprint,
      network: "eip155:8453",
      asset,
      transactionReference: refundTransaction,
      blockNumber: 125,
      payer: seller,
      recipient: payer,
      amountAtomic: "50000",
      reasonCode: "exact_refund_transfer_confirmed",
    }, "operator:paid-on-chain:confirmed-1", now);
    await recordRefundEvidence(env(database), "paid-on-chain", {
      outcome: "confirmed",
      source: "base_receipt",
      evidenceFingerprint: fingerprint,
      network: "eip155:8453",
      asset,
      transactionReference: refundTransaction,
      blockNumber: 125,
      payer: seller,
      recipient: payer,
      amountAtomic: "50000",
      reasonCode: "exact_refund_transfer_confirmed",
    }, "operator:paid-on-chain:confirmed-1", now);

    expect(await readRemediationCase(env(database), "paid-on-chain")).toMatchObject({
      reconciliation_status: "confirmed_paid",
      chain_confirmed_payer: payer,
      remediation_status: "refund_confirmed",
      refund_recipient: payer,
      refund_transaction_reference: refundTransaction,
    });
    expect(database.prepare("SELECT state FROM request_payments WHERE request_id = ?").get("paid-on-chain").state).toBe("ambiguous");
  });

  it("supports failed manual refund evidence followed by a deliberate new approval", async () => {
    seedPaidRequest(database, "refund-retry", "accepted");
    await ensurePaidFulfillmentCase(env(database), "refund-retry", "unavailable", now);
    await approveRefund(env(database), "refund-retry", "operator:refund-retry:approve-1", "service_unavailable", now);
    await recordRefundSubmitted(env(database), "refund-retry", refundTransaction, "operator:refund-retry:submitted-1", now);
    await recordRefundEvidence(env(database), "refund-retry", {
      outcome: "failed",
      source: "base_receipt",
      evidenceFingerprint: fingerprint,
      network: "eip155:8453",
      asset,
      transactionReference: refundTransaction,
      blockNumber: 126,
      payer: seller,
      recipient: payer,
      amountAtomic: "50000",
      reasonCode: "receipt_failed",
    }, "operator:refund-retry:failed-1", now);
    await approveRefund(env(database), "refund-retry", "operator:refund-retry:approve-2", "manual_retry_approved", now);
    expect(await readRemediationCase(env(database), "refund-retry")).toMatchObject({
      remediation_status: "refund_approved",
      refund_recipient: payer,
      refund_transaction_reference: null,
    });
  });

  it("preserves remediation and accounting across seven-day lifecycle deletion", async () => {
    seedPaidRequest(database, "expired-paid", "accepted", "failed_before_inference");
    database.prepare("UPDATE idempotent_requests SET expires_at = 1 WHERE request_id = ?").run("expired-paid");
    await preserveRemediationBeforeExpiredLifecycleDeletion(env(database), 2, now);
    database.prepare("DELETE FROM idempotent_requests WHERE request_id = ?").run("expired-paid");

    expect(database.prepare("SELECT request_id FROM request_payments WHERE request_id = ?").get("expired-paid")).toBeUndefined();
    expect(database.prepare("SELECT request_id FROM commercial_payment_exposures WHERE request_id = ?").get("expired-paid")).toEqual({ request_id: "expired-paid" });
    expect(await readRemediationCase(env(database), "expired-paid")).toMatchObject({
      fulfillment_status: "recovery_available",
      reconciliation_status: "not_required",
    });
    expect(await events(database, "expired-paid")).toHaveLength(1);
  });

  it("releases only prospective value caps after proven nonpayment while retaining settlement-attempt history", async () => {
    seedPaidRequest(database, "old-ambiguous", "ambiguous");
    await ensurePaymentAmbiguityCase(env(database), "old-ambiguous", now);
    await recordPaymentReconciliation(env(database), "old-ambiguous", await withTerminalFingerprint({
      classification: "confirmed_not_paid",
      source: "base_authorization_cancellation",
      network: "eip155:8453",
      asset,
      transactionReference: transaction,
      blockNumber: 123,
      payer,
      authorizationNonce: nonce,
      authorizationLogIndex: 1,
      reasonCode: "authorization_canceled",
    }), "operator:old-ambiguous:cancellation-1", now);
    seedReservableRequest(database, "next-commercial", "lifecycle-owner", "admission-owner");
    await expect(reserveCommercialPaymentExposure(env(database), "next-commercial", "lifecycle-owner", "admission-owner", {
      requirement: { network: "eip155:8453", asset, amountAtomic: "50000", payTo: seller },
      facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
      configurationFingerprint: fingerprint,
      limits: {
        dailySettlementLimit: 2,
        dailyAcceptedPaymentLimit: 1,
        dailySettledAtomicLimit: 50000,
        monthlyFacilitatorLimit: 2,
        dailyPaidInferenceLimit: 1,
      },
    }, now)).resolves.toBeUndefined();
    expect(database.prepare("SELECT state FROM commercial_payment_exposures WHERE request_id = ?").get("next-commercial")).toEqual({ state: "reserved" });
    expect(database.prepare(
      "SELECT event_type FROM commercial_payment_events WHERE request_id = ? AND event_type = 'financial_exposure_reserved'",
    ).get("next-commercial")).toEqual({ event_type: "financial_exposure_reserved" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM commercial_payment_exposures WHERE admission_day = '2026-08-30'").get().count).toBe(2);
  });

  it("keeps remediation lifecycle-local while unrelated paid admission remains available", async () => {
    seedPaidRequest(database, "safe-nonpayment", "ambiguous");
    await ensurePaymentAmbiguityCase(env(database), "safe-nonpayment", now);
    await recordPaymentReconciliation(env(database), "safe-nonpayment", await withTerminalFingerprint({
      classification: "confirmed_not_paid",
      source: "base_authorization_cancellation",
      network: "eip155:8453",
      asset,
      transactionReference: transaction,
      blockNumber: 123,
      payer,
      authorizationNonce: nonce,
      authorizationLogIndex: 1,
      reasonCode: "authorization_canceled",
    }), "operator:safe-nonpayment:cancellation-1", now);
    seedReservableRequest(database, "admission-after-safe", "owner-after-safe");
    await expect(reservePaidSettlementAdmission(env(database), "admission-after-safe", "owner-after-safe", now)).resolves.toMatchObject({
      requestId: "admission-after-safe",
    });

    database.prepare("UPDATE paid_execution_admissions SET state = 'released', owner_token = NULL, lease_kind = NULL, lease_expires_at = NULL WHERE request_id = ?").run("admission-after-safe");
    seedPaidRequest(database, "refund-pending", "accepted", "reserved", `0x${"88".repeat(32)}`);
    await ensurePaidFulfillmentCase(env(database), "refund-pending", "unavailable", now);
    await approveRefund(env(database), "refund-pending", "operator:refund-pending:approve-1", "service_unavailable", now);
    await recordRefundSubmitted(env(database), "refund-pending", refundTransaction, "operator:refund-pending:submitted-1", now);
    database.prepare("UPDATE idempotent_requests SET state = 'completed', response_json = '{}', completed_at = ? WHERE request_id = ?")
      .run(now.toISOString(), "refund-pending");
    seedReservableRequest(database, "admission-blocked", "owner-blocked");
    await expect(reservePaidSettlementAdmission(env(database), "admission-blocked", "owner-blocked", now)).resolves.toMatchObject({
      requestId: "admission-blocked",
    });
  });

  it("race-safely bounds outstanding public obligations and frees capacity only after durable completion", async () => {
    database.prepare("UPDATE api_service_control SET global_concurrent_inference_limit = 10 WHERE singleton_id = 1").run();
    const requestIds = Array.from({ length: 6 }, (_, index) => `outstanding-${index + 1}`);
    for (const requestId of requestIds) seedReservableRequest(database, requestId, `owner-${requestId}`);
    const attempts = await Promise.allSettled(requestIds.map((requestId) =>
      reservePaidSettlementAdmission(env(database), requestId, `owner-${requestId}`, now, 5)));
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(5);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({
      reason: { code: "financial_capacity_reached" },
    });
    const ambiguous = database.prepare("SELECT request_id FROM paid_execution_admissions WHERE state = 'reserved' LIMIT 1").get().request_id;
    database.prepare(
      "UPDATE paid_execution_admissions SET state = 'ambiguous', owner_token = NULL, lease_kind = NULL, lease_expires_at = NULL WHERE request_id = ?",
    ).run(ambiguous);
    const candidate = requestIds.find((requestId) => !database.prepare(
      "SELECT 1 AS present FROM paid_execution_admissions WHERE request_id = ?",
    ).get(requestId));
    await expect(reservePaidSettlementAdmission(env(database), candidate, `owner-${candidate}`, now, 5)).rejects.toMatchObject({
      code: "financial_capacity_reached",
    });
    const admitted = database.prepare(
      "SELECT request_id FROM paid_execution_admissions WHERE state = 'reserved' AND request_id <> ? LIMIT 1",
    ).get(ambiguous).request_id;
    database.prepare(
      "UPDATE paid_execution_admissions SET state = 'consumed', owner_token = NULL, lease_kind = NULL, lease_expires_at = NULL WHERE request_id = ?",
    ).run(admitted);
    database.prepare(
      "UPDATE idempotent_requests SET state = 'completed', response_json = '{}', completed_at = ?, owner_token = NULL WHERE request_id = ?",
    ).run(now.toISOString(), admitted);
    await expect(reservePaidSettlementAdmission(env(database), candidate, `owner-${candidate}`, now, 5)).resolves.toMatchObject({ requestId: candidate });
  });

  it("isolates authoritative ambiguous paid inference state without requiring a remediation projection", async () => {
    seedConsumedPaidInference(database, "inference-ambiguous-no-projection", "ambiguous");
    expect(database.prepare("SELECT 1 FROM payment_remediation_cases WHERE request_id = ?").get("inference-ambiguous-no-projection")).toBeUndefined();
    seedReservableRequest(database, "blocked-after-inference-ambiguity", "owner-blocked");
    await expect(reservePaidSettlementAdmission(
      env(database), "blocked-after-inference-ambiguity", "owner-blocked", now, 5,
    )).resolves.toMatchObject({ requestId: "blocked-after-inference-ambiguity" });
  });

  it("treats stale and fresh inference work as lifecycle-local bounded obligations", async () => {
    const staleAt = new Date(now.getTime() - 61_000).toISOString();
    seedConsumedPaidInference(database, "stale-inference-no-projection", "inference_running", staleAt);
    seedReservableRequest(database, "blocked-after-stale-inference", "owner-stale");
    await expect(reservePaidSettlementAdmission(
      env(database), "blocked-after-stale-inference", "owner-stale", now, 5,
    )).resolves.toMatchObject({ requestId: "blocked-after-stale-inference" });

    database = migratedDatabase();
    database.prepare("UPDATE api_service_control SET global_concurrent_inference_limit = 10 WHERE singleton_id = 1").run();
    seedConsumedPaidInference(database, "fresh-active-inference", "inference_running", now.toISOString());
    seedReservableRequest(database, "allowed-with-fresh-inference", "owner-fresh");
    await expect(reservePaidSettlementAdmission(
      env(database), "allowed-with-fresh-inference", "owner-fresh", now, 5,
    )).resolves.toMatchObject({ requestId: "allowed-with-fresh-inference" });
  });

  it("keeps unsigned settlement negotiation available during an unrelated paid inference incident", async () => {
    seedConsumedPaidInference(database, "preflight-inference-incident", "ambiguous");
    await expect(assertPaidSettlementAvailability(env(database), 5, now)).resolves.toBeUndefined();
  });

  it("repairs capability-bound stale processing without sales configuration and leaves fresh processing in progress", async () => {
    const key = "10000000-0000-4000-8000-0000000000f1";
    const staleAt = new Date(now.getTime() - 61_000).toISOString();
    const stale = await seedCapabilityBoundProcessing(database, "historical-stale-processing", key, staleAt);
    await expect(reserveExistingPaidIdempotentRequest(
      env(database), stale.auth, key, `${stale.requestHash}-wrong`, "{}", now,
    )).rejects.toMatchObject({ code: "idempotency_key_conflict", retryable: false });
    expect(database.prepare("SELECT state FROM request_payments WHERE request_id = ?").get("historical-stale-processing")).toEqual({ state: "processing" });
    await expect(reserveExistingPaidIdempotentRequest(
      env(database), stale.auth, key, stale.requestHash, "{}", now,
    )).rejects.toMatchObject({ code: "payment_ambiguous", retryable: false });
    expect(database.prepare("SELECT state FROM request_payments WHERE request_id = ?").get("historical-stale-processing")).toEqual({ state: "ambiguous" });
    expect(database.prepare("SELECT state FROM paid_execution_admissions WHERE request_id = ?").get("historical-stale-processing")).toEqual({ state: "ambiguous" });

    database = migratedDatabase();
    const fresh = await seedCapabilityBoundProcessing(database, "historical-fresh-processing", key, now.toISOString());
    await expect(reserveExistingPaidIdempotentRequest(
      env(database), fresh.auth, key, fresh.requestHash, "{}", now,
    )).rejects.toMatchObject({ code: "payment_in_progress", retryable: true });
    expect(database.prepare("SELECT state FROM request_payments WHERE request_id = ?").get("historical-fresh-processing")).toEqual({ state: "processing" });
  });

  it("counts ambiguity-honored judgments against the dedicated paid-inference fuse", async () => {
    seedPaidRequest(database, "ambiguity-paid-inference", "ambiguous", "reserved", nonce, true);
    database.prepare(
      `INSERT INTO paid_execution_admissions (
        request_id, state, admission_day, capacity_day, owner_token, lease_kind,
        lease_expires_at, settlement_authorized_at, created_at, updated_at
      ) VALUES (?, 'ambiguous', '2026-08-30', '2026-08-30', NULL, NULL, NULL, ?, ?, ?)`,
    ).run("ambiguity-paid-inference", now.toISOString(), now.toISOString(), now.toISOString());
    await ensurePaymentAmbiguityCase(env(database), "ambiguity-paid-inference", now);
    await expect(authorizePublicMainnetAmbiguityFulfillment(
      env(database), "ambiguity-paid-inference", now,
    )).resolves.toBe(true);

    await expect(assertCommercialPaymentCapacity(env(database), commercialContext({
      dailySettlementLimit: 10,
      dailyAcceptedPaymentLimit: 10,
      dailySettledAtomicLimit: 500000,
      monthlyFacilitatorLimit: 10,
      dailyPaidInferenceLimit: 1,
    }), now)).rejects.toMatchObject({ code: "financial_capacity_reached" });
  });

  it("ignores only safely releasable stale commercial reservations during read-only preflight", async () => {
    seedReservableRequest(database, "stale-safe-commercial", "lifecycle-stale", "admission-stale");
    await reserveCommercialPaymentExposure(
      env(database), "stale-safe-commercial", "lifecycle-stale", "admission-stale",
      commercialContext({ dailySettlementLimit: 1, dailyAcceptedPaymentLimit: 1, dailySettledAtomicLimit: 50000, monthlyFacilitatorLimit: 1, dailyPaidInferenceLimit: 1 }),
      now,
    );
    database.prepare("UPDATE paid_execution_admissions SET lease_expires_at = ? WHERE request_id = ?")
      .run(Math.floor(now.getTime() / 1000) - 1, "stale-safe-commercial");
    await expect(assertCommercialPaymentCapacity(
      env(database), commercialContext({ dailySettlementLimit: 1, dailyAcceptedPaymentLimit: 1, dailySettledAtomicLimit: 50000, monthlyFacilitatorLimit: 1, dailyPaidInferenceLimit: 1 }), now,
    )).resolves.toBeUndefined();
    expect(database.prepare("SELECT state FROM commercial_payment_exposures WHERE request_id = ?").get("stale-safe-commercial")).toEqual({ state: "reserved" });

    database = migratedDatabase();
    seedReservableRequest(database, "fresh-unsafe-commercial", "lifecycle-fresh", "admission-fresh");
    await reserveCommercialPaymentExposure(
      env(database), "fresh-unsafe-commercial", "lifecycle-fresh", "admission-fresh",
      commercialContext({ dailySettlementLimit: 1, dailyAcceptedPaymentLimit: 1, dailySettledAtomicLimit: 50000, monthlyFacilitatorLimit: 1, dailyPaidInferenceLimit: 1 }),
      now,
    );
    await expect(assertCommercialPaymentCapacity(
      env(database), commercialContext({ dailySettlementLimit: 1, dailyAcceptedPaymentLimit: 1, dailySettledAtomicLimit: 50000, monthlyFacilitatorLimit: 1, dailyPaidInferenceLimit: 1 }), now,
    )).rejects.toMatchObject({ code: "financial_capacity_reached" });
  });

  it("refuses nonrefund closure without established nonpayment or completed fulfillment", async () => {
    seedPaidRequest(database, "still-open", "ambiguous");
    await ensurePaymentAmbiguityCase(env(database), "still-open", now);
    await expect(closeEligibleWithoutRefund(
      env(database), "still-open", "operator:still-open:close-1", "operator_review", now,
    )).rejects.toThrow("not eligible");
  });
});
