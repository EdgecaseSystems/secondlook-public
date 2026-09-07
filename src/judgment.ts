import { redactAuthority, redactConstraintContext, redactList, redactText } from "./privacy";
import { normalizeConstraintContext } from "./constraints";
import { ClientInputError, ModelResponseError } from "./errors";
import type {
  AppEnv,
  LegacyRecommendation,
  ModelDecision,
  ReviewStatus,
  SecondLookDecision,
  SecondLookRequest,
  WorkersAiModel,
} from "./types";

export const WORKERS_AI_MODEL = "@cf/google/gemma-4-26b-a4b-it" as const;
export const POLICY_VERSION = "2026-08-27.5" as const;
export const WORKERS_AI_MODELS = [
  WORKERS_AI_MODEL,
  "@cf/zai-org/glm-4.7-flash",
  "@cf/nvidia/nemotron-3-120b-a12b",
] as const satisfies readonly WorkersAiModel[];
const OPENAI_DEFAULT_MODEL = "gpt-5.6-luna";

type GateName = "authority_or_required_human_review" | "known_material_concern" | "material_unknown" | "inherent_human_accountability";
type GateAssessment = { schema_version: "secondlook-gates-v1"; gates: Record<GateName, { triggered: boolean; reason: string | null }>; clear_reason: string | null; key_risks: string[]; missing_information: string[] };
const GATE_PRECEDENCE: readonly [GateName, ReviewStatus][] = [["authority_or_required_human_review", "human_review_required"], ["known_material_concern", "material_concern_found"], ["material_unknown", "insufficient_information"], ["inherent_human_accountability", "human_review_required"]];

const SYSTEM_INSTRUCTIONS = `You are SecondLook, the final independent check before an AI agent acts.

SecondLook is not an authorization service. The caller remains responsible for establishing authority and deciding whether to execute. SecondLook never creates, grants, infers, or fills in missing authority. Assess only the supplied action and information. Never invent facts, authority, approvals, remediation, or future verification.

Return a private semantic gate assessment, not a public review status. Evaluate all four gates independently. Application code owns final status selection and precedence; do not select a final status or stop assessing later gates.

Before assessing known constraints, resolve only relationships supplied for this decision. Explicit language that one instruction controls, governs, takes precedence, is controlling, or clearly equivalent language establishes the relevant precedence relationship. Supersede only conflicting non-controlling instructions, unless supplied information says one remains independently binding; unrelated independently applicable constraints remain effective. Do not infer control from array order, prohibition wording, strictness, conservatism, or position.

When constraint_resolution is supplied, it is complete authoritative deterministic input. Use normalized_signals as supplied: known_effective_violation_ids and invariant_violation_group_ids are known-concern input; material_unknown_constraint_ids and materially_unresolved_group_ids are material-unknown input; superseded_constraint_ids cannot independently create a concern. Do not infer, recalculate, contradict, or supplement applicability, action relation, control, precedence, or constraint meaning from text, IDs, array order, or other fields. Structured context does not alter authority assessment.

Assess these four independent semantic gates:
1. authority_or_required_human_review: true only when supplied information establishes that the action exceeds an explicit authority limit, required authority is missing, unknown, or unclear, or an explicit required human approval or review is unsatisfied. Absence of an authority field alone is not missing authority. Do not invent an authority or approval requirement from cost, domain, sensitivity, regulation, or consequence.
2. known_material_concern: true only for an established concrete problem after supplied constraint resolution, including an effective hard-constraint violation, conflict with established facts, a clearly superior eligible alternative, or a known unsafe, incompatible, or incorrect action. A violation of one possible controlling instruction is not a known effective violation when control is materially unresolved and another possible controller accepts the action. If every possible controlling instruction rejects the action, it may be a known material concern.
3. material_unknown: true when a supplied outcome-sensitive factual uncertainty could change whether the action is acceptable, including unresolved control or precedence. If unresolved control means one possible controller accepts the action and another rejects it, known_material_concern for that unresolved issue is false and material_unknown is true. Do not treat violation of one possible controller as a known effective violation. Missing or unclear required authority belongs only in the authority gate.
4. inherent_human_accountability: true only when the nature of the action intrinsically requires an independent human accountability checkpoint. Financial, medical, tax, legal, regulated, sensitive-data, personal-data, or consequential domain labels alone are not enough.

Multiple gates may be true for separate conditions, such as an explicit authority exceedance plus an independent known material concern. Do not double-classify the same epistemically unresolved issue as both known_material_concern and material_unknown: known means established; unknown means outcome-sensitive uncertainty.

Interpret supplied ordinary constraint wording inclusively unless supplied text establishes another boundary. “By X” means no later than X. “After N days” is normally a minimum waiting period, not an exact-day-only window or upper bound. Do not invent expiration of authorization merely because more than the minimum waiting period has elapsed. “At most”, “no more than”, and “must not exceed X” include X; “at least X” includes X. Hard constraints determine eligibility; soft preferences optimize among eligible options. An unmet soft preference alone is not a material concern. Legacy fields may mix concepts; use only what their wording establishes.

Respond with one valid JSON object only, with no Markdown or surrounding text. Use exactly these top-level keys: schema_version, gates, clear_reason, key_risks, missing_information. schema_version must be secondlook-gates-v1. gates must contain exactly authority_or_required_human_review, known_material_concern, material_unknown, and inherent_human_accountability. Each gate has triggered (boolean) and reason (a concise nonempty string only when triggered; otherwise null). key_risks and missing_information are arrays of short strings.

When a gate is triggered, return clear_reason as null; application selection does not rely on clear_reason in triggered assessments. When no gate is triggered, all four triggered values must be false, every gate reason must be null, clear_reason must be one concise nonempty string, and key_risks and missing_information must remain arrays. Do not add review_status, a fifth clear gate, or any extra top-level field. Example: {"schema_version":"secondlook-gates-v1","gates":{"authority_or_required_human_review":{"triggered":false,"reason":null},"known_material_concern":{"triggered":false,"reason":null},"material_unknown":{"triggered":false,"reason":null},"inherent_human_accountability":{"triggered":false,"reason":null}},"clear_reason":"No material concern is established from the supplied information.","key_risks":[],"missing_information":[]}.`;

function sanitizeInput(input: SecondLookRequest): SecondLookRequest {
  return {
    goal: redactText(input.goal) ?? "",
    proposed_action: redactText(input.proposed_action) ?? "",
    authority: redactAuthority(input.authority),
    hard_constraints: redactList(input.hard_constraints),
    constraint_context: redactConstraintContext(input.constraint_context),
    soft_preferences: redactList(input.soft_preferences),
    known_facts: redactList(input.known_facts),
    unknown_facts: redactList(input.unknown_facts),
    alternatives_considered: redactList(input.alternatives_considered),
    reasoning_summary: redactText(input.reasoning_summary),
    important_constraints: redactList(input.important_constraints),
    uncertainties: redactList(input.uncertainties),
    estimated_cost_of_action: input.estimated_cost_of_action,
  };
}

function makePrompt(input: SecondLookRequest, constraintResolution?: import("./constraints").ConstraintResolution): string {
  const structured = input.constraint_context
    ? {
        constraint_resolution: {
          context: input.constraint_context,
          normalized_signals: constraintResolution,
          instruction: "The caller supplied these relationships authoritatively. Do not infer, recalculate, or override control, applicability, or constraint meaning from text or array order. Treat known effective violations as known-concern input and material unknown or unresolved-control signals as material-unknown input.",
        },
      }
    : { hard_constraints: input.hard_constraints ?? [] };
  return JSON.stringify(
    {
      goal: input.goal,
      proposed_action: input.proposed_action,
      authority: input.authority ?? null,
      ...structured,
      soft_preferences: input.soft_preferences ?? [],
      known_facts: input.known_facts ?? [],
      unknown_facts: input.unknown_facts ?? [],
      alternatives_considered: input.alternatives_considered ?? [],
      reasoning_summary: input.reasoning_summary ?? null,
      legacy_fields: {
        important_constraints: input.important_constraints ?? [],
        uncertainties: input.uncertainties ?? [],
      },
      estimated_cost_of_action: input.estimated_cost_of_action ?? null,
    },
    null,
    2,
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

const KNOWN_TOP_LEVEL_FIELDS = [
  "response",
  "choices",
  "usage",
  "id",
  "object",
  "created",
  "model",
  "system_fingerprint",
  "service_tier",
] as const;

function describeWorkersAiResponseShape(payload: unknown): Record<string, unknown> {
  const shape: Record<string, unknown> = { top_level_type: valueType(payload) };
  if (!isObject(payload)) return shape;

  const keys = Object.keys(payload);
  const knownFields: Record<string, string> = {};
  for (const key of KNOWN_TOP_LEVEL_FIELDS) {
    if (key in payload) knownFields[key] = valueType(payload[key]);
  }

  shape.top_level_key_count = keys.length;
  shape.known_top_level_fields = knownFields;
  shape.unknown_top_level_key_count = keys.filter(
    (key) => !(KNOWN_TOP_LEVEL_FIELDS as readonly string[]).includes(key),
  ).length;

  if (isObject(payload.response)) {
    shape.response_type = "object";
    shape.response_key_count = Object.keys(payload.response).length;
  } else if ("response" in payload) {
    shape.response_type = valueType(payload.response);
  }

  if (Array.isArray(payload.choices)) {
    shape.choices_length = payload.choices.length;
    const firstChoice = payload.choices[0];
    shape.first_choice_type = valueType(firstChoice);
    if (isObject(firstChoice)) {
      shape.first_choice_text_type = "text" in firstChoice ? valueType(firstChoice.text) : "absent";
      shape.first_choice_message_type = "message" in firstChoice ? valueType(firstChoice.message) : "absent";
      if (isObject(firstChoice.message)) {
        shape.first_message_content_type =
          "content" in firstChoice.message ? valueType(firstChoice.message.content) : "absent";
      }
    }
  }

  return shape;
}

function extractOpenAiOutputText(payload: unknown): string {
  if (!isObject(payload)) throw new Error("Model returned an invalid response.");
  if (typeof payload.output_text === "string") return payload.output_text;
  if (Array.isArray(payload.output)) {
    for (const item of payload.output) {
      if (!isObject(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (isObject(content) && content.type === "output_text" && typeof content.text === "string") {
          return content.text;
        }
      }
    }
  }
  throw new Error("Model response did not contain output text.");
}

function normalizeJsonText(text: string): string {
  return text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
}

function parseDecisionText(text: string, constraintResolution?: import("./constraints").ConstraintResolution): SecondLookDecision {
  let value: unknown;
  try {
    value = JSON.parse(normalizeJsonText(text));
  } catch {
    throw new ModelResponseError("invalid_model_json", "Model output was not valid JSON.");
  }
  return validateDecision(value, constraintResolution);
}

function extractWorkersAiDecision(payload: unknown, constraintResolution?: import("./constraints").ConstraintResolution): SecondLookDecision {
  try {
    if (!isObject(payload)) throw new ModelResponseError("invalid_model_payload", "Model returned an invalid payload.");

    // Workers AI's native text-generation interface returns generated text
    // under `response`.
    if (typeof payload.response === "string") return parseDecisionText(payload.response, constraintResolution);
    if (isObject(payload.response)) return validateDecision(payload.response, constraintResolution);

    // Newer model-specific interfaces use the OpenAI chat-completions shape.
    if (Array.isArray(payload.choices)) {
      for (const choice of payload.choices) {
        if (!isObject(choice)) continue;
        if (typeof choice.text === "string") return parseDecisionText(choice.text, constraintResolution);
        if (!isObject(choice.message)) continue;
        if (typeof choice.message.content === "string") return parseDecisionText(choice.message.content, constraintResolution);
        if (typeof choice.message.refusal === "string" && choice.message.refusal.length > 0) {
          throw new ModelResponseError("model_refusal", "Model declined to produce the required decision object.");
        }
      }
    }

    throw new ModelResponseError("missing_model_output", "Model response did not contain final output text.");
  } catch (error) {
    // Log only bounded structural metadata. Never log response values, model
    // text, user text, secrets, or dynamic field names.
    console.error("Workers AI response extraction failed", describeWorkersAiResponseShape(payload));
    throw error;
  }
}

function getWorkersAiUsage(payload: unknown): ModelDecision["usage"] {
  if (!isObject(payload) || !isObject(payload.usage)) return {};
  return {
    input_tokens: typeof payload.usage.prompt_tokens === "number" ? payload.usage.prompt_tokens : undefined,
    output_tokens: typeof payload.usage.completion_tokens === "number" ? payload.usage.completion_tokens : undefined,
  };
}

function getOpenAiUsage(payload: unknown): ModelDecision["usage"] {
  if (!isObject(payload) || !isObject(payload.usage)) return {};
  return {
    input_tokens: typeof payload.usage.input_tokens === "number" ? payload.usage.input_tokens : undefined,
    output_tokens: typeof payload.usage.output_tokens === "number" ? payload.usage.output_tokens : undefined,
  };
}

export function selectReviewStatus(assessment: GateAssessment): SecondLookDecision {
  for (const [gate, review_status] of GATE_PRECEDENCE) {
    if (assessment.gates[gate].triggered) return { review_status, reason: assessment.gates[gate].reason!, key_risks: assessment.key_risks, missing_information: assessment.missing_information };
  }
  return { review_status: "no_material_concern_found", reason: assessment.clear_reason!, key_risks: assessment.key_risks, missing_information: assessment.missing_information };
}

function mergeAuthoritativeConstraintSignals(assessment: GateAssessment, constraintResolution?: import("./constraints").ConstraintResolution): GateAssessment {
  if (!constraintResolution) return assessment;
  const knownEstablished = constraintResolution.known_effective_violation_ids.length > 0
    || constraintResolution.invariant_violation_group_ids.length > 0;
  const materialUnknown = constraintResolution.material_unknown_constraint_ids.length > 0
    || constraintResolution.materially_unresolved_group_ids.length > 0;
  const promoteMaterialUnknown = !assessment.gates.material_unknown.triggered && materialUnknown;
  return {
    ...assessment,
    missing_information: promoteMaterialUnknown && assessment.missing_information.length === 0
      ? ["Which supplied constraint or control relationship ultimately governs the action."]
      : assessment.missing_information,
    gates: {
      ...assessment.gates,
      known_material_concern: assessment.gates.known_material_concern.triggered || !knownEstablished
        ? assessment.gates.known_material_concern
        : { triggered: true, reason: "The supplied structured constraint context establishes an effective constraint violation." },
      material_unknown: !promoteMaterialUnknown
        ? assessment.gates.material_unknown
        : { triggered: true, reason: "The supplied structured constraint context contains a material unresolved constraint." },
    },
  };
}

function validateDecision(value: unknown, constraintResolution?: import("./constraints").ConstraintResolution): SecondLookDecision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelResponseError("invalid_gate_schema", "Model JSON must be a gate-assessment object.");
  }
  const object = value as Record<string, unknown>;
  const expected = ["schema_version", "gates", "clear_reason", "key_risks", "missing_information"];
  if (Object.keys(object).length !== expected.length || !expected.every((key) => key in object) || object.schema_version !== "secondlook-gates-v1") throw new ModelResponseError("invalid_gate_schema", "Model returned an invalid gate-assessment schema.");
  if (!Array.isArray(object.key_risks) || !object.key_risks.every((item) => typeof item === "string" && item.length <= 500)) {
    throw new ModelResponseError("invalid_key_risks", "Model returned invalid key_risks.");
  }
  if (!Array.isArray(object.missing_information) || !object.missing_information.every((item) => typeof item === "string" && item.length <= 500)) {
    throw new ModelResponseError("invalid_missing_information", "Model returned invalid missing_information.");
  }
  if (!isObject(object.gates)) throw new ModelResponseError("invalid_gate_object", "Model returned invalid gates.");
  const gateObject = object.gates;
  const names: GateName[] = ["authority_or_required_human_review", "known_material_concern", "material_unknown", "inherent_human_accountability"];
  if (Object.keys(gateObject).length !== names.length || !names.every((name) => name in gateObject)) throw new ModelResponseError("invalid_gate_object", "Model returned invalid gates.");
  const gates = {} as GateAssessment["gates"];
  for (const name of names) {
    const gate = gateObject[name];
    if (!isObject(gate) || Object.keys(gate).length !== 2 || typeof gate.triggered !== "boolean" || !("reason" in gate) || (gate.triggered ? typeof gate.reason !== "string" || !gate.reason || gate.reason.length > 1500 : gate.reason !== null)) throw new ModelResponseError("invalid_gate_object", "Model returned an invalid gate.");
    gates[name] = { triggered: gate.triggered, reason: gate.reason as string | null };
  }
  const anyTriggered = names.some((name) => gates[name].triggered);
  if (
    (anyTriggered && object.clear_reason !== null && (typeof object.clear_reason !== "string" || !object.clear_reason || object.clear_reason.length > 1500))
    || (!anyTriggered && (typeof object.clear_reason !== "string" || !object.clear_reason || object.clear_reason.length > 1500))
  ) {
    throw new ModelResponseError("invalid_clear_reason_consistency", "Model returned an invalid clear-reason consistency.");
  }
  if (gates.material_unknown.triggered && object.missing_information.length === 0) {
    throw new ModelResponseError("invalid_material_unknown_consistency", "Model returned material-unknown without missing information.");
  }
  return selectReviewStatus(mergeAuthoritativeConstraintSignals({ schema_version: "secondlook-gates-v1", gates, clear_reason: object.clear_reason as string | null, key_risks: (object.key_risks as string[]).slice(0, 10), missing_information: (object.missing_information as string[]).slice(0, 10) }, constraintResolution));
}

export function toLegacyRecommendation(reviewStatus: ReviewStatus): LegacyRecommendation {
  switch (reviewStatus) {
    case "no_material_concern_found":
      return "proceed";
    case "material_concern_found":
      return "reconsider";
    case "insufficient_information":
      return "need_more_information";
    case "human_review_required":
      return "escalate_to_human";
  }
}

export function parseWorkersAiModel(value: string | null | undefined): WorkersAiModel {
  const model = value?.trim() || WORKERS_AI_MODEL;
  if (!(WORKERS_AI_MODELS as readonly string[]).includes(model)) {
    throw new ClientInputError(
      "unsupported_model_override",
      "The requested model is not an approved Workers AI evaluation model.",
    );
  }
  return model as WorkersAiModel;
}

function makeWorkersAiRequest(model: WorkersAiModel, safeInput: SecondLookRequest, constraintResolution?: import("./constraints").ConstraintResolution): ChatCompletionsInput {
  const common = {
    messages: [
      { role: "system" as const, content: SYSTEM_INSTRUCTIONS },
      { role: "user" as const, content: makePrompt(safeInput, constraintResolution) },
    ],
    max_completion_tokens: 700,
    temperature: 0.1,
  };

  switch (model) {
    case "@cf/zai-org/glm-4.7-flash":
    case "@cf/google/gemma-4-26b-a4b-it":
    case "@cf/nvidia/nemotron-3-120b-a12b":
      // The current Cloudflare schema for each of these reasoning models
      // documents enable_thinking. Disable it for bounded structured output.
      return { ...common, chat_template_kwargs: { enable_thinking: false } };
  }
}

async function getWorkersAiSecondLook(
  input: SecondLookRequest,
  env: AppEnv,
  requestedModel?: string | null,
): Promise<ModelDecision> {
  const model = parseWorkersAiModel(requestedModel);
  const safeInput = sanitizeInput(input);
  const constraintResolution = safeInput.constraint_context ? normalizeConstraintContext(safeInput.constraint_context) : undefined;
  const payload = await env.AI.run(
    model,
    makeWorkersAiRequest(model, safeInput, constraintResolution),
    { gateway: { id: "secondlook", skipCache: true, collectLog: false } },
  );

  return {
    decision: extractWorkersAiDecision(payload, constraintResolution),
    model,
    usage: getWorkersAiUsage(payload),
    policy_version: POLICY_VERSION,
    constraint_resolution: constraintResolution,
  };
}

async function getOpenAiSecondLook(input: SecondLookRequest, env: AppEnv): Promise<ModelDecision> {
  if (!env.OPENAI_API_KEY) throw new Error("OpenAI provider is selected but OPENAI_API_KEY is not configured.");

  const model = env.OPENAI_MODEL || OPENAI_DEFAULT_MODEL;
  const safeInput = sanitizeInput(input);
  const constraintResolution = safeInput.constraint_context ? normalizeConstraintContext(safeInput.constraint_context) : undefined;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      instructions: SYSTEM_INSTRUCTIONS,
      input: makePrompt(safeInput, constraintResolution),
      max_output_tokens: 700,
    }),
  });

  if (!response.ok) {
    throw new Error(`AI provider error (${response.status}).`);
  }

  const payload: unknown = await response.json();

  return {
    decision: parseDecisionText(extractOpenAiOutputText(payload), constraintResolution),
    model,
    usage: getOpenAiUsage(payload),
    policy_version: POLICY_VERSION,
    constraint_resolution: constraintResolution,
  };
}

export async function getSecondLook(
  input: SecondLookRequest,
  env: AppEnv,
  requestedWorkersAiModel?: string | null,
): Promise<ModelDecision> {
  if (env.MODEL_PROVIDER === "openai") {
    if (requestedWorkersAiModel) {
      throw new ClientInputError(
        "unsupported_model_override",
        "Workers AI model overrides are unavailable for the selected provider.",
      );
    }
    return getOpenAiSecondLook(input, env);
  }
  return getWorkersAiSecondLook(input, env, requestedWorkersAiModel);
}
