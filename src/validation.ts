import type { ConstraintContextV1, ReportOutcomeRequest, SecondLookRequest } from "./types";
import { ClientInputError } from "./errors";

const MAX_TEXT = 4_000;
const MAX_LIST_ITEMS = 25;
const MAX_TOTAL_TEXT = 24_000;
const MAX_NUMERIC_VALUE = 1_000_000_000_000_000;
const SECONDLOOK_FIELDS = new Set([
  "goal", "proposed_action", "authority", "hard_constraints", "constraint_context",
  "soft_preferences", "known_facts", "unknown_facts", "alternatives_considered",
  "reasoning_summary", "important_constraints", "uncertainties", "estimated_cost_of_action",
]);
const ESTIMATED_COST_FIELDS = new Set(["amount", "currency"]);
const OUTCOME_FIELDS = new Set(["decision_id", "outcome", "details", "measurable_value", "currency"]);
const AUTHORITY_FIELDS = new Set(["status", "basis", "limits"]);
const AUTHORITY_STATUSES = new Set(["confirmed", "unclear", "unknown"]);
const CONSTRAINT_CONTEXT_FIELDS = new Set(["schema_version", "constraints", "conflict_groups"]);
const CONSTRAINT_FIELDS = new Set(["id", "text", "applicability", "action_relation"]);
const GROUP_FIELDS = new Set(["id", "constraint_ids", "independently_binding_constraint_ids", "control"]);
const CONTROL_FIELDS = new Set(["status", "controlling_constraint_id"]);
const CONSTRAINT_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const OUTCOMES = new Set([
  "successful",
  "unsuccessful",
  "human_approved",
  "human_corrected",
  "reversed",
  "no_observable_issue",
  "unknown",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(value: unknown, required = false): value is string {
  if (value === undefined && !required) return true;
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT;
}

function validStringArray(value: unknown): value is string[] {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= MAX_LIST_ITEMS &&
      value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= MAX_TEXT))
  );
}

function hasOnlyFields(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((field) => allowed.has(field));
}

function textLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((total, item) => total + (typeof item === "string" ? item.length : 0), 0);
  return 0;
}

function totalRequestText(value: Record<string, unknown>): number {
  let total = textLength(value.goal) + textLength(value.proposed_action) + textLength(value.reasoning_summary);
  for (const field of ["hard_constraints", "soft_preferences", "known_facts", "unknown_facts", "alternatives_considered", "important_constraints", "uncertainties"]) {
    total += textLength(value[field]);
  }
  if (isObject(value.authority)) total += textLength(value.authority.basis) + textLength(value.authority.limits);
  if (isObject(value.constraint_context) && Array.isArray(value.constraint_context.constraints)) {
    total += value.constraint_context.constraints.reduce((sum, constraint) => sum + (isObject(constraint) ? textLength(constraint.text) : 0), 0);
  }
  return total;
}

function parseConstraintContext(value: unknown): ConstraintContextV1 {
  const invalid = (message: string): never => { throw new ClientInputError("invalid_constraint_context", message); };
  if (!isObject(value) || !hasOnlyFields(value, CONSTRAINT_CONTEXT_FIELDS) || value.schema_version !== "constraint-context-v1") {
    return invalid("constraint_context must be a constraint-context-v1 object.");
  }
  if (!Array.isArray(value.constraints) || value.constraints.length < 1 || value.constraints.length > 25) {
    return invalid("constraint_context.constraints must contain 1 to 25 constraints.");
  }
  const ids = new Set<string>();
  let totalText = 0;
  const constraints = value.constraints.map((entry) => {
    if (!isObject(entry) || !hasOnlyFields(entry, CONSTRAINT_FIELDS) || typeof entry.id !== "string" || !CONSTRAINT_ID.test(entry.id) || ids.has(entry.id)) {
      return invalid("constraint IDs must be unique lowercase technical IDs.");
    }
    if (typeof entry.text !== "string" || entry.text.trim().length === 0 || entry.text.length > 1000) return invalid("constraint text must be 1 to 1,000 characters.");
    if (!["applicable", "inapplicable", "unresolved"].includes(entry.applicability as string) || !["satisfies", "violates", "unresolved", "not_applicable"].includes(entry.action_relation as string)) {
      return invalid("constraint applicability or action_relation is invalid.");
    }
    if (entry.applicability === "inapplicable" && entry.action_relation !== "not_applicable") return invalid("inapplicable constraints must be not_applicable.");
    if (entry.applicability !== "inapplicable" && entry.action_relation === "not_applicable") return invalid("applicable or unresolved constraints cannot be not_applicable.");
    ids.add(entry.id); totalText += entry.text.length;
    return { id: entry.id, text: entry.text, applicability: entry.applicability, action_relation: entry.action_relation } as ConstraintContextV1["constraints"][number];
  });
  if (totalText > 12000) return invalid("total constraint text must be at most 12,000 characters.");
  if (value.conflict_groups !== undefined && (!Array.isArray(value.conflict_groups) || value.conflict_groups.length > 12)) return invalid("constraint_context.conflict_groups must contain at most 12 groups.");
  const groupIds = new Set<string>(); const grouped = new Set<string>();
  const byId = new Map(constraints.map((constraint) => [constraint.id, constraint]));
  const conflict_groups = (value.conflict_groups ?? []).map((entry) => {
    if (!isObject(entry) || !hasOnlyFields(entry, GROUP_FIELDS) || typeof entry.id !== "string" || !CONSTRAINT_ID.test(entry.id) || groupIds.has(entry.id)) return invalid("conflict group IDs must be unique technical IDs.");
    if (!Array.isArray(entry.constraint_ids) || entry.constraint_ids.length < 2 || entry.constraint_ids.length > 10 || !entry.constraint_ids.every((id) => typeof id === "string") || new Set(entry.constraint_ids).size !== entry.constraint_ids.length) return invalid("conflict groups must have 2 to 10 unique constraint IDs.");
    const memberIds = entry.constraint_ids as string[];
    if (memberIds.some((id) => !byId.has(id) || grouped.has(id) || byId.get(id)!.applicability === "inapplicable")) return invalid("conflict groups may reference each applicable constraint once.");
    if (!isObject(entry.control) || !hasOnlyFields(entry.control, CONTROL_FIELDS) || !["established", "unresolved"].includes(entry.control.status as string)) return invalid("conflict group control is invalid.");
    const controllerId = entry.control.controlling_constraint_id;
    if (entry.control.status === "established" && (typeof controllerId !== "string" || !memberIds.includes(controllerId) || byId.get(controllerId)?.applicability !== "applicable")) return invalid("established control must name an applicable group member.");
    if (entry.control.status === "unresolved" && "controlling_constraint_id" in entry.control) return invalid("unresolved control cannot name a controller.");
    const independentIds = entry.independently_binding_constraint_ids as string[] | undefined;
    if (independentIds !== undefined && (!Array.isArray(independentIds) || !independentIds.every((id) => typeof id === "string") || new Set(independentIds).size !== independentIds.length || independentIds.some((id) => !memberIds.includes(id)) || (entry.control.status === "established" && typeof controllerId === "string" && independentIds.includes(controllerId)))) return invalid("independently binding IDs must be unique group members other than the controller.");
    groupIds.add(entry.id); for (const id of memberIds) grouped.add(id);
    return { id: entry.id, constraint_ids: memberIds, independently_binding_constraint_ids: independentIds, control: entry.control as import("./types").ConstraintControl };
  });
  return { schema_version: "constraint-context-v1", constraints, conflict_groups };
}

export function parseSecondLookRequest(value: unknown): SecondLookRequest {
  const invalid = (message: string): never => {
    throw new ClientInputError("invalid_secondlook_request", message);
  };
  if (!isObject(value)) return invalid("Request body must be a JSON object.");
  if (!hasOnlyFields(value, SECONDLOOK_FIELDS)) return invalid("Request body contains an unknown field.");
  if (!validText(value.goal, true)) return invalid("goal is required and must be under 4,000 characters.");
  if (!validText(value.proposed_action, true)) return invalid("proposed_action is required and must be under 4,000 characters.");
  let authority: SecondLookRequest["authority"];
  if (value.authority !== undefined) {
    if (!isObject(value.authority) || !hasOnlyFields(value.authority, AUTHORITY_FIELDS)) {
      return invalid("authority must be an object containing only status, basis, and limits.");
    }
    if (typeof value.authority.status !== "string" || !AUTHORITY_STATUSES.has(value.authority.status)) {
      return invalid("authority.status must be confirmed, unclear, or unknown.");
    }
    if (!validText(value.authority.basis)) return invalid("authority.basis must be under 4,000 characters.");
    if (!validStringArray(value.authority.limits)) return invalid("authority.limits must be a short list of strings.");
    authority = {
      status: value.authority.status as "confirmed" | "unclear" | "unknown",
      basis: value.authority.basis as string | undefined,
      limits: value.authority.limits as string[] | undefined,
    };
  }
  if (!validStringArray(value.hard_constraints)) return invalid("hard_constraints must be a short list of strings.");
  if (!validStringArray(value.soft_preferences)) return invalid("soft_preferences must be a short list of strings.");
  if (!validStringArray(value.known_facts)) return invalid("known_facts must be a short list of strings.");
  if (!validStringArray(value.unknown_facts)) return invalid("unknown_facts must be a short list of strings.");
  if (!validStringArray(value.alternatives_considered)) return invalid("alternatives_considered must be a short list of strings.");
  if (!validText(value.reasoning_summary)) return invalid("reasoning_summary must be under 4,000 characters.");
  if (!validStringArray(value.important_constraints)) return invalid("important_constraints must be a short list of strings.");
  if (!validStringArray(value.uncertainties)) return invalid("uncertainties must be a short list of strings.");
  const constraintContext = value.constraint_context === undefined ? undefined : parseConstraintContext(value.constraint_context);
  if (constraintContext && ((value.hard_constraints?.length ?? 0) > 0 || (value.important_constraints?.length ?? 0) > 0)) {
    throw new ClientInputError("invalid_constraint_context", "constraint_context cannot be combined with nonempty legacy constraint lists.");
  }

  let estimatedCost: SecondLookRequest["estimated_cost_of_action"];
  if (value.estimated_cost_of_action !== undefined) {
    if (!isObject(value.estimated_cost_of_action) || !hasOnlyFields(value.estimated_cost_of_action, ESTIMATED_COST_FIELDS)) return invalid("estimated_cost_of_action must contain only amount and currency.");
    const amount = value.estimated_cost_of_action.amount;
    const currency = value.estimated_cost_of_action.currency;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > MAX_NUMERIC_VALUE) return invalid("estimated cost amount must be a bounded non-negative number.");
    if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return invalid("currency must be a 3-letter uppercase code such as USD.");
    estimatedCost = { amount, currency };
  }
  if (totalRequestText(value) > MAX_TOTAL_TEXT) return invalid("Total request text must be at most 24,000 characters.");

  return {
    goal: value.goal as string,
    proposed_action: value.proposed_action as string,
    authority,
    hard_constraints: value.hard_constraints as string[] | undefined,
    constraint_context: constraintContext,
    soft_preferences: value.soft_preferences as string[] | undefined,
    known_facts: value.known_facts as string[] | undefined,
    unknown_facts: value.unknown_facts as string[] | undefined,
    alternatives_considered: value.alternatives_considered as string[] | undefined,
    reasoning_summary: value.reasoning_summary as string | undefined,
    important_constraints: value.important_constraints as string[] | undefined,
    uncertainties: value.uncertainties as string[] | undefined,
    estimated_cost_of_action: estimatedCost,
  };
}

export function parseOutcomeRequest(value: unknown): ReportOutcomeRequest {
  const invalid = (message: string): never => {
    throw new ClientInputError("invalid_outcome_request", message);
  };
  if (!isObject(value)) return invalid("Request body must be a JSON object.");
  if (!hasOnlyFields(value, OUTCOME_FIELDS)) return invalid("Outcome body contains an unknown field.");
  if (!validText(value.decision_id, true)) return invalid("decision_id is required.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.decision_id as string)) return invalid("decision_id must be a UUID v4.");
  if (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) return invalid("outcome is invalid.");
  if (!validText(value.details)) return invalid("details must be under 4,000 characters.");
  if (value.measurable_value !== undefined && (typeof value.measurable_value !== "number" || !Number.isFinite(value.measurable_value) || Math.abs(value.measurable_value) > MAX_NUMERIC_VALUE)) {
    return invalid("measurable_value must be numeric.");
  }
  if (value.currency !== undefined && (typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency))) {
    return invalid("currency must be a 3-letter uppercase code such as USD.");
  }

  return {
    decision_id: value.decision_id as string,
    outcome: value.outcome as ReportOutcomeRequest["outcome"],
    details: value.details as string | undefined,
    measurable_value: value.measurable_value as number | undefined,
    currency: value.currency as string | undefined,
  };
}
