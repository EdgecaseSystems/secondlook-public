import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSecondLook,
  parseWorkersAiModel,
  selectReviewStatus,
  POLICY_VERSION,
  WORKERS_AI_MODEL,
  WORKERS_AI_MODELS,
} from "../src/judgment";
import type { AppEnv, ConstraintContextV1 } from "../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
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

function structuredContext(constraints: ConstraintContextV1["constraints"], conflict_groups?: ConstraintContextV1["conflict_groups"]): ConstraintContextV1 {
  return { schema_version: "constraint-context-v1", constraints, conflict_groups };
}

describe("getSecondLook", () => {
  it("uses Gemma by default while retaining the two approved evaluation overrides", () => {
    expect(parseWorkersAiModel(null)).toBe("@cf/google/gemma-4-26b-a4b-it");
    expect(parseWorkersAiModel("@cf/zai-org/glm-4.7-flash")).toBe("@cf/zai-org/glm-4.7-flash");
    expect(parseWorkersAiModel("@cf/nvidia/nemotron-3-120b-a12b")).toBe("@cf/nvidia/nemotron-3-120b-a12b");
    expect(WORKERS_AI_MODELS).toEqual([
      "@cf/google/gemma-4-26b-a4b-it",
      "@cf/zai-org/glm-4.7-flash",
      "@cf/nvidia/nemotron-3-120b-a12b",
    ]);
    expect(new Set(WORKERS_AI_MODELS).size).toBe(3);
    expect(POLICY_VERSION).toBe("2026-08-27.5");
  });

  it.each([
    [{ authority_or_required_human_review: "authority", known_material_concern: "material" }, "human_review_required", "authority"],
    [{ known_material_concern: "material", material_unknown: "unknown" }, "material_concern_found", "material"],
    [{ material_unknown: "unknown", inherent_human_accountability: "human" }, "insufficient_information", "unknown"],
    [{ inherent_human_accountability: "human" }, "human_review_required", "human"],
    [{ authority_or_required_human_review: "authority", known_material_concern: "material", material_unknown: "unknown", inherent_human_accountability: "human" }, "human_review_required", "authority"],
  ])("selects deterministic gate precedence", (triggered, status, reason) => {
    const assessment = gateResponse("no_material_concern_found", "clear");
    for (const [gate, gateReason] of Object.entries(triggered)) assessment.gates[gate as keyof typeof assessment.gates] = { triggered: true, reason: gateReason };
    assessment.clear_reason = null;
    expect(selectReviewStatus(assessment as never).review_status).toBe(status);
    expect(selectReviewStatus(assessment as never).reason).toBe(reason);
  });
  it("uses Workers AI by default and redacts data before the binding call", async () => {
    const aiRun = vi.fn(async (
      _model: string,
      input: {
        messages: Array<{ content: string }>;
        chat_template_kwargs?: { enable_thinking?: boolean };
      },
      options: { gateway?: { id?: string; skipCache?: boolean; collectLog?: boolean } },
    ) => {
      const prompt = input.messages[1]?.content ?? "";
      expect(prompt).not.toContain("person@example.com");
      expect(prompt).not.toContain("Bearer abcdefghijklmnopqrstuvwxyz123456");
      expect(prompt).toContain("[REDACTED_EMAIL]");
      expect(prompt).toContain("[REDACTED_TOKEN]");
      expect(prompt).toContain('"hard_constraints"');
      expect(prompt).toContain('"known_facts"');
      expect(prompt).toContain('"legacy_fields"');
      expect(input.messages[0]?.content).toContain("Respond with one valid JSON object only");
      expect(input.messages[0]?.content).toContain("SecondLook never creates, grants, infers, or fills in missing authority");
      expect(input.messages[0]?.content).toContain(
        "Hard constraints determine eligibility; soft preferences optimize among eligible options",
      );
      expect(input.messages[0]?.content).toContain("Return a private semantic gate assessment, not a public review status");
      expect(input.messages[0]?.content).toContain("Application code owns final status selection and precedence");
      expect(input.messages[0]?.content).toContain("Assess these four independent semantic gates");
      expect(input.messages[0]?.content).toContain("one possible controlling instruction is not a known effective violation");
      expect(input.messages[0]?.content).toContain(
        "Do not invent expiration of authorization merely because more than the minimum waiting period has elapsed.",
      );
      const instructions = input.messages[0]?.content ?? "";
      expect(instructions).toContain("controls, governs, takes precedence, is controlling");
      expect(instructions).toContain("unless supplied information says one remains independently binding");
      expect(instructions).toContain("unrelated independently applicable constraints remain effective");
      expect(instructions).toContain("Application code owns final status selection and precedence");
      expect(instructions).toContain("Do not double-classify the same epistemically unresolved issue");
      expect(instructions).toContain("material_unknown is true");
      expect(input.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(input).not.toHaveProperty("response_format");
      expect(options).toEqual({
        gateway: { id: "secondlook", skipCache: true, collectLog: false },
      });

      return {
        response: JSON.stringify(gateResponse("no_material_concern_found", "No material problem is apparent from the supplied facts.")),
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
      };
    });
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: aiRun });

    const env = {
      AI: ai,
      DB: {} as D1Database,
    } satisfies AppEnv;

    const result = await getSecondLook(
      {
        goal: "Email person@example.com before purchasing",
        proposed_action: "Send Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
        authority: { status: "confirmed", basis: "Owner approval from person@example.com", limits: ["Up to $100"] },
        hard_constraints: ["Do not exceed $100"],
        known_facts: ["The token is Bearer abcdefghijklmnopqrstuvwxyz123456"],
      },
      env,
    );

    expect(result.decision.review_status).toBe("no_material_concern_found");
    expect(result.model).toBe(WORKERS_AI_MODEL);
    expect(POLICY_VERSION).toBe("2026-08-27.5");
    expect(result.policy_version).toBe(POLICY_VERSION);
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 30 });
    expect(aiRun).toHaveBeenCalledOnce();
    expect(aiRun).toHaveBeenCalledWith(
      WORKERS_AI_MODEL,
      expect.any(Object),
      { gateway: { id: "secondlook", skipCache: true, collectLog: false } },
    );
  });

  it("accepts an already-parsed Workers AI response", async () => {
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", {
      value: vi.fn(async () => ({
        response: gateResponse("insufficient_information", "A material fact is missing.", ["The decision could change when the fact is known."], ["The missing fact."]),
      })),
    });

    const result = await getSecondLook(
      { goal: "Review a plan", proposed_action: "Proceed with the plan" },
      { AI: ai, DB: {} as D1Database },
    );

    expect(result.decision.review_status).toBe("insufficient_information");
  });

  it("uses only the redacted structured context and its exact normalized signals in the structured prompt path", async () => {
    const aiRun = vi.fn(async (_model: string, input: { messages: Array<{ content: string }> }) => {
      const prompt = input.messages[1]?.content ?? "";
      expect(prompt).toContain('"constraint_resolution"');
      expect(prompt).toContain('"superseded_constraint_ids"');
      expect(prompt).toContain("[REDACTED_EMAIL]");
      expect(prompt).not.toContain("person@example.com");
      expect(prompt).not.toContain('"hard_constraints"');
      return { response: JSON.stringify(gateResponse("no_material_concern_found", "Reviewed.")) };
    });
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: aiRun });
    const result = await getSecondLook({
      goal: "Review", proposed_action: "Proceed", constraint_context: {
        schema_version: "constraint-context-v1",
        constraints: [
          { id: "a", text: "Email person@example.com", applicability: "applicable", action_relation: "violates" },
          { id: "b", text: "Controlling rule", applicability: "applicable", action_relation: "satisfies" },
        ],
        conflict_groups: [{ id: "ab", constraint_ids: ["a", "b"], control: { status: "established", controlling_constraint_id: "b" } }],
      },
    }, { AI: ai, DB: Object.create(null) as D1Database });
    expect(result.constraint_resolution?.superseded_constraint_ids).toEqual(["a"]);
  });

  it.each([
    ["an independently binding violated constraint", structuredContext([
      { id: "a", text: "A", applicability: "applicable", action_relation: "violates" },
      { id: "b", text: "B", applicability: "applicable", action_relation: "satisfies" },
      { id: "c", text: "C", applicability: "applicable", action_relation: "violates" },
    ], [{ id: "abc", constraint_ids: ["a", "b", "c"], independently_binding_constraint_ids: ["c"], control: { status: "established", controlling_constraint_id: "b" } }]), gateResponse("no_material_concern_found", "Model clear."), "material_concern_found", "The supplied structured constraint context establishes an effective constraint violation.", undefined],
    ["an established controlling violated constraint", structuredContext([
      { id: "a", text: "A", applicability: "applicable", action_relation: "satisfies" },
      { id: "b", text: "B", applicability: "applicable", action_relation: "violates" },
    ], [{ id: "ab", constraint_ids: ["a", "b"], control: { status: "established", controlling_constraint_id: "b" } }]), gateResponse("no_material_concern_found", "Model clear."), "material_concern_found", "The supplied structured constraint context establishes an effective constraint violation.", undefined],
    ["an invariant unresolved violation group", structuredContext([
      { id: "a", text: "A", applicability: "applicable", action_relation: "violates" },
      { id: "b", text: "B", applicability: "applicable", action_relation: "violates" },
    ], [{ id: "ab", constraint_ids: ["a", "b"], control: { status: "unresolved" } }]), gateResponse("no_material_concern_found", "Model clear."), "material_concern_found", "The supplied structured constraint context establishes an effective constraint violation.", undefined],
    ["a materially unresolved group", structuredContext([
      { id: "a", text: "A", applicability: "applicable", action_relation: "satisfies" },
      { id: "b", text: "B", applicability: "applicable", action_relation: "violates" },
    ], [{ id: "ab", constraint_ids: ["a", "b"], control: { status: "unresolved" } }]), gateResponse("no_material_concern_found", "Model clear."), "insufficient_information", "The supplied structured constraint context contains a material unresolved constraint.", ["Which supplied constraint or control relationship ultimately governs the action."]],
    ["unresolved applicability", structuredContext([
      { id: "a", text: "A", applicability: "unresolved", action_relation: "violates" },
    ]), gateResponse("no_material_concern_found", "Model clear."), "insufficient_information", "The supplied structured constraint context contains a material unresolved constraint.", ["Which supplied constraint or control relationship ultimately governs the action."]],
    ["a superseded violation alone", structuredContext([
      { id: "a", text: "A", applicability: "applicable", action_relation: "violates" },
      { id: "b", text: "B", applicability: "applicable", action_relation: "satisfies" },
    ], [{ id: "ab", constraint_ids: ["a", "b"], control: { status: "established", controlling_constraint_id: "b" } }]), gateResponse("no_material_concern_found", "Model clear."), "no_material_concern_found", "Model clear.", undefined],
    ["authority plus a structured known signal", structuredContext([
      { id: "a", text: "A", applicability: "applicable", action_relation: "violates" },
    ]), gateResponse("human_review_required", "Authority gate."), "human_review_required", "Authority gate.", undefined],
    ["structured known and unknown signals", structuredContext([
      { id: "a", text: "A", applicability: "applicable", action_relation: "violates" },
      { id: "b", text: "B", applicability: "applicable", action_relation: "satisfies" },
      { id: "c", text: "C", applicability: "applicable", action_relation: "violates" },
    ], [{ id: "bc", constraint_ids: ["b", "c"], control: { status: "unresolved" } }]), gateResponse("no_material_concern_found", "Model clear."), "material_concern_found", "The supplied structured constraint context establishes an effective constraint violation.", undefined],
  ])("merges authoritative structured signals for %s", async (_label, constraint_context, response, expected, reason, missing_information) => {
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: vi.fn(async () => ({ response })) });
    const result = await getSecondLook(
      { goal: "Review", proposed_action: "Proceed", constraint_context },
      { AI: ai, DB: {} as D1Database },
    );
    expect(result.decision).toMatchObject({ review_status: expected, reason });
    if (missing_information) expect(result.decision.missing_information).toEqual(missing_information);
  });

  it("preserves model missing information when material_unknown is already triggered", async () => {
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: vi.fn(async () => ({ response: gateResponse("insufficient_information", "Model unresolved condition.", [], ["Model supplied missing fact."]) })) });
    const result = await getSecondLook(
      { goal: "Review", proposed_action: "Proceed", constraint_context: structuredContext([{ id: "a", text: "A", applicability: "unresolved", action_relation: "violates" }]) },
      { AI: ai, DB: {} as D1Database },
    );
    expect(result.decision.missing_information).toEqual(["Model supplied missing fact."]);
  });

  it("keeps a legacy flat request model-semantic only", async () => {
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: vi.fn(async () => ({ response: gateResponse("no_material_concern_found", "Model clear.") })) });
    const result = await getSecondLook(
      { goal: "Review", proposed_action: "Proceed", hard_constraints: ["A", "B"], known_facts: ["The action violates B; control is not supplied."] },
      { AI: ai, DB: {} as D1Database },
    );
    expect(result.decision.review_status).toBe("no_material_concern_found");
  });

  it.each([
    {
      label: "refund",
      goal: "Resolve a verified duplicate charge.",
      proposed_action: "Issue a $2,500 refund to the original payment method.",
      authority: { status: "confirmed" as const, basis: "Support refund policy", limits: ["Maximum $100"] },
    },
    {
      label: "purchase",
      goal: "Replace office equipment.",
      proposed_action: "Place a nonrefundable $3,000 order.",
      authority: { status: "confirmed" as const, basis: "User purchase delegation", limits: ["Maximum $500"] },
    },
  ])("assesses exceeded-$label authority as an independent human-review gate", async ({ goal, proposed_action, authority }) => {
    const aiRun = vi.fn(async (
      _model: string,
      input: { messages: Array<{ content: string }> },
    ) => {
      expect(input.messages[0]?.content).toContain("action exceeds an explicit authority limit");
      expect(input.messages[0]?.content).toContain("Multiple gates may be true for separate conditions");
      expect(input.messages[1]?.content).toContain(JSON.stringify(authority.limits[0]));
      expect(input.messages[1]?.content).toContain(JSON.stringify(proposed_action));
      return {
        response: JSON.stringify(gateResponse("human_review_required", "The proposed action exceeds the explicitly supplied authority limit.", ["The caller lacks supplied authority for this amount."])),
      };
    });
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: aiRun });

    const result = await getSecondLook(
      { goal, proposed_action, authority, known_facts: ["No higher approval is recorded"] },
      { AI: ai, DB: Object.create(null) as D1Database },
    );

    expect(result.decision.review_status).toBe("human_review_required");
    expect(aiRun).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "missing authority",
      authority: { status: "unknown" as const, basis: "No delegation was supplied" },
      expected: "human_review_required",
    },
    {
      label: "unclear authority",
      authority: { status: "unclear" as const, basis: "The supplied limits conflict" },
      expected: "human_review_required",
    },
  ])("keeps $label in the immediate human-review gate", async ({ authority, expected }) => {
    const aiRun = vi.fn(async (_model: string, input: { messages: Array<{ content: string }> }) => {
      expect(input.messages[0]?.content).toContain("required authority is missing, unknown, or unclear");
      return {
        response: JSON.stringify(gateResponse(expected as "human_review_required", "Required authority is not clear from the supplied information.", ["Required authority is not established."])),
      };
    });
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: aiRun });

    const result = await getSecondLook(
      { goal: "Complete a routine action", proposed_action: "Take the action", authority },
      { AI: ai, DB: Object.create(null) as D1Database },
    );

    expect(result.decision.review_status).toBe(expected);
  });

  it("describes known concerns, material unknowns, and inherent accountability as independent gates", async () => {
    const aiRun = vi.fn(async (_model: string, input: { messages: Array<{ content: string }> }) => {
      const system = input.messages[0]?.content ?? "";
      expect(system.indexOf("2. known_material_concern")).toBeLessThan(system.indexOf("3. material_unknown"));
      expect(system.indexOf("3. material_unknown")).toBeLessThan(system.indexOf("4. inherent_human_accountability"));
      expect(system).toContain("known unsafe, incompatible, or incorrect action");
      expect(system).toContain("not a public review status");
      return {
        response: JSON.stringify(gateResponse("material_concern_found", "A known hard constraint is violated.", ["The action conflicts with a known constraint."])),
      };
    });
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: aiRun });

    const result = await getSecondLook(
      {
        goal: "Submit a correct tax filing.",
        proposed_action: "Claim the known-ineligible deduction.",
        authority: { status: "confirmed", basis: "Taxpayer delegation" },
        hard_constraints: ["Do not claim ineligible deductions"],
        known_facts: ["The deduction is known to be ineligible"],
      },
      { AI: ai, DB: Object.create(null) as D1Database },
    );

    expect(result.decision.review_status).toBe("material_concern_found");
  });

  it.each([
    {
      label: "a material medical uncertainty",
      input: {
        goal: "Select a safe treatment option.",
        proposed_action: "Recommend the medication.",
        authority: { status: "confirmed" as const, basis: "Clinical workflow delegation" },
        unknown_facts: ["Whether the required screening result contraindicates the medication"],
      },
      expected: "insufficient_information",
    },
    {
      label: "a routine explicitly authorized low-impact action",
      input: {
        goal: "Confirm a resolved support ticket.",
        proposed_action: "Send the approved standard confirmation message.",
        authority: { status: "confirmed" as const, basis: "Support workflow delegation" },
        known_facts: ["The ticket is resolved", "The selected template is approved"],
      },
      expected: "no_material_concern_found",
    },
  ])("keeps $label out of domain-based human escalation", async ({ input, expected }) => {
    const aiRun = vi.fn(async (_model: string, request: { messages: Array<{ content: string }> }) => ({
      response: JSON.stringify(gateResponse(expected as "insufficient_information" | "no_material_concern_found", "The applicable earlier policy gate determines the status.", [], expected === "insufficient_information" ? ["The screening result."] : [])),
    }));
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: aiRun });

    const result = await getSecondLook(input, { AI: ai, DB: Object.create(null) as D1Database });

    expect(result.decision.review_status).toBe(expected);
    expect(aiRun.mock.calls[0]?.[1].messages[0]?.content).toContain(
      "domain labels alone are not enough",
    );
  });

  it("continues to accept the model-specific chat-completions response", async () => {
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", {
      value: vi.fn(async () => ({
        id: "completion-1",
        object: "chat.completion",
        created: 1,
        model: WORKERS_AI_MODEL,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify(gateResponse("no_material_concern_found", "No material problem is apparent from the supplied facts.")),
              refusal: null,
            },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      })),
    });

    const result = await getSecondLook(
      { goal: "Review a plan", proposed_action: "Proceed with the plan" },
      { AI: ai, DB: {} as D1Database },
    );

    expect(result.decision.review_status).toBe("no_material_concern_found");
  });

  it("rejects a Workers AI response outside the review-status contract", async () => {
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", {
      value: vi.fn(async () => ({
        id: "completion-2",
        object: "chat.completion",
        created: 1,
        model: WORKERS_AI_MODEL,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                review_status: "approve",
                reason: "This label is not allowed.",
                key_risks: [],
                missing_information: [],
              }),
              refusal: null,
            },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      })),
    });

    await expect(
      getSecondLook(
        { goal: "Review a plan", proposed_action: "Proceed with the plan" },
        { AI: ai, DB: {} as D1Database },
      ),
    ).rejects.toMatchObject({ code: "invalid_gate_schema" });
  });

  it.each([
    ["material unknown with an irrelevant clear reason", { ...gateResponse("insufficient_information", "A material fact is missing.", [], ["The missing fact."]), clear_reason: "Ignored clear text." }, "insufficient_information", "A material fact is missing."],
    ["authority with an irrelevant clear reason", { ...gateResponse("human_review_required", "Authority is exceeded."), clear_reason: "Ignored clear text." }, "human_review_required", "Authority is exceeded."],
  ])("uses the triggered gate rather than clear_reason for %s", async (_label, response, status, reason) => {
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: vi.fn(async () => ({ response })) });

    const result = await getSecondLook(
      { goal: "Review a plan", proposed_action: "Proceed with the plan" },
      { AI: ai, DB: {} as D1Database },
    );

    expect(result.decision).toMatchObject({ review_status: status, reason });
  });

  it.each([
    ["top-level gate schema", { ...gateResponse("no_material_concern_found", "Clear."), schema_version: "wrong" }, "invalid_gate_schema"],
    ["gate object", { ...gateResponse("no_material_concern_found", "Clear."), gates: {} }, "invalid_gate_object"],
    ["missing clear reason", { ...gateResponse("no_material_concern_found", "Clear."), clear_reason: null }, "invalid_clear_reason_consistency"],
    ["empty clear reason", { ...gateResponse("no_material_concern_found", "Clear."), clear_reason: "" }, "invalid_clear_reason_consistency"],
    ["material-unknown consistency", { ...gateResponse("insufficient_information", "Unknown."), missing_information: [] }, "invalid_material_unknown_consistency"],
  ])("classifies invalid %s with a bounded static diagnostic code", async (_label, response, code) => {
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: vi.fn(async () => ({ response })) });

    await expect(
      getSecondLook(
        { goal: "Review a plan", proposed_action: "Proceed with the plan" },
        { AI: ai, DB: {} as D1Database },
      ),
    ).rejects.toMatchObject({ code });
  });

  it("logs only privacy-safe response shape metadata when Workers AI extraction fails", async () => {
    const privateModelText = "PRIVATE_MODEL_TEXT_MUST_NOT_BE_LOGGED";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", {
      value: vi.fn(async () => ({
        id: "private-provider-id",
        choices: [
          {
            message: {
              content: [{ type: "text", text: privateModelText }],
            },
          },
        ],
        private_dynamic_key: privateModelText,
      })),
    });

    await expect(
      getSecondLook(
        { goal: "Review a plan", proposed_action: "Proceed with the plan" },
        { AI: ai, DB: {} as D1Database },
      ),
    ).rejects.toThrow(/did not contain final output text/);

    expect(consoleError).toHaveBeenCalledWith(
      "Workers AI response extraction failed",
      expect.objectContaining({
        top_level_type: "object",
        known_top_level_fields: { id: "string", choices: "array" },
        unknown_top_level_key_count: 1,
        choices_length: 1,
        first_choice_type: "object",
        first_choice_message_type: "object",
        first_message_content_type: "array",
      }),
    );
    const serializedLogs = JSON.stringify(consoleError.mock.calls);
    expect(serializedLogs).not.toContain(privateModelText);
    expect(serializedLogs).not.toContain("private-provider-id");
    expect(serializedLogs).not.toContain("private_dynamic_key");
  });

  it("handles the exact live null-content shape without treating private reasoning as output", async () => {
    const privateReasoning = "PRIVATE_REASONING_MUST_NOT_BE_PARSED_OR_LOGGED";
    const privateProviderValue = "PRIVATE_PROVIDER_VALUE_MUST_NOT_BE_LOGGED";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", {
      value: vi.fn(async () => ({
        id: "private-completion-id",
        object: "chat.completion",
        created: 1,
        model: WORKERS_AI_MODEL,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              reasoning_content: privateReasoning,
            },
            finish_reason: "length",
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 700,
          total_tokens: 800,
          completion_tokens_details: { reasoning_tokens: 700 },
        },
        system_fingerprint: null,
        service_tier: null,
        input_sensitive: false,
        output_sensitive: false,
        base_resp: { status_msg: privateProviderValue },
      })),
    });

    await expect(
      getSecondLook(
        { goal: "Review a plan", proposed_action: "Proceed with the plan" },
        { AI: ai, DB: {} as D1Database },
      ),
    ).rejects.toThrow(/did not contain final output text/);

    expect(consoleError).toHaveBeenCalledWith("Workers AI response extraction failed", {
      top_level_type: "object",
      top_level_key_count: 11,
      known_top_level_fields: {
        choices: "array",
        usage: "object",
        id: "string",
        object: "string",
        created: "number",
        model: "string",
        system_fingerprint: "null",
        service_tier: "null",
      },
      unknown_top_level_key_count: 3,
      choices_length: 1,
      first_choice_type: "object",
      first_choice_text_type: "absent",
      first_choice_message_type: "object",
      first_message_content_type: "null",
    });
    const serializedLogs = JSON.stringify(consoleError.mock.calls);
    expect(serializedLogs).not.toContain(privateReasoning);
    expect(serializedLogs).not.toContain(privateProviderValue);
    expect(serializedLogs).not.toContain("private-completion-id");
    expect(serializedLogs).not.toContain("reasoning_content");
    expect(serializedLogs).not.toContain("base_resp");
  });

  it("keeps OpenAI available only when explicitly selected", async () => {
    const modelFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.input).not.toContain("person@example.com");
      expect(body.input).not.toContain("Bearer abcdefghijklmnopqrstuvwxyz123456");
      expect(body.input).toContain("[REDACTED_EMAIL]");
      expect(body.input).toContain("[REDACTED_TOKEN]");

      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(gateResponse("no_material_concern_found", "No material problem is apparent from the supplied facts.")),
                },
              ],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 30 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    vi.stubGlobal("fetch", modelFetch);

    const env = {
      AI: Object.create(null) as Ai,
      OPENAI_API_KEY: "test-key",
      OPENAI_MODEL: "test-model",
      DB: {} as D1Database,
      MODEL_PROVIDER: "openai",
    } satisfies AppEnv;

    const result = await getSecondLook(
      {
        goal: "Email person@example.com before purchasing",
        proposed_action: "Send Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
      },
      env,
    );

    expect(result.decision.review_status).toBe("no_material_concern_found");
    expect(result.model).toBe("test-model");
    expect(result.policy_version).toBe(POLICY_VERSION);
    expect(modelFetch).toHaveBeenCalledOnce();
  });

  it.each(WORKERS_AI_MODELS)("uses the documented bounded request adapter for %s", async (model) => {
    const aiRun = vi.fn(async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify(gateResponse("no_material_concern_found", "No gate blocks the action.")),
          },
        },
      ],
    }));
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: aiRun });

    const result = await getSecondLook(
      { goal: "Review a routine action", proposed_action: "Take the authorized action" },
      { AI: ai, DB: Object.create(null) as D1Database },
      model,
    );

    expect(result.model).toBe(model);
    expect(aiRun).toHaveBeenCalledWith(
      model,
      expect.objectContaining({
        chat_template_kwargs: { enable_thinking: false },
        max_completion_tokens: 700,
        temperature: 0.1,
      }),
      { gateway: { id: "secondlook", skipCache: true, collectLog: false } },
    );
  });

  it("rejects model overrides outside the explicit Workers AI allowlist", async () => {
    const aiRun = vi.fn();
    const ai = Object.create(null) as Ai;
    Object.defineProperty(ai, "run", { value: aiRun });

    await expect(
      getSecondLook(
        { goal: "Review a plan", proposed_action: "Proceed" },
        { AI: ai, DB: Object.create(null) as D1Database },
        "gpt-5.6-luna",
      ),
    ).rejects.toMatchObject({ code: "unsupported_model_override" });
    expect(aiRun).not.toHaveBeenCalled();
  });
});
