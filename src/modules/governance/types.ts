export const governanceScopes = [
  "read",
  "restricted_read",
  "write",
  "export",
  "ai_operation",
] as const;

export const lawfulBases = [
  "consent",
  "contract",
  "legal_obligation",
  "vital_interests",
  "public_task",
  "legitimate_interests",
] as const;

export type GovernanceScope = (typeof governanceScopes)[number];
export type LawfulBasis = (typeof lawfulBases)[number];
export type CoverageReason =
  | "covered"
  | "missing_consent"
  | "expired"
  | "withdrawn"
  | "field_not_permitted"
  | "case_not_permitted"
  | "legal_hold";

export type CoverageResult = {
  allowed: boolean;
  reason: CoverageReason;
  consentRecordId: string | null;
  policyId: string | null;
};

export type PurposeCoverageInput = {
  personId: string;
  purpose: string;
  scope: GovernanceScope;
  fieldDefinitionId?: string | null;
  caseReference?: string | null;
  at?: Date;
};

export type GovernanceValidationIssue = {
  path: string[];
  code: string;
  message: string;
};

export type GovernanceValidationResult<T> =
  | { value: T; issues: [] }
  | { value?: undefined; issues: GovernanceValidationIssue[] };
