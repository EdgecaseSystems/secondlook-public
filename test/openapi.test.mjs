import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("OpenAPI contract", () => {
  it("documents the structured request, observational statuses, and compatibility alias", async () => {
    const document = await readFile(path.join(root, "openapi.yaml"), "utf8");
    for (const field of [
      "authority:",
      "hard_constraints:",
      "soft_preferences:",
      "known_facts:",
      "unknown_facts:",
      "alternatives_considered:",
      "review_status:",
    ]) expect(document).toContain(field);
    for (const status of [
      "no_material_concern_found",
      "material_concern_found",
      "insufficient_information",
      "human_review_required",
    ]) expect(document).toContain(status);
    expect(document).toMatch(/recommendation:\s*\n\s+type: string\s*\n\s+deprecated: true/);
    expect(document).toContain("SecondLook never supplies missing authority");
    for (const operationalContract of [
      "65,536 bytes",
      "24,000 aggregate text characters",
      "request_too_large",
      "ProviderTimeout:",
      "retryable:",
      "request_id:",
      "Idempotency-Key",
      "Idempotency-Replayed",
      "idempotency_key_conflict",
      "idempotency_state_ambiguous",
      "/v1/paid/second-look",
      "PAYMENT-REQUIRED",
      "PAYMENT-SIGNATURE",
      "PAYMENT-RESPONSE",
      "payment_proof_conflict",
      "payment_ambiguous",
      "paid_service_disabled",
    ]) expect(document).toContain(operationalContract);
  });
});
