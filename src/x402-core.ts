import { ClientInputError } from "./errors";
import type { CommercialFinancialLimits } from "./commercial-accounting";
import type { PaymentAttemptResult, PaymentProviderAdapter, PaymentRequirement } from "./payments";
import type { AppEnv } from "./types";
import { PUBLIC_AGENT_DESCRIPTION, PUBLIC_MAINNET_AMOUNT_ATOMIC, readPublicMainnetConfiguration, type PublicMainnetConfiguration } from "./public-mainnet";

export const X402_VERSION = 2 as const;
export const X402_PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const X402_PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const X402_PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";
export const X402_EXTENSION_RESPONSES_HEADER = "EXTENSION-RESPONSES";
export const X402_BASE_SEPOLIA = "eip155:84532";
export const X402_BASE_MAINNET = "eip155:8453";
export const X402_BASE_MAINNET_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const X402_MAINNET_MAX_AMOUNT_ATOMIC = 100_000;
export const X402_ORG_FACILITATOR = "https://x402.org/facilitator";
export const X402_CDP_FACILITATOR = "https://api.cdp.coinbase.com/platform/v2/x402";
export const X402_EXACT_SCHEME = "exact";
export const X402_FACILITATOR_TIMEOUT_MS = 10_000;
export const X402_MAX_HEADER_CHARACTERS = 16_384;
export const X402_MAX_BAZAAR_REJECTED_REASON_CODE_POINTS = 256;
const X402_MAX_FACILITATOR_RESPONSE_BYTES = 16_384;
const X402_PROVIDER = "x402-facilitator";
const X402_PROTOCOL = "x402-v2-exact-eip3009-upfront";

type JsonObject = Record<string, unknown>;

type FacilitatorFailurePhase = "authorization" | "request" | "response_body";
type FacilitatorFailureKind =
  | "authorization_setup"
  | "timeout"
  | "transport"
  | "response_missing"
  | "response_too_large"
  | "response_invalid_json"
  | "response_invalid_utf8"
  | "response_read";

export type BazaarStatus = "success" | "processing" | "rejected";
export type BazaarParseStatus = "observed" | "not_observed" | "malformed" | "oversized" | "unsupported";

export interface BazaarPhaseObservation {
  request_id: string;
  phase: "verify" | "settle";
  response_received: boolean;
  parse_status: BazaarParseStatus;
  status?: BazaarStatus;
  rejected_reason?: string;
  rejected_reason_truncated?: boolean;
}

type CdpFacilitatorCredentials = {
  apiKeyId: string;
  apiKeySecret: string;
};

type X402FacilitatorConfiguration =
  | { kind: "x402_org"; url: typeof X402_ORG_FACILITATOR }
  | ({ kind: "cdp"; url: typeof X402_CDP_FACILITATOR } & CdpFacilitatorCredentials);

export interface X402PaymentRequirements {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    assetTransferMethod: "eip3009";
    paymentFlow: "upfront";
    name: string;
    version: string;
  };
}

export interface X402PaymentPayload {
  x402Version: 2;
  resource: {
    url: string;
    description?: string;
    mimeType?: string;
    serviceName?: string;
    tags?: string[];
    iconUrl?: string;
  };
  accepted: X402PaymentRequirements;
  payload: {
    signature: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
  extensions: JsonObject;
}

export interface X402PaymentRequired {
  x402Version: 2;
  error: string;
  resource: {
    url: string;
    description: string;
    mimeType: "application/json";
    serviceName: "SecondLook";
    tags: string[];
  };
  accepts: [X402PaymentRequirements];
  extensions: JsonObject;
}

export interface X402SettlementResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
  amount?: string;
  extensions?: JsonObject;
}

export interface X402Configuration {
  facilitatorUrl: string;
  facilitator: X402FacilitatorConfiguration;
  requirement: PaymentRequirement;
  accepted: X402PaymentRequirements;
  canaryPayer: string | null;
  commercialLimits: CommercialFinancialLimits | null;
  publicMainnet: PublicMainnetConfiguration | null;
}

export function makeSecondLookRequestSchema(): JsonObject {
  return {
  type: "object",
  additionalProperties: false,
  description: "Structural JSON Schema plus the expressible cross-field rules. The x-secondlook-semantic-validation extension lists additional deterministic runtime invariants required for acceptance.",
  "x-secondlook-semantic-validation": {
    additional_runtime_validation_required: true,
    runtime_is_authoritative: true,
    failure: { http_status: 400, error_codes: ["invalid_secondlook_request", "invalid_constraint_context"] },
    invariants: [
      { id: "aggregate_request_text", rule: "Aggregate request text across all request fields must be at most 24,000 JavaScript string code units." },
      { id: "aggregate_constraint_text", rule: "Aggregate constraint_context constraint text must be at most 12,000 JavaScript string code units." },
      { id: "unique_constraint_ids", rule: "Each constraint id must be unique across constraint_context.constraints, even when the surrounding objects differ." },
      { id: "unique_conflict_group_ids", rule: "Each conflict-group id must be unique across constraint_context.conflict_groups, even when the surrounding objects differ." },
      { id: "conflict_group_references", rule: "Every conflict-group constraint id must reference an existing constraint whose applicability is not inapplicable." },
      { id: "single_conflict_group_membership", rule: "A constraint may appear in at most one conflict group." },
      { id: "established_controller", rule: "An established controlling_constraint_id must identify an applicable member of that conflict group." },
      { id: "independently_binding_members", rule: "independently_binding_constraint_ids must be unique members of the same group and must not include its established controller." },
    ],
  },
  required: ["goal", "proposed_action"],
  allOf: [
    { not: { required: ["constraint_context", "hard_constraints"], properties: { hard_constraints: { minItems: 1 } } } },
    { not: { required: ["constraint_context", "important_constraints"], properties: { important_constraints: { minItems: 1 } } } },
  ],
  properties: {
    goal: { type: "string", minLength: 1, maxLength: 4000, pattern: "\\S" },
    proposed_action: { type: "string", minLength: 1, maxLength: 4000, pattern: "\\S" },
    authority: {
      type: "object", additionalProperties: false, required: ["status"],
      properties: {
        status: { type: "string", enum: ["confirmed", "unclear", "unknown"] },
        basis: { type: "string", minLength: 1, maxLength: 4000, pattern: "\\S" },
        limits: { type: "array", maxItems: 25, items: { type: "string", minLength: 1, maxLength: 4000, pattern: "\\S" } },
      },
    },
    hard_constraints: { type: "array", maxItems: 25, items: { type: "string", minLength: 1, maxLength: 4000, pattern: "\\S" } },
    soft_preferences: { type: "array", maxItems: 25, items: { type: "string", minLength: 1, maxLength: 4000, pattern: "\\S" } },
    known_facts: { type: "array", maxItems: 25, items: { type: "string", minLength: 1, maxLength: 4000, pattern: "\\S" } },
    unknown_facts: { type: "array", maxItems: 25, items: { type: "string", minLength: 1, maxLength: 4000, pattern: "\\S" } },
    alternatives_considered: { type: "array", maxItems: 25, items: { type: "string", minLength: 1, maxLength: 4000, pattern: "\\S" } },
    reasoning_summary: { type: "string", minLength: 1, maxLength: 4000, pattern: "\\S" },
    important_constraints: { type: "array", maxItems: 25, items: { type: "string", minLength: 1, maxLength: 4000, pattern: "\\S" } },
    uncertainties: { type: "array", maxItems: 25, items: { type: "string", minLength: 1, maxLength: 4000, pattern: "\\S" } },
    estimated_cost_of_action: {
      type: "object", additionalProperties: false, required: ["amount", "currency"],
      properties: { amount: { type: "number", minimum: 0, maximum: 1000000000000000 }, currency: { type: "string", pattern: "^[A-Z]{3}$" } },
    },
    constraint_context: {
      type: "object", additionalProperties: false, required: ["schema_version", "constraints"],
      properties: {
        schema_version: { const: "constraint-context-v1" },
        constraints: {
          type: "array", minItems: 1, maxItems: 25, uniqueItems: true,
          items: {
            type: "object", additionalProperties: false, required: ["id", "text", "applicability", "action_relation"],
            properties: {
              id: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" }, text: { type: "string", minLength: 1, maxLength: 1000, pattern: "\\S" },
              applicability: { enum: ["applicable", "inapplicable", "unresolved"] }, action_relation: { enum: ["satisfies", "violates", "unresolved", "not_applicable"] },
            },
            allOf: [
              {
                if: { properties: { applicability: { const: "inapplicable" } }, required: ["applicability"] },
                then: { properties: { action_relation: { const: "not_applicable" } } },
              },
              {
                if: { properties: { applicability: { enum: ["applicable", "unresolved"] } }, required: ["applicability"] },
                then: { properties: { action_relation: { enum: ["satisfies", "violates", "unresolved"] } } },
              },
            ],
          },
        },
        conflict_groups: {
          type: "array", maxItems: 12, uniqueItems: true,
          items: {
            type: "object", additionalProperties: false, required: ["id", "constraint_ids", "control"],
            properties: {
              id: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
              constraint_ids: { type: "array", minItems: 2, maxItems: 10, uniqueItems: true, items: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" } },
              independently_binding_constraint_ids: { type: "array", maxItems: 10, uniqueItems: true, items: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" } },
              control: {
                oneOf: [
                  {
                    type: "object", additionalProperties: false, required: ["status", "controlling_constraint_id"],
                    properties: { status: { const: "established" }, controlling_constraint_id: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" } },
                  },
                  {
                    type: "object", additionalProperties: false, required: ["status"],
                    properties: { status: { const: "unresolved" } },
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
  };
}

export function makeSecondLookResponseSchema(): JsonObject {
  return {
  type: "object", additionalProperties: false,
  required: ["decision_id", "created_at", "policy_version", "model", "review_status", "recommendation", "reason", "key_risks", "missing_information"],
  properties: {
    decision_id: { type: "string", format: "uuid" }, created_at: { type: "string", format: "date-time" }, policy_version: { type: "string" }, model: { type: "string", description: "Deprecated compatibility field; the underlying inference implementation is not a stable product contract." },
    review_status: { type: "string", enum: ["no_material_concern_found", "material_concern_found", "insufficient_information", "human_review_required"] },
    recommendation: { type: "string", enum: ["proceed", "reconsider", "need_more_information", "escalate_to_human"] },
    reason: { type: "string" }, key_risks: { type: "array", items: { type: "string" } }, missing_information: { type: "array", items: { type: "string" } },
  },
  };
}

export function makeSecondLookRequestExample(): JsonObject {
  return {
  goal: "Review a proposed customer refund before execution.",
  proposed_action: "Issue a $25 refund to the customer.",
  authority: { status: "confirmed", basis: "Support policy permits refunds up to $50." },
  hard_constraints: ["Do not exceed the documented $50 refund limit."],
  known_facts: ["The customer was charged twice."],
  };
}

export function makeSecondLookResponseExample(): JsonObject {
  return {
  decision_id: "00000000-0000-4000-8000-000000000000", created_at: "2026-08-29T00:00:00.000Z",
  policy_version: "2026-08-27.5", model: "implementation-managed",
  review_status: "no_material_concern_found", recommendation: "proceed",
  reason: "The supplied authority, facts, and constraint support the proposed refund.", key_risks: [], missing_information: [],
  };
}

function secondLookBazaarExtension(): JsonObject {
  return {
    bazaar: {
      info: {
        input: {
          type: "http", method: "POST", bodyType: "json",
          body: makeSecondLookRequestExample(),
        },
        output: {
          type: "json",
          example: makeSecondLookResponseExample(),
        },
      },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
        properties: {
          input: {
            type: "object", additionalProperties: false, required: ["type", "method", "bodyType", "body"],
            properties: {
              type: { const: "http" }, method: { const: "POST" }, bodyType: { const: "json" }, body: makeSecondLookRequestSchema(),
            },
          },
          output: {
            type: "object", additionalProperties: false, required: ["type", "example"],
            properties: { type: { const: "json" }, example: makeSecondLookResponseSchema() },
          },
        },
        required: ["input", "output"],
      },
    },
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonObject, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isCanonicalUint(value: unknown, maximumLength = 78): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= maximumLength;
}

function isHexByteString(value: unknown): value is string {
  return typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalize(child)]));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeBase64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64Json(value: string): unknown {
  if (
    value.length === 0 ||
    value.length > X402_MAX_HEADER_CHARACTERS ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) throw new ClientInputError("malformed_payment_proof", "PAYMENT-SIGNATURE must contain bounded Base64-encoded JSON.");
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ClientInputError("malformed_payment_proof", "PAYMENT-SIGNATURE must contain valid UTF-8 JSON.");
  }
}

function bazaarObservationWithoutResponse(requestId: string, phase: BazaarPhaseObservation["phase"]): BazaarPhaseObservation {
  return { request_id: requestId, phase, response_received: false, parse_status: "not_observed" };
}

function sanitizeBazaarRejectedReason(value: string): Pick<BazaarPhaseObservation, "rejected_reason" | "rejected_reason_truncated"> {
  const sanitized = value.trim().replace(/[\u0000-\u001F\u007F]/gu, " ").trim();
  const codePoints = Array.from(sanitized);
  if (codePoints.length === 0) return {};
  if (codePoints.length <= X402_MAX_BAZAAR_REJECTED_REASON_CODE_POINTS) return { rejected_reason: sanitized };
  return {
    rejected_reason: codePoints.slice(0, X402_MAX_BAZAAR_REJECTED_REASON_CODE_POINTS).join(""),
    rejected_reason_truncated: true,
  };
}

export function parseCdpBazaarObservation(
  requestId: string,
  phase: BazaarPhaseObservation["phase"],
  header: string | null,
): BazaarPhaseObservation {
  const base = { request_id: requestId, phase, response_received: true } as const;
  if (header === null) return { ...base, parse_status: "not_observed" };
  if (header.length > X402_MAX_HEADER_CHARACTERS) return { ...base, parse_status: "oversized" };
  if (
    header.length === 0 ||
    header.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header)
  ) return { ...base, parse_status: "malformed" };
  try {
    const binary = atob(header);
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))));
    if (!isObject(decoded)) return { ...base, parse_status: "malformed" };
    const bazaar = decoded.bazaar;
    if (bazaar === undefined) return { ...base, parse_status: "not_observed" };
    if (!isObject(bazaar) || typeof bazaar.status !== "string") return { ...base, parse_status: "malformed" };
    if (!(["success", "processing", "rejected"] as const).includes(bazaar.status as BazaarStatus)) {
      return { ...base, parse_status: "unsupported" };
    }
    const status = bazaar.status as BazaarStatus;
    return {
      ...base,
      parse_status: "observed",
      status,
      ...(status === "rejected" && typeof bazaar.rejectedReason === "string" ? sanitizeBazaarRejectedReason(bazaar.rejectedReason) : {}),
    };
  } catch {
    return { ...base, parse_status: "malformed" };
  }
}

function logCdpBazaarObservation(observation: BazaarPhaseObservation): void {
  console.log("SecondLook CDP Bazaar observation", {
    request_id: observation.request_id,
    phase: observation.phase,
    response_received: observation.response_received,
    parse_status: observation.parse_status,
    ...(observation.status ? { status: observation.status } : {}),
    ...(observation.rejected_reason ? { rejected_reason: observation.rejected_reason } : {}),
    ...(observation.rejected_reason_truncated ? { rejected_reason_truncated: true } : {}),
  });
}

function facilitatorFailureKind(error: unknown, phase: FacilitatorFailurePhase): FacilitatorFailureKind {
  if (phase === "authorization") return "authorization_setup";
  if (error instanceof FacilitatorRequestError) return error.failureKind;
  if (phase === "request") return "transport";
  if (error instanceof SyntaxError) return "response_invalid_json";
  if (error instanceof TypeError) return "response_invalid_utf8";
  if (error instanceof Error && error.message === "facilitator_response_missing") return "response_missing";
  if (error instanceof Error && error.message === "facilitator_response_too_large") return "response_too_large";
  return "response_read";
}

function logFacilitatorFailure(input: {
  requestId: string;
  facilitatorKind: X402FacilitatorConfiguration["kind"];
  phase: FacilitatorFailurePhase;
  kind: FacilitatorFailureKind;
  responseReceived: boolean;
  httpStatus?: number;
  elapsedMs: number;
}): void {
  console.warn("SecondLook x402 facilitator failure", {
    request_id: input.requestId,
    facilitator_kind: input.facilitatorKind,
    phase: input.phase,
    failure_kind: input.kind,
    response_received: input.responseReceived,
    ...(input.httpStatus === undefined ? {} : { http_status: input.httpStatus }),
    elapsed_ms: input.elapsedMs,
  });
}

function parseResource(value: unknown): X402PaymentPayload["resource"] {
  if (!isObject(value) || !hasOnlyKeys(value, ["url", "description", "mimeType", "serviceName", "tags", "iconUrl"])) {
    throw new ClientInputError("malformed_payment_proof", "The x402 resource object is invalid.");
  }
  if (typeof value.url !== "string" || value.url.length > 2048) throw new ClientInputError("malformed_payment_proof", "The x402 resource URL is invalid.");
  for (const key of ["description", "mimeType", "serviceName", "iconUrl"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") throw new ClientInputError("malformed_payment_proof", "The x402 resource metadata is invalid.");
  }
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.length > 5 || value.tags.some((tag) => typeof tag !== "string" || tag.length > 32))) {
    throw new ClientInputError("malformed_payment_proof", "The x402 resource tags are invalid.");
  }
  return value as X402PaymentPayload["resource"];
}

function parseRequirements(value: unknown): X402PaymentRequirements {
  if (!isObject(value) || !hasOnlyKeys(value, ["scheme", "network", "amount", "asset", "payTo", "maxTimeoutSeconds", "extra"])) {
    throw new ClientInputError("malformed_payment_proof", "The accepted x402 payment requirements are invalid.");
  }
  if (
    value.scheme !== X402_EXACT_SCHEME ||
    typeof value.network !== "string" || value.network.length > 128 ||
    !isCanonicalUint(value.amount) ||
    !isAddress(value.asset) ||
    !isAddress(value.payTo) ||
    !Number.isInteger(value.maxTimeoutSeconds) || Number(value.maxTimeoutSeconds) < 1 || Number(value.maxTimeoutSeconds) > 300 ||
    !isObject(value.extra) ||
    !hasOnlyKeys(value.extra, ["assetTransferMethod", "paymentFlow", "name", "version"]) ||
    value.extra.assetTransferMethod !== "eip3009" ||
    value.extra.paymentFlow !== "upfront" ||
    typeof value.extra.name !== "string" || value.extra.name.length === 0 || value.extra.name.length > 64 ||
    typeof value.extra.version !== "string" || value.extra.version.length === 0 || value.extra.version.length > 32
  ) throw new ClientInputError("malformed_payment_proof", "The accepted x402 payment requirements are invalid.");
  return value as unknown as X402PaymentRequirements;
}

function parseSchemePayload(value: unknown): X402PaymentPayload["payload"] {
  if (!isObject(value) || !hasOnlyKeys(value, ["signature", "authorization"]) || !isHexByteString(value.signature)) {
    throw new ClientInputError("malformed_payment_proof", "The exact EVM payment payload is invalid.");
  }
  const authorization = value.authorization;
  if (
    !isObject(authorization) ||
    !hasOnlyKeys(authorization, ["from", "to", "value", "validAfter", "validBefore", "nonce"]) ||
    !isAddress(authorization.from) ||
    !isAddress(authorization.to) ||
    !isCanonicalUint(authorization.value) ||
    !isCanonicalUint(authorization.validAfter, 20) ||
    !isCanonicalUint(authorization.validBefore, 20) ||
    typeof authorization.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(authorization.nonce)
  ) throw new ClientInputError("malformed_payment_proof", "The exact EVM authorization is invalid.");
  return value as unknown as X402PaymentPayload["payload"];
}

export function parseX402PaymentPayload(
  headerValue: string,
  expectedPaymentRequired: X402PaymentRequired,
): X402PaymentPayload {
  const value = decodeBase64Json(headerValue);
  if (!isObject(value) || !hasOnlyKeys(value, ["x402Version", "resource", "accepted", "payload", "extensions"]) || value.x402Version !== X402_VERSION) {
    throw new ClientInputError("malformed_payment_proof", "The PAYMENT-SIGNATURE payload must use x402 version 2.");
  }
  const expected = expectedPaymentRequired.accepts[0];
  const accepted = parseRequirements(value.accepted);
  if (canonicalJson(accepted) !== canonicalJson(expected)) {
    throw new ClientInputError("invalid_payment_binding", "The payment proof does not match this request's amount, asset, network, recipient, or scheme.", 409);
  }
  const payload = parseSchemePayload(value.payload);
  if (
    payload.authorization.to.toLowerCase() !== expected.payTo.toLowerCase() ||
    payload.authorization.value !== expected.amount
  ) throw new ClientInputError("invalid_payment_binding", "The signed payment authorization does not match this request.", 409);
  if (value.resource === undefined) {
    throw new ClientInputError("invalid_payment_binding", "The payment proof must include the protected resource metadata.", 409);
  }
  const resource = parseResource(value.resource);
  if (canonicalJson(resource) !== canonicalJson(expectedPaymentRequired.resource)) {
    throw new ClientInputError("invalid_payment_binding", "The payment proof does not match this request's protected resource metadata.", 409);
  }
  if (!isObject(value.extensions)) {
    throw new ClientInputError("malformed_payment_proof", "The x402 extensions object is invalid.");
  }
  if (canonicalJson(value.extensions.bazaar) !== canonicalJson(expectedPaymentRequired.extensions.bazaar)) {
    throw new ClientInputError("invalid_payment_binding", "The payment proof does not match this request's Bazaar metadata.", 409);
  }
  return {
    x402Version: X402_VERSION,
    resource,
    accepted,
    payload,
    extensions: value.extensions,
  };
}

export async function fingerprintX402PaymentPayload(payload: X402PaymentPayload): Promise<string> {
  return sha256Hex(canonicalJson(payload));
}

function paymentRequirement(accepted: X402PaymentRequirements): PaymentRequirement {
  return {
    provider: X402_PROVIDER,
    protocol: X402_PROTOCOL,
    amountAtomic: accepted.amount,
    asset: accepted.asset,
    network: accepted.network,
    payTo: accepted.payTo,
    requirementsJson: canonicalJson(accepted),
  };
}

export function readX402Configuration(env: AppEnv): X402Configuration | null {
  if (env.X402_PAID_ENABLED !== "true") return null;
  const facilitatorUrl = env.X402_FACILITATOR_URL?.trim() ?? "";
  const network = env.X402_NETWORK?.trim() ?? "";
  const asset = env.X402_ASSET?.trim() ?? "";
  const amount = env.X402_AMOUNT_ATOMIC?.trim() ?? "";
  const payTo = env.X402_PAY_TO?.trim() ?? "";
  const name = env.X402_ASSET_NAME?.trim() ?? "";
  const version = env.X402_ASSET_VERSION?.trim() ?? "";
  const cdpApiKeyId = env.X402_CDP_API_KEY_ID?.trim() ?? "";
  const cdpApiKeySecret = env.X402_CDP_API_KEY_SECRET?.trim() ?? "";
  const mainnetCanaryEnabled = env.X402_MAINNET_CANARY_ENABLED === "true";
  const publicMainnet = readPublicMainnetConfiguration(env);
  const canaryPayerRaw = env.X402_CANARY_PAYER?.trim() ?? "";
  let facilitator: X402FacilitatorConfiguration;
  if (facilitatorUrl === X402_ORG_FACILITATOR) {
    if (cdpApiKeyId || cdpApiKeySecret) throw new Error("The x402.org facilitator does not accept CDP credentials.");
    facilitator = { kind: "x402_org", url: X402_ORG_FACILITATOR };
  } else if (facilitatorUrl === X402_CDP_FACILITATOR) {
    if (!cdpApiKeyId || !cdpApiKeySecret) throw new Error("The CDP facilitator requires both API key ID and secret.");
    facilitator = { kind: "cdp", url: X402_CDP_FACILITATOR, apiKeyId: cdpApiKeyId, apiKeySecret: cdpApiKeySecret };
  } else {
    throw new Error("The dormant x402 paid path is enabled with an unapproved facilitator.");
  }
  const isSepolia = network === X402_BASE_SEPOLIA;
  const isMainnetCanary = network === X402_BASE_MAINNET;
  if (
    (!isSepolia && !isMainnetCanary) ||
    !isAddress(asset) || !isAddress(payTo) ||
    !/^[1-9][0-9]{0,77}$/.test(amount) ||
    name.length === 0 || name.length > 64 ||
    version.length === 0 || version.length > 32
  ) throw new Error("The dormant x402 paid path is enabled without a complete supported configuration.");
  let canaryPayer: string | null = null;
  let commercialLimits: CommercialFinancialLimits | null = null;
  if (isMainnetCanary) {
    if (mainnetCanaryEnabled && publicMainnet) throw new Error("Mainnet canary and public mainnet modes are mutually exclusive.");
    if (
      (!mainnetCanaryEnabled && !publicMainnet) || facilitator.kind !== "cdp" ||
      asset.toLowerCase() !== X402_BASE_MAINNET_USDC ||
      payTo.toLowerCase() === "0x0000000000000000000000000000000000000000" ||
      BigInt(amount) > BigInt(X402_MAINNET_MAX_AMOUNT_ATOMIC)
    ) throw new Error("The Base mainnet paid path requires an explicit bounded CDP canary or public mainnet configuration.");
    if (mainnetCanaryEnabled) {
      if (!isAddress(canaryPayerRaw)) throw new Error("The Base mainnet canary requires a valid payer restriction.");
      canaryPayer = canaryPayerRaw.toLowerCase();
    } else {
      if (canaryPayerRaw.length > 0) throw new Error("A canary payer restriction cannot be applied to public mainnet mode.");
      if (amount !== PUBLIC_MAINNET_AMOUNT_ATOMIC) throw new Error("The public mainnet price must be exactly 50000 atomic USDC.");
    }
    const parseCommercialLimit = (raw: string | undefined, name: string): number => {
      if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) {
        throw new Error(`${name} must be a canonical positive integer for Base mainnet.`);
      }
      const value = Number(raw);
      if (!Number.isSafeInteger(value)) throw new Error(`${name} exceeds the supported safety range.`);
      return value;
    };
    commercialLimits = {
      dailySettlementLimit: parseCommercialLimit(env.X402_DAILY_SETTLEMENT_LIMIT, "X402_DAILY_SETTLEMENT_LIMIT"),
      dailyAcceptedPaymentLimit: parseCommercialLimit(env.X402_DAILY_ACCEPTED_PAYMENT_LIMIT, "X402_DAILY_ACCEPTED_PAYMENT_LIMIT"),
      dailySettledAtomicLimit: parseCommercialLimit(env.X402_DAILY_SETTLED_ATOMIC_LIMIT, "X402_DAILY_SETTLED_ATOMIC_LIMIT"),
      monthlyFacilitatorLimit: parseCommercialLimit(env.X402_MONTHLY_FACILITATOR_LIMIT, "X402_MONTHLY_FACILITATOR_LIMIT"),
      dailyPaidInferenceLimit: parseCommercialLimit(env.X402_DAILY_PAID_INFERENCE_LIMIT, "X402_DAILY_PAID_INFERENCE_LIMIT"),
    };
  } else if (mainnetCanaryEnabled || publicMainnet || canaryPayerRaw.length > 0) {
    throw new Error("Mainnet mode configuration cannot be applied to Base Sepolia.");
  }
  const accepted: X402PaymentRequirements = {
    scheme: X402_EXACT_SCHEME,
    network,
    amount,
    asset,
    payTo,
    maxTimeoutSeconds: 60,
    extra: { assetTransferMethod: "eip3009", paymentFlow: "upfront", name, version },
  };
  return { facilitatorUrl, facilitator, accepted, requirement: paymentRequirement(accepted), canaryPayer, commercialLimits, publicMainnet };
}

export function makeX402PaymentRequired(resourceUrl: string, accepted: X402PaymentRequirements, error = "PAYMENT-SIGNATURE header is required"): X402PaymentRequired {
  return {
    x402Version: X402_VERSION,
    error,
    resource: {
      url: resourceUrl,
      description: `${PUBLIC_AGENT_DESCRIPTION} See the public root and /openapi.json for buyer-fit guidance, labeled illustrative examples, and /privacy before submitting business context. U.S.-only public service in the 50 states and District of Columbia; U.S. territories unavailable.`,
      mimeType: "application/json",
      serviceName: "SecondLook",
      tags: ["ai", "agent", "review", "pre-action", "decision-support"],
    },
    accepts: [{ ...accepted, extra: { ...accepted.extra } }],
    extensions: secondLookBazaarExtension(),
  };
}

export function encodeX402PaymentRequired(value: X402PaymentRequired): string {
  return encodeBase64Json(value);
}

export function encodeX402SettlementResponse(value: X402SettlementResponse): string {
  return encodeBase64Json(value);
}

async function readBoundedResponseJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > X402_MAX_FACILITATOR_RESPONSE_BYTES) throw new Error("facilitator_response_too_large");
  if (!response.body) throw new Error("facilitator_response_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > X402_MAX_FACILITATOR_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("facilitator_response_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCdpKeySecret(value: string): Uint8Array {
  if (value.length === 0 || value.length > 512 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("invalid_cdp_api_key_secret");
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 64) throw new Error("invalid_cdp_api_key_secret");
  return bytes;
}

async function cdpAuthorizationHeader(credentials: CdpFacilitatorCredentials, endpoint: string): Promise<string> {
  const keyBytes = decodeCdpKeySecret(credentials.apiKeySecret);
  const now = Math.floor(Date.now() / 1000);
  const target = new URL(endpoint);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: credentials.apiKeyId, nonce: crypto.randomUUID().replaceAll("-", "") })));
  const claims = base64Url(new TextEncoder().encode(JSON.stringify({
    sub: credentials.apiKeyId,
    iss: "cdp",
    iat: now,
    nbf: now,
    exp: now + 120,
    uris: [`POST ${target.host}${target.pathname}`],
  })));
  const privateKey = await crypto.subtle.importKey("jwk", {
    kty: "OKP", crv: "Ed25519", d: base64Url(keyBytes.slice(0, 32)), x: base64Url(keyBytes.slice(32)),
  }, { name: "Ed25519" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(`${header}.${claims}`)));
  return `Bearer ${header}.${claims}.${base64Url(signature)}`;
}

class FacilitatorRequestError extends Error {
  constructor(readonly failureKind: "timeout" | "transport") {
    super(failureKind);
    this.name = "FacilitatorRequestError";
  }
}

async function postFacilitator(fetcher: typeof fetch, url: string, body: unknown, authorization?: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), X402_FACILITATOR_TIMEOUT_MS);
  try {
    return await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: controller.signal,
    });
  } catch {
    throw new FacilitatorRequestError(controller.signal.aborted ? "timeout" : "transport");
  } finally {
    clearTimeout(timeout);
  }
}

function boundedReason(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : fallback;
}

export class X402FacilitatorAdapter implements PaymentProviderAdapter<X402PaymentPayload> {
  private readonly facilitator: X402FacilitatorConfiguration;

  constructor(facilitator: X402FacilitatorConfiguration | string, private readonly fetcher: typeof fetch = fetch) {
    this.facilitator = typeof facilitator === "string"
      ? { kind: "x402_org", url: facilitator as typeof X402_ORG_FACILITATOR }
      : facilitator;
  }

  async attemptAcceptance(input: {
    requestId: string;
    requirement: PaymentRequirement;
    authorization: X402PaymentPayload;
  }): Promise<PaymentAttemptResult> {
    let requirements: X402PaymentRequirements;
    try {
      requirements = JSON.parse(input.requirement.requirementsJson) as X402PaymentRequirements;
    } catch {
      return { outcome: "failed", failureCode: "invalid_durable_payment_requirements" };
    }
    const facilitatorBody = {
      x402Version: X402_VERSION,
      paymentPayload: input.authorization,
      paymentRequirements: requirements,
    };

    let settlement: unknown;
    let settlementHttpStatus: number | undefined;
    let failurePhase: FacilitatorFailurePhase = this.facilitator.kind === "cdp" ? "authorization" : "request";
    let responseReceived = false;
    const attemptStartedAt = Date.now();
    try {
      const settleUrl = `${this.facilitator.url}/settle`;
      const authorization = this.facilitator.kind === "cdp" ? await cdpAuthorizationHeader(this.facilitator, settleUrl) : undefined;
      failurePhase = "request";
      const response = await postFacilitator(this.fetcher, settleUrl, facilitatorBody, authorization);
      responseReceived = true;
      settlementHttpStatus = response.status;
      if (this.facilitator.kind === "cdp") logCdpBazaarObservation(parseCdpBazaarObservation(input.requestId, "settle", response.headers.get(X402_EXTENSION_RESPONSES_HEADER)));
      failurePhase = "response_body";
      settlement = await readBoundedResponseJson(response);
    } catch (error) {
      if (this.facilitator.kind === "cdp" && !responseReceived) logCdpBazaarObservation(bazaarObservationWithoutResponse(input.requestId, "settle"));
      logFacilitatorFailure({
        requestId: input.requestId,
        facilitatorKind: this.facilitator.kind,
        phase: failurePhase,
        kind: facilitatorFailureKind(error, failurePhase),
        responseReceived,
        httpStatus: settlementHttpStatus,
        elapsedMs: Math.max(0, Date.now() - attemptStartedAt),
      });
      if (failurePhase === "authorization") {
        return { outcome: "failed", failureCode: "payment_facilitator_authorization_failed" };
      }
      return { outcome: "ambiguous", failureCode: "payment_settlement_outcome_unknown" };
    }
    if (!isObject(settlement) || typeof settlement.success !== "boolean" || typeof settlement.transaction !== "string" || typeof settlement.network !== "string") {
      return { outcome: "ambiguous", failureCode: "payment_settlement_invalid_response" };
    }
    const successfulHttpStatus = settlementHttpStatus >= 200 && settlementHttpStatus < 300;
    const definiteRejectionHttpStatus = settlementHttpStatus >= 400 && settlementHttpStatus < 500 &&
      ![408, 425, 429].includes(settlementHttpStatus);
    if (!settlement.success) {
      const reason = boundedReason(settlement.errorReason, "payment_settlement_failed");
      const payer = settlement.payer;
      const payerContradiction = payer !== undefined && (!isAddress(payer) || payer.toLowerCase() !== input.authorization.payload.authorization.from.toLowerCase());
      const amountContradiction = settlement.amount !== undefined && settlement.amount !== requirements.amount;
      if (
        !definiteRejectionHttpStatus || settlement.transaction.length > 0 || reason === "settlement_pending" ||
        settlement.network !== requirements.network || payerContradiction || amountContradiction
      ) {
        return {
          outcome: "ambiguous",
          failureCode: definiteRejectionHttpStatus ? reason : "payment_settlement_http_uncertain",
          externalReference: /^0x[0-9a-fA-F]{64}$/.test(settlement.transaction) ? settlement.transaction : undefined,
        };
      }
      return { outcome: "failed", failureCode: reason };
    }
    if (!successfulHttpStatus) {
      return {
        outcome: "ambiguous",
        failureCode: "payment_settlement_http_uncertain",
        externalReference: /^0x[0-9a-fA-F]{64}$/.test(settlement.transaction) ? settlement.transaction : undefined,
      };
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(settlement.transaction)) {
      return { outcome: "ambiguous", failureCode: "payment_settlement_missing_transaction" };
    }
    if (settlement.network !== requirements.network) {
      return { outcome: "ambiguous", failureCode: "payment_settlement_network_mismatch", externalReference: settlement.transaction };
    }
    if (!isAddress(settlement.payer)) {
      return { outcome: "ambiguous", failureCode: "payment_settlement_missing_payer", externalReference: settlement.transaction };
    }
    if (settlement.payer.toLowerCase() !== input.authorization.payload.authorization.from.toLowerCase()) {
      return { outcome: "ambiguous", failureCode: "payment_settlement_payer_mismatch", payerIdentity: settlement.payer, externalReference: settlement.transaction };
    }
    if (settlement.amount !== undefined && settlement.amount !== requirements.amount) {
      return { outcome: "ambiguous", failureCode: "payment_settlement_amount_mismatch", payerIdentity: settlement.payer, externalReference: settlement.transaction };
    }
    const observedAt = new Date().toISOString();
    return {
      outcome: "accepted",
      payerIdentity: settlement.payer,
      externalReference: settlement.transaction,
      verifiedAt: observedAt,
      settledAt: observedAt,
    };
  }
}

export function settlementResponseFromPayment(input: {
  success: boolean;
  network: string;
  amount: string;
  payer?: string | null;
  transaction?: string | null;
  errorReason?: string | null;
}): X402SettlementResponse {
  return {
    success: input.success,
    ...(input.errorReason ? { errorReason: input.errorReason } : {}),
    ...(input.payer ? { payer: input.payer } : {}),
    transaction: input.transaction ?? "",
    network: input.network,
    amount: input.amount,
  };
}
