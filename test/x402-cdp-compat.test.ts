import { describe, expect, it } from "vitest";
import type { PaymentRequirement } from "../src/payments";
import {
  makeX402PaymentRequired,
  X402FacilitatorAdapter,
  X402_BASE_SEPOLIA,
  X402_CDP_FACILITATOR,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "../src/x402";

const accepted: X402PaymentRequirements = {
  scheme: "exact",
  network: X402_BASE_SEPOLIA,
  amount: "1000",
  asset: "0x1111111111111111111111111111111111111111",
  payTo: "0x2222222222222222222222222222222222222222",
  maxTimeoutSeconds: 60,
  extra: { assetTransferMethod: "eip3009", paymentFlow: "upfront", name: "USDC", version: "2" },
};

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function decodeJwtPart(value: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(value))) as Record<string, unknown>;
}

async function cdpSecret(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const bytes = [...base64UrlDecode(privateJwk.d ?? ""), ...base64UrlDecode(privateJwk.x ?? "")];
  return btoa(String.fromCharCode(...bytes));
}

describe("CDP x402 compatibility boundary", () => {
  it("keeps payment-resource metadata within the current CDP 500-character boundary", () => {
    const required = makeX402PaymentRequired("https://secondlook.example/v1/paid/second-look", accepted);

    expect(required.resource.description.length).toBeLessThanOrEqual(500);
    expect(required.resource.description).toContain("does not authorize, execute, or supply missing authority");
  });

  it("uses the documented CDP server Bearer JWT claims for settlement", async () => {
    const requirement: PaymentRequirement = {
      provider: "x402-facilitator",
      protocol: "x402-v2-exact-eip3009-upfront",
      amountAtomic: accepted.amount,
      asset: accepted.asset,
      network: accepted.network,
      payTo: accepted.payTo,
      requirementsJson: JSON.stringify(accepted),
    };
    const authorization: X402PaymentPayload = {
      x402Version: 2,
      resource: makeX402PaymentRequired("https://secondlook.example/v1/paid/second-look", accepted).resource,
      accepted,
      extensions: {},
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

    let observedAuthorization = "";
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({
        success: true,
        payer: authorization.payload.authorization.from,
        transaction: `0x${"ef".repeat(32)}`,
        network: accepted.network,
        amount: accepted.amount,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const adapter = new X402FacilitatorAdapter({
      kind: "cdp",
      url: X402_CDP_FACILITATOR,
      apiKeyId: "test-cdp-key",
      apiKeySecret: await cdpSecret(),
    }, fetcher);

    await expect(adapter.attemptAcceptance({ requestId: crypto.randomUUID(), requirement, authorization }))
      .resolves.toMatchObject({ outcome: "accepted" });

    const token = observedAuthorization.replace(/^Bearer\s+/u, "");
    const [headerPart, claimsPart] = token.split(".");
    const header = decodeJwtPart(headerPart ?? "");
    const claims = decodeJwtPart(claimsPart ?? "");

    expect(header).toMatchObject({ alg: "EdDSA", typ: "JWT", kid: "test-cdp-key" });
    expect(claims).toMatchObject({
      sub: "test-cdp-key",
      iss: "cdp",
      aud: ["cdp_service"],
      uri: "POST api.cdp.coinbase.com/platform/v2/x402/settle",
    });
    expect(claims).not.toHaveProperty("iat");
    expect(claims).not.toHaveProperty("uris");
  });
});
