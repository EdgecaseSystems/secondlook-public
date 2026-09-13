import { describe, expect, it } from "vitest";
import type { PaymentRequirement } from "../src/payments";
import {
  makeX402PaymentRequired,
  X402FacilitatorAdapter,
  X402_CDP_FACILITATOR,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "../src/x402-core";

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function decodeJwtPart(value: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(value))) as Record<string, unknown>;
}

describe("direct x402 core CDP compatibility", () => {
  it("uses the bounded payment description and documented CDP JWT claims without wrapper repair", async () => {
    const accepted: X402PaymentRequirements = {
      scheme: "exact",
      network: "eip155:8453",
      amount: "50000",
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      payTo: "0x2222222222222222222222222222222222222222",
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: "eip3009", paymentFlow: "upfront", name: "USD Coin", version: "2" },
    };
    const required = makeX402PaymentRequired("https://secondlook.example/v1/paid/second-look", accepted);
    expect(required.resource.description.length).toBeLessThanOrEqual(500);
    expect(required.resource.description).toContain("does not authorize, execute, or supply missing authority");

    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const secret = btoa(String.fromCharCode(...base64UrlDecode(privateJwk.d ?? ""), ...base64UrlDecode(privateJwk.x ?? "")));

    let authorizationHeader = "";
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      authorizationHeader = headers.get("authorization") ?? "";
      return new Response(JSON.stringify({
        success: true,
        payer: "0x3333333333333333333333333333333333333333",
        transaction: `0x${"ef".repeat(32)}`,
        network: accepted.network,
        amount: accepted.amount,
      }), { status: 200 });
    }) as typeof fetch;

    const requirement: PaymentRequirement = {
      provider: "x402-facilitator",
      protocol: "x402-v2-exact-eip3009-upfront",
      amountAtomic: accepted.amount,
      asset: accepted.asset,
      network: accepted.network,
      payTo: accepted.payTo,
      requirementsJson: JSON.stringify(accepted),
    };
    const payload: X402PaymentPayload = {
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
    };

    const adapter = new X402FacilitatorAdapter({
      kind: "cdp",
      url: X402_CDP_FACILITATOR,
      apiKeyId: "test-cdp-key",
      apiKeySecret: secret,
    }, fetcher);
    await expect(adapter.attemptAcceptance({ requestId: "core-regression", requirement, authorization: payload }))
      .resolves.toMatchObject({ outcome: "accepted" });

    const [, claimsPart] = authorizationHeader.replace(/^Bearer /, "").split(".");
    const claims = decodeJwtPart(claimsPart ?? "");
    expect(claims).toMatchObject({
      sub: "test-cdp-key",
      iss: "cdp",
      aud: ["cdp_service"],
      nbf: expect.any(Number),
      exp: expect.any(Number),
      uri: "POST api.cdp.coinbase.com/platform/v2/x402/settle",
    });
    expect(claims).not.toHaveProperty("iat");
    expect(claims).not.toHaveProperty("uris");
  });
});
