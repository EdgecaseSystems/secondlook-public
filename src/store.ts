import { hashAgentId, redactAuthority, redactConstraintContext, redactList, redactText } from "./privacy";
import { ClientInputError } from "./errors";
import { toLegacyRecommendation } from "./judgment";
import type { AppEnv, AuthContext, ModelDecision, ReportOutcomeRequest, SecondLookRequest, SecondLookResponse } from "./types";

export async function saveDecision(
  env: AppEnv,
  id: string,
  createdAt: string,
  request: SecondLookRequest,
  result: ModelDecision,
  agentId: string | null,
  auth: AuthContext = { kind: "internal" },
): Promise<void> {
  const statement = await prepareDecisionInsert(env, id, createdAt, request, result, agentId, auth);
  await statement.run();
}

async function prepareDecisionInsert(
  env: AppEnv,
  id: string,
  createdAt: string,
  request: SecondLookRequest,
  result: ModelDecision,
  agentId: string | null,
  auth: AuthContext,
  completionPrecondition?: { requestId: string; ownerToken: string },
) {
  const agentIdHash = await hashAgentId(agentId, env.AGENT_HASH_SALT ?? "");
  const authority = redactAuthority(request.authority);
  const constraintContext = redactConstraintContext(request.constraint_context);
  const values: Array<string | number | null> = [
    id,
    createdAt,
    agentIdHash,
    redactText(request.goal) ?? null,
    redactText(request.proposed_action) ?? null,
    redactText(request.reasoning_summary) ?? null,
    JSON.stringify(redactList(request.important_constraints)),
    JSON.stringify(redactList(request.uncertainties)),
    toLegacyRecommendation(result.decision.review_status),
    redactText(result.decision.reason) ?? null,
    JSON.stringify(redactList(result.decision.key_risks)),
    JSON.stringify(redactList(result.decision.missing_information)),
    result.model,
    result.policy_version,
    result.usage.input_tokens ?? null,
    result.usage.output_tokens ?? null,
    authority ? JSON.stringify(authority) : null,
    JSON.stringify(constraintContext ? constraintContext.constraints.map((constraint) => constraint.text) : redactList(request.hard_constraints)),
    JSON.stringify(redactList(request.soft_preferences)),
    JSON.stringify(redactList(request.known_facts)),
    JSON.stringify(redactList(request.unknown_facts)),
    JSON.stringify(redactList(request.alternatives_considered)),
    result.decision.review_status,
    constraintContext ? JSON.stringify(constraintContext) : null,
    result.constraint_resolution ? JSON.stringify(result.constraint_resolution) : null,
    auth.kind === "pilot" ? auth.customer_id : null,
    auth.kind === "pilot" ? auth.project_id : null,
    auth.kind === "pilot" ? auth.key_id : null,
  ];
  const statement = env.DB.prepare(
    `INSERT INTO decisions (
      id, created_at, agent_id_hash, goal_redacted, proposed_action_redacted,
      reasoning_redacted, constraints_json, uncertainties_json, recommendation,
      reason, key_risks_json, missing_information_json, model, policy_version,
      input_tokens, output_tokens, authority_json, hard_constraints_json,
      soft_preferences_json, known_facts_json, unknown_facts_json,
      alternatives_considered_json, review_status, constraint_context_json, constraint_resolution_json,
      pilot_customer_id, pilot_project_id, pilot_api_key_id
    ) SELECT ${values.map(() => "?").join(", ")}
      ${completionPrecondition ? "WHERE EXISTS (SELECT 1 FROM idempotent_requests WHERE request_id = ? AND owner_token = ? AND state = 'inference_running')" : ""}`,
  );
  return completionPrecondition
    ? statement.bind(...values, completionPrecondition.requestId, completionPrecondition.ownerToken)
    : statement.bind(...values);
}

export async function saveDecisionAndCompleteIdempotentRequest(
  env: AppEnv,
  id: string,
  createdAt: string,
  request: SecondLookRequest,
  result: ModelDecision,
  response: SecondLookResponse,
  agentId: string | null,
  auth: AuthContext,
  idempotencyRequestId: string,
  ownerToken: string,
): Promise<void> {
  const decision = await prepareDecisionInsert(env, id, createdAt, request, result, agentId, auth, {
    requestId: idempotencyRequestId,
    ownerToken,
  });
  const completion = env.DB.prepare(
    `UPDATE idempotent_requests SET state = 'completed', decision_id = ?, response_json = ?,
      owner_token = NULL, failure_code = NULL, completed_at = ?, updated_at = ?
     WHERE request_id = ? AND owner_token = ? AND state = 'inference_running'`,
  ).bind(id, JSON.stringify(response), createdAt, createdAt, idempotencyRequestId, ownerToken);
  const results = await env.DB.batch([decision, completion]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    throw new Error("Idempotency completion state was unavailable.");
  }
}

export async function saveOutcome(
  env: AppEnv,
  request: ReportOutcomeRequest,
  agentId: string | null,
  auth: AuthContext = { kind: "internal" },
): Promise<void> {
  const exists = auth.kind === "pilot"
    ? await env.DB.prepare("SELECT id FROM decisions WHERE id = ? AND pilot_customer_id = ? AND pilot_project_id = ?").bind(request.decision_id, auth.customer_id, auth.project_id).first()
    : await env.DB.prepare("SELECT id FROM decisions WHERE id = ?").bind(request.decision_id).first();
  if (!exists) throw new ClientInputError("decision_not_found", "Decision not found.");

  const reporterAgentIdHash = await hashAgentId(agentId, env.AGENT_HASH_SALT ?? "");
  await env.DB.prepare(
    `INSERT INTO outcomes (
      id, decision_id, created_at, reporter_agent_id_hash, outcome,
      details_redacted, measurable_value, currency, pilot_customer_id, pilot_project_id, pilot_api_key_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      request.decision_id,
      new Date().toISOString(),
      reporterAgentIdHash,
      request.outcome,
      redactText(request.details) ?? null,
      request.measurable_value ?? null,
      request.currency ?? null,
      auth.kind === "pilot" ? auth.customer_id : null,
      auth.kind === "pilot" ? auth.project_id : null,
      auth.kind === "pilot" ? auth.key_id : null,
    )
    .run();
}
