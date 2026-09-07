import { describe, expect, it } from "vitest";
import { normalizeConstraintContext } from "../src/constraints";
import { parseSecondLookRequest } from "../src/validation";

const context = (overrides = {}) => ({
  schema_version: "constraint-context-v1" as const,
  constraints: [
    { id: "a", text: "A", applicability: "applicable" as const, action_relation: "violates" as const },
    { id: "b", text: "B", applicability: "applicable" as const, action_relation: "satisfies" as const },
  ],
  conflict_groups: [{ id: "ab", constraint_ids: ["a", "b"], control: { status: "established" as const, controlling_constraint_id: "b" } }],
  ...overrides,
});

describe("constraint-context-v1", () => {
  it("uses explicit established control and canonical IDs without reading text", () => {
    expect(normalizeConstraintContext(context())).toEqual({
      known_effective_violation_ids: [], invariant_violation_group_ids: [], material_unknown_constraint_ids: [], materially_unresolved_group_ids: [], superseded_constraint_ids: ["a"],
    });
  });

  it("preserves unresolved control only when it changes acceptability and recognizes invariant violations", () => {
    const unresolved = context({ conflict_groups: [{ id: "ab", constraint_ids: ["a", "b"], control: { status: "unresolved" as const } }] });
    expect(normalizeConstraintContext(unresolved).materially_unresolved_group_ids).toEqual(["ab"]);
    expect(normalizeConstraintContext({ ...unresolved, constraints: unresolved.constraints.map((item) => ({ ...item, action_relation: "violates" as const })) }).invariant_violation_group_ids).toEqual(["ab"]);
  });

  it("treats unresolved applicability as material only when the relation is not satisfying", () => {
    expect(normalizeConstraintContext({ schema_version: "constraint-context-v1", constraints: [{ id: "a", text: "A", applicability: "unresolved", action_relation: "violates" }] }).material_unknown_constraint_ids).toEqual(["a"]);
    expect(normalizeConstraintContext({ schema_version: "constraint-context-v1", constraints: [{ id: "a", text: "A", applicability: "unresolved", action_relation: "satisfies" }] }).material_unknown_constraint_ids).toEqual([]);
  });

  it("strictly validates completeness, exclusivity, and caller-supplied relationships", () => {
    expect(() => parseSecondLookRequest({ goal: "g", proposed_action: "a", hard_constraints: ["legacy"], constraint_context: context() })).toThrow(/constraint_context/);
    expect(() => parseSecondLookRequest({ goal: "g", proposed_action: "a", constraint_context: { ...context(), constraints: [{ id: "A", text: "x", applicability: "applicable", action_relation: "satisfies" }] } })).toThrow(/constraint/i);
    expect(parseSecondLookRequest({ goal: "g", proposed_action: "a", constraint_context: context() }).constraint_context?.schema_version).toBe("constraint-context-v1");
  });
});
