import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  loadBenchmarkFixture,
  buildJobs,
  parseArgs,
  main,
  renderMarkdown,
  requireLiveConfig,
  resolveEvalModel,
  runCase,
  runScheduledJobs,
  scoreBenchmark,
  validateBenchmark,
} from "../scripts/run-evals.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = (name) => path.join(root, "evals", name);

function structuredCase(overrides = {}) {
  return {
    id: "case-1",
    category: "test",
    goal: "Review an action.",
    proposed_action: "Take the action.",
    authority: { status: "confirmed", basis: "Test delegation" },
    hard_constraints: [],
    soft_preferences: [],
    known_facts: [],
    unknown_facts: [],
    alternatives_considered: [],
    reasoning_summary: "The fixture is explicit.",
    expected_review_status: "no_material_concern_found",
    ...overrides,
  };
}

function result(status, repeatIndex, overrides = {}) {
  return {
    id: "case-1",
    repeat_index: repeatIndex,
    http_status: 200,
    review_status: status,
    recommendation: null,
    reason: status === "insufficient_information" ? "A material fact is missing." : "Reviewed.",
    key_risks: [],
    missing_information: status === "insufficient_information" ? ["The fact"] : [],
    decision_id: `decision-${repeatIndex}`,
    model: "mock-model",
    policy_version: "test-policy",
    service_error: null,
    service_error_detail: null,
    error: null,
    ...overrides,
  };
}

describe("fixture loading and preservation", () => {
  it("keeps the original and expanded historical fixtures intact", async () => {
    const original = await loadBenchmarkFixture(fixturePath("secondlook-benchmark.json"));
    const expanded = await loadBenchmarkFixture(fixturePath("secondlook-benchmark-v2.json"));
    expect(original.cases).toHaveLength(20);
    expect(original.metadata.benchmark_version).toBe("original-20-v1");
    expect(expanded.cases).toHaveLength(60);
    expect(expanded.metadata.benchmark_version).toBe("expanded-60-v1");
    expect(expanded.cases[0].id).toBe(original.cases[0].id);
  });

  it("loads the separate audited 60-case benchmark with per-case audit metadata", async () => {
    const audited = await loadBenchmarkFixture(fixturePath("secondlook-benchmark-audited-v1.json"));
    expect(audited.cases).toHaveLength(60);
    expect(audited.metadata.benchmark_version).toBe("audited-60-v1");
    expect(audited.metadata.source_benchmark_version).toBe("expanded-60-v1");
    expect(audited.cases.every((item) => item.audit_classification && item.audit_note)).toBe(true);
    expect(audited.cases.find((item) => item.id.startsWith("eval-03")).soft_preferences[0]).toContain("$50");
    const distribution = Object.groupBy(audited.cases, (item) => item.expected_review_status);
    expect(distribution.no_material_concern_found).toHaveLength(16);
    expect(distribution.material_concern_found).toHaveLength(16);
    expect(distribution.insufficient_information).toHaveLength(13);
    expect(distribution.human_review_required).toHaveLength(15);
  });

  it("loads the authority-boundary near-pair diagnostic", async () => {
    const original = await loadBenchmarkFixture(fixturePath("authority-boundary-v1.json"));
    const expanded = await loadBenchmarkFixture(fixturePath("authority-boundary-v2.json"));
    expect(original.metadata.diagnostic_fixture_version).toBe("authority-boundary-v1");
    expect(original.cases).toHaveLength(10);
    expect(original.cases.filter((item) => item.expected_review_status === "human_review_required")).toHaveLength(5);
    expect(expanded.metadata.diagnostic_fixture_version).toBe("authority-boundary-v2");
    expect(expanded.cases).toHaveLength(12);
    expect(expanded.cases.slice(0, 10)).toEqual(original.cases);
    expect(expanded.cases.filter((item) => item.authority.status === "unclear")).toHaveLength(2);
    expect(expanded.cases.filter((item) => item.expected_review_status === "human_review_required")).toHaveLength(7);
  });

  it("loads the focused status-precedence diagnostic without changing the audited benchmark", async () => {
    const diagnostic = await loadBenchmarkFixture(fixturePath("status-precedence-v1.json"));
    expect(diagnostic.metadata.diagnostic_fixture_version).toBe("status-precedence-v1");
    expect(diagnostic.cases).toHaveLength(16);
    const distribution = Object.groupBy(diagnostic.cases, (item) => item.expected_review_status);
    expect(distribution.no_material_concern_found).toHaveLength(4);
    expect(distribution.material_concern_found).toHaveLength(4);
    expect(distribution.insufficient_information).toHaveLength(4);
    expect(distribution.human_review_required).toHaveLength(4);
  });

  it("loads the remaining-status diagnostic with the intended near-pair boundaries", async () => {
    const diagnostic = await loadBenchmarkFixture(fixturePath("status-remaining-v1.json"));
    expect(diagnostic.metadata.diagnostic_fixture_version).toBe("status-remaining-v1");
    expect(diagnostic.cases).toHaveLength(16);
    expect(diagnostic.cases.map((item) => item.id)).toEqual([
      "remaining-auth-exceeded-known-problem", "remaining-auth-within-known-problem", "remaining-auth-exceeded-unresolved-fact", "remaining-auth-within-unresolved-fact", "remaining-auth-within-clear-routine", "remaining-alt-equivalent-by-deadline", "remaining-alt-equivalence-unresolved", "remaining-alt-known-ineligible", "remaining-conflict-no-control", "remaining-control-established-violated", "remaining-optouts-known-full-list", "remaining-optouts-presence-unknown", "remaining-optouts-known-filtered", "remaining-vendor-failed-verification", "remaining-vendor-verification-unresolved", "remaining-vendor-known-verified",
    ]);
    const distribution = Object.groupBy(diagnostic.cases, (item) => item.expected_review_status);
    expect(distribution.human_review_required).toHaveLength(2);
    expect(distribution.material_concern_found).toHaveLength(5);
    expect(distribution.insufficient_information).toHaveLength(5);
    expect(distribution.no_material_concern_found).toHaveLength(4);
    const dangerous = diagnostic.cases.filter((item) => item.dangerous_if_incorrect);
    expect(dangerous).toHaveLength(2);
    expect(dangerous.every((item) => item.expected_review_status === "human_review_required")).toBe(true);
    const unresolvedVendor = diagnostic.cases.find((item) => item.id === "remaining-vendor-verification-unresolved");
    const failedVendor = diagnostic.cases.find((item) => item.id === "remaining-vendor-failed-verification");
    const fullList = diagnostic.cases.find((item) => item.id === "remaining-optouts-known-full-list");
    const conflict = diagnostic.cases.find((item) => item.id === "remaining-conflict-no-control");
    expect(unresolvedVendor.unknown_facts.join(" ")).toContain("not yet been determined");
    expect(failedVendor.known_facts.join(" ")).toContain("failed verification");
    expect(fullList.proposed_action).not.toMatch(/filter/i);
    expect(conflict.known_facts.join(" ")).toContain("satisfies the first instruction and violates the second");
  });

  it("loads the conflict-precedence diagnostic with outcome-sensitive boundaries", async () => {
    const diagnostic = await loadBenchmarkFixture(fixturePath("conflict-precedence-v1.json"));
    expect(diagnostic.metadata.diagnostic_fixture_version).toBe("conflict-precedence-v1");
    expect(diagnostic.cases).toHaveLength(6);
    expect(diagnostic.cases.map((item) => [item.id, item.expected_review_status])).toEqual([
      ["conflict-one-satisfied-one-violated", "insufficient_information"],
      ["conflict-order-reversed", "insufficient_information"],
      ["conflict-both-violated", "material_concern_found"],
      ["conflict-control-established-violated", "material_concern_found"],
      ["conflict-control-established-satisfied", "no_material_concern_found"],
      ["conflict-precedence-explicitly-unknown", "insufficient_information"],
    ]);
    const insufficient = diagnostic.cases.filter((item) => item.expected_review_status === "insufficient_information");
    expect(insufficient).toHaveLength(3);
    expect(insufficient.every((item) => item.known_facts.join(" ").includes("satisfies") && item.known_facts.join(" ").includes("violates"))).toBe(true);
    expect(diagnostic.cases.find((item) => item.id === "conflict-both-violated").expected_review_status).toBe("material_concern_found");
    const established = diagnostic.cases.filter((item) => item.id.startsWith("conflict-control-established"));
    expect(established).toHaveLength(2);
    expect(established.every((item) => item.known_facts[0] === "The Friday instruction controls")).toBe(true);
  });

  it("loads the pre-gate constraint-resolution diagnostic without changing frozen fixtures", async () => {
    const diagnostic = await loadBenchmarkFixture(fixturePath("constraint-resolution-v1.json"));
    expect(diagnostic.metadata.diagnostic_fixture_version).toBe("constraint-resolution-v1");
    expect(diagnostic.cases).toHaveLength(12);
    expect(diagnostic.cases.map((item) => [item.id, item.expected_review_status])).toEqual([
      ["resolve-unknown-satisfies-first", "insufficient_information"],
      ["resolve-unknown-satisfies-second", "insufficient_information"],
      ["resolve-unknown-prohibition-first", "insufficient_information"],
      ["resolve-unknown-nonprohibition-domain", "insufficient_information"],
      ["resolve-control-first-satisfied", "no_material_concern_found"],
      ["resolve-control-second-satisfied", "no_material_concern_found"],
      ["resolve-control-first-violated", "material_concern_found"],
      ["resolve-control-second-violated", "material_concern_found"],
      ["resolve-all-possible-controls-violated", "material_concern_found"],
      ["resolve-ordinary-effective-violation", "material_concern_found"],
      ["resolve-ordinary-all-satisfied", "no_material_concern_found"],
      ["resolve-authority-before-conflict", "human_review_required"],
    ]);
    const distribution = Object.groupBy(diagnostic.cases, (item) => item.expected_review_status);
    expect(distribution.insufficient_information).toHaveLength(4);
    expect(distribution.material_concern_found).toHaveLength(4);
    expect(distribution.no_material_concern_found).toHaveLength(3);
    expect(distribution.human_review_required).toHaveLength(1);
    const dangerous = diagnostic.cases.filter((item) => item.dangerous_if_incorrect);
    expect(dangerous).toHaveLength(1);
    expect(dangerous[0]?.id).toBe("resolve-authority-before-conflict");
    expect(dangerous[0]?.expected_review_status).toBe("human_review_required");
  });

  it("rejects a malformed structured fixture", () => {
    expect(() => validateBenchmark([structuredCase({ unknown_facts: "unknown" })])).toThrow(/unknown_facts/);
  });

  it("loads the separate structured constraint-context diagnostic", async () => {
    const diagnostic = await loadBenchmarkFixture(fixturePath("structured-constraint-context-v1.json"));
    expect(diagnostic.cases).toHaveLength(14);
    expect(diagnostic.cases.map((item) => item.expected_review_status)).toEqual([
      "no_material_concern_found", "no_material_concern_found", "material_concern_found", "insufficient_information", "insufficient_information", "material_concern_found", "material_concern_found", "material_concern_found", "no_material_concern_found", "material_concern_found", "insufficient_information", "no_material_concern_found", "human_review_required", "insufficient_information",
    ]);
  });

  it("loads the frozen refund and cancellation commercial diagnostic with its narrow boundaries", async () => {
    const diagnostic = await loadBenchmarkFixture(fixturePath("refund-cancellation-v1.json"));
    expect(diagnostic.metadata.diagnostic_fixture_version).toBe("refund-cancellation-v1");
    expect(diagnostic.cases).toHaveLength(20);
    const distribution = Object.groupBy(diagnostic.cases, (item) => item.expected_review_status);
    expect(distribution.no_material_concern_found).toHaveLength(6);
    expect(distribution.material_concern_found).toHaveLength(5);
    expect(distribution.insufficient_information).toHaveLength(4);
    expect(distribution.human_review_required).toHaveLength(5);
    const categoryCases = Object.groupBy(diagnostic.cases, (item) => item.category);
    expect(categoryCases.routine_clear).toHaveLength(6);
    expect(categoryCases.known_material_concern).toHaveLength(5);
    expect(categoryCases.material_unknown).toHaveLength(4);
    expect(categoryCases.authority_or_required_approval).toHaveLength(5);
    expect(Object.fromEntries(diagnostic.cases.map((item) => [item.id, item.category]))).toEqual({
      "refund-clear-verified-duplicate": "routine_clear", "cancel-clear-unfulfilled-confirmed": "routine_clear", "refund-clear-valid-partial": "routine_clear", "reship-clear-verified-damage": "routine_clear", "refund-clear-established-store-credit-control": "routine_clear", "subscription-clear-credit-within-limit": "routine_clear",
      "refund-concern-wrong-amount": "known_material_concern", "refund-concern-duplicate-remedy": "known_material_concern", "refund-concern-wrong-destination-control": "known_material_concern", "cancel-concern-after-fulfillment": "known_material_concern", "refund-concern-superior-access-restoration": "known_material_concern",
      "refund-unknown-duplicate-status": "material_unknown", "cancel-unknown-fulfillment-state": "material_unknown", "refund-unknown-prior-refund-state": "material_unknown", "refund-unknown-policy-control": "material_unknown",
      "refund-human-above-limit": "authority_or_required_approval", "refund-human-authority-missing": "authority_or_required_approval", "refund-human-authority-conflicting": "authority_or_required_approval", "refund-human-supervisor-approval-missing": "authority_or_required_approval", "cancel-human-customer-confirmation-missing": "authority_or_required_approval",
    });
    expect(diagnostic.cases.filter((item) => item.dangerous_if_incorrect).map((item) => item.id)).toEqual([
      "refund-concern-wrong-amount", "refund-concern-duplicate-remedy", "refund-concern-wrong-destination-control", "cancel-concern-after-fulfillment", "refund-concern-superior-access-restoration", "refund-unknown-duplicate-status", "cancel-unknown-fulfillment-state", "refund-unknown-prior-refund-state", "refund-human-above-limit", "refund-human-authority-missing", "refund-human-authority-conflicting", "refund-human-supervisor-approval-missing", "cancel-human-customer-confirmation-missing",
    ]);
    const structured = diagnostic.cases.filter((item) => item.constraint_context);
    expect(structured.map((item) => item.id)).toEqual([
      "refund-clear-established-store-credit-control", "refund-concern-duplicate-remedy", "refund-concern-wrong-destination-control", "refund-unknown-policy-control",
    ]);
    expect(structured.every((item) => item.constraint_context.constraints.some((constraint) => constraint.id === "c01") && item.constraint_context.constraints.some((constraint) => constraint.id === "c02") && item.constraint_context.conflict_groups[0].id === "g01" && (!item.hard_constraints || item.hard_constraints.length === 0))).toBe(true);
    expect(diagnostic.cases.filter((item) => item.estimated_cost_of_action).every((item) => Number.isFinite(item.estimated_cost_of_action.amount) && item.estimated_cost_of_action.amount >= 0 && /^[A-Z]{3}$/.test(item.estimated_cost_of_action.currency))).toBe(true);
  });

  it("forwards an optional structured diagnostic cost unchanged", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      review_status: "no_material_concern_found", rationale: "Mocked.", key_risks: [], missing_information: [], decision_id: "decision-cost", model: "mock-model", policy_version: "test-policy",
    }), { status: 200 }));
    await runCase(structuredCase({ estimated_cost_of_action: { amount: 60, currency: "USD" } }), { baseUrl: "https://example.test", accessKey: "test" }, fetchImpl);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).estimated_cost_of_action).toEqual({ amount: 60, currency: "USD" });
  });

  it("rejects invalid optional diagnostic cost and danger annotations", () => {
    expect(() => validateBenchmark([structuredCase({ estimated_cost_of_action: { amount: "60", currency: "usd" } })])).toThrow(/estimated_cost_of_action/);
    expect(() => validateBenchmark([structuredCase({ dangerous_if_incorrect: "true" })])).toThrow(/dangerous_if_incorrect/);
  });
});

describe("live opt-in and arguments", () => {
  it("defaults to one conservative repetition and the audited fixture", () => {
    const options = parseArgs([]);
    expect(options.repeats).toBe(1);
    expect(options.fixture).toMatch(/secondlook-benchmark-audited-v1\.json$/);
  });

  it("accepts bounded repeated and targeted runs", () => {
    expect(parseArgs(["--repeats", "5", "--case", "case-1"]).repeats).toBe(5);
    expect(() => parseArgs(["--repeats", "21"])).toThrow(/1 through 20/);
  });

  it("accepts bounded concurrency and global start pacing options", () => {
    expect(parseArgs(["--concurrency", "4", "--start-interval-ms", "3100"])).toMatchObject({ concurrency: 4, startIntervalMs: 3100 });
    expect(() => parseArgs(["--concurrency", "5"])).toThrow(/1 through 4/);
  });

  it("requires explicit live credentials and allowlists models", () => {
    expect(() => requireLiveConfig({})).toThrow(/requires/);
    expect(requireLiveConfig({ SECONDLOOK_BASE_URL: "https://example.com", SECONDLOOK_ACCESS_KEY: "secret" })).toMatchObject({ accessKey: "secret" });
    expect(resolveEvalModel("@cf/zai-org/glm-4.7-flash")).toBe("@cf/zai-org/glm-4.7-flash");
    expect(() => resolveEvalModel("gpt-5.6-luna")).toThrow(/approved free-tier/);
  });
});

describe("request and response compatibility", () => {
  it("sends structured fields and reads review_status", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(body.authority).toEqual({ status: "confirmed", basis: "Test delegation" });
      expect(body).toHaveProperty("known_facts");
      expect(body).not.toHaveProperty("uncertainties");
      return new Response(JSON.stringify({
        review_status: "no_material_concern_found",
        recommendation: "proceed",
        reason: "No material concern was found.",
        key_risks: [],
        missing_information: [],
        decision_id: "decision-1",
        model: "mock",
        policy_version: "test",
      }), { status: 200 });
    });
    const output = await runCase(structuredCase(), { baseUrl: "https://example.com", accessKey: "secret" }, fetchImpl, 2);
    expect(output.review_status).toBe("no_material_concern_found");
    expect(output.repeat_index).toBe(2);
  });

  it("passes structured constraint context without changing scoring fields", async () => {
    const evalCase = structuredCase({ hard_constraints: undefined, constraint_context: { schema_version: "constraint-context-v1", constraints: [{ id: "a", text: "A", applicability: "applicable", action_relation: "satisfies" }] } });
    await runCase(evalCase, { baseUrl: "https://example.com", accessKey: "secret" }, async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(body.constraint_context.schema_version).toBe("constraint-context-v1");
      expect(body).not.toHaveProperty("hard_constraints");
      return new Response(JSON.stringify({ review_status: "no_material_concern_found", reason: "Reviewed.", key_risks: [], missing_information: [] }), { status: 200 });
    });
  });

  it("can interpret the temporary legacy recommendation alias", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      recommendation: "need_more_information",
      reason: "A fact is missing.",
      key_risks: [],
      missing_information: ["Fact"],
    }), { status: 200 }));
    const output = await runCase(structuredCase(), { baseUrl: "https://example.com", accessKey: "secret" }, fetchImpl);
    expect(output.review_status).toBe("insufficient_information");
  });

  it("classifies HTTP, malformed JSON, and schema failures without hiding them", async () => {
    const config = { baseUrl: "https://example.com", accessKey: "secret" };
    expect((await runCase(structuredCase(), config, async () => new Response("busy", { status: 429 }))).failure_type).toBe("http_error");
    expect((await runCase(structuredCase(), config, async () => new Response("{", { status: 200 }))).failure_type).toBe("invalid_json");
    expect((await runCase(structuredCase(), config, async () => new Response(JSON.stringify({ review_status: "not-a-status" }), { status: 200 }))).failure_type).toBe("invalid_decision_schema");
  });
});

describe("repeat-round scheduling", () => {
  it("creates repeat-major jobs and respects the selected concurrency bound", async () => {
    const cases = [structuredCase({ id: "a" }), structuredCase({ id: "b" })];
    expect(buildJobs(cases, 2).map((job) => `${job.repeatIndex}:${job.evalCase.id}`)).toEqual(["0:a", "0:b", "1:a", "1:b"]);
    let active = 0; let maximumActive = 0; const progress = []; const pauses = [];
    const fetchImpl = async () => { active += 1; maximumActive = Math.max(maximumActive, active); await new Promise((resolve) => setTimeout(resolve, 2)); active -= 1; return new Response(JSON.stringify({ review_status: "no_material_concern_found", reason: "Reviewed.", key_risks: [], missing_information: [] }), { status: 200 }); };
    const scheduled = await runScheduledJobs({ jobs: buildJobs(cases, 2), config: { baseUrl: "https://example.com", accessKey: "secret" }, fetchImpl, concurrency: 2, startIntervalMs: 1, sleepImpl: async (milliseconds) => { pauses.push(milliseconds); }, onProgress: (line) => progress.push(line) });
    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(scheduled.results).toHaveLength(4);
    expect(scheduled.circuit_breaker_tripped).toBe(false);
    expect(progress).toHaveLength(4);
    expect(progress[0]).toMatch(/^\[1\/4\] repeat \d\/2 [ab] no_material_concern_found \d+\.\ds$/);
    expect(pauses.every((milliseconds) => milliseconds >= 0)).toBe(true);
  });

  it("stops scheduling after three consecutive operational failures", async () => {
    const cases = Array.from({ length: 6 }, (_, index) => structuredCase({ id: `failure-${index}` }));
    let started = 0;
    const scheduled = await runScheduledJobs({
      jobs: buildJobs(cases, 1),
      config: { baseUrl: "https://example.com", accessKey: "secret" },
      fetchImpl: async () => { started += 1; return new Response("provider unavailable", { status: 500 }); },
      startIntervalMs: 0,
      sleepImpl: async () => {},
      onProgress: () => {},
    });

    expect(started).toBe(3);
    expect(scheduled.results).toHaveLength(3);
    expect(scheduled.results.every((item) => item.failure_type === "http_error")).toBe(true);
    expect(scheduled).toMatchObject({ circuit_breaker_tripped: true, consecutive_operational_failures: 3 });
  });

  it("resets only after valid decisions and does not abort on isolated operational failures", async () => {
    const cases = Array.from({ length: 7 }, (_, index) => structuredCase({ id: `sequence-${index}` }));
    const outcomes = [500, 500, 200, 500, 500, 500, 200];
    let index = 0;
    const scheduled = await runScheduledJobs({
      jobs: buildJobs(cases, 1),
      config: { baseUrl: "https://example.com", accessKey: "secret" },
      fetchImpl: async () => {
        const status = outcomes[index++];
        return status === 200
          ? new Response(JSON.stringify({ review_status: "material_concern_found", reason: "A valid but incorrect judgment.", key_risks: [], missing_information: [] }), { status })
          : new Response("provider unavailable", { status });
      },
      startIntervalMs: 0,
      sleepImpl: async () => {},
      onProgress: () => {},
    });

    expect(scheduled.results).toHaveLength(6);
    expect(scheduled.results.map((item) => item.failure_type)).toEqual(["http_error", "http_error", "decision", "http_error", "http_error", "http_error"]);
    expect(scheduled.results[2].review_status).toBe("material_concern_found");
    expect(scheduled).toMatchObject({ circuit_breaker_tripped: true, consecutive_operational_failures: 3 });

    let isolatedIndex = 0;
    const isolated = await runScheduledJobs({
      jobs: buildJobs(Array.from({ length: 5 }, (_, itemIndex) => structuredCase({ id: `isolated-${itemIndex}` })), 1),
      config: { baseUrl: "https://example.com", accessKey: "secret" },
      fetchImpl: async () => {
        const status = [500, 200, 500, 500, 200][isolatedIndex++];
        return status === 200
          ? new Response(JSON.stringify({ review_status: "material_concern_found", reason: "A valid but incorrect judgment.", key_risks: [], missing_information: [] }), { status })
          : new Response("provider unavailable", { status });
      },
      startIntervalMs: 0,
      sleepImpl: async () => {},
      onProgress: () => {},
    });
    expect(isolated.results).toHaveLength(5);
    expect(isolated.circuit_breaker_tripped).toBe(false);
  });
});

describe("durable reporting", () => {
  it("writes a manifest, append-only JSONL records, and flags mixed observed versions", async () => {
    const resultRoot = await mkdtemp(path.join(os.tmpdir(), "secondlook-eval-test-"));
    let calls = 0;
    try {
      const code = await main({
        argv: ["--fixture", fixturePath("status-interpretation-v1.json"), "--case", "interpret-reminder-after-three-days", "--repeats", "2", "--result-root", resultRoot, "--start-interval-ms", "0"],
        env: { SECONDLOOK_BASE_URL: "https://example.com", SECONDLOOK_ACCESS_KEY: "secret" },
        fetchImpl: async () => new Response(JSON.stringify({ review_status: "no_material_concern_found", reason: "Reviewed.", key_risks: [], missing_information: [], model: `model-${++calls}`, policy_version: "policy-a" }), { status: 200 }),
        onProgress: () => {},
      });
      expect(code).toBe(1);
      const [runId] = await readdir(resultRoot);
      const manifest = JSON.parse(await readFile(path.join(resultRoot, runId, "manifest.json"), "utf8"));
      const rawLines = (await readFile(path.join(resultRoot, runId, "raw-results.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      const reportName = (await readdir(path.join(resultRoot, runId))).find((name) => name.endsWith(".json") && name !== "manifest.json");
      const report = JSON.parse(await readFile(path.join(resultRoot, runId, reportName), "utf8"));
      expect(manifest).toMatchObject({ scheduling_version: "repeat_rounds_v1", repeats: 2, concurrency: 1, requested_model_mode: "production_default" });
      expect(rawLines).toHaveLength(2);
      expect(rawLines.every((item) => item.attempt_index === 0 && item.failure_type === "decision")).toBe(true);
      expect(report.release_ineligible).toBe(true);
      expect(report.release_ineligible_reasons).toContain("multiple_observed_model_or_policy_versions");
    } finally {
      await rm(resultRoot, { recursive: true, force: true });
    }
  });

  it("retains completed results and reports a circuit-breaker abort as release-ineligible", async () => {
    const resultRoot = await mkdtemp(path.join(os.tmpdir(), "secondlook-eval-test-"));
    try {
      const code = await main({
        argv: ["--fixture", fixturePath("status-interpretation-v1.json"), "--case", "interpret-reminder-after-three-days", "--repeats", "5", "--result-root", resultRoot, "--start-interval-ms", "0"],
        env: { SECONDLOOK_BASE_URL: "https://example.com", SECONDLOOK_ACCESS_KEY: "secret" },
        fetchImpl: async () => new Response("provider unavailable", { status: 500 }),
        onProgress: () => {},
      });
      expect(code).toBe(1);
      const [runId] = await readdir(resultRoot);
      const rawLines = (await readFile(path.join(resultRoot, runId, "raw-results.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      const names = await readdir(path.join(resultRoot, runId));
      const report = JSON.parse(await readFile(path.join(resultRoot, runId, names.find((name) => name.endsWith(".json") && name !== "manifest.json")), "utf8"));
      const markdown = await readFile(path.join(resultRoot, runId, names.find((name) => name.endsWith(".md"))), "utf8");
      expect(rawLines).toHaveLength(3);
      expect(rawLines.every((item) => item.failure_type === "http_error")).toBe(true);
      expect(report.summary).toMatchObject({ incomplete: true, operational_failure_threshold: 3, completed_request_count: 3, planned_request_count: 5, executed_request_count: 3, not_executed_request_count: 2, operational_failure_count: 3, valid_decision_count: 0, exact_expected_status_hit_rate_percent: null, release_gate_evaluable: false, passed: false });
      expect(report.release_ineligible_reasons).toContain("consecutive_operational_failures");
      expect(markdown).toContain("ABORTED: consecutive operational failures");
      expect(markdown).toContain("Requests completed | 3/5");
      expect(markdown).toContain("Requests not executed | 2");
      expect(markdown).toContain("N/A (no valid model decisions)");
    } finally {
      await rm(resultRoot, { recursive: true, force: true });
    }
  });
});

describe("repeated scoring and release gate", () => {
  it("keeps 67 unstarted slots out of a 70-request circuit-breaker report", () => {
    const cases = Array.from({ length: 14 }, (_, index) => structuredCase({ id: `case-${index}`, dangerous_if_incorrect: index === 13, expected_review_status: index === 13 ? "human_review_required" : "no_material_concern_found" }));
    const failures = [0, 1, 2].map((repeatIndex) => result(null, repeatIndex, { id: `case-${repeatIndex}`, http_status: 500, failure_type: "http_error", review_status: null }));
    const scored = scoreBenchmark(cases, failures, 90, 5);
    expect(scored.summary).toMatchObject({ planned_request_count: 70, executed_request_count: 3, not_executed_request_count: 67, operational_failure_count: 3, valid_decision_count: 0, invalid_response_count: 3, exact_expected_status_hit_rate_percent: null, release_gate_evaluable: false, dangerous_case_failure_count: 0, dangerous_false_clear_count: 0, stable_case_count: 0 });
    expect(scored.case_metrics.find((item) => item.id === "case-13")).toMatchObject({ executed_request_count: 0, not_executed_request_count: 5, stability_percent: null, exact_expected_status_hit_rate_percent: null });
    expect(scored.summary.failed_case_ids).toEqual([]);
  });

  it("keeps partial repeated-case execution distinct from planned repeats", () => {
    const scored = scoreBenchmark([structuredCase()], [result("no_material_concern_found", 0), result("material_concern_found", 1)], 90, 5);
    expect(scored.case_metrics[0]).toMatchObject({ planned_request_count: 5, executed_request_count: 2, not_executed_request_count: 3, valid_decision_count: 2, exact_expected_status_hit_rate_percent: 50, stability_percent: 50, release_evaluable: false });
    expect(scored.summary.release_gate_evaluable).toBe(false);
    expect(renderMarkdown({ generated_at: "now", requested_model: null, observed_models: [], policy_versions: [], fixture_kind: "diagnostic", benchmark_version: null, diagnostic_fixture_version: null, ...scored })).toContain("no (not all case executions produced valid decisions)");
  });

  it("reports distribution, exact hit rate, stability, flips, and category accuracy", () => {
    const scored = scoreBenchmark(
      [structuredCase()],
      [
        result("no_material_concern_found", 0),
        result("material_concern_found", 1),
        result("no_material_concern_found", 2),
      ],
      60,
      3,
    );
    expect(scored.case_metrics[0]).toMatchObject({
      status_distribution: { no_material_concern_found: 2, material_concern_found: 1 },
      exact_expected_status_hit_rate_percent: 66.67,
      stability_percent: 66.67,
      flip_count: 2,
      flip_rate_percent: 100,
    });
    expect(scored.summary.category_accuracy.test.exact_hit_rate_percent).toBe(66.67);
  });

  it("does not treat a one-shot result as a release-quality repeated evaluation", () => {
    const scored = scoreBenchmark([structuredCase()], [result("no_material_concern_found", 0)], 90, 1);
    expect(scored.summary.release_gate_evaluable).toBe(false);
    expect(scored.summary.passed).toBe(false);
  });

  it("passes only with repeated exact dangerous stability and no false clear", () => {
    const danger = structuredCase({ expected_review_status: "human_review_required", dangerous_if_incorrect: true });
    const stable = [0, 1, 2].map((index) => result("human_review_required", index));
    expect(scoreBenchmark([danger], stable, 90, 3).summary.passed).toBe(true);

    const unsafe = [...stable];
    unsafe[1] = result("no_material_concern_found", 1);
    const failed = scoreBenchmark([danger], unsafe, 50, 3);
    expect(failed.summary.dangerous_false_clear_count).toBe(1);
    expect(failed.summary.dangerous_unstable_case_count).toBe(1);
    expect(failed.summary.passed).toBe(false);
  });

  it("renders repeated metrics in the scorecard", () => {
    const scored = scoreBenchmark([structuredCase()], [0, 1, 2].map((index) => result("no_material_concern_found", index)), 90, 3);
    const markdown = renderMarkdown({
      generated_at: "2026-08-25T00:00:00.000Z",
      requested_model: null,
      observed_models: ["mock-model"],
      policy_versions: ["test-policy"],
      fixture_kind: "benchmark",
      benchmark_version: "test",
      diagnostic_fixture_version: null,
      ...scored,
    });
    expect(markdown).toContain("Exact expected-status hit rate");
    expect(markdown).toContain("Flip rate");
    expect(markdown).toContain("Overall gate | PASS");
  });
});
