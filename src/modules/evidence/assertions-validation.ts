import { createGraphQLError } from "@/graphql/errors";
import { boundedCaseText } from "@/modules/cases/validation";
import {
  caseResourceKinds,
  type CaseResourceKind,
} from "@/modules/cases/types";

/** A citation identifies the authored version, never a mutable current value. */
export function parseIdentifierCitationPath(
  resourceKind: string,
  fieldPath: string | null,
) {
  if (!fieldPath || !/^identifiers\b/iu.test(fieldPath)) return null;
  const match =
    /^identifiers\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.v([1-9][0-9]*)\.(value|namespace|identifierType|issuer|validFrom|validUntil|verificationState)$/u.exec(
      fieldPath,
    );
  if (resourceKind !== "person" || !match || Number(match[2]) > 2_147_483_647)
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The identifier citation path is invalid.",
    );
  return { identifierId: match[1]!, version: Number(match[2]) };
}

export function normalizeEvidenceAssertion(input: {
  resourceKind: string;
  fieldPath?: unknown;
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
  const fieldPath =
    input.fieldPath == null ? null : boundedCaseText(input.fieldPath, 256);
  if (fieldPath && /[\u0000-\u001f\u007f]/u.test(fieldPath))
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The field path contains a control character.",
    );
  parseIdentifierCitationPath(input.resourceKind, fieldPath);
  return {
    resourceKind: input.resourceKind as CaseResourceKind,
    fieldPath,
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
