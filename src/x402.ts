export * from "./x402-core";

import {
  makeX402PaymentRequired as makeCoreX402PaymentRequired,
  X402FacilitatorAdapter as CoreX402FacilitatorAdapter,
  type X402PaymentRequired,
  type X402PaymentRequirements,
} from "./x402-core";

const CDP_DIAGNOSTIC_MAX_RESPONSE_BYTES = 16_384;
const CDP_DIAGNOSTIC_MAX_TEXT_CODE_POINTS = 256;
const CDP_PAYMENT_RESOURCE_DESCRIPTION_MAX_CHARACTERS = 500;
const CDP_PAYMENT_RESOURCE_DESCRIPTION = "SecondLook provides an independent pre-action review of a proposed AI or agent action. It checks supplied facts, authority, constraints, reasoning, risks, and missing information before execution. Use it when an action is costly, external, irreversible, or constraint-sensitive. SecondLook does not authorize, execute, or supply missing authority, and results are not guarantees of correctness.";

type CoreFacilitatorInput = ConstructorParameters<typeof CoreX402FacilitatorAdapter>[0];
type CoreAttemptInput = Parameters<CoreX402FacilitatorAdapter["attemptAcceptance"]>[0];
type CoreAttemptResult = ReturnType<CoreX402FacilitatorAdapter["attemptAcceptance"]>;
type CdpFacilitatorInput = {
  kind: "cdp";
  url: string;
  apiKeyId: string;
  apiKeySecret: string;
};

type DiagnosticReadResult =
  | { status: "ok"; value: unknown }
  | { status: "unavailable" };

type SanitizedDiagnosticText = {
  value?: string;
  truncated?: boolean;
};

// Coinbase CDP currently rejects otherwise valid x402 v2 payment payloads when
// resource.description exceeds 500 characters. Keep the richer public product description
// elsewhere; only the payment-resource metadata uses this bounded compatibility description.
export function makeX402PaymentRequired(
  resourceUrl: string,
  accepted: X402PaymentRequirements,
  error?: string,
): X402PaymentRequired {
  if (CDP_PAYMENT_RESOURCE_DESCRIPTION.length > CDP_PAYMENT_RESOURCE_DESCRIPTION_MAX_CHARACTERS) {
    throw new Error("CDP x402 resource description exceeds the supported 500-character boundary.");
  }
  const required = makeCoreX402PaymentRequired(resourceUrl, accepted, error);
  return {
    ...required,
    resource: {
      ...required.resource,
      description: CDP_PAYMENT_RESOURCE_DESCRIPTION,
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cdpFacilitator(value: CoreFacilitatorInput): CdpFacilitatorInput | null {
  if (
    typeof value === "object" && value !== null &&
    "kind" in value && (value as { kind?: unknown }).kind === "cdp" &&
    "url" in value && typeof (value as { url?: unknown }).url === "string" &&
    "apiKeyId" in value && typeof (value as { apiKeyId?: unknown }).apiKeyId === "string" &&
    "apiKeySecret" in value && typeof (value as { apiKeySecret?: unknown }).apiKeySecret === "string"
  ) return value as CdpFacilitatorInput;
  return null;
}

function responseKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function fieldType(value: Record<string, unknown> | null, key: string): string {
  if (!value || !Object.prototype.hasOwnProperty.call(value, key)) return "missing";
  const field = value[key];
  if (field === null) return "null";
  if (Array.isArray(field)) return "array";
  return typeof field;
}

function sanitizeDiagnosticText(value: unknown): SanitizedDiagnosticText {
  if (typeof value !== "string") return {};
  let sanitized = value
    .trim()
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (sanitized.length === 0) return {};

  sanitized = sanitized
    .replace(/Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/giu, "Bearer [redacted]")
    .replace(/0x[0-9a-fA-F]{64,}/gu, "[redacted]")
    .replace(/[A-Za-z0-9+/_=-]{48,}/gu, "[redacted]");

  const codePoints = Array.from(sanitized);
  if (codePoints.length <= CDP_DIAGNOSTIC_MAX_TEXT_CODE_POINTS) return { value: sanitized };
  return {
    value: codePoints.slice(0, CDP_DIAGNOSTIC_MAX_TEXT_CODE_POINTS).join(""),
    truncated: true,
  };
}

function sanitizedIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

function sanitizedErrorLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    url.search = "";
    url.hash = "";
    const normalized = url.toString();
    return normalized.length <= 512 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCdpKeySecret(value: string): Uint8Array {
  if (value.length === 0 || value.length > 512 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("invalid_cdp_api_key_secret");
  }
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 64) throw new Error("invalid_cdp_api_key_secret");
  return bytes;
}

async function cdpBearerAuthorizationHeader(
  credentials: CdpFacilitatorInput,
  endpoint: string,
): Promise<string> {
  const keyBytes = decodeCdpKeySecret(credentials.apiKeySecret);
  const now = Math.floor(Date.now() / 1000);
  const target = new URL(endpoint);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({
    alg: "EdDSA",
    typ: "JWT",
    kid: credentials.apiKeyId,
    nonce: crypto.randomUUID().replaceAll("-", ""),
  })));
  const claims = base64Url(new TextEncoder().encode(JSON.stringify({
    sub: credentials.apiKeyId,
    iss: "cdp",
    aud: ["cdp_service"],
    nbf: now,
    exp: now + 120,
    uri: `POST ${target.host}${target.pathname}`,
  })));
  const privateKey = await crypto.subtle.importKey("jwk", {
    kty: "OKP",
    crv: "Ed25519",
    d: base64Url(keyBytes.slice(0, 32)),
    x: base64Url(keyBytes.slice(32)),
  }, { name: "Ed25519" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(`${header}.${claims}`),
  ));
  return `Bearer ${header}.${claims}.${base64Url(signature)}`;
}

async function readBoundedDiagnosticJson(response: Response): Promise<DiagnosticReadResult> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > CDP_DIAGNOSTIC_MAX_RESPONSE_BYTES) {
    return { status: "unavailable" };
  }
  if (!response.body) return { status: "unavailable" };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > CDP_DIAGNOSTIC_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return { status: "unavailable" };
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { status: "ok", value: JSON.parse(decoded) };
  } catch {
    return { status: "unavailable" };
  }
}

function firstPresent(body: Record<string, unknown>, camel: string, snake: string): unknown {
  return body[camel] ?? body[snake];
}

async function logInvalidCdpSettlementResponse(
  response: Response,
  requestId: string,
): Promise<void> {
  let clone: Response;
  try {
    clone = response.clone();
  } catch {
    return;
  }

  const read = await readBoundedDiagnosticJson(clone);
  if (read.status !== "ok") return;
  const body = isObject(read.value) ? read.value : null;
  if (
    body &&
    typeof body.success === "boolean" &&
    typeof body.transaction === "string" &&
    typeof body.network === "string"
  ) return;

  const errorType = body
    ? sanitizedIdentifier(firstPresent(body, "errorType", "error_type"))
    : undefined;
  const correlationId = body
    ? sanitizedIdentifier(firstPresent(body, "correlationId", "correlation_id"))
    : undefined;
  const errorMessage = body
    ? sanitizeDiagnosticText(firstPresent(body, "errorMessage", "error_message"))
    : {};
  const errorLink = body
    ? sanitizedErrorLink(firstPresent(body, "errorLink", "error_link"))
    : undefined;

  console.warn("SecondLook CDP settlement invalid response", {
    request_id: requestId,
    http_status: response.status,
    response_kind: responseKind(read.value),
    success_type: fieldType(body, "success"),
    transaction_type: fieldType(body, "transaction"),
    network_type: fieldType(body, "network"),
    ...(errorType ? { error_type: errorType } : {}),
    ...(errorMessage.value ? { error_message: errorMessage.value } : {}),
    ...(errorMessage.truncated ? { error_message_truncated: true } : {}),
    ...(correlationId ? { correlation_id: correlationId } : {}),
    ...(errorLink ? { error_link: errorLink } : {}),
  });
}

function withCdpSettlementBoundary(
  fetcher: typeof fetch,
  requestId: string,
  facilitator: CdpFacilitatorInput,
): typeof fetch {
  return (async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args;
    const settleUrl = `${facilitator.url}/settle`;
    const inputUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    let forwardedInit = init;
    if (inputUrl === settleUrl) {
      const headers = new Headers(init?.headers);
      headers.set("authorization", await cdpBearerAuthorizationHeader(facilitator, settleUrl));
      forwardedInit = {
        ...(init ?? {}),
        headers: Object.fromEntries(headers.entries()),
      };
    }

    const response = await fetcher(input, forwardedInit);
    await logInvalidCdpSettlementResponse(response, requestId);
    return response;
  }) as typeof fetch;
}

// Keep payment-state and settlement semantics in the reviewed core adapter. This public boundary
// only replaces the CDP Authorization header with Coinbase's documented server Bearer JWT and
// observes a cloned CDP response. It never changes the payment body, destination, or retry count.
export class X402FacilitatorAdapter {
  constructor(
    private readonly facilitator: CoreFacilitatorInput,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  attemptAcceptance(input: CoreAttemptInput): CoreAttemptResult {
    const cdp = cdpFacilitator(this.facilitator);
    const fetcher = cdp
      ? withCdpSettlementBoundary(this.fetcher, input.requestId, cdp)
      : this.fetcher;
    return new CoreX402FacilitatorAdapter(this.facilitator, fetcher).attemptAcceptance(input);
  }
}
