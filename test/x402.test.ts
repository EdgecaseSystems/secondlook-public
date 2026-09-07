import { describe, expect, it, vi } from "vitest";
import type { PaymentRequirement } from "../src/payments";
import {
  encodeX402PaymentRequired,
  fingerprintX402PaymentPayload,
  makeX402PaymentRequired,
  parseCdpBazaarObservation,
  parseX402PaymentPayload,
  readX402Configuration,
  X402FacilitatorAdapter,
  X402_BASE_MAINNET,
  X402_BASE_MAINNET_USDC,
  X402_BASE_SEPOLIA,
  X402_CDP_FACILITATOR,
  X402_MAX_BAZAAR_REJECTED_REASON_CODE_POINTS,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "../src/x402";
import type { AppEnv } from "../src/types";

const accepted: X402PaymentRequirements = {
  scheme: "exact",
  network: X402_BASE_SEPOLIA,
  amount: "1000",
  asset: "0x1111111111111111111111111111111111111111",
  payTo: "0x2222222222222222222222222222222222222222",
  maxTimeoutSeconds: 60,
  extra: { assetTransferMethod: "eip3009", paymentFlow: "upfront", name: "USDC", version: "2" },
};

function payload(overrides: Partial<X402PaymentPayload> = {}): X402PaymentPayload {
  const required = makeX402PaymentRequired("https://secondlook.example/v1/paid/second-look", accepted);
  return {
    x402Version: 2,
    resource: required.resource,
    accepted,
    extensions: required.extensions,
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from: "0x3333333333333333333333333333333333333333",
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: "1",
        validBefore: "9999999999",
        nonce: `0x${"cd".repeat(32)}`,
      },
    },
    ...overrides,
  };
}

function encode(value: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function cdpAdapter(fetcher: typeof fetch): Promise<{ adapter: X402FacilitatorAdapter; secret: string }> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const secret = btoa(String.fromCharCode(...base64UrlDecode(privateJwk.d ?? ""), ...base64UrlDecode(privateJwk.x ?? "")));
  return {
    adapter: new X402FacilitatorAdapter({
      kind: "cdp", url: X402_CDP_FACILITATOR, apiKeyId: "test-cdp-key", apiKeySecret: secret,
    }, fetcher),
    secret,
  };
}

function extensionResponses(value: unknown): string {
  return btoa(JSON.stringify(value));
}

function verifyResponse(header: string | null = null): Response {
  return new Response(JSON.stringify({ isValid: true, payer: payload().payload.authorization.from }), {
    status: 200,
    headers: header === null ? undefined : { "EXTENSION-RESPONSES": header },
  });
}

function settleResponse(header: string | null = null): Response {
  return new Response(JSON.stringify({
    success: true, payer: payload().payload.authorization.from, transaction: `0x${"ef".repeat(32)}`,
    network: accepted.network, amount: accepted.amount,
  }), { status: 200, headers: header === null ? undefined : { "EXTENSION-RESPONSES": header } });
}

const requirement: PaymentRequirement = {
  provider: "x402-facilitator",
  protocol: "x402-v2-exact-eip3009-upfront",
  amountAtomic: accepted.amount,
  asset: accepted.asset,
  network: accepted.network,
  payTo: accepted.payTo,
  requirementsJson: JSON.stringify(accepted),
};

describe("x402 v2 protocol boundary", () => {
  it("is disabled without explicit configuration and accepts only the bounded Base Sepolia configuration", () => {
    expect(readX402Configuration({} as AppEnv)).toBeNull();
    const config = readX402Configuration({
      X402_PAID_ENABLED: "true",
      X402_FACILITATOR_URL: "https://x402.org/facilitator",
      X402_NETWORK: X402_BASE_SEPOLIA,
      X402_ASSET: accepted.asset,
      X402_AMOUNT_ATOMIC: accepted.amount,
      X402_PAY_TO: accepted.payTo,
      X402_ASSET_NAME: "USDC",
      X402_ASSET_VERSION: "2",
    } as AppEnv);
    expect(config?.accepted).toEqual(accepted);
    expect(() => readX402Configuration({
      X402_PAID_ENABLED: "true",
      X402_FACILITATOR_URL: "https://x402.org/facilitator",
      X402_NETWORK: "eip155:8453",
      X402_ASSET: accepted.asset,
      X402_AMOUNT_ATOMIC: accepted.amount,
      X402_PAY_TO: accepted.payTo,
      X402_ASSET_NAME: "USDC",
      X402_ASSET_VERSION: "2",
    } as AppEnv)).toThrow(/mainnet paid path/);
    expect(() => readX402Configuration({
      X402_PAID_ENABLED: "true",
      X402_FACILITATOR_URL: X402_CDP_FACILITATOR,
      X402_NETWORK: X402_BASE_SEPOLIA,
      X402_ASSET: accepted.asset,
      X402_AMOUNT_ATOMIC: accepted.amount,
      X402_PAY_TO: accepted.payTo,
      X402_ASSET_NAME: "USDC",
      X402_ASSET_VERSION: "2",
      X402_CDP_API_KEY_ID: "configured-without-secret",
    } as AppEnv)).toThrow(/requires both API key ID and secret/);
    expect(() => readX402Configuration({
      X402_PAID_ENABLED: "true",
      X402_FACILITATOR_URL: "https://unapproved.example/facilitator",
      X402_NETWORK: X402_BASE_SEPOLIA,
      X402_ASSET: accepted.asset,
      X402_AMOUNT_ATOMIC: accepted.amount,
      X402_PAY_TO: accepted.payTo,
      X402_ASSET_NAME: "USDC",
      X402_ASSET_VERSION: "2",
    } as AppEnv)).toThrow(/unapproved facilitator/);
    expect(readX402Configuration({
      X402_PAID_ENABLED: "true",
      X402_FACILITATOR_URL: X402_CDP_FACILITATOR,
      X402_NETWORK: X402_BASE_SEPOLIA,
      X402_ASSET: accepted.asset,
      X402_AMOUNT_ATOMIC: accepted.amount,
      X402_PAY_TO: accepted.payTo,
      X402_ASSET_NAME: "USDC",
      X402_ASSET_VERSION: "2",
      X402_CDP_API_KEY_ID: "test-cdp-key",
      X402_CDP_API_KEY_SECRET: "configured-secret",
    } as AppEnv)?.facilitator).toMatchObject({ kind: "cdp", url: X402_CDP_FACILITATOR, apiKeyId: "test-cdp-key" });
  });

  it("fails closed for Base mainnet except the explicit bounded CDP canary", () => {
    const base = {
      X402_PAID_ENABLED: "true",
      X402_FACILITATOR_URL: X402_CDP_FACILITATOR,
      X402_NETWORK: X402_BASE_MAINNET,
      X402_ASSET: X402_BASE_MAINNET_USDC,
      X402_AMOUNT_ATOMIC: "50000",
      X402_PAY_TO: accepted.payTo,
      X402_ASSET_NAME: "USDC",
      X402_ASSET_VERSION: "2",
      X402_CDP_API_KEY_ID: "test-cdp-key",
      X402_CDP_API_KEY_SECRET: "configured-secret",
      X402_MAINNET_CANARY_ENABLED: "true",
      X402_CANARY_PAYER: payload().payload.authorization.from,
      X402_DAILY_SETTLEMENT_LIMIT: "10",
      X402_DAILY_ACCEPTED_PAYMENT_LIMIT: "8",
      X402_DAILY_SETTLED_ATOMIC_LIMIT: "500000",
      X402_MONTHLY_FACILITATOR_LIMIT: "25",
      X402_DAILY_PAID_INFERENCE_LIMIT: "6",
    } satisfies Partial<AppEnv>;
    const config = readX402Configuration(base as AppEnv);
    expect(config).toMatchObject({
      canaryPayer: payload().payload.authorization.from,
      accepted: { network: X402_BASE_MAINNET, amount: "50000", asset: X402_BASE_MAINNET_USDC },
      commercialLimits: {
        dailySettlementLimit: 10,
        dailyAcceptedPaymentLimit: 8,
        dailySettledAtomicLimit: 500000,
        monthlyFacilitatorLimit: 25,
        dailyPaidInferenceLimit: 6,
      },
    });
    expect(readX402Configuration({ ...base, X402_AMOUNT_ATOMIC: "100000" } as AppEnv)?.accepted.amount).toBe("100000");
    expect(() => readX402Configuration({ ...base, X402_AMOUNT_ATOMIC: "100001" } as AppEnv)).toThrow(/bounded CDP canary/);
    expect(() => readX402Configuration({ ...base, X402_MAINNET_CANARY_ENABLED: "false" } as AppEnv)).toThrow(/bounded CDP canary/);
    expect(() => readX402Configuration({ ...base, X402_ASSET: accepted.asset } as AppEnv)).toThrow(/bounded CDP canary/);
    expect(() => readX402Configuration({ ...base, X402_FACILITATOR_URL: "https://x402.org/facilitator", X402_CDP_API_KEY_ID: undefined, X402_CDP_API_KEY_SECRET: undefined } as AppEnv)).toThrow(/bounded CDP canary/);
    for (const key of [
      "X402_DAILY_SETTLEMENT_LIMIT",
      "X402_DAILY_ACCEPTED_PAYMENT_LIMIT",
      "X402_DAILY_SETTLED_ATOMIC_LIMIT",
      "X402_MONTHLY_FACILITATOR_LIMIT",
      "X402_DAILY_PAID_INFERENCE_LIMIT",
    ] as const) {
      expect(() => readX402Configuration({ ...base, [key]: undefined } as AppEnv)).toThrow(/canonical positive integer/);
      expect(() => readX402Configuration({ ...base, [key]: "0" } as AppEnv)).toThrow(/canonical positive integer/);
      expect(() => readX402Configuration({ ...base, [key]: "-1" } as AppEnv)).toThrow(/canonical positive integer/);
      expect(() => readX402Configuration({ ...base, [key]: "01" } as AppEnv)).toThrow(/canonical positive integer/);
      expect(() => readX402Configuration({ ...base, [key]: " 1" } as AppEnv)).toThrow(/canonical positive integer/);
    }
  });

  it("emits the official V2 payment-required shape and strictly binds a payment payload", async () => {
    const required = makeX402PaymentRequired("https://secondlook.example/v1/paid/second-look", accepted);
    const encoded = encodeX402PaymentRequired(required);
    expect(JSON.parse(atob(encoded))).toMatchObject({ x402Version: 2, accepts: [accepted] });

    const parsed = parseX402PaymentPayload(encode(payload()), required);
    expect(parsed).toEqual(payload());
    await expect(fingerprintX402PaymentPayload(parsed)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["65-byte EOA", 65],
    ["variable-length smart-account", 160],
  ])("accepts an opaque %s signature for facilitator verification", (_kind, byteLength) => {
    const required = makeX402PaymentRequired("https://secondlook.example/v1/paid/second-look", accepted);
    const proof = payload();
    proof.payload.signature = `0x${"ab".repeat(byteLength)}`;

    expect(parseX402PaymentPayload(encode(proof), required).payload.signature).toBe(proof.payload.signature);
  });

  it.each([
    ["empty", "0x"],
    ["odd-length", "0xabc"],
    ["non-hex", "0xzz"],
  ])("rejects a structurally malformed %s EVM signature", (_kind, signature) => {
    const required = makeX402PaymentRequired("https://secondlook.example/v1/paid/second-look", accepted);
    const proof = payload();
    proof.payload.signature = signature;

    expect(() => parseX402PaymentPayload(encode(proof), required)).toThrow(/exact EVM payment payload/);
  });

  it("declares Bazaar POST discovery metadata with the current public request and response contract", () => {
    const required = makeX402PaymentRequired("https://secondlook.example/v1/paid/second-look", accepted);
    const bazaar = (required.extensions as Record<string, Record<string, Record<string, unknown>>>).bazaar;
    const info = bazaar.info as Record<string, Record<string, unknown>>;
    const schema = bazaar.schema as Record<string, unknown>;
    const input = info.input as Record<string, unknown>;
    const output = info.output as Record<string, unknown>;
    const inputSchema = ((schema.properties as Record<string, Record<string, unknown>>).input.properties as Record<string, Record<string, unknown>>).body;
    const outputSchema = ((schema.properties as Record<string, Record<string, unknown>>).output.properties as Record<string, Record<string, unknown>>).example;

    expect(required.resource).toMatchObject({
      serviceName: "SecondLook",
      tags: ["ai", "agent", "review", "pre-action", "decision-support"],
    });
    expect(required.resource.description).toContain("does not authorize, execute, or supply missing authority");
    expect(input).toMatchObject({ type: "http", method: "POST", bodyType: "json" });
    expect(input.body).toMatchObject({ goal: expect.any(String), proposed_action: expect.any(String) });
    expect(inputSchema).toMatchObject({ required: ["goal", "proposed_action"] });
    expect((inputSchema.properties as Record<string, unknown>).constraint_context).toBeDefined();
    expect(inputSchema.allOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ not: expect.objectContaining({ required: ["constraint_context", "hard_constraints"] }) }),
      expect.objectContaining({ not: expect.objectContaining({ required: ["constraint_context", "important_constraints"] }) }),
    ]));
    expect(output).toMatchObject({ type: "json" });
    expect(outputSchema).toMatchObject({ required: expect.arrayContaining(["decision_id", "review_status", "reason"]) });
  });

  it("publishes expressible structural rules and explicit runtime semantic invariants", () => {
    const required = makeX402PaymentRequired("https://secondlook.example/v1/paid/second-look", accepted);
    const bazaar = (required.extensions as Record<string, Record<string, Record<string, unknown>>>).bazaar;
    const schema = bazaar.schema as Record<string, any>;
    const inputSchema = schema.properties.input.properties.body as Record<string, any>;
    const context = inputSchema.properties.constraint_context as Record<string, any>;
    const constraintItems = context.properties.constraints.items as Record<string, any>;
    const semantic = inputSchema["x-secondlook-semantic-validation"] as Record<string, any>;
    const invariantIds = semantic.invariants.map((item: Record<string, unknown>) => item.id);

    expect(inputSchema.properties.goal).toMatchObject({ minLength: 1, maxLength: 4000, pattern: "\\S" });
    expect(context.properties.constraints.uniqueItems).toBe(true);
    expect(context.properties.conflict_groups.uniqueItems).toBe(true);
    expect(constraintItems.allOf).toHaveLength(2);
    expect(semantic).toMatchObject({ additional_runtime_validation_required: true, runtime_is_authoritative: true });
    expect(invariantIds).toEqual(expect.arrayContaining([
      "aggregate_request_text",
      "aggregate_constraint_text",
      "unique_constraint_ids",
      "unique_conflict_group_ids",
      "conflict_group_references",
      "single_conflict_group_membership",
      "established_controller",
      "independently_binding_members",
    ]));
  });

  it("returns fresh PaymentRequired and Bazaar metadata for every build", () => {
    const first = makeX402PaymentRequired("https://secondlook.example/v1/paid/second-look", accepted);
    first.accepts[0].amount = "9999";
    const firstBazaar = (first.extensions as Record<string, any>).bazaar;
    firstBazaar.info.input.body.goal = "mutated";
    firstBazaar.schema.properties.input.properties.body.properties.goal.maxLength = 1;
    firstBazaar.schema.properties.input.properties.body["x-secondlook-semantic-validation"].invariants.length = 0;

    const second = makeX402PaymentRequired("https://secondlook.example/v1/paid/second-look", accepted);
    const secondBazaar = (second.extensions as Record<string, any>).bazaar;
    expect(accepted.amount).toBe("1000");
    expect(second.accepts[0].amount).toBe("1000");
    expect(secondBazaar.info.input.body.goal).toBe("Review a proposed customer refund before execution.");
    expect(secondBazaar.schema.properties.input.properties.body.properties.goal.maxLength).toBe(4000);
    expect(secondBazaar.schema.properties.input.properties.body["x-secondlook-semantic-validation"].invariants.length).toBeGreaterThan(0);
  });

  it("does not expose CDP configuration in public Bazaar metadata", () => {
    const encoded = encodeX402PaymentRequired(makeX402PaymentRequired("https://secondlook.example/v1/paid/second-look", accepted));
    expect(atob(encoded)).not.toContain("X402_CDP_API_KEY_SECRET");
    expect(atob(encoded)).not.toContain("configured-without-secret");
  });

  it("rejects malformed and wrong-recipient/amount/network bindings before a facilitator can see them", () => {
    const required = makeX402PaymentRequired("https://secondlook.example/v1/paid/second-look", accepted);
    expect(() => parseX402PaymentPayload("not base64", required))
      .toThrow(/Base64/);
    const wrongAmount = payload({ accepted: { ...accepted, amount: "1001" } });
    expect(() => parseX402PaymentPayload(encode(wrongAmount), required))
      .toThrow(/does not match/);
    const wrongRecipient = payload({
      payload: {
        ...payload().payload,
        authorization: { ...payload().payload.authorization, to: "0x4444444444444444444444444444444444444444" },
      },
    });
    expect(() => parseX402PaymentPayload(encode(wrongRecipient), required))
      .toThrow(/does not match/);
  });

  it.each([
    ["omitted resource", (proof: X402PaymentPayload) => { delete (proof as unknown as { resource?: unknown }).resource; }],
    ["changed resource description", (proof: X402PaymentPayload) => { proof.resource.description = "changed"; }],
    ["changed resource service name", (proof: X402PaymentPayload) => { proof.resource.serviceName = "changed"; }],
    ["removed resource tag", (proof: X402PaymentPayload) => { proof.resource.tags = proof.resource.tags?.slice(1); }],
    ["added resource tag", (proof: X402PaymentPayload) => { proof.resource.tags = [...(proof.resource.tags ?? []), "added"]; }],
    ["reordered resource tags", (proof: X402PaymentPayload) => { proof.resource.tags = [...(proof.resource.tags ?? [])].reverse(); }],
    ["changed resource MIME type", (proof: X402PaymentPayload) => { proof.resource.mimeType = "text/plain"; }],
    ["added resource icon URL", (proof: X402PaymentPayload) => { proof.resource.iconUrl = "https://example.invalid/icon"; }],
    ["omitted Bazaar declaration", (proof: X402PaymentPayload) => { delete proof.extensions.bazaar; }],
    ["changed Bazaar info", (proof: X402PaymentPayload) => { ((proof.extensions.bazaar as Record<string, Record<string, unknown>>).info.input as Record<string, unknown>).method = "GET"; }],
    ["changed Bazaar schema", (proof: X402PaymentPayload) => { ((proof.extensions.bazaar as Record<string, unknown>).schema as Record<string, unknown>).additionalProperties = true; }],
    ["changed Bazaar input example", (proof: X402PaymentPayload) => { ((proof.extensions.bazaar as Record<string, Record<string, unknown>>).info.input as Record<string, Record<string, unknown>>).body.goal = "changed"; }],
    ["changed Bazaar output example", (proof: X402PaymentPayload) => { ((proof.extensions.bazaar as Record<string, Record<string, unknown>>).info.output as Record<string, Record<string, unknown>>).example.reason = "changed"; }],
    ["added Bazaar-level field", (proof: X402PaymentPayload) => { (proof.extensions.bazaar as Record<string, unknown>).routeTemplate = "/different"; }],
  ])("rejects %s as a local canonical metadata-binding failure", (_name, mutate) => {
    const required = makeX402PaymentRequired("https://secondlook.example/v1/paid/second-look", accepted);
    const proof = structuredClone(payload());
    mutate(proof);
    expect(() => parseX402PaymentPayload(encode(proof), required)).toThrow(/does not match|must include|resource tags/);
  });

  it("permits unknown top-level extensions but fingerprints them", async () => {
    const required = makeX402PaymentRequired("https://secondlook.example/v1/paid/second-look", accepted);
    const base = parseX402PaymentPayload(encode(payload()), required);
    const withUnknown = payload({ extensions: { ...payload().extensions, future_extension: { opaque: "untrusted" } } });
    const parsed = parseX402PaymentPayload(encode(withUnknown), required);
    expect(parsed.extensions.future_extension).toEqual({ opaque: "untrusted" });
    await expect(fingerprintX402PaymentPayload(parsed)).resolves.not.toEqual(await fingerprintX402PaymentPayload(base));
  });

  it("uses exactly one settle operation and no verify for x402.org upfront acceptance", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        payer: payload().payload.authorization.from,
        transaction: `0x${"ef".repeat(32)}`,
        network: accepted.network,
        amount: accepted.amount,
      }), { status: 200 }));
    const adapter = new X402FacilitatorAdapter("https://x402.org/facilitator", fetcher);
    const result = await adapter.attemptAcceptance({ requestId: "request-1", requirement, authorization: payload() });
    expect(result).toMatchObject({ outcome: "accepted", externalReference: `0x${"ef".repeat(32)}` });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["https://x402.org/facilitator/settle"]);
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).redirect).toBe("manual");
    if (result.outcome !== "accepted") throw new Error("expected accepted settlement");
    expect(result.verifiedAt).toBe(result.settledAt);
  });

  it("uses a short-lived CDP JWT only for post-proof facilitator calls", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
        success: true, payer: payload().payload.authorization.from, transaction: `0x${"ef".repeat(32)}`,
        network: accepted.network, amount: accepted.amount,
      }), { status: 200 }));
    const { adapter, secret } = await cdpAdapter(fetcher);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(adapter.attemptAcceptance({ requestId: "request-cdp", requirement, authorization: payload() }))
      .resolves.toMatchObject({ outcome: "accepted" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${X402_CDP_FACILITATOR}/settle`);
    for (const [, init] of fetcher.mock.calls) {
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.authorization).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(headers.authorization).not.toContain(secret);
      const [encodedHeader, encodedClaims] = headers.authorization.slice("Bearer ".length).split(".");
      const jwtHeader = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedHeader)));
      const jwtClaims = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedClaims)));
      expect(jwtHeader).toMatchObject({ alg: "EdDSA", typ: "JWT", kid: "test-cdp-key" });
      expect(jwtHeader.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(jwtClaims).toMatchObject({
        sub: "test-cdp-key",
        iss: "cdp",
        uris: [`POST api.cdp.coinbase.com/platform/v2/x402/settle`],
      });
      expect(jwtClaims.iat).toBe(jwtClaims.nbf);
      expect(jwtClaims.exp).toBe(jwtClaims.iat + 120);
      expect(jwtClaims).not.toHaveProperty("aud");
      expect(jwtClaims).not.toHaveProperty("uri");
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(payload().payload.signature);
    log.mockRestore();
  });

  it("parses only bounded documented CDP Bazaar observations", () => {
    expect(parseCdpBazaarObservation("request-1", "verify", null)).toEqual({
      request_id: "request-1", phase: "verify", response_received: true, parse_status: "not_observed",
    });
    expect(parseCdpBazaarObservation("request-1", "settle", null)).toEqual({
      request_id: "request-1", phase: "settle", response_received: true, parse_status: "not_observed",
    });
    expect(parseCdpBazaarObservation("request-1", "settle", extensionResponses({ bazaar: { status: "success" } }))).toMatchObject({
      phase: "settle", parse_status: "observed", status: "success",
    });
    expect(parseCdpBazaarObservation("request-1", "verify", extensionResponses({ bazaar: { status: "processing" } }))).toMatchObject({
      phase: "verify", parse_status: "observed", status: "processing",
    });
    expect(parseCdpBazaarObservation("request-1", "settle", extensionResponses({ bazaar: { status: "rejected", rejectedReason: "bad\r\nreason\u0000\u007f" } }))).toMatchObject({
      parse_status: "observed", status: "rejected", rejected_reason: "bad  reason",
    });
    expect(parseCdpBazaarObservation("request-1", "settle", extensionResponses({ bazaar: { status: "rejected", rejectedReason: "x".repeat(300) } }))).toMatchObject({
      rejected_reason: "x".repeat(X402_MAX_BAZAAR_REJECTED_REASON_CODE_POINTS), rejected_reason_truncated: true,
    });
    expect(parseCdpBazaarObservation("request-1", "verify", "%%%=")).toMatchObject({ parse_status: "malformed" });
    expect(parseCdpBazaarObservation("request-1", "verify", "/w==")).toMatchObject({ parse_status: "malformed" });
    expect(parseCdpBazaarObservation("request-1", "verify", btoa("not json"))).toMatchObject({ parse_status: "malformed" });
    expect(parseCdpBazaarObservation("request-1", "verify", extensionResponses([]))).toMatchObject({ parse_status: "malformed" });
    expect(parseCdpBazaarObservation("request-1", "verify", extensionResponses({ other: { secret: "ignored" } }))).toMatchObject({ parse_status: "not_observed" });
    expect(parseCdpBazaarObservation("request-1", "verify", extensionResponses({ bazaar: { status: "unknown", secret: "ignored" } }))).toMatchObject({ parse_status: "unsupported" });
    expect(parseCdpBazaarObservation("request-1", "verify", extensionResponses({ other: { secret: "ignored" }, bazaar: { status: "success", nonce: "ignored" } }))).toEqual({
      request_id: "request-1", phase: "verify", response_received: true, parse_status: "observed", status: "success",
    });
    expect(parseCdpBazaarObservation("request-1", "verify", "a".repeat(16_385))).toMatchObject({ parse_status: "oversized" });
  });

  it.each(["success", "processing", "rejected"] as const)("logs only the actual CDP settle Bazaar %s observation without changing acceptance", async (status) => {
    const fetcher = vi.fn().mockResolvedValueOnce(settleResponse(extensionResponses({ bazaar: { status } })));
    const { adapter } = await cdpAdapter(fetcher);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(adapter.attemptAcceptance({ requestId: "request-cdp-observation", requirement, authorization: payload() }))
      .resolves.toMatchObject({ outcome: "accepted" });
    const observations = log.mock.calls.filter(([event]) => event === "SecondLook CDP Bazaar observation").map(([, value]) => value);
    expect(observations).toEqual([
      expect.objectContaining({ request_id: "request-cdp-observation", phase: "settle", response_received: true, parse_status: "observed", status }),
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it("tolerates absent or malformed CDP observation metadata without retries or payment ambiguity", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(settleResponse("%%%="));
    const { adapter, secret } = await cdpAdapter(fetcher);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(adapter.attemptAcceptance({ requestId: "request-cdp-malformed", requirement, authorization: payload() }))
      .resolves.toMatchObject({ outcome: "accepted" });
    const observations = log.mock.calls.filter(([event]) => event === "SecondLook CDP Bazaar observation").map(([, value]) => value as Record<string, unknown>);
    expect(observations).toEqual([expect.objectContaining({ phase: "settle", response_received: true, parse_status: "malformed" })]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain("%%%=");
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(payload().payload.signature);
    log.mockRestore();
  });

  it("records a CDP phase with no HTTP response without retrying or fabricating settlement", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline-secret-detail"));
    const { adapter, secret } = await cdpAdapter(fetcher);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(adapter.attemptAcceptance({ requestId: "request-cdp-no-response", requirement, authorization: payload() }))
      .resolves.toMatchObject({ outcome: "ambiguous", failureCode: "payment_settlement_outcome_unknown" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(log.mock.calls).toContainEqual([
      "SecondLook CDP Bazaar observation",
      expect.objectContaining({ request_id: "request-cdp-no-response", phase: "settle", response_received: false, parse_status: "not_observed" }),
    ]);
    expect(warn).toHaveBeenCalledWith("SecondLook x402 facilitator failure", expect.objectContaining({
      request_id: "request-cdp-no-response", facilitator_kind: "cdp", phase: "request",
      failure_kind: "transport", response_received: false,
    }));
    const emitted = JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
    expect(emitted).not.toContain("offline-secret-detail");
    expect(emitted).not.toContain(secret);
    expect(emitted).not.toContain(payload().payload.signature);
    expect(log.mock.calls.some(([, observation]) => (observation as Record<string, unknown> | undefined)?.phase === "verify")).toBe(false);
    log.mockRestore();
    warn.mockRestore();
  });

  it("classifies a CDP authorization setup failure as pre-contact without attempting settlement", async () => {
    const fetcher = vi.fn();
    const adapter = new X402FacilitatorAdapter({
      kind: "cdp", url: X402_CDP_FACILITATOR, apiKeyId: "test-cdp-key", apiKeySecret: "invalid-secret",
    }, fetcher);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(adapter.attemptAcceptance({ requestId: "request-cdp-auth-failure", requirement, authorization: payload() }))
      .resolves.toEqual({ outcome: "failed", failureCode: "payment_facilitator_authorization_failed" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("SecondLook CDP Bazaar observation", expect.objectContaining({
      request_id: "request-cdp-auth-failure", response_received: false,
    }));
    expect(warn).toHaveBeenCalledWith("SecondLook x402 facilitator failure", expect.objectContaining({
      request_id: "request-cdp-auth-failure", facilitator_kind: "cdp", phase: "authorization",
      failure_kind: "authorization_setup", response_received: false,
    }));
    expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls])).not.toContain("invalid-secret");
    log.mockRestore();
    warn.mockRestore();
  });

  it("keeps an unreadable CDP response ambiguous without contradicting the observed response", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("not-json", { status: 502 }));
    const { adapter } = await cdpAdapter(fetcher);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(adapter.attemptAcceptance({ requestId: "request-cdp-invalid-body", requirement, authorization: payload() }))
      .resolves.toEqual({ outcome: "ambiguous", failureCode: "payment_settlement_outcome_unknown" });
    expect(fetcher).toHaveBeenCalledOnce();
    const observations = log.mock.calls.filter(([event]) => event === "SecondLook CDP Bazaar observation");
    expect(observations).toEqual([["SecondLook CDP Bazaar observation", expect.objectContaining({
      request_id: "request-cdp-invalid-body", response_received: true,
    })]]);
    expect(warn).toHaveBeenCalledWith("SecondLook x402 facilitator failure", expect.objectContaining({
      request_id: "request-cdp-invalid-body", phase: "response_body", failure_kind: "response_invalid_json",
      response_received: true, http_status: 502,
    }));
    log.mockRestore();
    warn.mockRestore();
  });

  it("leaves the x402.org adapter path free of CDP Bazaar logging", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(settleResponse(extensionResponses({ bazaar: { status: "rejected", rejectedReason: "ignored" } })));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(new X402FacilitatorAdapter("https://x402.org/facilitator", fetcher)
      .attemptAcceptance({ requestId: "request-x402-org", requirement, authorization: payload() }))
      .resolves.toMatchObject({ outcome: "accepted" });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it.each([
    ["missing payer", { payer: undefined }, "payment_settlement_missing_payer"],
    ["malformed payer", { payer: "not-an-address" }, "payment_settlement_missing_payer"],
    ["payer mismatch", { payer: "0x4444444444444444444444444444444444444444" }, "payment_settlement_payer_mismatch"],
    ["network mismatch", { network: "eip155:8453" }, "payment_settlement_network_mismatch"],
    ["amount mismatch", { amount: "1001" }, "payment_settlement_amount_mismatch"],
    ["invalid transaction", { transaction: "not-a-transaction" }, "payment_settlement_missing_transaction"],
  ])("makes successful settlement with %s ambiguous without retry", async (_name, overrides, failureCode) => {
    const settlement = { success: true, payer: payload().payload.authorization.from, transaction: `0x${"ef".repeat(32)}`, network: accepted.network, amount: accepted.amount, ...overrides };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(settlement), { status: 200 }));
    await expect(new X402FacilitatorAdapter("https://x402.org/facilitator", fetcher)
      .attemptAcceptance({ requestId: "request-4", requirement, authorization: payload() }))
      .resolves.toMatchObject({ outcome: "ambiguous", failureCode });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("makes a transport failure after the one settle call ambiguous without retrying", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(new X402FacilitatorAdapter("https://x402.org/facilitator", fetcher)
      .attemptAcceptance({ requestId: "request-settle-timeout", requirement, authorization: payload() }))
      .resolves.toMatchObject({ outcome: "ambiguous", failureCode: "payment_settlement_outcome_unknown" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("SecondLook x402 facilitator failure", expect.objectContaining({
      facilitator_kind: "x402_org", phase: "request", failure_kind: "transport", response_received: false,
    }));
    warn.mockRestore();
  });

  it("classifies facilitator content rather than HTTP status alone", async () => {
    const definitive = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      success: false, transaction: "", network: accepted.network,
      payer: payload().payload.authorization.from, amount: accepted.amount, errorReason: "insufficient_funds",
    }), { status: 400 }));
    await expect(new X402FacilitatorAdapter("https://x402.org/facilitator", definitive)
      .attemptAcceptance({ requestId: "request-definitive", requirement, authorization: payload() }))
      .resolves.toMatchObject({ outcome: "failed", failureCode: "insufficient_funds" });

    const generic = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ errorType: "bad_gateway", errorMessage: "Try later" }), { status: 400 }));
    await expect(new X402FacilitatorAdapter("https://x402.org/facilitator", generic)
      .attemptAcceptance({ requestId: "request-generic", requirement, authorization: payload() }))
      .resolves.toMatchObject({ outcome: "ambiguous", failureCode: "payment_settlement_invalid_response" });

    const contradictory = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      success: false, transaction: `0x${"ef".repeat(32)}`, network: accepted.network,
      payer: payload().payload.authorization.from, amount: accepted.amount, errorReason: "insufficient_funds",
    }), { status: 400 }));
    await expect(new X402FacilitatorAdapter("https://x402.org/facilitator", contradictory)
      .attemptAcceptance({ requestId: "request-contradictory", requirement, authorization: payload() }))
      .resolves.toMatchObject({ outcome: "ambiguous", externalReference: `0x${"ef".repeat(32)}` });

    for (const status of [408, 425, 429, 500, 503]) {
      const uncertain = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
        success: false, transaction: "", network: accepted.network,
        payer: payload().payload.authorization.from, amount: accepted.amount, errorReason: "insufficient_funds",
      }), { status }));
      await expect(new X402FacilitatorAdapter("https://x402.org/facilitator", uncertain)
        .attemptAcceptance({ requestId: `request-http-${status}`, requirement, authorization: payload() }))
        .resolves.toMatchObject({ outcome: "ambiguous", failureCode: "payment_settlement_http_uncertain" });
      expect(uncertain).toHaveBeenCalledOnce();
    }

    const successOnError = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      success: true, transaction: `0x${"ef".repeat(32)}`, network: accepted.network,
      payer: payload().payload.authorization.from, amount: accepted.amount,
    }), { status: 503 }));
    await expect(new X402FacilitatorAdapter("https://x402.org/facilitator", successOnError)
      .attemptAcceptance({ requestId: "request-success-http-error", requirement, authorization: payload() }))
      .resolves.toMatchObject({ outcome: "ambiguous", failureCode: "payment_settlement_http_uncertain" });
  });
});
