import { publicBuyerGuide } from "./buyer-guide";
import { ClientInputError, CommercialEligibilityError, IdempotencyLifecycleError, ModelResponseError, PaymentLifecycleError, PilotUsageLimitError, ProviderFailureError, ServiceBoundaryError } from "./errors";
import { assertCommercialPaymentCapacity, createCommercialPaymentContext, synchronizeCommercialAccountingFromPayment } from "./commercial-accounting";
import { authenticate, reservePilotReviewAttempt } from "./auth";
import { getSecondLook, POLICY_VERSION, toLegacyRecommendation } from "./judgment";
import {
  fingerprintSecondLookRequest,
  IDEMPOTENCY_IN_PROGRESS_RETRY_SECONDS,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_RETENTION_SECONDS,
  markFailedBeforeInference,
  markInferenceAmbiguous,
  markInferenceRunning,
  markPaidInferenceRunning,
  paidIdempotentRequestExists,
  paidRateLimitContext,
  readIdempotencyKey,
  readExistingPaidIdempotencyCandidate,
  readPaidIdempotency,
  releasePaidReservation,
  reserveIdempotentRequest,
  reserveExistingPaidIdempotentRequest,
  reservePaidIdempotentRequest,
} from "./idempotency";
import {
  acquireInferenceLease,
  acquirePaidInferenceLease,
  assertPaidSettlementAvailability,
  CALLER_BURST_LIMIT,
  CALLER_BURST_WINDOW_SECONDS,
  CALLER_DAILY_LIMIT,
  CALLER_MINUTE_LIMIT,
  callerKey,
  estimatedInferenceCostMicroUsd,
  estimatedWorkersAiNeurons,
  MAX_REQUEST_BYTES,
  PROVIDER_TIMEOUT_MS,
  publicPaidNewSettlementsEnabled,
  recordProviderFailure,
  recordProviderSuccess,
  releaseInferenceLease,
  releasePaidInferenceLease,
  markPaidAdmissionConsumed,
  reserveRequestAttempt,
} from "./operations";
import { saveDecision, saveDecisionAndCompleteIdempotentRequest, saveOutcome } from "./store";
import {
  authorizePublicMainnetAmbiguityFulfillment,
  ensurePaidFulfillmentCase,
  ensurePaymentAmbiguityCase,
  isCompletedPublicMainnetAmbiguityFulfillment,
  markPublicMainnetAmbiguityInferenceUncertain,
  synchronizeCompletedFulfillment,
} from "./remediation";
import {
  attemptPaymentAcceptance,
  cleanupAbandonedCommercialReservations,
  createPaymentRequirement,
  getPaymentSnapshot,
  type PaymentProviderAdapter,
} from "./payments";
import type { AppEnv, AuthContext, SecondLookRequest, SecondLookResponse } from "./types";
import { parseOutcomeRequest, parseSecondLookRequest } from "./validation";
import { PUBLIC_AGENT_DESCRIPTION, publicCommercialEligibleRegions, readPublicCommercialJurisdiction, readPublicSupportUrl, renderPublicPrivacy, renderPublicTerms, SERVICE_USE_COUNTRY_HEADER, SERVICE_USE_REGION_HEADER } from "./public-mainnet";
import { PUBLIC_MANIFEST_PATH, PUBLIC_OPENAPI_PATH, publicOpenApiDocument, publicServiceIndex } from "./public-api";
import {
  encodeX402PaymentRequired,
  encodeX402SettlementResponse,
  fingerprintX402PaymentPayload,
  makeX402PaymentRequired,
  parseX402PaymentPayload,
  readX402Configuration,
  settlementResponseFromPayment,
  X402FacilitatorAdapter,
  X402_PAYMENT_REQUIRED_HEADER,
  X402_PAYMENT_RESPONSE_HEADER,
  X402_PAYMENT_SIGNATURE_HEADER,
  type X402Configuration,
  type X402PaymentPayload,
} from "./x402";

const PROVIDER_ERROR_STRING_LIMIT = 256;

function readProviderErrorScalar(error: unknown, fields: readonly string[]): string | number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const source = error as Record<string, unknown>;

  for (const field of fields) {
    try {
      const value = source[field];
      if (typeof value === "string") return value.slice(0, PROVIDER_ERROR_STRING_LIMIT);
      if (typeof value === "number" && Number.isFinite(value)) return value;
    } catch {
      // An accessor is not required provider metadata; preserve the generic failure path.
    }
  }

  return undefined;
}

function readProviderErrorNumber(error: unknown, fields: readonly string[]): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const source = error as Record<string, unknown>;

  for (const field of fields) {
    try {
      const value = source[field];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    } catch {
      // An accessor is not required provider metadata; preserve the generic failure path.
    }
  }

  return undefined;
}

function readProviderMessageDiagnostic(error: unknown): {
  providerErrorCode?: number;
  providerInternalReference?: string;
} {
  if (!(error instanceof Error)) return {};

  try {
    const message = error.message;
    if (typeof message !== "string") return {};

    const code = /^(?:AiError:\s*|Error:\s*)?(\d{4}):/.exec(message);
    if (code) return { providerErrorCode: Number(code[1]) };

    const reference = /^(?:Error:\s*)?internal error; reference = ([A-Za-z0-9]{1,64})$/.exec(message);
    if (reference) return { providerInternalReference: reference[1] };
  } catch {
    // Message diagnostics are optional; preserve the generic failure path.
  }

  return {};
}

function unexpectedErrorLog(path: string, requestId: string, error: unknown): Record<string, string | number> {
  const errorType = error instanceof Error ? readProviderErrorScalar(error, ["name"]) : undefined;
  const messageDiagnostic = readProviderMessageDiagnostic(error);
  const providerErrorCode =
    readProviderErrorScalar(error, ["internalCode", "internal_code"]) ??
    readProviderErrorNumber(error, ["code"]) ??
    messageDiagnostic.providerErrorCode;
  const providerHttpCode =
    readProviderErrorScalar(error, ["httpCode", "http_code"]) ??
    readProviderErrorNumber(error, ["status", "statusCode", "status_code"]);
  const providerDescription = readProviderErrorScalar(error, ["description"]);
  const providerRequestId = readProviderErrorScalar(error, ["requestId", "request_id"]);

  return {
    path,
    request_id: requestId,
    error_type: typeof errorType === "string" ? errorType : error instanceof Error ? "Error" : "UnknownError",
    ...(providerErrorCode === undefined ? {} : { provider_error_code: providerErrorCode }),
    ...(providerHttpCode === undefined ? {} : { provider_http_code: providerHttpCode }),
    ...(providerDescription === undefined ? {} : { provider_description: providerDescription }),
    ...(providerRequestId === undefined ? {} : { provider_request_id: providerRequestId }),
    ...(messageDiagnostic.providerInternalReference === undefined
      ? {}
      : { provider_internal_reference: messageDiagnostic.providerInternalReference }),
  };
}

function json(
  data: unknown,
  status = 200,
  requestId?: string,
  retryAfterSeconds?: number,
  additionalHeaders: Record<string, string> = {},
): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  if (requestId) headers["x-secondlook-request-id"] = requestId;
  if (retryAfterSeconds !== undefined) headers["retry-after"] = String(retryAfterSeconds);
  Object.assign(headers, additionalHeaders);
  return new Response(JSON.stringify(data), {
    status,
    headers,
  });
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = (request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ClientInputError("unsupported_media_type", "Content-Type must be application/json.", 415, "unsupported_media_type");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_REQUEST_BYTES) {
    throw new ClientInputError("request_too_large", "Request body must be at most 65,536 bytes.", 413, "request_too_large");
  }
  if (!request.body) throw new ClientInputError("invalid_json_body", "Request body must contain valid JSON.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new ClientInputError("request_too_large", "Request body must be at most 65,536 bytes.", 413, "request_too_large");
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    if (error instanceof ClientInputError) throw error;
    throw new ClientInputError("invalid_json_body", "Request body must contain valid UTF-8 JSON.");
  }
}

async function getSecondLookWithTimeout(
  input: Parameters<typeof getSecondLook>[0],
  env: AppEnv,
  requestedModel: string | null,
): Promise<Awaited<ReturnType<typeof getSecondLook>>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const provider = getSecondLook(input, env, requestedModel);
  try {
    return await Promise.race([
      provider,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new ProviderFailureError("provider_timeout")), PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof ClientInputError || error instanceof ModelResponseError || error instanceof ProviderFailureError) throw error;
    throw new ProviderFailureError("provider_unavailable", error);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function updateProviderStateSafely(operation: () => Promise<void>, requestId: string, action: string): Promise<void> {
  try {
    await operation();
  } catch {
    console.error("SecondLook provider state update failed", { request_id: requestId, action });
  }
}

async function synchronizeCompletedFulfillmentSafely(env: AppEnv, requestId: string): Promise<void> {
  try {
    await synchronizeCompletedFulfillment(env, requestId);
  } catch {
    console.error("SecondLook remediation completion synchronization failed", { idempotency_request_id: requestId });
  }
}

async function synchronizePaymentAmbiguityRemediationSafely(env: AppEnv, requestId: string): Promise<void> {
  try {
    await ensurePaymentAmbiguityCase(env, requestId);
  } catch {
    console.error("SecondLook payment ambiguity remediation synchronization failed", {
      idempotency_request_id: requestId,
    });
  }
}

async function tryHonorPublicMainnetPaymentAmbiguity(
  request: Request,
  env: AppEnv,
  auth: AuthContext,
  requestId: string,
  input: SecondLookRequest,
  lifecycle: { requestId: string; ownerToken: string },
): Promise<Response | null> {
  await synchronizePaymentAmbiguityRemediationSafely(env, lifecycle.requestId);
  if (!(await authorizePublicMainnetAmbiguityFulfillment(env, lifecycle.requestId))) return null;
  console.warn("SecondLook honoring one review for ambiguous public-mainnet settlement", {
    request_id: requestId,
    idempotency_request_id: lifecycle.requestId,
    ...callerLogFields(auth),
    payment_state: "ambiguous",
  });
  const response = await runSecondLookInference(
    request,
    env,
    auth,
    requestId,
    input,
    null,
    { ...lifecycle, paid: true, ambiguityHonored: true },
  );
  return ambiguityHonoredResponse(response);
}

function callerLogFields(auth: AuthContext): Record<string, string> {
  return auth.kind === "pilot"
    ? { caller_kind: auth.kind, caller_key: callerKey(auth), customer_id: auth.customer_id, project_id: auth.project_id }
    : { caller_kind: auth.kind, caller_key: callerKey(auth) };
}

type ActiveIdempotency = { requestId: string; ownerToken: string; paid: boolean; ambiguityHonored?: boolean };

const PAYMENT_STATE_HEADER = "X-SecondLook-Payment-State";
const AMBIGUITY_HONORED_HEADER = "X-SecondLook-Ambiguity-Honored";

function ambiguityHonoredResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(PAYMENT_STATE_HEADER, "ambiguous");
  headers.set(AMBIGUITY_HONORED_HEADER, "true");
  headers.delete(X402_PAYMENT_RESPONSE_HEADER);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function runSecondLookInference(
  request: Request,
  env: AppEnv,
  auth: AuthContext,
  requestId: string,
  input: SecondLookRequest,
  requestedModel: string | null,
  idempotency?: ActiveIdempotency,
): Promise<Response> {
  const inferenceStartedAt = Date.now();
  let lease: Awaited<ReturnType<typeof acquireInferenceLease>> | undefined;
  let paidLease: Awaited<ReturnType<typeof acquirePaidInferenceLease>> | undefined;
  let inferenceMarked = false;
  let preserveLeaseUntilExpiry = false;
  try {
    await reservePilotReviewAttempt(env, auth);
    if (idempotency?.paid) paidLease = await acquirePaidInferenceLease(
      env, idempotency.requestId, idempotency.ownerToken, idempotency.ambiguityHonored === true,
    );
    else lease = await acquireInferenceLease(env, auth);
    if (idempotency) {
      if (idempotency.paid) {
        await markPaidInferenceRunning(
          env, idempotency.requestId, idempotency.ownerToken, idempotency.ambiguityHonored === true,
        );
        if (!paidLease) throw new PaymentLifecycleError("payment_state_conflict", false);
        await markPaidAdmissionConsumed(env, paidLease, idempotency.ambiguityHonored === true);
      }
      else await markInferenceRunning(env, idempotency.requestId, idempotency.ownerToken);
      inferenceMarked = true;
    }
    console.log("SecondLook inference started", {
      request_id: requestId,
      ...(idempotency ? { idempotency_request_id: idempotency.requestId } : {}),
      ...callerLogFields(auth),
      policy_version: POLICY_VERSION,
    });
    const result = await getSecondLookWithTimeout(input, env, requestedModel);
    await updateProviderStateSafely(() => recordProviderSuccess(env), requestId, "success");
    const decisionId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const response: SecondLookResponse = {
      decision_id: decisionId,
      created_at: createdAt,
      policy_version: result.policy_version,
      model: result.model,
      recommendation: toLegacyRecommendation(result.decision.review_status),
      ...result.decision,
    };
    const agentId = auth.kind === "paid" ? null : request.headers.get("x-agent-id");
    if (idempotency) {
      await saveDecisionAndCompleteIdempotentRequest(
        env, decisionId, createdAt, input, result, response, agentId, auth,
        idempotency.requestId, idempotency.ownerToken,
      );
      if (idempotency.paid) await synchronizeCompletedFulfillmentSafely(env, idempotency.requestId);
    } else {
      await saveDecision(env, decisionId, createdAt, input, result, agentId, auth);
    }
    const estimatedCostMicroUsd = estimatedInferenceCostMicroUsd(result.model, result.usage);
    const estimatedNeurons = estimatedWorkersAiNeurons(result.model, result.usage);
    console.log("SecondLook inference completed", {
      request_id: requestId,
      decision_id: decisionId,
      ...(idempotency ? { idempotency_request_id: idempotency.requestId } : {}),
      ...callerLogFields(auth),
      model: result.model,
      policy_version: result.policy_version,
      review_status: result.decision.review_status,
      latency_ms: Date.now() - inferenceStartedAt,
      ...(result.usage.input_tokens === undefined ? {} : { input_tokens: result.usage.input_tokens }),
      ...(result.usage.output_tokens === undefined ? {} : { output_tokens: result.usage.output_tokens }),
      ...(estimatedCostMicroUsd === undefined ? {} : { estimated_inference_cost_micro_usd: estimatedCostMicroUsd }),
      ...(estimatedNeurons === undefined ? {} : { estimated_workers_ai_neurons: estimatedNeurons }),
    });
    return json(response, 200, requestId, undefined, idempotency ? { "idempotency-replayed": "false" } : {});
  } catch (error) {
    if (error instanceof ModelResponseError || error instanceof ProviderFailureError) {
      preserveLeaseUntilExpiry = error instanceof ProviderFailureError && error.code === "provider_timeout";
      await updateProviderStateSafely(() => recordProviderFailure(env), requestId, "failure");
    }
    if (idempotency) {
      const failureCode = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "internal_error";
      let ambiguousStateRecorded = false;
      try {
        if (inferenceMarked) {
          await markInferenceAmbiguous(env, idempotency.requestId, idempotency.ownerToken, failureCode);
          ambiguousStateRecorded = true;
          if (idempotency.paid && idempotency.ambiguityHonored) {
            await markPublicMainnetAmbiguityInferenceUncertain(env, idempotency.requestId);
          } else if (idempotency.paid) await ensurePaidFulfillmentCase(env, idempotency.requestId, "inference_ambiguous");
          console.error("SecondLook idempotency inference ambiguous", {
            request_id: requestId, idempotency_request_id: idempotency.requestId, ...callerLogFields(auth), failure_code: failureCode,
          });
        } else {
          await markFailedBeforeInference(env, idempotency.requestId, idempotency.ownerToken, failureCode);
          if (idempotency.paid && !idempotency.ambiguityHonored) {
            await ensurePaidFulfillmentCase(env, idempotency.requestId, "recovery_available");
          }
          console.error("SecondLook idempotency failed before inference", {
            request_id: requestId, idempotency_request_id: idempotency.requestId, ...callerLogFields(auth), failure_code: failureCode,
          });
        }
      } catch {
        console.error("SecondLook idempotency state update failed", {
          request_id: requestId, idempotency_request_id: idempotency.requestId, ...callerLogFields(auth),
        });
      }
      if (ambiguousStateRecorded) throw new IdempotencyLifecycleError("idempotency_state_ambiguous", false);
    }
    throw error;
  } finally {
    if (lease && !preserveLeaseUntilExpiry) {
      try { await releaseInferenceLease(env, lease); }
      catch { console.error("SecondLook inference lease release failed", { request_id: requestId }); }
    }
    if (paidLease && !preserveLeaseUntilExpiry) {
      try { await releasePaidInferenceLease(env, paidLease); }
      catch { console.error("SecondLook paid inference lease release failed", { request_id: requestId }); }
    }
  }
}

async function secondLook(request: Request, env: AppEnv, auth: AuthContext, requestId: string): Promise<Response> {
  if (auth.kind === "pilot" && request.headers.has("x-secondlook-model")) throw new ClientInputError("pilot_model_override_not_allowed", "Pilot credentials cannot select a model.");
  const input = parseSecondLookRequest(await readJson(request));
  const requestedModel = auth.kind === "internal" ? request.headers.get("x-secondlook-model") : null;
  const idempotencyKey = readIdempotencyKey(request);
  let idempotency: { requestId: string; ownerToken: string } | undefined;
  if (idempotencyKey) {
    const fingerprint = await fingerprintSecondLookRequest(input, env, requestedModel);
    const reservation = await reserveIdempotentRequest(env, auth, idempotencyKey, fingerprint.hash, fingerprint.executionContext);
    if (reservation.kind === "replay") {
      console.log("SecondLook idempotency replay hit", {
        request_id: requestId,
        idempotency_request_id: reservation.requestId,
        ...callerLogFields(auth),
      });
      return json(reservation.response, 200, requestId, undefined, { "idempotency-replayed": "true" });
    }
    idempotency = reservation;
    console.log("SecondLook idempotency reservation created", {
      request_id: requestId,
      idempotency_request_id: reservation.requestId,
      ...callerLogFields(auth),
    });
  }

  return runSecondLookInference(
    request,
    env,
    auth,
    requestId,
    input,
    requestedModel,
    idempotency ? { ...idempotency, paid: false } : undefined,
  );
}

function paymentLifecycleResponse(
  error: PaymentLifecycleError,
  requestId: string,
  snapshot?: Awaited<ReturnType<typeof getPaymentSnapshot>>,
): Response {
  const inProgress = error.code === "payment_in_progress";
  const requestProcessing = error.code === "payment_request_processing";
  const conflict = error.code === "payment_proof_conflict" || error.code === "payment_requirement_conflict";
  const unavailable = error.code === "payment_verification_unavailable";
  const failed = error.code === "payment_failed";
  const ambiguous = error.code === "payment_ambiguous";
  const status = unavailable ? 503 : failed ? 402 : 409;
  const additionalHeaders: Record<string, string> = {};
  if (snapshot && (failed || ambiguous)) {
    additionalHeaders[X402_PAYMENT_RESPONSE_HEADER] = encodeX402SettlementResponse(settlementResponseFromPayment({
      success: false,
      network: snapshot.network,
      amount: snapshot.amountAtomic,
      payer: snapshot.payerIdentity,
      transaction: snapshot.externalReference,
      errorReason: snapshot.failureCode ?? error.code,
    }));
  }
  return json({
    error: conflict ? "payment_conflict" : unavailable ? "payment_verification_unavailable" : inProgress
      ? "payment_settlement_in_progress" : requestProcessing ? "payment_accepted_request_processing" : failed
        ? "invalid_payment" : ambiguous ? "payment_state_ambiguous" : "payment_state_conflict",
    code: error.code,
    category: conflict ? "caller" : inProgress || requestProcessing ? "capacity" : unavailable ? "provider" : "payment",
    message: ambiguous
      ? "The payment may have settled, but the durable local result is uncertain; do not resubmit payment automatically."
      : requestProcessing
        ? "Payment is accepted and the original request is still processing."
        : unavailable
          ? "Payment verification is temporarily unavailable; the facilitator settlement endpoint was not called."
          : "The paid request could not advance from its durable payment state.",
    retryable: error.retryable,
    request_id: requestId,
  }, status, requestId, error.retryAfterSeconds, additionalHeaders);
}

function paymentRequiredResponse(paymentRequired: ReturnType<typeof makeX402PaymentRequired>, requestId: string): Response {
  return json({
    error: "payment_required",
    code: "payment_required",
    category: "payment",
    message: "A valid x402 payment is required before inference can begin.",
    retryable: false,
    request_id: requestId,
  }, 402, requestId, undefined, { [X402_PAYMENT_REQUIRED_HEADER]: encodeX402PaymentRequired(paymentRequired) });
}

async function tryExistingPaidObligationWithoutSalesConfiguration(
  request: Request,
  env: AppEnv,
  requestId: string,
): Promise<Response | null> {
  const candidate = await readExistingPaidIdempotencyCandidate(request);
  if (candidate === null || !(await paidIdempotentRequestExists(env, candidate.auth, candidate.key))) return null;
  if (request.headers.has("x-secondlook-model")) {
    throw new ClientInputError("unsupported_model_override", "The paid endpoint always uses the production model.");
  }
  await reserveRequestAttempt(env, await paidRateLimitContext(request), "/v1/paid/second-look");
  const input = parseSecondLookRequest(await readJson(request));
  const fingerprint = await fingerprintSecondLookRequest(input, env, null);
  const reservation = await reserveExistingPaidIdempotentRequest(
    env,
    candidate.auth,
    candidate.key,
    fingerprint.hash,
    fingerprint.executionContext,
  );
  if (reservation === null) return null;
  if (reservation.kind === "replay") {
    await synchronizeCompletedFulfillmentSafely(env, reservation.requestId);
    const payment = await getPaymentSnapshot(env, reservation.requestId);
    if (payment.state === "ambiguous" && await isCompletedPublicMainnetAmbiguityFulfillment(env, reservation.requestId)) {
      return ambiguityHonoredResponse(json(reservation.response, 200, requestId, undefined, {
        "idempotency-replayed": "true",
      }));
    }
    if (payment.state !== "accepted") throw new PaymentLifecycleError("payment_ambiguous", false);
    return json(reservation.response, 200, requestId, undefined, {
      "idempotency-replayed": "true",
      [X402_PAYMENT_RESPONSE_HEADER]: encodeX402SettlementResponse(settlementResponseFromPayment({
        success: true,
        network: payment.network,
        amount: payment.amountAtomic,
        payer: payment.payerIdentity,
        transaction: payment.externalReference,
      })),
    });
  }

  const lifecycle = { requestId: reservation.requestId, ownerToken: reservation.ownerToken };
  const payment = await getPaymentSnapshot(env, lifecycle.requestId);
  if (payment.state === "accepted") {
    const commercial = await env.DB.prepare(
      "SELECT 1 AS present FROM commercial_payment_exposures WHERE request_id = ?",
    ).bind(lifecycle.requestId).first<{ present: number }>();
    if (commercial) await synchronizeCommercialAccountingFromPayment(env, lifecycle.requestId);
    const response = await runSecondLookInference(request, env, candidate.auth, requestId, input, null, { ...lifecycle, paid: true });
    const headers = new Headers(response.headers);
    headers.set(X402_PAYMENT_RESPONSE_HEADER, encodeX402SettlementResponse(settlementResponseFromPayment({
      success: true,
      network: payment.network,
      amount: payment.amountAtomic,
      payer: payment.payerIdentity,
      transaction: payment.externalReference,
    })));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  if (payment.state === "ambiguous") {
    const honored = await tryHonorPublicMainnetPaymentAmbiguity(
      request, env, candidate.auth, requestId, input, lifecycle,
    );
    if (honored) return honored;
  }
  await releasePaidReservation(env, lifecycle.requestId, lifecycle.ownerToken);
  if (payment.state === "ambiguous" || payment.state === "failed") {
    return paymentLifecycleResponse(
      new PaymentLifecycleError(payment.state === "ambiguous" ? "payment_ambiguous" : "payment_failed", false),
      requestId,
      payment,
    );
  }
  return null;
}

async function paidSecondLook(
  request: Request,
  env: AppEnv,
  requestId: string,
  config: X402Configuration,
  adapter: PaymentProviderAdapter<X402PaymentPayload>,
): Promise<Response> {
  const resource = new URL(request.url);
  resource.search = "";
  resource.hash = "";
  const paymentRequired = makeX402PaymentRequired(resource.toString(), config.accepted);
  const paymentHeader = request.headers.get(X402_PAYMENT_SIGNATURE_HEADER);
  let identity: Awaited<ReturnType<typeof readPaidIdempotency>>;
  let allowCreate: boolean;

  if (paymentHeader === null) {
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_REQUEST_BYTES) {
      throw new ClientInputError("request_too_large", "Request body must be at most 65,536 bytes.", 413, "request_too_large");
    }
    const candidate = await readExistingPaidIdempotencyCandidate(request);
    if (candidate === null || !(await paidIdempotentRequestExists(env, candidate.auth, candidate.key))) {
      await assertPaidSettlementAvailability(env, config.publicMainnet?.maxOutstandingPaidObligations);
      if (config.commercialLimits) {
        await assertCommercialPaymentCapacity(env, { requirement: config.requirement, limits: config.commercialLimits });
      }
      console.log("SecondLook payment negotiation advertised", {
        request_id: requestId,
        payment_state: "required",
        network: config.requirement.network,
        asset: config.requirement.asset,
        amount_atomic: config.requirement.amountAtomic,
      });
      return paymentRequiredResponse(paymentRequired, requestId);
    }
    identity = candidate;
    allowCreate = false;
  } else {
    identity = await readPaidIdempotency(request);
    allowCreate = true;
  }

  if (request.headers.has("x-secondlook-model")) {
    throw new ClientInputError("unsupported_model_override", "The paid endpoint always uses the production model.");
  }
  const { key, auth } = identity;
  await reserveRequestAttempt(env, await paidRateLimitContext(request), "/v1/paid/second-look");
  const input = parseSecondLookRequest(await readJson(request));
  const fingerprint = await fingerprintSecondLookRequest(input, env, null);
  if (allowCreate && config.commercialLimits) {
    await cleanupAbandonedCommercialReservations(env);
  }
  const reservation = allowCreate
    ? await reservePaidIdempotentRequest(env, auth, key, fingerprint.hash, fingerprint.executionContext)
    : await reserveExistingPaidIdempotentRequest(env, auth, key, fingerprint.hash, fingerprint.executionContext);
  if (reservation === null) return paymentRequiredResponse(paymentRequired, requestId);
  if (reservation.kind === "replay") {
    await synchronizeCompletedFulfillmentSafely(env, reservation.requestId);
    const payment = await getPaymentSnapshot(env, reservation.requestId);
    if (payment.state === "ambiguous" && await isCompletedPublicMainnetAmbiguityFulfillment(env, reservation.requestId)) {
      return ambiguityHonoredResponse(json(reservation.response, 200, requestId, undefined, {
        "idempotency-replayed": "true",
      }));
    }
    if (payment.state !== "accepted") throw new PaymentLifecycleError("payment_ambiguous", false);
    console.log("SecondLook paid result replayed", {
      request_id: requestId,
      idempotency_request_id: reservation.requestId,
      ...callerLogFields(auth),
      payment_state: payment.state,
      network: payment.network,
      asset: payment.asset,
      amount_atomic: payment.amountAtomic,
      external_reference: payment.externalReference ?? "unavailable",
    });
    return json(reservation.response, 200, requestId, undefined, {
      "idempotency-replayed": "true",
      [X402_PAYMENT_RESPONSE_HEADER]: encodeX402SettlementResponse(settlementResponseFromPayment({
        success: true,
        network: payment.network,
        amount: payment.amountAtomic,
        payer: payment.payerIdentity,
        transaction: payment.externalReference,
      })),
    });
  }

  const lifecycle = { requestId: reservation.requestId, ownerToken: reservation.ownerToken };
  await createPaymentRequirement(env, lifecycle.requestId, lifecycle.ownerToken, config.requirement);
  const durablePayment = await getPaymentSnapshot(env, lifecycle.requestId);
  if (durablePayment.state === "accepted") {
    if (config.commercialLimits) await synchronizeCommercialAccountingFromPayment(env, lifecycle.requestId);
    const response = await runSecondLookInference(
      request,
      env,
      auth,
      requestId,
      input,
      null,
      { ...lifecycle, paid: true },
    );
    const headers = new Headers(response.headers);
    headers.set(X402_PAYMENT_RESPONSE_HEADER, encodeX402SettlementResponse(settlementResponseFromPayment({
      success: true,
      network: durablePayment.network,
      amount: durablePayment.amountAtomic,
      payer: durablePayment.payerIdentity,
      transaction: durablePayment.externalReference,
    })));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  if (durablePayment.state === "ambiguous" || durablePayment.state === "failed") {
    if (durablePayment.state === "ambiguous") {
      const honored = await tryHonorPublicMainnetPaymentAmbiguity(
        request, env, auth, requestId, input, lifecycle,
      );
      if (honored) return honored;
    }
    await releasePaidReservation(env, lifecycle.requestId, lifecycle.ownerToken);
    return paymentLifecycleResponse(
      new PaymentLifecycleError(durablePayment.state === "ambiguous" ? "payment_ambiguous" : "payment_failed", false),
      requestId,
      durablePayment,
    );
  }
  if (paymentHeader === null) {
    await releasePaidReservation(env, lifecycle.requestId, lifecycle.ownerToken);
    console.log("SecondLook payment required", {
      request_id: requestId,
      idempotency_request_id: lifecycle.requestId,
      ...callerLogFields(auth),
      payment_state: "required",
      network: config.requirement.network,
      asset: config.requirement.asset,
      amount_atomic: config.requirement.amountAtomic,
    });
    return paymentRequiredResponse(paymentRequired, requestId);
  }

  let publicCommercialJurisdiction: ReturnType<typeof readPublicCommercialJurisdiction> | undefined;
  if (config.publicMainnet) {
    try {
      publicCommercialJurisdiction = readPublicCommercialJurisdiction(request);
    } catch (error) {
      await releasePaidReservation(env, lifecycle.requestId, lifecycle.ownerToken);
      throw error;
    }
  }

  let payload: X402PaymentPayload;
  try {
    payload = parseX402PaymentPayload(paymentHeader, paymentRequired);
  } catch (error) {
    await releasePaidReservation(env, lifecycle.requestId, lifecycle.ownerToken);
    throw error;
  }
  const authorizationPayer = payload.payload.authorization.from.toLowerCase();
  const authorizationNonce = payload.payload.authorization.nonce.toLowerCase();
  if (config.canaryPayer && authorizationPayer !== config.canaryPayer) {
    await releasePaidReservation(env, lifecycle.requestId, lifecycle.ownerToken);
    throw new ClientInputError("invalid_payment_binding", "The payment authorization is not permitted for this canary.", 409);
  }
  const proofFingerprint = await fingerprintX402PaymentPayload(payload);
  const commercialContext = config.commercialLimits
    ? await createCommercialPaymentContext({
        requirement: config.requirement,
        facilitator: config.facilitatorUrl,
        limits: config.commercialLimits,
        ...(config.publicMainnet && publicCommercialJurisdiction
          ? { publicMainnet: { ...config.publicMainnet, jurisdiction: publicCommercialJurisdiction } }
          : {}),
      })
    : undefined;
  try {
    const acceptance = await attemptPaymentAcceptance(
      env,
      lifecycle.requestId,
      lifecycle.ownerToken,
      proofFingerprint,
      { payer: authorizationPayer, nonce: authorizationNonce },
      payload,
      adapter,
      new Date(),
      commercialContext,
    );
    console.log("SecondLook payment accepted", {
      request_id: requestId,
      idempotency_request_id: lifecycle.requestId,
      ...callerLogFields(auth),
      payment_state: "accepted",
      network: acceptance.payment.network,
      asset: acceptance.payment.asset,
      amount_atomic: acceptance.payment.amountAtomic,
      external_reference: acceptance.payment.externalReference,
    });
    const response = await runSecondLookInference(
      request,
      env,
      auth,
      requestId,
      input,
      null,
      { ...lifecycle, paid: true },
    );
    const headers = new Headers(response.headers);
    headers.set(X402_PAYMENT_RESPONSE_HEADER, encodeX402SettlementResponse(settlementResponseFromPayment({
      success: true,
      network: acceptance.payment.network,
      amount: acceptance.payment.amountAtomic,
      payer: acceptance.payment.payerIdentity,
      transaction: acceptance.payment.externalReference,
    })));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    if (!(error instanceof PaymentLifecycleError)) throw error;
    if (error.code === "payment_ambiguous") {
      let snapshot: Awaited<ReturnType<typeof getPaymentSnapshot>> | undefined;
      try { snapshot = await getPaymentSnapshot(env, lifecycle.requestId); }
      catch { /* Preserve the bounded lifecycle error when state cannot be read. */ }
      if (snapshot?.state === "ambiguous") {
        const honored = await tryHonorPublicMainnetPaymentAmbiguity(
          request, env, auth, requestId, input, lifecycle,
        );
        if (honored) return honored;
      }
    }
    try { await releasePaidReservation(env, lifecycle.requestId, lifecycle.ownerToken); }
    catch { /* The lifecycle may have advanced; the durable payment state remains authoritative. */ }
    let snapshot: Awaited<ReturnType<typeof getPaymentSnapshot>> | undefined;
    try { snapshot = await getPaymentSnapshot(env, lifecycle.requestId); }
    catch { /* Preserve the bounded lifecycle error when state cannot be read. */ }
    console.error("SecondLook payment request rejected", {
      request_id: requestId,
      idempotency_request_id: lifecycle.requestId,
      ...callerLogFields(auth),
      payment_state: snapshot?.state ?? "unknown",
      error_code: error.code,
      ...(snapshot ? { network: snapshot.network, asset: snapshot.asset, amount_atomic: snapshot.amountAtomic } : {}),
      ...(snapshot?.externalReference ? { external_reference: snapshot.externalReference } : {}),
    });
    return paymentLifecycleResponse(error, requestId, snapshot);
  }
}

async function reportOutcome(request: Request, env: AppEnv, auth: AuthContext, requestId: string): Promise<Response> {
  const input = parseOutcomeRequest(await readJson(request));
  await saveOutcome(env, input, request.headers.get("x-agent-id"), auth);
  console.log("SecondLook outcome accepted", { request_id: requestId, ...callerLogFields(auth) });
  return json({ accepted: true }, 202, requestId);
}

export interface WorkerDependencies {
  paymentAdapter?: PaymentProviderAdapter<X402PaymentPayload>;
}

export interface SecondLookWorker {
  fetch(request: Request, env: AppEnv): Promise<Response>;
}

export function createWorker(dependencies: WorkerDependencies = {}): SecondLookWorker {
  return {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    let authenticatedCaller: AuthContext | undefined;

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ status: "ok", service: "secondlook", version: "0.2.0", policy_version: POLICY_VERSION }, 200, requestId);
      }

      if (request.method === "GET" && url.pathname === "/") {
        return json(publicServiceIndex(url.origin), 200, requestId);
      }

      if (request.method === "GET" && url.pathname === PUBLIC_OPENAPI_PATH) {
        return json(publicOpenApiDocument(url.origin), 200, requestId);
      }

      if (request.method === "GET" && url.pathname === "/support") {
        return new Response("SecondLook Support\n\nFor payment, replay, or service issues:\nsupport@example.com\n", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" },
        });
      }

      if (request.method === "GET" && url.pathname === "/terms") {
        const supportUrl = readPublicSupportUrl(env);
        return new Response(renderPublicTerms(supportUrl), { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
      }

      if (request.method === "GET" && url.pathname === "/privacy") {
        const supportUrl = readPublicSupportUrl(env);
        return new Response(renderPublicPrivacy(supportUrl), { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
      }

      if (request.method === "GET" && url.pathname === PUBLIC_MANIFEST_PATH) {
        let paidConfig: X402Configuration | null = null;
        try { paidConfig = readX402Configuration(env); }
        catch { /* Invalid paid configuration remains undiscoverable and unusable. */ }
        const newSalesEnabled = paidConfig !== null && (
          paidConfig.publicMainnet === null || await publicPaidNewSettlementsEnabled(env)
        );
        const supportUrl = readPublicSupportUrl(env);
        return json({
          service: "SecondLook",
          description: PUBLIC_AGENT_DESCRIPTION,
          buyer_guide: publicBuyerGuide(),
          version: "0.2.0",
          policy_version: POLICY_VERSION,
          openapi_url: `${url.origin}${PUBLIC_OPENAPI_PATH}`,
          endpoints: {
            second_look: { method: "POST", path: "/v1/second-look" },
            report_outcome: { method: "POST", path: "/v1/outcomes" },
            paid_second_look: {
              method: "POST",
              path: "/v1/paid/second-look",
              protocol: "x402-v2",
              new_sales_enabled: newSalesEnabled,
              existing_paid_replay_or_recovery_supported: true,
            },
          },
          review_statuses: [
            "no_material_concern_found",
            "material_concern_found",
            "insufficient_information",
            "human_review_required",
          ],
          invariant: "SecondLook never supplies missing authority.",
          public_notices: {
            terms: "/terms",
            privacy: "/privacy",
            ...(supportUrl ? { support: supportUrl } : {}),
          },
          paid_service: {
            new_sales_enabled: newSalesEnabled,
            existing_paid_replay_or_recovery_supported: true,
            payment_flow: "upfront",
            authorization: "Payment purchases review processing; it does not authorize or execute the proposed action.",
            payment_ambiguity: {
              public_mainnet_single_fulfillment: true,
              payment_truth_remains_ambiguous: true,
              settlement_success_receipt_returned: false,
              new_sales_blocked_until_reconciliation: false,
              unrelated_new_sales_remain_available_within_capacity: true,
            },
            ...(paidConfig ? {
              endpoint: "/v1/paid/second-look",
              protocol: "x402-v2",
              network: paidConfig.requirement.network,
              asset: paidConfig.requirement.asset,
              amount_atomic: paidConfig.requirement.amountAtomic,
              ...(paidConfig.publicMainnet ? { price_display: "0.05 USDC" } : {}),
            } : {}),
            ...(paidConfig?.publicMainnet ? { public_commercial: {
              policy_version: paidConfig.publicMainnet.policyVersion,
              capacity_limited: true,
              service_use_country: "US",
              eligible_regions: "50 U.S. states and District of Columbia",
              excluded_regions: ["U.S. territories"],
              required_headers: [SERVICE_USE_COUNTRY_HEADER, SERVICE_USE_REGION_HEADER],
              service_use_headers: {
                country: { name: SERVICE_USE_COUNTRY_HEADER, required_for_payment_retry: true, value: "US" },
                region: {
                  name: SERVICE_USE_REGION_HEADER,
                  required_for_payment_retry: true,
                  format: "USPS two-letter state code or DC",
                  eligible_values: publicCommercialEligibleRegions(),
                },
              },
            } } : {}),
          },
          request_limits: {
            content_type: "application/json",
            maximum_body_bytes: MAX_REQUEST_BYTES,
            maximum_aggregate_text_characters: 24_000,
            maximum_list_items: 25,
            maximum_structured_constraints: 25,
            maximum_conflict_groups: 12,
          },
          operational_behavior: {
            provider_timeout_seconds: PROVIDER_TIMEOUT_MS / 1000,
            automatic_inference_retries: false,
            caller_burst_limit: CALLER_BURST_LIMIT,
            caller_burst_window_seconds: CALLER_BURST_WINDOW_SECONDS,
            caller_minute_limit: CALLER_MINUTE_LIMIT,
            caller_daily_request_limit: CALLER_DAILY_LIMIT,
            global_capacity: "bounded and operator-controlled",
            request_id_response_header: "X-SecondLook-Request-Id",
            idempotency: {
              rules: "endpoint-specific",
              second_look: {
                header: IDEMPOTENCY_KEY_HEADER,
                required: false,
                minimum_key_characters: IDEMPOTENCY_KEY_MIN_LENGTH,
                maximum_key_characters: IDEMPOTENCY_KEY_MAX_LENGTH,
                retention_seconds: IDEMPOTENCY_RETENTION_SECONDS,
                in_progress_retry_seconds: IDEMPOTENCY_IN_PROGRESS_RETRY_SECONDS,
                replay_response_header: "Idempotency-Replayed",
              },
              report_outcome: { supported: false },
              paid_second_look: {
                protocol: "x402-v2",
                header: IDEMPOTENCY_KEY_HEADER,
                required_for_negotiation: false,
                required_for_payment_retry: true,
                format: "uuid-v4",
                retention_seconds: IDEMPOTENCY_RETENTION_SECONDS,
                replay_response_header: "Idempotency-Replayed",
                recovery: {
                  method: "POST",
                  same_path: true,
                  same_canonical_request_required: true,
                  json_formatting_may_differ: true,
                  same_idempotency_key_required: true,
                  payment_signature_required: false,
                  repeats_settlement: false,
                },
              },
            },
          },
          constraint_context_versions: ["constraint-context-v1"],
          deprecated_recommendation_aliases: {
            no_material_concern_found: "proceed",
            material_concern_found: "reconsider",
            insufficient_information: "need_more_information",
            human_review_required: "escalate_to_human",
          },
        }, 200, requestId);
      }

      if (url.pathname === "/v1/paid/second-look") {
        if (request.method !== "POST") {
          return json({ error: "not_found", code: "not_found", category: "caller", retryable: false, request_id: requestId }, 404, requestId);
        }
        let config: X402Configuration | null;
        let configurationInvalid = false;
        try { config = readX402Configuration(env); }
        catch {
          config = null;
          configurationInvalid = true;
          console.error("SecondLook paid path configuration invalid", { path: url.pathname, request_id: requestId });
        }
        if (config === null) {
          const existing = await tryExistingPaidObligationWithoutSalesConfiguration(request, env, requestId);
          if (existing !== null) return existing;
          return json({
            error: "service_unavailable",
            code: configurationInvalid ? "payment_configuration_invalid" : "paid_service_disabled",
            category: "service",
            message: configurationInvalid ? "The paid endpoint is not configured." : "The paid endpoint is not enabled.",
            retryable: false,
            request_id: requestId,
          }, 503, requestId);
        }
        console.log("SecondLook paid request attempted", { request_id: requestId, path: url.pathname, method: request.method });
        const adapter = dependencies.paymentAdapter ?? new X402FacilitatorAdapter(config.facilitator);
        return await paidSecondLook(request, env, requestId, config, adapter);
      }

      if (url.pathname === "/v1/second-look" || url.pathname === "/v1/outcomes") {
        if (!env.SECONDLOOK_ACCESS_KEY) {
          console.error("SecondLook access key unavailable", { path: url.pathname, error_code: "missing_access_key" });
          return json({ error: "service_unavailable", code: "missing_access_key", category: "service", retryable: false, request_id: requestId }, 503, requestId);
        }
        console.log("SecondLook request attempted", { request_id: requestId, path: url.pathname, method: request.method });
        const auth = await authenticate(request, env);
        if (!auth) {
          return json({ error: "unauthorized", code: "invalid_access_key", category: "access", retryable: false, request_id: requestId }, 401, requestId);
        }
        authenticatedCaller = auth;
        if (request.method === "POST") await reserveRequestAttempt(env, auth, url.pathname);
        if (request.method === "POST" && url.pathname === "/v1/second-look") return await secondLook(request, env, auth, requestId);
        if (request.method === "POST" && url.pathname === "/v1/outcomes") return await reportOutcome(request, env, auth, requestId);
      }

      return json({ error: "not_found", code: "not_found", category: "caller", retryable: false, request_id: requestId }, 404, requestId);
    } catch (error) {
      if (error instanceof ClientInputError) {
        console.error("SecondLook request rejected", { path: url.pathname, request_id: requestId, error_code: error.code });
        return json({ error: error.errorName, code: error.code, detail: error.code, category: "caller", message: error.message, retryable: false, request_id: requestId }, error.status, requestId);
      }
      if (error instanceof CommercialEligibilityError) {
        console.error("SecondLook commercial eligibility rejected", { path: url.pathname, request_id: requestId, error_code: error.code });
        return json({ error: "commercial_ineligible", code: error.code, category: error.category, message: error.message, retryable: false, request_id: requestId }, error.status, requestId);
      }
      if (error instanceof ModelResponseError) {
        console.error("SecondLook model response rejected", { path: url.pathname, request_id: requestId, error_code: error.code });
        return json(
          {
            error: "model_invalid_response",
            code: error.code,
            detail: error.code,
            category: "provider",
            message: "The model did not return a valid SecondLook decision.",
            retryable: false,
            request_id: requestId,
          },
          502,
          requestId,
        );
      }
      if (error instanceof PilotUsageLimitError) return json({ error: "usage_limit_reached", code: "pilot_usage_limit_reached", category: "capacity", retryable: false, request_id: requestId }, 429, requestId);
      if (error instanceof IdempotencyLifecycleError) {
        const conflict = error.code === "idempotency_key_conflict";
        const inProgress = error.code === "idempotency_in_progress";
        console.error("SecondLook idempotency request rejected", {
          path: url.pathname,
          request_id: requestId,
          error_code: error.code,
          ...(authenticatedCaller ? callerLogFields(authenticatedCaller) : {}),
        });
        return json({
          error: conflict ? "idempotency_conflict" : inProgress ? "idempotency_in_progress" : "idempotency_ambiguous",
          code: error.code,
          category: conflict ? "caller" : inProgress ? "capacity" : "service",
          message: error.message,
          retryable: error.retryable,
          request_id: requestId,
        }, 409, requestId, error.retryAfterSeconds);
      }
      if (error instanceof PaymentLifecycleError) {
        console.error("SecondLook payment lifecycle rejected request", {
          path: url.pathname,
          request_id: requestId,
          error_code: error.code,
          ...(authenticatedCaller ? callerLogFields(authenticatedCaller) : {}),
        });
        return paymentLifecycleResponse(error, requestId);
      }
      if (error instanceof ServiceBoundaryError) {
        console.error("SecondLook service boundary rejected request", {
          path: url.pathname,
          request_id: requestId,
          error_code: error.code,
          ...(authenticatedCaller ? callerLogFields(authenticatedCaller) : {}),
        });
        return json({ error: error.status === 429 ? "capacity_limited" : "service_unavailable", code: error.code, category: error.code === "service_disabled" ? "service" : "capacity", message: error.message, retryable: error.retryable, request_id: requestId }, error.status, requestId, error.retryAfterSeconds);
      }
      if (error instanceof ProviderFailureError) {
        console.error("SecondLook provider request failed", unexpectedErrorLog(url.pathname, requestId, error.providerCause ?? error));
        const timedOut = error.code === "provider_timeout";
        return json({ error: "provider_failure", code: error.code, category: "provider", message: "The model provider could not complete the request.", retryable: !timedOut, request_id: requestId }, timedOut ? 504 : 503, requestId, timedOut ? undefined : 10);
      }

      console.error("SecondLook request failed", unexpectedErrorLog(url.pathname, requestId, error));
      return json({ error: "service_error", code: "internal_error", category: "service", message: "SecondLook could not complete the request.", retryable: false, request_id: requestId }, 500, requestId);
    }
  },
  };
}

const worker = createWorker();
export default worker;