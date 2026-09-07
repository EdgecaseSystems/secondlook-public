import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import type { PaymentAttemptResult, PaymentProviderAdapter } from "../src/payments";
import type { AppEnv } from "../src/types";
import {
  makeX402PaymentRequired,
  X402_BASE_MAINNET,
  X402_BASE_MAINNET_USDC,
  X402_CDP_FACILITATOR,
  X402_PAYMENT_REQUIRED_HEADER,
  X402_PAYMENT_RESPONSE_HEADER,
  X402_PAYMENT_SIGNATURE_HEADER,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "../src/x402";

afterEach(() => vi.restoreAllMocks());

type LifecycleRow = {
  request_id: string;
  caller_key: string;
  idempotency_key_hash: string;
  request_hash: string;
  execution_context: string;
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

function paidDb(options: { inferenceLeaseChanges?: number[]; inferenceEnabled?: 0 | 1; circuitOpenUntil?: number | null } = {}): D1Database & {
  lifecycleStates(): string[];
  paymentStates(): string[];
  admissionStates(): string[];
  decisionCount(): number;
} {
  const lifecycles = new Map<string, LifecycleRow>();
  const payments = new Map<string, PaymentRow>();
  const admissions = new Map<string, AdmissionRow>();
  let decisions = 0;
  const byRequestId = (requestId: string) => [...lifecycles.values()].find((row) => row.request_id === requestId);

  const statement = (sql: string) => {
    let values: unknown[] = [];
    const prepared = {
      bind: (...bound: unknown[]) => { values = bound; return prepared; },
      all: async () => ({ results: [] }),
      first: async () => {
        if (sql.includes("FROM api_service_control")) {
          return {
            inference_enabled: options.inferenceEnabled ?? 1,
            global_daily_inference_limit: 250,
            global_concurrent_inference_limit: 3,
            provider_failure_threshold: 3,
            provider_circuit_seconds: 60,
            circuit_open_until: options.circuitOpenUntil ?? null,
          };
        }
        if (sql.includes("FROM request_payments")) {
          if (sql.includes("blocked_inference_lifecycle")) {
            const staleBefore = values[0] as string;
            const found = [...payments.values()].find((payment) => {
              const lifecycle = byRequestId(payment.request_id);
              return payment.state === "accepted" && (
                lifecycle?.state === "ambiguous"
                || (lifecycle?.state === "inference_running" && lifecycle.updated_at <= staleBefore)
              );
            });
            return found ? { request_id: found.request_id } : null;
          }
          if (sql.includes("payment_proof_fingerprint = ? AND request_id <> ?")) {
            const found = [...payments.values()].find(
              (row) => row.payment_proof_fingerprint === values[0] && row.request_id !== values[1],
            );
            return found ? { request_id: found.request_id } : null;
          }
          if (sql.includes("authorization_payer = ?")) {
            const found = [...payments.values()].find((row) =>
              row.authorization_payer === values[2] && row.authorization_nonce === values[3] && row.request_id !== values[4]);
            return found ? { request_id: found.request_id } : null;
          }
          if (sql.includes("state = 'ambiguous'")) {
            const found = [...payments.values()].find((row) => row.state === "ambiguous");
            return found ? { request_id: found.request_id } : null;
          }
          if (sql.includes("JOIN idempotent_requests")) {
            const found = [...payments.values()].find((payment) => {
              const lifecycle = byRequestId(payment.request_id);
              return payment.state === "accepted" && lifecycle?.state !== "completed" && payment.request_id !== values[0];
            });
            return found ? { request_id: found.request_id } : null;
          }
          const row = payments.get(values[0] as string);
          if (!row) return null;
          return sql.trim().startsWith("SELECT state") ? { state: row.state } : { ...row };
        }
        if (sql.includes("FROM paid_execution_admissions")) {
          const row = admissions.get(values[0] as string);
          return row ? { ...row } : null;
        }
        if (sql.includes(" AS used")) return { used: 0 };
        if (sql.includes("FROM idempotent_requests")) {
          const found = [...lifecycles.values()].find(
            (row) => row.caller_key === values[0] && row.idempotency_key_hash === values[1],
          );
          if (!found) return null;
          return sql.includes("SELECT 1 AS present") ? { present: 1 } : { ...found };
        }
        return null;
      },
      run: async () => {
        let changes = 1;
        if (sql.includes("INSERT OR IGNORE INTO api_inference_leases")) {
          changes = options.inferenceLeaseChanges?.shift() ?? 1;
        } else if (sql.startsWith("DELETE FROM idempotent_requests")) {
          changes = 0;
        } else if (sql.includes("INSERT OR IGNORE INTO idempotent_requests")) {
          const [requestId, caller, keyHash, requestHash, executionContext, owner, created] = values as string[];
          const scope = `${caller}:${keyHash}`;
          if (lifecycles.has(scope)) changes = 0;
          else lifecycles.set(scope, {
            request_id: requestId,
            caller_key: caller,
            idempotency_key_hash: keyHash,
            request_hash: requestHash,
            execution_context: executionContext,
            state: "reserved",
            owner_token: owner,
            response_json: null,
            updated_at: created,
          });
        } else if (sql.includes("state = 'reserved', owner_token = ?") && sql.includes("owner_token IS NULL")) {
          const [executionContext, owner, updated, , requestId, requestHash, staleBefore] = values as string[];
          const row = byRequestId(requestId);
          const reclaimable = row && row.request_hash === requestHash && (
            row.state === "failed_before_inference" ||
            (row.state === "reserved" && row.owner_token === null) ||
            (row.state === "reserved" && row.updated_at <= staleBefore)
          );
          if (!row || !reclaimable) changes = 0;
          else {
            row.execution_context = executionContext;
            row.state = "reserved";
            row.owner_token = owner;
            row.updated_at = updated;
          }
        } else if (sql.includes("idempotent_requests SET owner_token = NULL")) {
          const [updated, requestId, owner] = values as string[];
          const row = byRequestId(requestId);
          if (!row || row.state !== "reserved" || row.owner_token !== owner) changes = 0;
          else { row.owner_token = null; row.updated_at = updated; }
        } else if (sql.includes("INSERT OR IGNORE INTO request_payments")) {
          const [requestId, provider, protocol, amount, asset, network, payTo, requirementsJson, , updated, lifecycleId, lifecycleOwner] = values as string[];
          const lifecycle = byRequestId(lifecycleId);
          if (payments.has(requestId) || !lifecycle || lifecycle.state !== "reserved" || lifecycle.owner_token !== lifecycleOwner) changes = 0;
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
        } else if (sql.includes("request_payments SET state = 'processing'")) {
          const [attemptOwner, started, proof, authorizationPayer, authorizationNonce, , requestId, repeatedProof, lifecycleId, lifecycleOwner, admissionId, admissionOwner] = values as string[];
          const payment = payments.get(requestId);
          const lifecycle = byRequestId(lifecycleId);
          const admission = admissions.get(admissionId);
          if (
            !payment || payment.state !== "required" ||
            (payment.payment_proof_fingerprint !== null && payment.payment_proof_fingerprint !== repeatedProof) ||
            !lifecycle || lifecycle.state !== "reserved" || lifecycle.owner_token !== lifecycleOwner ||
            !admission || admission.state !== "reserved" || admission.owner_token !== admissionOwner
          ) changes = 0;
          else {
            payment.state = "processing";
            payment.attempt_owner_token = attemptOwner;
            payment.attempt_started_at = started;
            payment.payment_proof_fingerprint = proof;
            payment.authorization_payer = authorizationPayer;
            payment.authorization_nonce = authorizationNonce;
            payment.failure_code = null;
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
            const preserveAcceptanceLease = paymentState === "accepted" && options.inferenceLeaseChanges === undefined;
            admission.owner_token = preserveAcceptanceLease ? lifecycleOwner as string : null;
            admission.lease_kind = preserveAcceptanceLease ? "inference" : null;
            admission.lease_expires_at = preserveAcceptanceLease ? expires as number : null;
          }
        } else if (sql.includes("paid_execution_admissions SET state = 'accepted'")) {
          const requestId = values[6] as string;
          const admission = admissions.get(requestId);
          if (admission?.state === "settling" && payments.get(requestId)?.state === "accepted") admission.state = "accepted";
          else changes = 0;
        } else if (sql.includes("paid_execution_admissions SET owner_token = ?")) {
          const [owner, expires, , requestId] = values as [string, number, string, string];
          const admission = admissions.get(requestId);
          changes = options.inferenceLeaseChanges?.shift() ?? 1;
          if (!admission || admission.state !== "accepted") changes = 0;
          if (changes === 1 && admission) {
            admission.owner_token = owner; admission.lease_kind = "inference"; admission.lease_expires_at = expires;
          }
        } else if (sql.includes("paid_execution_admissions SET state = 'consumed'")) {
          const requestId = values[1] as string;
          const admission = admissions.get(requestId);
          if (!admission || admission.state !== "accepted") changes = 0;
          else admission.state = "consumed";
        } else if (sql.includes("paid_execution_admissions SET owner_token = NULL")) {
          const requestId = values[1] as string;
          const admission = admissions.get(requestId);
          if (!admission || !["accepted", "consumed"].includes(admission.state)) changes = 0;
          else { admission.owner_token = null; admission.lease_kind = null; admission.lease_expires_at = null; }
        } else if (sql.includes("paid_execution_admissions SET state = 'released'")) {
          const requestId = values[1] as string;
          const admission = admissions.get(requestId);
          const payment = payments.get(requestId);
          const isRepair = sql.includes("request_payments WHERE request_id = ? AND state = 'failed'");
          if (!admission || (isRepair && payment?.state !== "failed")) changes = 0;
          else { admission.state = "released"; admission.owner_token = null; admission.lease_kind = null; admission.lease_expires_at = null; }
        } else if (sql.includes("paid_execution_admissions SET state = 'ambiguous'")) {
          const requestId = values[1] as string;
          const admission = admissions.get(requestId);
          const payment = payments.get(requestId);
          if (!admission || payment?.state !== "ambiguous") changes = 0;
          else { admission.state = "ambiguous"; admission.owner_token = null; admission.lease_kind = null; admission.lease_expires_at = null; }
        } else if (sql.includes("request_payments SET state = 'accepted'")) {
          const [payer, reference, verifiedAt, settledAt, updated, requestId, owner] = values as string[];
          const payment = payments.get(requestId);
          if (!payment || payment.state !== "processing" || payment.attempt_owner_token !== owner) changes = 0;
          else {
            payment.state = "accepted";
            payment.payer_identity = payer;
            payment.external_reference = reference;
            payment.failure_code = null;
            payment.verified_at = verifiedAt;
            payment.settled_at = settledAt;
            payment.attempt_owner_token = null;
            payment.updated_at = updated;
          }
        } else if (sql.includes("request_payments SET state = 'failed'")) {
          const [failure, updated, requestId, owner] = values as string[];
          const payment = payments.get(requestId);
          if (!payment || payment.state !== "processing" || payment.attempt_owner_token !== owner) changes = 0;
          else { payment.state = "failed"; payment.failure_code = failure; payment.attempt_owner_token = null; payment.updated_at = updated; }
        } else if (sql.includes("request_payments SET state = 'required'")) {
          const [failure, updated, requestId, owner] = values as string[];
          const payment = payments.get(requestId);
          if (!payment || payment.state !== "processing" || payment.attempt_owner_token !== owner) changes = 0;
          else { payment.state = "required"; payment.failure_code = failure; payment.attempt_owner_token = null; payment.updated_at = updated; }
        } else if (sql.includes("request_payments SET state = 'ambiguous'")) {
          const [payer, reference, failure, verifiedAt, updated, requestId, owner] = values as Array<string | null>;
          const payment = payments.get(requestId as string);
          if (!payment || payment.state !== "processing" || payment.attempt_owner_token !== owner) changes = 0;
          else {
            payment.state = "ambiguous";
            payment.payer_identity = payer;
            payment.external_reference = reference;
            payment.failure_code = failure;
            payment.verified_at = verifiedAt;
            payment.attempt_owner_token = null;
            payment.updated_at = updated as string;
          }
        } else if (sql.includes("SET state = 'inference_running'") && sql.includes("FROM request_payments")) {
          const [started, , requestId, owner] = values as string[];
          const lifecycle = byRequestId(requestId);
          const payment = payments.get(requestId);
          if (!lifecycle || lifecycle.state !== "reserved" || lifecycle.owner_token !== owner || payment?.state !== "accepted") changes = 0;
          else { lifecycle.state = "inference_running"; lifecycle.updated_at = started; }
        } else if (sql.includes("idempotent_requests SET state = 'failed_before_inference'")) {
          const [, updated, requestId, owner] = values as string[];
          const row = byRequestId(requestId);
          if (!row || row.state !== "reserved" || row.owner_token !== owner) changes = 0;
          else { row.state = "failed_before_inference"; row.owner_token = null; row.updated_at = updated; }
        } else if (sql.includes("idempotent_requests SET state = 'ambiguous'")) {
          const [, updated, requestId, owner] = values as string[];
          const row = byRequestId(requestId);
          if (!row || row.state !== "inference_running" || row.owner_token !== owner) changes = 0;
          else { row.state = "ambiguous"; row.owner_token = null; row.updated_at = updated; }
        } else if (sql.startsWith("INSERT INTO decisions")) {
          const requestId = values.at(-2) as string;
          const owner = values.at(-1) as string;
          const row = byRequestId(requestId);
          if (!row || row.state !== "inference_running" || row.owner_token !== owner) changes = 0;
          else decisions += 1;
        } else if (sql.includes("idempotent_requests SET state = 'completed'")) {
          const [, response, completed, , requestId, owner] = values as string[];
          const row = byRequestId(requestId);
          if (!row || row.state !== "inference_running" || row.owner_token !== owner) changes = 0;
          else {
            row.state = "completed";
            row.owner_token = null;
            row.response_json = response;
            row.updated_at = completed;
          }
        }
        return { success: true, meta: { changes } };
      },
    };
    return prepared;
  };
  const db = Object.create(null) as D1Database;
  Object.defineProperty(db, "prepare", { value: vi.fn(statement) });
  Object.defineProperty(db, "batch", {
    value: vi.fn(async (statements: Array<{ run(): Promise<unknown> }>) => Promise.all(statements.map((item) => item.run()))),
  });
  return Object.assign(db, {
    lifecycleStates: () => [...lifecycles.values()].map((row) => row.state),
    paymentStates: () => [...payments.values()].map((row) => row.state),
    admissionStates: () => [...admissions.values()].map((row) => row.state),
    decisionCount: () => decisions,
  });
}

const accepted: X402PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "1000",
  asset: "0x1111111111111111111111111111111111111111",
  payTo: "0x2222222222222222222222222222222222222222",
  maxTimeoutSeconds: 60,
  extra: { assetTransferMethod: "eip3009", paymentFlow: "upfront", name: "USDC", version: "2" },
};

function paymentPayload(): X402PaymentPayload {
  const required = makeX402PaymentRequired("https://secondlook.example/v1/paid/second-look", accepted);
  return {
    x402Version: 2,
    resource: required.resource,
    accepted,
    extensions: required.extensions,
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from: "0x3333333333333333333333333333333333333333",
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: "1",
        validBefore: "9999999999",
        nonce: `0x${"cd".repeat(32)}`,
      },
    },
  };
}

function paidRequest(key?: string, goal = "Review this paid action", payment: unknown = undefined): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["idempotency-key"] = key;
  if (payment !== undefined) headers[X402_PAYMENT_SIGNATURE_HEADER] = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(payment))));
  return new Request("https://secondlook.example/v1/paid/second-look", {
    method: "POST",
    headers,
    body: JSON.stringify({ goal, proposed_action: "Perform the reviewed action." }),
  });
}

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

function paidEnv(db: D1Database, aiRun = vi.fn(async () => ({ response: clearGateResponse() }))): AppEnv & { AI: Ai } {
  const ai = Object.create(null) as Ai;
  Object.defineProperty(ai, "run", { value: aiRun });
  return {
    AI: ai,
    DB: db,
    X402_PAID_ENABLED: "true",
    X402_FACILITATOR_URL: "https://x402.org/facilitator",
    X402_NETWORK: accepted.network,
    X402_ASSET: accepted.asset,
    X402_AMOUNT_ATOMIC: accepted.amount,
    X402_PAY_TO: accepted.payTo,
    X402_ASSET_NAME: "USDC",
    X402_ASSET_VERSION: "2",
  } as AppEnv & { AI: Ai };
}

const acceptedResult: PaymentAttemptResult = {
  outcome: "accepted",
  payerIdentity: paymentPayload().payload.authorization.from,
  externalReference: `0x${"ef".repeat(32)}`,
  verifiedAt: "2026-08-28T18:00:01.000Z",
  settledAt: "2026-08-28T18:00:02.000Z",
};

function adapter(result: PaymentAttemptResult): PaymentProviderAdapter<X402PaymentPayload> & { attemptAcceptance: ReturnType<typeof vi.fn> } {
  return { attemptAcceptance: vi.fn(async () => result) };
}

describe("dormant public x402 paid endpoint", () => {
  it("stays unavailable without explicit configuration and advertises endpoint-specific idempotency rules", async () => {
    const db = paidDb();
    const aiRun = vi.fn();
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: aiRun });
    const worker = createWorker({ paymentAdapter: adapter(acceptedResult) });

    const disabled = await worker.fetch(paidRequest("10000000-0000-4000-8000-000000000001"), { AI: ai, DB: db } as AppEnv);
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toMatchObject({ code: "paid_service_disabled", retryable: false });
    expect(db.lifecycleStates()).toEqual([]);

    const discovery = await worker.fetch(new Request("https://secondlook.example/.well-known/secondlook.json"), { AI: ai, DB: db } as AppEnv);
    expect(discovery.status).toBe(200);
    const discoveryBody = await discovery.json() as { endpoints: Record<string, unknown>; operational_behavior: { idempotency: Record<string, unknown> } };
    expect(discoveryBody.endpoints).toMatchObject({
      paid_second_look: {
        new_sales_enabled: false,
        existing_paid_replay_or_recovery_supported: true,
      },
    });
    expect(discoveryBody.operational_behavior.idempotency).toMatchObject({
      rules: "endpoint-specific",
      second_look: { required: false },
      report_outcome: { supported: false },
    });
    expect(discoveryBody.operational_behavior.idempotency).toHaveProperty("paid_second_look");

    const configuredDb = paidDb();
    const configured = paidEnv(configuredDb, aiRun);
    const missing = await worker.fetch(paidRequest(), configured);
    expect(missing.status).toBe(402);
    expect(await missing.json()).toMatchObject({ code: "payment_required", retryable: false });
    expect(configuredDb.lifecycleStates()).toEqual([]);
    expect(configuredDb.paymentStates()).toEqual([]);
    expect(aiRun).not.toHaveBeenCalled();

    const configuredDiscovery = await worker.fetch(new Request("https://secondlook.example/.well-known/secondlook.json"), configured);
    const configuredBody = await configuredDiscovery.json() as { endpoints: Record<string, unknown>; operational_behavior: { idempotency: Record<string, unknown> } };
    expect(configuredBody.endpoints).toHaveProperty("paid_second_look");
    expect(configuredBody.operational_behavior.idempotency).toMatchObject({
      paid_second_look: {
        protocol: "x402-v2",
        required_for_payment_retry: true,
        required_for_negotiation: false,
        format: "uuid-v4",
      },
    });
  });

  it("returns an official 402 without creating payment/lifecycle state or reaching execution", async () => {
    const db = paidDb();
    const aiRun = vi.fn();
    const provider = adapter(acceptedResult);
    const response = await createWorker({ paymentAdapter: provider }).fetch(
      paidRequest("10000000-0000-4000-8000-000000000002"),
      paidEnv(db, aiRun),
    );
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ code: "payment_required", category: "payment" });
    expect(JSON.parse(atob(response.headers.get(X402_PAYMENT_REQUIRED_HEADER) ?? ""))).toMatchObject({ x402Version: 2, accepts: [accepted] });
    expect(provider.attemptAcceptance).not.toHaveBeenCalled();
    expect(aiRun).not.toHaveBeenCalled();
    expect(db.lifecycleStates()).toEqual([]);
    expect(db.paymentStates()).toEqual([]);
  });

  it("accepts a CDP-validator-shaped bare POST after read-only preflight without durable mutation or execution", async () => {
    const db = paidDb();
    const aiRun = vi.fn();
    const provider = adapter(acceptedResult);
    const response = await createWorker({ paymentAdapter: provider }).fetch(
      new Request("https://secondlook.example/v1/paid/second-look", { method: "POST" }),
      paidEnv(db, aiRun),
    );
    expect(response.status).toBe(402);
    expect(response.headers.get(X402_PAYMENT_REQUIRED_HEADER)).toBeTruthy();
    expect(db.lifecycleStates()).toEqual([]);
    expect(db.paymentStates()).toEqual([]);
    expect(provider.attemptAcceptance).not.toHaveBeenCalled();
    expect(aiRun).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled inference", { inferenceEnabled: 0 as const }],
    ["open provider circuit", { circuitOpenUntil: Math.floor(Date.now() / 1000) + 60 }],
  ])("does not advertise a usable 402 when %s is already known", async (_label, options) => {
    const db = paidDb(options);
    const aiRun = vi.fn();
    const provider = adapter(acceptedResult);
    const response = await createWorker({ paymentAdapter: provider }).fetch(paidRequest(), paidEnv(db, aiRun));
    expect(response.status).toBe(503);
    expect(response.headers.get(X402_PAYMENT_REQUIRED_HEADER)).toBeNull();
    expect(await response.json()).toMatchObject({ code: "service_disabled" });
    expect(db.lifecycleStates()).toEqual([]);
    expect(db.paymentStates()).toEqual([]);
    expect(provider.attemptAcceptance).not.toHaveBeenCalled();
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("requires UUIDv4 idempotency and a valid SecondLook body on payment-bearing retries", async () => {
    const db = paidDb();
    const aiRun = vi.fn();
    const provider = adapter(acceptedResult);
    const worker = createWorker({ paymentAdapter: provider });
    const env = paidEnv(db, aiRun);

    const missingKey = await worker.fetch(paidRequest(undefined, "Review this paid action", paymentPayload()), env);
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toMatchObject({ code: "missing_idempotency_key" });

    const headers = {
      "content-type": "application/json",
      "idempotency-key": "10000000-0000-4000-8000-00000000000d",
      [X402_PAYMENT_SIGNATURE_HEADER]: btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(paymentPayload())))),
    };
    const missingBody = await worker.fetch(new Request("https://secondlook.example/v1/paid/second-look", { method: "POST", headers }), env);
    expect(missingBody.status).toBe(400);
    expect(await missingBody.json()).toMatchObject({ code: "invalid_json_body" });
    expect(db.lifecycleStates()).toEqual([]);
    expect(db.paymentStates()).toEqual([]);
    expect(provider.attemptAcceptance).not.toHaveBeenCalled();
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("enforces the Gate A authorization-payer allowlist before facilitator contact", async () => {
    const db = paidDb();
    const aiRun = vi.fn();
    const provider = adapter(acceptedResult);
    const worker = createWorker({ paymentAdapter: provider });
    const payTo = accepted.payTo;
    const canaryPayer = "0x4444444444444444444444444444444444444444";
    const mainnetAccepted: X402PaymentRequirements = {
      ...accepted,
      network: X402_BASE_MAINNET,
      asset: X402_BASE_MAINNET_USDC,
      amount: "50000",
      payTo,
    };
    const required = makeX402PaymentRequired("https://secondlook.example/v1/paid/second-look", mainnetAccepted);
    const proof: X402PaymentPayload = {
      x402Version: 2,
      resource: required.resource,
      accepted: mainnetAccepted,
      payload: {
        signature: `0x${"ab".repeat(65)}`,
        authorization: {
          ...paymentPayload().payload.authorization,
          to: payTo,
          value: "50000",
        },
      },
      extensions: required.extensions,
    };
    const env = {
      ...paidEnv(db, aiRun),
      X402_FACILITATOR_URL: X402_CDP_FACILITATOR,
      X402_NETWORK: X402_BASE_MAINNET,
      X402_ASSET: X402_BASE_MAINNET_USDC,
      X402_AMOUNT_ATOMIC: "50000",
      X402_CDP_API_KEY_ID: "test-cdp-key",
      X402_CDP_API_KEY_SECRET: "configured-secret",
      X402_MAINNET_CANARY_ENABLED: "true",
      X402_CANARY_PAYER: canaryPayer,
      X402_DAILY_SETTLEMENT_LIMIT: "1",
      X402_DAILY_ACCEPTED_PAYMENT_LIMIT: "1",
      X402_DAILY_SETTLED_ATOMIC_LIMIT: "50000",
      X402_MONTHLY_FACILITATOR_LIMIT: "1",
      X402_DAILY_PAID_INFERENCE_LIMIT: "1",
    } as AppEnv & { AI: Ai };

    const response = await worker.fetch(paidRequest(
      "10000000-0000-4000-8000-000000000013", "Review this canary action", proof,
    ), env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "invalid_payment_binding", retryable: false });
    expect(provider.attemptAcceptance).not.toHaveBeenCalled();
    expect(aiRun).not.toHaveBeenCalled();
    expect(db.paymentStates()).toEqual(["required"]);
    expect(db.admissionStates()).toEqual([]);
  });

  it("rejects malformed and mismatched payment data before settlement or inference", async () => {
    const db = paidDb();
    const aiRun = vi.fn();
    const provider = adapter(acceptedResult);
    const worker = createWorker({ paymentAdapter: provider });
    const env = paidEnv(db, aiRun);
    const key = "10000000-0000-4000-8000-000000000003";
    await worker.fetch(paidRequest(key), env);

    const malformed = paidRequest(key);
    malformed.headers.set(X402_PAYMENT_SIGNATURE_HEADER, "not-base64");
    const malformedResponse = await worker.fetch(malformed, env);
    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.json()).toMatchObject({ code: "malformed_payment_proof" });

    const wrong = paymentPayload();
    wrong.accepted = { ...accepted, amount: "1001" };
    const wrongResponse = await worker.fetch(paidRequest(key, "Review this paid action", wrong), env);
    expect(wrongResponse.status).toBe(409);
    expect(await wrongResponse.json()).toMatchObject({ code: "invalid_payment_binding" });
    expect(provider.attemptAcceptance).not.toHaveBeenCalled();
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("passes a variable-length smart-account signature unchanged to one facilitator attempt", async () => {
    const db = paidDb();
    const aiRun = vi.fn(async () => ({ response: clearGateResponse() }));
    const smartAccountSignature = `0x${"ab".repeat(160)}`;
    const provider: PaymentProviderAdapter<X402PaymentPayload> & { attemptAcceptance: ReturnType<typeof vi.fn> } = {
      attemptAcceptance: vi.fn(async ({ authorization }) => {
        expect(authorization.payload.signature).toBe(smartAccountSignature);
        return acceptedResult;
      }),
    };
    const worker = createWorker({ paymentAdapter: provider });
    const env = paidEnv(db, aiRun);
    const key = "10000000-0000-4000-8000-000000000014";
    const proof = paymentPayload();
    proof.payload.signature = smartAccountSignature;

    expect((await worker.fetch(paidRequest(key), env)).status).toBe(402);
    const response = await worker.fetch(paidRequest(key, "Review this smart-wallet paid action", proof), env);

    expect(response.status).toBe(200);
    expect(provider.attemptAcceptance).toHaveBeenCalledOnce();
    expect(aiRun).toHaveBeenCalledOnce();
    expect(db.paymentStates()).toEqual(["accepted"]);
    expect(db.lifecycleStates()).toEqual(["completed"]);
  });

  it("rejects mutated server-owned catalog metadata before payment processing or inference", async () => {
    const db = paidDb();
    const aiRun = vi.fn();
    const provider = adapter(acceptedResult);
    const worker = createWorker({ paymentAdapter: provider });
    const env = paidEnv(db, aiRun);
    const key = "10000000-0000-4000-8000-00000000000c";
    await worker.fetch(paidRequest(key), env);
    const proof = paymentPayload();
    proof.resource.description = "buyer mutation";
    const response = await worker.fetch(paidRequest(key, "Review this paid action", proof), env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "invalid_payment_binding", category: "caller" });
    expect(provider.attemptAcceptance).not.toHaveBeenCalled();
    expect(aiRun).not.toHaveBeenCalled();
    expect(db.paymentStates()).toEqual(["required"]);
    expect(db.lifecycleStates()).toEqual(["reserved"]);
  });

  it("settles once, gates one inference, and durably replays without settling or inferring again", async () => {
    const db = paidDb();
    const aiRun = vi.fn(async () => {
      expect(db.lifecycleStates()).toEqual(["inference_running"]);
      expect(db.admissionStates()).toEqual(["consumed"]);
      return { response: clearGateResponse() };
    });
    const provider: PaymentProviderAdapter<X402PaymentPayload> & { attemptAcceptance: ReturnType<typeof vi.fn> } = {
      attemptAcceptance: vi.fn(async () => {
        expect(db.paymentStates()).toEqual(["processing"]);
        expect(db.admissionStates()).toEqual(["settling"]);
        return acceptedResult;
      }),
    };
    const worker = createWorker({ paymentAdapter: provider });
    const env = paidEnv(db, aiRun);
    const key = "10000000-0000-4000-8000-000000000004";

    expect((await worker.fetch(paidRequest(key), env)).status).toBe(402);
    const completed = await worker.fetch(paidRequest(key, "Review this paid action", paymentPayload()), env);
    const completedBody = await completed.json();
    const admissionWritesBeforeReplay = vi.mocked(db.prepare).mock.calls.filter(([sql]) =>
      /(?:INSERT|UPDATE).*paid_execution_admissions/s.test(sql as string)).length;
    const replay = await worker.fetch(paidRequest(key, "Review this paid action", paymentPayload()), env);
    const publicConfiguration = {
      ...env,
      X402_FACILITATOR_URL: X402_CDP_FACILITATOR,
      X402_NETWORK: X402_BASE_MAINNET,
      X402_ASSET: X402_BASE_MAINNET_USDC,
      X402_AMOUNT_ATOMIC: "50000",
      X402_PAY_TO: "0x2222222222222222222222222222222222222222",
      X402_MAINNET_CANARY_ENABLED: undefined,
      X402_PUBLIC_MAINNET_ENABLED: "true",
      X402_MAX_OUTSTANDING_PAID_OBLIGATIONS: "5",
      X402_SUPPORT_URL: "https://support.example/secondlook",
      X402_CDP_API_KEY_ID: "test-key",
      X402_CDP_API_KEY_SECRET: "test-secret",
      X402_DAILY_SETTLEMENT_LIMIT: "100",
      X402_DAILY_ACCEPTED_PAYMENT_LIMIT: "100",
      X402_DAILY_SETTLED_ATOMIC_LIMIT: "5000000",
      X402_MONTHLY_FACILITATOR_LIMIT: "100",
      X402_DAILY_PAID_INFERENCE_LIMIT: "100",
    };
    const historicalConfigurations = [
      { ...env, X402_PAID_ENABLED: undefined },
      { ...publicConfiguration, X402_PUBLIC_MAINNET_ENABLED: undefined },
      { ...publicConfiguration, X402_SUPPORT_URL: undefined },
      { ...publicConfiguration, X402_PAY_TO: undefined },
      { ...publicConfiguration, X402_CDP_API_KEY_ID: undefined, X402_CDP_API_KEY_SECRET: undefined },
      { ...publicConfiguration, X402_DAILY_SETTLEMENT_LIMIT: "invalid" },
      publicConfiguration,
    ];
    const historicalReplays = [];
    for (const historicalEnv of historicalConfigurations) {
      historicalReplays.push(await worker.fetch(paidRequest(key), historicalEnv));
    }

    expect(completed.status).toBe(200);
    expect(completed.headers.get(X402_PAYMENT_RESPONSE_HEADER)).not.toBeNull();
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await replay.json()).toEqual(completedBody);
    for (const historicalReplay of historicalReplays) {
      expect(historicalReplay.status).toBe(200);
      expect(historicalReplay.headers.get("idempotency-replayed")).toBe("true");
      expect(await historicalReplay.json()).toEqual(completedBody);
    }
    expect(provider.attemptAcceptance).toHaveBeenCalledOnce();
    expect(aiRun).toHaveBeenCalledOnce();
    expect(db.decisionCount()).toBe(1);
    expect(db.lifecycleStates()).toEqual(["completed"]);
    expect(db.paymentStates()).toEqual(["accepted"]);
    const reservationSql = vi.mocked(db.prepare).mock.calls
      .map(([sql]) => sql as string)
      .find((sql) => sql.includes("INSERT OR IGNORE INTO paid_execution_admissions"));
    expect(reservationSql).toContain("api_global_usage");
    expect(reservationSql).toContain("api_inference_leases");
    expect(reservationSql).toContain("paid_execution_admissions paid_daily");
    expect(reservationSql).toContain("paid_execution_admissions paid_concurrent");
    expect(vi.mocked(db.prepare).mock.calls.filter(([sql]) =>
      /(?:INSERT|UPDATE).*paid_execution_admissions/s.test(sql as string)).length).toBe(admissionWritesBeforeReplay);
  });

  it("rejects one proof on a second lifecycle before another settlement or inference", async () => {
    const db = paidDb();
    const aiRun = vi.fn(async () => ({ response: clearGateResponse() }));
    const provider = adapter(acceptedResult);
    const worker = createWorker({ paymentAdapter: provider });
    const env = paidEnv(db, aiRun);
    const firstKey = "10000000-0000-4000-8000-000000000005";
    const secondKey = "10000000-0000-4000-8000-000000000006";
    await worker.fetch(paidRequest(firstKey, "First logical request"), env);
    expect((await worker.fetch(paidRequest(firstKey, "First logical request", paymentPayload()), env)).status).toBe(200);
    await worker.fetch(paidRequest(secondKey, "Second logical request"), env);
    const conflict = await worker.fetch(paidRequest(secondKey, "Second logical request", paymentPayload()), env);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "payment_proof_conflict", retryable: false });
    expect(provider.attemptAcceptance).toHaveBeenCalledOnce();
    expect(aiRun).toHaveBeenCalledOnce();
  });

  it("allows only one concurrent payment transition", async () => {
    const db = paidDb();
    const aiRun = vi.fn(async () => ({ response: clearGateResponse() }));
    let resolve!: (result: PaymentAttemptResult) => void;
    const provider: PaymentProviderAdapter<X402PaymentPayload> & { attemptAcceptance: ReturnType<typeof vi.fn> } = {
      attemptAcceptance: vi.fn(() => new Promise<PaymentAttemptResult>((done) => { resolve = done; })),
    };
    const worker = createWorker({ paymentAdapter: provider });
    const env = paidEnv(db, aiRun);
    const key = "10000000-0000-4000-8000-000000000007";
    await worker.fetch(paidRequest(key), env);
    const first = worker.fetch(paidRequest(key, "Review this paid action", paymentPayload()), env);
    await vi.waitUntil(() => provider.attemptAcceptance.mock.calls.length === 1);
    const duplicate = await worker.fetch(paidRequest(key, "Review this paid action", paymentPayload()), env);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "payment_in_progress", retryable: true });
    expect(aiRun).not.toHaveBeenCalled();
    resolve(acceptedResult);
    expect((await first).status).toBe(200);
    expect(provider.attemptAcceptance).toHaveBeenCalledOnce();
    expect(aiRun).toHaveBeenCalledOnce();
  });

  it("never infers after failed payment and makes uncertain settlement non-retryable", async () => {
    const failedDb = paidDb();
    const failedAi = vi.fn();
    const failedWorker = createWorker({ paymentAdapter: adapter({ outcome: "failed", failureCode: "invalid_payment" }) });
    const failedEnv = paidEnv(failedDb, failedAi);
    const failedKey = "10000000-0000-4000-8000-000000000008";
    await failedWorker.fetch(paidRequest(failedKey), failedEnv);
    const failed = await failedWorker.fetch(paidRequest(failedKey, "Review this paid action", paymentPayload()), failedEnv);
    expect(failed.status).toBe(402);
    expect(await failed.json()).toMatchObject({ code: "payment_failed", retryable: false });
    expect(failedAi).not.toHaveBeenCalled();
    expect(failedDb.admissionStates()).toEqual(["released"]);

    const ambiguousDb = paidDb();
    const ambiguousAi = vi.fn(async () => ({ response: clearGateResponse() }));
    const ambiguousResult: PaymentAttemptResult = {
      outcome: "ambiguous",
      failureCode: "settlement_pending",
      payerIdentity: paymentPayload().payload.authorization.from,
      externalReference: `0x${"aa".repeat(32)}`,
      verifiedAt: "2026-08-28T18:00:01.000Z",
    };
    const ambiguousProvider = {
      attemptAcceptance: vi.fn()
        .mockResolvedValueOnce(ambiguousResult)
        .mockResolvedValueOnce(acceptedResult),
    } as PaymentProviderAdapter<X402PaymentPayload> & { attemptAcceptance: ReturnType<typeof vi.fn> };
    const ambiguousWorker = createWorker({ paymentAdapter: ambiguousProvider });
    const ambiguousEnv = paidEnv(ambiguousDb, ambiguousAi);
    const ambiguousKey = "10000000-0000-4000-8000-000000000009";
    await ambiguousWorker.fetch(paidRequest(ambiguousKey), ambiguousEnv);
    const ambiguous = await ambiguousWorker.fetch(paidRequest(ambiguousKey, "Review this paid action", paymentPayload()), ambiguousEnv);
    const retry = await ambiguousWorker.fetch(paidRequest(ambiguousKey), ambiguousEnv);
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.headers.get(X402_PAYMENT_RESPONSE_HEADER)).not.toBeNull();
    expect(await ambiguous.json()).toMatchObject({ code: "payment_ambiguous", retryable: false });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ code: "payment_ambiguous", retryable: false });
    expect(ambiguousProvider.attemptAcceptance).toHaveBeenCalledOnce();
    expect(ambiguousAi).not.toHaveBeenCalled();
    expect(ambiguousDb.admissionStates()).toEqual(["ambiguous"]);

    const blockedKey = "10000000-0000-4000-8000-000000000010";
    const unrelatedNegotiation = await ambiguousWorker.fetch(paidRequest(blockedKey, "A different paid action"), ambiguousEnv);
    expect(unrelatedNegotiation.status).toBe(402);
    const unrelated = await ambiguousWorker.fetch(paidRequest(blockedKey, "A different paid action", {
      ...paymentPayload(),
      payload: {
        ...paymentPayload().payload,
        authorization: { ...paymentPayload().payload.authorization, nonce: `0x${"bb".repeat(32)}` },
      },
    }), ambiguousEnv);
    expect(unrelated.status).toBe(200);
    expect(ambiguousProvider.attemptAcceptance).toHaveBeenCalledTimes(2);
    expect(ambiguousAi).toHaveBeenCalledOnce();
  });

  it("leaves accepted payment plus ambiguous inference durably visible for reconciliation", async () => {
    const db = paidDb();
    const aiRun = vi.fn(async () => { throw new Error("provider unavailable"); });
    const provider = adapter(acceptedResult);
    const worker = createWorker({ paymentAdapter: provider });
    const env = paidEnv(db, aiRun);
    const key = "10000000-0000-4000-8000-00000000000a";
    await worker.fetch(paidRequest(key), env);
    const failed = await worker.fetch(paidRequest(key, "Review this paid action", paymentPayload()), env);
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({ code: "idempotency_state_ambiguous", retryable: false });
    expect(db.paymentStates()).toEqual(["accepted"]);
    expect(db.lifecycleStates()).toEqual(["ambiguous"]);
    expect(db.decisionCount()).toBe(0);
    expect(provider.attemptAcceptance).toHaveBeenCalledOnce();
    expect(aiRun).toHaveBeenCalledOnce();

    const blocked = await worker.fetch(
      paidRequest("10000000-0000-4000-8000-0000000000fa", "A different paid action"),
      env,
    );
    expect(blocked.status).toBe(409);
    expect(blocked.headers.get(X402_PAYMENT_REQUIRED_HEADER)).toBeNull();
    expect(await blocked.json()).toMatchObject({ code: "payment_request_processing", retryable: true });
    expect(provider.attemptAcceptance).toHaveBeenCalledOnce();
    expect(aiRun).toHaveBeenCalledOnce();
  });

  it("recovers accepted payment after sales disablement without another proof or settlement", async () => {
    const db = paidDb({ inferenceLeaseChanges: [0, 1] });
    const aiRun = vi.fn(async () => ({ response: clearGateResponse() }));
    const provider = adapter(acceptedResult);
    const worker = createWorker({ paymentAdapter: provider });
    const env = paidEnv(db, aiRun);
    const key = "10000000-0000-4000-8000-00000000000b";
    await worker.fetch(paidRequest(key), env);
    const capacity = await worker.fetch(paidRequest(key, "Review this paid action", paymentPayload()), env);
    expect(capacity.status).toBe(429);
    expect(await capacity.json()).toMatchObject({ code: "inference_capacity_reached", retryable: true });
    expect(db.paymentStates()).toEqual(["accepted"]);
    expect(db.lifecycleStates()).toEqual(["failed_before_inference"]);
    expect(aiRun).not.toHaveBeenCalled();

    const recovered = await worker.fetch(paidRequest(key), { ...env, X402_PAID_ENABLED: undefined });
    expect(recovered.status).toBe(200);
    expect(provider.attemptAcceptance).toHaveBeenCalledOnce();
    expect(aiRun).toHaveBeenCalledOnce();
    expect(db.lifecycleStates()).toEqual(["completed"]);
  });

  it("blocks new settlement while an accepted paid request still needs inference", async () => {
    const db = paidDb({ inferenceLeaseChanges: [0] });
    const aiRun = vi.fn(async () => ({ response: clearGateResponse() }));
    const provider = adapter(acceptedResult);
    const worker = createWorker({ paymentAdapter: provider });
    const env = paidEnv(db, aiRun);
    const firstKey = "10000000-0000-4000-8000-000000000011";
    await worker.fetch(paidRequest(firstKey), env);
    expect((await worker.fetch(paidRequest(firstKey, "First accepted action", paymentPayload()), env)).status).toBe(429);

    const secondKey = "10000000-0000-4000-8000-000000000012";
    await worker.fetch(paidRequest(secondKey, "Second action"), env);
    const secondPayload = paymentPayload();
    secondPayload.payload.authorization.nonce = `0x${"cc".repeat(32)}`;
    const blocked = await worker.fetch(paidRequest(secondKey, "Second action", secondPayload), env);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: "payment_request_processing", retryable: true });
    expect(provider.attemptAcceptance).toHaveBeenCalledOnce();
    expect(aiRun).not.toHaveBeenCalled();
  });
});
