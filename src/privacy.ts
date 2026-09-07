import type { AuthorityContext, ConstraintContextV1 } from "./types";

const REDACTIONS: Array<[RegExp, string]> = [
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_SSN]"],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]"],
  [/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, "[REDACTED_PHONE]"],
  [/\b(?:sk|rk|pk|api)[-_][A-Za-z0-9_-]{16,}\b/g, "[REDACTED_SECRET]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED_TOKEN]"],
  [/\b(?:\d[ -]*?){13,19}\b/g, "[REDACTED_PAYMENT_NUMBER]"],
];

export function redactText(value: string | undefined): string | undefined {
  if (!value) return value;
  return REDACTIONS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

export function redactList(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => redactText(value) ?? "");
}

export function redactAuthority(authority: AuthorityContext | undefined): AuthorityContext | undefined {
  if (!authority) return undefined;
  return {
    ...authority,
    basis: redactText(authority.basis),
    limits: redactList(authority.limits),
  };
}

export function redactConstraintContext(context: ConstraintContextV1 | undefined): ConstraintContextV1 | undefined {
  if (!context) return undefined;
  return {
    ...context,
    constraints: context.constraints.map((constraint) => ({ ...constraint, text: redactText(constraint.text) ?? "" })),
    conflict_groups: context.conflict_groups?.map((group) => ({
      ...group,
      constraint_ids: [...group.constraint_ids],
      independently_binding_constraint_ids: group.independently_binding_constraint_ids ? [...group.independently_binding_constraint_ids] : undefined,
      control: { ...group.control },
    })),
  };
}

export async function hashAgentId(agentId: string | null, salt = ""): Promise<string | null> {
  if (!agentId) return null;
  const bytes = new TextEncoder().encode(`${salt}:${agentId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
