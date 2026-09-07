import { describe, expect, it } from "vitest";
import { authenticate, reservePilotReviewAttempt } from "../src/auth";
import type { AppEnv } from "../src/types";

const pilotKey = "slk_pilot_0123456789abcdef.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
async function digest(value: string) { const bytes = new TextEncoder().encode(value); const hash = await crypto.subtle.digest("SHA-256", bytes); return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

function env(record: Record<string, unknown> | null, changes = 1) {
  const db = { prepare: (sql: string) => ({ bind: () => ({ first: async () => sql.startsWith("SELECT") ? record : null, run: async () => ({ meta: { changes } }) }) }) } as unknown as D1Database;
  return { AI: Object.create(null) as Ai, DB: db, SECONDLOOK_ACCESS_KEY: "internal-secret" } satisfies AppEnv;
}

describe("pilot authentication and cap", () => {
  it("preserves internal authorization and accepts only a matching active pilot secret", async () => {
    expect((await authenticate(new Request("https://x", { headers: { authorization: "Bearer internal-secret" } }), env(null)))?.kind).toBe("internal");
    const record = { key_id: "0123456789abcdef", customer_id: "customer-a", project_id: "project-a", status: "active", secret_hash: await digest(pilotKey.split(".")[1]) };
    expect(await authenticate(new Request("https://x", { headers: { authorization: `Bearer ${pilotKey}` } }), env(record))).toMatchObject({ kind: "pilot", customer_id: "customer-a" });
    expect(await authenticate(new Request("https://x", { headers: { authorization: `Bearer slk_pilot_0123456789abcdef.${"b".repeat(43)}` } }), env(record))).toBeNull();
    expect(await authenticate(new Request("https://x", { headers: { authorization: `Bearer ${pilotKey}` } }), env({ ...record, status: "revoked" }))).toBeNull();
  });

  it("uses one atomic active-and-under-limit update and rejects a boundary miss", async () => {
    const auth = { kind: "pilot" as const, key_id: "0123456789abcdef", customer_id: "customer-a", project_id: "project-a" };
    await expect(reservePilotReviewAttempt(env(null, 1), auth)).resolves.toBeUndefined();
    await expect(reservePilotReviewAttempt(env(null, 0), auth)).rejects.toThrow(/limit/);
  });
});
