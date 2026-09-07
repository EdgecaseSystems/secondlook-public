import { PaymentLifecycleError, ServiceBoundaryError } from "./errors";
import type { AppEnv, AuthContext, ModelUsage } from "./types";

export const MAX_REQUEST_BYTES = 64 * 1024;
export const PROVIDER_TIMEOUT_MS = 30_000;
export const INFERENCE_LEASE_SECONDS = 45;
export const PAID_SETTLEMENT_LEASE_SECONDS = 30;
export const CALLER_BURST_LIMIT = 5;
export const CALLER_BURST_WINDOW_SECONDS = 10;
export const CALLER_MINUTE_LIMIT = 30;
export const CALLER_DAILY_LIMIT = 500;

type ServiceControl = {
  inference_enabled: number;
  global_daily_inference_limit: number;
  global_concurrent_inference_limit: number;
  provider_failure_threshold: number;
  provider_circuit_seconds: number;
  circuit_open_until: number | null;
};

type PublicPaidServiceControl = {
  new_settlement_enabled: number;
  max_daily_ambiguity_fulfillments: number;
  max_unresolved_ambiguity_fulfillments_per_payer: number;
  facilitator_transport_failure_threshold: number;
  consecutive_facilitator_transport_failures: number;
  last_facilitator_transport_failure_code: string | null;
};

export const FACILITATOR_TRANSPORT_FAILURE_CODE = "payment_settlement_outcome_unknown";

export type InferenceLease = { id: string; callerKey: string; day: string };
export type PaidExecutionLease = { requestId: string; ownerToken: string; day: string };

function secondsUntilWindowEnd(now: Date, windowStartSeconds: number, windowSeconds: number): number {
  return Math.max(1, Math.ceil(((windowStartSeconds + windowSeconds) * 1_000 - now.getTime()) / 1_000));
}

function secondsUntilNextUtcDay(now: Date): number {
  const nextDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((nextDay - now.getTime()) / 1_000));
}

export function callerKey(auth: AuthContext): string {
  if (auth.kind === "pilot") return `pilot:${auth.key_id}`;
  if (auth.kind === "paid") return `paid:${auth.key_id}`;
  return "internal";
}

export async function reserveRequestAttempt(env: AppEnv, auth: AuthContext, route: string, now = new Date()): Promise<void> {
  const scope = `${callerKey(auth)}:${route}`;
  const epochSeconds = Math.floor(now.getTime() / 1000);
  const burstWindow = Math.floor(epochSeconds / CALLER_BURST_WINDOW_SECONDS) * CALLER_BURST_WINDOW_SECONDS;
  const minuteWindow = Math.floor(epochSeconds / 60) * 60;
  const dayWindow = now.toISOString().slice(0, 10);
  const result = await env.DB.prepare(
    `INSERT INTO api_caller_usage (
      caller_key, burst_window_start, burst_count, minute_window_start, minute_count,
      day_window_start, day_count, last_request_at
    ) VALUES (?, ?, 1, ?, 1, ?, 1, ?)
    ON CONFLICT(caller_key) DO UPDATE SET
      burst_window_start = excluded.burst_window_start,
      burst_count = CASE WHEN api_caller_usage.burst_window_start = excluded.burst_window_start THEN api_caller_usage.burst_count + 1 ELSE 1 END,
      minute_window_start = excluded.minute_window_start,
      minute_count = CASE WHEN api_caller_usage.minute_window_start = excluded.minute_window_start THEN api_caller_usage.minute_count + 1 ELSE 1 END,
      day_window_start = excluded.day_window_start,
      day_count = CASE WHEN api_caller_usage.day_window_start = excluded.day_window_start THEN api_caller_usage.day_count + 1 ELSE 1 END,
      last_request_at = excluded.last_request_at
    WHERE (api_caller_usage.burst_window_start <> excluded.burst_window_start OR api_caller_usage.burst_count < ?)
      AND (api_caller_usage.minute_window_start <> excluded.minute_window_start OR api_caller_usage.minute_count < ?)
      AND (api_caller_usage.day_window_start <> excluded.day_window_start OR api_caller_usage.day_count < ?)`,
  ).bind(scope, burstWindow, minuteWindow, dayWindow, now.toISOString(), CALLER_BURST_LIMIT, CALLER_MINUTE_LIMIT, CALLER_DAILY_LIMIT).run();

  if (result.meta.changes === 1) return;
  const current = await env.DB.prepare(
    "SELECT burst_window_start, burst_count, minute_window_start, minute_count, day_window_start, day_count FROM api_caller_usage WHERE caller_key = ?",
  ).bind(scope).first<{
    burst_window_start: number;
    burst_count: number;
    minute_window_start: number;
    minute_count: number;
    day_window_start: string;
    day_count: number;
  }>();
  if (current?.day_window_start === dayWindow && current.day_count >= CALLER_DAILY_LIMIT) {
    throw new ServiceBoundaryError("daily_request_limit_reached", "The caller daily request limit has been reached.", 429, true, secondsUntilNextUtcDay(now));
  }
  if (current?.minute_window_start === minuteWindow && current.minute_count >= CALLER_MINUTE_LIMIT) {
    throw new ServiceBoundaryError("rate_limit_reached", "The caller request rate limit has been reached.", 429, true, secondsUntilWindowEnd(now, minuteWindow, 60));
  }
  throw new ServiceBoundaryError("rate_limit_reached", "The caller request rate limit has been reached.", 429, true, secondsUntilWindowEnd(now, burstWindow, CALLER_BURST_WINDOW_SECONDS));
}

async function readServiceControl(env: AppEnv, now = new Date()): Promise<ServiceControl> {
  const control = await env.DB.prepare(
    `SELECT inference_enabled, global_daily_inference_limit, global_concurrent_inference_limit,
      provider_failure_threshold, provider_circuit_seconds, circuit_open_until
    FROM api_service_control WHERE singleton_id = 1`,
  ).first<ServiceControl>();
  if (!control || control.inference_enabled !== 1) {
    throw new ServiceBoundaryError("service_disabled", "Inference is temporarily unavailable.", 503, true, 60);
  }
  const epochSeconds = Math.floor(now.getTime() / 1000);
  if (control.circuit_open_until !== null && control.circuit_open_until > epochSeconds) {
    throw new ServiceBoundaryError("service_disabled", "The model provider circuit is temporarily open.", 503, true, Math.max(1, control.circuit_open_until - epochSeconds));
  }
  return control;
}

async function readPublicPaidServiceControl(env: AppEnv): Promise<PublicPaidServiceControl> {
  const control = await env.DB.prepare(
    `SELECT new_settlement_enabled, max_daily_ambiguity_fulfillments,
      max_unresolved_ambiguity_fulfillments_per_payer,
      facilitator_transport_failure_threshold, consecutive_facilitator_transport_failures,
      last_facilitator_transport_failure_code
     FROM public_paid_service_control WHERE singleton_id = 1`,
  ).first<PublicPaidServiceControl>();
  if (!control) throw new ServiceBoundaryError("service_disabled", "New paid settlements are temporarily unavailable.", 503, true, 60);
  return control;
}

export async function publicPaidNewSettlementsEnabled(env: AppEnv): Promise<boolean> {
  try { return (await readPublicPaidServiceControl(env)).new_settlement_enabled === 1; }
  catch { return false; }
}

export async function assertPublicPaidNewSettlementsEnabled(env: AppEnv): Promise<void> {
  if ((await readPublicPaidServiceControl(env)).new_settlement_enabled !== 1) {
    throw new ServiceBoundaryError("service_disabled", "New paid settlements are temporarily unavailable.", 503, true, 60);
  }
}

export async function recordPublicFacilitatorTransportResult(
  env: AppEnv,
  failureCode: string | null,
  now = new Date(),
): Promise<void> {
  const timestamp = now.toISOString();
  if (failureCode !== FACILITATOR_TRANSPORT_FAILURE_CODE) {
    await env.DB.prepare(
      `UPDATE public_paid_service_control
       SET consecutive_facilitator_transport_failures = 0,
         last_facilitator_transport_failure_code = NULL, updated_at = ?
       WHERE singleton_id = 1`,
    ).bind(timestamp).run();
    return;
  }
  const updated = await env.DB.prepare(
    `UPDATE public_paid_service_control
     SET consecutive_facilitator_transport_failures = CASE
           WHEN last_facilitator_transport_failure_code = ?
             THEN consecutive_facilitator_transport_failures + 1
           ELSE 1
         END,
       last_facilitator_transport_failure_code = ?,
       new_settlement_enabled = CASE
         WHEN (CASE
           WHEN last_facilitator_transport_failure_code = ?
             THEN consecutive_facilitator_transport_failures + 1
           ELSE 1
         END) >= facilitator_transport_failure_threshold THEN 0
         ELSE new_settlement_enabled
       END,
       disabled_at = CASE
         WHEN new_settlement_enabled = 1 AND (CASE
           WHEN last_facilitator_transport_failure_code = ?
             THEN consecutive_facilitator_transport_failures + 1
           ELSE 1
         END) >= facilitator_transport_failure_threshold THEN ?
         ELSE disabled_at
       END,
       updated_at = ?
     WHERE singleton_id = 1`,
  ).bind(
    failureCode, failureCode, failureCode, failureCode, timestamp, timestamp,
  ).run();
  if (updated.meta.changes !== 1) {
    throw new ServiceBoundaryError("service_disabled", "The public payment safety control is unavailable.", 503, true, 60);
  }
}

export async function acquireInferenceLease(env: AppEnv, auth: AuthContext, now = new Date()): Promise<InferenceLease> {
  const control = await readServiceControl(env, now);
  const epochSeconds = Math.floor(now.getTime() / 1000);
  const caller = callerKey(auth);
  const lease: InferenceLease = { id: crypto.randomUUID(), callerKey: caller, day: now.toISOString().slice(0, 10) };
  await env.DB.prepare("DELETE FROM api_inference_leases WHERE expires_at <= ?").bind(epochSeconds).run();
  const acquired = await env.DB.prepare(
    `INSERT OR IGNORE INTO api_inference_leases (lease_id, caller_key, created_at, expires_at)
     SELECT ?, ?, ?, ?
     WHERE (
       (SELECT COUNT(*) FROM api_inference_leases WHERE expires_at > ?) +
       (SELECT COUNT(*) FROM paid_execution_admissions
        WHERE lease_expires_at > ? AND (
          (lease_kind = 'settlement' AND state IN ('reserved', 'settling')) OR
          (lease_kind = 'inference' AND state IN ('accepted', 'consumed'))
        ))
     ) < ?`,
  ).bind(lease.id, caller, now.toISOString(), epochSeconds + INFERENCE_LEASE_SECONDS, epochSeconds, epochSeconds, control.global_concurrent_inference_limit).run();
  if (acquired.meta.changes !== 1) {
    throw new ServiceBoundaryError("inference_capacity_reached", "Inference capacity is temporarily full.", 429, true, 5);
  }

  const daily = await env.DB.prepare(
    `INSERT INTO api_global_usage (day, inference_count, updated_at)
     SELECT ?, 1, ?
     WHERE (
       SELECT COUNT(*) FROM paid_execution_admissions
       WHERE capacity_day = ? AND (
         (state = 'reserved' AND lease_expires_at > ?) OR
         state IN ('settling', 'accepted', 'ambiguous', 'consumed')
       )
     ) < ?
     ON CONFLICT(day) DO UPDATE SET inference_count = api_global_usage.inference_count + 1, updated_at = excluded.updated_at
     WHERE api_global_usage.inference_count + (
       SELECT COUNT(*) FROM paid_execution_admissions
       WHERE capacity_day = excluded.day AND (
         (state = 'reserved' AND lease_expires_at > ?) OR
         state IN ('settling', 'accepted', 'ambiguous', 'consumed')
       )
     ) < ?`,
  ).bind(
    lease.day, now.toISOString(), lease.day, epochSeconds, control.global_daily_inference_limit,
    epochSeconds, control.global_daily_inference_limit,
  ).run();
  if (daily.meta.changes === 1) return lease;
  await releaseInferenceLease(env, lease);
  throw new ServiceBoundaryError("daily_inference_limit_reached", "The service daily inference limit has been reached.", 503, true, secondsUntilNextUtcDay(now));
}

function paidDailyCountSql(alias: string): string {
  return `(SELECT COUNT(*) FROM paid_execution_admissions ${alias}
    WHERE ${alias}.capacity_day = ? AND (
      (${alias}.state = 'reserved' AND ${alias}.lease_expires_at > ?) OR
      ${alias}.state IN ('settling', 'accepted', 'ambiguous', 'consumed')
    ))`;
}

function combinedConcurrencySql(alias: string): string {
  return `(
    (SELECT COUNT(*) FROM api_inference_leases WHERE expires_at > ?) +
    (SELECT COUNT(*) FROM paid_execution_admissions ${alias}
     WHERE ${alias}.lease_expires_at > ? AND (
       (${alias}.lease_kind = 'settlement' AND ${alias}.state IN ('reserved', 'settling')) OR
       (${alias}.lease_kind = 'inference' AND ${alias}.state IN ('accepted', 'consumed'))
     ))
  )`;
}

function outstandingPaidObligationsSql(alias: string): string {
  return `(SELECT COUNT(*) FROM paid_execution_admissions ${alias}
    WHERE ${alias}.request_id <> ? AND (
      (${alias}.state = 'reserved' AND ${alias}.lease_kind = 'settlement' AND ${alias}.lease_expires_at > ?) OR
      ${alias}.state IN ('settling', 'accepted', 'ambiguous') OR
      (${alias}.state = 'consumed' AND EXISTS (
        SELECT 1 FROM idempotent_requests outstanding_lifecycle
        WHERE outstanding_lifecycle.request_id = ${alias}.request_id
          AND outstanding_lifecycle.state <> 'completed'
      ))
    ))`;
}

export async function assertPaidSettlementAvailability(
  env: AppEnv,
  maxOutstandingPaidObligations?: number,
  now = new Date(),
): Promise<void> {
  const control = await readServiceControl(env, now);
  if (maxOutstandingPaidObligations !== undefined) await assertPublicPaidNewSettlementsEnabled(env);
  const epochSeconds = Math.floor(now.getTime() / 1000);
  const day = now.toISOString().slice(0, 10);
  const availability = await env.DB.prepare(
    `SELECT
      COALESCE((SELECT inference_count FROM api_global_usage WHERE day = ?), 0) +
        ${paidDailyCountSql("paid_daily")} AS daily_used,
      ${combinedConcurrencySql("paid_concurrent")} AS concurrent_used,
      ${outstandingPaidObligationsSql("outstanding")} AS outstanding_used`,
  ).bind(
    day, day, epochSeconds,
    epochSeconds, epochSeconds,
    "", epochSeconds,
  ).first<{ daily_used: number; concurrent_used: number; outstanding_used: number }>();
  if ((availability?.daily_used ?? 0) >= control.global_daily_inference_limit) {
    throw new ServiceBoundaryError("daily_inference_limit_reached", "The service daily inference limit has been reached.", 503, true, secondsUntilNextUtcDay(now));
  }
  if ((availability?.concurrent_used ?? 0) >= control.global_concurrent_inference_limit) {
    throw new ServiceBoundaryError("inference_capacity_reached", "Inference capacity is temporarily full.", 429, true, 5);
  }
  if (maxOutstandingPaidObligations !== undefined && (availability?.outstanding_used ?? 0) >= maxOutstandingPaidObligations) {
    throw new ServiceBoundaryError("financial_capacity_reached", "The paid service outstanding-obligation limit has been reached.", 503, true, 5);
  }
  if (maxOutstandingPaidObligations === undefined) {
    const accepted = await env.DB.prepare(
      `SELECT 1 AS blocked FROM request_payments payment
       JOIN idempotent_requests lifecycle ON lifecycle.request_id = payment.request_id
       WHERE payment.state = 'accepted' AND lifecycle.state <> 'completed' LIMIT 1`,
    ).first<{ blocked: number }>();
    if (accepted) throw new PaymentLifecycleError("payment_request_processing", true, 5);
  }
}

export async function reservePaidSettlementAdmission(
  env: AppEnv,
  requestId: string,
  lifecycleOwnerToken: string,
  now = new Date(),
  maxOutstandingPaidObligations?: number,
): Promise<PaidExecutionLease> {
  const control = await readServiceControl(env, now);
  if (maxOutstandingPaidObligations !== undefined) await assertPublicPaidNewSettlementsEnabled(env);
  const epochSeconds = Math.floor(now.getTime() / 1000);
  const day = now.toISOString().slice(0, 10);
  const ownerToken = crypto.randomUUID();
  const timestamp = now.toISOString();
  if (maxOutstandingPaidObligations === undefined) {
    const blockedAccepted = await env.DB.prepare(
      `SELECT payment.request_id FROM request_payments payment
       JOIN idempotent_requests lifecycle ON lifecycle.request_id = payment.request_id
       WHERE payment.state = 'accepted' AND lifecycle.state <> 'completed'
         AND payment.request_id <> ? LIMIT 1`,
    ).bind(requestId).first<{ request_id: string }>();
    if (blockedAccepted) throw new PaymentLifecycleError("payment_request_processing", true, 5);
  }

  const insertSql = `INSERT OR IGNORE INTO paid_execution_admissions (
      request_id, state, admission_day, capacity_day, owner_token, lease_kind,
      lease_expires_at, settlement_authorized_at, created_at, updated_at
    ) SELECT ?, 'reserved', ?, ?, ?, 'settlement', ?, NULL, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM idempotent_requests
        WHERE request_id = ? AND owner_token = ? AND state = 'reserved'
      )
      AND COALESCE((SELECT inference_count FROM api_global_usage WHERE day = ?), 0) +
        ${paidDailyCountSql("paid_daily")} < ?
      AND ${combinedConcurrencySql("paid_concurrent")} < ?
      AND (? IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM request_payments blocked_accepted
        JOIN idempotent_requests blocked_lifecycle ON blocked_lifecycle.request_id = blocked_accepted.request_id
        WHERE blocked_accepted.state = 'accepted' AND blocked_lifecycle.state <> 'completed'
          AND blocked_accepted.request_id <> ?
      ))
      AND (? IS NULL OR ${outstandingPaidObligationsSql("outstanding")} < ?)`;
  const inserted = await env.DB.prepare(insertSql).bind(
    requestId, day, day, ownerToken, epochSeconds + PAID_SETTLEMENT_LEASE_SECONDS, timestamp, timestamp,
    requestId, lifecycleOwnerToken,
    day, day, epochSeconds, control.global_daily_inference_limit,
    epochSeconds, epochSeconds, control.global_concurrent_inference_limit,
    maxOutstandingPaidObligations ?? null, requestId,
    maxOutstandingPaidObligations ?? null, requestId, epochSeconds, maxOutstandingPaidObligations ?? 1,
  ).run();
  if (inserted.meta.changes === 1) return { requestId, ownerToken, day };

  const recycled = await env.DB.prepare(
    `UPDATE paid_execution_admissions SET state = 'reserved', admission_day = ?, capacity_day = ?,
      owner_token = ?, lease_kind = 'settlement', lease_expires_at = ?, settlement_authorized_at = NULL,
      updated_at = ?
     WHERE request_id = ? AND state = 'released'
       AND EXISTS (SELECT 1 FROM idempotent_requests WHERE request_id = ? AND owner_token = ? AND state = 'reserved')
       AND COALESCE((SELECT inference_count FROM api_global_usage WHERE day = ?), 0) +
         ${paidDailyCountSql("paid_daily")} < ?
       AND ${combinedConcurrencySql("paid_concurrent")} < ?
       AND (? IS NOT NULL OR NOT EXISTS (
         SELECT 1 FROM request_payments blocked_accepted
         JOIN idempotent_requests blocked_lifecycle ON blocked_lifecycle.request_id = blocked_accepted.request_id
         WHERE blocked_accepted.state = 'accepted' AND blocked_lifecycle.state <> 'completed'
           AND blocked_accepted.request_id <> ?
       ))
       AND (? IS NULL OR ${outstandingPaidObligationsSql("outstanding")} < ?)`,
  ).bind(
    day, day, ownerToken, epochSeconds + PAID_SETTLEMENT_LEASE_SECONDS, timestamp, requestId,
    requestId, lifecycleOwnerToken,
    day, day, epochSeconds, control.global_daily_inference_limit,
    epochSeconds, epochSeconds, control.global_concurrent_inference_limit,
    maxOutstandingPaidObligations ?? null, requestId,
    maxOutstandingPaidObligations ?? null, requestId, epochSeconds, maxOutstandingPaidObligations ?? 1,
  ).run();
  if (recycled.meta.changes === 1) return { requestId, ownerToken, day };

  const existing = await env.DB.prepare(
    "SELECT state, lease_expires_at FROM paid_execution_admissions WHERE request_id = ?",
  ).bind(requestId).first<{ state: string; lease_expires_at: number | null }>();
  if (existing && existing.state !== "released") {
    if (existing.state === "ambiguous") throw new PaymentLifecycleError("payment_ambiguous", false);
    throw new PaymentLifecycleError("payment_in_progress", true, 5);
  }
  const dailyUsage = await env.DB.prepare(
    `SELECT COALESCE((SELECT inference_count FROM api_global_usage WHERE day = ?), 0) +
      ${paidDailyCountSql("paid_daily")} AS used`,
  ).bind(day, day, epochSeconds).first<{ used: number }>();
  if ((dailyUsage?.used ?? 0) >= control.global_daily_inference_limit) {
    throw new ServiceBoundaryError("daily_inference_limit_reached", "The service daily inference limit has been reached.", 503, true, secondsUntilNextUtcDay(now));
  }
  if (maxOutstandingPaidObligations !== undefined) {
    const outstanding = await env.DB.prepare(
      `SELECT ${outstandingPaidObligationsSql("outstanding")} AS used`,
    ).bind(requestId, epochSeconds).first<{ used: number }>();
    if ((outstanding?.used ?? 0) >= maxOutstandingPaidObligations) {
      throw new ServiceBoundaryError("financial_capacity_reached", "The paid service outstanding-obligation limit has been reached.", 503, true, 5);
    }
  }
  throw new ServiceBoundaryError("inference_capacity_reached", "Inference capacity is temporarily full.", 429, true, 5);
}

export async function releasePaidSettlementAdmission(
  env: AppEnv,
  lease: PaidExecutionLease,
  now = new Date(),
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE paid_execution_admissions SET state = 'released', owner_token = NULL,
      lease_kind = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE request_id = ? AND state = 'reserved' AND owner_token = ?`,
  ).bind(now.toISOString(), lease.requestId, lease.ownerToken).run();
  if (result.meta.changes !== 1) throw new PaymentLifecycleError("payment_state_conflict", false);
}

export async function acquirePaidInferenceLease(
  env: AppEnv,
  requestId: string,
  lifecycleOwnerToken: string,
  ambiguityHonored = false,
  now = new Date(),
): Promise<PaidExecutionLease> {
  const control = await readServiceControl(env, now);
  const epochSeconds = Math.floor(now.getTime() / 1000);
  const timestamp = now.toISOString();
  const paymentState = ambiguityHonored ? "ambiguous" : "accepted";
  const admissionState = ambiguityHonored ? "ambiguous" : "settling";
  const exposureState = ambiguityHonored ? "ambiguous" : "accepted";
  const remediationGuard = ambiguityHonored
    ? `AND EXISTS (SELECT 1 FROM payment_remediation_cases WHERE request_id = ?
         AND case_kind = 'payment_ambiguity' AND fulfillment_status = 'recovery_available')
       AND EXISTS (SELECT 1 FROM payment_remediation_events WHERE request_id = ?
         AND event_type = 'fulfillment_recovery_available'
         AND reason_code = 'public_mainnet_ambiguity_honored')`
    : "";
  await env.DB.prepare(
    `UPDATE paid_execution_admissions SET state = 'accepted',
      owner_token = CASE WHEN lease_expires_at > ? THEN ? ELSE NULL END,
      lease_kind = CASE WHEN lease_expires_at > ? THEN 'inference' ELSE NULL END,
      lease_expires_at = CASE WHEN lease_expires_at > ? THEN ? ELSE NULL END,
      updated_at = ?
     WHERE request_id = ? AND state = ?
       AND EXISTS (SELECT 1 FROM request_payments WHERE request_id = ? AND state = ?)
       AND (
         NOT EXISTS (SELECT 1 FROM commercial_payment_exposures WHERE request_id = ?)
         OR EXISTS (SELECT 1 FROM commercial_payment_exposures WHERE request_id = ? AND state = ?)
       ) ${remediationGuard}`,
  ).bind(
    epochSeconds, lifecycleOwnerToken, epochSeconds, epochSeconds,
    epochSeconds + INFERENCE_LEASE_SECONDS, timestamp, requestId, admissionState,
    requestId, paymentState, requestId, requestId, exposureState,
    ...(ambiguityHonored ? [requestId, requestId] : []),
  ).run();
  await env.DB.prepare(
    `UPDATE paid_execution_admissions SET state = 'released', owner_token = NULL,
      lease_kind = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE request_id = ? AND state = 'settling'
       AND EXISTS (SELECT 1 FROM request_payments WHERE request_id = ? AND state = 'failed')`,
  ).bind(timestamp, requestId, requestId).run();
  await env.DB.prepare(
    `UPDATE paid_execution_admissions SET state = 'ambiguous', owner_token = NULL,
      lease_kind = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE request_id = ? AND state = 'settling'
       AND EXISTS (SELECT 1 FROM request_payments WHERE request_id = ? AND state = 'ambiguous')`,
  ).bind(timestamp, requestId, requestId).run();
  const existing = await env.DB.prepare(
    `SELECT owner_token, lease_kind, lease_expires_at, capacity_day FROM paid_execution_admissions
     WHERE request_id = ? AND state = 'accepted'`,
  ).bind(requestId).first<{ owner_token: string | null; lease_kind: string | null; lease_expires_at: number | null; capacity_day: string }>();
  if (existing?.owner_token === lifecycleOwnerToken && existing.lease_kind === "inference" && (existing.lease_expires_at ?? 0) > epochSeconds) {
    return { requestId, ownerToken: lifecycleOwnerToken, day: existing.capacity_day };
  }

  const updated = await env.DB.prepare(
    `UPDATE paid_execution_admissions SET owner_token = ?, lease_kind = 'inference',
      lease_expires_at = ?, updated_at = ?
     WHERE request_id = ? AND state = 'accepted'
       AND EXISTS (SELECT 1 FROM request_payments WHERE request_id = ? AND state = ?)
       AND (
         NOT EXISTS (SELECT 1 FROM commercial_payment_exposures WHERE request_id = ?)
         OR EXISTS (SELECT 1 FROM commercial_payment_exposures WHERE request_id = ? AND state = ?)
       )
       ${remediationGuard}
       AND EXISTS (SELECT 1 FROM idempotent_requests WHERE request_id = ? AND owner_token = ? AND state IN ('reserved', 'failed_before_inference'))
       AND (
         (SELECT COUNT(*) FROM api_inference_leases WHERE expires_at > ?) +
         (SELECT COUNT(*) FROM paid_execution_admissions paid_concurrent
          WHERE paid_concurrent.request_id <> ? AND paid_concurrent.lease_expires_at > ? AND (
            (paid_concurrent.lease_kind = 'settlement' AND paid_concurrent.state IN ('reserved', 'settling')) OR
            (paid_concurrent.lease_kind = 'inference' AND paid_concurrent.state IN ('accepted', 'consumed'))
          ))
       ) < ?`,
  ).bind(
    lifecycleOwnerToken, epochSeconds + INFERENCE_LEASE_SECONDS, timestamp, requestId,
    requestId, paymentState, requestId, requestId, exposureState,
    ...(ambiguityHonored ? [requestId, requestId] : []), requestId, lifecycleOwnerToken,
    epochSeconds, requestId, epochSeconds, control.global_concurrent_inference_limit,
  ).run();
  if (updated.meta.changes !== 1) {
    throw new ServiceBoundaryError("inference_capacity_reached", "Inference capacity is temporarily full.", 429, true, 5);
  }
  const capacity = await env.DB.prepare(
    "SELECT capacity_day FROM paid_execution_admissions WHERE request_id = ?",
  ).bind(requestId).first<{ capacity_day: string }>();
  if (!capacity) throw new PaymentLifecycleError("payment_state_conflict", false);
  return { requestId, ownerToken: lifecycleOwnerToken, day: capacity.capacity_day };
}

export async function markPaidAdmissionConsumed(
  env: AppEnv,
  lease: PaidExecutionLease,
  ambiguityHonored = false,
  now = new Date(),
): Promise<void> {
  const epochSeconds = Math.floor(now.getTime() / 1000);
  const result = await env.DB.prepare(
    `UPDATE paid_execution_admissions SET state = 'consumed', updated_at = ?
     WHERE request_id = ? AND state = 'accepted' AND owner_token = ?
       AND lease_kind = 'inference' AND lease_expires_at > ?
       AND (
         NOT EXISTS (SELECT 1 FROM commercial_payment_exposures WHERE request_id = ?)
          OR EXISTS (SELECT 1 FROM commercial_payment_exposures WHERE request_id = ? AND state = ?)
        )
       AND EXISTS (SELECT 1 FROM request_payments WHERE request_id = ? AND state = ?)
       ${ambiguityHonored ? `AND EXISTS (SELECT 1 FROM payment_remediation_cases WHERE request_id = ?
         AND case_kind = 'payment_ambiguity' AND fulfillment_status = 'recovery_available')
       AND EXISTS (SELECT 1 FROM payment_remediation_events WHERE request_id = ?
         AND event_type = 'fulfillment_recovery_available'
         AND reason_code = 'public_mainnet_ambiguity_honored')` : ""}
       AND EXISTS (SELECT 1 FROM idempotent_requests WHERE request_id = ? AND state = 'inference_running')`,
  ).bind(
    now.toISOString(), lease.requestId, lease.ownerToken, epochSeconds,
    lease.requestId, lease.requestId, ambiguityHonored ? "ambiguous" : "accepted",
    lease.requestId, ambiguityHonored ? "ambiguous" : "accepted",
    ...(ambiguityHonored ? [lease.requestId, lease.requestId] : []), lease.requestId,
  ).run();
  if (result.meta.changes !== 1) throw new PaymentLifecycleError("payment_state_conflict", false);
}

export async function releasePaidInferenceLease(env: AppEnv, lease: PaidExecutionLease, now = new Date()): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE paid_execution_admissions SET owner_token = NULL, lease_kind = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE request_id = ? AND state IN ('accepted', 'consumed') AND owner_token = ? AND lease_kind = 'inference'`,
  ).bind(now.toISOString(), lease.requestId, lease.ownerToken).run();
  if (result.meta.changes !== 1) throw new PaymentLifecycleError("payment_state_conflict", false);
}

export async function releaseInferenceLease(env: AppEnv, lease: InferenceLease): Promise<void> {
  await env.DB.prepare("DELETE FROM api_inference_leases WHERE lease_id = ? AND caller_key = ?").bind(lease.id, lease.callerKey).run();
}

export async function recordProviderSuccess(env: AppEnv): Promise<void> {
  await env.DB.prepare(
    "UPDATE api_service_control SET consecutive_provider_failures = 0, circuit_open_until = NULL, updated_at = ? WHERE singleton_id = 1",
  ).bind(new Date().toISOString()).run();
}

export async function recordProviderFailure(env: AppEnv, now = new Date()): Promise<void> {
  const epochSeconds = Math.floor(now.getTime() / 1000);
  await env.DB.prepare(
    `UPDATE api_service_control SET
      consecutive_provider_failures = consecutive_provider_failures + 1,
      circuit_open_until = CASE
        WHEN consecutive_provider_failures + 1 >= provider_failure_threshold THEN ? + provider_circuit_seconds
        ELSE circuit_open_until
      END,
      updated_at = ?
    WHERE singleton_id = 1`,
  ).bind(epochSeconds, now.toISOString()).run();
}

const MODEL_PRICING_PER_MILLION: Record<string, { input: number; output: number }> = {
  "@cf/google/gemma-4-26b-a4b-it": { input: 0.10, output: 0.30 },
};

export function estimatedInferenceCostMicroUsd(model: string, usage: ModelUsage): number | undefined {
  const pricing = MODEL_PRICING_PER_MILLION[model];
  if (!pricing || usage.input_tokens === undefined || usage.output_tokens === undefined) return undefined;
  return Math.round(usage.input_tokens * pricing.input + usage.output_tokens * pricing.output);
}

const WORKERS_AI_NEURONS_PER_MILLION: Record<string, { input: number; output: number }> = {
  "@cf/google/gemma-4-26b-a4b-it": { input: 9_091, output: 27_273 },
};

export function estimatedWorkersAiNeurons(model: string, usage: ModelUsage): number | undefined {
  const rates = WORKERS_AI_NEURONS_PER_MILLION[model];
  if (!rates || usage.input_tokens === undefined || usage.output_tokens === undefined) return undefined;
  return Math.round((usage.input_tokens * rates.input + usage.output_tokens * rates.output) / 1_000_000);
}
