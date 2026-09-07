import type { ConstraintContextV1, StructuredConstraint } from "./types";

export interface ConstraintResolution {
  known_effective_violation_ids: string[];
  invariant_violation_group_ids: string[];
  material_unknown_constraint_ids: string[];
  materially_unresolved_group_ids: string[];
  superseded_constraint_ids: string[];
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort((a, b) => a.localeCompare(b));

/**
 * Applies only the relationships explicitly supplied in constraint-context-v1.
 * It never derives precedence or meaning from constraint text or array order.
 */
export function normalizeConstraintContext(context: ConstraintContextV1): ConstraintResolution {
  const byId = new Map(context.constraints.map((constraint) => [constraint.id, constraint]));
  const groupedIds = new Set<string>();
  const knownViolations = new Set<string>();
  const invariantGroups = new Set<string>();
  const materialUnknowns = new Set<string>();
  const unresolvedGroups = new Set<string>();
  const superseded = new Set<string>();

  const applyEffective = (constraint: StructuredConstraint) => {
    if (constraint.applicability === "inapplicable") return;
    if (constraint.applicability === "unresolved") {
      if (constraint.action_relation !== "satisfies") materialUnknowns.add(constraint.id);
      return;
    }
    if (constraint.action_relation === "violates") knownViolations.add(constraint.id);
    if (constraint.action_relation === "unresolved") materialUnknowns.add(constraint.id);
  };

  for (const group of context.conflict_groups ?? []) {
    for (const id of group.constraint_ids) groupedIds.add(id);
    const members = group.constraint_ids.map((id) => byId.get(id)!);
    const independent = new Set(group.independently_binding_constraint_ids ?? []);
    if (group.control.status === "established") {
      for (const constraint of members) {
        if (constraint.id === group.control.controlling_constraint_id || independent.has(constraint.id)) {
          applyEffective(constraint);
        } else if (constraint.applicability !== "inapplicable") {
          superseded.add(constraint.id);
        }
      }
      continue;
    }

    for (const constraint of members) if (independent.has(constraint.id)) applyEffective(constraint);
    const possibleControllers = members.filter((constraint) => !independent.has(constraint.id) && constraint.applicability !== "inapplicable");
    const relations = possibleControllers.map((constraint) => constraint.action_relation);
    if (relations.length === 0 || relations.every((relation) => relation === "satisfies")) continue;
    if (relations.every((relation) => relation === "violates")) {
      invariantGroups.add(group.id);
    } else {
      unresolvedGroups.add(group.id);
    }
  }

  for (const constraint of context.constraints) if (!groupedIds.has(constraint.id)) applyEffective(constraint);
  return {
    known_effective_violation_ids: sorted(knownViolations),
    invariant_violation_group_ids: sorted(invariantGroups),
    material_unknown_constraint_ids: sorted(materialUnknowns),
    materially_unresolved_group_ids: sorted(unresolvedGroups),
    superseded_constraint_ids: sorted(superseded),
  };
}
