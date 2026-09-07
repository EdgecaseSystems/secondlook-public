/** Public examples are illustrative; not observed model outputs or performance evidence. */
export function publicBuyerGuide() {
  return {
  "incremental_value": "A dedicated second pass against supplied facts, authority, constraints, and uncertainties, with a stable structured result your workflow can handle. Use it when a separate review could change the next action; no greater accuracy than your own review or another model is promised.",
  "buy_when": "A costly, external, irreversible, or constraint-sensitive action warrants checking for an overlooked supplied fact, authority issue, uncertainty, or conflict before execution.",
  "skip_when": "The action is trivial or readily reversible and another review would not change your decision, or your existing review process already provides the same value.",
  "prerequisites": [
    "A proposed action plus the material facts, authority basis, constraints, and uncertainties needed to review it. SecondLook cannot discover facts you omit.",
    "Eligible U.S. service use in the 50 states or DC and the required country/region headers.",
    "An authorized x402 wallet for the live payment terms, and a caller that retains its request and UUIDv4 Idempotency-Key for recovery."
  ],
  "you_receive": "0.05 USDC purchases processing of one valid request and a durable review result: review_status, reason, key_risks, missing_information, decision_id, and policy_version. All four statuses are valid fulfilled results, including insufficient_information and human_review_required.",
  "quick_start": [
    "Read /privacy before supplying business context. Choose a minimal request or adapt an illustrative request below using only the facts you actually know.",
    "Send unsigned POST /v1/paid/second-look to obtain the live PAYMENT-REQUIRED terms. No request body is required for negotiation.",
    "After authorizing the terms, POST your JSON with Content-Type: application/json, PAYMENT-SIGNATURE, a fresh UUIDv4 Idempotency-Key, X-SecondLook-Service-Use-Country: US, and your eligible state/DC in X-SecondLook-Service-Use-Region.",
    "Use review_status and its reasons to decide your next step. The caller retains authority and execution responsibility.",
    "Save the result and original request/key. Recovery uses the same logical request and key without PAYMENT-SIGNATURE; never blindly retry a signed request or ambiguous inference."
  ],
  "privacy_url": "/privacy",
  "privacy_before_purchase": "Effective September 6, 2026, customer input and generated reviews are not used by Edgecase Systems to train, fine-tune, or improve AI models. Substantive decision records have no automatic deletion deadline and may remain stored indefinitely; seven days is the replay window, not decision-content retention. Read /privacy before sending business context.",
  "examples": [
    {
      "name": "Useful catch: overlapping refunds",
      "kind": "Illustrative expected result, not a live result or performance evidence",
      "request": {
        "goal": "Resolve a verified duplicate $40 charge without refunding it twice.",
        "proposed_action": "Issue a $40 refund now.",
        "authority": {
          "status": "confirmed",
          "basis": "Support policy authorizes the agent to refund verified duplicates up to $50."
        },
        "hard_constraints": [
          "Do not create a second refund while one for the same charge is pending."
        ],
        "known_facts": [
          "The $40 duplicate is verified.",
          "A separate billing workflow has already submitted a $40 refund for this charge; its result is pending."
        ],
        "reasoning_summary": "The duplicate is verified and $40 is within my $50 limit."
      },
      "illustrative_review": {
        "review_status": "material_concern_found",
        "reason": "The amount is within your authority, but the pending refund makes another refund conflict with the supplied no-duplicate-refund constraint.",
        "key_risks": [
          "Refunding the same duplicate charge twice."
        ],
        "missing_information": []
      },
      "next_step": "Check the existing refund outcome before considering another refund. SecondLook does not query the billing system or execute either action."
    },
    {
      "name": "Stays out of the way: supported refund",
      "kind": "Illustrative expected result, not a live result or performance evidence",
      "request": {
        "goal": "Resolve a verified duplicate $25 charge.",
        "proposed_action": "Issue one $25 refund to the original payment method.",
        "authority": {
          "status": "confirmed",
          "basis": "Support policy authorizes the agent to refund verified duplicates up to $50."
        },
        "hard_constraints": [
          "Refund only verified duplicates, at most once, to the original payment method."
        ],
        "known_facts": [
          "The duplicate is verified.",
          "No refund exists or is pending for this charge.",
          "The proposed destination is the original payment method."
        ]
      },
      "illustrative_review": {
        "review_status": "no_material_concern_found",
        "reason": "The supplied authority, facts, and constraints support this routine refund; no material concern is identified.",
        "key_risks": [],
        "missing_information": []
      },
      "next_step": "The caller can continue under its existing authority. This status does not grant permission or guarantee correctness; if this check adds no value to your workflow, skip the purchase."
    }
  ]
};
}
