import { describe, expect, it } from "vitest";
import { redactAuthority, redactList, redactText } from "../src/privacy";

describe("redactText", () => {
  it("removes common personal identifiers", () => {
    const input = "Email me at person@example.com or call 214-555-1212. SSN 123-45-6789.";
    const output = redactText(input)!;
    expect(output).not.toContain("person@example.com");
    expect(output).not.toContain("214-555-1212");
    expect(output).not.toContain("123-45-6789");
    expect(output).toContain("[REDACTED_EMAIL]");
  });

  it("removes bearer tokens", () => {
    const output = redactText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456")!;
    expect(output).toBe("Authorization: Bearer [REDACTED_TOKEN]");
  });

  it("redacts structured authority and list fields", () => {
    expect(
      redactAuthority({
        status: "confirmed",
        basis: "Approved by person@example.com",
        limits: ["Do not expose Bearer abcdefghijklmnopqrstuvwxyz123456"],
      }),
    ).toEqual({
      status: "confirmed",
      basis: "Approved by [REDACTED_EMAIL]",
      limits: ["Do not expose Bearer [REDACTED_TOKEN]"],
    });
    expect(redactList(["Contact person@example.com"])).toEqual(["Contact [REDACTED_EMAIL]"]);
  });
});
