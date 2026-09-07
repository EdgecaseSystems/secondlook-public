import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  fingerprintSecondLookRequest,
  markInferenceAmbiguous,
  markInferenceRunning,
  reserveIdempotentRequest,
} from "../src/idempotency";
import { parseSecondLookRequest } from "../src/validation";
import type { AppEnv } from "../src/types";

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
  expires_at: number;
};

function lifecycleDb(options: { loseCompletionOwnership?: boolean; loseAmbiguityOwnership?: boolean } = {}): D1Database & {
  decisionCount(): number;
  completedCount(): number;
  executionContextFor(requestId: string): string | undefined;
  forceCompleted(requestId: string, response: string): void;
  seedCommercialAccounting(requestId: string, state?: string): void;
  commercialRequestIds(): string[];
  responseFor(requestId: string): string | null | undefined;
} {
  const rows = new Map<string, LifecycleRow>();
  const decisions = new Set<string>();
  const commercialRows = new Map<string, string>();
  const statement = (sql: string) => {
    let values: unknown[] = [];
    const prepared = {
      bind: (...bound: unknown[]) => { values = bound; return prepared; },
      first: async () => {
        if (sql.includes("FROM api_service_control")) {
          return {
            inference_enabled: 1,
            global_daily_inference_limit: 250,
            global_concurrent_inference_limit: 3,
            provider_failure_threshold: 3,
            provider_circuit_seconds: 60,
            circuit_open_until: null,
          };
        }
        if (sql.includes("FROM idempotent_requests")) {
          const row = rows.get(`${values[0]}:${values[1]}`);
          return row ? { ...row } : null;
        }
        return { id: "decision-1" };
      },
      run: async () => {
        let changes = 1;
        if (sql.startsWith("DELETE FROM idempotent_requests")) {
          changes = 0;
          const expiresAt = Number(values[0]);
          for (const [scope, row] of rows) {
            const unresolvedCommercialReservation = sql.includes("commercial_payment_exposures.state = 'reserved'")
              && commercialRows.get(row.request_id) === "reserved";
            if (row.expires_at <= expiresAt && !unresolvedCommercialReservation) {
              rows.delete(scope);
              changes += 1;
            }
          }
        } else if (sql.includes("INSERT OR IGNORE INTO idempotent_requests")) {
          const [requestId, caller, key, hash, executionContext, owner, created, , expiresAt] = values as Array<string | number>;
          const scope = `${caller}:${key}`;
          if (rows.has(scope)) changes = 0;
          else rows.set(scope, {
            request_id: requestId as string,
            caller_key: caller as string,
            idempotency_key_hash: key as string,
            request_hash: hash as string,
            execution_context: executionContext as string,
            state: "reserved",
            owner_token: owner as string,
            response_json: null,
            updated_at: created as string,
            expires_at: expiresAt as number,
          });
        } else if (sql.includes("SET execution_context = ?, state = 'reserved'")) {
          const [executionContext, owner, updated, , requestId, requestHash, staleBefore] = values as string[];
          const row = [...rows.values()].find((candidate) => candidate.request_id === requestId);
          if (!row || row.request_hash !== requestHash || !(
            row.state === "failed_before_inference" || (row.state === "reserved" && row.updated_at <= staleBefore)
          )) changes = 0;
          else {
            row.execution_context = executionContext;
            row.state = "reserved";
            row.owner_token = owner;
            row.updated_at = updated;
          }
        } else if (sql.includes("SET state = 'inference_running'")) {
          const [started, , requestId, owner] = values as string[];
          const row = [...rows.values()].find((candidate) => candidate.request_id === requestId);
          if (!row || row.owner_token !== owner || row.state !== "reserved") changes = 0;
          else { row.state = "inference_running"; row.updated_at = started; }
        } else if (sql.startsWith("INSERT INTO decisions")) {
          const requestId = values.at(-2) as string;
          const owner = values.at(-1) as string;
          const row = [...rows.values()].find((candidate) => candidate.request_id === requestId);
          if (options.loseCompletionOwnership || !row || row.owner_token !== owner || row.state !== "inference_running") changes = 0;
          else decisions.add(values[0] as string);
        } else if (sql.includes("SET state = 'completed'")) {
          const [, response, completed, , requestId, owner] = values as string[];
          const row = [...rows.values()].find((candidate) => candidate.request_id === requestId);
          if (options.loseCompletionOwnership || !row || row.owner_token !== owner || row.state !== "inference_running") changes = 0;
          else {
            row.state = "completed";
            row.owner_token = null;
            row.response_json = response;
            row.updated_at = completed;
          }
        } else if (sql.includes("SET state = 'ambiguous'")) {
          const [, updated, requestId, owner] = values as string[];
          const row = [...rows.values()].find((candidate) => candidate.request_id === requestId);
          if (options.loseAmbiguityOwnership || !row || row.owner_token !== owner || row.state !== "inference_running") changes = 0;
          else { row.state = "ambiguous"; row.owner_token = null; row.updated_at = updated; }
        } else if (sql.includes("SET state = 'failed_before_inference'")) {
          const [, updated, requestId, owner] = values as string[];
          const row = [...rows.values()].find((candidate) => candidate.request_id === requestId);
          if (!row || row.owner_token !== owner || row.state !== "reserved") changes = 0;
          else { row.state = "failed_before_inference"; row.owner_token = null; row.updated_at = updated; }
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
    decisionCount: () => decisions.size,
    completedCount: () => [...rows.values()].filter((row) => row.state === "completed").length,
    executionContextFor: (requestId: string) => [...rows.values()].find((row) => row.request_id === requestId)?.execution_context,
    forceCompleted: (requestId: string, response: string) => {
      const row = [...rows.values()].find((candidate) => candidate.request_id === requestId);
      if (!row) throw new Error("Lifecycle not found.");
      row.state = "completed";
      row.owner_token = null;
      row.response_json = response;
    },
    seedCommercialAccounting: (requestId: string, state = "accepted") => commercialRows.set(requestId, state),
    commercialRequestIds: () => [...commercialRows.keys()],
    responseFor: (requestId: string) => [...rows.values()].find((row) => row.request_id === requestId)?.response_json,
  });
}

function request(key?: string, goal = "Review this medication order", model?: string): Request {
  const headers: Record<string, string> = {
    authorization: "Bearer test-secret",
    "content-type": "application/json",
  };
  if (key) headers["idempotency-key"] = key;
  if (model) headers["x-secondlook-model"] = model;
  return new Request("https://secondlook.example/v1/second-look", {
    method: "POST",
    headers,
    body: JSON.stringify({ goal, proposed_action: "Administer the prescribed dose." }),
  });
}

function clearGateResponse(reason = "The supplied facts support the action.") {
  return {
    schema_version: "secondlook-gates-v1",
    gates: {
      authority_or_required_human_review: { triggered: false, reason: null },
      known_material_concern: { triggered: false, reason: null },
      material_unknown: { triggered: false, reason: null },
      inherent_human_accountability: { triggered: false, reason: null },
    },
    clear_reason: reason,
    key_risks: [],
    missing_information: [],
  };
}

function successfulAi(run = vi.fn(async () => ({
  response: clearGateResponse(),
  usage: { prompt_tokens: 10, completion_tokens: 5 },
}))) {
  const ai = Object.create(null) as Ai;
  Object.defineProperty(ai, "run", { value: run });
  return { ai, run };
}

describe("durable idempotency lifecycle", () => {
  it("runs one inference and replays the exact durable result for the same caller, key, and request", async () => {
    const db = lifecycleDb();
    const { ai, run } = successfulAi();
    const env = { AI: ai, DB: db, SECONDLOOK_ACCESS_KEY: "test-secret" } satisfies AppEnv;

    const first = await worker.fetch(request("retry-key-0001"), env);
    const firstBody = await first.json();
    const replay = await worker.fetch(request("retry-key-0001"), env);

    expect(first.status).toBe(200);
    expect(first.headers.get("idempotency-replayed")).toBe("false");
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await replay.json()).toEqual(firstBody);
    expect(run).toHaveBeenCalledOnce();
  });

  it("replays the historical result when server execution context changes", async () => {
    const db = lifecycleDb();
    const { ai, run } = successfulAi();
    const firstEnv = { AI: ai, DB: db, SECONDLOOK_ACCESS_KEY: "test-secret", MODEL_PROVIDER: "workers_ai" } satisfies AppEnv;
    const deployedEnv = { AI: ai, DB: db, SECONDLOOK_ACCESS_KEY: "test-secret", MODEL_PROVIDER: "openai", OPENAI_MODEL: "later-default" } satisfies AppEnv;

    const first = await worker.fetch(request("retry-key-deploy-01"), firstEnv);
    const firstBody = await first.json();
    const replay = await worker.fetch(request("retry-key-deploy-01"), deployedEnv);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await replay.json()).toEqual(firstBody);
    expect(run).toHaveBeenCalledOnce();
  });

  it("expires seven-day replay independently while permanent commercial accounting survives and key reuse gets a fresh lifecycle", async () => {
    const db = lifecycleDb();
    const env = { DB: db } as unknown as AppEnv;
    const createdAt = new Date("2026-08-20T00:00:00.000Z");
    const expired = await reserveIdempotentRequest(env, { kind: "internal" }, "expired-commercial-key", "old-hash", "old-context", createdAt);
    if (expired.kind !== "acquired") throw new Error("Expected lifecycle ownership.");
    db.forceCompleted(expired.requestId, JSON.stringify({ old: "response_json" }));
    db.seedCommercialAccounting(expired.requestId);

    const replacement = await reserveIdempotentRequest(
      env,
      { kind: "internal" },
      "expired-commercial-key",
      "new-hash",
      "new-context",
      new Date("2026-08-28T00:00:01.000Z"),
    );
    if (replacement.kind !== "acquired") throw new Error("Expected fresh lifecycle ownership.");
    db.seedCommercialAccounting(replacement.requestId);

    expect(replacement.requestId).not.toBe(expired.requestId);
    expect(db.responseFor(expired.requestId)).toBeUndefined();
    expect(db.commercialRequestIds()).toEqual([expired.requestId, replacement.requestId]);
  });

  it("does not insert a decision when completion ownership is lost", async () => {
    const db = lifecycleDb({ loseCompletionOwnership: true });
    const { ai, run } = successfulAi();
    const response = await worker.fetch(request("retry-key-owner-loss-01"), {
      AI: ai,
      DB: db,
      SECONDLOOK_ACCESS_KEY: "test-secret",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "idempotency_state_ambiguous", retryable: false });
    expect(db.decisionCount()).toBe(0);
    expect(db.completedCount()).toBe(0);
    expect(run).toHaveBeenCalledOnce();
  });

  it("rejects same-key different-payload and different-model reuse before another inference", async () => {
    const db = lifecycleDb();
    const { ai, run } = successfulAi();
    const env = { AI: ai, DB: db, SECONDLOOK_ACCESS_KEY: "test-secret" } satisfies AppEnv;
    await worker.fetch(request("retry-key-0002"), env);

    const changedPayload = await worker.fetch(request("retry-key-0002", "A different goal"), env);
    const changedModel = await worker.fetch(request("retry-key-0002", "Review this medication order", "@cf/zai-org/glm-4.7-flash"), env);

    expect(changedPayload.status).toBe(409);
    expect(await changedPayload.json()).toMatchObject({ code: "idempotency_key_conflict", retryable: false });
    expect(changedModel.status).toBe(409);
    expect(await changedModel.json()).toMatchObject({ code: "idempotency_key_conflict", retryable: false });
    expect(run).toHaveBeenCalledOnce();
  });

  it("blocks a concurrent duplicate while the first inference is running", async () => {
    let resolveProvider!: (value: unknown) => void;
    const provider = vi.fn(() => new Promise((resolve) => { resolveProvider = resolve; }));
    const { ai, run } = successfulAi(provider);
    const env = { AI: ai, DB: lifecycleDb(), SECONDLOOK_ACCESS_KEY: "test-secret" } satisfies AppEnv;

    const firstPending = worker.fetch(request("retry-key-0003"), env);
    await vi.waitUntil(() => run.mock.calls.length === 1);
    const duplicate = await worker.fetch(request("retry-key-0003"), env);
    expect(duplicate.status).toBe(409);
    expect(duplicate.headers.get("retry-after")).toBe("5");
    expect(await duplicate.json()).toMatchObject({ code: "idempotency_in_progress", retryable: true });
    expect(run).toHaveBeenCalledOnce();

    resolveProvider({ response: clearGateResponse("Clear.") });
    expect((await firstPending).status).toBe(200);
  });

  it("keeps provider-failure state ambiguous and never automatically re-infers", async () => {
    const run = vi.fn(async () => { throw new Error("provider failure"); });
    const { ai } = successfulAi(run);
    const env = { AI: ai, DB: lifecycleDb(), SECONDLOOK_ACCESS_KEY: "test-secret" } satisfies AppEnv;

    const first = await worker.fetch(request("retry-key-0004"), env);
    const retry = await worker.fetch(request("retry-key-0004"), env);

    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ code: "idempotency_state_ambiguous", retryable: false });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ code: "idempotency_state_ambiguous", retryable: false });
    expect(run).toHaveBeenCalledOnce();
  });

  it("allows unrelated authenticated callers to use the same key independently", async () => {
    const db = lifecycleDb();
    const internal = await reserveIdempotentRequest({ DB: db } as unknown as AppEnv, { kind: "internal" }, "shared-key-01", "hash", "context");
    const pilot = await reserveIdempotentRequest(
      { DB: db } as unknown as AppEnv,
      { kind: "pilot", key_id: "pilot-1", customer_id: "customer-1", project_id: "project-1" },
      "shared-key-01", "hash", "context",
    );
    expect(internal.kind).toBe("acquired");
    expect(pilot.kind).toBe("acquired");
  });

  it("reclaims only stale pre-inference reservations, records the current execution context, and treats stale started inference as ambiguous", async () => {
    const db = lifecycleDb();
    const env = { DB: db } as unknown as AppEnv;
    const old = new Date("2026-08-28T00:00:00.000Z");
    const later = new Date("2026-08-28T00:02:00.000Z");
    const safe = await reserveIdempotentRequest(env, { kind: "internal" }, "stale-safe-01", "hash", "old-context", old);
    expect(safe.kind).toBe("acquired");
    if (safe.kind !== "acquired") throw new Error("Expected reservation ownership.");
    const reclaimed = await reserveIdempotentRequest(env, { kind: "internal" }, "stale-safe-01", "hash", "current-context", later);
    expect(reclaimed.kind).toBe("acquired");
    expect(reclaimed).toMatchObject({ requestId: safe.requestId });
    expect(db.executionContextFor(safe.requestId)).toBe("current-context");

    const started = await reserveIdempotentRequest(env, { kind: "internal" }, "stale-risk-01", "hash", "context", old);
    if (started.kind !== "acquired") throw new Error("Expected reservation ownership.");
    await markInferenceRunning(env, started.requestId, started.ownerToken, old);
    await expect(reserveIdempotentRequest(env, { kind: "internal" }, "stale-risk-01", "hash", "context", later))
      .rejects.toMatchObject({ code: "idempotency_state_ambiguous", retryable: false });
  });

  it("does not claim ambiguity was recorded when its conditional lifecycle transition loses ownership", async () => {
    const db = lifecycleDb({ loseAmbiguityOwnership: true });
    const env = { DB: db } as unknown as AppEnv;
    const reservation = await reserveIdempotentRequest(env, { kind: "internal" }, "ambiguous-owner-loss-01", "hash", "context");
    if (reservation.kind !== "acquired") throw new Error("Expected reservation ownership.");
    await markInferenceRunning(env, reservation.requestId, reservation.ownerToken);

    await expect(markInferenceAmbiguous(env, reservation.requestId, reservation.ownerToken, "provider_failure"))
      .rejects.toMatchObject({ code: "idempotency_state_ambiguous", retryable: false });
  });

  it("canonicalizes validated objects while preserving explicit model-override differences", async () => {
    const left = parseSecondLookRequest({ goal: "Review", proposed_action: "Act", known_facts: ["A"] });
    const right = parseSecondLookRequest({ known_facts: ["A"], proposed_action: "Act", goal: "Review" });
    const env = { MODEL_PROVIDER: "workers_ai" } as AppEnv;
    const leftHash = await fingerprintSecondLookRequest(left, env, null);
    const rightHash = await fingerprintSecondLookRequest(right, env, null);
    const overrideHash = await fingerprintSecondLookRequest(right, env, "@cf/zai-org/glm-4.7-flash");
    expect(leftHash.hash).toBe(rightHash.hash);
    expect(overrideHash.hash).not.toBe(leftHash.hash);
  });

  it("rejects invalid keys and keeps idempotency optional for existing callers", async () => {
    const { ai, run } = successfulAi();
    const env = { AI: ai, DB: lifecycleDb(), SECONDLOOK_ACCESS_KEY: "test-secret" } satisfies AppEnv;
    const invalid = await worker.fetch(request("bad key"), env);
    const absent = await worker.fetch(request(), env);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_idempotency_key", retryable: false });
    expect(absent.status).toBe(200);
    expect(run).toHaveBeenCalledOnce();
  });
});
