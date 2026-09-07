import { CommercialEligibilityError } from "./errors";
import type { AppEnv } from "./types";

export const PUBLIC_COMMERCIAL_POLICY_VERSION = "public-commercial-v1";
export const GEOGRAPHY_POLICY_VERSION = "us-states-and-dc-v1";
export const TERMS_VERSION = "2026-09-02.1";
export const PRIVACY_VERSION = "2026-09-06.1";
export const PUBLIC_MAINNET_AMOUNT_ATOMIC = "50000";
export const PUBLIC_MAINNET_MAX_OUTSTANDING_PAID_OBLIGATIONS = 20;
export const SERVICE_USE_COUNTRY_HEADER = "X-SecondLook-Service-Use-Country";
export const SERVICE_USE_REGION_HEADER = "X-SecondLook-Service-Use-Region";
export const PUBLIC_AGENT_DESCRIPTION = "A second opinion before your AI agent acts: catch overlooked risks, conflicting constraints, and missing information before committing to an action. Independent pre-action review checks your supplied facts, authority, constraints, and reasoning against the proposed action and returns a structured status, reasons, risks, and missing information to help you decide whether to proceed, revise the plan, gather information, or involve a human. Buy when a costly, external, irreversible, or constraint-sensitive action warrants a separate check that could change your next step. Skip trivial or reversible actions when another review would not change the decision. This is a dedicated review contract, not a claim of superiority over your own reasoning or another model. SecondLook does not authorize, execute, or supply missing authority; results are not guarantees of correctness.";

const LEGACY_BETA_CONFIGURATION_KEYS = [
  "X402_PUBLIC_BETA_ENABLED",
  "X402_PUBLIC_BETA_ID",
  "X402_PUBLIC_BETA_EXPIRES_AT",
  "X402_PUBLIC_BETA_SETTLEMENT_LIMIT",
] as const;

const PUBLIC_COMMERCIAL_ELIGIBLE_REGION_VALUES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
] as const;
const ELIGIBLE_REGIONS = new Set<string>(PUBLIC_COMMERCIAL_ELIGIBLE_REGION_VALUES);
const US_REGIONS = new Set<string>(PUBLIC_COMMERCIAL_ELIGIBLE_REGION_VALUES);

export function publicCommercialEligibleRegions(): string[] {
  return [...PUBLIC_COMMERCIAL_ELIGIBLE_REGION_VALUES];
}

export interface PublicMainnetConfiguration {
  supportUrl: string;
  maxOutstandingPaidObligations: number;
  policyVersion: typeof PUBLIC_COMMERCIAL_POLICY_VERSION;
  geographyPolicyVersion: typeof GEOGRAPHY_POLICY_VERSION;
  termsVersion: typeof TERMS_VERSION;
  privacyVersion: typeof PRIVACY_VERSION;
}

export interface PublicCommercialJurisdiction {
  serviceUseCountry: "US";
  serviceUseRegion: string;
  edgeCountry: "US";
  edgeRegion: string;
}

function canonicalHeader(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function parseSupportUrl(raw: string): string {
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new Error("X402_SUPPORT_URL must be a bounded HTTPS URL."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || raw.length > 2048) {
    throw new Error("X402_SUPPORT_URL must be a bounded HTTPS URL.");
  }
  return parsed.toString();
}

export function readPublicSupportUrl(env: AppEnv): string | undefined {
  const raw = env.X402_SUPPORT_URL?.trim();
  if (!raw) return undefined;
  try { return parseSupportUrl(raw); }
  catch { return undefined; }
}

export function readPublicMainnetConfiguration(env: AppEnv): PublicMainnetConfiguration | null {
  for (const key of LEGACY_BETA_CONFIGURATION_KEYS) {
    if (env[key] !== undefined) throw new Error(`${key} is obsolete; remove legacy finite-beta configuration.`);
  }
  if (env.X402_PUBLIC_MAINNET_ENABLED !== "true") return null;

  const maximumRaw = env.X402_MAX_OUTSTANDING_PAID_OBLIGATIONS?.trim() ?? "";
  if (!/^[1-9][0-9]*$/.test(maximumRaw)) {
    throw new Error("X402_MAX_OUTSTANDING_PAID_OBLIGATIONS must be a canonical positive integer.");
  }
  const maxOutstandingPaidObligations = Number(maximumRaw);
  if (!Number.isSafeInteger(maxOutstandingPaidObligations) || maxOutstandingPaidObligations > PUBLIC_MAINNET_MAX_OUTSTANDING_PAID_OBLIGATIONS) {
    throw new Error("X402_MAX_OUTSTANDING_PAID_OBLIGATIONS exceeds the reviewed maximum of 20.");
  }

  const supportUrl = parseSupportUrl(env.X402_SUPPORT_URL?.trim() ?? "");

  return {
    supportUrl,
    maxOutstandingPaidObligations,
    policyVersion: PUBLIC_COMMERCIAL_POLICY_VERSION,
    geographyPolicyVersion: GEOGRAPHY_POLICY_VERSION,
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
  };
}

export function readPublicCommercialJurisdiction(request: Request): PublicCommercialJurisdiction {
  const country = canonicalHeader(request.headers.get(SERVICE_USE_COUNTRY_HEADER));
  const region = canonicalHeader(request.headers.get(SERVICE_USE_REGION_HEADER));
  if (country === null || region === null) {
    throw new CommercialEligibilityError("missing_service_use_jurisdiction", "Both service-use jurisdiction headers are required.", 400, "caller");
  }
  if (country !== "US" || !US_REGIONS.has(region)) {
    throw new CommercialEligibilityError("invalid_service_use_jurisdiction", "The declared service-use jurisdiction is invalid.", 400, "caller");
  }
  if (!ELIGIBLE_REGIONS.has(region)) {
    throw new CommercialEligibilityError("service_region_unavailable", "Paid public service is unavailable for this jurisdiction.", 403, "access");
  }
  const cf = request.cf;
  const edgeCountry = typeof cf?.country === "string" ? cf.country.trim().toUpperCase() : "";
  const edgeRegion = typeof cf?.regionCode === "string" ? cf.regionCode.trim().toUpperCase() : "";
  if (edgeCountry !== "US" || !ELIGIBLE_REGIONS.has(edgeRegion)) {
    throw new CommercialEligibilityError("service_region_unavailable", "Paid public service is unavailable for this request.", 403, "access");
  }
  return { serviceUseCountry: "US", serviceUseRegion: region, edgeCountry: "US", edgeRegion };
}

export const PUBLIC_TERMS_TEXT = `SecondLook Public x402 Service Terms — ${TERMS_VERSION}

SecondLook provides automated independent pre-action review. It does not authorize or execute actions. The caller remains responsible for authority, execution, consequences, and legal compliance.

Illustrative examples explain the review format and possible next steps; they are not observed results, performance statistics, or promises of a particular outcome. Content handling and retention are described in /privacy.

One payment purchases processing of one valid request and one durable review result under the then-current SecondLook judgment policy. All four review statuses—no_material_concern_found, material_concern_found, insufficient_information, and human_review_required—are valid fulfilled results. Payment does not purchase a desired recommendation.

SecondLook may be wrong, incomplete, unavailable, or unsuitable for a particular purpose. It is not professional legal, medical, financial, investment, or tax advice and has no uptime or service-level guarantee.

The early-stage public service is limited to eligible United States service use in the 50 states and District of Columbia. U.S. territories are unavailable. Malformed or ineligible requests are rejected before settlement when reasonably possible. New sales may be temporarily suspended by service, incident, capacity, or operator safety controls.

A durable completed result remains fulfilled if HTTP delivery is lost; exact replay is the remedy. A confirmed paid service failure is handled through the operator-controlled remediation policy. On-chain x402 settlement is irreversible; any approved refund is a separate USDC transfer. SecondLook never automatically retries ambiguous settlement or ambiguous inference.
`;

export const PUBLIC_PRIVACY_TEXT = `SecondLook Public Service Privacy Notice — ${PRIVACY_VERSION}

Model training and improvement
Effective September 6, 2026, Edgecase Systems does not use customer-submitted review content or generated reviews to train, fine-tune, or improve AI models. Processing content to answer the requested review is distinct from training.

Submitted business context
SecondLook processes your goal, proposed action, authority, facts, constraints, uncertainties, and reasoning to provide the review. Selected common personal-data and credential patterns are redacted before model processing and decision storage; this is limited pattern matching, not anonymization or a guarantee that sensitive information is removed. Submit only the context needed for the review.

Substantive input and generated review retention
Decision records retain substantive submitted fields and generated review fields separately from replay records. There is currently no automatic deletion deadline for these decision records: they may remain stored indefinitely unless separately deleted. Generated review reasons, risks, missing information, and any constraint-resolution content can themselves contain submitted business context. The seven-day replay window does not delete these decision records.

Replay and operational records
The operational idempotency/replay window is seven days. Replay records include request identity/hash, lifecycle state and the completed response for recovery; the saved response contains generated review content. Expiration cleanup is request-driven rather than immediate at the deadline, and unresolved reserved commercial cases can delay cleanup. Do not treat the replay window as a promise that all content is deleted after seven days.

Payment and service records
Separate payment, accounting, reconciliation, remediation and bounded operational metadata support service integrity, payment processing, exact replay, accounting/compliance, and failure or refund verification. They include correlation identifiers, payment amounts and states, payment-evidence identifiers, and coarse declared/observed country and region. Commercial accounting and remediation records are retained independently of replay; no fixed deletion deadline is currently specified. These records are not a separate model-training dataset.

Processors
Cloudflare processes service traffic and stores decision and replay records in D1. Workers AI receives the prepared review context to generate the review. Cloudflare states that Workers AI Customer Content is not used to train models or improve Cloudflare or third-party services without explicit consent: https://developers.cloudflare.com/workers-ai/platform/data-usage/ . This processor policy does not remove the SecondLook storage described above. The Coinbase CDP facilitator receives payment/protocol data when settlement is attempted; substantive review context is processed by Workers AI.

SecondLook does not store IP addresses or precise location as part of its geography policy, does not sell personal data, and does not use submitted data for targeted advertising.

Do not submit private keys, seed phrases, credentials, or unnecessary sensitive personal information. If you require a fixed deletion deadline for business context, the current retention behavior may not meet your requirements. Contact support before submitting it; contact is not a promise of automated deletion.
`;

export function renderPublicTerms(supportUrl?: string): string {
  return supportUrl ? `${PUBLIC_TERMS_TEXT}\nSupport: ${supportUrl}\n` : PUBLIC_TERMS_TEXT;
}

export function renderPublicPrivacy(supportUrl?: string): string {
  return supportUrl ? `${PUBLIC_PRIVACY_TEXT}\nSupport: ${supportUrl}\n` : PUBLIC_PRIVACY_TEXT;
}
