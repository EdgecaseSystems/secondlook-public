import { describe, expect, it, vi } from "vitest";
import { createWorker } from "../src/index";
import {
  PUBLIC_AGENT_DESCRIPTION,
  PUBLIC_MAINNET_AMOUNT_ATOMIC,
  publicCommercialEligibleRegions,
  readPublicCommercialJurisdiction,
  renderPublicPrivacy,
  renderPublicTerms,
  SERVICE_USE_COUNTRY_HEADER,
  SERVICE_USE_REGION_HEADER,
} from "../src/public-mainnet";
import { readX402Configuration, X402_BASE_MAINNET, X402_BASE_MAINNET_USDC, X402_CDP_FACILITATOR } from "../src/x402";
import type { AppEnv } from "../src/types";

const payer = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";

function publicEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    X402_PAID_ENABLED: "true",
    X402_PUBLIC_MAINNET_ENABLED: "true",
    X402_MAX_OUTSTANDING_PAID_OBLIGATIONS: "5",
    X402_SUPPORT_URL: "https://support.example/secondlook",
    X402_FACILITATOR_URL: X402_CDP_FACILITATOR,
    X402_NETWORK: X402_BASE_MAINNET,
    X402_ASSET: X402_BASE_MAINNET_USDC,
    X402_AMOUNT_ATOMIC: PUBLIC_MAINNET_AMOUNT_ATOMIC,
    X402_PAY_TO: recipient,
    X402_ASSET_NAME: "USDC",
    X402_ASSET_VERSION: "2",
    X402_CDP_API_KEY_ID: "test-key",
    X402_CDP_API_KEY_SECRET: "test-secret",
    X402_DAILY_SETTLEMENT_LIMIT: "100000",
    X402_DAILY_ACCEPTED_PAYMENT_LIMIT: "100000",
    X402_DAILY_SETTLED_ATOMIC_LIMIT: "5000000000",
    X402_MONTHLY_FACILITATOR_LIMIT: "100000",
    X402_DAILY_PAID_INFERENCE_LIMIT: "100000",
    ...overrides,
  } as AppEnv;
}

function requestWithJurisdiction(declaredCountry: string | null, declaredRegion: string | null, edgeCountry: unknown, edgeRegion: unknown): Request {
  const headers = new Headers();
  if (declaredCountry !== null) headers.set(SERVICE_USE_COUNTRY_HEADER, declaredCountry);
  if (declaredRegion !== null) headers.set(SERVICE_USE_REGION_HEADER, declaredRegion);
  const request = new Request("https://secondlook.example/v1/paid/second-look", { method: "POST", headers });
  Object.defineProperty(request, "cf", { value: { country: edgeCountry, regionCode: edgeRegion } });
  return request;
}

describe("scalable public x402 mainnet", () => {
  it("does not expose mutable region metadata capable of changing enforcement or later discovery", async () => {
    const callerCopy = publicCommercialEligibleRegions();
    callerCopy.push("PR");

    expect(publicCommercialEligibleRegions()).not.toContain("PR");
    expect(() => readPublicCommercialJurisdiction(requestWithJurisdiction("US", "PR", "US", "CA")))
      .toThrow(expect.objectContaining({ code: "invalid_service_use_jurisdiction" }));

    const manifest = await createWorker().fetch(
      new Request("https://secondlook.example/.well-known/secondlook.json"),
      publicEnv(),
    );
    const body = await manifest.json() as Record<string, any>;
    expect(body.paid_service.public_commercial.service_use_headers.region.eligible_values).not.toContain("PR");
  });

  it("is disabled by default, requires explicit outstanding capacity, and rejects legacy beta variables", () => {
    expect(readX402Configuration({} as AppEnv)).toBeNull();
    expect(() => readX402Configuration(publicEnv({ X402_PUBLIC_MAINNET_ENABLED: undefined }))).toThrow(/mainnet paid path/);
    expect(() => readX402Configuration(publicEnv({ X402_MAX_OUTSTANDING_PAID_OBLIGATIONS: undefined }))).toThrow(/canonical positive integer/);
    expect(() => readX402Configuration(publicEnv({ X402_MAX_OUTSTANDING_PAID_OBLIGATIONS: "21" }))).toThrow(/maximum of 20/);
    expect(() => readX402Configuration(publicEnv({ X402_PUBLIC_BETA_ENABLED: "true" }))).toThrow(/obsolete/);
  });

  it("accepts exact Base-mainnet public terms without finite age or lifetime caps", () => {
    expect(readX402Configuration(publicEnv())).toMatchObject({
      canaryPayer: null,
      accepted: { network: X402_BASE_MAINNET, asset: X402_BASE_MAINNET_USDC, amount: "50000", payTo: recipient },
      publicMainnet: { maxOutstandingPaidObligations: 5, policyVersion: "public-commercial-v1" },
    });
    expect(() => readX402Configuration(publicEnv({ X402_MAINNET_CANARY_ENABLED: "true", X402_CANARY_PAYER: payer }))).toThrow(/mutually exclusive/);
    expect(() => readX402Configuration(publicEnv({ X402_CANARY_PAYER: payer }))).toThrow(/canary payer/);
    expect(() => readX402Configuration(publicEnv({ X402_AMOUNT_ATOMIC: "50001" }))).toThrow(/exactly 50000/);
    expect(() => readX402Configuration(publicEnv({ X402_ASSET: payer }))).toThrow(/bounded CDP/);
  });

  it("keeps all five commercial fuses explicit but removes obsolete low maxima", () => {
    const keys: (keyof AppEnv)[] = [
      "X402_DAILY_SETTLEMENT_LIMIT", "X402_DAILY_ACCEPTED_PAYMENT_LIMIT", "X402_DAILY_SETTLED_ATOMIC_LIMIT",
      "X402_MONTHLY_FACILITATOR_LIMIT", "X402_DAILY_PAID_INFERENCE_LIMIT",
    ];
    for (const key of keys) expect(() => readX402Configuration(publicEnv({ [key]: undefined }))).toThrow(/canonical positive integer/);
    expect(readX402Configuration(publicEnv())?.commercialLimits).toEqual({
      dailySettlementLimit: 100000,
      dailyAcceptedPaymentLimit: 100000,
      dailySettledAtomicLimit: 5000000000,
      monthlyFacilitatorLimit: 100000,
      dailyPaidInferenceLimit: 100000,
    });
  });

  it("accepts independently eligible declared and current edge regions", () => {
    expect(readPublicCommercialJurisdiction(requestWithJurisdiction("us", "ca", "US", "NY"))).toEqual({
      serviceUseCountry: "US", serviceUseRegion: "CA", edgeCountry: "US", edgeRegion: "NY",
    });
  });

  it("accepts Texas as either the declared service-use region or current edge region", () => {
    expect(readPublicCommercialJurisdiction(requestWithJurisdiction("US", "TX", "US", "CA"))).toEqual({
      serviceUseCountry: "US", serviceUseRegion: "TX", edgeCountry: "US", edgeRegion: "CA",
    });
    expect(readPublicCommercialJurisdiction(requestWithJurisdiction("US", "CA", "US", "TX"))).toEqual({
      serviceUseCountry: "US", serviceUseRegion: "CA", edgeCountry: "US", edgeRegion: "TX",
    });
  });

  it.each([
    [null, "CA", "US", "CA", "missing_service_use_jurisdiction"],
    ["US", null, "US", "CA", "missing_service_use_jurisdiction"],
    ["CA", "CA", "US", "CA", "invalid_service_use_jurisdiction"],
    ["US", "PR", "US", "CA", "invalid_service_use_jurisdiction"],
    ["US", "CA", "US", "PR", "service_region_unavailable"],
    ["US", "CA", "CA", "CA", "service_region_unavailable"],
  ])("rejects ineligible or incomplete jurisdiction %#", (country, region, edgeCountry, edgeRegion, code) => {
    expect(() => readPublicCommercialJurisdiction(requestWithJurisdiction(country, region, edgeCountry, edgeRegion))).toThrow(expect.objectContaining({ code }));
  });

  it("serves notices and manifest metadata from the read-only public sales control without AI or payments", async () => {
    const first = vi.fn(async () => ({
      new_settlement_enabled: 1,
      max_daily_ambiguity_fulfillments: 3,
      max_unresolved_ambiguity_fulfillments_per_payer: 1,
      facilitator_transport_failure_threshold: 3,
      consecutive_facilitator_transport_failures: 0,
      last_facilitator_transport_failure_code: null,
    }));
    const prepare = vi.fn(() => ({ first }));
    const db = Object.create(null) as D1Database;
    Object.defineProperty(db, "prepare", { value: prepare });
    const ai = Object.create(null) as Ai;
    const aiRun = vi.fn();
    Object.defineProperty(ai, "run", { value: aiRun });
    const worker = createWorker();
    const env = { ...publicEnv(), DB: db, AI: ai } as AppEnv;
    const terms = await worker.fetch(new Request("https://secondlook.example/terms"), env);
    const privacy = await worker.fetch(new Request("https://secondlook.example/privacy"), env);
    const manifest = await worker.fetch(new Request("https://secondlook.example/.well-known/secondlook.json"), env);
    expect(await terms.text()).toBe(renderPublicTerms("https://support.example/secondlook"));
    expect(await privacy.text()).toBe(renderPublicPrivacy("https://support.example/secondlook"));
    const manifestBody = await manifest.json() as Record<string, any>;
    expect(manifestBody).toMatchObject({
      description: PUBLIC_AGENT_DESCRIPTION,
      openapi_url: "https://secondlook.example/openapi.json",
      endpoints: {
        paid_second_look: {
          new_sales_enabled: true,
          existing_paid_replay_or_recovery_supported: true,
        },
      },
      paid_service: {
        new_sales_enabled: true,
        existing_paid_replay_or_recovery_supported: true,
        payment_ambiguity: {
          new_sales_blocked_until_reconciliation: false,
          unrelated_new_sales_remain_available_within_capacity: true,
        },
        amount_atomic: "50000",
        price_display: "0.05 USDC",
        network: X402_BASE_MAINNET,
        public_commercial: {
          capacity_limited: true,
          required_headers: [SERVICE_USE_COUNTRY_HEADER, SERVICE_USE_REGION_HEADER],
          service_use_headers: {
            country: { name: SERVICE_USE_COUNTRY_HEADER, required_for_payment_retry: true, value: "US" },
            region: {
              name: SERVICE_USE_REGION_HEADER,
              required_for_payment_retry: true,
              format: "USPS two-letter state code or DC",
              eligible_values: expect.arrayContaining(["CA", "DC"]),
            },
          },
        },
      },
    });
    expect(manifestBody.paid_service.public_commercial).not.toHaveProperty("maximum_outstanding_paid_obligations");
    expect(prepare).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("keeps bounded support and historical-capability metadata visible while new sales are disabled", async () => {
    const worker = createWorker();
    const env = publicEnv({ X402_PAID_ENABLED: undefined });
    const terms = await worker.fetch(new Request("https://secondlook.example/terms"), env);
    const privacy = await worker.fetch(new Request("https://secondlook.example/privacy"), env);
    const manifest = await worker.fetch(new Request("https://secondlook.example/.well-known/secondlook.json"), env);
    expect(await terms.text()).toContain("Support: https://support.example/secondlook");
    expect(await privacy.text()).toContain("Support: https://support.example/secondlook");
    expect(await manifest.json()).toMatchObject({
      endpoints: {
        paid_second_look: {
          path: "/v1/paid/second-look",
          new_sales_enabled: false,
          existing_paid_replay_or_recovery_supported: true,
        },
      },
      public_notices: { support: "https://support.example/secondlook" },
      paid_service: {
        new_sales_enabled: false,
        existing_paid_replay_or_recovery_supported: true,
      },
    });

    const invalidEnv = publicEnv({ X402_PAID_ENABLED: undefined, X402_SUPPORT_URL: "http://user:secret@example.com" });
    const invalidTerms = await worker.fetch(new Request("https://secondlook.example/terms"), invalidEnv);
    const invalidManifest = await worker.fetch(new Request("https://secondlook.example/.well-known/secondlook.json"), invalidEnv);
    expect(await invalidTerms.text()).not.toContain("Support:");
    expect(await invalidManifest.json()).toMatchObject({ public_notices: { terms: "/terms", privacy: "/privacy" } });
    expect((await worker.fetch(new Request("https://secondlook.example/v1/paid/second-look", { method: "POST" }), publicEnv({ X402_SUPPORT_URL: "http://example.com" }))).status).toBe(503);
  });

  it.each([
    ["paid kill switch", { X402_PAID_ENABLED: undefined }],
    ["public kill switch", { X402_PUBLIC_MAINNET_ENABLED: undefined }],
    ["recipient", { X402_PAY_TO: undefined }],
    ["support URL", { X402_SUPPORT_URL: undefined }],
    ["commercial fuse", { X402_DAILY_SETTLEMENT_LIMIT: "invalid" }],
  ])("never contacts a facilitator for a new request with unavailable %s configuration", async (_label, override) => {
    const attemptAcceptance = vi.fn();
    const db = Object.create(null) as D1Database;
    Object.defineProperty(db, "prepare", { value: vi.fn() });
    const response = await createWorker({ paymentAdapter: { attemptAcceptance } }).fetch(
      new Request("https://secondlook.example/v1/paid/second-look", { method: "POST" }),
      { ...publicEnv(override), DB: db } as AppEnv,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(attemptAcceptance).not.toHaveBeenCalled();
  });
});
