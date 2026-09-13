# Post-publication validation

This portfolio repository began as a sanitized snapshot published on 2026-09-07. The production service continued to be tested and hardened afterward. This note records only non-secret evidence that materially changes how the work sample should be interpreted; it intentionally omits wallet identifiers, payment capabilities, request identifiers, production database records, credentials, and deployment access.

## 2026-09-13 x402 production audit

A controlled production audit exercised the paid SecondLook path end to end on Base mainnet with one separately approved 0.05-USDC payment. The transaction settled successfully, the durable paid lifecycle completed without idempotent replay, and the submitted high-consequence bulk-deletion case returned `human_review_required` / `escalate_to_human` rather than a dangerous clear.

The audit also exposed two vendor-integration defects that were corrected and given regression coverage:

- Coinbase CDP server Bearer JWTs use `aud: ["cdp_service"]` and singular `uri` bound to the settle request; the earlier `iat` plus plural `uris` shape was rejected.
- CDP currently requires the x402 V2 `paymentPayload.resource.description` to stay at or below 500 characters. SecondLook keeps its richer public product description elsewhere and uses a bounded payment-resource description at the facilitator boundary.

A separate zero-spend schema probe had already confirmed that the corrected V2 payment payload advanced beyond schema validation to later authorization validation. The real-money audit then established the missing end-to-end settlement evidence.

## Publication boundary

The public repository remains an isolated portfolio work sample. The compatibility code and focused regression tests are retained because they demonstrate the debugging and protocol-boundary work; production incident records, reconciliation details, live deployment identifiers, real wallet/payment material, and operator-only audit tooling are not exported.
