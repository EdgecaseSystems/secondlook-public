export type LegacyRecommendation =
  | "proceed"
  | "reconsider"
  | "need_more_information"
  | "escalate_to_human";

export type ReviewStatus =
  | "no_material_concern_found"
  | "material_concern_found"
  | "insufficient_information"
  | "human_review_required";

export interface AuthorityContext {
  status: "confirmed" | "unclear" | "unknown";
  basis?: string;
  limits?: string[];
}

export type ConstraintApplicability = "applicable" | "inapplicable" | "unresolved";
export type ConstraintActionRelation = "satisfies" | "violates" | "unresolved" | "not_applicable";

export interface StructuredConstraint {
  id: string;
  text: string;
  applicability: ConstraintApplicability;
  action_relation: ConstraintActionRelation;
}

export type ConstraintControl =
  | { status: "established"; controlling_constraint_id: string }
  | { status: "unresolved" };

export interface ConstraintConflictGroup {
  id: string;
  constraint_ids: string[];
  independently_binding_constraint_ids?: string[];
  control: ConstraintControl;
}

export interface ConstraintContextV1 {
  schema_version: "constraint-context-v1";
  constraints: StructuredConstraint[];
  conflict_groups?: ConstraintConflictGroup[];
}

export type Outcome =
  | "successful"
  | "unsuccessful"
  | "human_approved"
  | "human_corrected"
  | "reversed"
  | "no_observable_issue"
  | "unknown";

export interface SecondLookRequest {
  goal: string;
  proposed_action: string;
  authority?: AuthorityContext;
  hard_constraints?: string[];
  /** Authoritative, caller-supplied constraint relationships. Mutually exclusive with nonempty legacy constraint lists. */
  constraint_context?: ConstraintContextV1;
  soft_preferences?: string[];
  known_facts?: string[];
  unknown_facts?: string[];
  alternatives_considered?: string[];
  reasoning_summary?: string;
  /** @deprecated Use hard_constraints and soft_preferences. */
  important_constraints?: string[];
  /** @deprecated Use unknown_facts. Known facts must not be placed here. */
  uncertainties?: string[];
  estimated_cost_of_action?: {
    amount: number;
    currency: string;
  };
}

export interface SecondLookDecision {
  review_status: ReviewStatus;
  reason: string;
  key_risks: string[];
  missing_information: string[];
}

export interface SecondLookResponse extends SecondLookDecision {
  decision_id: string;
  created_at: string;
  policy_version: string;
  model: string;
  /** @deprecated Compatibility alias derived from review_status. */
  recommendation: LegacyRecommendation;
}

export interface ReportOutcomeRequest {
  decision_id: string;
  outcome: Outcome;
  details?: string;
  measurable_value?: number;
  currency?: string;
}

export type ModelProvider = "workers_ai" | "openai";

export type WorkersAiModel =
  | "@cf/zai-org/glm-4.7-flash"
  | "@cf/google/gemma-4-26b-a4b-it"
  | "@cf/nvidia/nemotron-3-120b-a12b";

export type AppEnv = Omit<Env, "MODEL_PROVIDER"> & {
  MODEL_PROVIDER?: ModelProvider;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  SECONDLOOK_ACCESS_KEY?: string;
  AGENT_HASH_SALT?: string;
  X402_PAID_ENABLED?: string;
  X402_FACILITATOR_URL?: string;
  X402_NETWORK?: string;
  X402_ASSET?: string;
  X402_AMOUNT_ATOMIC?: string;
  X402_PAY_TO?: string;
  X402_ASSET_NAME?: string;
  X402_ASSET_VERSION?: string;
  X402_CDP_API_KEY_ID?: string;
  X402_CDP_API_KEY_SECRET?: string;
  X402_MAINNET_CANARY_ENABLED?: string;
  X402_CANARY_PAYER?: string;
  X402_DAILY_SETTLEMENT_LIMIT?: string;
  X402_DAILY_ACCEPTED_PAYMENT_LIMIT?: string;
  X402_DAILY_SETTLED_ATOMIC_LIMIT?: string;
  X402_MONTHLY_FACILITATOR_LIMIT?: string;
  X402_DAILY_PAID_INFERENCE_LIMIT?: string;
  X402_PUBLIC_MAINNET_ENABLED?: string;
  X402_MAX_OUTSTANDING_PAID_OBLIGATIONS?: string;
  X402_PUBLIC_BETA_ENABLED?: string;
  X402_PUBLIC_BETA_ID?: string;
  X402_PUBLIC_BETA_EXPIRES_AT?: string;
  X402_PUBLIC_BETA_SETTLEMENT_LIMIT?: string;
  X402_SUPPORT_URL?: string;
};

export interface ModelUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export type AuthContext =
  | { kind: "internal" }
  | { kind: "pilot"; key_id: string; customer_id: string; project_id: string }
  | { kind: "paid"; key_id: string };

export interface ModelDecision {
  decision: SecondLookDecision;
  usage: ModelUsage;
  model: string;
  policy_version: string;
  constraint_resolution?: import("./constraints").ConstraintResolution;
}
