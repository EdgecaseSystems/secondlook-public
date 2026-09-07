import { describe, expect, it } from "vitest";
import { parseOutcomeRequest, parseSecondLookRequest } from "../src/validation";

describe("parseSecondLookRequest", () => {
  it("accepts a minimal valid request", () => {
    expect(
      parseSecondLookRequest({
        goal: "Buy the cheapest nonstop flight arriving before noon",
        proposed_action: "Purchase flight AA123 for $411",
      }),
    ).toMatchObject({ goal: expect.any(String), proposed_action: expect.any(String) });
  });

  it("accepts structured authority, constraints, facts, and alternatives", () => {
    expect(
      parseSecondLookRequest({
        goal: "Issue a verified duplicate-charge refund",
        proposed_action: "Refund $75",
        authority: { status: "confirmed", basis: "Support policy", limits: ["Up to $100"] },
        hard_constraints: ["Refund only verified duplicates"],
        soft_preferences: ["Resolve today if practical"],
        known_facts: ["The duplicate charge is verified"],
        unknown_facts: [],
        alternatives_considered: ["Escalate to billing"],
      }),
    ).toMatchObject({
      authority: { status: "confirmed", limits: ["Up to $100"] },
      known_facts: ["The duplicate charge is verified"],
    });
  });

  it("keeps legacy fields separate instead of silently promoting them", () => {
    const request = parseSecondLookRequest({
      goal: "Review a plan",
      proposed_action: "Use the plan",
      important_constraints: ["Legacy wording"],
      uncertainties: ["Legacy uncertainty"],
    });
    expect(request.hard_constraints).toBeUndefined();
    expect(request.unknown_facts).toBeUndefined();
    expect(request.important_constraints).toEqual(["Legacy wording"]);
    expect(request.uncertainties).toEqual(["Legacy uncertainty"]);
  });

  it("rejects unclear authority objects without an explicit status", () => {
    expect(() =>
      parseSecondLookRequest({
        goal: "Review",
        proposed_action: "Act",
        authority: { basis: "Maybe approved" },
      }),
    ).toThrow(/authority.status/);
  });

  it("rejects a missing goal", () => {
    expect(() => parseSecondLookRequest({ proposed_action: "Do something" })).toThrow(/goal is required/);
  });

  it("rejects invalid currency formatting", () => {
    expect(() =>
      parseSecondLookRequest({
        goal: "Buy something",
        proposed_action: "Pay now",
        estimated_cost_of_action: { amount: 10, currency: "usd" },
      }),
    ).toThrow(/currency/);
  });

  it("rejects unknown top-level and nested cost fields", () => {
    expect(() => parseSecondLookRequest({ goal: "Review", proposed_action: "Act", misspelled_fact: "ignored" })).toThrow(/unknown field/);
    expect(() => parseSecondLookRequest({
      goal: "Review",
      proposed_action: "Act",
      estimated_cost_of_action: { amount: 10, currency: "USD", note: "ignored" },
    })).toThrow(/only amount and currency/);
  });

  it("enforces a bounded aggregate text budget", () => {
    expect(() => parseSecondLookRequest({
      goal: "g".repeat(4_000),
      proposed_action: "a".repeat(4_000),
      known_facts: Array.from({ length: 5 }, () => "f".repeat(4_000)),
    })).toThrow(/24,000/);
  });
});

describe("parseOutcomeRequest", () => {
  it("accepts known outcome labels", () => {
    expect(parseOutcomeRequest({ decision_id: "123e4567-e89b-42d3-a456-426614174000", outcome: "successful" }).outcome).toBe("successful");
  });

  it("rejects unknown outcome labels", () => {
    expect(() => parseOutcomeRequest({ decision_id: "123e4567-e89b-42d3-a456-426614174000", outcome: "sort_of" })).toThrow(/invalid/);
  });

  it("rejects unknown outcome fields and non-UUID decision IDs", () => {
    expect(() => parseOutcomeRequest({ decision_id: "not-a-uuid", outcome: "successful" })).toThrow(/UUID v4/);
    expect(() => parseOutcomeRequest({
      decision_id: "123e4567-e89b-42d3-a456-426614174000",
      outcome: "successful",
      extra: true,
    })).toThrow(/unknown field/);
  });
});
