import { pgEnum } from "drizzle-orm/pg-core";

export const sensitivityEnum = pgEnum("sensitivity", [
  "public",
  "internal",
  "confidential",
  "restricted",
]);

export const lifecycleStateEnum = pgEnum("lifecycle_state", [
  "active",
  "inactive",
  "archived",
]);

export const policyStateEnum = pgEnum("policy_state", [
  "draft",
  "active",
  "disabled",
  "archived",
]);

export const deletionBehaviorEnum = pgEnum("deletion_behavior", [
  "review",
  "soft_delete",
  "hard_delete",
  "anonymize",
]);

export const deletionRequestStateEnum = pgEnum("deletion_request_state", [
  "requested",
  "reviewing",
  "approved",
  "rejected",
  "exporting",
  "deleting",
  "completed",
  "cancelled",
]);

export const legalHoldStateEnum = pgEnum("legal_hold_state", [
  "active",
  "released",
]);

export const consentStatusEnum = pgEnum("consent_status", [
  "granted",
  "denied",
  "withdrawn",
  "expired",
  "unknown",
]);

export const personStatusEnum = pgEnum("person_status", [
  "active",
  "deceased",
  "missing",
  "unknown",
  "archived",
  "merged",
]);

export const personNameKindEnum = pgEnum("person_name_kind", [
  "legal",
  "preferred",
  "birth",
  "married",
  "former",
  "alias",
  "transliteration",
  "other",
]);

export const personRecordStateEnum = pgEnum("person_record_state", [
  "asserted",
  "verified",
  "disputed",
  "superseded",
  "unknown",
]);

export const identifierVerificationStateEnum = pgEnum(
  "identifier_verification_state",
  ["unverified", "verified", "disputed", "revoked", "unknown"],
);

export const mergeCandidateStateEnum = pgEnum("merge_candidate_state", [
  "pending",
  "reviewing",
  "accepted",
  "rejected",
  "cancelled",
]);

export const factValueTypeEnum = pgEnum("fact_value_type", [
  "text",
  "rich_text",
  "integer",
  "decimal",
  "boolean",
  "date",
  "date_range",
  "timestamp",
  "duration",
  "quantity",
  "uri",
  "json",
  "person_reference",
  "place_reference",
  "file_reference",
]);

export const factCardinalityEnum = pgEnum("fact_cardinality", ["one", "many"]);

export const factDefinitionStateEnum = pgEnum("fact_definition_state", [
  "draft",
  "active",
  "deprecated",
  "archived",
]);

export const factStateEnum = pgEnum("fact_state", [
  "asserted",
  "corroborated",
  "disputed",
  "disproven",
  "superseded",
  "unknown",
]);

export const factReviewStateEnum = pgEnum("fact_review_state", [
  "unreviewed",
  "in_review",
  "accepted",
  "rejected",
  "needs_attention",
]);

export const temporalSemanticsEnum = pgEnum("temporal_semantics", [
  "exact",
  "approximate",
  "before",
  "after",
  "between",
  "year_only",
  "unknown",
]);

export const temporalPrecisionEnum = pgEnum("temporal_precision", [
  "instant",
  "second",
  "minute",
  "hour",
  "day",
  "month",
  "year",
  "range",
  "unknown",
]);

export const factRelationshipTypeEnum = pgEnum("fact_relationship_type", [
  "supports",
  "contradicts",
  "duplicates",
  "supersedes",
  "derived_from",
]);
