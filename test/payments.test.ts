import { describe, expect, it, vi } from "vitest";
import {
  authorizeCommercialSettlement,
  createCommercialPaymentContext,
  reserveCommercialPaymentExposure,
} from "../src/commercial-accounting";
import {
  markInferenceAmbiguous,
  markInferenceRunning,
  markPaidInferenceRunning,
  reserveIdempotentRequest,
} from "../src/idempotency";
import {
  attemptPaymentAcceptance,
  cleanupAbandonedCommercialReservations,
  createPaymentRequirement,
  type PaymentAttemptResult,
  type PaymentProviderAdapter,
} from "../src/payments";
import { reservePaidSettlementAdmission } from "../src/operations";
import type { AppEnv } from "../src/types";

type LifecycleRow = {
  request_id: string;
  caller_key: string;
  idempotency_key_hash: string;
  request_hash: string;
  state: string;
  owner_token: string | null;
  response_json: string | null;
  updated_at: string;
};

type PaymentRow = {
  request_id: string;
  provider: string;
  protocol: string;
  state: string;
  amount_atomic: string;
  asset: string;
  network: string;
  pay_to: string;
  payment_requirements_json: string;
  payment_proof_fingerprint: string | null;
  authorization_payer: string | null;
  authorization_nonce: string | null;
  payer_identity: string | null;
  external_reference: string | null;
  failure_code: string | null;
  attempt_owner_token: string | null;
  attempt_started_at: string | null;
  verified_at: string | null;
  settled_at: string | null;
  updated_at: string;
};

type AdmissionRow = {
  request_id: string;
  state: string;
  owner_token: string | null;
  lease_kind: string | null;
  lease_expires_at: number | null;
  capacity_day: string;
};

type CommercialExposureRow = {
  request_id: string;
  state: string;
  admission_day: string;
  admission_month: string;
  amount_atomic: string;
  settlement_authorized_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

function paymentDb(options: { authorizeDuringCleanupSelection?: boolean } = {}): D1Database & {
  lifecycleState(requestId: string): string | undefined;
  paymentState(requestId: string): string | undefined;
  admissionState(requestId: string): string | undefined;
  commercialState(requestId: string): string | undefined;
  commercialEvents(requestId: string): string[];
  forcePaymentProcessing(requestId: string, updatedAt: string, admissionState: "reserved" | "settling"): void;
  forceAdmissionSettling(requestId: string): void;
  expireAdmission(requestId: string, at: Date): void;
  forceAdmissionState(requestId: string, state: string): void;
  forceCommercialState(requestId: string, state: string): void;
  removeCommercialEvent(requestId: string, eventType: string): void;
} {
  const lifecycles = new Map<string, LifecycleRow>();
  const payments = new Map<string, PaymentRow>();
  const admissions = new Map<string, AdmissionRow>();
  const commercialExposures = new Map<string, CommercialExposureRow>();
  const commercialEvents = new Map<string, { request_id: string; event_type: string }>();

  const statement = (sql: string) => {
    let values: unknown[] = [];
    const prepared = {
      bind: (...bound: unknown[]) => { values = bound; return prepared; },
      all: async () => {
        if (!sql.includes("FROM commercial_payment_exposures exposure")) return { results: [] };
        const cutoff = Number(values[0]);
        const paymentStaleBefore = values[1] as string;
        const limit = Number(values[2]);
        const candidates = [...commercialExposures.values()]
          .filter((exposure) => {
            const payment = payments.get(exposure.request_id);
            const admission = admissions.get(exposure.request_id);
            return exposure.state === "reserved"
              && exposure.settlement_authorized_at === null
              && (
                payment?.state === "required"
                || (payment?.state === "processing"
                  && payment.updated_at <= paymentStaleBefore
                  && payment.attempt_owner_token === admission?.owner_token)
              )
              && admission?.state === "reserved"
              && admission.owner_token !== null
              && admission.lease_kind === "settlement"
              && (admission.lease_expires_at ?? Number.POSITIVE_INFINITY) <= cutoff;
          })
          .sort((left, right) => left.updated_at.localeCompare(right.updated_at) || left.request_id.localeCompare(right.request_id))
          .slice(0, limit);
        if (options.authorizeDuringCleanupSelection && candidates[0]) {
          const requestId = candidates[0].request_id;
          const payment = payments.get(requestId)!;
          const admission = admissions.get(requestId)!;
          const exposure = commercialExposures.get(requestId)!;
          payment.state = "processing";
          payment.attempt_owner_token = admission.owner_token;
          payment.updated_at = "2026-08-29T11:00:00.000Z";
          admission.state = "settling";
          exposure.state = "authorized";
          exposure.settlement_authorized_at = "2026-08-29T11:00:01.000Z";
        }
        return { results: candidates.map(({ request_id }) => ({ request_id })) };
      },
      first: async () => {
        if (sql.includes("FROM commercial_payment_exposures exposure")) {
          const exposure = commercialExposures.get(values[0] as string);
          const payment = payments.get(values[2] as string);
          const admission = admissions.get(values[4] as string);
          const event = [...commercialEvents.values()].find((row) => row.request_id === values[1] && row.event_type === "settlement_authorized");
          return exposure?.state === "authorized" && payment?.state === "processing" && payment.attempt_owner_token === values[3]
            && admission?.state === "settling" && admission.owner_token === values[5] && event ? { request_id: exposure.request_id } : null;
        }
        if (sql.includes("FROM commercial_payment_events")) {
          const event = [...commercialEvents.values()].find((row) => row.request_id === values[0] && row.event_type === values[1]);
          return event ? { event_id: `${event.request_id}:${event.event_type}` } : null;
        }
        if (sql.includes("FROM commercial_payment_exposures")) {
          const row = commercialExposures.get(values[0] as string);
          return row ? { ...row } : null;
        }
        if (sql.includes("FROM api_service_control")) return {
          inference_enabled: 1, global_daily_inference_limit: 250, global_concurrent_inference_limit: 3,
          provider_failure_threshold: 3, provider_circuit_seconds: 60, circuit_open_until: null,
        };
        if (sql.includes("FROM request_payments")) {
          if (sql.includes("payment_proof_fingerprint = ? AND request_id <> ?")) {
            const row = [...payments.values()].find(
              (candidate) => candidate.payment_proof_fingerprint === values[0] && candidate.request_id !== values[1],
            );
            return row ? { request_id: row.request_id } : null;
          }
          if (sql.includes("authorization_payer = ?")) {
            const row = [...payments.values()].find((candidate) =>
              candidate.authorization_payer === values[2] && candidate.authorization_nonce === values[3] && candidate.request_id !== values[4]);
            return row ? { request_id: row.request_id } : null;
          }
          if (sql.includes("state = 'ambiguous'")) {
            const row = [...payments.values()].find((candidate) => candidate.state === "ambiguous");
            return row ? { request_id: row.request_id } : null;
          }
          if (sql.includes("JOIN idempotent_requests")) return null;
          const row = payments.get(values[0] as string);
          return row ? { ...row } : null;
        }
        if (sql.includes("FROM paid_execution_admissions")) {
          const row = admissions.get(values[0] as string);
          return row ? { ...row } : null;
        }
        if (sql.includes(" AS used")) return { used: 0 };
        if (sql.includes("FROM idempotent_requests")) {
          const row = [...lifecycles.values()].find(
            (candidate) => candidate.caller_key === values[0] && candidate.idempotency_key_hash === values[1],
          );
          return row ? { ...row } : null;
        }
        return null;
      },
      run: async () => {
        let changes = 1;
        if (sql.startsWith("INSERT INTO commercial_payment_exposures")) {
          const requestId = values[0] as string;
          const day = values[1] as string;
          const month = values[2] as string;
          const amount = Number(values[5]);
          const existing = [...commercialExposures.values()].filter((row) => row.request_id !== requestId);
          const allowed = existing.filter((row) => row.admission_day === day && ["reserved", "authorized", "accepted", "ambiguous", "failed"].includes(row.state)).length < Number(values[31])
            && existing.filter((row) => row.admission_day === day && ["reserved", "authorized", "accepted", "ambiguous"].includes(row.state)).length < Number(values[34])
            && existing.filter((row) => row.admission_day === day && ["reserved", "authorized", "accepted", "ambiguous"].includes(row.state)).reduce((sum, row) => sum + Number(row.amount_atomic), 0) + amount <= Number(values[38])
            && existing.filter((row) => row.admission_month === month && ["reserved", "authorized", "accepted", "ambiguous", "failed"].includes(row.state)).length < Number(values[41])
            && existing.filter((row) => row.admission_day === day && ["reserved", "authorized", "accepted"].includes(row.state)).length < Number(values[44]);
          const current = commercialExposures.get(requestId);
          if (!allowed || (current && current.state !== "released")) changes = 0;
          else commercialExposures.set(requestId, {
            request_id: requestId,
            state: "reserved",
            admission_day: day,
            admission_month: month,
            amount_atomic: values[5] as string,
            settlement_authorized_at: null,
            resolved_at: null,
            created_at: values[17] as string,
            updated_at: values[18] as string,
          });
        } else if (sql.startsWith("INSERT OR IGNORE INTO commercial_payment_events")) {
          const [eventId, eventType, , , , , requestId] = values as string[];
          if (commercialEvents.has(eventId) || !commercialExposures.has(requestId)) changes = 0;
          else commercialEvents.set(eventId, { request_id: requestId, event_type: eventType });
        } else if (sql.includes("commercial_payment_exposures SET state = 'authorized'")) {
          const requestId = values[2] as string;
          const exposure = commercialExposures.get(requestId);
          const payment = payments.get(requestId);
          const admission = admissions.get(requestId);
          if (!exposure || exposure.state !== "reserved" || payment?.state !== "processing" || admission?.state !== "settling") changes = 0;
          else {
            exposure.state = "authorized";
            exposure.settlement_authorized_at = values[0] as string;
            exposure.updated_at = values[1] as string;
          }
        } else if (sql.includes("commercial_payment_exposures SET state = 'released'")) {
          const requestId = values[2] as string;
          const exposure = commercialExposures.get(requestId);
          if (!exposure || exposure.state !== "reserved") changes = 0;
          else {
            exposure.state = "released";
            exposure.resolved_at = values[0] as string;
            exposure.updated_at = values[1] as string;
          }
        } else if (sql.includes("commercial_payment_exposures SET state = ?, accepted_at")) {
          const [state, , , , requestId] = values as string[];
          const exposure = commercialExposures.get(requestId);
          if (!exposure || !["reserved", "authorized", state].includes(exposure.state)) changes = 0;
          else exposure.state = state;
        } else if (sql.startsWith("DELETE FROM idempotent_requests")) {
          changes = 0;
        } else if (sql.includes("INSERT OR IGNORE INTO idempotent_requests")) {
          const [requestId, caller, key, requestHash, , owner, created] = values as string[];
          const existing = [...lifecycles.values()].some(
            (row) => row.caller_key === caller && row.idempotency_key_hash === key,
          );
          if (existing) changes = 0;
          else lifecycles.set(requestId, {
            request_id: requestId,
            caller_key: caller,
            idempotency_key_hash: key,
            request_hash: requestHash,
            state: "reserved",
            owner_token: owner,
            response_json: null,
            updated_at: created,
          });
        } else if (sql.includes("INSERT OR IGNORE INTO request_payments")) {
          const [requestId, provider, protocol, amount, asset, network, payTo, requirementsJson, , updated, lifecycleId, owner] = values as string[];
          const lifecycle = lifecycles.get(lifecycleId);
          if (payments.has(requestId) || !lifecycle || lifecycle.state !== "reserved" || lifecycle.owner_token !== owner) changes = 0;
          else payments.set(requestId, {
            request_id: requestId,
            provider,
            protocol,
            state: "required",
            amount_atomic: amount,
            asset,
            network,
            pay_to: payTo,
            payment_requirements_json: requirementsJson,
            payment_proof_fingerprint: null,
            authorization_payer: null,
            authorization_nonce: null,
            payer_identity: null,
            external_reference: null,
            failure_code: null,
            attempt_owner_token: null,
            attempt_started_at: null,
            verified_at: null,
            settled_at: null,
            updated_at: updated,
          });
        } else if (sql.includes("INSERT OR IGNORE INTO paid_execution_admissions")) {
          const [requestId, day, , owner, expires] = values as [string, string, string, string, number];
          if (admissions.has(requestId)) changes = 0;
          else admissions.set(requestId, { request_id: requestId, state: "reserved", owner_token: owner, lease_kind: "settlement", lease_expires_at: expires, capacity_day: day });
        } else if (sql.includes("paid_execution_admissions SET state = 'reserved'")) {
          changes = 0;
        } else if (sql.includes("SET state = 'processing'")) {
          const [attemptOwner, started, proofFingerprint, authorizationPayer, authorizationNonce, , requestId, , lifecycleId, lifecycleOwner, admissionId, admissionOwner] = values as string[];
          const payment = payments.get(requestId);
          const lifecycle = lifecycles.get(lifecycleId);
          const admission = admissions.get(admissionId);
          if (!payment || payment.state !== "required" || !lifecycle || lifecycle.state !== "reserved" || lifecycle.owner_token !== lifecycleOwner || !admission || admission.state !== "reserved" || admission.owner_token !== admissionOwner) changes = 0;
          else {
            payment.state = "processing";
            payment.payment_proof_fingerprint = proofFingerprint;
            payment.authorization_payer = authorizationPayer;
            payment.authorization_nonce = authorizationNonce;
            payment.attempt_owner_token = attemptOwner;
            payment.attempt_started_at = started;
            payment.updated_at = started;
          }
        } else if (sql.includes("paid_execution_admissions SET state = 'settling'")) {
          const [, , requestId, owner] = values as string[];
          const admission = admissions.get(requestId);
          if (!admission || admission.state !== "reserved" || admission.owner_token !== owner) changes = 0;
          else admission.state = "settling";
        } else if (sql.includes("paid_execution_admissions SET state = ?")) {
          const [state, paymentState, , lifecycleOwner, , , , , expires, , requestId, attemptOwner] = values as Array<string | number>;
          const admission = admissions.get(requestId as string);
          if (!admission || admission.state !== "settling" || admission.owner_token !== attemptOwner) changes = 0;
          else {
            admission.state = state as string;
            admission.owner_token = paymentState === "accepted" ? lifecycleOwner as string : null;
            admission.lease_kind = paymentState === "accepted" ? "inference" : null;
            admission.lease_expires_at = paymentState === "accepted" ? expires as number : null;
          }
        } else if (sql.includes("paid_execution_admissions SET state = 'released'")) {
          const requestId = values[1] as string;
          const admission = admissions.get(requestId);
          const payment = payments.get(requestId);
          const repairsFailedPayment = sql.includes("request_payments WHERE request_id = ? AND state = 'failed'");
          if (!admission || (repairsFailedPayment ? admission.state !== "settling" || payment?.state !== "failed" : admission.state !== "reserved")) changes = 0;
          else { admission.state = "released"; admission.owner_token = null; admission.lease_kind = null; admission.lease_expires_at = null; }
        } else if (sql.includes("failure_code = 'stale_payment_processing'")) {
          const [updated, requestId, owner, staleBefore] = values as string[];
          const payment = payments.get(requestId);
          const admission = admissions.get(requestId);
          if (!payment || payment.state !== "processing" || payment.attempt_owner_token !== owner || payment.updated_at > staleBefore || admission?.state !== "settling" || admission.owner_token !== owner) changes = 0;
          else {
            payment.state = "ambiguous";
            payment.failure_code = "stale_payment_processing";
            payment.attempt_owner_token = null;
            payment.updated_at = updated;
          }
        } else if (sql.includes("paid_execution_admissions SET state = 'ambiguous'")) {
          const requestId = values[1] as string;
          const admission = admissions.get(requestId);
          if (!admission || admission.state !== "settling") changes = 0;
          else { admission.state = "ambiguous"; admission.owner_token = null; admission.lease_kind = null; admission.lease_expires_at = null; }
        } else if (sql.includes("request_payments SET state = 'failed'")) {
          const [failureCode, updated, requestId, owner] = values as string[];
          const payment = payments.get(requestId);
          if (!payment || payment.state !== "processing" || payment.attempt_owner_token !== owner) changes = 0;
          else {
            payment.state = "failed";
            payment.failure_code = failureCode;
            payment.attempt_owner_token = null;
            payment.updated_at = updated;
          }
        } else if (sql.includes("request_payments SET state = 'required'")) {
          const [updated, requestId, owner] = values as string[];
          const payment = payments.get(requestId);
          if (!payment || payment.state !== "processing" || payment.attempt_owner_token !== owner) changes = 0;
          else {
            payment.state = "required";
            payment.failure_code = "settlement_not_authorized";
            payment.payment_proof_fingerprint = null;
            payment.authorization_payer = null;
            payment.authorization_nonce = null;
            payment.attempt_owner_token = null;
            payment.updated_at = updated;
          }
        } else if (sql.includes("request_payments SET state = 'ambiguous'")) {
          const [payer, externalReference, failureCode, verifiedAt, updated, requestId, owner] = values as Array<string | null>;
          const payment = payments.get(requestId as string);
          if (!payment || payment.state !== "processing" || payment.attempt_owner_token !== owner) changes = 0;
          else {
            payment.state = "ambiguous";
            payment.payer_identity = payer;
            payment.external_reference = externalReference;
            payment.failure_code = failureCode;
            payment.verified_at = verifiedAt;
            payment.attempt_owner_token = null;
            payment.updated_at = updated as string;
          }
        } else if (sql.includes("request_payments SET state = 'accepted'")) {
          const [payer, externalReference, verifiedAt, settledAt, updated, requestId, owner] = values as string[];
          const payment = payments.get(requestId);
          const referenceUsed = [...payments.values()].some(
            (candidate) => candidate.request_id !== requestId && candidate.provider === payment?.provider && candidate.external_reference === externalReference,
          );
          if (!payment || payment.state !== "processing" || payment.attempt_owner_token !== owner || referenceUsed) changes = 0;
          else {
            payment.state = "accepted";
            payment.payer_identity = payer;
            payment.external_reference = externalReference;
            payment.failure_code = null;
            payment.verified_at = verifiedAt;
            payment.settled_at = settledAt;
            payment.attempt_owner_token = null;
            payment.updated_at = updated;
          }
        } else if (sql.includes("SET state = 'inference_running'") && sql.includes("FROM request_payments")) {
          const [started, , requestId, owner] = values as string[];
          const lifecycle = lifecycles.get(requestId);
          const payment = payments.get(requestId);
          if (!lifecycle || lifecycle.state !== "reserved" || lifecycle.owner_token !== owner || payment?.state !== "accepted") changes = 0;
          else {
            lifecycle.state = "inference_running";
            lifecycle.updated_at = started;
          }
        } else if (sql.includes("SET state = 'inference_running'")) {
          const [started, , requestId, owner] = values as string[];
          const lifecycle = lifecycles.get(requestId);
          if (!lifecycle || lifecycle.state !== "reserved" || lifecycle.owner_token !== owner) changes = 0;
          else {
            lifecycle.state = "inference_running";
            lifecycle.updated_at = started;
          }
        } else if (sql.includes("idempotent_requests SET state = 'ambiguous'")) {
          const [, updated, requestId, owner] = values as string[];
          const lifecycle = lifecycles.get(requestId);
          if (!lifecycle || lifecycle.state !== "inference_running" || lifecycle.owner_token !== owner) changes = 0;
          else {
            lifecycle.state = "ambiguous";
            lifecycle.owner_token = null;
            lifecycle.updated_at = updated;
          }
        } else {
          changes = 0;
        }
        return { success: true, meta: { changes } };
      },
    };
    return prepared;
  };

  const db = Object.create(null) as D1Database;
  Object.defineProperty(db, "prepare", { value: vi.fn(statement) });
  return Object.assign(db, {
    lifecycleState: (requestId: string) => lifecycles.get(requestId)?.state,
    paymentState: (requestId: string) => payments.get(requestId)?.state,
    admissionState: (requestId: string) => admissions.get(requestId)?.state,
    commercialState: (requestId: string) => commercialExposures.get(requestId)?.state,
    commercialEvents: (requestId: string) => [...commercialEvents.values()].filter((row) => row.request_id === requestId).map((row) => row.event_type),
    forcePaymentProcessing: (requestId: string, updatedAt: string, admissionState: "reserved" | "settling") => {
      const payment = payments.get(requestId);
      if (!payment) throw new Error("Payment not found.");
      const owner = "lost-owner";
      payment.state = "processing";
      payment.payment_proof_fingerprint = "proof-fingerprint";
      payment.authorization_payer = authorizationIdentity.payer;
      payment.authorization_nonce = authorizationIdentity.nonce;
      payment.attempt_owner_token = owner;
      payment.attempt_started_at = updatedAt;
      payment.updated_at = updatedAt;
      admissions.set(requestId, {
        request_id: requestId,
        state: admissionState,
        owner_token: owner,
        lease_kind: "settlement",
        lease_expires_at: Math.floor(new Date(updatedAt).getTime() / 1000) + 30,
        capacity_day: updatedAt.slice(0, 10),
      });
    },
    forceAdmissionSettling: (requestId: string) => {
      const admission = admissions.get(requestId);
      if (!admission) throw new Error("Admission not found.");
      admission.state = "settling";
      admission.owner_token = "crashed-owner";
      admission.lease_kind = "settlement";
      admission.lease_expires_at = Math.floor(Date.now() / 1000) + 30;
    },
    expireAdmission: (requestId: string, at: Date) => {
      const admission = admissions.get(requestId);
      if (!admission) throw new Error("Admission not found.");
      admission.lease_expires_at = Math.floor(at.getTime() / 1000) - 1;
    },
    forceAdmissionState: (requestId: string, state: string) => {
      const admission = admissions.get(requestId);
      if (!admission) throw new Error("Admission not found.");
      admission.state = state;
      if (["accepted", "ambiguous", "consumed", "released"].includes(state)) {
        admission.owner_token = null;
        admission.lease_kind = null;
        admission.lease_expires_at = null;
      }
    },
    forceCommercialState: (requestId: string, state: string) => {
      const exposure = commercialExposures.get(requestId);
      if (!exposure) throw new Error("Commercial exposure not found.");
      exposure.state = state;
      if (["authorized", "accepted", "ambiguous", "failed"].includes(state)) {
        exposure.settlement_authorized_at ??= "2026-08-29T11:00:01.000Z";
      }
    },
    removeCommercialEvent: (requestId: string, eventType: string) => {
      commercialEvents.delete(`${requestId}:${eventType}`);
    },
  });
}

const requirement = {
  provider: "mock-provider",
  protocol: "mock-v1",
  amountAtomic: "1000",
  asset: "TEST-USD",
  network: "test-network",
  payTo: "test-recipient",
  requirementsJson: "{\"scheme\":\"mock\"}",
};

const acceptedResult: PaymentAttemptResult = {
  outcome: "accepted",
  payerIdentity: "0x1111111111111111111111111111111111111111",
  externalReference: "payment-1",
  verifiedAt: "2026-08-28T18:00:01.000Z",
  settledAt: "2026-08-28T18:00:02.000Z",
};
const authorizationIdentity = {
  payer: "0x1111111111111111111111111111111111111111",
  nonce: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

async function reserve(env: AppEnv, key: string) {
  const reservation = await reserveIdempotentRequest(env, { kind: "internal" }, key, "request-hash", "execution-context");
  if (reservation.kind !== "acquired") throw new Error("Expected lifecycle ownership.");
  await createPaymentRequirement(env, reservation.requestId, reservation.ownerToken, requirement);
  return reservation;
}

function adapter(result: PaymentAttemptResult): PaymentProviderAdapter<string> & { attemptAcceptance: ReturnType<typeof vi.fn> } {
  return { attemptAcceptance: vi.fn(async () => result) };
}

function commercialContext() {
  return createCommercialPaymentContext({
    requirement,
    facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
    limits: {
      dailySettlementLimit: 100,
      dailyAcceptedPaymentLimit: 100,
      dailySettledAtomicLimit: 100_000,
      monthlyFacilitatorLimit: 100,
      dailyPaidInferenceLimit: 100,
    },
  });
}

async function reserveCommercialOnly(env: AppEnv, key: string, now: Date) {
  const lifecycle = await reserve(env, key);
  const admission = await reservePaidSettlementAdmission(env, lifecycle.requestId, lifecycle.ownerToken, now);
  await reserveCommercialPaymentExposure(
    env,
    lifecycle.requestId,
    lifecycle.ownerToken,
    admission.ownerToken,
    await commercialContext(),
    now,
  );
  return lifecycle;
}

describe("durable payment-ready boundary", () => {
  it("accepts at most one payment and reuses the durable acceptance without calling the adapter again", async () => {
    const db = paymentDb();
    const env = { DB: db } as unknown as AppEnv;
    const lifecycle = await reserve(env, "payment-once-01");
    const provider = adapter(acceptedResult);

    const first = await attemptPaymentAcceptance(env, lifecycle.requestId, lifecycle.ownerToken, "proof-fingerprint", authorizationIdentity, "proof", provider);
    const replay = await attemptPaymentAcceptance(env, lifecycle.requestId, lifecycle.ownerToken, "proof-fingerprint", authorizationIdentity, "proof", provider);

    expect(first.kind).toBe("accepted");
    expect(replay.kind).toBe("already_accepted");
    expect(provider.attemptAcceptance).toHaveBeenCalledOnce();
    expect(db.paymentState(lifecycle.requestId)).toBe("accepted");
  });

  it("crosses execution and commercial authorization boundaries before the one facilitator call", async () => {
    const db = paymentDb();
    const env = { DB: db } as unknown as AppEnv;
    const lifecycle = await reserve(env, "commercial-payment-order-01");
    const commercial = await createCommercialPaymentContext({
      requirement,
      facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
      limits: {
        dailySettlementLimit: 1,
        dailyAcceptedPaymentLimit: 1,
        dailySettledAtomicLimit: 1000,
        monthlyFacilitatorLimit: 1,
        dailyPaidInferenceLimit: 1,
      },
    });
    const provider: PaymentProviderAdapter<string> = {
      attemptAcceptance: vi.fn(async () => {
        expect(db.paymentState(lifecycle.requestId)).toBe("processing");
        expect(db.admissionState(lifecycle.requestId)).toBe("settling");
        expect(db.commercialState(lifecycle.requestId)).toBe("authorized");
        expect(db.commercialEvents(lifecycle.requestId)).toContain("settlement_authorized");
        return acceptedResult;
      }),
    };

    await expect(attemptPaymentAcceptance(
      env, lifecycle.requestId, lifecycle.ownerToken, "commercial-proof", authorizationIdentity,
      "proof", provider, new Date("2026-08-29T12:00:00.000Z"), commercial,
    )).resolves.toMatchObject({ kind: "accepted" });
    expect(provider.attemptAcceptance).toHaveBeenCalledOnce();
    expect(db.commercialState(lifecycle.requestId)).toBe("accepted");
    expect(db.commercialEvents(lifecycle.requestId)).toEqual([
      "financial_exposure_reserved", "settlement_authorized", "settlement_accepted",
    ]);
  });

  it("lazily releases abandoned required and processing reservations and restores financial capacity", async () => {
    const db = paymentDb();
    const env = { DB: db } as unknown as AppEnv;
    const reserved = await reserveCommercialOnly(env, "abandoned-required-01", new Date("2026-08-29T10:00:00.000Z"));
    const processing = await reserveCommercialOnly(env, "abandoned-processing-01", new Date("2026-08-29T10:01:00.000Z"));
    db.forcePaymentProcessing(processing.requestId, "2026-08-29T10:01:00.000Z", "reserved");
    db.removeCommercialEvent(reserved.requestId, "financial_exposure_reserved");

    await cleanupAbandonedCommercialReservations(env, new Date("2026-08-29T10:03:00.000Z"));

    for (const requestId of [reserved.requestId, processing.requestId]) {
      expect(db.paymentState(requestId)).toBe("required");
      expect(db.admissionState(requestId)).toBe("released");
      expect(db.commercialState(requestId)).toBe("released");
      expect(db.commercialEvents(requestId)).toEqual([
        "financial_exposure_reserved", "financial_exposure_released",
      ]);
    }

    const replacement = await reserveCommercialOnly(env, "replacement-after-cleanup-01", new Date("2026-08-29T10:03:01.000Z"));
    expect(db.commercialState(replacement.requestId)).toBe("reserved");
  });

  it("bounds lazy abandoned-reservation cleanup to eight candidates per admission attempt", async () => {
    const db = paymentDb();
    const env = { DB: db } as unknown as AppEnv;
    const requestIds: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      const lifecycle = await reserveCommercialOnly(
        env,
        `bounded-abandoned-${index}`,
        new Date(`2026-08-29T09:0${index}:00.000Z`),
      );
      requestIds.push(lifecycle.requestId);
    }

    await cleanupAbandonedCommercialReservations(env, new Date("2026-08-29T10:00:00.000Z"));
    expect(requestIds.filter((requestId) => db.commercialState(requestId) === "released")).toHaveLength(8);
    expect(requestIds.filter((requestId) => db.commercialState(requestId) === "reserved")).toHaveLength(1);
  });

  it("never cleans live or post-authorization admissions and cannot win a race with settlement authorization", async () => {
    const db = paymentDb({ authorizeDuringCleanupSelection: true });
    const env = { DB: db } as unknown as AppEnv;
    const raced = await reserveCommercialOnly(env, "cleanup-race-01", new Date("2026-08-29T10:00:00.000Z"));
    db.removeCommercialEvent(raced.requestId, "settlement_authorized");
    const live = await reserveCommercialOnly(env, "cleanup-live-01", new Date("2026-08-29T11:59:45.000Z"));

    await cleanupAbandonedCommercialReservations(env, new Date("2026-08-29T12:00:00.000Z"));
    expect(db.commercialState(raced.requestId)).toBe("ambiguous");
    expect(db.admissionState(raced.requestId)).toBe("ambiguous");
    expect(db.commercialEvents(raced.requestId)).toContain("settlement_authorized");
    expect(db.commercialState(live.requestId)).toBe("reserved");

    for (const [label, admissionState, exposureState] of [
      ["settling", "settling", "reserved"],
      ["accepted", "accepted", "accepted"],
      ["ambiguous", "ambiguous", "ambiguous"],
      ["consumed", "consumed", "reserved"],
      ["authorized-exposure", "reserved", "authorized"],
    ] as const) {
      const isolatedDb = paymentDb();
      const isolatedEnv = { DB: isolatedDb } as unknown as AppEnv;
      const lifecycle = await reserveCommercialOnly(isolatedEnv, `cleanup-${label}-01`, new Date("2026-08-29T10:00:00.000Z"));
      isolatedDb.forceAdmissionState(lifecycle.requestId, admissionState);
      isolatedDb.forceCommercialState(lifecycle.requestId, exposureState);
      await cleanupAbandonedCommercialReservations(isolatedEnv, new Date("2026-08-29T12:00:00.000Z"));
      expect(isolatedDb.commercialState(lifecycle.requestId)).not.toBe("released");
    }
  });

  it("allows only one concurrent payment attempt to call the provider", async () => {
    const db = paymentDb();
    const env = { DB: db } as unknown as AppEnv;
    const lifecycle = await reserve(env, "payment-race-01");
    let resolve!: (result: PaymentAttemptResult) => void;
    const provider: PaymentProviderAdapter<string> = {
      attemptAcceptance: vi.fn(() => new Promise<PaymentAttemptResult>((done) => { resolve = done; })),
    };

    const first = attemptPaymentAcceptance(env, lifecycle.requestId, lifecycle.ownerToken, "proof-fingerprint", authorizationIdentity, "proof", provider);
    await vi.waitUntil(() => vi.mocked(provider.attemptAcceptance).mock.calls.length === 1);
    await expect(attemptPaymentAcceptance(env, lifecycle.requestId, lifecycle.ownerToken, "proof-fingerprint", authorizationIdentity, "proof", provider))
      .rejects.toMatchObject({ code: "payment_in_progress", retryable: true });
    resolve(acceptedResult);
    await expect(first).resolves.toMatchObject({ kind: "accepted" });
    expect(provider.attemptAcceptance).toHaveBeenCalledOnce();
  });

  it("does not unlock paid inference after a definitive payment failure", async () => {
    const db = paymentDb();
    const env = { DB: db } as unknown as AppEnv;
    const lifecycle = await reserve(env, "payment-failed-01");

    await expect(attemptPaymentAcceptance(env, lifecycle.requestId, lifecycle.ownerToken, "proof-fingerprint", authorizationIdentity, "proof", adapter({
      outcome: "failed",
      failureCode: "payment_declined",
    }))).rejects.toMatchObject({ code: "payment_failed" });
    await expect(markPaidInferenceRunning(env, lifecycle.requestId, lifecycle.ownerToken))
      .rejects.toMatchObject({ code: "idempotency_state_ambiguous" });
    expect(db.lifecycleState(lifecycle.requestId)).toBe("reserved");
  });

  it("repairs admission lag from authoritative failed and ambiguous payment states", async () => {
    const failedDb = paymentDb();
    const failedEnv = { DB: failedDb } as unknown as AppEnv;
    const failedLifecycle = await reserve(failedEnv, "payment-failed-repair-01");
    await expect(attemptPaymentAcceptance(
      failedEnv, failedLifecycle.requestId, failedLifecycle.ownerToken, "failed-proof", authorizationIdentity,
      "proof", adapter({ outcome: "failed", failureCode: "payment_declined" }),
    )).rejects.toMatchObject({ code: "payment_failed" });
    failedDb.forceAdmissionSettling(failedLifecycle.requestId);
    await expect(attemptPaymentAcceptance(
      failedEnv, failedLifecycle.requestId, failedLifecycle.ownerToken, "failed-proof", authorizationIdentity,
      "proof", adapter(acceptedResult),
    )).rejects.toMatchObject({ code: "payment_failed" });
    expect(failedDb.admissionState(failedLifecycle.requestId)).toBe("released");

    const ambiguousDb = paymentDb();
    const ambiguousEnv = { DB: ambiguousDb } as unknown as AppEnv;
    const ambiguousLifecycle = await reserve(ambiguousEnv, "payment-ambiguous-repair-01");
    await expect(attemptPaymentAcceptance(
      ambiguousEnv, ambiguousLifecycle.requestId, ambiguousLifecycle.ownerToken, "ambiguous-proof", authorizationIdentity,
      "proof", adapter({ outcome: "ambiguous", failureCode: "settlement_unknown" }),
    )).rejects.toMatchObject({ code: "payment_ambiguous" });
    ambiguousDb.forceAdmissionSettling(ambiguousLifecycle.requestId);
    await expect(attemptPaymentAcceptance(
      ambiguousEnv, ambiguousLifecycle.requestId, ambiguousLifecycle.ownerToken, "ambiguous-proof", authorizationIdentity,
      "proof", adapter(acceptedResult),
    )).rejects.toMatchObject({ code: "payment_ambiguous" });
    expect(ambiguousDb.admissionState(ambiguousLifecycle.requestId)).toBe("ambiguous");
  });

  it("unlocks only the paid inference transition after durable acceptance", async () => {
    const db = paymentDb();
    const env = { DB: db } as unknown as AppEnv;
    const lifecycle = await reserve(env, "payment-confirmed-01");
    await attemptPaymentAcceptance(env, lifecycle.requestId, lifecycle.ownerToken, "proof-fingerprint", authorizationIdentity, "proof", adapter(acceptedResult));

    await markPaidInferenceRunning(env, lifecycle.requestId, lifecycle.ownerToken);
    expect(db.lifecycleState(lifecycle.requestId)).toBe("inference_running");
  });

  it("turns an unknown provider outcome into payment ambiguity and never retries it", async () => {
    const db = paymentDb();
    const env = { DB: db } as unknown as AppEnv;
    const lifecycle = await reserve(env, "payment-ambiguous-01");
    const provider: PaymentProviderAdapter<string> = {
      attemptAcceptance: vi.fn(async () => { throw new Error("connection lost"); }),
    };

    await expect(attemptPaymentAcceptance(env, lifecycle.requestId, lifecycle.ownerToken, "proof-fingerprint", authorizationIdentity, "proof", provider))
      .rejects.toMatchObject({ code: "payment_ambiguous", retryable: false });
    await expect(attemptPaymentAcceptance(env, lifecycle.requestId, lifecycle.ownerToken, "proof-fingerprint", authorizationIdentity, "proof", provider))
      .rejects.toMatchObject({ code: "payment_ambiguous", retryable: false });
    expect(provider.attemptAcceptance).toHaveBeenCalledOnce();
    expect(db.paymentState(lifecycle.requestId)).toBe("ambiguous");
    expect(db.lifecycleState(lifecycle.requestId)).toBe("reserved");
  });

  it("makes stale processing ambiguous after settlement was durably authorized without another provider call", async () => {
    const db = paymentDb();
    const env = { DB: db } as unknown as AppEnv;
    const lifecycle = await reserveCommercialOnly(env, "payment-crash-01", new Date("2026-08-28T17:00:00.000Z"));
    db.forcePaymentProcessing(lifecycle.requestId, "2026-08-28T17:00:00.000Z", "settling");
    db.forceCommercialState(lifecycle.requestId, "authorized");
    db.removeCommercialEvent(lifecycle.requestId, "settlement_authorized");
    const provider = adapter(acceptedResult);

    await expect(attemptPaymentAcceptance(
      env,
      lifecycle.requestId,
      lifecycle.ownerToken,
      "proof-fingerprint",
      authorizationIdentity,
      "proof",
      provider,
      new Date("2026-08-28T17:02:00.000Z"),
      await commercialContext(),
    )).rejects.toMatchObject({ code: "payment_ambiguous", retryable: false });
    expect(provider.attemptAcceptance).not.toHaveBeenCalled();
    expect(db.paymentState(lifecycle.requestId)).toBe("ambiguous");
    expect(db.admissionState(lifecycle.requestId)).toBe("ambiguous");
    expect(db.commercialState(lifecycle.requestId)).toBe("ambiguous");
    expect(db.commercialEvents(lifecycle.requestId)).toEqual([
      "financial_exposure_reserved", "settlement_authorized", "settlement_ambiguous",
    ]);
  });

  it("releases stale pre-authorization processing without calling the facilitator", async () => {
    const db = paymentDb();
    const env = { DB: db } as unknown as AppEnv;
    const lifecycle = await reserve(env, "payment-pre-settle-crash-01");
    db.forcePaymentProcessing(lifecycle.requestId, "2026-08-28T17:00:00.000Z", "reserved");
    const provider = adapter(acceptedResult);

    await expect(attemptPaymentAcceptance(
      env, lifecycle.requestId, lifecycle.ownerToken, "proof-fingerprint", authorizationIdentity,
      "proof", provider, new Date("2026-08-28T17:02:00.000Z"),
    )).rejects.toMatchObject({ code: "payment_in_progress", retryable: true });
    expect(provider.attemptAcceptance).not.toHaveBeenCalled();
    expect(db.paymentState(lifecycle.requestId)).toBe("required");
    expect(db.admissionState(lifecycle.requestId)).toBe("released");
  });

  it("binds authorization payer plus nonce independently of the proof fingerprint", async () => {
    const db = paymentDb();
    const env = { DB: db } as unknown as AppEnv;
    const first = await reserve(env, "payment-authorization-01");
    await attemptPaymentAcceptance(env, first.requestId, first.ownerToken, "proof-one", authorizationIdentity, "proof", adapter(acceptedResult));
    const second = await reserve(env, "payment-authorization-02");

    await expect(attemptPaymentAcceptance(
      env, second.requestId, second.ownerToken, "proof-two", authorizationIdentity, "different-proof", adapter(acceptedResult),
    )).rejects.toMatchObject({ code: "payment_proof_conflict", retryable: false });
  });

  it("never accepts a facilitator payer that differs from the locally bound authorization payer", async () => {
    const db = paymentDb();
    const env = { DB: db } as unknown as AppEnv;
    const lifecycle = await reserve(env, "payment-payer-mismatch-01");
    const provider = adapter({
      ...acceptedResult,
      payerIdentity: "0x2222222222222222222222222222222222222222",
    });

    await expect(attemptPaymentAcceptance(
      env, lifecycle.requestId, lifecycle.ownerToken, "proof-mismatch", authorizationIdentity, "proof", provider,
    )).rejects.toMatchObject({ code: "payment_ambiguous", retryable: false });
    expect(provider.attemptAcceptance).toHaveBeenCalledOnce();
    expect(db.paymentState(lifecycle.requestId)).toBe("ambiguous");
    expect(db.admissionState(lifecycle.requestId)).toBe("ambiguous");
  });

  it("keeps payment ambiguity separate from inference ambiguity", async () => {
    const db = paymentDb();
    const env = { DB: db } as unknown as AppEnv;
    const paymentLifecycle = await reserve(env, "payment-separate-01");
    await expect(attemptPaymentAcceptance(env, paymentLifecycle.requestId, paymentLifecycle.ownerToken, "proof-fingerprint", authorizationIdentity, "proof", adapter({
      outcome: "ambiguous",
      failureCode: "settlement_unknown",
      externalReference: "possible-payment-1",
      verifiedAt: "2026-08-28T18:00:01.000Z",
    }))).rejects.toMatchObject({ code: "payment_ambiguous" });

    const inferenceLifecycle = await reserveIdempotentRequest(
      env,
      { kind: "internal" },
      "inference-separate-01",
      "other-request-hash",
      "execution-context",
    );
    if (inferenceLifecycle.kind !== "acquired") throw new Error("Expected lifecycle ownership.");
    await markInferenceRunning(env, inferenceLifecycle.requestId, inferenceLifecycle.ownerToken);
    await markInferenceAmbiguous(env, inferenceLifecycle.requestId, inferenceLifecycle.ownerToken, "provider_timeout");

    expect(db.paymentState(paymentLifecycle.requestId)).toBe("ambiguous");
    expect(db.lifecycleState(paymentLifecycle.requestId)).toBe("reserved");
    expect(db.lifecycleState(inferenceLifecycle.requestId)).toBe("ambiguous");
  });
});
