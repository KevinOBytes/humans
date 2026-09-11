import type { cases, caseMembers, caseResourceLinks } from "@/db/schema/cases";

export const caseResourceKinds = ["person", "fact", "relationship"] as const;
export type CaseResourceKind = (typeof caseResourceKinds)[number];
export type CaseRow = typeof cases.$inferSelect;
export type CaseMemberRow = typeof caseMembers.$inferSelect;
export type CaseResourceLinkRow = typeof caseResourceLinks.$inferSelect;
export type RelationshipProvenanceInput = {
  caseId?: string | null;
  governancePurpose?: string | null;
  observedAt?: Date | string | null;
  validFrom?: Date | string | null;
  validUntil?: Date | string | null;
  creationMethod?: string | null;
  reviewState?: string | null;
  state?: string | null;
  explicitConfirmed?: boolean | null;
  evidenceAssertionId?: string | null;
  reviewReason?: string | null;
};
