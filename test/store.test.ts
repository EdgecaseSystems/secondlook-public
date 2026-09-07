import { describe, expect, it, vi } from "vitest";
import { saveDecision } from "../src/store";
import type { AppEnv, ModelDecision } from "../src/types";

describe("saveDecision", () => {
  it("persists the policy version beside the selected model for every new decision", async () => {
    const run = vi.fn(async () => ({ success: true }));
    const boundValues: unknown[] = [];
    const bind = vi.fn((...values: unknown[]) => {
      boundValues.push(...values);
      return { run };
    });
    const prepare = vi.fn(() => ({ bind }));
    const db = Object.create(null) as D1Database;
    Object.defineProperty(db, "prepare", { value: prepare });
    const env = { AI: Object.create(null) as Ai, DB: db } satisfies AppEnv;
    const result: ModelDecision = {
      decision: {
        review_status: "no_material_concern_found",
        reason: "All policy gates pass.",
        key_risks: [],
        missing_information: [],
      },
      model: "@cf/zai-org/glm-4.7-flash",
      policy_version: "2026-08-25.2",
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    await saveDecision(
      env,
      "decision-1",
      "2026-08-25T00:00:00.000Z",
      { goal: "Review", proposed_action: "Proceed" },
      result,
      null,
    );

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("constraint_context_json, constraint_resolution_json"));
    expect(bind).toHaveBeenCalledOnce();
    expect(boundValues[13]).toBe("2026-08-25.2");
    expect(boundValues[22]).toBe("no_material_concern_found");
    expect(boundValues[23]).toBeNull();
    expect(boundValues[24]).toBeNull();
    expect(run).toHaveBeenCalledOnce();
  });
});
