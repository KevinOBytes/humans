export type WorkspaceOption = {
  id: string;
  name: string;
  slug?: string | null;
};

export type ViewerSummary = {
  displayName: string;
  email: string;
  permissions: readonly string[];
  role: string;
};

export type PersonListItem = {
  id: string;
  displayName: string;
  preferredName?: string | null;
  sensitivity: string;
  status: string;
  updatedAt: string;
  version: number;
};

export type FactEvidenceView = {
  id: string;
  title: string;
  excerpt?: string | null;
  locator?: string | null;
  url?: string | null;
};

export type FactRevisionView = {
  id: string;
  revision: number;
  changeReason?: string | null;
  createdAt: string;
  actorLabel?: string | null;
};

export type FactView = {
  id: string;
  namespace: string;
  fieldKey: string;
  label: string;
  value: string;
  state: string;
  reviewState?: string | null;
  sensitivity: string;
  confidence?: number | null;
  temporalLabel?: string | null;
  version: number;
  selected: boolean;
  selectionVerified?: boolean;
  selectionVersion?: number | null;
  revisions: readonly FactRevisionView[];
  evidence: readonly FactEvidenceView[];
  revisionNextHref?: string | null;
  revisionResetHref?: string | null;
  evidenceNextHref?: string | null;
  evidenceResetHref?: string | null;
};

export type PersonProfileView = {
  id: string;
  displayName: string;
  preferredName?: string | null;
  biography?: string | null;
  status: string;
  sensitivity: string;
  confidence: number;
  version: number;
  facts: readonly FactView[];
};
