import { publicBuyerGuide } from "./buyer-guide";
import { POLICY_VERSION } from "./judgment";
import {
  PUBLIC_AGENT_DESCRIPTION,
  publicCommercialEligibleRegions,
  SERVICE_USE_COUNTRY_HEADER,
  SERVICE_USE_REGION_HEADER,
} from "./public-mainnet";
import {
  makeSecondLookRequestExample,
  makeSecondLookRequestSchema,
  makeSecondLookResponseExample,
  makeSecondLookResponseSchema,
  X402_PAYMENT_SIGNATURE_HEADER,
} from "./x402";

export const PUBLIC_OPENAPI_PATH = "/openapi.json";
export const PUBLIC_MANIFEST_PATH = "/.well-known/secondlook.json";
export const PUBLIC_PAID_PATH = "/v1/paid/second-look";

export function publicServiceIndex(origin: string): Record<string, unknown> {
  return {
    service: "SecondLook",
    description: PUBLIC_AGENT_DESCRIPTION,
    buyer_guide: publicBuyerGuide(),
    invariant: "SecondLook never supplies missing authority.",
    manifest_url: `${origin}${PUBLIC_MANIFEST_PATH}`,
    openapi_url: `${origin}${PUBLIC_OPENAPI_PATH}`,
    paid_endpoint_url: `${origin}${PUBLIC_PAID_PATH}`,
    notices: {
      terms_url: `${origin}/terms`,
      privacy_url: `${origin}/privacy`,
      support_url: `${origin}/support`,
    },
  };
}

export function publicOpenApiDocument(origin: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "SecondLook Public Paid API",
      version: "0.2.0",
      description: `${PUBLIC_AGENT_DESCRIPTION} SecondLook is not authorization or execution, and review results are not guarantees of correctness.`,
    },
    "x-buyer-guide": publicBuyerGuide(),
    servers: [{ url: origin }],
    externalDocs: { description: "SecondLook machine-readable service manifest", url: `${origin}${PUBLIC_MANIFEST_PATH}` },
    paths: {
      [PUBLIC_PAID_PATH]: {
        post: {
          operationId: "requestPaidSecondLook",
          summary: "Get a second opinion before your agent commits to an action",
          description: "Use before an external action such as sending a customer message, changing production settings, or issuing a refund when a separate review of a costly, external, irreversible, or constraint-sensitive action could change your next step. Skip trivial/reversible actions when another review adds no value. See x-buyer-guide for prerequisites, integration steps, and paired illustrative examples of a useful catch and a supported action. Receive one of four review statuses with a reason, key risks, and missing information. An unsigned POST obtains deterministic x402 V2 payment requirements. A payment-bearing retry must include every required header and a valid SecondLook JSON body. Payment authorizes processing only; it does not authorize or execute the proposed action.",
          "x-secondlook-payment-retry": {
            required_headers: {
              "Content-Type": "application/json",
              [X402_PAYMENT_SIGNATURE_HEADER]: "Base64-encoded x402 V2 PaymentPayload",
              "Idempotency-Key": "UUIDv4",
              [SERVICE_USE_COUNTRY_HEADER]: "US",
              [SERVICE_USE_REGION_HEADER]: "one eligible_regions value",
            },
            eligible_regions: publicCommercialEligibleRegions(),
            automatic_payment_retry: false,
            automatic_inference_retry: false,
          },
          parameters: [
            {
              name: X402_PAYMENT_SIGNATURE_HEADER, in: "header", required: false,
              description: "Required on the payment-bearing retry; omit only to obtain PAYMENT-REQUIRED.",
              schema: { type: "string", minLength: 1 },
            },
            {
              name: "Idempotency-Key", in: "header", required: false,
              description: "Required on the payment-bearing retry; must be a UUIDv4. Not required for unsigned negotiation. To recover or replay an existing paid lifecycle, resend the same semantically equivalent structured request and UUIDv4 without PAYMENT-SIGNATURE; JSON formatting and object-key order may differ, and settlement is never repeated.",
              schema: { type: "string", format: "uuid", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" },
            },
            {
              name: SERVICE_USE_COUNTRY_HEADER, in: "header", required: false,
              description: "Required on a new public-mainnet payment-bearing retry.",
              schema: { type: "string", const: "US" },
            },
            {
              name: SERVICE_USE_REGION_HEADER, in: "header", required: false,
              description: "Required on a new public-mainnet payment-bearing retry. Use the two-letter service-use state code or DC.",
              schema: { type: "string", enum: publicCommercialEligibleRegions() },
            },
          ],
          requestBody: {
            required: false,
            description: "Required and validated on the payment-bearing retry and on signature-free recovery/replay of an existing lifecycle; may be omitted for unsigned x402 negotiation.",
            content: { "application/json": { schema: makeSecondLookRequestSchema(), example: makeSecondLookRequestExample() } },
          },
          responses: {
            "200": {
              description: "Durable review result. All four review statuses are valid fulfilled results.",
              headers: {
                "PAYMENT-RESPONSE": { description: "Base64-encoded x402 V2 SettlementResponse.", schema: { type: "string" } },
                "Idempotency-Replayed": { description: "true when returning the exact durable completed replay.", schema: { type: "string", const: "true" } },
                "X-SecondLook-Payment-State": { description: "Present as ambiguous when SecondLook honors one review without claiming uncertain settlement succeeded.", schema: { type: "string", const: "ambiguous" } },
                "X-SecondLook-Ambiguity-Honored": { description: "Present as true when this result is the one bounded public-mainnet ambiguity fulfillment. PAYMENT-RESPONSE is omitted.", schema: { type: "string", const: "true" } },
              },
              content: { "application/json": { schema: makeSecondLookResponseSchema(), example: makeSecondLookResponseExample() } },
            },
            "400": { description: "Malformed request or missing paid-retry integration header." },
            "402": { description: "Payment required. Read the PAYMENT-REQUIRED header for the canonical x402 V2 requirements, resource, and Bazaar declaration." },
            "403": { description: "Public paid service is unavailable in the declared or observed region." },
            "409": { description: "Payment, proof, idempotency, or durable lifecycle conflict. Never resubmit PAYMENT-SIGNATURE automatically. If the response says an accepted request failed before inference, recover with the same semantically equivalent structured request and Idempotency-Key but no PAYMENT-SIGNATURE; JSON formatting and object-key order may differ. Ineligible or already-uncertain ambiguity fulfillment requires operator reconciliation." },
            "429": { description: "Rate or capacity limit." },
            "503": { description: "Paid service disabled, unavailable, or conservatively blocked." },
          },
        },
      },
    },
    "x-secondlook": {
      policy_version: POLICY_VERSION,
      invariant: "SecondLook never supplies missing authority.",
      review_statuses: [
        "no_material_concern_found",
        "material_concern_found",
        "insufficient_information",
        "human_review_required",
      ],
      notices: {
        terms_url: `${origin}/terms`,
        privacy_url: `${origin}/privacy`,
        support_url: `${origin}/support`,
      },
    },
  };
}
