import { ClientInputError, IdempotencyLifecycleError, PaymentLifecycleError } from "./errors";
import { POLICY_VERSION, WORKERS_AI_MODEL, parseWorkersAiModel } from "./judgment";
import { callerKey } from "./operations";
import { preserveRemediationBeforeExpiredLifecycleDeletion } from "./remediation";
import { repairExistingPaymentState } from "./payments";
import { IDEMPOTENCY_STATE_STALE_SECONDS } from "./lifecycle-constants";
import type { AppEnv, AuthContext, SecondLookRequest, SecondLookResponse } from "./types";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
export const IDEMPOTENCY_RETENTION_SECONDS = 7 * 24 * 60 * 60;
export const IDEMPOTENCY_RESERVATION_STALE_SECONDS = IDEMPOTENCY_STATE_STALE_SECONDS;
export const IDEMPOTENCY_IN_PROGRESS_RETRY_SECONDS = 5;

type LifecycleState = "reserved" | "inference_running" | "completed" | "failed_before_inference" | "ambiguous";

type LifecycleRow = {
  request_id: string;
  request_hash: string;
  state: LifecycleState;
  response_json: string | null;
  updated_at: string;
  owner_token: string | null;
};

export type IdempotencyReservation = {
  kind: "acquired";
  requestId: string;
  ownerToken: string;
} | {
  kind: "replay";
  requestId: string;
  response: SecondLookResponse;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function readIdempotencyKey(request: Request): string | null {
  const value = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (value === null) return null;
  if (
    value.length < IDEMPOTENCY_KEY_MIN_LENGTH ||
    value.length > IDEMPOTENCY_KEY_MAX_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new ClientInputError(
      "invalid_idempotency_key",
      `Idempotency-Key must be ${IDEMPOTENCY_KEY_MIN_LENGTH}-${IDEMPOTENCY_KEY_MAX_LENGTH} characters using letters, digits, period, underscore, colon, or hyphen.`,
    );
  }
  return value;
}

export async function readPaidIdempotency(request: Request): Promise<{ key: string; auth: Extract<AuthContext, { kind: "paid" }> }> {
  const key = readIdempotencyKey(request);
  if (key === null) throw new ClientInputError("missing_idempotency_key", "The paid endpoint requires an Idempotency-Key UUID.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw new ClientInputError("invalid_idempotency_key", "Paid Idempotency-Key values must be UUIDv4 capability identifiers.");
  }
  return { key, auth: { kind: "paid", key_id: await sha256Hex(key) } };
}

export async function readExistingPaidIdempotencyCandidate(
  request: Request,
): Promise<{ key: string; auth: Extract<AuthContext, { kind: "paid" }> } | null> {
  const key = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (key === null || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) return null;
  return { key, auth: { kind: "paid", key_id: await sha256Hex(key) } };
}

export async function paidIdempotentRequestExists(
  env: AppEnv,
  auth: Extract<AuthContext, { kind: "paid" }>,
  idempotencyKey: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS present FROM idempotent_requests WHERE caller_key = ? AND idempotency_key_hash = ?",
  ).bind(callerKey(auth), await sha256Hex(idempotencyKey)).first<{ present: number }>();
  return row?.present === 1;
}

export async function paidRateLimitContext(request: Request): Promise<Extract<AuthContext, { kind: "paid" }>> {
  const connectingIp = request.headers.get("cf-connecting-ip")?.trim() ?? "unavailable";
  const bounded = connectingIp.length > 0 && connectingIp.length <= 64 ? connectingIp : "invalid";
  return { kind: "paid", key_id: `edge-${await sha256Hex(`cf-ip:${bounded}`)}` };
}

export function executionModelIdentity(env: AppEnv, requestedModel: string | null): string {
  if (env.MODEL_PROVIDER === "openai") {
    if (requestedModel) {
      throw new ClientInputError(
        "unsupported_model_override",
        "Workers AI model overrides are unavailable for the selected provider.",
      );
    }
    return env.OPENAI_MODEL?.trim() || "openai-provider-default";
  }
  return parseWorkersAiModel(requestedModel) || WORKERS_AI_MODEL;
}

function callerModelOverrideIdentity(env: AppEnv, requestedModel: string | null): string | undefined {
  if (env.MODEL_PROVIDER === "openai") {
    if (requestedModel?.trim()) {
      throw new ClientInputError(
        "unsupported_model_override",
        "Workers AI model overrides are unavailable for the selected provider.",
      );
    }
    return undefined;
  }
  const requested = requestedModel?.trim();
  return requested ? parseWorkersAiModel(requested) : undefined;
}

export async function fingerprintSecondLookRequest(
  input: SecondLookRequest,
  env: AppEnv,
  requestedModel: string | null,
): Promise<{ hash: string; executionContext: string }> {
  const executionContext = JSON.stringify({
    provider: env.MODEL_PROVIDER ?? "workers_ai",
    model: executionModelIdentity(env, requestedModel),
    policy_version: POLICY_VERSION,
  });
  const requestedModelOverride = callerModelOverrideIdentity(env, requestedModel);
  const canonical = JSON.stringify(canonicalize({
    request: input,
    ...(requestedModelOverride === undefined ? {} : { requested_model_override: requestedModelOverride }),
  }));
  return { hash: await sha256Hex(canonical), executionContext };
}

function parseReplay(row: LifecycleRow): SecondLookResponse {
  if (!row.response_json) throw new IdempotencyLifecycleError("idempotency_state_ambiguous", false);
  try {
    const value = JSON.parse(row.response_json) as Partial<SecondLookResponse>;
    if (
      typeof value.decision_id !== "string" ||
      typeof value.created_at !== "string" ||
      typeof value.policy_version !== "string" ||
      typeof value.model !== "string" ||
      typeof value.review_status !== "string" ||
      typeof value.reason !== "string" ||
      !Array.isArray(value.key_risks) ||
      !Array.isArray(value.missing_information) ||
      typeof value.recommendation !== "string"
    ) throw new Error("invalid replay result");
    return value as SecondLookResponse;
  } catch {
    throw new IdempotencyLifecycleError("idempotency_state_ambiguous", false);
  }
}

function classifyExisting(row: LifecycleRow, requestHash: string, staleBefore: string): IdempotencyReservation {
  if (row.request_hash !== requestHash) throw new IdempotencyLifecycleError("idempotency_key_conflict", false);
  if (row.state === "completed") return { kind: "replay", requestId: row.request_id, response: parseReplay(row) };
  if (row.state === "ambiguous" || (row.state === "inference_running" && row.updated_at <= staleBefore)) {
    throw new IdempotencyLifecycleError("idempotency_state_ambiguous", false);
  }
  throw new IdempotencyLifecycleError("idempotency_in_progress", true, IDEMPOTENCY_IN_PROGRESS_RETRY_SECONDS);
}

export async function reserveIdempotentRequest(
  env: AppEnv,
  auth: AuthContext,
  idempotencyKey: string,
  requestHash: string,
  executionContext: string,
  now = new Date(),
): Promise<IdempotencyReservation> {
  const namespace = callerKey(auth);
  const keyHash = await sha256Hex(idempotencyKey);
  const requestId = crypto.randomUUID();
  const ownerToken = crypto.randomUUID();
  const expiresAt = Math.floor(now.getTime() / 1000) + IDEMPOTENCY_RETENTION_SECONDS;
  const staleBefore = new Date(now.getTime() - IDEMPOTENCY_RESERVATION_STALE_SECONDS * 1000).toISOString();

  const cutoff = Math.floor(now.getTime() / 1000);
  await preserveRemediationBeforeExpiredLifecycleDeletion(env, cutoff, now);
  await env.DB.prepare(
    `DELETE FROM idempotent_requests WHERE expires_at <= ?
       AND NOT EXISTS (
         SELECT 1 FROM commercial_payment_exposures
         WHERE commercial_payment_exposures.request_id = idempotent_requests.request_id
           AND commercial_payment_exposures.state = 'reserved'
       )`,
  ).bind(cutoff).run();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO idempotent_requests (
      request_id, caller_key, idempotency_key_hash, request_hash, execution_context, state,
      owner_token, created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)`,
  ).bind(requestId, namespace, keyHash, requestHash, executionContext, ownerToken, now.toISOString(), now.toISOString(), expiresAt).run();
  if (inserted.meta.changes === 1) return { kind: "acquired", requestId, ownerToken };

  let row = await env.DB.prepare(
    `SELECT request_id, request_hash, state, response_json, updated_at, owner_token
     FROM idempotent_requests WHERE caller_key = ? AND idempotency_key_hash = ?`,
  ).bind(namespace, keyHash).first<LifecycleRow>();
  if (!row) throw new IdempotencyLifecycleError("idempotency_state_ambiguous", false);
  if (row.request_hash !== requestHash) throw new IdempotencyLifecycleError("idempotency_key_conflict", false);
  if (row.state === "completed") return { kind: "replay", requestId: row.request_id, response: parseReplay(row) };

  if (row.state === "failed_before_inference" || (row.state === "reserved" && row.updated_at <= staleBefore)) {
    const acquired = await env.DB.prepare(
      `UPDATE idempotent_requests SET execution_context = ?, state = 'reserved', owner_token = ?, failure_code = NULL,
        updated_at = ?, expires_at = ?
       WHERE request_id = ? AND request_hash = ? AND (
          state = 'failed_before_inference' OR (state = 'reserved' AND updated_at <= ?)
        )`,
    ).bind(executionContext, ownerToken, now.toISOString(), expiresAt, row.request_id, requestHash, staleBefore).run();
    if (acquired.meta.changes === 1) return { kind: "acquired", requestId: row.request_id, ownerToken };
    row = await env.DB.prepare(
      `SELECT request_id, request_hash, state, response_json, updated_at, owner_token
       FROM idempotent_requests WHERE caller_key = ? AND idempotency_key_hash = ?`,
    ).bind(namespace, keyHash).first<LifecycleRow>();
    if (!row) throw new IdempotencyLifecycleError("idempotency_state_ambiguous", false);
  }
  return classifyExisting(row, requestHash, staleBefore);
}

async function reservePaidIdempotentRequestInternal(
  env: AppEnv,
  auth: Extract<AuthContext, { kind: "paid" }>,
  idempotencyKey: string,
  requestHash: string,
  executionContext: string,
  allowCreate: boolean,
  now = new Date(),
): Promise<IdempotencyReservation | null> {
  const namespace = callerKey(auth);
  const keyHash = await sha256Hex(idempotencyKey);
  const requestId = crypto.randomUUID();
  const ownerToken = crypto.randomUUID();
  const expiresAt = Math.floor(now.getTime() / 1000) + IDEMPOTENCY_RETENTION_SECONDS;
  const staleBefore = new Date(now.getTime() - IDEMPOTENCY_RESERVATION_STALE_SECONDS * 1000).toISOString();

  if (allowCreate) {
    const cutoff = Math.floor(now.getTime() / 1000);
    await preserveRemediationBeforeExpiredLifecycleDeletion(env, cutoff, now);
    await env.DB.prepare(
      `DELETE FROM idempotent_requests WHERE expires_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM commercial_payment_exposures
           WHERE commercial_payment_exposures.request_id = idempotent_requests.request_id
             AND commercial_payment_exposures.state = 'reserved'
         )`,
    ).bind(cutoff).run();
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO idempotent_requests (
        request_id, caller_key, idempotency_key_hash, request_hash, execution_context, state,
        owner_token, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)`,
    ).bind(requestId, namespace, keyHash, requestHash, executionContext, ownerToken, now.toISOString(), now.toISOString(), expiresAt).run();
    if (inserted.meta.changes === 1) return { kind: "acquired", requestId, ownerToken };
  }

  let row = await env.DB.prepare(
    `SELECT request_id, request_hash, state, response_json, updated_at, owner_token
     FROM idempotent_requests WHERE caller_key = ? AND idempotency_key_hash = ?`,
  ).bind(namespace, keyHash).first<LifecycleRow>();
  if (!row) return null;
  if (row.request_hash !== requestHash) throw new IdempotencyLifecycleError("idempotency_key_conflict", false);
  if (row.state === "completed") return { kind: "replay", requestId: row.request_id, response: parseReplay(row) };
  if (row.state === "ambiguous" || (row.state === "inference_running" && row.updated_at <= staleBefore)) {
    throw new IdempotencyLifecycleError("idempotency_state_ambiguous", false);
  }
  if (row.state === "inference_running") throw new PaymentLifecycleError("payment_request_processing", true, IDEMPOTENCY_IN_PROGRESS_RETRY_SECONDS);

  const payment = await env.DB.prepare("SELECT state FROM request_payments WHERE request_id = ?")
    .bind(row.request_id).first<{ state: string }>();
  if (payment?.state === "processing") {
    await repairExistingPaymentState(env, row.request_id, now);
    throw new PaymentLifecycleError("payment_in_progress", true, IDEMPOTENCY_IN_PROGRESS_RETRY_SECONDS);
  }

  const safelyReclaimable =
    row.state === "failed_before_inference" ||
    (row.state === "reserved" && row.owner_token === null) ||
    (row.state === "reserved" && row.updated_at <= staleBefore);
  if (safelyReclaimable) {
    const acquired = await env.DB.prepare(
      `UPDATE idempotent_requests SET execution_context = ?, state = 'reserved', owner_token = ?, failure_code = NULL,
        updated_at = ?, expires_at = ?
       WHERE request_id = ? AND request_hash = ? AND (
         state = 'failed_before_inference' OR
         (state = 'reserved' AND owner_token IS NULL) OR
         (state = 'reserved' AND updated_at <= ?)
       )`,
    ).bind(executionContext, ownerToken, now.toISOString(), expiresAt, row.request_id, requestHash, staleBefore).run();
    if (acquired.meta.changes === 1) return { kind: "acquired", requestId: row.request_id, ownerToken };
    row = await env.DB.prepare(
      `SELECT request_id, request_hash, state, response_json, updated_at, owner_token
       FROM idempotent_requests WHERE caller_key = ? AND idempotency_key_hash = ?`,
    ).bind(namespace, keyHash).first<LifecycleRow>();
    if (!row) throw new IdempotencyLifecycleError("idempotency_state_ambiguous", false);
    if (row.state === "completed") return { kind: "replay", requestId: row.request_id, response: parseReplay(row) };
  }
  throw new IdempotencyLifecycleError("idempotency_in_progress", true, IDEMPOTENCY_IN_PROGRESS_RETRY_SECONDS);
}

export async function reservePaidIdempotentRequest(
  env: AppEnv,
  auth: Extract<AuthContext, { kind: "paid" }>,
  idempotencyKey: string,
  requestHash: string,
  executionContext: string,
  now = new Date(),
): Promise<IdempotencyReservation> {
  const reservation = await reservePaidIdempotentRequestInternal(env, auth, idempotencyKey, requestHash, executionContext, true, now);
  if (!reservation) throw new IdempotencyLifecycleError("idempotency_state_ambiguous", false);
  return reservation;
}

export async function reserveExistingPaidIdempotentRequest(
  env: AppEnv,
  auth: Extract<AuthContext, { kind: "paid" }>,
  idempotencyKey: string,
  requestHash: string,
  executionContext: string,
  now = new Date(),
): Promise<IdempotencyReservation | null> {
  return reservePaidIdempotentRequestInternal(env, auth, idempotencyKey, requestHash, executionContext, false, now);
}

export async function releasePaidReservation(
  env: AppEnv,
  requestId: string,
  ownerToken: string,
  now = new Date(),
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE idempotent_requests SET owner_token = NULL, updated_at = ?
     WHERE request_id = ? AND owner_token = ? AND state = 'reserved'`,
  ).bind(now.toISOString(), requestId, ownerToken).run();
  if (result.meta.changes !== 1) throw new IdempotencyLifecycleError("idempotency_state_ambiguous", false);
}

export async function markInferenceRunning(
  env: AppEnv,
  requestId: string,
  ownerToken: string,
  now = new Date(),
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE idempotent_requests SET state = 'inference_running', inference_started_at = ?, updated_at = ?
     WHERE request_id = ? AND owner_token = ? AND state = 'reserved'`,
  ).bind(now.toISOString(), now.toISOString(), requestId, ownerToken).run();
  if (result.meta.changes !== 1) throw new IdempotencyLifecycleError("idempotency_state_ambiguous", false);
}

export async function markPaidInferenceRunning(
  env: AppEnv,
  requestId: string,
  ownerToken: string,
  ambiguityHonored = false,
  now = new Date(),
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE idempotent_requests SET state = 'inference_running', inference_started_at = ?, updated_at = ?
     WHERE request_id = ? AND owner_token = ? AND state = 'reserved'
       AND EXISTS (
         SELECT 1 FROM request_payments
          WHERE request_payments.request_id = idempotent_requests.request_id AND state = ?
        ) AND EXISTS (
         SELECT 1 FROM paid_execution_admissions
         WHERE paid_execution_admissions.request_id = idempotent_requests.request_id
           AND state = 'accepted' AND owner_token = ? AND lease_kind = 'inference'
            AND lease_expires_at > ?
        ) ${ambiguityHonored ? `AND EXISTS (
          SELECT 1 FROM payment_remediation_cases
          WHERE payment_remediation_cases.request_id = idempotent_requests.request_id
            AND case_kind = 'payment_ambiguity' AND fulfillment_status = 'recovery_available'
        ) AND EXISTS (
          SELECT 1 FROM payment_remediation_events
          WHERE payment_remediation_events.request_id = idempotent_requests.request_id
            AND event_type = 'fulfillment_recovery_available'
            AND reason_code = 'public_mainnet_ambiguity_honored'
        )` : ""}`,
  ).bind(
    now.toISOString(), now.toISOString(), requestId, ownerToken,
    ambiguityHonored ? "ambiguous" : "accepted",
    ownerToken, Math.floor(now.getTime() / 1000),
  ).run();
  if (result.meta.changes !== 1) throw new IdempotencyLifecycleError("idempotency_state_ambiguous", false);
}

export async function markFailedBeforeInference(
  env: AppEnv,
  requestId: string,
  ownerToken: string,
  failureCode: string,
  now = new Date(),
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE idempotent_requests SET state = 'failed_before_inference', failure_code = ?, owner_token = NULL, updated_at = ?
     WHERE request_id = ? AND owner_token = ? AND state = 'reserved'`,
  ).bind(failureCode, now.toISOString(), requestId, ownerToken).run();
  if (result.meta.changes !== 1) throw new IdempotencyLifecycleError("idempotency_state_ambiguous", false);
}

export async function markInferenceAmbiguous(
  env: AppEnv,
  requestId: string,
  ownerToken: string,
  failureCode: string,
  now = new Date(),
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE idempotent_requests SET state = 'ambiguous', failure_code = ?, owner_token = NULL, updated_at = ?
     WHERE request_id = ? AND owner_token = ? AND state = 'inference_running'`,
  ).bind(failureCode, now.toISOString(), requestId, ownerToken).run();
  if (result.meta.changes !== 1) throw new IdempotencyLifecycleError("idempotency_state_ambiguous", false);
}
