import { describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import { publicOpenApiDocument } from "../src/public-api";
import type { AppEnv } from "../src/types";

function inertEnvironment(): AppEnv {
  const ai = Object.create(null) as Ai;
  Object.defineProperty(ai, "run", { value: vi.fn() });
  const db = Object.create(null) as D1Database;
  Object.defineProperty(db, "prepare", { value: vi.fn() });
  return { AI: ai, DB: db } as AppEnv;
}

function object(value: unknown): Record<string, any> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Record<string, any>;
}

describe("cold-agent public integration contract", () => {
  it("returns fresh OpenAPI metadata that cannot mutate later documents", () => {
    const first = object(publicOpenApiDocument("https://secondlook.example"));
    const firstOperation = object(first.paths["/v1/paid/second-look"].post);
    const firstRetry = object(firstOperation["x-secondlook-payment-retry"]);
    const firstBody = object(firstOperation.requestBody.content["application/json"]);
    firstRetry.eligible_regions.push("PR");
    firstBody.schema.properties.goal.maxLength = 1;
    firstBody.schema["x-secondlook-semantic-validation"].invariants.length = 0;
    firstBody.example.goal = "mutated";

    const second = object(publicOpenApiDocument("https://secondlook.example"));
    const secondOperation = object(second.paths["/v1/paid/second-look"].post);
    const secondRetry = object(secondOperation["x-secondlook-payment-retry"]);
    const secondBody = object(secondOperation.requestBody.content["application/json"]);
    expect(secondRetry.eligible_regions).not.toContain("PR");
    expect(secondBody.schema.properties.goal.maxLength).toBe(4000);
    expect(secondBody.schema["x-secondlook-semantic-validation"].invariants.length).toBeGreaterThan(0);
    expect(secondBody.example.goal).toBe("Review a proposed customer refund before execution.");
  });

  it("lets an outside buyer discover and construct the complete paid-retry request shape", async () => {
    const worker = createWorker();
    const env = inertEnvironment();
    const origin = "https://secondlook.example";

    const indexResponse = await worker.fetch(new Request(`${origin}/`), env);
    expect(indexResponse.status).toBe(200);
    const index = object(await indexResponse.json());
    expect(index).toMatchObject({
      service: "SecondLook",
      invariant: "SecondLook never supplies missing authority.",
      manifest_url: `${origin}/.well-known/secondlook.json`,
      openapi_url: `${origin}/openapi.json`,
      paid_endpoint_url: `${origin}/v1/paid/second-look`,
      notices: {
        terms_url: `${origin}/terms`, privacy_url: `${origin}/privacy`, support_url: `${origin}/support`,
      },
    });

    const manifestResponse = await worker.fetch(new Request(index.manifest_url), env);
    const openApiResponse = await worker.fetch(new Request(index.openapi_url), env);
    expect(manifestResponse.status).toBe(200);
    expect(openApiResponse.status).toBe(200);
    const manifest = object(await manifestResponse.json());
    const openapi = object(await openApiResponse.json());

    expect(manifest.openapi_url).toBe(index.openapi_url);
    expect(manifest.description).toContain("Independent pre-action review");
    expect(manifest.review_statuses).toEqual([
      "no_material_concern_found", "material_concern_found", "insufficient_information", "human_review_required",
    ]);
    expect(manifest.paid_service.payment_flow).toBe("upfront");
    expect(manifest.paid_service.authorization).toContain("does not authorize or execute");

    const operation = object(openapi.paths["/v1/paid/second-look"].post);
    const retry = object(operation["x-secondlook-payment-retry"]);
    const headers = object(retry.required_headers);
    const bodyContract = object(operation.requestBody.content["application/json"]);
    const example = object(bodyContract.example);

    expect(openapi.openapi).toBe("3.1.0");
    expect(headers).toMatchObject({
      "Content-Type": "application/json",
      "PAYMENT-SIGNATURE": "Base64-encoded x402 V2 PaymentPayload",
      "Idempotency-Key": "UUIDv4",
      "X-SecondLook-Service-Use-Country": "US",
      "X-SecondLook-Service-Use-Region": "one eligible_regions value",
    });
    expect(retry.automatic_payment_retry).toBe(false);
    expect(retry.eligible_regions).toContain("CA");
    expect(retry.eligible_regions).toContain("TX");
    expect(bodyContract.schema.required).toEqual(["goal", "proposed_action"]);
    expect(bodyContract.schema.additionalProperties).toBe(false);
    expect(bodyContract.schema.properties.goal.pattern).toBe("\\S");
    expect(bodyContract.schema["x-secondlook-semantic-validation"]).toMatchObject({
      additional_runtime_validation_required: true,
      runtime_is_authoritative: true,
    });
    expect(example.goal).toBeTypeOf("string");
    expect(example.proposed_action).toBeTypeOf("string");

    const paidRequestShape = {
      method: "POST",
      url: index.paid_endpoint_url,
      headers: {
        "Content-Type": headers["Content-Type"],
        "PAYMENT-SIGNATURE": "<x402-v2-payment-payload-from-PAYMENT-REQUIRED>",
        "Idempotency-Key": "123e4567-e89b-42d3-a456-426614174000",
        "X-SecondLook-Service-Use-Country": headers["X-SecondLook-Service-Use-Country"],
        "X-SecondLook-Service-Use-Region": retry.eligible_regions[0],
      },
      body: example,
    };
    expect(paidRequestShape).toMatchObject({
      method: "POST",
      url: `${origin}/v1/paid/second-look`,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "123e4567-e89b-42d3-a456-426614174000",
        "X-SecondLook-Service-Use-Country": "US",
      },
    });

    expect((env.AI.run as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((env.DB.prepare as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
