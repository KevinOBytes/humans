import { createGraphQLError } from "@/graphql/errors";
import { normalizeHumanText } from "@/modules/facts/validation";
import { normalizeGovernanceContext } from "@/modules/governance/validation";
import type { RelationshipProvenanceInput } from "./types";

export function boundedCaseText(value: unknown, max: number) {
  const result = normalizeHumanText(value, { path: ["input"], min: 1, max });
  if (!result.value || result.issues.length)
    throw createGraphQLError("VALIDATION_FAILED", "The input is invalid.");
  return result.value;
}
export function normalizeCaseInput(input: {
  title: unknown;
  purpose: unknown;
}) {
  const governance = normalizeGovernanceContext({
    governancePurpose: input.purpose as string,
  });
  return {
    title: boundedCaseText(input.title, 200),
    purpose: governance.governancePurpose!,
  };
}
export function canReadCase(input: {
  sameWorkspace: boolean;
  member: boolean;
  resourceVisible: boolean;
}) {
  return input.sameWorkspace && input.member && input.resourceVisible;
}
export function normalizeRelationshipProvenance(
  input: RelationshipProvenanceInput,
) {
  const date = (value: Date | string | null | undefined) => {
    if (value == null) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime()))
      throw createGraphQLError("VALIDATION_FAILED", "The date is invalid.");
    return parsed;
  };
  const validFrom = date(input.validFrom);
  const validUntil = date(input.validUntil);
  if (validFrom && validUntil && validUntil < validFrom)
    throw createGraphQLError("VALIDATION_FAILED", "The interval is invalid.");
  const creationMethod = input.creationMethod?.toLowerCase() ?? "manual";
  const reviewState = input.reviewState?.toLowerCase() ?? "unreviewed";
  if (
    !["manual", "import", "ai"].includes(creationMethod) ||
    !["unreviewed", "approved", "rejected"].includes(reviewState)
  )
    throw createGraphQLError("VALIDATION_FAILED", "The provenance is invalid.");
  if (
    creationMethod !== "manual" &&
    (input.state ?? "inferred").toLowerCase() !== "inferred"
  )
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "Machine-created claims require review before promotion.",
    );
  return {
    validFrom,
    validUntil,
    observedAt: date(input.observedAt),
    creationMethod,
    reviewState,
  };
}
