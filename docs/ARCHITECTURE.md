# Architecture and trust boundaries

## Request and review

The Worker exposes discovery, schema, buyer guidance, review, outcome, and paid-review routes. Input validation bounds request size and structured fields. The review pipeline separates submitted authority, hard constraints, soft preferences, facts, unknowns, and the model response. Deterministic application checks decide status precedence rather than blindly accepting a model's suggestion to proceed.

The model is an external reasoning component, not the authority holder. Missing authority cannot be supplied by review. A caller must still decide whether it is entitled to act and must execute any action itself. The service exposes observational statuses; it does not execute the proposed action.

## Durable payment and execution

D1 holds distinct idempotency, payment, admission, accounting, and remediation records. Exact request binding prevents one key or proof from being repurposed for a different request. A completed result can be replayed without another payment or inference. Settlement is a one-attempt boundary; an uncertain external result is recorded as ambiguity rather than treated as an invitation to retry.

Remediation is explicit. The implementation includes controlled reconciliation and public-mainnet ambiguity-fulfillment paths, with durable ownership and evidence rules. Preserving payment truth is separate from deciding whether a service obligation may be fulfilled. See `src/remediation.ts` and its tests for the actual transitions; this snapshot is not an operator runbook.

## Privacy and operational limits

Pattern redaction removes selected recognizable personal-data and credential patterns before model processing and decision storage. This is a limited filter and does not establish that arbitrary business context is anonymous. Review output can itself contain sensitive context.

Replay expiry, decision retention, and financial record retention are separate. In particular, the seven-day replay window does not delete substantive decision records. The included privacy notice documents these distinctions. Error and lifecycle paths retain bounded diagnostic metadata rather than raw model or payment bodies.

## What the portfolio changes

The public copy substitutes reserved example domains and contact addresses, replaces the database UUID, renames the Worker/database configuration, disables public preview/workers.dev publication and traces, and omits operational tools and history. It retains the application state machines, model review policy, schema, migrations, and mocked regression tests. No live model evaluations or payment attempts are part of the publication validation.
