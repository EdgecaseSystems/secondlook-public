import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { WORKERS_AI_MODEL } from "../src/judgment";
import type { AppEnv } from "../src/types";

afterEach(() => {
  vi.restoreAllMocks();
});

function gateResponse(status: "no_material_concern_found" | "material_concern_found" | "insufficient_information" | "human_review_required", reason: string, key_risks: string[] = [], missing_information: string[] = []) {
  const gates: Record<string, { triggered: boolean; reason: string | null }> = {
    authority_or_required_human_review: { triggered: status === "human_review_required", reason: status === "human_review_required" ? reason : null },
    known_material_concern: { triggered: status === "material_concern_found", reason: status === "material_concern_found" ? reason : null },
    material_unknown: { triggered: status === "insufficient_information", reason: status === "insufficient_information" ? reason : null },
    inherent_human_accountability: { triggered: false, reason: null },
  };
  return { schema_version: "secondlook-gates-v1", gates, clear_reason: status === "no_material_concern_found" ? reason : null, key_risks, missing_information: status === "insufficient_information" && missing_information.length === 0 ? ["Required fact"] : missing_information };
}

function medicationCaseRequest(authorization: string | null = "Bearer test-secret"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization) headers.authorization = authorization;
  return new Request("https://secondlook.example/v1/second-look", {
    method: "POST",
    headers,
    body: JSON.stringify({
      goal: "Reduce a patient's reported side effects.",
      proposed_action: "Change the prescribed medication dose in the patient portal.",
      reasoning_summary: "A lower dose may reduce side effects.",
      authority: { status: "unknown" },
      hard_constraints: ["Medication changes require a licensed clinician"],
      known_facts: ["No clinician order authorizes this dose change"],
    }),
  });
}

function outcomeRequest(authorization: string | null = "Bearer test-secret"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization) headers.authorization = authorization;
  return new Request("https://secondlook.example/v1/outcomes", {
    method: "POST",
    headers,
    body: JSON.stringify({ decision_id: "decision-1", outcome: "successful" }),
  });
}

function operationalDb(options: {
  rateChanges?: number;
  dayCount?: number;
  burstCount?: number;
  minuteCount?: number;
  inferenceEnabled?: number;
  circuitOpenUntil?: number | null;
  leaseChanges?: number;
  globalChanges?: number;
} = {}): D1Database {
  const db = Object.create(null) as D1Database;
  Object.defineProperty(db, "prepare", {
    value: vi.fn((sql: string) => {
      if (sql.includes("FROM api_service_control") && sql.startsWith("SELECT")) {
        return {
          first: vi.fn(async () => ({
            inference_enabled: options.inferenceEnabled ?? 1,
            global_daily_inference_limit: 250,
            global_concurrent_inference_limit: 3,
            provider_failure_threshold: 3,
            provider_circuit_seconds: 60,
            circuit_open_until: options.circuitOpenUntil ?? null,
          })),
        };
      }
      const bound = {
        run: vi.fn(async () => ({
          success: true,
          meta: {
            changes: sql.includes("INSERT INTO api_caller_usage") ? (options.rateChanges ?? 1)
              : sql.includes("INSERT OR IGNORE INTO api_inference_leases") ? (options.leaseChanges ?? 1)
                : sql.includes("INSERT INTO api_global_usage") ? (options.globalChanges ?? 1)
                  : 1,
          },
        })),
        first: vi.fn(async () => {
          const now = new Date();
          const epochSeconds = Math.floor(now.getTime() / 1_000);
          return {
            id: "decision-1",
            burst_window_start: Math.floor(epochSeconds / 10) * 10,
            burst_count: options.burstCount ?? 1,
            minute_window_start: Math.floor(epochSeconds / 60) * 60,
            minute_count: options.minuteCount ?? 1,
            day_window_start: now.toISOString().slice(0, 10),
            day_count: options.dayCount ?? 1,
          };
        }),
      };
      return { bind: vi.fn(() => bound), run: bound.run, first: bound.first };
    }),
  });
  return db;
}

describe("SecondLook endpoint error boundaries", () => {
  it("returns review_status with a deprecated recommendation compatibility alias", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", {
      value: vi.fn(async () => ({
        response: gateResponse("human_review_required", "Required authority is missing.", ["The caller may lack authority."]),
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      })),
    });
    const db = operationalDb();
    const response = await worker.fetch(medicationCaseRequest("Bearer test-secret"), {
      AI: ai,
      DB: db,
      SECONDLOOK_ACCESS_KEY: "test-secret",
    });
    const payload = await response.json<{ review_status: string; recommendation: string; policy_version: string }>();
    expect(response.status).toBe(200);
    expect(payload.review_status).toBe("human_review_required");
    expect(payload.recommendation).toBe("escalate_to_human");
    expect(payload.policy_version).toBe("2026-08-27.5");
    expect(consoleLog).toHaveBeenCalledWith("SecondLook inference completed", expect.objectContaining({
      model: WORKERS_AI_MODEL,
      policy_version: "2026-08-27.5",
      input_tokens: 100,
      output_tokens: 20,
      estimated_inference_cost_micro_usd: 16,
      estimated_workers_ai_neurons: 1,
    }));
  });

  it("preserves bearer authentication for protected endpoints", async () => {
    const env = {
      AI: Object.create(null) as Ai,
      DB: operationalDb(),
      SECONDLOOK_ACCESS_KEY: "test-secret",
    } satisfies AppEnv;
    const response = await worker.fetch(medicationCaseRequest("Bearer wrong-secret"), env);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "unauthorized", code: "invalid_access_key", category: "access", retryable: false });
  });

  it("fails closed for protected endpoints without a configured access key before AI or D1 work", async () => {
    const aiRun = vi.fn();
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: aiRun });
    const prepare = vi.fn();
    const db = Object.create(null) as D1Database;
    Object.defineProperty(db, "prepare", { value: prepare });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = { AI: ai, DB: db } satisfies AppEnv;

    const secondLookResponse = await worker.fetch(medicationCaseRequest(), env);
    const outcomeResponse = await worker.fetch(outcomeRequest(), env);

    expect(secondLookResponse.status).toBe(503);
    expect(await secondLookResponse.json()).toMatchObject({ error: "service_unavailable", code: "missing_access_key", retryable: false });
    expect(outcomeResponse.status).toBe(503);
    expect(await outcomeResponse.json()).toMatchObject({ error: "service_unavailable", code: "missing_access_key", retryable: false });
    expect(aiRun).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenNthCalledWith(1, "SecondLook access key unavailable", { path: "/v1/second-look", error_code: "missing_access_key" });
    expect(consoleError).toHaveBeenNthCalledWith(2, "SecondLook access key unavailable", { path: "/v1/outcomes", error_code: "missing_access_key" });
  });

  it("keeps public health and discovery endpoints available without a configured access key", async () => {
    const env = { AI: Object.create(null) as Ai, DB: operationalDb() } satisfies AppEnv;

    const health = await worker.fetch(new Request("https://secondlook.example/health"), env);
    const discovery = await worker.fetch(new Request("https://secondlook.example/.well-known/secondlook.json"), env);

    expect(health.status).toBe(200);
    expect(discovery.status).toBe(200);
  });

  it("returns concise public support information without AI or D1 work", async () => {
    const aiRun = vi.fn();
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: aiRun });
    const prepare = vi.fn();
    const db = Object.create(null) as D1Database;
    Object.defineProperty(db, "prepare", { value: prepare });

    const response = await worker.fetch(
      new Request("https://secondlook.example/support"),
      { AI: ai, DB: db } satisfies AppEnv,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe(
      "SecondLook Support\n\nFor payment, replay, or service issues:\nsupport@example.com\n",
    );
    expect(aiRun).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("returns 401 for a missing bearer credential when the access key is configured", async () => {
    const env = {
      AI: Object.create(null) as Ai,
      DB: operationalDb(),
      SECONDLOOK_ACCESS_KEY: "test-secret",
    } satisfies AppEnv;

    const response = await worker.fetch(medicationCaseRequest(null), env);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "unauthorized", code: "invalid_access_key", category: "access", retryable: false });
  });

  it("does not misclassify an invalid model result for eval-16 as an HTTP 400 request error", async () => {
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", {
      value: vi.fn(async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                review_status: "approve",
                reason: "This label is outside the contract.",
                key_risks: [],
                missing_information: [],
              }),
            },
          },
        ],
      })),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = { AI: ai, DB: operationalDb(), SECONDLOOK_ACCESS_KEY: "test-secret" } satisfies AppEnv;

    const response = await worker.fetch(medicationCaseRequest(), env);
    const payload = await response.json<{ error: string; detail: string }>();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      error: "model_invalid_response",
      code: "invalid_gate_schema",
      detail: "invalid_gate_schema",
      category: "provider",
      message: "The model did not return a valid SecondLook decision.",
      retryable: false,
    });
    expect(consoleError).toHaveBeenCalledWith("SecondLook model response rejected", expect.objectContaining({
      path: "/v1/second-look",
      error_code: "invalid_gate_schema",
    }));
  });

  it("logs only allowlisted bounded Workers AI error metadata and keeps the response generic", async () => {
    const providerError = Object.assign(new Error("3040: prompt text must never be logged"), {
      name: "AiError",
      internal_code: "provider_timeout",
      code: 1007,
      httpCode: 524,
      status: 429,
      statusCode: 503,
      description: "x".repeat(300),
      request_id: "request-123",
      proposed_action: "sensitive action",
      arbitrary_extra: "must not be logged",
    });
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: vi.fn(async () => { throw providerError; }) });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await worker.fetch(medicationCaseRequest(), { AI: ai, DB: operationalDb(), SECONDLOOK_ACCESS_KEY: "test-secret" });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "provider_failure", code: "provider_unavailable", category: "provider", retryable: true });
    expect(consoleError).toHaveBeenCalledWith("SecondLook provider request failed", expect.objectContaining({
      path: "/v1/second-look",
      error_type: "AiError",
      provider_error_code: "provider_timeout",
      provider_http_code: 524,
      provider_description: "x".repeat(256),
      provider_request_id: "request-123",
    }));
    expect(consoleError.mock.calls[0]?.[1]).not.toHaveProperty("proposed_action");
    expect(consoleError.mock.calls[0]?.[1]).not.toHaveProperty("arbitrary_extra");
    expect(JSON.stringify(consoleError.mock.calls[0])).not.toContain("3040: prompt text must never be logged");
  });

  it("logs numeric native Workers AI code and status aliases only when preferred metadata is absent", async () => {
    const providerError = Object.assign(new Error("message must remain excluded"), {
      name: "AiError",
      code: 1008,
      status: 503,
      arbitrary_extra: "must not be logged",
    });
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: vi.fn(async () => { throw providerError; }) });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await worker.fetch(medicationCaseRequest(), { AI: ai, DB: operationalDb(), SECONDLOOK_ACCESS_KEY: "test-secret" });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "provider_failure", code: "provider_unavailable", retryable: true });
    expect(consoleError).toHaveBeenCalledWith("SecondLook provider request failed", expect.objectContaining({
      path: "/v1/second-look",
      error_type: "AiError",
      provider_error_code: 1008,
      provider_http_code: 503,
    }));
  });

  it("logs the numeric native Workers AI statusCode alias when status is absent", async () => {
    const providerError = Object.assign(new Error("message must remain excluded"), {
      name: "AiError",
      statusCode: 502,
    });
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: vi.fn(async () => { throw providerError; }) });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await worker.fetch(medicationCaseRequest(), { AI: ai, DB: operationalDb(), SECONDLOOK_ACCESS_KEY: "test-secret" });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "provider_failure", code: "provider_unavailable", retryable: true });
    expect(consoleError).toHaveBeenCalledWith("SecondLook provider request failed", expect.objectContaining({
      path: "/v1/second-look",
      error_type: "AiError",
      provider_http_code: 502,
    }));
  });

  it("ignores string values in numeric-only native Workers AI aliases", async () => {
    const providerError = Object.assign(new Error("message must remain excluded"), {
      name: "AiError",
      code: "1008",
      status: "503",
      statusCode: "502",
      status_code: "500",
    });
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: vi.fn(async () => { throw providerError; }) });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await worker.fetch(medicationCaseRequest(), { AI: ai, DB: operationalDb(), SECONDLOOK_ACCESS_KEY: "test-secret" });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "provider_failure", code: "provider_unavailable", retryable: true });
    expect(consoleError).toHaveBeenCalledWith("SecondLook provider request failed", expect.objectContaining({
      path: "/v1/second-look",
      error_type: "AiError",
    }));
  });

  it.each([
    ["3040: capacity text", 3040],
    ["AiError: 3036: quota text", 3036],
    ["Error: 3007: timeout text", 3007],
    ["Arbitrary failure included 3040 later", undefined],
    ["User-provided note says 3040 is important", undefined],
  ])("logs only a strictly prefixed native Workers AI message code", async (message, expectedCode) => {
    const providerError = Object.assign(new Error(message), { name: "AiError" });
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: vi.fn(async () => { throw providerError; }) });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await worker.fetch(medicationCaseRequest(), { AI: ai, DB: operationalDb(), SECONDLOOK_ACCESS_KEY: "test-secret" });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "provider_failure", code: "provider_unavailable", retryable: true });
    expect(consoleError).toHaveBeenCalledWith("SecondLook provider request failed", expect.objectContaining({
      path: "/v1/second-look",
      error_type: "AiError",
      ...(expectedCode === undefined ? {} : { provider_error_code: expectedCode }),
    }));
    expect(JSON.stringify(consoleError.mock.calls[0])).not.toContain(message);
  });

  it.each([
    ["Error: internal error; reference = abc123", "abc123"],
    ["Error: internal error; reference = abc-123", undefined],
    [`Error: internal error; reference = ${"a".repeat(65)}`, undefined],
  ])("logs only a strict bounded internal-error reference", async (message, expectedReference) => {
    const providerError = Object.assign(new Error(message), { name: "AiError" });
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: vi.fn(async () => { throw providerError; }) });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await worker.fetch(medicationCaseRequest(), { AI: ai, DB: operationalDb(), SECONDLOOK_ACCESS_KEY: "test-secret" });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "provider_failure", code: "provider_unavailable", retryable: true });
    expect(consoleError).toHaveBeenCalledWith("SecondLook provider request failed", expect.objectContaining({
      path: "/v1/second-look",
      error_type: "AiError",
      ...(expectedReference === undefined ? {} : { provider_internal_reference: expectedReference }),
    }));
    expect(JSON.stringify(consoleError.mock.calls[0])).not.toContain(message);
  });

  it("keeps generic Error logging safe and the response generic", async () => {
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: vi.fn(async () => { throw new Error("sensitive model or user text"); }) });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await worker.fetch(medicationCaseRequest(), { AI: ai, DB: operationalDb(), SECONDLOOK_ACCESS_KEY: "test-secret" });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "provider_failure", code: "provider_unavailable", retryable: true });
    expect(consoleError).toHaveBeenCalledWith("SecondLook provider request failed", expect.objectContaining({
      path: "/v1/second-look",
      error_type: "Error",
    }));
    expect(JSON.stringify(consoleError.mock.calls[0])).not.toContain("sensitive model or user text");
  });

  it("returns a structured 400 only for actual client input errors", async () => {
    const env = {
      AI: Object.create(null) as Ai,
      DB: operationalDb(),
      SECONDLOOK_ACCESS_KEY: "test-secret",
    } satisfies AppEnv;
    const request = new Request("https://secondlook.example/v1/second-look", {
      method: "POST",
      headers: { "content-type": "application/json", "x-secondlook-model": WORKERS_AI_MODEL, authorization: "Bearer test-secret" },
      body: JSON.stringify({ proposed_action: "Proceed" }),
    });

    const response = await worker.fetch(request, env);
    const payload = await response.json<{ error: string; detail: string }>();

    expect(response.status).toBe(400);
    expect(payload).toMatchObject({
      error: "invalid_request",
      detail: "invalid_secondlook_request",
    });
  });

  it("rejects unsupported media types and oversized bodies before inference", async () => {
    const aiRun = vi.fn();
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: aiRun });
    const env = { AI: ai, DB: operationalDb(), SECONDLOOK_ACCESS_KEY: "test-secret" } satisfies AppEnv;
    const unsupported = await worker.fetch(new Request("https://secondlook.example/v1/second-look", {
      method: "POST",
      headers: { authorization: "Bearer test-secret", "content-type": "text/plain" },
      body: "{}",
    }), env);
    const oversized = await worker.fetch(new Request("https://secondlook.example/v1/second-look", {
      method: "POST",
      headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
      body: JSON.stringify({ goal: "g", proposed_action: "x".repeat(66_000) }),
    }), env);

    expect(unsupported.status).toBe(415);
    expect(await unsupported.json()).toMatchObject({ error: "unsupported_media_type", code: "unsupported_media_type", retryable: false });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: "request_too_large", code: "request_too_large", retryable: false });
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("returns retry delays that reach the relevant caller limit window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T23:30:00.000Z"));
    try {
    const aiRun = vi.fn();
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: aiRun });
    const response = await worker.fetch(medicationCaseRequest(), {
      AI: ai,
      DB: operationalDb({ rateChanges: 0 }),
      SECONDLOOK_ACCESS_KEY: "test-secret",
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("10");
    expect(await response.json()).toMatchObject({ error: "capacity_limited", code: "rate_limit_reached", retryable: true });
    const daily = await worker.fetch(medicationCaseRequest(), {
      AI: ai,
      DB: operationalDb({ rateChanges: 0, dayCount: 500 }),
      SECONDLOOK_ACCESS_KEY: "test-secret",
    });
    expect(daily.status).toBe(429);
    expect(daily.headers.get("retry-after")).toBe("1800");
    expect(await daily.json()).toMatchObject({ code: "daily_request_limit_reached", retryable: true });
    const minute = await worker.fetch(medicationCaseRequest(), {
      AI: ai,
      DB: operationalDb({ rateChanges: 0, minuteCount: 30 }),
      SECONDLOOK_ACCESS_KEY: "test-secret",
    });
    expect(minute.status).toBe(429);
    expect(minute.headers.get("retry-after")).toBe("60");
    expect(await minute.json()).toMatchObject({ code: "rate_limit_reached", retryable: true });
    expect(aiRun).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed with consistent categories and safe capacity delays", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T23:30:00.000Z"));
    try {
    const aiRun = vi.fn();
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: aiRun });
    const disabled = await worker.fetch(medicationCaseRequest(), {
      AI: ai, DB: operationalDb({ inferenceEnabled: 0 }), SECONDLOOK_ACCESS_KEY: "test-secret",
    });
    const full = await worker.fetch(medicationCaseRequest(), {
      AI: ai, DB: operationalDb({ leaseChanges: 0 }), SECONDLOOK_ACCESS_KEY: "test-secret",
    });
    const dailyCap = await worker.fetch(medicationCaseRequest(), {
      AI: ai, DB: operationalDb({ globalChanges: 0 }), SECONDLOOK_ACCESS_KEY: "test-secret",
    });
    const circuit = await worker.fetch(medicationCaseRequest(), {
      AI: ai, DB: operationalDb({ circuitOpenUntil: Math.floor(Date.now() / 1000) + 60 }), SECONDLOOK_ACCESS_KEY: "test-secret",
    });
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toMatchObject({ code: "service_disabled", category: "service", retryable: true });
    expect(full.status).toBe(429);
    expect(await full.json()).toMatchObject({ code: "inference_capacity_reached", retryable: true });
    expect(dailyCap.status).toBe(503);
    expect(dailyCap.headers.get("retry-after")).toBe("1800");
    expect(await dailyCap.json()).toMatchObject({ code: "daily_inference_limit_reached", category: "capacity", retryable: true });
    expect(circuit.status).toBe(503);
    expect(await circuit.json()).toMatchObject({ code: "service_disabled", category: "service", retryable: true });
    expect(aiRun).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts paid admission leases and daily reservations in internal/pilot capacity", async () => {
    const db = operationalDb();
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: vi.fn(async () => ({ response: gateResponse("no_material_concern_found", "No concern found.") })) });
    const response = await worker.fetch(medicationCaseRequest(), {
      AI: ai,
      DB: db,
      SECONDLOOK_ACCESS_KEY: "test-secret",
    });
    expect(response.status).toBe(200);
    const sql = vi.mocked(db.prepare).mock.calls.map(([statement]) => statement as string);
    const concurrency = sql.find((statement) => statement.includes("INSERT OR IGNORE INTO api_inference_leases"));
    const daily = sql.find((statement) => statement.includes("INSERT INTO api_global_usage"));
    expect(concurrency).toContain("paid_execution_admissions");
    expect(concurrency).toContain("lease_kind = 'settlement'");
    expect(concurrency).toContain("lease_kind = 'inference'");
    expect(daily).toContain("paid_execution_admissions");
    expect(daily).toContain("state IN ('settling', 'accepted', 'ambiguous', 'consumed')");
  });

  it("returns a non-retryable provider timeout without starting a second inference", async () => {
    vi.useFakeTimers();
    try {
      const aiRun = vi.fn(() => new Promise(() => undefined));
      const ai = Object.create(null) as Ai;
      Object.defineProperty(ai, "run", { value: aiRun });
      const pending = worker.fetch(medicationCaseRequest(), { AI: ai, DB: operationalDb(), SECONDLOOK_ACCESS_KEY: "test-secret" });
      await vi.waitUntil(() => aiRun.mock.calls.length === 1, { timeout: 1_000 });
      expect(aiRun).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(30_000);
      const response = await pending;
      expect(response.status).toBe(504);
      expect(response.headers.get("retry-after")).toBeNull();
      expect(await response.json()).toMatchObject({ error: "provider_failure", code: "provider_timeout", retryable: false });
    } finally {
      vi.useRealTimers();
    }
  });
});
