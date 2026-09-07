import { PilotUsageLimitError } from "./errors";
import type { AppEnv, AuthContext } from "./types";

const PILOT_KEY = /^slk_pilot_([a-z0-9]{16})\.([A-Za-z0-9_-]{43})$/;

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function authenticate(request: Request, env: AppEnv): Promise<AuthContext | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (env.SECONDLOOK_ACCESS_KEY && constantTimeEqual(await sha256Hex(authorization), await sha256Hex(`Bearer ${env.SECONDLOOK_ACCESS_KEY}`))) return { kind: "internal" };
  if (!authorization.startsWith("Bearer ")) return null;
  const parsed = PILOT_KEY.exec(authorization.slice("Bearer ".length));
  if (!parsed) return null;
  const [, keyId, secret] = parsed;
  const record = await env.DB.prepare("SELECT key_id, customer_id, project_id, status, secret_hash FROM pilot_api_keys WHERE key_id = ?").bind(keyId).first<{ key_id: string; customer_id: string; project_id: string; status: string; secret_hash: string }>();
  if (!record || record.status !== "active" || !constantTimeEqual(await sha256Hex(secret), record.secret_hash)) return null;
  return { kind: "pilot", key_id: record.key_id, customer_id: record.customer_id, project_id: record.project_id };
}

export async function reservePilotReviewAttempt(env: AppEnv, auth: AuthContext): Promise<void> {
  if (auth.kind !== "pilot") return;
  const result = await env.DB.prepare("UPDATE pilot_api_keys SET review_attempt_count = review_attempt_count + 1 WHERE key_id = ? AND status = 'active' AND review_attempt_count < review_attempt_limit").bind(auth.key_id).run();
  if (result.meta.changes !== 1) throw new PilotUsageLimitError();
}
