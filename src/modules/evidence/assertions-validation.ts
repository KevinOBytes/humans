import { createGraphQLError } from "@/graphql/errors";
import { boundedCaseText } from "@/modules/cases/validation";
import {
  caseResourceKinds,
  type CaseResourceKind,
} from "@/modules/cases/types";

export function normalizeEvidenceAssertion(input: {
  resourceKind: string;
  locator: unknown;
  quote: unknown;
  role: string;
  confidence: number;
}) {
  if (
    !caseResourceKinds.includes(input.resourceKind as CaseResourceKind) ||
    !["supports", "contradicts", "context"].includes(input.role) ||
    !Number.isFinite(input.confidence) ||
    input.confidence < 0 ||
    input.confidence > 1
  )
    throw createGraphQLError("VALIDATION_FAILED", "The assertion is invalid.");
  return {
    resourceKind: input.resourceKind as CaseResourceKind,
    locator: boundedCaseText(input.locator, 2048),
    quote: boundedCaseText(input.quote, 8000),
    role: input.role,
    confidence: input.confidence.toFixed(3),
  };
}
export function requiresRelationshipPromotionReview(input: {
  from: string;
  to: string;
  reviewState?: string;
}) {
  return (
    ["asserted", "corroborated"].includes(input.to) &&
    (input.from === "inferred" ||
      (input.from !== input.to && input.reviewState !== "approved"))
  );
}
export function requireReviewedPromotion(input: {
  from: string;
  to: string;
  reviewState?: string;
  reviewer: boolean;
  assertionApproved: boolean;
  approvalRecorded: boolean;
}) {
  if (
    requiresRelationshipPromotionReview(input) &&
    !(input.reviewer && input.assertionApproved && input.approvalRecorded)
  )
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "A reviewed assertion and approval are required for promotion.",
    );
}
