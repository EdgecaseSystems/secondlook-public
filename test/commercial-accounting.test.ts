import { describe, expect, it, vi } from "vitest";
// @ts-expect-error The Worker project intentionally omits Node typings; Vitest runs this contract test in Node.
import { readFileSync } from "node:fs";
import {
  authorizeCommercialSettlement,
  createCommercialPaymentContext,
  repairCommercialAccountingEvidence,
  releaseCommercialPaymentExposure,
  reserveCommercialPaymentExposure,
  synchronizeCommercialAccountingFromPayment,
  type CommercialExposureState,
  type CommercialFinancialLimits,
} from "../src/commercial-accounting";
import type { AppEnv } from "../src/types";

type Exposure = {
  request_id: string;
  admission_day: string;
  admission_month: string;
  network: string;
  asset: string;
  amount_atomic: string;
  pay_to: string;
  facilitator: string;
  state: CommercialExposureState;
  configuration_fingerprint: string;
  public_commercial_policy_version?: string | null;
  settlement_authorized_at: string | null;
  resolved_at: string | null;
  created_at: string;
};

type Payment = { state: string; payer_identity: string | null; external_reference: string | null; settled_at: string | null; attempt_owner_token: string | null };
type Admission = { state: string; owner_token: string | null; lease_expires_at: number };
type Event = { event_id: string; request_id: string; event_type: string; verified_payer: string | null; transaction_reference: string | null };

function accountingDb() {
  const exposures = new Map<string, Exposure>();
  const payments = new Map<string, Payment>();
  const admissions = new Map<string, Admission>();
  const lifecycles = new Map<string, string>();
  const events = new Map<string, Event>();
  const boundValues: unknown[][] = [];

  const statement = (sql: string) => {
    let values: unknown[] = [];
    const prepared = {
      bind: (...bound: unknown[]) => { values = bound; boundValues.push(bound); return prepared; },
      all: async () => ({ results: [] }),
      first: async () => {
        if (sql.includes("FROM commercial_payment_exposures exposure")) {
          const exposure = exposures.get(values[0] as string);
          const payment = payments.get(values[2] as string);
          const admission = admissions.get(values[4] as string);
          const event = [...events.values()].find((row) => row.request_id === values[1] && row.event_type === "settlement_authorized");
          return exposure?.state === "authorized" && payment?.state === "processing" && payment.attempt_owner_token === values[3]
            && admission?.state === "settling" && admission.owner_token === values[5] && event ? { request_id: exposure.request_id } : null;
        }
        if (sql.includes("FROM commercial_payment_events")) {
          const event = [...events.values()].find((row) => row.request_id === values[0] && row.event_type === values[1]);
          return event ? { ...event } : null;
        }
        if (sql.includes("FROM commercial_payment_exposures")) {
          const exposure = exposures.get(values[0] as string);
          return exposure ? { ...exposure } : null;
        }
        if (sql.includes("FROM request_payments")) {
          const payment = payments.get(values[0] as string);
          return payment ? { ...payment } : null;
        }
        if (sql.includes("FROM paid_execution_admissions")) {
          const admission = admissions.get(values[0] as string);
          return admission ? { ...admission } : null;
        }
        return null;
      },
      run: async () => {
        let changes = 0;
        if (sql.startsWith("INSERT INTO commercial_payment_exposures")) {
          const requestId = values[0] as string;
          const day = values[1] as string;
          const month = values[2] as string;
          const amount = Number(values[5]);
          const stateCounts = (states: CommercialExposureState[]) => [...exposures.values()]
            .filter((row) => row.request_id !== requestId && row.admission_day === day && states.includes(row.state));
          const monthCount = [...exposures.values()].filter((row) =>
            row.request_id !== requestId && row.admission_month === month && ["reserved", "authorized", "accepted", "ambiguous", "failed"].includes(row.state)).length;
          const payment = payments.get(requestId);
          const admission = admissions.get(requestId);
          const publicPolicy = values[9] as string | null;
          const allowed = lifecycles.get(requestId) === values[20]
            && payment?.state === "required"
            && admission?.state === "reserved" && admission.owner_token === values[27] && admission.lease_expires_at > Number(values[28])
            && stateCounts(["reserved", "authorized", "accepted", "ambiguous", "failed"]).length < Number(values[31])
            && stateCounts(["reserved", "authorized", "accepted", "ambiguous"]).length < Number(values[34])
            && stateCounts(["reserved", "authorized", "accepted", "ambiguous"]).reduce((sum, row) => sum + Number(row.amount_atomic), 0) + amount <= Number(values[38])
            && monthCount < Number(values[41])
            && stateCounts(["reserved", "authorized", "accepted"]).length < Number(values[44]);
          const existing = exposures.get(requestId);
          const bindingMatches = !existing || publicPolicy === null || existing.configuration_fingerprint === values[8];
          if (allowed && (!existing || (existing.state === "released" && bindingMatches))) {
            exposures.set(requestId, {
              request_id: requestId, admission_day: day, admission_month: month,
              network: values[3] as string, asset: values[4] as string, amount_atomic: values[5] as string,
              pay_to: values[6] as string, facilitator: values[7] as string,
               state: "reserved", configuration_fingerprint: values[8] as string,
               public_commercial_policy_version: values[9] as string | null,
               settlement_authorized_at: null, resolved_at: null, created_at: values[17] as string,
            });
            changes = 1;
          }
        } else if (sql.startsWith("INSERT OR IGNORE INTO commercial_payment_events")) {
          const [eventId, eventType, , verifiedPayer, transactionReference, , requestId] = values as Array<string | null>;
          if (!events.has(eventId!) && exposures.has(requestId!)) {
            events.set(eventId!, { event_id: eventId!, request_id: requestId!, event_type: eventType!, verified_payer: verifiedPayer, transaction_reference: transactionReference });
            changes = 1;
          }
        } else if (sql.includes("SET state = 'released'")) {
          const requestId = values[2] as string;
          const exposure = exposures.get(requestId);
          const admission = admissions.get(requestId);
          if (exposure?.state === "reserved" && !["settling", "accepted", "ambiguous", "consumed"].includes(admission?.state ?? "")) {
            exposure.state = "released";
            exposure.resolved_at = values[0] as string;
            changes = 1;
          }
        } else if (sql.includes("SET state = 'authorized'")) {
          const requestId = values[2] as string;
          const payment = payments.get(requestId);
          const admission = admissions.get(requestId);
          const exposure = exposures.get(requestId);
          if (exposure?.state === "reserved" && payment?.state === "processing" && payment.attempt_owner_token === values[4]
            && admission?.state === "settling" && admission.owner_token === values[6]) {
            exposure.state = "authorized";
            exposure.settlement_authorized_at = values[0] as string;
            changes = 1;
          }
        } else if (sql.includes("SET state = ?, accepted_at")) {
          const [target, , , , requestId] = values as string[];
          const exposure = exposures.get(requestId);
          if (exposure && ["reserved", "authorized", target].includes(exposure.state)) {
            exposure.state = target as CommercialExposureState;
            changes = 1;
          }
        }
        return { success: true, meta: { changes } };
      },
    };
    return prepared;
  };

  const db = Object.create(null) as D1Database;
  Object.defineProperty(db, "prepare", { value: vi.fn(statement) });
  return Object.assign(db, {
    prepareRequest(requestId: string, owner = `lifecycle-${requestId}`, admissionOwner = `admission-${requestId}`) {
      lifecycles.set(requestId, owner);
      payments.set(requestId, { state: "required", payer_identity: null, external_reference: null, settled_at: null, attempt_owner_token: null });
      admissions.set(requestId, { state: "reserved", owner_token: admissionOwner, lease_expires_at: 2_000_000_000 });
      return { owner, admissionOwner };
    },
    seedExposure(requestId: string, state: CommercialExposureState, amount = "50000", day = "2026-08-29", fingerprint = "a".repeat(64)) {
      exposures.set(requestId, {
        request_id: requestId, admission_day: day, admission_month: day.slice(0, 7), network: "eip155:8453",
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", amount_atomic: amount,
        pay_to: "0x2222222222222222222222222222222222222222", facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
        state, configuration_fingerprint: fingerprint,
        settlement_authorized_at: state === "authorized" || state === "accepted" || state === "ambiguous" || state === "failed"
          ? `${day}T12:00:01.000Z` : null,
        resolved_at: state === "released" || state === "ambiguous" || state === "failed" ? `${day}T12:00:02.000Z` : null,
        created_at: `${day}T12:00:00.000Z`,
      });
    },
    setSettlementState(requestId: string, paymentState: string, admissionState: string, owner: string) {
      const payment = payments.get(requestId)!;
      payment.state = paymentState;
      payment.attempt_owner_token = owner;
      const admission = admissions.get(requestId)!;
      admission.state = admissionState;
      admission.owner_token = owner;
    },
    setPaymentResult(requestId: string, state: "accepted" | "failed" | "ambiguous") {
      const payment = payments.get(requestId)!;
      payment.state = state;
      payment.payer_identity = state === "accepted" ? "0x1111111111111111111111111111111111111111" : null;
      payment.external_reference = state === "accepted" ? `0x${"ef".repeat(32)}` : null;
      payment.settled_at = state === "accepted" ? "2026-08-29T12:00:02.000Z" : null;
    },
    exposure: (requestId: string) => exposures.get(requestId),
    exposureCount: () => exposures.size,
    eventTypes: (requestId: string) => [...events.values()].filter((row) => row.request_id === requestId).map((row) => row.event_type),
    removeEvent: (requestId: string, eventType: string) => events.delete(`${requestId}:${eventType}`),
    serializedState: () => JSON.stringify({ exposures: [...exposures.values()], events: [...events.values()], boundValues }),
  });
}

const requirement = {
  provider: "x402-facilitator", protocol: "x402-v2-exact-eip3009-upfront", amountAtomic: "50000",
  asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", network: "eip155:8453",
  payTo: "0x2222222222222222222222222222222222222222", requirementsJson: "{}",
};

const generousLimits: CommercialFinancialLimits = {
  dailySettlementLimit: 100,
  dailyAcceptedPaymentLimit: 100,
  dailySettledAtomicLimit: 5_000_000,
  monthlyFacilitatorLimit: 100,
  dailyPaidInferenceLimit: 100,
};

async function context(limits: CommercialFinancialLimits = generousLimits) {
  return createCommercialPaymentContext({ requirement, facilitator: "https://api.cdp.coinbase.com/platform/v2/x402", limits });
}

async function publicMainnetContext(region = "CA", edgeRegion = "NY") {
  return createCommercialPaymentContext({
    requirement,
    facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
    limits: generousLimits,
    publicMainnet: {
      supportUrl: "https://support.example/secondlook",
      maxOutstandingPaidObligations: 5,
      policyVersion: "public-commercial-v1",
      geographyPolicyVersion: "us-states-and-dc-v1",
      termsVersion: "2026-09-02.1",
      privacyVersion: "2026-09-06.1",
      jurisdiction: { serviceUseCountry: "US", serviceUseRegion: region, edgeCountry: "US", edgeRegion },
    },
  });
}

describe("commercial payment accounting", () => {
  it("keeps the permanent ledger independent from the seven-day lifecycle foreign key", () => {
    const migration = readFileSync(new URL("../migrations/0011_add_commercial_accounting.sql", import.meta.url), "utf8");
    expect(migration).not.toMatch(/commercial_payment_exposures[\s\S]*REFERENCES idempotent_requests/);
    expect(migration).toMatch(/FOREIGN KEY \(request_id\) REFERENCES commercial_payment_exposures\(request_id\)/);
    const implementation = readFileSync(new URL("../src/commercial-accounting.ts", import.meta.url), "utf8");
    expect(implementation).not.toMatch(/(?:UPDATE|DELETE FROM) commercial_payment_events/);
  });

  it.each([
    ["daily settlement", { dailySettlementLimit: 1 }],
    ["daily accepted payment", { dailyAcceptedPaymentLimit: 1 }],
    ["daily atomic value", { dailySettledAtomicLimit: 50000 }],
    ["monthly facilitator", { monthlyFacilitatorLimit: 1 }],
    ["daily paid inference", { dailyPaidInferenceLimit: 1 }],
  ])("does not overbook the final %s slot under concurrent reservation", async (_name, override) => {
    const db = accountingDb();
    const env = { DB: db } as unknown as AppEnv;
    const first = db.prepareRequest("request-1");
    const second = db.prepareRequest("request-2");
    const limits = { ...generousLimits, ...override };
    const commercial = await context(limits);
    const results = await Promise.allSettled([
      reserveCommercialPaymentExposure(env, "request-1", first.owner, first.admissionOwner, commercial, new Date("2026-08-29T12:00:00.000Z")),
      reserveCommercialPaymentExposure(env, "request-2", second.owner, second.admissionOwner, commercial, new Date("2026-08-29T12:00:00.000Z")),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect([...results].find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "financial_capacity_reached" } });
  });

  it("binds a released logical public request to its original declared jurisdiction but not its original edge", async () => {
    const db = accountingDb();
    const original = await publicMainnetContext("CA", "NY");
    db.seedExposure("candidate", "released", "50000", "2026-08-29", original.configurationFingerprint);
    const prepared = db.prepareRequest("candidate");
    await expect(reserveCommercialPaymentExposure(
      { DB: db } as unknown as AppEnv,
      "candidate", prepared.owner, prepared.admissionOwner, await publicMainnetContext("CA", "WA"), new Date("2026-08-29T12:00:00.000Z"),
    )).resolves.toBeUndefined();

    const changedDb = accountingDb();
    changedDb.seedExposure("candidate", "released", "50000", "2026-08-29", original.configurationFingerprint);
    const changedPrepared = changedDb.prepareRequest("candidate");
    await expect(reserveCommercialPaymentExposure(
      { DB: changedDb } as unknown as AppEnv,
      "candidate", changedPrepared.owner, changedPrepared.admissionOwner, await publicMainnetContext("NV", "NY"), new Date("2026-08-29T12:00:00.000Z"),
    )).rejects.toMatchObject({ code: "invalid_payment_binding" });
  });

  it.each([
    ["reserved", true, true, true, true, true],
    ["authorized", true, true, true, true, true],
    ["accepted", true, true, true, true, true],
    ["ambiguous", true, true, true, true, false],
    ["failed", true, false, false, true, false],
    ["released", false, false, false, false, false],
  ] as const)("counts %s in the documented dimensions", async (state, settlement, accepted, atomic, monthly, inference) => {
    const dimensions = [
      [settlement, { dailySettlementLimit: 1 }],
      [accepted, { dailyAcceptedPaymentLimit: 1 }],
      [atomic, { dailySettledAtomicLimit: 50000 }],
      [monthly, { monthlyFacilitatorLimit: 1 }],
      [inference, { dailyPaidInferenceLimit: 1 }],
    ] as const;
    for (const [shouldBlock, override] of dimensions) {
      const db = accountingDb();
      db.seedExposure("existing", state);
      const prepared = db.prepareRequest("candidate");
      const env = { DB: db } as unknown as AppEnv;
      const attempt = reserveCommercialPaymentExposure(
        env, "candidate", prepared.owner, prepared.admissionOwner,
        await context({ ...generousLimits, ...override }), new Date("2026-08-29T12:00:00.000Z"),
      );
      if (shouldBlock) await expect(attempt).rejects.toMatchObject({ code: "financial_capacity_reached" });
      else await expect(attempt).resolves.toBeUndefined();
    }
  });

  it("requires reserved exposure before the durable settlement boundary and records idempotent append-only events", async () => {
    const db = accountingDb();
    const prepared = db.prepareRequest("request-1");
    const env = { DB: db } as unknown as AppEnv;
    const commercial = await context();
    await reserveCommercialPaymentExposure(env, "request-1", prepared.owner, prepared.admissionOwner, commercial, new Date("2026-08-29T12:00:00.000Z"));
    await expect(authorizeCommercialSettlement(env, "request-1", prepared.admissionOwner, new Date("2026-08-29T12:00:01.000Z")))
      .rejects.toMatchObject({ code: "payment_state_conflict" });
    db.setSettlementState("request-1", "processing", "settling", prepared.admissionOwner);
    await authorizeCommercialSettlement(env, "request-1", prepared.admissionOwner, new Date("2026-08-29T12:00:01.000Z"));
    db.setPaymentResult("request-1", "accepted");
    await synchronizeCommercialAccountingFromPayment(env, "request-1", new Date("2026-08-29T12:00:02.000Z"));
    await synchronizeCommercialAccountingFromPayment(env, "request-1", new Date("2026-08-29T12:00:03.000Z"));
    expect(db.exposure("request-1")?.state).toBe("accepted");
    expect(db.eventTypes("request-1")).toEqual([
      "financial_exposure_reserved", "settlement_authorized", "settlement_accepted",
    ]);
  });

  it("repairs missing reservation and authorization events without reserving another exposure", async () => {
    const db = accountingDb();
    const prepared = db.prepareRequest("request-repair");
    const env = { DB: db } as unknown as AppEnv;
    await reserveCommercialPaymentExposure(
      env, "request-repair", prepared.owner, prepared.admissionOwner,
      await context(), new Date("2026-08-29T12:00:00.000Z"),
    );
    db.removeEvent("request-repair", "financial_exposure_reserved");
    await repairCommercialAccountingEvidence(env, "request-repair");
    expect(db.exposureCount()).toBe(1);
    expect(db.eventTypes("request-repair")).toEqual(["financial_exposure_reserved"]);

    db.setSettlementState("request-repair", "processing", "settling", prepared.admissionOwner);
    await authorizeCommercialSettlement(env, "request-repair", prepared.admissionOwner, new Date("2026-08-29T12:00:01.000Z"));
    db.removeEvent("request-repair", "settlement_authorized");
    await repairCommercialAccountingEvidence(env, "request-repair");
    await repairCommercialAccountingEvidence(env, "request-repair");
    expect(db.exposureCount()).toBe(1);
    expect(db.eventTypes("request-repair")).toEqual([
      "financial_exposure_reserved", "settlement_authorized",
    ]);
  });

  it("releases only before settlement authorization and retains no proof, signature, credential, JWT, or judgment content", async () => {
    const db = accountingDb();
    const prepared = db.prepareRequest("request-1");
    const env = { DB: db } as unknown as AppEnv;
    await reserveCommercialPaymentExposure(env, "request-1", prepared.owner, prepared.admissionOwner, await context(), new Date("2026-08-29T12:00:00.000Z"));
    await releaseCommercialPaymentExposure(env, "request-1", new Date("2026-08-29T12:00:01.000Z"));
    expect(db.exposure("request-1")?.state).toBe("released");
    expect(db.eventTypes("request-1")).toEqual(["financial_exposure_reserved", "financial_exposure_released"]);
    const stored = db.serializedState();
    for (const forbidden of ["PAYMENT-SIGNATURE", "signature-secret", "cdp-secret", "jwt-secret", "judgment input", "judgment output"]) {
      expect(stored).not.toContain(forbidden);
    }
  });

  it.each(["failed", "ambiguous"] as const)("repairs lagging exposure and append-only evidence from authoritative %s payment truth", async (state) => {
    const db = accountingDb();
    const prepared = db.prepareRequest(`request-${state}`);
    const env = { DB: db } as unknown as AppEnv;
    await reserveCommercialPaymentExposure(
      env, `request-${state}`, prepared.owner, prepared.admissionOwner,
      await context(), new Date("2026-08-29T12:00:00.000Z"),
    );
    db.setSettlementState(`request-${state}`, "processing", "settling", prepared.admissionOwner);
    await authorizeCommercialSettlement(env, `request-${state}`, prepared.admissionOwner, new Date("2026-08-29T12:00:01.000Z"));
    db.setPaymentResult(`request-${state}`, state);
    await synchronizeCommercialAccountingFromPayment(env, `request-${state}`, new Date("2026-08-29T12:00:02.000Z"));
    await synchronizeCommercialAccountingFromPayment(env, `request-${state}`, new Date("2026-08-29T12:00:03.000Z"));
    expect(db.exposure(`request-${state}`)?.state).toBe(state);
    expect(db.eventTypes(`request-${state}`)).toEqual([
      "financial_exposure_reserved", "settlement_authorized", `settlement_${state}`,
    ]);
  });

  it("repairs a safely released pre-authorization request without releasing a post-authorization reservation", async () => {
    const safeDb = accountingDb();
    const safe = safeDb.prepareRequest("safe");
    const safeEnv = { DB: safeDb } as unknown as AppEnv;
    await reserveCommercialPaymentExposure(safeEnv, "safe", safe.owner, safe.admissionOwner, await context(), new Date("2026-08-29T12:00:00.000Z"));
    safeDb.setSettlementState("safe", "required", "released", safe.admissionOwner);
    await synchronizeCommercialAccountingFromPayment(safeEnv, "safe", new Date("2026-08-29T12:01:00.000Z"));
    expect(safeDb.exposure("safe")?.state).toBe("released");

    const unsafeDb = accountingDb();
    const unsafe = unsafeDb.prepareRequest("unsafe");
    const unsafeEnv = { DB: unsafeDb } as unknown as AppEnv;
    await reserveCommercialPaymentExposure(unsafeEnv, "unsafe", unsafe.owner, unsafe.admissionOwner, await context(), new Date("2026-08-29T12:00:00.000Z"));
    unsafeDb.setSettlementState("unsafe", "processing", "settling", unsafe.admissionOwner);
    await synchronizeCommercialAccountingFromPayment(unsafeEnv, "unsafe", new Date("2026-08-29T12:01:00.000Z"));
    expect(unsafeDb.exposure("unsafe")?.state).toBe("reserved");
    await expect(releaseCommercialPaymentExposure(unsafeEnv, "unsafe", new Date("2026-08-29T12:01:01.000Z")))
      .rejects.toMatchObject({ code: "payment_state_conflict" });
  });
});
