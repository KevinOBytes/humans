/* eslint-disable */
/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> =
  | T
  | {
      [P in keyof T]?: P extends " $fragmentName" | "__typename" ? T[P] : never;
    };
import type { DocumentTypeDecoration } from "@graphql-typed-document-node/core";
export type AccessPolicyInput = {
  name: string;
  resourceKinds: Array<string>;
  roleBindings: unknown;
  sensitivityCeiling: Sensitivity;
  state: PolicyState;
};

export type ActorKind = "API_KEY" | "LEGACY" | "SYSTEM" | "USER";

export type AiAnalysisScopeInput = {
  evidenceIds?: Array<string> | null | undefined;
  personIds?: Array<string> | null | undefined;
};

export type AiFailureCode =
  | "ANALYSIS_CANCELLED"
  | "ANALYSIS_LIMIT_REACHED"
  | "AUTHORIZATION_CHANGED"
  | "EXECUTION_FAILED"
  | "INPUT_UNAVAILABLE"
  | "PROVIDER_INVALID_RESPONSE"
  | "PROVIDER_RESPONSE_TOO_LARGE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE";

export type AiProvider = "COMPATIBLE" | "OLLAMA" | "OPENAI";

export type AiResourceKind = "EVIDENCE" | "PERSON";

export type AiRunState =
  "CANCELLED" | "COMPLETED" | "FAILED" | "PENDING" | "RUNNING";

export type AiToolState = "COMPLETED" | "FAILED" | "PENDING" | "RUNNING";

export type ArchiveGraphViewInput = {
  expectedVersion: number;
  id: string;
};

export type ArchiveNoteInput = {
  expectedVersion: number;
  id: string;
};

export type ArchivePersonAddressInput = {
  associationId: string;
  expectedAddressVersion: number;
  expectedVersion: number;
  idempotencyKey: string;
};

export type ArchivePersonInput = {
  expectedVersion: number;
  id: string;
};

export type ArchivePhoneContactInput = {
  associationId: string;
  expectedContactVersion: number;
  expectedVersion: number;
  idempotencyKey: string;
};

export type ArchivePlaceInput = {
  expectedVersion: number;
  id: string;
  idempotencyKey: string;
};

export type ArchiveRelationshipInput = {
  expectedVersion: number;
  id: string;
};

export type AuditEventFilterInput = {
  action?: string | null | undefined;
  occurredFrom?: string | null | undefined;
  occurredUntil?: string | null | undefined;
  outcome?: AuditOutcome | null | undefined;
  resourceId?: string | null | undefined;
  resourceKind?: string | null | undefined;
};

export type AuditOutcome = "FAILURE" | "SUCCESS";

export type CreateEvidenceExcerptInput = {
  checksum: string;
  endOffset?: number | null | undefined;
  endTimeMs?: number | null | undefined;
  evidenceItemId: string;
  excerpt: string;
  language?: string | null | undefined;
  locator?: string | null | undefined;
  pageNumber?: number | null | undefined;
  redactionState?: string | null | undefined;
  startOffset?: number | null | undefined;
  startTimeMs?: number | null | undefined;
};

export type CreateEvidenceItemInput = {
  capturedAt?: string | null | undefined;
  checksum: string;
  externalLocator?: string | null | undefined;
  extractedText?: string | null | undefined;
  fileId?: string | null | undefined;
  reviewState?: string | null | undefined;
  sensitivity?: Sensitivity | null | undefined;
  sourceId: string;
};

export type CreateFactDefinitionInput = {
  allowedValueType: FactValueType;
  cardinality?: FactCardinality | null | undefined;
  category?: string | null | undefined;
  defaultSensitivity?: Sensitivity | null | undefined;
  description?: string | null | undefined;
  enumerationMetadata?: unknown;
  fieldKey: string;
  filterable?: boolean | null | undefined;
  graphable?: boolean | null | undefined;
  label: string;
  namespace: string;
  searchable?: boolean | null | undefined;
  state?: FactDefinitionState | null | undefined;
  validationSchema?: unknown;
};

export type CreateFactInput = {
  confidence?: number | null | undefined;
  confidenceExplanation?: string | null | undefined;
  confidenceMethod?: string | null | undefined;
  definitionId: string;
  language?: string | null | undefined;
  observedAt?: string | null | undefined;
  personId: string;
  reviewState?: FactReviewState | null | undefined;
  sensitivity?: Sensitivity | null | undefined;
  state?: FactState | null | undefined;
  supersedesFactId?: string | null | undefined;
  temporalPrecision?: TemporalPrecision | null | undefined;
  temporalSemantics?: TemporalSemantics | null | undefined;
  validEarliestAt?: string | null | undefined;
  validLatestAt?: string | null | undefined;
  value: FactValueInput;
};

export type CreateGraphViewInput = {
  appearance?: GraphViewAppearanceInput | null | undefined;
  filter: GraphFilterInput;
  layout?: GraphViewLayoutInput | null | undefined;
  name: string;
  positions?: Array<GraphPositionInput> | null | undefined;
  sharing?: GraphViewSharing | null | undefined;
};

export type CreateNoteInput = {
  content: NoteContentInput;
  sensitivity?: Sensitivity | null | undefined;
  subject?: NoteSubjectInput | null | undefined;
};

export type CreateOrganizationApiKeyInput = {
  expiresInSeconds?: number | null | undefined;
  name: string;
  scopes: Array<string>;
};

export type CreatePersonAddressInput = {
  addressKind: string;
  confidence?: number | null | undefined;
  countryCode?: string | null | undefined;
  evidenceId?: string | null | undefined;
  idempotencyKey: string;
  isPrimary?: boolean | null | undefined;
  latitude?: number | null | undefined;
  line1?: string | null | undefined;
  line2?: string | null | undefined;
  locality?: string | null | undefined;
  longitude?: number | null | undefined;
  personId: string;
  placeId?: string | null | undefined;
  postalCode?: string | null | undefined;
  region?: string | null | undefined;
  sensitivity?: Sensitivity | null | undefined;
  state?: string | null | undefined;
  temporalPrecision?: string | null | undefined;
  unstructuredText?: string | null | undefined;
  validFrom?: string | null | undefined;
  validUntil?: string | null | undefined;
};

export type CreatePersonContactInput = {
  confidence?: number | null | undefined;
  evidenceId?: string | null | undefined;
  idempotencyKey: string;
  isPrimary?: boolean | null | undefined;
  kind: string;
  label?: string | null | undefined;
  personId: string;
  sensitivity?: Sensitivity | null | undefined;
  usageKind: string;
  validFrom?: string | null | undefined;
  validUntil?: string | null | undefined;
  value: string;
  verificationState?: string | null | undefined;
};

export type CreatePersonInput = {
  biography?: string | null | undefined;
  confidence?: number | null | undefined;
  confidenceExplanation?: string | null | undefined;
  displayName: string;
  preferredName?: string | null | undefined;
  sensitivity?: Sensitivity | null | undefined;
  sortName?: string | null | undefined;
  status?: PersonStatus | null | undefined;
};

export type CreatePhoneContactInput = {
  confidence?: number | null | undefined;
  evidenceId?: string | null | undefined;
  idempotencyKey: string;
  isPrimary?: boolean | null | undefined;
  label?: string | null | undefined;
  personId: string;
  sensitivity?: Sensitivity | null | undefined;
  usageKind: string;
  validFrom?: string | null | undefined;
  validUntil?: string | null | undefined;
  value: string;
  verificationState?: string | null | undefined;
};

export type CreatePlaceInput = {
  countryCode?: string | null | undefined;
  idempotencyKey: string;
  kind: string;
  latitude?: number | null | undefined;
  locality?: string | null | undefined;
  longitude?: number | null | undefined;
  name: string;
  parentPlaceId?: string | null | undefined;
  region?: string | null | undefined;
  sensitivity?: Sensitivity | null | undefined;
};

export type CreateRelationshipInput = {
  confidence?: number | null | undefined;
  labelOverride?: string | null | undefined;
  metadata?: unknown;
  relationshipTypeId: string;
  sensitivity?: Sensitivity | null | undefined;
  sourcePersonId: string;
  state?: string | null | undefined;
  strength?: number | null | undefined;
  targetPersonId: string;
  temporalPrecision?: RelationshipTemporalPrecision | null | undefined;
  temporalSemantics?: RelationshipTemporalSemantics | null | undefined;
  validFrom?: string | null | undefined;
  validUntil?: string | null | undefined;
};

export type CreateRelationshipTypeInput = {
  allowedMultiplicity?: RelationshipMultiplicity | null | undefined;
  allowsSelf?: boolean | null | undefined;
  directed?: boolean | null | undefined;
  forwardLabel: string;
  inverseLabel: string;
  key: string;
  metadataSchema?: unknown;
  namespace?: string | null | undefined;
  state?: LifecycleState | null | undefined;
};

export type CreateResourceGrantInput = {
  memberId?: string | null | undefined;
  policyId: string;
  resourceId: string;
  resourceKind: string;
  role?: WorkspaceAdministrationRole | null | undefined;
  validFrom?: string | null | undefined;
  validUntil?: string | null | undefined;
};

export type CreateSavedQueryInput = {
  name: string;
  queryAst: unknown;
  sharing: SavedQuerySharing;
};

export type CreateSourceInput = {
  author?: string | null | undefined;
  canonicalUrl?: string | null | undefined;
  citation?: string | null | undefined;
  collectedAt?: string | null | undefined;
  collectionMethod?: string | null | undefined;
  contentHash?: string | null | undefined;
  kind: string;
  metadata?: unknown;
  publisher?: string | null | undefined;
  reliability?: number | null | undefined;
  sensitivity?: Sensitivity | null | undefined;
  title: string;
};

export type CreateTagInput = {
  color?: string | null | undefined;
  description?: string | null | undefined;
  name: string;
};

export type CreateUploadSessionInput = {
  byteSize: number;
  checksumSha256: string;
  claimedMediaType: string;
  originalName: string;
  purpose: UploadPurpose;
  sensitivity?: Sensitivity | null | undefined;
};

export type CreateWebhookInput = {
  events: Array<string>;
  url: string;
};

export type ExtractionRunState =
  "CANCELLED" | "COMPLETED" | "ERROR" | "PENDING" | "PROCESSING";

export type FactCardinality = "MANY" | "ONE";

export type FactDefinitionState =
  "ACTIVE" | "ARCHIVED" | "DEPRECATED" | "DRAFT";

export type FactReviewState =
  "ACCEPTED" | "IN_REVIEW" | "NEEDS_ATTENTION" | "REJECTED" | "UNREVIEWED";

export type FactState =
  | "ASSERTED"
  | "CORROBORATED"
  | "DISPROVEN"
  | "DISPUTED"
  | "SUPERSEDED"
  | "UNKNOWN";

export type FactValueInput = {
  boolean?: boolean | null | undefined;
  dateEnd?: string | null | undefined;
  dateStart?: string | null | undefined;
  decimal?: string | null | undefined;
  fileId?: string | null | undefined;
  json?: unknown;
  placeId?: string | null | undefined;
  referencedPersonId?: string | null | undefined;
  text?: string | null | undefined;
  timestamp?: string | null | undefined;
  unit?: string | null | undefined;
};

export type FactValueType =
  | "BOOLEAN"
  | "DATE"
  | "DATE_RANGE"
  | "DECIMAL"
  | "DURATION"
  | "FILE_REFERENCE"
  | "INTEGER"
  | "JSON"
  | "PERSON_REFERENCE"
  | "PLACE_REFERENCE"
  | "QUANTITY"
  | "RICH_TEXT"
  | "TEXT"
  | "TIMESTAMP"
  | "URI";

export type FileAvailability = "AVAILABLE" | "QUARANTINED" | "REJECTED";

export type FileExtractionState =
  | "CANCELLED"
  | "COMPLETED"
  | "ERROR"
  | "NOT_REQUESTED"
  | "PENDING"
  | "PROCESSING";

export type FileGrantMethod = "GET" | "PUT";

export type FileScanState =
  "CLEAN" | "ERROR" | "INFECTED" | "NOT_REQUIRED" | "PENDING";

export type GraphAnalysisAlgorithm =
  "DEGREE" | "LOUVAIN_COMMUNITY" | "PAGERANK";

export type GraphAnalysisExportFormat = "CSV" | "JSON";

export type GraphFilterInput = {
  at?: string | null | undefined;
  depth?: number | null | undefined;
  edgeLimit?: number | null | undefined;
  from?: string | null | undefined;
  includeIsolates?: boolean | null | undefined;
  minimumConfidence?: number | null | undefined;
  mode: GraphTraversalMode;
  nodeLimit?: number | null | undefined;
  relationshipStates?: Array<GraphRelationshipState> | null | undefined;
  relationshipTypeIds?: Array<string> | null | undefined;
  rootPersonIds?: Array<string> | null | undefined;
  sensitivities?: Array<Sensitivity> | null | undefined;
  until?: string | null | undefined;
};

export type GraphLayoutAlgorithm = "CIRCLE" | "FORCE_ATLAS_2";

export type GraphPalette = "DEFAULT" | "MONOCHROME";

export type GraphPositionInput = {
  id: string;
  x: number;
  y: number;
};

export type GraphRelationshipState =
  | "ASSERTED"
  | "CORROBORATED"
  | "DISPROVEN"
  | "DISPUTED"
  | "INACTIVE"
  | "INFERRED";

export type GraphTraversalMode = "NEIGHBORHOOD" | "WORKSPACE";

export type GraphViewAppearanceInput = {
  palette?: GraphPalette | null | undefined;
  showLabels?: boolean | null | undefined;
};

export type GraphViewLayoutInput = {
  algorithm?: GraphLayoutAlgorithm | null | undefined;
  settings?: GraphViewLayoutSettingsInput | null | undefined;
};

export type GraphViewLayoutSettingsInput = {
  barnesHutOptimize?: boolean | null | undefined;
  gravity?: number | null | undefined;
  scalingRatio?: number | null | undefined;
  slowDown?: number | null | undefined;
};

export type GraphViewSharing = "PRIVATE" | "WORKSPACE";

export type IdentityCandidateState =
  "ACCEPTED" | "CANCELLED" | "PENDING" | "REJECTED" | "REVIEWING";

export type ImportFormat = "CSV" | "JSON";

export type ImportMode = "COMMIT" | "DRY_RUN";

export type ImportState =
  | "COMPLETED"
  | "COMPLETED_WITH_ERRORS"
  | "DEAD_LETTER"
  | "FAILED"
  | "PREVIEW_READY"
  | "QUEUED"
  | "RUNNING"
  | "STAGING";

export type IssueWorkspaceInvitationInput = {
  email: string;
  idempotencyKey: string;
  role: WorkspaceAdministrationRole;
};

export type LifecycleState = "ACTIVE" | "ARCHIVED" | "INACTIVE";

export type LinkFactEvidenceInput = {
  evidenceItemId: string;
  excerpt?: string | null | undefined;
  factId: string;
  locator?: string | null | undefined;
  supportStrength?: number | null | undefined;
};

export type LinkRelationshipEvidenceInput = {
  evidenceItemId: string;
  locator?: string | null | undefined;
  relationshipId: string;
  supportStrength?: number | null | undefined;
};

export type MergePersonInput = {
  loserPersonId: string;
  reason: string;
  winnerPersonId: string;
};

export type NoteContentInput = {
  markdown?: string | null | undefined;
  plainText?: string | null | undefined;
};

export type NoteSubjectInput = {
  evidenceItemId?: string | null | undefined;
  factId?: string | null | undefined;
  personId?: string | null | undefined;
  relationshipId?: string | null | undefined;
};

export type PersonFilterInput = {
  name?: string | null | undefined;
  nameContains?: string | null | undefined;
  namePrefix?: string | null | undefined;
  sensitivity?: Sensitivity | null | undefined;
  status?: PersonStatus | null | undefined;
};

export type PersonNameKind =
  | "ALIAS"
  | "BIRTH"
  | "FORMER"
  | "LEGAL"
  | "MARRIED"
  | "OTHER"
  | "PREFERRED"
  | "TRANSLITERATION";

export type PersonRecordState =
  "ASSERTED" | "DISPUTED" | "SUPERSEDED" | "UNKNOWN" | "VERIFIED";

export type PersonStatus =
  "ACTIVE" | "ARCHIVED" | "DECEASED" | "MERGED" | "MISSING" | "UNKNOWN";

export type PersonTemporalPrecision =
  | "DAY"
  | "HOUR"
  | "INSTANT"
  | "MINUTE"
  | "MONTH"
  | "RANGE"
  | "SECOND"
  | "UNKNOWN"
  | "YEAR";

export type PersonTemporalSemantics =
  | "AFTER"
  | "APPROXIMATE"
  | "BEFORE"
  | "BETWEEN"
  | "EXACT"
  | "UNKNOWN"
  | "YEAR_ONLY";

export type PolicyState = "ACTIVE" | "ARCHIVED" | "DISABLED" | "DRAFT";

export type PrepareImportInput = {
  fileId: string;
  idempotencyKey: string;
  mappingId: string;
  mode?: ImportMode | null | undefined;
};

export type ProtectedSearchKind = "PERSON_IDENTIFIER" | "PHONE";

export type RelationshipMultiplicity =
  "MANY_TO_MANY" | "MANY_TO_ONE" | "ONE_TO_MANY" | "ONE_TO_ONE";

export type RelationshipTemporalPrecision =
  | "DAY"
  | "HOUR"
  | "INSTANT"
  | "MINUTE"
  | "MONTH"
  | "RANGE"
  | "SECOND"
  | "UNKNOWN"
  | "YEAR";

export type RelationshipTemporalSemantics =
  | "AFTER"
  | "APPROXIMATE"
  | "BEFORE"
  | "BETWEEN"
  | "EXACT"
  | "UNKNOWN"
  | "YEAR_ONLY";

export type ReplayGraphSnapshotInput = {
  snapshotId: string;
};

export type RerunGraphAnalysisInput = {
  algorithm: GraphAnalysisAlgorithm;
  snapshotId: string;
};

export type ReviewIdentityCandidateInput = {
  expectedVersion: number;
  id: string;
  reason?: string | null | undefined;
  state: IdentityCandidateState;
};

export type ReviseFactInput = {
  changeReason?: string | null | undefined;
  confidence?: number | null | undefined;
  expectedVersion: number;
  id: string;
  reviewState?: FactReviewState | null | undefined;
  sensitivity?: Sensitivity | null | undefined;
  state?: FactState | null | undefined;
  value?: FactValueInput | null | undefined;
};

export type RevokeOrganizationApiKeyInput = {
  actionId: string;
};

export type RotateOrganizationApiKeyInput = {
  actionId: string;
  expiresInSeconds?: number | null | undefined;
  name: string;
  scopes: Array<string>;
};

export type RunGraphAnalysisInput = {
  algorithm: GraphAnalysisAlgorithm;
  filter?: GraphFilterInput | null | undefined;
  graphViewId?: string | null | undefined;
};

export type SaveImportMappingInput = {
  definition: unknown;
  expectedVersion?: number | null | undefined;
  format: ImportFormat;
  id?: string | null | undefined;
  name: string;
};

export type SavedQuerySharing = "PRIVATE" | "WORKSPACE";

export type SearchFiltersInput = {
  at?: string | null | undefined;
  factDefinitionIds?: Array<string> | null | undefined;
  factStates?: Array<string> | null | undefined;
  from?: string | null | undefined;
  personIds?: Array<string> | null | undefined;
  relationshipStates?: Array<string> | null | undefined;
  relationshipTypeIds?: Array<string> | null | undefined;
  sensitivities?: Array<Sensitivity> | null | undefined;
  sourceIds?: Array<string> | null | undefined;
  until?: string | null | undefined;
};

export type SearchInput = {
  after?: string | null | undefined;
  filters: SearchFiltersInput;
  first?: number | null | undefined;
  kinds: Array<SearchResultKind>;
  match: SearchMatchInput;
  version: number;
};

export type SearchMatchInput = {
  namespace?: string | null | undefined;
  protectedKind?: ProtectedSearchKind | null | undefined;
  query?: string | null | undefined;
  type: SearchMatchType;
  value?: string | null | undefined;
};

export type SearchMatchType = "PROTECTED_EXACT" | "TEXT";

export type SearchResultKind =
  "ADDRESS" | "EVIDENCE" | "FACT" | "PERSON" | "RELATIONSHIP";

export type SelectPersonFieldInput = {
  expectedVersion?: number | null | undefined;
  factId: string;
  fieldKey: string;
  namespace: string;
  personId: string;
  selectionReason?: string | null | undefined;
};

export type SelectPersonPresentationInput = {
  expectedVersion: number;
  personId: string;
  primaryNameId?: string | null | undefined;
  primaryPhotoFileId?: string | null | undefined;
};

export type Sensitivity = "CONFIDENTIAL" | "INTERNAL" | "PUBLIC" | "RESTRICTED";

export type StartAiAnalysisInput = {
  idempotencyKey: string;
  question: string;
  scope?: AiAnalysisScopeInput | null | undefined;
};

export type TagFilterInput = {
  normalizedNamePrefix?: string | null | undefined;
};

export type TagPersonInput = {
  personId: string;
  tagId: string;
};

export type TemporalPrecision =
  | "DAY"
  | "HOUR"
  | "INSTANT"
  | "MINUTE"
  | "MONTH"
  | "RANGE"
  | "SECOND"
  | "UNKNOWN"
  | "YEAR";

export type TemporalSemantics =
  | "AFTER"
  | "APPROXIMATE"
  | "BEFORE"
  | "BETWEEN"
  | "EXACT"
  | "UNKNOWN"
  | "YEAR_ONLY";

export type UnmergePersonInput = {
  expectedVersion: number;
  loserPersonId: string;
};

export type UpdateGraphViewInput = {
  appearance?: GraphViewAppearanceInput | null | undefined;
  expectedVersion: number;
  filter?: GraphFilterInput | null | undefined;
  id: string;
  layout?: GraphViewLayoutInput | null | undefined;
  name?: string | null | undefined;
  positions?: Array<GraphPositionInput> | null | undefined;
  sharing?: GraphViewSharing | null | undefined;
};

export type UpdateNoteInput = {
  content?: NoteContentInput | null | undefined;
  expectedVersion: number;
  id: string;
  sensitivity?: Sensitivity | null | undefined;
};

export type UpdatePersonAddressInput = {
  addressKind?: string | null | undefined;
  associationId: string;
  confidence?: number | null | undefined;
  countryCode?: string | null | undefined;
  evidenceId?: string | null | undefined;
  expectedAddressVersion: number;
  expectedVersion: number;
  idempotencyKey: string;
  isPrimary?: boolean | null | undefined;
  latitude?: number | null | undefined;
  line1?: string | null | undefined;
  line2?: string | null | undefined;
  locality?: string | null | undefined;
  longitude?: number | null | undefined;
  placeId?: string | null | undefined;
  postalCode?: string | null | undefined;
  region?: string | null | undefined;
  sensitivity?: Sensitivity | null | undefined;
  state?: string | null | undefined;
  temporalPrecision?: string | null | undefined;
  unstructuredText?: string | null | undefined;
  validFrom?: string | null | undefined;
  validUntil?: string | null | undefined;
};

export type UpdatePersonInput = {
  biography?: string | null | undefined;
  displayName?: string | null | undefined;
  expectedVersion: number;
  id: string;
  preferredName?: string | null | undefined;
  sensitivity?: Sensitivity | null | undefined;
  sortName?: string | null | undefined;
  status?: PersonStatus | null | undefined;
};

export type UpdatePhoneContactInput = {
  associationId: string;
  confidence?: number | null | undefined;
  evidenceId?: string | null | undefined;
  expectedContactVersion: number;
  expectedVersion: number;
  idempotencyKey: string;
  isPrimary?: boolean | null | undefined;
  label?: string | null | undefined;
  sensitivity?: Sensitivity | null | undefined;
  usageKind?: string | null | undefined;
  validFrom?: string | null | undefined;
  validUntil?: string | null | undefined;
  value?: string | null | undefined;
  verificationState?: string | null | undefined;
};

export type UpdatePlaceInput = {
  countryCode?: string | null | undefined;
  expectedVersion: number;
  id: string;
  idempotencyKey: string;
  kind?: string | null | undefined;
  latitude?: number | null | undefined;
  locality?: string | null | undefined;
  longitude?: number | null | undefined;
  name?: string | null | undefined;
  parentPlaceId?: string | null | undefined;
  region?: string | null | undefined;
  sensitivity?: Sensitivity | null | undefined;
};

export type UpdateRelationshipInput = {
  confidence?: number | null | undefined;
  expectedVersion: number;
  id: string;
  labelOverride?: string | null | undefined;
  metadata?: unknown;
  sensitivity?: Sensitivity | null | undefined;
  state?: string | null | undefined;
  strength?: number | null | undefined;
  temporalPrecision?: RelationshipTemporalPrecision | null | undefined;
  temporalSemantics?: RelationshipTemporalSemantics | null | undefined;
  validFrom?: string | null | undefined;
  validUntil?: string | null | undefined;
};

export type UpdateSavedQueryInput = {
  expectedVersion: number;
  id: string;
  name?: string | null | undefined;
  queryAst?: unknown;
  sharing?: SavedQuerySharing | null | undefined;
};

export type UpdateWorkspaceDefaultsInput = {
  aiEnabled?: boolean | null | undefined;
  expectedVersion: number;
  locale?: string | null | undefined;
  retentionDays?: number | null | undefined;
  storageEnabled?: boolean | null | undefined;
  timezone?: string | null | undefined;
};

export type UpdateWorkspaceMemberRoleInput = {
  actionId: string;
  idempotencyKey: string;
  role: WorkspaceAdministrationRole;
};

export type UploadPurpose = "CSV_IMPORT" | "EVIDENCE" | "JSON_IMPORT";

export type UploadSessionState =
  | "CLEANUP_PENDING"
  | "COMPLETED"
  | "EXPIRED"
  | "PENDING"
  | "REJECTED"
  | "VERIFYING";

export type WebhookIdInput = {
  id: string;
};

export type WorkspaceAdministrationRole =
  "ADMIN" | "ANALYST" | "CONTRIBUTOR" | "VIEWER";

export type WorkspaceInvitationActionInput = {
  actionId: string;
  idempotencyKey: string;
};

export type AnalystPublicRunFragment = {
  id: string | null;
  state: AiRunState | null;
  provider: AiProvider | null;
  model: string | null;
  answer: string | null;
  errorCode: AiFailureCode | null;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  citations: Array<{
    claimText: string | null;
    locator: string | null;
    resourceId: string | null;
    resourceKind: AiResourceKind | null;
  }> | null;
  toolCalls: Array<{
    name: string | null;
    state: AiToolState | null;
    startedAt: string | null;
    completedAt: string | null;
    inputSummary: {
      evidenceCount: number | null;
      filterCount: number | null;
      personCount: number | null;
      resourceCount: number | null;
      resultCount: number | null;
      truncated: boolean | null;
    } | null;
    resultSummary: {
      evidenceCount: number | null;
      filterCount: number | null;
      personCount: number | null;
      resourceCount: number | null;
      resultCount: number | null;
      truncated: boolean | null;
    } | null;
  }> | null;
} & { " $fragmentName"?: "AnalystPublicRunFragment" };

export type StartAiAnalysisMutationVariables = Exact<{
  input: StartAiAnalysisInput;
}>;

export type StartAiAnalysisMutation = {
  startAiAnalysis: {
    " $fragmentRefs"?: { AnalystPublicRunFragment: AnalystPublicRunFragment };
  } | null;
};

export type AiRunQueryVariables = Exact<{
  id: string;
}>;

export type AiRunQuery = {
  aiRun: {
    " $fragmentRefs"?: { AnalystPublicRunFragment: AnalystPublicRunFragment };
  } | null;
};

export type CancelAiAnalysisMutationVariables = Exact<{
  id: string;
}>;

export type CancelAiAnalysisMutation = {
  cancelAiAnalysis: {
    " $fragmentRefs"?: { AnalystPublicRunFragment: AnalystPublicRunFragment };
  } | null;
};

export type DashboardOverviewQueryVariables = Exact<{
  includeActivity: boolean;
}>;

export type DashboardOverviewQuery = {
  dashboardRecentPeople: {
    nodes: Array<{
      " $fragmentRefs"?: { PersonSummaryFragment: PersonSummaryFragment };
    }>;
  };
  imports: {
    nodes: Array<{
      " $fragmentRefs"?: {
        ImportWorkspaceItemFragment: ImportWorkspaceItemFragment;
      };
    }> | null;
  } | null;
  dashboardRecentGraphAnalyses: {
    nodes: Array<{
      id: string | null;
      algorithm: string | null;
      state: string | null;
      startedAt: string | null;
      completedAt: string | null;
      createdAt: string | null;
    }>;
  };
  dashboardRecentAiAnalyses: {
    nodes: Array<{
      id: string | null;
      provider: AiProvider | null;
      model: string | null;
      state: AiRunState | null;
      startedAt: string | null;
      completedAt: string | null;
      createdAt: string | null;
    }>;
  };
  graphStatistics: { visiblePeople: number; visibleRelationships: number };
  workspacePolicySummary: {
    defaultRetentionDays: number | null;
    aiEnabled: boolean;
    storageEnabled: boolean;
  };
  auditEvents?: {
    nodes: Array<{
      action: string | null;
      resourceKind: string | null;
      outcome: AuditOutcome | null;
      occurredAt: string | null;
      actor: { kind: ActorKind | null; label: string | null } | null;
    }> | null;
  } | null;
};

export type FileWorkspaceItemFragment = {
  id: string | null;
  originalName: string | null;
  mediaType: string | null;
  detectedType: string | null;
  byteSize: number | null;
  availability: FileAvailability | null;
  scanState: FileScanState | null;
  extractionState: FileExtractionState | null;
  sensitivity: Sensitivity | null;
  version: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  variants: Array<{
    id: string | null;
    kind: string | null;
    mediaType: string | null;
    byteSize: number | null;
    checksum: string | null;
    generatorVersion: string | null;
    createdAt: string | null;
  }> | null;
} & { " $fragmentName"?: "FileWorkspaceItemFragment" };

export type ImportWorkspaceItemFragment = {
  id: string | null;
  fileId: string | null;
  format: ImportFormat | null;
  state: ImportState | null;
  mappingId: string | null;
  totalRows: number | null;
  acceptedRows: number | null;
  rejectedRows: number | null;
  startedAt: string | null;
  completedAt: string | null;
  version: number | null;
  createdAt: string | null;
  updatedAt: string | null;
} & { " $fragmentName"?: "ImportWorkspaceItemFragment" };

export type EvidenceFilesQueryVariables = Exact<{
  first?: number | null | undefined;
  after?: string | null | undefined;
}>;

export type EvidenceFilesQuery = {
  files: {
    nodes: Array<{
      " $fragmentRefs"?: {
        FileWorkspaceItemFragment: FileWorkspaceItemFragment;
      };
    }> | null;
    pageInfo: { hasNextPage: boolean; endCursor: string | null } | null;
  } | null;
};

export type PendingWorkspaceUploadsQueryVariables = Exact<{
  [key: string]: never;
}>;

export type PendingWorkspaceUploadsQuery = {
  uploadSessions: {
    nodes: Array<{
      id: string | null;
      originalName: string | null;
      byteSize: number | null;
      checksumSha256: string | null;
      state: UploadSessionState | null;
      expiresAt: string | null;
    }> | null;
    pageInfo: { hasNextPage: boolean; endCursor: string | null } | null;
  } | null;
};

export type FileExtractionRunsQueryVariables = Exact<{
  fileId: string;
}>;

export type FileExtractionRunsQuery = {
  extractionRuns: Array<{
    id: string | null;
    fileId: string | null;
    extractor: string | null;
    extractorVersion: string | null;
    state: ExtractionRunState | null;
    structuredOutput: unknown;
    errorSummary: unknown;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string | null;
  }> | null;
};

export type RequestFileExtractionMutationVariables = Exact<{
  fileId: string;
  extractor?: string | null | undefined;
  configuration?: unknown;
}>;

export type RequestFileExtractionMutation = {
  requestExtraction: {
    id: string | null;
    fileId: string | null;
    extractor: string | null;
    extractorVersion: string | null;
    state: ExtractionRunState | null;
    structuredOutput: unknown;
    errorSummary: unknown;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string | null;
  } | null;
};

export type CancelFileExtractionMutationVariables = Exact<{
  runId: string;
}>;

export type CancelFileExtractionMutation = {
  cancelExtraction: {
    id: string | null;
    fileId: string | null;
    extractor: string | null;
    extractorVersion: string | null;
    state: ExtractionRunState | null;
    structuredOutput: unknown;
    errorSummary: unknown;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string | null;
  } | null;
};

export type RetryFileExtractionMutationVariables = Exact<{
  runId: string;
}>;

export type RetryFileExtractionMutation = {
  retryExtraction: {
    id: string | null;
    fileId: string | null;
    extractor: string | null;
    extractorVersion: string | null;
    state: ExtractionRunState | null;
    structuredOutput: unknown;
    errorSummary: unknown;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string | null;
  } | null;
};

export type ImportHistoryQueryVariables = Exact<{
  first?: number | null | undefined;
  after?: string | null | undefined;
}>;

export type ImportHistoryQuery = {
  imports: {
    nodes: Array<{
      " $fragmentRefs"?: {
        ImportWorkspaceItemFragment: ImportWorkspaceItemFragment;
      };
    }> | null;
    pageInfo: { hasNextPage: boolean; endCursor: string | null } | null;
  } | null;
};

export type ImportRowDiagnosticsQueryVariables = Exact<{
  importId: string;
  first?: number | null | undefined;
  after?: string | null | undefined;
}>;

export type ImportRowDiagnosticsQuery = {
  importRows: {
    nodes: Array<{
      id: string | null;
      rowNumber: number | null;
      state: string | null;
      normalizedPayload: unknown;
      resultReferences: Array<string> | null;
      issues: Array<{ code: string | null; message: string | null }> | null;
    }> | null;
    pageInfo: { hasNextPage: boolean; endCursor: string | null } | null;
  } | null;
};

export type ImportMappingOptionsQueryVariables = Exact<{
  [key: string]: never;
}>;

export type ImportMappingOptionsQuery = {
  importMappings: {
    nodes: Array<{
      id: string | null;
      name: string | null;
      format: ImportFormat | null;
      definition: unknown;
      version: number | null;
      updatedAt: string | null;
    }> | null;
    pageInfo: { hasNextPage: boolean; endCursor: string | null } | null;
  } | null;
};

export type CreateWorkspaceUploadMutationVariables = Exact<{
  input: CreateUploadSessionInput;
}>;

export type CreateWorkspaceUploadMutation = {
  createUploadSession: {
    session: {
      id: string | null;
      state: UploadSessionState | null;
      expiresAt: string | null;
    } | null;
    grant: {
      method: FileGrantMethod | null;
      url: string | null;
      expiresAt: string | null;
      headers: unknown;
      contentLength: number | null;
    } | null;
    issues: Array<{
      code: string;
      message: string;
      path: Array<string>;
    }> | null;
  } | null;
};

export type CompleteWorkspaceUploadMutationVariables = Exact<{
  uploadSessionId: string;
}>;

export type CompleteWorkspaceUploadMutation = {
  completeUpload: {
    session: {
      id: string | null;
      state: UploadSessionState | null;
      completedAt: string | null;
    } | null;
    file: {
      " $fragmentRefs"?: {
        FileWorkspaceItemFragment: FileWorkspaceItemFragment;
      };
    } | null;
    issues: Array<{
      code: string;
      message: string;
      path: Array<string>;
    }> | null;
  } | null;
};

export type RegrantWorkspaceUploadMutationVariables = Exact<{
  id: string;
}>;

export type RegrantWorkspaceUploadMutation = {
  regrantUploadSession: {
    session: { id: string | null; state: UploadSessionState | null } | null;
    grant: {
      method: FileGrantMethod | null;
      url: string | null;
      expiresAt: string | null;
      headers: unknown;
      contentLength: number | null;
    } | null;
    issues: Array<{
      code: string;
      message: string;
      path: Array<string>;
    }> | null;
  } | null;
};

export type CancelWorkspaceUploadMutationVariables = Exact<{
  id: string;
}>;

export type CancelWorkspaceUploadMutation = {
  cancelUploadSession: {
    session: { id: string | null; state: UploadSessionState | null } | null;
    issues: Array<{
      code: string;
      message: string;
      path: Array<string>;
    }> | null;
  } | null;
};

export type ArchiveWorkspaceFileMutationVariables = Exact<{
  id: string;
  expectedVersion: number;
}>;

export type ArchiveWorkspaceFileMutation = {
  archiveFile: {
    file: {
      id: string | null;
      version: number | null;
      archivedAt: string | null;
    } | null;
    issues: Array<{
      code: string;
      message: string;
      path: Array<string>;
    }> | null;
  } | null;
};

export type CreateWorkspaceFileDownloadMutationVariables = Exact<{
  fileId: string;
}>;

export type CreateWorkspaceFileDownloadMutation = {
  createFileDownload: {
    file: { id: string | null; originalName: string | null } | null;
    grant: {
      method: FileGrantMethod | null;
      url: string | null;
      expiresAt: string | null;
      headers: unknown;
    } | null;
    issues: Array<{
      code: string;
      message: string;
      path: Array<string>;
    }> | null;
  } | null;
};

export type SaveWorkspaceImportMappingMutationVariables = Exact<{
  input: SaveImportMappingInput;
}>;

export type SaveWorkspaceImportMappingMutation = {
  saveImportMapping: {
    mapping: {
      id: string | null;
      name: string | null;
      format: ImportFormat | null;
      definition: unknown;
      version: number | null;
      updatedAt: string | null;
    } | null;
    issues: Array<{
      code: string;
      message: string;
      path: Array<string>;
    }> | null;
  } | null;
};

export type PrepareWorkspaceImportMutationVariables = Exact<{
  input: PrepareImportInput;
}>;

export type PrepareWorkspaceImportMutation = {
  prepareImport: {
    import: {
      " $fragmentRefs"?: {
        ImportWorkspaceItemFragment: ImportWorkspaceItemFragment;
      };
    } | null;
    preview: Array<{
      rowNumber: number | null;
      normalizedPayload: unknown;
      state: string | null;
      issues: Array<{ code: string | null; message: string | null }> | null;
    }> | null;
    issues: Array<{
      code: string;
      message: string;
      path: Array<string>;
    }> | null;
  } | null;
};

export type StartWorkspaceImportMutationVariables = Exact<{
  importId: string;
  expectedVersion: number;
  idempotencyKey: string;
}>;

export type StartWorkspaceImportMutation = {
  startImport: {
    import: {
      " $fragmentRefs"?: {
        ImportWorkspaceItemFragment: ImportWorkspaceItemFragment;
      };
    } | null;
    job: {
      id: string | null;
      kind: string | null;
      state: string | null;
      attemptCount: number | null;
      scheduledAt: string | null;
      errorCode: string | null;
    } | null;
    issues: Array<{
      code: string;
      message: string;
      path: Array<string>;
    }> | null;
  } | null;
};

export type RetryWorkspaceImportMutationVariables = Exact<{
  importId: string;
  expectedVersion: number;
  idempotencyKey: string;
}>;

export type RetryWorkspaceImportMutation = {
  retryImport: {
    import: {
      " $fragmentRefs"?: {
        ImportWorkspaceItemFragment: ImportWorkspaceItemFragment;
      };
    } | null;
    job: {
      id: string | null;
      state: string | null;
      attemptCount: number | null;
      scheduledAt: string | null;
      errorCode: string | null;
    } | null;
    issues: Array<{
      code: string;
      message: string;
      path: Array<string>;
    }> | null;
  } | null;
};

export type GraphAnalysisRunsQueryVariables = Exact<{
  first?: number | null | undefined;
  after?: string | null | undefined;
}>;

export type GraphAnalysisRunsQuery = {
  graphAnalysisRuns: {
    nodes: Array<{
      id: string | null;
      algorithm: string | null;
      graphSnapshotId: string | null;
      state: string | null;
      startedAt: string | null;
      completedAt: string | null;
      createdAt: string | null;
    }>;
    pageInfo: { endCursor: string | null; hasNextPage: boolean };
  };
};

export type GraphAnalysisResultsQueryVariables = Exact<{
  runId: string;
  first?: number | null | undefined;
  after?: string | null | undefined;
}>;

export type GraphAnalysisResultsQuery = {
  graphAnalysisResults: {
    nodes: Array<{
      id: string | null;
      analysisRunId: string | null;
      resultKind: string | null;
      subjectPersonId: string | null;
      value: number | null;
      rank: number | null;
      explanation: string | null;
      createdAt: string | null;
    }>;
    pageInfo: { endCursor: string | null; hasNextPage: boolean };
  };
};

export type RunGraphAnalysisMutationVariables = Exact<{
  input: RunGraphAnalysisInput;
}>;

export type RunGraphAnalysisMutation = {
  runGraphAnalysis: {
    run: {
      id: string | null;
      algorithm: string | null;
      graphSnapshotId: string | null;
      state: string | null;
      startedAt: string | null;
      completedAt: string | null;
      createdAt: string | null;
    } | null;
    metrics: Array<{
      personId: string | null;
      metricKey: string | null;
      value: number | null;
      rank: number | null;
      algorithmVersion: string | null;
      explanation: string | null;
    }> | null;
    graph: {
      fingerprint: string | null;
      generatedAt: string | null;
      normalizedFilter: {
        mode: GraphTraversalMode | null;
        rootPersonIds: Array<string> | null;
        depth: number | null;
        relationshipTypeIds: Array<string> | null;
        relationshipStates: Array<GraphRelationshipState> | null;
        sensitivities: Array<Sensitivity> | null;
        minimumConfidence: number | null;
        at: string | null;
        from: string | null;
        until: string | null;
        nodeLimit: number | null;
        edgeLimit: number | null;
        includeIsolates: boolean | null;
      } | null;
      limits: {
        requestedNodeLimit: number | null;
        requestedEdgeLimit: number | null;
        returnedNodeCount: number | null;
        returnedEdgeCount: number | null;
        nodesTruncated: boolean | null;
        edgesTruncated: boolean | null;
        reasons: Array<string> | null;
      } | null;
      nodes: Array<{
        id: string | null;
        displayName: string | null;
        sortName: string | null;
        status: string | null;
        sensitivity: Sensitivity | null;
        version: number | null;
      }> | null;
      edges: Array<{
        id: string | null;
        relationshipId: string | null;
        source: string | null;
        target: string | null;
        relationshipTypeId: string | null;
        forwardLabel: string | null;
        inverseLabel: string | null;
        directed: boolean | null;
        state: GraphRelationshipState | null;
        sensitivity: Sensitivity | null;
        confidence: number | null;
        strength: number | null;
        temporalSemantics: string | null;
        temporalPrecision: string | null;
        validFrom: string | null;
        validUntil: string | null;
        version: number | null;
      }> | null;
    } | null;
  } | null;
};

export type RerunGraphAnalysisMutationVariables = Exact<{
  input: RerunGraphAnalysisInput;
}>;

export type RerunGraphAnalysisMutation = {
  rerunGraphAnalysis: {
    run: {
      id: string | null;
      algorithm: string | null;
      graphSnapshotId: string | null;
      state: string | null;
      startedAt: string | null;
      completedAt: string | null;
      createdAt: string | null;
    } | null;
    metrics: Array<{
      personId: string | null;
      metricKey: string | null;
      value: number | null;
      rank: number | null;
      algorithmVersion: string | null;
      explanation: string | null;
    }> | null;
    graph: {
      fingerprint: string | null;
      generatedAt: string | null;
      normalizedFilter: {
        mode: GraphTraversalMode | null;
        rootPersonIds: Array<string> | null;
        depth: number | null;
        relationshipTypeIds: Array<string> | null;
        relationshipStates: Array<GraphRelationshipState> | null;
        sensitivities: Array<Sensitivity> | null;
        minimumConfidence: number | null;
        at: string | null;
        from: string | null;
        until: string | null;
        nodeLimit: number | null;
        edgeLimit: number | null;
        includeIsolates: boolean | null;
      } | null;
      limits: {
        requestedNodeLimit: number | null;
        requestedEdgeLimit: number | null;
        returnedNodeCount: number | null;
        returnedEdgeCount: number | null;
        nodesTruncated: boolean | null;
        edgesTruncated: boolean | null;
        reasons: Array<string> | null;
      } | null;
      nodes: Array<{
        id: string | null;
        displayName: string | null;
        sortName: string | null;
        status: string | null;
        sensitivity: Sensitivity | null;
        version: number | null;
      }> | null;
      edges: Array<{
        id: string | null;
        relationshipId: string | null;
        source: string | null;
        target: string | null;
        relationshipTypeId: string | null;
        forwardLabel: string | null;
        inverseLabel: string | null;
        directed: boolean | null;
        state: GraphRelationshipState | null;
        sensitivity: Sensitivity | null;
        confidence: number | null;
        strength: number | null;
        temporalSemantics: string | null;
        temporalPrecision: string | null;
        validFrom: string | null;
        validUntil: string | null;
        version: number | null;
      }> | null;
    } | null;
  } | null;
};

export type CreateGraphSnapshotMutationVariables = Exact<{
  input: RunGraphAnalysisInput;
}>;

export type CreateGraphSnapshotMutation = {
  createGraphSnapshot: {
    id: string | null;
    manifestSchema: string | null;
    manifestHash: string | null;
    algorithm: string | null;
    algorithmVersion: string | null;
    algorithmConfigHash: string | null;
    generatedAt: string | null;
  } | null;
};

export type ReplayGraphSnapshotMutationVariables = Exact<{
  input: ReplayGraphSnapshotInput;
}>;

export type ReplayGraphSnapshotMutation = {
  replayGraphSnapshot: {
    valid: boolean | null;
    snapshot: {
      id: string | null;
      manifestHash: string | null;
      algorithm: string | null;
      generatedAt: string | null;
    } | null;
  } | null;
};

export type GraphAnalysisExportQueryVariables = Exact<{
  runId: string;
  format: GraphAnalysisExportFormat;
  first?: number | null | undefined;
}>;

export type GraphAnalysisExportQuery = {
  graphAnalysisExport: {
    content: string | null;
    contentType: string | null;
    filename: string | null;
    format: GraphAnalysisExportFormat | null;
    resultCount: number | null;
    truncated: boolean | null;
  } | null;
};

export type GraphPageQueryVariables = Exact<{
  filter: GraphFilterInput;
}>;

export type GraphPageQuery = {
  graph: {
    fingerprint: string | null;
    generatedAt: string | null;
    normalizedFilter: {
      mode: GraphTraversalMode | null;
      rootPersonIds: Array<string> | null;
      depth: number | null;
      relationshipTypeIds: Array<string> | null;
      relationshipStates: Array<GraphRelationshipState> | null;
      sensitivities: Array<Sensitivity> | null;
      minimumConfidence: number | null;
      at: string | null;
      from: string | null;
      until: string | null;
      nodeLimit: number | null;
      edgeLimit: number | null;
      includeIsolates: boolean | null;
    } | null;
    limits: {
      requestedNodeLimit: number | null;
      requestedEdgeLimit: number | null;
      returnedNodeCount: number | null;
      returnedEdgeCount: number | null;
      nodesTruncated: boolean | null;
      edgesTruncated: boolean | null;
      reasons: Array<string> | null;
    } | null;
    nodes: Array<{
      id: string | null;
      displayName: string | null;
      sortName: string | null;
      status: string | null;
      sensitivity: Sensitivity | null;
      version: number | null;
    }> | null;
    edges: Array<{
      id: string | null;
      relationshipId: string | null;
      source: string | null;
      target: string | null;
      relationshipTypeId: string | null;
      forwardLabel: string | null;
      inverseLabel: string | null;
      directed: boolean | null;
      state: GraphRelationshipState | null;
      sensitivity: Sensitivity | null;
      confidence: number | null;
      strength: number | null;
      temporalSemantics: string | null;
      temporalPrecision: string | null;
      validFrom: string | null;
      validUntil: string | null;
      version: number | null;
    }> | null;
  } | null;
};

export type GraphSavedViewPageQueryVariables = Exact<{
  id: string;
  positionsFirst?: number | null | undefined;
  positionsAfter?: string | null | undefined;
}>;

export type GraphSavedViewPageQuery = {
  graphView: {
    id: string | null;
    name: string | null;
    version: number | null;
    sharing: GraphViewSharing | null;
    filter: {
      mode: GraphTraversalMode | null;
      rootPersonIds: Array<string> | null;
      depth: number | null;
      relationshipTypeIds: Array<string> | null;
      relationshipStates: Array<GraphRelationshipState> | null;
      sensitivities: Array<Sensitivity> | null;
      minimumConfidence: number | null;
      at: string | null;
      from: string | null;
      until: string | null;
      nodeLimit: number | null;
      edgeLimit: number | null;
      includeIsolates: boolean | null;
    } | null;
    layout: {
      version: string | null;
      algorithm: GraphLayoutAlgorithm | null;
      settings: {
        barnesHutOptimize: boolean | null;
        gravity: number | null;
        scalingRatio: number | null;
        slowDown: number | null;
      } | null;
    } | null;
    appearance: {
      version: string | null;
      palette: GraphPalette | null;
      showLabels: boolean | null;
    } | null;
    positions: {
      nodes: Array<{ id: string | null; x: number | null; y: number | null }>;
      pageInfo: { endCursor: string | null; hasNextPage: boolean };
    };
  } | null;
};

export type CreateGraphViewMutationVariables = Exact<{
  input: CreateGraphViewInput;
}>;

export type CreateGraphViewMutation = {
  createGraphView: {
    id: string | null;
    name: string | null;
    version: number | null;
    sharing: GraphViewSharing | null;
  } | null;
};

export type UpdateGraphViewMutationVariables = Exact<{
  input: UpdateGraphViewInput;
}>;

export type UpdateGraphViewMutation = {
  updateGraphView: {
    id: string | null;
    name: string | null;
    version: number | null;
    sharing: GraphViewSharing | null;
  } | null;
};

export type ArchiveGraphViewMutationVariables = Exact<{
  input: ArchiveGraphViewInput;
}>;

export type ArchiveGraphViewMutation = {
  archiveGraphView: { id: string | null; version: number | null } | null;
};

export type GraphWorkspaceControlsQueryVariables = Exact<{
  viewsFirst?: number | null | undefined;
  viewsAfter?: string | null | undefined;
}>;

export type GraphWorkspaceControlsQuery = {
  graphViews: {
    nodes: Array<{
      id: string | null;
      name: string | null;
      sharing: GraphViewSharing | null;
      version: number | null;
      createdAt: string | null;
      updatedAt: string | null;
      filter: {
        mode: GraphTraversalMode | null;
        rootPersonIds: Array<string> | null;
        depth: number | null;
        relationshipTypeIds: Array<string> | null;
        relationshipStates: Array<GraphRelationshipState> | null;
        sensitivities: Array<Sensitivity> | null;
        minimumConfidence: number | null;
        at: string | null;
        from: string | null;
        until: string | null;
        nodeLimit: number | null;
        edgeLimit: number | null;
        includeIsolates: boolean | null;
      } | null;
      layout: {
        version: string | null;
        algorithm: GraphLayoutAlgorithm | null;
        settings: {
          barnesHutOptimize: boolean | null;
          gravity: number | null;
          scalingRatio: number | null;
          slowDown: number | null;
        } | null;
      } | null;
      appearance: {
        version: string | null;
        palette: GraphPalette | null;
        showLabels: boolean | null;
      } | null;
    }>;
    pageInfo: { endCursor: string | null; hasNextPage: boolean };
  };
};

export type ContactDetailsFragment = {
  associationId: string;
  contactPointId: string;
  kind: string;
  displayValue: string;
  label: string | null;
  verificationState: string;
  sensitivity: Sensitivity;
  usageKind: string;
  isPrimary: boolean;
  version: number;
  contactVersion: number;
} & { " $fragmentName"?: "ContactDetailsFragment" };

export type AddressDetailsFragment = {
  associationId: string;
  addressId: string;
  addressKind: string;
  line1: string | null;
  line2: string | null;
  locality: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string | null;
  unstructuredText: string | null;
  sensitivity: Sensitivity;
  isPrimary: boolean;
  version: number;
  addressVersion: number;
  place: {
    id: string;
    name: string;
    kind: string;
    locality: string | null;
    region: string | null;
    countryCode: string | null;
  } | null;
} & { " $fragmentName"?: "AddressDetailsFragment" };

export type PersonContactsQueryVariables = Exact<{
  id: string;
  first?: number | null | undefined;
  after?: string | null | undefined;
}>;

export type PersonContactsQuery = {
  person: {
    id: string;
    contacts: {
      nodes: Array<{
        " $fragmentRefs"?: { ContactDetailsFragment: ContactDetailsFragment };
      }>;
      pageInfo: {
        " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
      };
    };
  } | null;
};

export type PersonAddressesQueryVariables = Exact<{
  id: string;
  first?: number | null | undefined;
  after?: string | null | undefined;
}>;

export type PersonAddressesQuery = {
  person: {
    id: string;
    addresses: {
      nodes: Array<{
        " $fragmentRefs"?: { AddressDetailsFragment: AddressDetailsFragment };
      }>;
      pageInfo: {
        " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
      };
    };
  } | null;
};

export type ContactEditProjectionQueryVariables = Exact<{
  associationId: string;
}>;

export type ContactEditProjectionQuery = {
  contactEditProjection: {
    associationId: string;
    displayValue: string;
    label: string | null;
    usageKind: string;
    sensitivity: Sensitivity;
    isPrimary: boolean;
    version: number;
    contactVersion: number;
  };
};

export type ContactDisplayProjectionQueryVariables = Exact<{
  associationId: string;
}>;

export type ContactDisplayProjectionQuery = {
  contactDisplayProjection: {
    associationId: string;
    displayValue: string;
    label: string | null;
    usageKind: string;
  };
};

export type AddressEditProjectionQueryVariables = Exact<{
  associationId: string;
}>;

export type AddressEditProjectionQuery = {
  addressEditProjection: {
    associationId: string;
    line1: string | null;
    locality: string | null;
    region: string | null;
    postalCode: string | null;
    countryCode: string | null;
    addressKind: string;
    sensitivity: Sensitivity;
    isPrimary: boolean;
    version: number;
    addressVersion: number;
    place: { id: string } | null;
  };
};

export type AddressDisplayProjectionQueryVariables = Exact<{
  associationId: string;
}>;

export type AddressDisplayProjectionQuery = {
  addressDisplayProjection: {
    associationId: string;
    line1: string | null;
    line2: string | null;
    locality: string | null;
    region: string | null;
    postalCode: string | null;
    countryCode: string | null;
    unstructuredText: string | null;
    place: { name: string } | null;
  };
};

export type LocationMutationOutcomeFragment = {
  path: Array<string>;
  code: string;
  message: string;
} & { " $fragmentName"?: "LocationMutationOutcomeFragment" };

export type PersonLocationsQueryVariables = Exact<{
  id: string;
  first?: number | null | undefined;
  contactAfter?: string | null | undefined;
  addressAfter?: string | null | undefined;
}>;

export type PersonLocationsQuery = {
  person: {
    id: string;
    contacts: {
      nodes: Array<{
        " $fragmentRefs"?: { ContactDetailsFragment: ContactDetailsFragment };
      }>;
      pageInfo: {
        " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
      };
    };
    addresses: {
      nodes: Array<{
        " $fragmentRefs"?: { AddressDetailsFragment: AddressDetailsFragment };
      }>;
      pageInfo: {
        " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
      };
    };
  } | null;
};

export type PlaceOptionsQueryVariables = Exact<{
  first?: number | null | undefined;
  after?: string | null | undefined;
}>;

export type PlaceOptionsQuery = {
  places: {
    nodes: Array<{
      id: string;
      name: string;
      kind: string;
      locality: string | null;
      region: string | null;
      countryCode: string | null;
      sensitivity: Sensitivity;
      version: number;
    }>;
    pageInfo: {
      " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
    };
  };
};

export type CreatePhoneContactMutationVariables = Exact<{
  input: CreatePhoneContactInput;
}>;

export type CreatePhoneContactMutation = {
  createPhoneContact: {
    code: string | null;
    currentVersion: number | null;
    contact: {
      " $fragmentRefs"?: { ContactDetailsFragment: ContactDetailsFragment };
    } | null;
    issues: Array<{
      " $fragmentRefs"?: {
        LocationMutationOutcomeFragment: LocationMutationOutcomeFragment;
      };
    }>;
  };
};

export type CreatePersonContactMutationVariables = Exact<{
  input: CreatePersonContactInput;
}>;

export type CreatePersonContactMutation = {
  createPersonContact: {
    code: string | null;
    currentVersion: number | null;
    contact: {
      " $fragmentRefs"?: { ContactDetailsFragment: ContactDetailsFragment };
    } | null;
    issues: Array<{
      " $fragmentRefs"?: {
        LocationMutationOutcomeFragment: LocationMutationOutcomeFragment;
      };
    }>;
  };
};

export type UpdatePhoneContactMutationVariables = Exact<{
  input: UpdatePhoneContactInput;
}>;

export type UpdatePhoneContactMutation = {
  updatePhoneContact: {
    code: string | null;
    currentVersion: number | null;
    contact: {
      " $fragmentRefs"?: { ContactDetailsFragment: ContactDetailsFragment };
    } | null;
    issues: Array<{
      " $fragmentRefs"?: {
        LocationMutationOutcomeFragment: LocationMutationOutcomeFragment;
      };
    }>;
  };
};

export type UpdatePersonContactMutationVariables = Exact<{
  input: UpdatePhoneContactInput;
}>;

export type UpdatePersonContactMutation = {
  updatePersonContact: {
    code: string | null;
    currentVersion: number | null;
    contact: {
      " $fragmentRefs"?: { ContactDetailsFragment: ContactDetailsFragment };
    } | null;
    issues: Array<{
      " $fragmentRefs"?: {
        LocationMutationOutcomeFragment: LocationMutationOutcomeFragment;
      };
    }>;
  };
};

export type ArchivePhoneContactMutationVariables = Exact<{
  input: ArchivePhoneContactInput;
}>;

export type ArchivePhoneContactMutation = {
  archivePhoneContact: {
    code: string | null;
    currentVersion: number | null;
    contact: {
      associationId: string;
      version: number;
      contactVersion: number;
    } | null;
    issues: Array<{
      " $fragmentRefs"?: {
        LocationMutationOutcomeFragment: LocationMutationOutcomeFragment;
      };
    }>;
  };
};

export type ArchivePersonContactMutationVariables = Exact<{
  input: ArchivePhoneContactInput;
}>;

export type ArchivePersonContactMutation = {
  archivePersonContact: {
    code: string | null;
    currentVersion: number | null;
    contact: {
      associationId: string;
      version: number;
      contactVersion: number;
    } | null;
    issues: Array<{
      " $fragmentRefs"?: {
        LocationMutationOutcomeFragment: LocationMutationOutcomeFragment;
      };
    }>;
  };
};

export type CreatePlaceMutationVariables = Exact<{
  input: CreatePlaceInput;
}>;

export type CreatePlaceMutation = {
  createPlace: {
    code: string | null;
    currentVersion: number | null;
    place: {
      id: string;
      name: string;
      kind: string;
      locality: string | null;
      region: string | null;
      countryCode: string | null;
      sensitivity: Sensitivity;
      version: number;
    } | null;
    issues: Array<{
      " $fragmentRefs"?: {
        LocationMutationOutcomeFragment: LocationMutationOutcomeFragment;
      };
    }>;
  };
};

export type UpdatePlaceMutationVariables = Exact<{
  input: UpdatePlaceInput;
}>;

export type UpdatePlaceMutation = {
  updatePlace: {
    code: string | null;
    currentVersion: number | null;
    place: {
      id: string;
      name: string;
      kind: string;
      parentPlaceId: string | null;
      locality: string | null;
      region: string | null;
      countryCode: string | null;
      sensitivity: Sensitivity;
      version: number;
    } | null;
    issues: Array<{
      " $fragmentRefs"?: {
        LocationMutationOutcomeFragment: LocationMutationOutcomeFragment;
      };
    }>;
  };
};

export type ArchivePlaceMutationVariables = Exact<{
  input: ArchivePlaceInput;
}>;

export type ArchivePlaceMutation = {
  archivePlace: {
    code: string | null;
    currentVersion: number | null;
    place: { id: string; version: number } | null;
    issues: Array<{
      " $fragmentRefs"?: {
        LocationMutationOutcomeFragment: LocationMutationOutcomeFragment;
      };
    }>;
  };
};

export type CreatePersonAddressMutationVariables = Exact<{
  input: CreatePersonAddressInput;
}>;

export type CreatePersonAddressMutation = {
  createPersonAddress: {
    code: string | null;
    currentVersion: number | null;
    address: {
      " $fragmentRefs"?: { AddressDetailsFragment: AddressDetailsFragment };
    } | null;
    issues: Array<{
      " $fragmentRefs"?: {
        LocationMutationOutcomeFragment: LocationMutationOutcomeFragment;
      };
    }>;
  };
};

export type UpdatePersonAddressMutationVariables = Exact<{
  input: UpdatePersonAddressInput;
}>;

export type UpdatePersonAddressMutation = {
  updatePersonAddress: {
    code: string | null;
    currentVersion: number | null;
    address: {
      " $fragmentRefs"?: { AddressDetailsFragment: AddressDetailsFragment };
    } | null;
    issues: Array<{
      " $fragmentRefs"?: {
        LocationMutationOutcomeFragment: LocationMutationOutcomeFragment;
      };
    }>;
  };
};

export type ArchivePersonAddressMutationVariables = Exact<{
  input: ArchivePersonAddressInput;
}>;

export type ArchivePersonAddressMutation = {
  archivePersonAddress: {
    code: string | null;
    currentVersion: number | null;
    address: {
      associationId: string;
      version: number;
      addressVersion: number;
    } | null;
    issues: Array<{
      " $fragmentRefs"?: {
        LocationMutationOutcomeFragment: LocationMutationOutcomeFragment;
      };
    }>;
  };
};

export type PersonSummaryFragment = {
  id: string;
  displayName: string;
  sortName: string | null;
  preferredName: string | null;
  biography: string | null;
  status: PersonStatus;
  sensitivity: Sensitivity;
  confidence: number;
  confidenceExplanation: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
} & { " $fragmentName"?: "PersonSummaryFragment" };

export type PageDetailsFragment = {
  endCursor: string | null;
  hasNextPage: boolean;
} & { " $fragmentName"?: "PageDetailsFragment" };

export type MutationIssueFragment = {
  code: string;
  message: string;
  path: Array<string>;
} & { " $fragmentName"?: "MutationIssueFragment" };

export type FactSummaryFragment = {
  id: string | null;
  personId: string | null;
  definitionId: string | null;
  namespace: string | null;
  fieldKey: string | null;
  label: string | null;
  valueType: FactValueType | null;
  state: FactState | null;
  reviewState: FactReviewState | null;
  sensitivity: Sensitivity | null;
  confidence: number | null;
  temporalSemantics: TemporalSemantics | null;
  temporalPrecision: TemporalPrecision | null;
  validEarliestAt: string | null;
  validLatestAt: string | null;
  assertedAt: string | null;
  version: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  value: {
    text: string | null;
    decimal: string | null;
    boolean: boolean | null;
    dateStart: string | null;
    dateEnd: string | null;
    timestamp: string | null;
    json: unknown;
    referencedPersonId: string | null;
    placeId: string | null;
    fileId: string | null;
    unit: string | null;
  } | null;
} & { " $fragmentName"?: "FactSummaryFragment" };

export type ResearchViewerQueryVariables = Exact<{ [key: string]: never }>;

export type ResearchViewerQuery = {
  viewer: {
    id: string;
    principalId: string;
    actorType: string;
    role: string | null;
    permissions: Array<string>;
    workspace: { id: string; organizationId: string; name: string };
  };
};

export type DashboardPeopleQueryVariables = Exact<{
  first?: number | null | undefined;
}>;

export type DashboardPeopleQuery = {
  people: {
    nodes: Array<{
      " $fragmentRefs"?: { PersonSummaryFragment: PersonSummaryFragment };
    }>;
    pageInfo: {
      " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
    };
  };
};

export type PeopleListQueryVariables = Exact<{
  first?: number | null | undefined;
  after?: string | null | undefined;
  filter?: PersonFilterInput | null | undefined;
}>;

export type PeopleListQuery = {
  people: {
    nodes: Array<{
      " $fragmentRefs"?: { PersonSummaryFragment: PersonSummaryFragment };
    }>;
    pageInfo: {
      " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
    };
  };
};

export type PersonHeaderQueryVariables = Exact<{
  id: string;
}>;

export type PersonHeaderQuery = {
  person: {
    " $fragmentRefs"?: { PersonSummaryFragment: PersonSummaryFragment };
  } | null;
};

export type PersonNameSummaryFragment = {
  id: string;
  personId: string;
  kind: PersonNameKind;
  fullName: string;
  givenName: string | null;
  middleName: string | null;
  familyName: string | null;
  prefix: string | null;
  suffix: string | null;
  script: string | null;
  language: string | null;
  validFrom: string | null;
  validUntil: string | null;
  temporalSemantics: PersonTemporalSemantics;
  temporalPrecision: PersonTemporalPrecision;
  confidence: number;
  sensitivity: Sensitivity;
  state: PersonRecordState;
  version: number;
  createdAt: string;
  updatedAt: string;
} & { " $fragmentName"?: "PersonNameSummaryFragment" };

export type PersonEventSummaryFragment = {
  id: string;
  personId: string;
  eventKind: string;
  title: string;
  description: string | null;
  placeId: string | null;
  earliestAt: string | null;
  latestAt: string | null;
  temporalSemantics: PersonTemporalSemantics;
  temporalPrecision: PersonTemporalPrecision;
  confidence: number;
  sensitivity: Sensitivity;
  state: PersonRecordState;
  version: number;
  createdAt: string;
  updatedAt: string;
} & { " $fragmentName"?: "PersonEventSummaryFragment" };

export type PersonNamesAndEventsQueryVariables = Exact<{
  id: string;
  namesFirst?: number | null | undefined;
  namesAfter?: string | null | undefined;
  eventsFirst?: number | null | undefined;
  eventsAfter?: string | null | undefined;
}>;

export type PersonNamesAndEventsQuery = {
  person: {
    id: string;
    names: {
      nodes: Array<{
        " $fragmentRefs"?: {
          PersonNameSummaryFragment: PersonNameSummaryFragment;
        };
      }> | null;
      pageInfo: {
        " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
      };
    } | null;
    events: {
      nodes: Array<{
        " $fragmentRefs"?: {
          PersonEventSummaryFragment: PersonEventSummaryFragment;
        };
      }> | null;
      pageInfo: {
        " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
      };
    } | null;
  } | null;
};

export type PersonFactsQueryVariables = Exact<{
  id: string;
  first?: number | null | undefined;
  after?: string | null | undefined;
  contradictoryAfter?: string | null | undefined;
}>;

export type PersonFactsQuery = {
  person: {
    id: string;
    facts: {
      nodes: Array<{
        " $fragmentRefs"?: { FactSummaryFragment: FactSummaryFragment };
      }> | null;
      pageInfo: {
        " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
      } | null;
    } | null;
    contradictoryFacts: {
      nodes: Array<{
        " $fragmentRefs"?: { FactSummaryFragment: FactSummaryFragment };
      }> | null;
      pageInfo: {
        " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
      } | null;
    } | null;
  } | null;
};

export type PersonFieldSelectionsQueryVariables = Exact<{
  id: string;
  first?: number | null | undefined;
  after?: string | null | undefined;
}>;

export type PersonFieldSelectionsQuery = {
  person: {
    id: string;
    fieldSelections: {
      nodes: Array<{
        id: string | null;
        personId: string | null;
        namespace: string | null;
        fieldKey: string | null;
        factId: string | null;
        selectionReason: string | null;
        version: number | null;
        updatedAt: string | null;
        selectedBy: { kind: ActorKind | null; label: string | null } | null;
      }> | null;
      pageInfo: {
        " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
      } | null;
    } | null;
  } | null;
};

export type FactDetailQueryVariables = Exact<{
  id: string;
  revisionFirst?: number | null | undefined;
  revisionAfter?: string | null | undefined;
  evidenceFirst?: number | null | undefined;
  evidenceAfter?: string | null | undefined;
}>;

export type FactDetailQuery = {
  fact: {
    id: string | null;
    revisions: {
      nodes: Array<{
        id: string | null;
        revision: number | null;
        changeReason: string | null;
        createdAt: string | null;
        createdBy: { kind: ActorKind | null; label: string | null } | null;
      }> | null;
      pageInfo: {
        " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
      } | null;
    } | null;
    evidence: {
      nodes: Array<{
        id: string | null;
        excerpt: string | null;
        locator: string | null;
        supportStrength: number | null;
        evidenceItem: {
          id: string | null;
          checksum: string | null;
          reviewState: string | null;
          sensitivity: Sensitivity | null;
          externalLocator: string | null;
          source: {
            id: string | null;
            title: string | null;
            citation: string | null;
            canonicalUrl: string | null;
          } | null;
        } | null;
      }> | null;
      pageInfo: {
        " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
      } | null;
    } | null;
  } | null;
};

export type FactCatalogQueryVariables = Exact<{
  first?: number | null | undefined;
  after?: string | null | undefined;
}>;

export type FactCatalogQuery = {
  factDefinitions: {
    nodes: Array<{
      id: string | null;
      namespace: string | null;
      fieldKey: string | null;
      label: string | null;
      description: string | null;
      allowedValueType: FactValueType | null;
      cardinality: FactCardinality | null;
      defaultSensitivity: Sensitivity | null;
      version: number | null;
    }> | null;
    pageInfo: {
      " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
    } | null;
  } | null;
};

export type PersonRelationshipsQueryVariables = Exact<{
  id: string;
  first?: number | null | undefined;
  after?: string | null | undefined;
}>;

export type PersonRelationshipsQuery = {
  person: {
    id: string;
    relationships: {
      nodes: Array<{
        id: string | null;
        relationshipTypeId: string | null;
        sourcePersonId: string | null;
        targetPersonId: string | null;
        labelOverride: string | null;
        state: string | null;
        sensitivity: Sensitivity | null;
        confidence: number | null;
        strength: number | null;
        temporalSemantics: RelationshipTemporalSemantics | null;
        temporalPrecision: RelationshipTemporalPrecision | null;
        validFrom: string | null;
        validUntil: string | null;
        version: number | null;
        createdAt: string | null;
        updatedAt: string | null;
      }> | null;
      pageInfo: {
        " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
      } | null;
    } | null;
  } | null;
};

export type RelationshipTypeDetailQueryVariables = Exact<{
  id: string;
}>;

export type RelationshipTypeDetailQuery = {
  relationshipType: {
    id: string | null;
    key: string | null;
    forwardLabel: string | null;
    inverseLabel: string | null;
    directed: boolean | null;
  } | null;
};

export type PersonIdentityQueryVariables = Exact<{
  id: string;
}>;

export type PersonIdentityQuery = {
  person: { id: string; displayName: string } | null;
};

export type PersonEvidenceFactsQueryVariables = Exact<{
  id: string;
  first?: number | null | undefined;
  after?: string | null | undefined;
}>;

export type PersonEvidenceFactsQuery = {
  person: {
    id: string;
    facts: {
      nodes: Array<{
        id: string | null;
        label: string | null;
        value: {
          text: string | null;
          dateStart: string | null;
          dateEnd: string | null;
        } | null;
      }> | null;
      pageInfo: {
        " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
      } | null;
    } | null;
  } | null;
};

export type FactEvidenceQueryVariables = Exact<{
  id: string;
  first?: number | null | undefined;
  after?: string | null | undefined;
}>;

export type FactEvidenceQuery = {
  fact: {
    id: string | null;
    evidence: {
      nodes: Array<{
        id: string | null;
        excerpt: string | null;
        locator: string | null;
        supportStrength: number | null;
        evidenceItem: {
          id: string | null;
          checksum: string | null;
          reviewState: string | null;
          sensitivity: Sensitivity | null;
          externalLocator: string | null;
          source: {
            id: string | null;
            kind: string | null;
            title: string | null;
            author: string | null;
            publisher: string | null;
            citation: string | null;
            canonicalUrl: string | null;
            reliability: number | null;
          } | null;
        } | null;
      }> | null;
      pageInfo: {
        " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
      } | null;
    } | null;
  } | null;
};

export type PersonNotesQueryVariables = Exact<{
  id: string;
  first?: number | null | undefined;
  after?: string | null | undefined;
}>;

export type PersonNotesQuery = {
  person: {
    id: string;
    notes: {
      nodes: Array<{
        id: string | null;
        personId: string | null;
        plainText: string | null;
        sanitizedMarkdown: string | null;
        sensitivity: Sensitivity | null;
        version: number | null;
        createdAt: string | null;
        updatedAt: string | null;
        createdBy: { kind: ActorKind | null; label: string | null } | null;
      }> | null;
      pageInfo: {
        " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
      } | null;
    } | null;
  } | null;
};

export type PersonTagsQueryVariables = Exact<{
  id: string;
  first?: number | null | undefined;
  after?: string | null | undefined;
}>;

export type PersonTagsQuery = {
  person: {
    id: string;
    tags: {
      nodes: Array<{
        id: string | null;
        name: string | null;
        normalizedName: string | null;
        color: string | null;
        description: string | null;
        version: number | null;
      }> | null;
      pageInfo: {
        " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
      } | null;
    } | null;
  } | null;
};

export type PersonActivityQueryVariables = Exact<{
  id: string;
  first?: number | null | undefined;
  after?: string | null | undefined;
}>;

export type PersonActivityQuery = {
  auditEvents: {
    nodes: Array<{
      id: string | null;
      action: string | null;
      outcome: AuditOutcome | null;
      resourceKind: string | null;
      resourceId: string | null;
      requestId: string | null;
      occurredAt: string | null;
      actor: { kind: ActorKind | null; label: string | null } | null;
    }> | null;
    pageInfo: {
      " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
    } | null;
  } | null;
};

export type RelationshipTypeOptionsQueryVariables = Exact<{
  first?: number | null | undefined;
  after?: string | null | undefined;
}>;

export type RelationshipTypeOptionsQuery = {
  relationshipTypes: {
    nodes: Array<{
      id: string | null;
      key: string | null;
      forwardLabel: string | null;
      inverseLabel: string | null;
      directed: boolean | null;
    }> | null;
    pageInfo: {
      " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
    } | null;
  } | null;
};

export type PeopleOptionsQueryVariables = Exact<{
  first?: number | null | undefined;
  after?: string | null | undefined;
  filter?: PersonFilterInput | null | undefined;
}>;

export type PeopleOptionsQuery = {
  people: {
    nodes: Array<{ id: string; displayName: string }>;
    pageInfo: {
      " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
    };
  };
};

export type WorkspaceTagsQueryVariables = Exact<{
  first?: number | null | undefined;
  after?: string | null | undefined;
  filter?: TagFilterInput | null | undefined;
}>;

export type WorkspaceTagsQuery = {
  tags: {
    nodes: Array<{
      id: string | null;
      name: string | null;
      normalizedName: string | null;
      color: string | null;
      description: string | null;
      version: number | null;
    }> | null;
    pageInfo: {
      " $fragmentRefs"?: { PageDetailsFragment: PageDetailsFragment };
    } | null;
  } | null;
};

export type CreatePersonMutationVariables = Exact<{
  input: CreatePersonInput;
}>;

export type CreatePersonMutation = {
  createPerson: {
    code: string | null;
    currentVersion: number | null;
    person: {
      " $fragmentRefs"?: { PersonSummaryFragment: PersonSummaryFragment };
    } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }>;
  };
};

export type UpdatePersonMutationVariables = Exact<{
  input: UpdatePersonInput;
}>;

export type UpdatePersonMutation = {
  updatePerson: {
    code: string | null;
    currentVersion: number | null;
    person: {
      " $fragmentRefs"?: { PersonSummaryFragment: PersonSummaryFragment };
    } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }>;
  };
};

export type ArchivePersonMutationVariables = Exact<{
  input: ArchivePersonInput;
}>;

export type ArchivePersonMutation = {
  archivePerson: {
    code: string | null;
    currentVersion: number | null;
    person: { id: string; status: PersonStatus; version: number } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }>;
  };
};

export type MergePersonMutationVariables = Exact<{
  input: MergePersonInput;
}>;

export type MergePersonMutation = {
  mergePerson: {
    person: {
      id: string;
      displayName: string;
      status: PersonStatus;
      version: number;
    } | null;
    issues: Array<{ code: string; message: string; path: Array<string> }>;
  };
};

export type UnmergePersonMutationVariables = Exact<{
  input: UnmergePersonInput;
}>;

export type UnmergePersonMutation = {
  unmergePerson: {
    person: {
      id: string;
      displayName: string;
      status: PersonStatus;
      version: number;
    } | null;
    issues: Array<{ code: string; message: string; path: Array<string> }>;
  };
};

export type SelectPersonPresentationMutationVariables = Exact<{
  input: SelectPersonPresentationInput;
}>;

export type SelectPersonPresentationMutation = {
  selectPersonPresentation: {
    person: {
      id: string;
      displayName: string;
      status: PersonStatus;
      version: number;
      primaryNameId: string | null;
      primaryPhotoFileId: string | null;
      mergedIntoPersonId: string | null;
    } | null;
    issues: Array<{ code: string; message: string; path: Array<string> }>;
  };
};

export type IdentityCandidatesQueryVariables = Exact<{
  limit?: number | null | undefined;
}>;

export type IdentityCandidatesQuery = {
  identityCandidates: Array<{
    id: string | null;
    firstPersonId: string | null;
    secondPersonId: string | null;
    score: number | null;
    matchSignals: unknown;
    state: IdentityCandidateState | null;
    reviewReason: string | null;
    reviewedAt: string | null;
    version: number | null;
  }> | null;
};

export type ReviewIdentityCandidateMutationVariables = Exact<{
  input: ReviewIdentityCandidateInput;
}>;

export type ReviewIdentityCandidateMutation = {
  reviewIdentityCandidate: {
    id: string | null;
    firstPersonId: string | null;
    secondPersonId: string | null;
    score: number | null;
    state: IdentityCandidateState | null;
    reviewReason: string | null;
    reviewedAt: string | null;
    version: number | null;
  };
};

export type CreateFactDefinitionMutationVariables = Exact<{
  input: CreateFactDefinitionInput;
}>;

export type CreateFactDefinitionMutation = {
  createFactDefinition: {
    code: string | null;
    currentVersion: number | null;
    factDefinition: {
      id: string | null;
      namespace: string | null;
      fieldKey: string | null;
      label: string | null;
      allowedValueType: FactValueType | null;
      cardinality: FactCardinality | null;
      version: number | null;
    } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }> | null;
  } | null;
};

export type CreateFactMutationVariables = Exact<{
  input: CreateFactInput;
}>;

export type CreateFactMutation = {
  createFact: {
    code: string | null;
    currentVersion: number | null;
    fact: {
      " $fragmentRefs"?: { FactSummaryFragment: FactSummaryFragment };
    } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }> | null;
  } | null;
};

export type ReviseFactMutationVariables = Exact<{
  input: ReviseFactInput;
}>;

export type ReviseFactMutation = {
  reviseFact: {
    code: string | null;
    currentVersion: number | null;
    fact: {
      " $fragmentRefs"?: { FactSummaryFragment: FactSummaryFragment };
    } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }> | null;
  } | null;
};

export type SelectPersonFieldMutationVariables = Exact<{
  input: SelectPersonFieldInput;
}>;

export type SelectPersonFieldMutation = {
  selectPersonField: {
    code: string | null;
    currentVersion: number | null;
    selection: {
      id: string | null;
      personId: string | null;
      namespace: string | null;
      fieldKey: string | null;
      factId: string | null;
      selectionReason: string | null;
      version: number | null;
      updatedAt: string | null;
    } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }> | null;
  } | null;
};

export type CreateRelationshipTypeMutationVariables = Exact<{
  input: CreateRelationshipTypeInput;
}>;

export type CreateRelationshipTypeMutation = {
  createRelationshipType: {
    code: string | null;
    currentVersion: number | null;
    relationshipType: {
      id: string | null;
      key: string | null;
      namespace: string | null;
      forwardLabel: string | null;
      inverseLabel: string | null;
      directed: boolean | null;
      allowsSelf: boolean | null;
      version: number | null;
    } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }> | null;
  } | null;
};

export type CreateRelationshipMutationVariables = Exact<{
  input: CreateRelationshipInput;
}>;

export type CreateRelationshipMutation = {
  createRelationship: {
    code: string | null;
    currentVersion: number | null;
    relationship: {
      id: string | null;
      relationshipTypeId: string | null;
      sourcePersonId: string | null;
      targetPersonId: string | null;
      state: string | null;
      sensitivity: Sensitivity | null;
      confidence: number | null;
      strength: number | null;
      version: number | null;
    } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }> | null;
  } | null;
};

export type UpdateRelationshipMutationVariables = Exact<{
  input: UpdateRelationshipInput;
}>;

export type UpdateRelationshipMutation = {
  updateRelationship: {
    code: string | null;
    currentVersion: number | null;
    relationship: {
      id: string | null;
      state: string | null;
      sensitivity: Sensitivity | null;
      confidence: number | null;
      strength: number | null;
      version: number | null;
    } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }> | null;
  } | null;
};

export type ArchiveRelationshipMutationVariables = Exact<{
  input: ArchiveRelationshipInput;
}>;

export type ArchiveRelationshipMutation = {
  archiveRelationship: {
    code: string | null;
    currentVersion: number | null;
    relationship: { id: string | null; version: number | null } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }> | null;
  } | null;
};

export type CreateSourceMutationVariables = Exact<{
  input: CreateSourceInput;
}>;

export type CreateSourceMutation = {
  createSource: {
    code: string | null;
    currentVersion: number | null;
    source: {
      id: string | null;
      kind: string | null;
      title: string | null;
      canonicalUrl: string | null;
      citation: string | null;
      version: number | null;
    } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }> | null;
  } | null;
};

export type CreateEvidenceItemMutationVariables = Exact<{
  input: CreateEvidenceItemInput;
}>;

export type CreateEvidenceItemMutation = {
  createEvidenceItem: {
    code: string | null;
    currentVersion: number | null;
    evidenceItem: {
      id: string | null;
      sourceId: string | null;
      checksum: string | null;
      reviewState: string | null;
      sensitivity: Sensitivity | null;
      version: number | null;
    } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }> | null;
  } | null;
};

export type CreateEvidenceExcerptMutationVariables = Exact<{
  input: CreateEvidenceExcerptInput;
}>;

export type CreateEvidenceExcerptMutation = {
  createEvidenceExcerpt: {
    code: string | null;
    currentVersion: number | null;
    evidenceExcerpt: {
      id: string | null;
      evidenceItemId: string | null;
      locator: string | null;
      excerpt: string | null;
      checksum: string | null;
    } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }> | null;
  } | null;
};

export type LinkFactEvidenceMutationVariables = Exact<{
  input: LinkFactEvidenceInput;
}>;

export type LinkFactEvidenceMutation = {
  linkFactEvidence: {
    code: string | null;
    currentVersion: number | null;
    factEvidence: {
      id: string | null;
      factId: string | null;
      evidenceItemId: string | null;
      excerpt: string | null;
      locator: string | null;
      supportStrength: number | null;
    } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }> | null;
  } | null;
};

export type LinkRelationshipEvidenceMutationVariables = Exact<{
  input: LinkRelationshipEvidenceInput;
}>;

export type LinkRelationshipEvidenceMutation = {
  linkRelationshipEvidence: {
    code: string | null;
    currentVersion: number | null;
    relationshipEvidence: {
      id: string | null;
      relationshipId: string | null;
      evidenceItemId: string | null;
      locator: string | null;
      supportStrength: number | null;
    } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }> | null;
  } | null;
};

export type CreateNoteMutationVariables = Exact<{
  input: CreateNoteInput;
}>;

export type CreateNoteMutation = {
  createNote: {
    code: string | null;
    currentVersion: number | null;
    note: {
      id: string | null;
      personId: string | null;
      factId: string | null;
      relationshipId: string | null;
      evidenceItemId: string | null;
      plainText: string | null;
      sanitizedMarkdown: string | null;
      sensitivity: Sensitivity | null;
      version: number | null;
    } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }> | null;
  } | null;
};

export type UpdateNoteMutationVariables = Exact<{
  input: UpdateNoteInput;
}>;

export type UpdateNoteMutation = {
  updateNote: {
    code: string | null;
    currentVersion: number | null;
    note: {
      id: string | null;
      plainText: string | null;
      sanitizedMarkdown: string | null;
      sensitivity: Sensitivity | null;
      version: number | null;
    } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }> | null;
  } | null;
};

export type ArchiveNoteMutationVariables = Exact<{
  input: ArchiveNoteInput;
}>;

export type ArchiveNoteMutation = {
  archiveNote: {
    code: string | null;
    currentVersion: number | null;
    note: { id: string | null; version: number | null } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }> | null;
  } | null;
};

export type CreateTagMutationVariables = Exact<{
  input: CreateTagInput;
}>;

export type CreateTagMutation = {
  createTag: {
    code: string | null;
    currentVersion: number | null;
    tag: {
      id: string | null;
      name: string | null;
      color: string | null;
      version: number | null;
    } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }> | null;
  } | null;
};

export type TagPersonMutationVariables = Exact<{
  input: TagPersonInput;
}>;

export type TagPersonMutation = {
  tagPerson: {
    code: string | null;
    currentVersion: number | null;
    personTag: {
      id: string | null;
      personId: string | null;
      tagId: string | null;
    } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }> | null;
  } | null;
};

export type UntagPersonMutationVariables = Exact<{
  input: TagPersonInput;
}>;

export type UntagPersonMutation = {
  untagPerson: {
    code: string | null;
    currentVersion: number | null;
    personTag: {
      id: string | null;
      personId: string | null;
      tagId: string | null;
    } | null;
    issues: Array<{
      " $fragmentRefs"?: { MutationIssueFragment: MutationIssueFragment };
    }> | null;
  } | null;
};

export type SearchWorkbenchHitFragment = {
  id: string | null;
  kind: SearchResultKind | null;
  title: string | null;
  rank: number | null;
  updatedAt: string | null;
  snippet: Array<{ matched: boolean | null; text: string | null }> | null;
} & { " $fragmentName"?: "SearchWorkbenchHitFragment" };

export type SearchWorkbenchPageFragment = {
  nodes: Array<{
    " $fragmentRefs"?: {
      SearchWorkbenchHitFragment: SearchWorkbenchHitFragment;
    };
  }> | null;
  pageInfo: { endCursor: string | null; hasNextPage: boolean } | null;
} & { " $fragmentName"?: "SearchWorkbenchPageFragment" };

export type SearchWorkbenchSavedQueryFragment = {
  id: string | null;
  ownerPrincipalId: string | null;
  name: string | null;
  sharing: SavedQuerySharing | null;
  queryAst: unknown;
  version: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  archivedAt: string | null;
} & { " $fragmentName"?: "SearchWorkbenchSavedQueryFragment" };

export type SearchWorkbenchSearchQueryVariables = Exact<{
  input: SearchInput;
}>;

export type SearchWorkbenchSearchQuery = {
  search: {
    " $fragmentRefs"?: {
      SearchWorkbenchPageFragment: SearchWorkbenchPageFragment;
    };
  };
};

export type SearchWorkbenchSavedQueriesQueryVariables = Exact<{
  first?: number | null | undefined;
  after?: string | null | undefined;
}>;

export type SearchWorkbenchSavedQueriesQuery = {
  savedQueries: {
    nodes: Array<{
      " $fragmentRefs"?: {
        SearchWorkbenchSavedQueryFragment: SearchWorkbenchSavedQueryFragment;
      };
    }> | null;
    pageInfo: { endCursor: string | null; hasNextPage: boolean } | null;
  };
};

export type SearchWorkbenchSavedQueryByIdQueryVariables = Exact<{
  id: string;
}>;

export type SearchWorkbenchSavedQueryByIdQuery = {
  savedQuery: {
    " $fragmentRefs"?: {
      SearchWorkbenchSavedQueryFragment: SearchWorkbenchSavedQueryFragment;
    };
  } | null;
};

export type SearchWorkbenchCreateSavedQueryMutationVariables = Exact<{
  input: CreateSavedQueryInput;
}>;

export type SearchWorkbenchCreateSavedQueryMutation = {
  createSavedQuery: {
    " $fragmentRefs"?: {
      SearchWorkbenchSavedQueryFragment: SearchWorkbenchSavedQueryFragment;
    };
  } | null;
};

export type SearchWorkbenchUpdateSavedQueryMutationVariables = Exact<{
  input: UpdateSavedQueryInput;
}>;

export type SearchWorkbenchUpdateSavedQueryMutation = {
  updateSavedQuery: {
    " $fragmentRefs"?: {
      SearchWorkbenchSavedQueryFragment: SearchWorkbenchSavedQueryFragment;
    };
  } | null;
};

export type SearchWorkbenchArchiveSavedQueryMutationVariables = Exact<{
  id: string;
  expectedVersion: number;
}>;

export type SearchWorkbenchArchiveSavedQueryMutation = {
  archiveSavedQuery: {
    " $fragmentRefs"?: {
      SearchWorkbenchSavedQueryFragment: SearchWorkbenchSavedQueryFragment;
    };
  } | null;
};

export type SearchWorkbenchRunSavedQueryMutationVariables = Exact<{
  id: string;
}>;

export type SearchWorkbenchRunSavedQueryMutation = {
  runSavedQuery: {
    " $fragmentRefs"?: {
      SearchWorkbenchPageFragment: SearchWorkbenchPageFragment;
    };
  } | null;
};

export type SettingsAuditEventsQueryVariables = Exact<{
  first?: number | null | undefined;
  after?: string | null | undefined;
  filter?: AuditEventFilterInput | null | undefined;
}>;

export type SettingsAuditEventsQuery = {
  auditEvents: {
    nodes: Array<{
      action: string | null;
      resourceKind: string | null;
      requestId: string | null;
      outcome: AuditOutcome | null;
      occurredAt: string | null;
      actor: { kind: ActorKind | null; label: string | null } | null;
    }> | null;
    pageInfo: { endCursor: string | null; hasNextPage: boolean } | null;
  } | null;
};

export type SettingsPolicyPostureQueryVariables = Exact<{
  [key: string]: never;
}>;

export type SettingsPolicyPostureQuery = {
  settingsPolicyPosture: {
    workspace: {
      version: number;
      name: string;
      locale: string;
      timezone: string;
      defaultRetentionDays: number | null;
      aiEnabled: boolean;
      storageEnabled: boolean;
    };
    accessPolicies: Array<{
      id: string;
      version: number;
      name: string;
      state: string;
      sensitivityCeiling: string;
      resourceKinds: Array<string>;
    }>;
    resourceGrants: Array<{
      id: string;
      policyId: string;
      resourceId: string;
      resourceKind: string;
      memberId: string | null;
      role: string | null;
      state: string;
      validFrom: string | null;
      validUntil: string | null;
      version: number;
    }>;
    retentionPolicies: Array<{
      resourceKind: string;
      retentionDays: number;
      deletionBehavior: string;
    }>;
  };
};

export type SettingsOrganizationApiKeysQueryVariables = Exact<{
  offset?: number | null | undefined;
}>;

export type SettingsOrganizationApiKeysQuery = {
  settingsOrganizationApiKeys: {
    offset: number;
    limit: number;
    total: number;
    hasPrevious: boolean;
    hasMore: boolean;
    allowedScopes: Array<string>;
    nodes: Array<{
      actionId: string;
      name: string;
      fingerprint: string;
      state: string;
      scopes: Array<string>;
      createdAt: string;
      updatedAt: string;
      expiresAt: string | null;
      lastUsedAt: string | null;
    }>;
  };
};

export type CreateOrganizationApiKeyMutationVariables = Exact<{
  input: CreateOrganizationApiKeyInput;
}>;

export type CreateOrganizationApiKeyMutation = {
  createOrganizationApiKey: {
    actionId: string | null;
    code: string;
    requestId: string;
    secret: string | null;
  };
};

export type RotateOrganizationApiKeyMutationVariables = Exact<{
  input: RotateOrganizationApiKeyInput;
}>;

export type RotateOrganizationApiKeyMutation = {
  rotateOrganizationApiKey: {
    actionId: string | null;
    code: string;
    requestId: string;
    secret: string | null;
  };
};

export type RevokeOrganizationApiKeyMutationVariables = Exact<{
  input: RevokeOrganizationApiKeyInput;
}>;

export type RevokeOrganizationApiKeyMutation = {
  revokeOrganizationApiKey: {
    actionId: string | null;
    code: string;
    requestId: string;
  };
};

export type SettingsWorkspaceDirectoryQueryVariables = Exact<{
  offset?: number | null | undefined;
}>;

export type SettingsWorkspaceDirectoryQuery = {
  settingsWorkspaceDirectory: {
    actorRole: string;
    invitations: Array<{
      actionId: string;
      email: string;
      role: string;
      status: string;
      createdAt: string;
      expiresAt: string;
    }>;
    members: {
      offset: number;
      limit: number;
      total: number;
      hasPrevious: boolean;
      hasMore: boolean;
      nodes: Array<{
        actionId: string;
        displayName: string;
        email: string;
        role: string;
        joinedAt: string;
        isSelf: boolean;
      }>;
    };
  };
};

export type IssueWorkspaceInvitationMutationVariables = Exact<{
  input: IssueWorkspaceInvitationInput;
}>;

export type IssueWorkspaceInvitationMutation = {
  issueWorkspaceInvitation: {
    actionId: string | null;
    code: string;
    requestId: string;
  };
};

export type ResendWorkspaceInvitationMutationVariables = Exact<{
  input: WorkspaceInvitationActionInput;
}>;

export type ResendWorkspaceInvitationMutation = {
  resendWorkspaceInvitation: {
    actionId: string | null;
    code: string;
    requestId: string;
  };
};

export type CancelWorkspaceInvitationMutationVariables = Exact<{
  input: WorkspaceInvitationActionInput;
}>;

export type CancelWorkspaceInvitationMutation = {
  cancelWorkspaceInvitation: {
    actionId: string | null;
    code: string;
    requestId: string;
  };
};

export type UpdateWorkspaceMemberRoleMutationVariables = Exact<{
  input: UpdateWorkspaceMemberRoleInput;
}>;

export type UpdateWorkspaceMemberRoleMutation = {
  updateWorkspaceMemberRole: {
    actionId: string | null;
    code: string;
    requestId: string;
  };
};

export type RemoveWorkspaceMemberMutationVariables = Exact<{
  input: WorkspaceInvitationActionInput;
}>;

export type RemoveWorkspaceMemberMutation = {
  removeWorkspaceMember: {
    actionId: string | null;
    code: string;
    requestId: string;
  };
};

export type UpdateWorkspaceDefaultsMutationVariables = Exact<{
  input: UpdateWorkspaceDefaultsInput;
}>;

export type UpdateWorkspaceDefaultsMutation = {
  updateWorkspaceDefaults: {
    id: string | null;
    version: number | null;
    code: string | null;
    requestId: string | null;
  };
};

export type CreateAccessPolicyMutationVariables = Exact<{
  input: AccessPolicyInput;
}>;

export type CreateAccessPolicyMutation = {
  createAccessPolicy: {
    id: string | null;
    version: number | null;
    code: string | null;
    requestId: string | null;
  };
};

export type CreateResourceGrantMutationVariables = Exact<{
  input: CreateResourceGrantInput;
}>;

export type CreateResourceGrantMutation = {
  createResourceGrant: {
    id: string | null;
    version: number | null;
    code: string | null;
    requestId: string | null;
  };
};

export type ArchiveResourceGrantMutationVariables = Exact<{
  id: string;
  expectedVersion: number;
}>;

export type ArchiveResourceGrantMutation = {
  archiveResourceGrant: {
    id: string | null;
    version: number | null;
    code: string | null;
    requestId: string | null;
  };
};

export type ViewerQueryVariables = Exact<{ [key: string]: never }>;

export type ViewerQuery = {
  viewer: {
    id: string;
    actorType: string;
    role: string | null;
    permissions: Array<string>;
    workspace: { id: string; organizationId: string; name: string };
  };
  workspace: { id: string; organizationId: string; name: string };
};

export type WorkspaceWebhooksQueryVariables = Exact<{ [key: string]: never }>;

export type WorkspaceWebhooksQuery = {
  webhooks: {
    nodes: Array<{
      id: string | null;
      url: string | null;
      subscribedEvents: Array<string>;
      state: string | null;
      secretFingerprint: string | null;
      version: number | null;
      createdAt: string | null;
      updatedAt: string | null;
    }>;
  };
};

export type CreateWorkspaceWebhookMutationVariables = Exact<{
  input: CreateWebhookInput;
}>;

export type CreateWorkspaceWebhookMutation = {
  createWebhook: {
    id: string | null;
    code: string | null;
    requestId: string | null;
    secret: string | null;
  };
};

export type RotateWorkspaceWebhookSecretMutationVariables = Exact<{
  input: WebhookIdInput;
}>;

export type RotateWorkspaceWebhookSecretMutation = {
  rotateWebhookSecret: {
    id: string | null;
    code: string | null;
    requestId: string | null;
    secret: string | null;
  };
};

export type DisableWorkspaceWebhookMutationVariables = Exact<{
  input: WebhookIdInput;
}>;

export type DisableWorkspaceWebhookMutation = {
  disableWebhook: {
    id: string | null;
    code: string | null;
    requestId: string | null;
  };
};

export class TypedDocumentString<TResult, TVariables>
  extends String
  implements DocumentTypeDecoration<TResult, TVariables>
{
  __apiType?: NonNullable<
    DocumentTypeDecoration<TResult, TVariables>["__apiType"]
  >;
  private value: string;
  public __meta__?: Record<string, any> | undefined;

  constructor(value: string, __meta__?: Record<string, any> | undefined) {
    super(value);
    this.value = value;
    this.__meta__ = __meta__;
  }

  override toString(): string & DocumentTypeDecoration<TResult, TVariables> {
    return this.value;
  }
}
export const AnalystPublicRunFragmentDoc = new TypedDocumentString(
  `
    fragment AnalystPublicRun on AiRun {
  id
  state
  provider
  model
  answer
  errorCode
  createdAt
  startedAt
  completedAt
  citations {
    claimText
    locator
    resourceId
    resourceKind
  }
  toolCalls {
    name
    state
    inputSummary {
      evidenceCount
      filterCount
      personCount
      resourceCount
      resultCount
      truncated
    }
    resultSummary {
      evidenceCount
      filterCount
      personCount
      resourceCount
      resultCount
      truncated
    }
    startedAt
    completedAt
  }
}
    `,
  { fragmentName: "AnalystPublicRun" },
) as unknown as TypedDocumentString<AnalystPublicRunFragment, unknown>;
export const FileWorkspaceItemFragmentDoc = new TypedDocumentString(
  `
    fragment FileWorkspaceItem on File {
  id
  originalName
  mediaType
  detectedType
  byteSize
  availability
  scanState
  extractionState
  sensitivity
  version
  createdAt
  updatedAt
  variants {
    id
    kind
    mediaType
    byteSize
    checksum
    generatorVersion
    createdAt
  }
}
    `,
  { fragmentName: "FileWorkspaceItem" },
) as unknown as TypedDocumentString<FileWorkspaceItemFragment, unknown>;
export const ImportWorkspaceItemFragmentDoc = new TypedDocumentString(
  `
    fragment ImportWorkspaceItem on Import {
  id
  fileId
  format
  state
  mappingId
  totalRows
  acceptedRows
  rejectedRows
  startedAt
  completedAt
  version
  createdAt
  updatedAt
}
    `,
  { fragmentName: "ImportWorkspaceItem" },
) as unknown as TypedDocumentString<ImportWorkspaceItemFragment, unknown>;
export const ContactDetailsFragmentDoc = new TypedDocumentString(
  `
    fragment ContactDetails on PersonContact {
  associationId
  contactPointId
  kind
  displayValue
  label
  verificationState
  sensitivity
  usageKind
  isPrimary
  version
  contactVersion
}
    `,
  { fragmentName: "ContactDetails" },
) as unknown as TypedDocumentString<ContactDetailsFragment, unknown>;
export const AddressDetailsFragmentDoc = new TypedDocumentString(
  `
    fragment AddressDetails on PersonAddress {
  associationId
  addressId
  addressKind
  line1
  line2
  locality
  region
  postalCode
  countryCode
  unstructuredText
  sensitivity
  isPrimary
  version
  addressVersion
  place {
    id
    name
    kind
    locality
    region
    countryCode
  }
}
    `,
  { fragmentName: "AddressDetails" },
) as unknown as TypedDocumentString<AddressDetailsFragment, unknown>;
export const LocationMutationOutcomeFragmentDoc = new TypedDocumentString(
  `
    fragment LocationMutationOutcome on ValidationIssue {
  path
  code
  message
}
    `,
  { fragmentName: "LocationMutationOutcome" },
) as unknown as TypedDocumentString<LocationMutationOutcomeFragment, unknown>;
export const PersonSummaryFragmentDoc = new TypedDocumentString(
  `
    fragment PersonSummary on Person {
  id
  displayName
  sortName
  preferredName
  biography
  status
  sensitivity
  confidence
  confidenceExplanation
  version
  createdAt
  updatedAt
}
    `,
  { fragmentName: "PersonSummary" },
) as unknown as TypedDocumentString<PersonSummaryFragment, unknown>;
export const PageDetailsFragmentDoc = new TypedDocumentString(
  `
    fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}
    `,
  { fragmentName: "PageDetails" },
) as unknown as TypedDocumentString<PageDetailsFragment, unknown>;
export const MutationIssueFragmentDoc = new TypedDocumentString(
  `
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}
    `,
  { fragmentName: "MutationIssue" },
) as unknown as TypedDocumentString<MutationIssueFragment, unknown>;
export const FactSummaryFragmentDoc = new TypedDocumentString(
  `
    fragment FactSummary on Fact {
  id
  personId
  definitionId
  namespace
  fieldKey
  label
  valueType
  value {
    text
    decimal
    boolean
    dateStart
    dateEnd
    timestamp
    json
    referencedPersonId
    placeId
    fileId
    unit
  }
  state
  reviewState
  sensitivity
  confidence
  temporalSemantics
  temporalPrecision
  validEarliestAt
  validLatestAt
  assertedAt
  version
  createdAt
  updatedAt
}
    `,
  { fragmentName: "FactSummary" },
) as unknown as TypedDocumentString<FactSummaryFragment, unknown>;
export const PersonNameSummaryFragmentDoc = new TypedDocumentString(
  `
    fragment PersonNameSummary on PersonName {
  id
  personId
  kind
  fullName
  givenName
  middleName
  familyName
  prefix
  suffix
  script
  language
  validFrom
  validUntil
  temporalSemantics
  temporalPrecision
  confidence
  sensitivity
  state
  version
  createdAt
  updatedAt
}
    `,
  { fragmentName: "PersonNameSummary" },
) as unknown as TypedDocumentString<PersonNameSummaryFragment, unknown>;
export const PersonEventSummaryFragmentDoc = new TypedDocumentString(
  `
    fragment PersonEventSummary on PersonEvent {
  id
  personId
  eventKind
  title
  description
  placeId
  earliestAt
  latestAt
  temporalSemantics
  temporalPrecision
  confidence
  sensitivity
  state
  version
  createdAt
  updatedAt
}
    `,
  { fragmentName: "PersonEventSummary" },
) as unknown as TypedDocumentString<PersonEventSummaryFragment, unknown>;
export const SearchWorkbenchHitFragmentDoc = new TypedDocumentString(
  `
    fragment SearchWorkbenchHit on SearchHit {
  id
  kind
  title
  rank
  updatedAt
  snippet {
    matched
    text
  }
}
    `,
  { fragmentName: "SearchWorkbenchHit" },
) as unknown as TypedDocumentString<SearchWorkbenchHitFragment, unknown>;
export const SearchWorkbenchPageFragmentDoc = new TypedDocumentString(
  `
    fragment SearchWorkbenchPage on SearchConnection {
  nodes {
    ...SearchWorkbenchHit
  }
  pageInfo {
    endCursor
    hasNextPage
  }
}
    fragment SearchWorkbenchHit on SearchHit {
  id
  kind
  title
  rank
  updatedAt
  snippet {
    matched
    text
  }
}`,
  { fragmentName: "SearchWorkbenchPage" },
) as unknown as TypedDocumentString<SearchWorkbenchPageFragment, unknown>;
export const SearchWorkbenchSavedQueryFragmentDoc = new TypedDocumentString(
  `
    fragment SearchWorkbenchSavedQuery on SavedQuery {
  id
  ownerPrincipalId
  name
  sharing
  queryAst
  version
  createdAt
  updatedAt
  archivedAt
}
    `,
  { fragmentName: "SearchWorkbenchSavedQuery" },
) as unknown as TypedDocumentString<SearchWorkbenchSavedQueryFragment, unknown>;
export const StartAiAnalysisDocument = new TypedDocumentString(
  `
    mutation StartAiAnalysis($input: StartAiAnalysisInput!) {
  startAiAnalysis(input: $input) {
    ...AnalystPublicRun
  }
}
    fragment AnalystPublicRun on AiRun {
  id
  state
  provider
  model
  answer
  errorCode
  createdAt
  startedAt
  completedAt
  citations {
    claimText
    locator
    resourceId
    resourceKind
  }
  toolCalls {
    name
    state
    inputSummary {
      evidenceCount
      filterCount
      personCount
      resourceCount
      resultCount
      truncated
    }
    resultSummary {
      evidenceCount
      filterCount
      personCount
      resourceCount
      resultCount
      truncated
    }
    startedAt
    completedAt
  }
}`,
  {
    hash: "sha256:542a7a19a6dad777ae7ea598bb3056cfa5057b4ad6aeadfd44bb1f5c6048a259",
  },
) as unknown as TypedDocumentString<
  StartAiAnalysisMutation,
  StartAiAnalysisMutationVariables
>;
export const AiRunDocument = new TypedDocumentString(
  `
    query AiRun($id: UUID!) {
  aiRun(id: $id) {
    ...AnalystPublicRun
  }
}
    fragment AnalystPublicRun on AiRun {
  id
  state
  provider
  model
  answer
  errorCode
  createdAt
  startedAt
  completedAt
  citations {
    claimText
    locator
    resourceId
    resourceKind
  }
  toolCalls {
    name
    state
    inputSummary {
      evidenceCount
      filterCount
      personCount
      resourceCount
      resultCount
      truncated
    }
    resultSummary {
      evidenceCount
      filterCount
      personCount
      resourceCount
      resultCount
      truncated
    }
    startedAt
    completedAt
  }
}`,
  {
    hash: "sha256:abee8a0591e6b236cf2728ed5d6010c000818a4a219d67ca513d42e14f373ebc",
  },
) as unknown as TypedDocumentString<AiRunQuery, AiRunQueryVariables>;
export const CancelAiAnalysisDocument = new TypedDocumentString(
  `
    mutation CancelAiAnalysis($id: UUID!) {
  cancelAiAnalysis(id: $id) {
    ...AnalystPublicRun
  }
}
    fragment AnalystPublicRun on AiRun {
  id
  state
  provider
  model
  answer
  errorCode
  createdAt
  startedAt
  completedAt
  citations {
    claimText
    locator
    resourceId
    resourceKind
  }
  toolCalls {
    name
    state
    inputSummary {
      evidenceCount
      filterCount
      personCount
      resourceCount
      resultCount
      truncated
    }
    resultSummary {
      evidenceCount
      filterCount
      personCount
      resourceCount
      resultCount
      truncated
    }
    startedAt
    completedAt
  }
}`,
  {
    hash: "sha256:75f14ba03e861226227ea6a46fa3198727b637da44d605dc2aa41dc9ec9d52bd",
  },
) as unknown as TypedDocumentString<
  CancelAiAnalysisMutation,
  CancelAiAnalysisMutationVariables
>;
export const DashboardOverviewDocument = new TypedDocumentString(
  `
    query DashboardOverview($includeActivity: Boolean!) {
  dashboardRecentPeople(first: 8) {
    nodes {
      ...PersonSummary
    }
  }
  imports(first: 5) {
    nodes {
      ...ImportWorkspaceItem
    }
  }
  dashboardRecentGraphAnalyses(first: 5) {
    nodes {
      id
      algorithm
      state
      startedAt
      completedAt
      createdAt
    }
  }
  dashboardRecentAiAnalyses(first: 5) {
    nodes {
      id
      provider
      model
      state
      startedAt
      completedAt
      createdAt
    }
  }
  graphStatistics {
    visiblePeople
    visibleRelationships
  }
  workspacePolicySummary {
    defaultRetentionDays
    aiEnabled
    storageEnabled
  }
  auditEvents(first: 6) @include(if: $includeActivity) {
    nodes {
      action
      resourceKind
      outcome
      occurredAt
      actor {
        kind
        label
      }
    }
  }
}
    fragment ImportWorkspaceItem on Import {
  id
  fileId
  format
  state
  mappingId
  totalRows
  acceptedRows
  rejectedRows
  startedAt
  completedAt
  version
  createdAt
  updatedAt
}
fragment PersonSummary on Person {
  id
  displayName
  sortName
  preferredName
  biography
  status
  sensitivity
  confidence
  confidenceExplanation
  version
  createdAt
  updatedAt
}`,
  {
    hash: "sha256:60037747d524e1d17ea2e5ea236ba93938e615b80e2d4bb753586cf7b8f50250",
  },
) as unknown as TypedDocumentString<
  DashboardOverviewQuery,
  DashboardOverviewQueryVariables
>;
export const EvidenceFilesDocument = new TypedDocumentString(
  `
    query EvidenceFiles($first: Int, $after: String) {
  files(first: $first, after: $after) {
    nodes {
      ...FileWorkspaceItem
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
    fragment FileWorkspaceItem on File {
  id
  originalName
  mediaType
  detectedType
  byteSize
  availability
  scanState
  extractionState
  sensitivity
  version
  createdAt
  updatedAt
  variants {
    id
    kind
    mediaType
    byteSize
    checksum
    generatorVersion
    createdAt
  }
}`,
  {
    hash: "sha256:be04f838454a9149073ed603f2b9257fa4b44b39ba56678765de5474ab4f0a15",
  },
) as unknown as TypedDocumentString<
  EvidenceFilesQuery,
  EvidenceFilesQueryVariables
>;
export const PendingWorkspaceUploadsDocument = new TypedDocumentString(
  `
    query PendingWorkspaceUploads {
  uploadSessions(first: 20, states: [PENDING]) {
    nodes {
      id
      originalName
      byteSize
      checksumSha256
      state
      expiresAt
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
    `,
  {
    hash: "sha256:692feee1175f52e938d04f0b79b2c696e14fe41e9f3db3b536b656d1950f36d4",
  },
) as unknown as TypedDocumentString<
  PendingWorkspaceUploadsQuery,
  PendingWorkspaceUploadsQueryVariables
>;
export const FileExtractionRunsDocument = new TypedDocumentString(
  `
    query FileExtractionRuns($fileId: UUID!) {
  extractionRuns(fileId: $fileId) {
    id
    fileId
    extractor
    extractorVersion
    state
    structuredOutput
    errorSummary
    startedAt
    completedAt
    createdAt
  }
}
    `,
  {
    hash: "sha256:3868032ac4a028ab46d29b5e53bb4001d5bc8a9d13bfeef1881134ee4313d52d",
  },
) as unknown as TypedDocumentString<
  FileExtractionRunsQuery,
  FileExtractionRunsQueryVariables
>;
export const RequestFileExtractionDocument = new TypedDocumentString(
  `
    mutation RequestFileExtraction($fileId: UUID!, $extractor: String, $configuration: JSON) {
  requestExtraction(
    fileId: $fileId
    extractor: $extractor
    configuration: $configuration
  ) {
    id
    fileId
    extractor
    extractorVersion
    state
    structuredOutput
    errorSummary
    startedAt
    completedAt
    createdAt
  }
}
    `,
  {
    hash: "sha256:b770d0a5eaf984bb54482aaba4daa1b48dd7110fba3e726ef59d6892c7cb9e38",
  },
) as unknown as TypedDocumentString<
  RequestFileExtractionMutation,
  RequestFileExtractionMutationVariables
>;
export const CancelFileExtractionDocument = new TypedDocumentString(
  `
    mutation CancelFileExtraction($runId: UUID!) {
  cancelExtraction(runId: $runId) {
    id
    fileId
    extractor
    extractorVersion
    state
    structuredOutput
    errorSummary
    startedAt
    completedAt
    createdAt
  }
}
    `,
  {
    hash: "sha256:f96e1ac1cd8ca2e9d7f19b6628566204f2133dd8df9ef5aebf0a49ac85298934",
  },
) as unknown as TypedDocumentString<
  CancelFileExtractionMutation,
  CancelFileExtractionMutationVariables
>;
export const RetryFileExtractionDocument = new TypedDocumentString(
  `
    mutation RetryFileExtraction($runId: UUID!) {
  retryExtraction(runId: $runId) {
    id
    fileId
    extractor
    extractorVersion
    state
    structuredOutput
    errorSummary
    startedAt
    completedAt
    createdAt
  }
}
    `,
  {
    hash: "sha256:0c0a2c97bac7ea6fec3d2dcf63685eca7e244692abf0f1ef38c921b67c1bb14e",
  },
) as unknown as TypedDocumentString<
  RetryFileExtractionMutation,
  RetryFileExtractionMutationVariables
>;
export const ImportHistoryDocument = new TypedDocumentString(
  `
    query ImportHistory($first: Int, $after: String) {
  imports(first: $first, after: $after) {
    nodes {
      ...ImportWorkspaceItem
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
    fragment ImportWorkspaceItem on Import {
  id
  fileId
  format
  state
  mappingId
  totalRows
  acceptedRows
  rejectedRows
  startedAt
  completedAt
  version
  createdAt
  updatedAt
}`,
  {
    hash: "sha256:dd09738e9e88cc6879f1bf3f548281b9578a5a44d9abcf4702d7969943ac050e",
  },
) as unknown as TypedDocumentString<
  ImportHistoryQuery,
  ImportHistoryQueryVariables
>;
export const ImportRowDiagnosticsDocument = new TypedDocumentString(
  `
    query ImportRowDiagnostics($importId: UUID!, $first: Int, $after: String) {
  importRows(importId: $importId, first: $first, after: $after) {
    nodes {
      id
      rowNumber
      state
      normalizedPayload
      issues {
        code
        message
      }
      resultReferences
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
    `,
  {
    hash: "sha256:381f0666f3687e0344e035491596bde281fd7457797268a0afdd24bebf231a91",
  },
) as unknown as TypedDocumentString<
  ImportRowDiagnosticsQuery,
  ImportRowDiagnosticsQueryVariables
>;
export const ImportMappingOptionsDocument = new TypedDocumentString(
  `
    query ImportMappingOptions {
  importMappings(first: 20) {
    nodes {
      id
      name
      format
      definition
      version
      updatedAt
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
    `,
  {
    hash: "sha256:12fd93f79228742d5857255714bfb313b6d57ad99190a35b21ae94e7cf5b92b7",
  },
) as unknown as TypedDocumentString<
  ImportMappingOptionsQuery,
  ImportMappingOptionsQueryVariables
>;
export const CreateWorkspaceUploadDocument = new TypedDocumentString(
  `
    mutation CreateWorkspaceUpload($input: CreateUploadSessionInput!) {
  createUploadSession(input: $input) {
    session {
      id
      state
      expiresAt
    }
    grant {
      method
      url
      expiresAt
      headers
      contentLength
    }
    issues {
      code
      message
      path
    }
  }
}
    `,
  {
    hash: "sha256:0fa6586934a30f41b530c95a95028da1d293f9d2f4b07299c06686b46c3542ae",
  },
) as unknown as TypedDocumentString<
  CreateWorkspaceUploadMutation,
  CreateWorkspaceUploadMutationVariables
>;
export const CompleteWorkspaceUploadDocument = new TypedDocumentString(
  `
    mutation CompleteWorkspaceUpload($uploadSessionId: UUID!) {
  completeUpload(uploadSessionId: $uploadSessionId) {
    session {
      id
      state
      completedAt
    }
    file {
      ...FileWorkspaceItem
    }
    issues {
      code
      message
      path
    }
  }
}
    fragment FileWorkspaceItem on File {
  id
  originalName
  mediaType
  detectedType
  byteSize
  availability
  scanState
  extractionState
  sensitivity
  version
  createdAt
  updatedAt
  variants {
    id
    kind
    mediaType
    byteSize
    checksum
    generatorVersion
    createdAt
  }
}`,
  {
    hash: "sha256:f480645b6a871dd3fa23880d1b151502ee44421111b0bc14b03e25bf3215aa98",
  },
) as unknown as TypedDocumentString<
  CompleteWorkspaceUploadMutation,
  CompleteWorkspaceUploadMutationVariables
>;
export const RegrantWorkspaceUploadDocument = new TypedDocumentString(
  `
    mutation RegrantWorkspaceUpload($id: UUID!) {
  regrantUploadSession(uploadSessionId: $id) {
    session {
      id
      state
    }
    grant {
      method
      url
      expiresAt
      headers
      contentLength
    }
    issues {
      code
      message
      path
    }
  }
}
    `,
  {
    hash: "sha256:e487d3a419d1bfdc637ebcc6264cecb39a6722283f430195c02def29f7156630",
  },
) as unknown as TypedDocumentString<
  RegrantWorkspaceUploadMutation,
  RegrantWorkspaceUploadMutationVariables
>;
export const CancelWorkspaceUploadDocument = new TypedDocumentString(
  `
    mutation CancelWorkspaceUpload($id: UUID!) {
  cancelUploadSession(uploadSessionId: $id) {
    session {
      id
      state
    }
    issues {
      code
      message
      path
    }
  }
}
    `,
  {
    hash: "sha256:6ebc2be31595ab976bcfe77cad295be8fe6beb6e04e11ca132157bb1cae67fec",
  },
) as unknown as TypedDocumentString<
  CancelWorkspaceUploadMutation,
  CancelWorkspaceUploadMutationVariables
>;
export const ArchiveWorkspaceFileDocument = new TypedDocumentString(
  `
    mutation ArchiveWorkspaceFile($id: UUID!, $expectedVersion: Int!) {
  archiveFile(fileId: $id, expectedVersion: $expectedVersion) {
    file {
      id
      version
      archivedAt
    }
    issues {
      code
      message
      path
    }
  }
}
    `,
  {
    hash: "sha256:0b7424d3ccd0dc98c800e0ead4cfcde5b25f5857abad0f08b050135026af29a2",
  },
) as unknown as TypedDocumentString<
  ArchiveWorkspaceFileMutation,
  ArchiveWorkspaceFileMutationVariables
>;
export const CreateWorkspaceFileDownloadDocument = new TypedDocumentString(
  `
    mutation CreateWorkspaceFileDownload($fileId: UUID!) {
  createFileDownload(fileId: $fileId) {
    file {
      id
      originalName
    }
    grant {
      method
      url
      expiresAt
      headers
    }
    issues {
      code
      message
      path
    }
  }
}
    `,
  {
    hash: "sha256:13742df70e09fa89adc01278f486fd70da06d3a1d4fc8f12ab2dbdddc4ee8690",
  },
) as unknown as TypedDocumentString<
  CreateWorkspaceFileDownloadMutation,
  CreateWorkspaceFileDownloadMutationVariables
>;
export const SaveWorkspaceImportMappingDocument = new TypedDocumentString(
  `
    mutation SaveWorkspaceImportMapping($input: SaveImportMappingInput!) {
  saveImportMapping(input: $input) {
    mapping {
      id
      name
      format
      definition
      version
      updatedAt
    }
    issues {
      code
      message
      path
    }
  }
}
    `,
  {
    hash: "sha256:db1326e84b32288907287712a36ff8cb932417dcb117a47aab7d1bb06b312dfc",
  },
) as unknown as TypedDocumentString<
  SaveWorkspaceImportMappingMutation,
  SaveWorkspaceImportMappingMutationVariables
>;
export const PrepareWorkspaceImportDocument = new TypedDocumentString(
  `
    mutation PrepareWorkspaceImport($input: PrepareImportInput!) {
  prepareImport(input: $input) {
    import {
      ...ImportWorkspaceItem
    }
    preview {
      rowNumber
      normalizedPayload
      state
      issues {
        code
        message
      }
    }
    issues {
      code
      message
      path
    }
  }
}
    fragment ImportWorkspaceItem on Import {
  id
  fileId
  format
  state
  mappingId
  totalRows
  acceptedRows
  rejectedRows
  startedAt
  completedAt
  version
  createdAt
  updatedAt
}`,
  {
    hash: "sha256:4fc124b04faf5d5ed5e0725b148f8dd3c7a26112cb688ded621944a34c2e073b",
  },
) as unknown as TypedDocumentString<
  PrepareWorkspaceImportMutation,
  PrepareWorkspaceImportMutationVariables
>;
export const StartWorkspaceImportDocument = new TypedDocumentString(
  `
    mutation StartWorkspaceImport($importId: UUID!, $expectedVersion: Int!, $idempotencyKey: String!) {
  startImport(
    importId: $importId
    expectedVersion: $expectedVersion
    idempotencyKey: $idempotencyKey
  ) {
    import {
      ...ImportWorkspaceItem
    }
    job {
      id
      kind
      state
      attemptCount
      scheduledAt
      errorCode
    }
    issues {
      code
      message
      path
    }
  }
}
    fragment ImportWorkspaceItem on Import {
  id
  fileId
  format
  state
  mappingId
  totalRows
  acceptedRows
  rejectedRows
  startedAt
  completedAt
  version
  createdAt
  updatedAt
}`,
  {
    hash: "sha256:ea1363c58cdc939be1f107624ec7d05ea2a141a7f6bbe48241b60ac81fe21105",
  },
) as unknown as TypedDocumentString<
  StartWorkspaceImportMutation,
  StartWorkspaceImportMutationVariables
>;
export const RetryWorkspaceImportDocument = new TypedDocumentString(
  `
    mutation RetryWorkspaceImport($importId: UUID!, $expectedVersion: Int!, $idempotencyKey: String!) {
  retryImport(
    importId: $importId
    expectedVersion: $expectedVersion
    idempotencyKey: $idempotencyKey
  ) {
    import {
      ...ImportWorkspaceItem
    }
    job {
      id
      state
      attemptCount
      scheduledAt
      errorCode
    }
    issues {
      code
      message
      path
    }
  }
}
    fragment ImportWorkspaceItem on Import {
  id
  fileId
  format
  state
  mappingId
  totalRows
  acceptedRows
  rejectedRows
  startedAt
  completedAt
  version
  createdAt
  updatedAt
}`,
  {
    hash: "sha256:61593e75cab1c79762eb79965b6b7279d93df71db9c0db3fa0a30223d789a83e",
  },
) as unknown as TypedDocumentString<
  RetryWorkspaceImportMutation,
  RetryWorkspaceImportMutationVariables
>;
export const GraphAnalysisRunsDocument = new TypedDocumentString(
  `
    query GraphAnalysisRuns($first: Int = 10, $after: String) {
  graphAnalysisRuns(first: $first, after: $after) {
    nodes {
      id
      algorithm
      graphSnapshotId
      state
      startedAt
      completedAt
      createdAt
    }
    pageInfo {
      endCursor
      hasNextPage
    }
  }
}
    `,
  {
    hash: "sha256:4f13d02b6d28468de2880fa5159f0bfa2b8d582a8012af652bec837e8ededf5b",
  },
) as unknown as TypedDocumentString<
  GraphAnalysisRunsQuery,
  GraphAnalysisRunsQueryVariables
>;
export const GraphAnalysisResultsDocument = new TypedDocumentString(
  `
    query GraphAnalysisResults($runId: UUID!, $first: Int = 100, $after: String) {
  graphAnalysisResults(runId: $runId, first: $first, after: $after) {
    nodes {
      id
      analysisRunId
      resultKind
      subjectPersonId
      value
      rank
      explanation
      createdAt
    }
    pageInfo {
      endCursor
      hasNextPage
    }
  }
}
    `,
  {
    hash: "sha256:07791d76b007d6a8eda041b6bac6662ed7387937b1d3dd3904340fbb96665e9b",
  },
) as unknown as TypedDocumentString<
  GraphAnalysisResultsQuery,
  GraphAnalysisResultsQueryVariables
>;
export const RunGraphAnalysisDocument = new TypedDocumentString(
  `
    mutation RunGraphAnalysis($input: RunGraphAnalysisInput!) {
  runGraphAnalysis(input: $input) {
    run {
      id
      algorithm
      graphSnapshotId
      state
      startedAt
      completedAt
      createdAt
    }
    metrics {
      personId
      metricKey
      value
      rank
      algorithmVersion
      explanation
    }
    graph {
      fingerprint
      generatedAt
      normalizedFilter {
        mode
        rootPersonIds
        depth
        relationshipTypeIds
        relationshipStates
        sensitivities
        minimumConfidence
        at
        from
        until
        nodeLimit
        edgeLimit
        includeIsolates
      }
      limits {
        requestedNodeLimit
        requestedEdgeLimit
        returnedNodeCount
        returnedEdgeCount
        nodesTruncated
        edgesTruncated
        reasons
      }
      nodes {
        id
        displayName
        sortName
        status
        sensitivity
        version
      }
      edges {
        id
        relationshipId
        source
        target
        relationshipTypeId
        forwardLabel
        inverseLabel
        directed
        state
        sensitivity
        confidence
        strength
        temporalSemantics
        temporalPrecision
        validFrom
        validUntil
        version
      }
    }
  }
}
    `,
  {
    hash: "sha256:07bb6f3dbb32587c0e3c5b252daeb9560a82a89eb3388dad4864a85981b2f1c5",
  },
) as unknown as TypedDocumentString<
  RunGraphAnalysisMutation,
  RunGraphAnalysisMutationVariables
>;
export const RerunGraphAnalysisDocument = new TypedDocumentString(
  `
    mutation RerunGraphAnalysis($input: RerunGraphAnalysisInput!) {
  rerunGraphAnalysis(input: $input) {
    run {
      id
      algorithm
      graphSnapshotId
      state
      startedAt
      completedAt
      createdAt
    }
    metrics {
      personId
      metricKey
      value
      rank
      algorithmVersion
      explanation
    }
    graph {
      fingerprint
      generatedAt
      normalizedFilter {
        mode
        rootPersonIds
        depth
        relationshipTypeIds
        relationshipStates
        sensitivities
        minimumConfidence
        at
        from
        until
        nodeLimit
        edgeLimit
        includeIsolates
      }
      limits {
        requestedNodeLimit
        requestedEdgeLimit
        returnedNodeCount
        returnedEdgeCount
        nodesTruncated
        edgesTruncated
        reasons
      }
      nodes {
        id
        displayName
        sortName
        status
        sensitivity
        version
      }
      edges {
        id
        relationshipId
        source
        target
        relationshipTypeId
        forwardLabel
        inverseLabel
        directed
        state
        sensitivity
        confidence
        strength
        temporalSemantics
        temporalPrecision
        validFrom
        validUntil
        version
      }
    }
  }
}
    `,
  {
    hash: "sha256:c0b0fe9789c55292ac5a79ddc77d7016a6c70160d462033cf562a735bfdebaef",
  },
) as unknown as TypedDocumentString<
  RerunGraphAnalysisMutation,
  RerunGraphAnalysisMutationVariables
>;
export const CreateGraphSnapshotDocument = new TypedDocumentString(
  `
    mutation CreateGraphSnapshot($input: RunGraphAnalysisInput!) {
  createGraphSnapshot(input: $input) {
    id
    manifestSchema
    manifestHash
    algorithm
    algorithmVersion
    algorithmConfigHash
    generatedAt
  }
}
    `,
  {
    hash: "sha256:b07fc79970b42faefae351e56851c1c939f11e1a1320c1c093b8fbccb25786c3",
  },
) as unknown as TypedDocumentString<
  CreateGraphSnapshotMutation,
  CreateGraphSnapshotMutationVariables
>;
export const ReplayGraphSnapshotDocument = new TypedDocumentString(
  `
    mutation ReplayGraphSnapshot($input: ReplayGraphSnapshotInput!) {
  replayGraphSnapshot(input: $input) {
    valid
    snapshot {
      id
      manifestHash
      algorithm
      generatedAt
    }
  }
}
    `,
  {
    hash: "sha256:0f996ba3ecb9e549ed56ccd7358ab3ccfc67d7207753f58f370ed10c0e6b974a",
  },
) as unknown as TypedDocumentString<
  ReplayGraphSnapshotMutation,
  ReplayGraphSnapshotMutationVariables
>;
export const GraphAnalysisExportDocument = new TypedDocumentString(
  `
    query GraphAnalysisExport($runId: UUID!, $format: GraphAnalysisExportFormat!, $first: Int = 1000) {
  graphAnalysisExport(runId: $runId, format: $format, first: $first) {
    content
    contentType
    filename
    format
    resultCount
    truncated
  }
}
    `,
  {
    hash: "sha256:c38b3cb36289617a11919d2481d779931c0b2831fed7a86e638a4f28df729f4f",
  },
) as unknown as TypedDocumentString<
  GraphAnalysisExportQuery,
  GraphAnalysisExportQueryVariables
>;
export const GraphPageDocument = new TypedDocumentString(
  `
    query GraphPage($filter: GraphFilterInput!) {
  graph(filter: $filter) {
    fingerprint
    generatedAt
    normalizedFilter {
      mode
      rootPersonIds
      depth
      relationshipTypeIds
      relationshipStates
      sensitivities
      minimumConfidence
      at
      from
      until
      nodeLimit
      edgeLimit
      includeIsolates
    }
    limits {
      requestedNodeLimit
      requestedEdgeLimit
      returnedNodeCount
      returnedEdgeCount
      nodesTruncated
      edgesTruncated
      reasons
    }
    nodes {
      id
      displayName
      sortName
      status
      sensitivity
      version
    }
    edges {
      id
      relationshipId
      source
      target
      relationshipTypeId
      forwardLabel
      inverseLabel
      directed
      state
      sensitivity
      confidence
      strength
      temporalSemantics
      temporalPrecision
      validFrom
      validUntil
      version
    }
  }
}
    `,
  {
    hash: "sha256:8b365f40dc459f1ed606495a28938b3c41cca7aa7715a49833317a0f6f275eb4",
  },
) as unknown as TypedDocumentString<GraphPageQuery, GraphPageQueryVariables>;
export const GraphSavedViewPageDocument = new TypedDocumentString(
  `
    query GraphSavedViewPage($id: UUID!, $positionsFirst: Int = 250, $positionsAfter: String) {
  graphView(id: $id) {
    id
    name
    version
    sharing
    filter {
      mode
      rootPersonIds
      depth
      relationshipTypeIds
      relationshipStates
      sensitivities
      minimumConfidence
      at
      from
      until
      nodeLimit
      edgeLimit
      includeIsolates
    }
    layout {
      version
      algorithm
      settings {
        barnesHutOptimize
        gravity
        scalingRatio
        slowDown
      }
    }
    appearance {
      version
      palette
      showLabels
    }
    positions(first: $positionsFirst, after: $positionsAfter) {
      nodes {
        id
        x
        y
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
  }
}
    `,
  {
    hash: "sha256:d954d3c430cdf75ecfead355240dbb5cbf98263b6f7146a465a1ececc3aeb55c",
  },
) as unknown as TypedDocumentString<
  GraphSavedViewPageQuery,
  GraphSavedViewPageQueryVariables
>;
export const CreateGraphViewDocument = new TypedDocumentString(
  `
    mutation CreateGraphView($input: CreateGraphViewInput!) {
  createGraphView(input: $input) {
    id
    name
    version
    sharing
  }
}
    `,
  {
    hash: "sha256:559ecbb31a34a7c88ad3a67fe3e34c153f46e6d9c49e557c04e95c05aca7864d",
  },
) as unknown as TypedDocumentString<
  CreateGraphViewMutation,
  CreateGraphViewMutationVariables
>;
export const UpdateGraphViewDocument = new TypedDocumentString(
  `
    mutation UpdateGraphView($input: UpdateGraphViewInput!) {
  updateGraphView(input: $input) {
    id
    name
    version
    sharing
  }
}
    `,
  {
    hash: "sha256:28d31e10a3d49017b57a506b5fdeefe6b13e2168baab573972d9f656cbd56ab7",
  },
) as unknown as TypedDocumentString<
  UpdateGraphViewMutation,
  UpdateGraphViewMutationVariables
>;
export const ArchiveGraphViewDocument = new TypedDocumentString(
  `
    mutation ArchiveGraphView($input: ArchiveGraphViewInput!) {
  archiveGraphView(input: $input) {
    id
    version
  }
}
    `,
  {
    hash: "sha256:f28ff0211304ca2da7b785a345e7801eb4b03177d1919545e271851c9443575b",
  },
) as unknown as TypedDocumentString<
  ArchiveGraphViewMutation,
  ArchiveGraphViewMutationVariables
>;
export const GraphWorkspaceControlsDocument = new TypedDocumentString(
  `
    query GraphWorkspaceControls($viewsFirst: Int = 10, $viewsAfter: String) {
  graphViews(first: $viewsFirst, after: $viewsAfter) {
    nodes {
      id
      name
      sharing
      version
      createdAt
      updatedAt
      filter {
        mode
        rootPersonIds
        depth
        relationshipTypeIds
        relationshipStates
        sensitivities
        minimumConfidence
        at
        from
        until
        nodeLimit
        edgeLimit
        includeIsolates
      }
      layout {
        version
        algorithm
        settings {
          barnesHutOptimize
          gravity
          scalingRatio
          slowDown
        }
      }
      appearance {
        version
        palette
        showLabels
      }
    }
    pageInfo {
      endCursor
      hasNextPage
    }
  }
}
    `,
  {
    hash: "sha256:ef4ae8caebea8441def4056c226b8a27b7c59a8de64563780d36a1477122dc3a",
  },
) as unknown as TypedDocumentString<
  GraphWorkspaceControlsQuery,
  GraphWorkspaceControlsQueryVariables
>;
export const PersonContactsDocument = new TypedDocumentString(
  `
    query PersonContacts($id: UUID!, $first: Int, $after: String) {
  person(id: $id) {
    id
    contacts(first: $first, after: $after) {
      nodes {
        ...ContactDetails
      }
      pageInfo {
        ...PageDetails
      }
    }
  }
}
    fragment ContactDetails on PersonContact {
  associationId
  contactPointId
  kind
  displayValue
  label
  verificationState
  sensitivity
  usageKind
  isPrimary
  version
  contactVersion
}
fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}`,
  {
    hash: "sha256:51f0e80c50ff390009e81fe6a8d142153d8d3d05a2fbc20d279572d29256cf97",
  },
) as unknown as TypedDocumentString<
  PersonContactsQuery,
  PersonContactsQueryVariables
>;
export const PersonAddressesDocument = new TypedDocumentString(
  `
    query PersonAddresses($id: UUID!, $first: Int, $after: String) {
  person(id: $id) {
    id
    addresses(first: $first, after: $after) {
      nodes {
        ...AddressDetails
      }
      pageInfo {
        ...PageDetails
      }
    }
  }
}
    fragment AddressDetails on PersonAddress {
  associationId
  addressId
  addressKind
  line1
  line2
  locality
  region
  postalCode
  countryCode
  unstructuredText
  sensitivity
  isPrimary
  version
  addressVersion
  place {
    id
    name
    kind
    locality
    region
    countryCode
  }
}
fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}`,
  {
    hash: "sha256:e78fc603a72122da7acdcc7fcfb707364dbd86182d618e332e073793fd4ffb54",
  },
) as unknown as TypedDocumentString<
  PersonAddressesQuery,
  PersonAddressesQueryVariables
>;
export const ContactEditProjectionDocument = new TypedDocumentString(
  `
    query ContactEditProjection($associationId: UUID!) {
  contactEditProjection(associationId: $associationId) {
    associationId
    displayValue
    label
    usageKind
    sensitivity
    isPrimary
    version
    contactVersion
  }
}
    `,
  {
    hash: "sha256:29e89f0601bbfd144e30bb265176cc2a86d2ae1cbdaefb2795ae2322aac04973",
  },
) as unknown as TypedDocumentString<
  ContactEditProjectionQuery,
  ContactEditProjectionQueryVariables
>;
export const ContactDisplayProjectionDocument = new TypedDocumentString(
  `
    query ContactDisplayProjection($associationId: UUID!) {
  contactDisplayProjection(associationId: $associationId) {
    associationId
    displayValue
    label
    usageKind
  }
}
    `,
  {
    hash: "sha256:256c2d5ebed377a22ee233b928cbf6c34dc3a906c75374847097cb54a4dbaaf0",
  },
) as unknown as TypedDocumentString<
  ContactDisplayProjectionQuery,
  ContactDisplayProjectionQueryVariables
>;
export const AddressEditProjectionDocument = new TypedDocumentString(
  `
    query AddressEditProjection($associationId: UUID!) {
  addressEditProjection(associationId: $associationId) {
    associationId
    line1
    locality
    region
    postalCode
    countryCode
    addressKind
    place {
      id
    }
    sensitivity
    isPrimary
    version
    addressVersion
  }
}
    `,
  {
    hash: "sha256:fa73590212678979cd61db470025f7d389fddf75643b3201452a4e6388665f38",
  },
) as unknown as TypedDocumentString<
  AddressEditProjectionQuery,
  AddressEditProjectionQueryVariables
>;
export const AddressDisplayProjectionDocument = new TypedDocumentString(
  `
    query AddressDisplayProjection($associationId: UUID!) {
  addressDisplayProjection(associationId: $associationId) {
    associationId
    line1
    line2
    locality
    region
    postalCode
    countryCode
    unstructuredText
    place {
      name
    }
  }
}
    `,
  {
    hash: "sha256:798f0852bb72ec7127c119a8ffa6b6adeec41a365f04986987340a3ddafb45bb",
  },
) as unknown as TypedDocumentString<
  AddressDisplayProjectionQuery,
  AddressDisplayProjectionQueryVariables
>;
export const PersonLocationsDocument = new TypedDocumentString(
  `
    query PersonLocations($id: UUID!, $first: Int, $contactAfter: String, $addressAfter: String) {
  person(id: $id) {
    id
    contacts(first: $first, after: $contactAfter) {
      nodes {
        ...ContactDetails
      }
      pageInfo {
        ...PageDetails
      }
    }
    addresses(first: $first, after: $addressAfter) {
      nodes {
        ...AddressDetails
      }
      pageInfo {
        ...PageDetails
      }
    }
  }
}
    fragment ContactDetails on PersonContact {
  associationId
  contactPointId
  kind
  displayValue
  label
  verificationState
  sensitivity
  usageKind
  isPrimary
  version
  contactVersion
}
fragment AddressDetails on PersonAddress {
  associationId
  addressId
  addressKind
  line1
  line2
  locality
  region
  postalCode
  countryCode
  unstructuredText
  sensitivity
  isPrimary
  version
  addressVersion
  place {
    id
    name
    kind
    locality
    region
    countryCode
  }
}
fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}`,
  {
    hash: "sha256:9915514cd852f1d24eee66ce4ed4042b485c262ba2970e363fca71d6f81c8131",
  },
) as unknown as TypedDocumentString<
  PersonLocationsQuery,
  PersonLocationsQueryVariables
>;
export const PlaceOptionsDocument = new TypedDocumentString(
  `
    query PlaceOptions($first: Int, $after: String) {
  places(first: $first, after: $after) {
    nodes {
      id
      name
      kind
      locality
      region
      countryCode
      sensitivity
      version
    }
    pageInfo {
      ...PageDetails
    }
  }
}
    fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}`,
  {
    hash: "sha256:2c66e013e1c844c45558940c69ac591344a82bfcd4bafeae59eca89a61da57c8",
  },
) as unknown as TypedDocumentString<
  PlaceOptionsQuery,
  PlaceOptionsQueryVariables
>;
export const CreatePhoneContactDocument = new TypedDocumentString(
  `
    mutation CreatePhoneContact($input: CreatePhoneContactInput!) {
  createPhoneContact(input: $input) {
    contact {
      ...ContactDetails
    }
    issues {
      ...LocationMutationOutcome
    }
    code
    currentVersion
  }
}
    fragment ContactDetails on PersonContact {
  associationId
  contactPointId
  kind
  displayValue
  label
  verificationState
  sensitivity
  usageKind
  isPrimary
  version
  contactVersion
}
fragment LocationMutationOutcome on ValidationIssue {
  path
  code
  message
}`,
  {
    hash: "sha256:98684c58fb41a79f313b3bc811bd150417d3b44dd8b09d7d7e4ee93c14d45b8c",
  },
) as unknown as TypedDocumentString<
  CreatePhoneContactMutation,
  CreatePhoneContactMutationVariables
>;
export const CreatePersonContactDocument = new TypedDocumentString(
  `
    mutation CreatePersonContact($input: CreatePersonContactInput!) {
  createPersonContact(input: $input) {
    contact {
      ...ContactDetails
    }
    issues {
      ...LocationMutationOutcome
    }
    code
    currentVersion
  }
}
    fragment ContactDetails on PersonContact {
  associationId
  contactPointId
  kind
  displayValue
  label
  verificationState
  sensitivity
  usageKind
  isPrimary
  version
  contactVersion
}
fragment LocationMutationOutcome on ValidationIssue {
  path
  code
  message
}`,
  {
    hash: "sha256:d80f192aa3943221784584b470ee3d4ccf2aef5af670c8b6bad8e35831b30562",
  },
) as unknown as TypedDocumentString<
  CreatePersonContactMutation,
  CreatePersonContactMutationVariables
>;
export const UpdatePhoneContactDocument = new TypedDocumentString(
  `
    mutation UpdatePhoneContact($input: UpdatePhoneContactInput!) {
  updatePhoneContact(input: $input) {
    contact {
      ...ContactDetails
    }
    issues {
      ...LocationMutationOutcome
    }
    code
    currentVersion
  }
}
    fragment ContactDetails on PersonContact {
  associationId
  contactPointId
  kind
  displayValue
  label
  verificationState
  sensitivity
  usageKind
  isPrimary
  version
  contactVersion
}
fragment LocationMutationOutcome on ValidationIssue {
  path
  code
  message
}`,
  {
    hash: "sha256:d52ca4a25e1e60d019723fd80f811dd3d25170f428892ab15fe1d2b5dec0db9f",
  },
) as unknown as TypedDocumentString<
  UpdatePhoneContactMutation,
  UpdatePhoneContactMutationVariables
>;
export const UpdatePersonContactDocument = new TypedDocumentString(
  `
    mutation UpdatePersonContact($input: UpdatePhoneContactInput!) {
  updatePersonContact(input: $input) {
    contact {
      ...ContactDetails
    }
    issues {
      ...LocationMutationOutcome
    }
    code
    currentVersion
  }
}
    fragment ContactDetails on PersonContact {
  associationId
  contactPointId
  kind
  displayValue
  label
  verificationState
  sensitivity
  usageKind
  isPrimary
  version
  contactVersion
}
fragment LocationMutationOutcome on ValidationIssue {
  path
  code
  message
}`,
  {
    hash: "sha256:bfb34602b78ce546496dbc0b7574633b8406c02a133bfdb55fa35c97e3b390ac",
  },
) as unknown as TypedDocumentString<
  UpdatePersonContactMutation,
  UpdatePersonContactMutationVariables
>;
export const ArchivePhoneContactDocument = new TypedDocumentString(
  `
    mutation ArchivePhoneContact($input: ArchivePhoneContactInput!) {
  archivePhoneContact(input: $input) {
    contact {
      associationId
      version
      contactVersion
    }
    issues {
      ...LocationMutationOutcome
    }
    code
    currentVersion
  }
}
    fragment LocationMutationOutcome on ValidationIssue {
  path
  code
  message
}`,
  {
    hash: "sha256:0ebbb7f98790ed4a09482ca0665cc649eb34196b12f8a28f9f718747a6519022",
  },
) as unknown as TypedDocumentString<
  ArchivePhoneContactMutation,
  ArchivePhoneContactMutationVariables
>;
export const ArchivePersonContactDocument = new TypedDocumentString(
  `
    mutation ArchivePersonContact($input: ArchivePhoneContactInput!) {
  archivePersonContact(input: $input) {
    contact {
      associationId
      version
      contactVersion
    }
    issues {
      ...LocationMutationOutcome
    }
    code
    currentVersion
  }
}
    fragment LocationMutationOutcome on ValidationIssue {
  path
  code
  message
}`,
  {
    hash: "sha256:59c83bc2ecdc3dd92495d004779e5b1cba584d1edca0f50a609604cbddb33b0f",
  },
) as unknown as TypedDocumentString<
  ArchivePersonContactMutation,
  ArchivePersonContactMutationVariables
>;
export const CreatePlaceDocument = new TypedDocumentString(
  `
    mutation CreatePlace($input: CreatePlaceInput!) {
  createPlace(input: $input) {
    place {
      id
      name
      kind
      locality
      region
      countryCode
      sensitivity
      version
    }
    issues {
      ...LocationMutationOutcome
    }
    code
    currentVersion
  }
}
    fragment LocationMutationOutcome on ValidationIssue {
  path
  code
  message
}`,
  {
    hash: "sha256:65e46fe08987f3e817d78a6d6d0f8b0cca058d70a3608a1e915eae50aa4b3957",
  },
) as unknown as TypedDocumentString<
  CreatePlaceMutation,
  CreatePlaceMutationVariables
>;
export const UpdatePlaceDocument = new TypedDocumentString(
  `
    mutation UpdatePlace($input: UpdatePlaceInput!) {
  updatePlace(input: $input) {
    place {
      id
      name
      kind
      parentPlaceId
      locality
      region
      countryCode
      sensitivity
      version
    }
    issues {
      ...LocationMutationOutcome
    }
    code
    currentVersion
  }
}
    fragment LocationMutationOutcome on ValidationIssue {
  path
  code
  message
}`,
  {
    hash: "sha256:6f29c220d85d60dfcfc2f5879857ccd4e4d8e7988ff45e37023dad0dacf69c0f",
  },
) as unknown as TypedDocumentString<
  UpdatePlaceMutation,
  UpdatePlaceMutationVariables
>;
export const ArchivePlaceDocument = new TypedDocumentString(
  `
    mutation ArchivePlace($input: ArchivePlaceInput!) {
  archivePlace(input: $input) {
    place {
      id
      version
    }
    issues {
      ...LocationMutationOutcome
    }
    code
    currentVersion
  }
}
    fragment LocationMutationOutcome on ValidationIssue {
  path
  code
  message
}`,
  {
    hash: "sha256:e30d670955f6e5b3967c7f19a767fb1f0de15f2bd241753696319003f3afe300",
  },
) as unknown as TypedDocumentString<
  ArchivePlaceMutation,
  ArchivePlaceMutationVariables
>;
export const CreatePersonAddressDocument = new TypedDocumentString(
  `
    mutation CreatePersonAddress($input: CreatePersonAddressInput!) {
  createPersonAddress(input: $input) {
    address {
      ...AddressDetails
    }
    issues {
      ...LocationMutationOutcome
    }
    code
    currentVersion
  }
}
    fragment AddressDetails on PersonAddress {
  associationId
  addressId
  addressKind
  line1
  line2
  locality
  region
  postalCode
  countryCode
  unstructuredText
  sensitivity
  isPrimary
  version
  addressVersion
  place {
    id
    name
    kind
    locality
    region
    countryCode
  }
}
fragment LocationMutationOutcome on ValidationIssue {
  path
  code
  message
}`,
  {
    hash: "sha256:e63738f182064f7f9e62aff195300327e0d616e4ca10811127cae8295b55dc06",
  },
) as unknown as TypedDocumentString<
  CreatePersonAddressMutation,
  CreatePersonAddressMutationVariables
>;
export const UpdatePersonAddressDocument = new TypedDocumentString(
  `
    mutation UpdatePersonAddress($input: UpdatePersonAddressInput!) {
  updatePersonAddress(input: $input) {
    address {
      ...AddressDetails
    }
    issues {
      ...LocationMutationOutcome
    }
    code
    currentVersion
  }
}
    fragment AddressDetails on PersonAddress {
  associationId
  addressId
  addressKind
  line1
  line2
  locality
  region
  postalCode
  countryCode
  unstructuredText
  sensitivity
  isPrimary
  version
  addressVersion
  place {
    id
    name
    kind
    locality
    region
    countryCode
  }
}
fragment LocationMutationOutcome on ValidationIssue {
  path
  code
  message
}`,
  {
    hash: "sha256:d941c98979aa0f33252b5d0233350631243c902d6a6d09f0f6ce68e76ae670f7",
  },
) as unknown as TypedDocumentString<
  UpdatePersonAddressMutation,
  UpdatePersonAddressMutationVariables
>;
export const ArchivePersonAddressDocument = new TypedDocumentString(
  `
    mutation ArchivePersonAddress($input: ArchivePersonAddressInput!) {
  archivePersonAddress(input: $input) {
    address {
      associationId
      version
      addressVersion
    }
    issues {
      ...LocationMutationOutcome
    }
    code
    currentVersion
  }
}
    fragment LocationMutationOutcome on ValidationIssue {
  path
  code
  message
}`,
  {
    hash: "sha256:f50af721ea9e36e1fb37a0cc6bc5b4ccc918b78b79695ddb8bd9db3ef5d503fb",
  },
) as unknown as TypedDocumentString<
  ArchivePersonAddressMutation,
  ArchivePersonAddressMutationVariables
>;
export const ResearchViewerDocument = new TypedDocumentString(
  `
    query ResearchViewer {
  viewer {
    id
    principalId
    actorType
    role
    permissions
    workspace {
      id
      organizationId
      name
    }
  }
}
    `,
  {
    hash: "sha256:e3022d22daad030e879e6b110c9e1d140e796b9d8a3f332e980476a4cb4b84c1",
  },
) as unknown as TypedDocumentString<
  ResearchViewerQuery,
  ResearchViewerQueryVariables
>;
export const DashboardPeopleDocument = new TypedDocumentString(
  `
    query DashboardPeople($first: Int) {
  people(first: $first) {
    nodes {
      ...PersonSummary
    }
    pageInfo {
      ...PageDetails
    }
  }
}
    fragment PersonSummary on Person {
  id
  displayName
  sortName
  preferredName
  biography
  status
  sensitivity
  confidence
  confidenceExplanation
  version
  createdAt
  updatedAt
}
fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}`,
  {
    hash: "sha256:a60dd6cc5054ce68c691f28e993d9188d95817145bd8735731c8957eab21719c",
  },
) as unknown as TypedDocumentString<
  DashboardPeopleQuery,
  DashboardPeopleQueryVariables
>;
export const PeopleListDocument = new TypedDocumentString(
  `
    query PeopleList($first: Int, $after: String, $filter: PersonFilterInput) {
  people(first: $first, after: $after, filter: $filter) {
    nodes {
      ...PersonSummary
    }
    pageInfo {
      ...PageDetails
    }
  }
}
    fragment PersonSummary on Person {
  id
  displayName
  sortName
  preferredName
  biography
  status
  sensitivity
  confidence
  confidenceExplanation
  version
  createdAt
  updatedAt
}
fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}`,
  {
    hash: "sha256:0a3c8a9d087da8d71ec3e97fd1605932e6b6ca6136cd2c94ae81fbe3dc33c078",
  },
) as unknown as TypedDocumentString<PeopleListQuery, PeopleListQueryVariables>;
export const PersonHeaderDocument = new TypedDocumentString(
  `
    query PersonHeader($id: UUID!) {
  person(id: $id) {
    ...PersonSummary
  }
}
    fragment PersonSummary on Person {
  id
  displayName
  sortName
  preferredName
  biography
  status
  sensitivity
  confidence
  confidenceExplanation
  version
  createdAt
  updatedAt
}`,
  {
    hash: "sha256:f575ca3ff7435c53ceee719e70c13c99356775ea59ad438eb41d753da65d4429",
  },
) as unknown as TypedDocumentString<
  PersonHeaderQuery,
  PersonHeaderQueryVariables
>;
export const PersonNamesAndEventsDocument = new TypedDocumentString(
  `
    query PersonNamesAndEvents($id: UUID!, $namesFirst: Int, $namesAfter: String, $eventsFirst: Int, $eventsAfter: String) {
  person(id: $id) {
    id
    names(first: $namesFirst, after: $namesAfter) {
      nodes {
        ...PersonNameSummary
      }
      pageInfo {
        ...PageDetails
      }
    }
    events(first: $eventsFirst, after: $eventsAfter) {
      nodes {
        ...PersonEventSummary
      }
      pageInfo {
        ...PageDetails
      }
    }
  }
}
    fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}
fragment PersonNameSummary on PersonName {
  id
  personId
  kind
  fullName
  givenName
  middleName
  familyName
  prefix
  suffix
  script
  language
  validFrom
  validUntil
  temporalSemantics
  temporalPrecision
  confidence
  sensitivity
  state
  version
  createdAt
  updatedAt
}
fragment PersonEventSummary on PersonEvent {
  id
  personId
  eventKind
  title
  description
  placeId
  earliestAt
  latestAt
  temporalSemantics
  temporalPrecision
  confidence
  sensitivity
  state
  version
  createdAt
  updatedAt
}`,
  {
    hash: "sha256:2a4354e6c301e5ee964527d291c631089f5d01f4c8dd7ed2d4839401502e356e",
  },
) as unknown as TypedDocumentString<
  PersonNamesAndEventsQuery,
  PersonNamesAndEventsQueryVariables
>;
export const PersonFactsDocument = new TypedDocumentString(
  `
    query PersonFacts($id: UUID!, $first: Int, $after: String, $contradictoryAfter: String) {
  person(id: $id) {
    id
    facts(first: $first, after: $after) {
      nodes {
        ...FactSummary
      }
      pageInfo {
        ...PageDetails
      }
    }
    contradictoryFacts(first: $first, after: $contradictoryAfter) {
      nodes {
        ...FactSummary
      }
      pageInfo {
        ...PageDetails
      }
    }
  }
}
    fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}
fragment FactSummary on Fact {
  id
  personId
  definitionId
  namespace
  fieldKey
  label
  valueType
  value {
    text
    decimal
    boolean
    dateStart
    dateEnd
    timestamp
    json
    referencedPersonId
    placeId
    fileId
    unit
  }
  state
  reviewState
  sensitivity
  confidence
  temporalSemantics
  temporalPrecision
  validEarliestAt
  validLatestAt
  assertedAt
  version
  createdAt
  updatedAt
}`,
  {
    hash: "sha256:20c5cbd1da6cc97a451c170b9ec03ea646a71b947262b28607f1c9be3bcf5ce9",
  },
) as unknown as TypedDocumentString<
  PersonFactsQuery,
  PersonFactsQueryVariables
>;
export const PersonFieldSelectionsDocument = new TypedDocumentString(
  `
    query PersonFieldSelections($id: UUID!, $first: Int, $after: String) {
  person(id: $id) {
    id
    fieldSelections(first: $first, after: $after) {
      nodes {
        id
        personId
        namespace
        fieldKey
        factId
        selectionReason
        version
        selectedBy {
          kind
          label
        }
        updatedAt
      }
      pageInfo {
        ...PageDetails
      }
    }
  }
}
    fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}`,
  {
    hash: "sha256:dcd5e7027ccc5c124c04f4e31e463f2016a7d58cd6ad53b2f7a190605b82beb7",
  },
) as unknown as TypedDocumentString<
  PersonFieldSelectionsQuery,
  PersonFieldSelectionsQueryVariables
>;
export const FactDetailDocument = new TypedDocumentString(
  `
    query FactDetail($id: UUID!, $revisionFirst: Int, $revisionAfter: String, $evidenceFirst: Int, $evidenceAfter: String) {
  fact(id: $id) {
    id
    revisions(first: $revisionFirst, after: $revisionAfter) {
      nodes {
        id
        revision
        changeReason
        createdAt
        createdBy {
          kind
          label
        }
      }
      pageInfo {
        ...PageDetails
      }
    }
    evidence(first: $evidenceFirst, after: $evidenceAfter) {
      nodes {
        id
        excerpt
        locator
        supportStrength
        evidenceItem {
          id
          checksum
          reviewState
          sensitivity
          externalLocator
          source {
            id
            title
            citation
            canonicalUrl
          }
        }
      }
      pageInfo {
        ...PageDetails
      }
    }
  }
}
    fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}`,
  {
    hash: "sha256:156f8b85199291d08ea7067aee20d1c245fccc0ffea59f595250e2355b6e876e",
  },
) as unknown as TypedDocumentString<FactDetailQuery, FactDetailQueryVariables>;
export const FactCatalogDocument = new TypedDocumentString(
  `
    query FactCatalog($first: Int, $after: String) {
  factDefinitions(first: $first, after: $after, filter: {state: ACTIVE}) {
    nodes {
      id
      namespace
      fieldKey
      label
      description
      allowedValueType
      cardinality
      defaultSensitivity
      version
    }
    pageInfo {
      ...PageDetails
    }
  }
}
    fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}`,
  {
    hash: "sha256:8b9a98ab1f638d2e07c8fd7a8ffd34af45a96765f591cd489514164ec3ae53fe",
  },
) as unknown as TypedDocumentString<
  FactCatalogQuery,
  FactCatalogQueryVariables
>;
export const PersonRelationshipsDocument = new TypedDocumentString(
  `
    query PersonRelationships($id: UUID!, $first: Int, $after: String) {
  person(id: $id) {
    id
    relationships(first: $first, after: $after) {
      nodes {
        id
        relationshipTypeId
        sourcePersonId
        targetPersonId
        labelOverride
        state
        sensitivity
        confidence
        strength
        temporalSemantics
        temporalPrecision
        validFrom
        validUntil
        version
        createdAt
        updatedAt
      }
      pageInfo {
        ...PageDetails
      }
    }
  }
}
    fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}`,
  {
    hash: "sha256:089175672712353d931e38e4d4821f108bc056287dd4eb32af83a0e6cf06927d",
  },
) as unknown as TypedDocumentString<
  PersonRelationshipsQuery,
  PersonRelationshipsQueryVariables
>;
export const RelationshipTypeDetailDocument = new TypedDocumentString(
  `
    query RelationshipTypeDetail($id: UUID!) {
  relationshipType(id: $id) {
    id
    key
    forwardLabel
    inverseLabel
    directed
  }
}
    `,
  {
    hash: "sha256:4cc6a726bd5e2ffe868639a59e43191625194d1ab528aeba74ce9384b715a418",
  },
) as unknown as TypedDocumentString<
  RelationshipTypeDetailQuery,
  RelationshipTypeDetailQueryVariables
>;
export const PersonIdentityDocument = new TypedDocumentString(
  `
    query PersonIdentity($id: UUID!) {
  person(id: $id) {
    id
    displayName
  }
}
    `,
  {
    hash: "sha256:49e9b5b39551f330d0315348cae69a5980d64dca2d4e0c344fb13b0672b09114",
  },
) as unknown as TypedDocumentString<
  PersonIdentityQuery,
  PersonIdentityQueryVariables
>;
export const PersonEvidenceFactsDocument = new TypedDocumentString(
  `
    query PersonEvidenceFacts($id: UUID!, $first: Int, $after: String) {
  person(id: $id) {
    id
    facts(first: $first, after: $after) {
      nodes {
        id
        label
        value {
          text
          dateStart
          dateEnd
        }
      }
      pageInfo {
        ...PageDetails
      }
    }
  }
}
    fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}`,
  {
    hash: "sha256:0586f08fc04927dba8acad04f9e78673c1081cdb3f1f733681678724a0dc820a",
  },
) as unknown as TypedDocumentString<
  PersonEvidenceFactsQuery,
  PersonEvidenceFactsQueryVariables
>;
export const FactEvidenceDocument = new TypedDocumentString(
  `
    query FactEvidence($id: UUID!, $first: Int, $after: String) {
  fact(id: $id) {
    id
    evidence(first: $first, after: $after) {
      nodes {
        id
        excerpt
        locator
        supportStrength
        evidenceItem {
          id
          checksum
          reviewState
          sensitivity
          externalLocator
          source {
            id
            kind
            title
            author
            publisher
            citation
            canonicalUrl
            reliability
          }
        }
      }
      pageInfo {
        ...PageDetails
      }
    }
  }
}
    fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}`,
  {
    hash: "sha256:5fbae08370c169124b1a05fd55eab143c3135a59b9bd3fa9a8ebc846f3290c5e",
  },
) as unknown as TypedDocumentString<
  FactEvidenceQuery,
  FactEvidenceQueryVariables
>;
export const PersonNotesDocument = new TypedDocumentString(
  `
    query PersonNotes($id: UUID!, $first: Int, $after: String) {
  person(id: $id) {
    id
    notes(first: $first, after: $after) {
      nodes {
        id
        personId
        plainText
        sanitizedMarkdown
        sensitivity
        version
        createdAt
        updatedAt
        createdBy {
          kind
          label
        }
      }
      pageInfo {
        ...PageDetails
      }
    }
  }
}
    fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}`,
  {
    hash: "sha256:71a968d281ddbb65ee5a955769c8921c97ab6d73844c3c784da71906683f248b",
  },
) as unknown as TypedDocumentString<
  PersonNotesQuery,
  PersonNotesQueryVariables
>;
export const PersonTagsDocument = new TypedDocumentString(
  `
    query PersonTags($id: UUID!, $first: Int, $after: String) {
  person(id: $id) {
    id
    tags(first: $first, after: $after) {
      nodes {
        id
        name
        normalizedName
        color
        description
        version
      }
      pageInfo {
        ...PageDetails
      }
    }
  }
}
    fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}`,
  {
    hash: "sha256:0521497b4ee2a0e1843ffe2726c4b20caa9b8e96c38c2605cf14c80f1e21e3cd",
  },
) as unknown as TypedDocumentString<PersonTagsQuery, PersonTagsQueryVariables>;
export const PersonActivityDocument = new TypedDocumentString(
  `
    query PersonActivity($id: UUID!, $first: Int, $after: String) {
  auditEvents(first: $first, after: $after, filter: {resourceId: $id}) {
    nodes {
      id
      action
      outcome
      resourceKind
      resourceId
      requestId
      occurredAt
      actor {
        kind
        label
      }
    }
    pageInfo {
      ...PageDetails
    }
  }
}
    fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}`,
  {
    hash: "sha256:fd2dabc5741aba7c6c57e4b6dc56b3eab78ffadd9fe38bb31c2b723b247b5274",
  },
) as unknown as TypedDocumentString<
  PersonActivityQuery,
  PersonActivityQueryVariables
>;
export const RelationshipTypeOptionsDocument = new TypedDocumentString(
  `
    query RelationshipTypeOptions($first: Int, $after: String) {
  relationshipTypes(first: $first, after: $after, filter: {state: ACTIVE}) {
    nodes {
      id
      key
      forwardLabel
      inverseLabel
      directed
    }
    pageInfo {
      ...PageDetails
    }
  }
}
    fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}`,
  {
    hash: "sha256:960bbd2cbbadc7d7996d5e3fb7d7c4b6cb686ead960a98c267046fc7331f6f5b",
  },
) as unknown as TypedDocumentString<
  RelationshipTypeOptionsQuery,
  RelationshipTypeOptionsQueryVariables
>;
export const PeopleOptionsDocument = new TypedDocumentString(
  `
    query PeopleOptions($first: Int, $after: String, $filter: PersonFilterInput) {
  people(first: $first, after: $after, filter: $filter) {
    nodes {
      id
      displayName
    }
    pageInfo {
      ...PageDetails
    }
  }
}
    fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}`,
  {
    hash: "sha256:64a6a6318ca37be366d794e1c29db72268e388819b95e431afa03c072c9f2d58",
  },
) as unknown as TypedDocumentString<
  PeopleOptionsQuery,
  PeopleOptionsQueryVariables
>;
export const WorkspaceTagsDocument = new TypedDocumentString(
  `
    query WorkspaceTags($first: Int, $after: String, $filter: TagFilterInput) {
  tags(first: $first, after: $after, filter: $filter) {
    nodes {
      id
      name
      normalizedName
      color
      description
      version
    }
    pageInfo {
      ...PageDetails
    }
  }
}
    fragment PageDetails on PageInfo {
  endCursor
  hasNextPage
}`,
  {
    hash: "sha256:e3ffefb5c66a0d5003ae395dc4744107052c5bdcc7e2f76ef9ff98946fa78e97",
  },
) as unknown as TypedDocumentString<
  WorkspaceTagsQuery,
  WorkspaceTagsQueryVariables
>;
export const CreatePersonDocument = new TypedDocumentString(
  `
    mutation CreatePerson($input: CreatePersonInput!) {
  createPerson(input: $input) {
    person {
      ...PersonSummary
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment PersonSummary on Person {
  id
  displayName
  sortName
  preferredName
  biography
  status
  sensitivity
  confidence
  confidenceExplanation
  version
  createdAt
  updatedAt
}
fragment MutationIssue on ValidationIssue {
  code
  message
  path
}`,
  {
    hash: "sha256:99ffbd7bcf9d87349dd0d84ce43c02b1c4c23dd8bcbf868b73da277e8f703f88",
  },
) as unknown as TypedDocumentString<
  CreatePersonMutation,
  CreatePersonMutationVariables
>;
export const UpdatePersonDocument = new TypedDocumentString(
  `
    mutation UpdatePerson($input: UpdatePersonInput!) {
  updatePerson(input: $input) {
    person {
      ...PersonSummary
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment PersonSummary on Person {
  id
  displayName
  sortName
  preferredName
  biography
  status
  sensitivity
  confidence
  confidenceExplanation
  version
  createdAt
  updatedAt
}
fragment MutationIssue on ValidationIssue {
  code
  message
  path
}`,
  {
    hash: "sha256:bfbba4909f6f9ee836803b5607716389e2009a1cf34a4c447c1a88b437199ff1",
  },
) as unknown as TypedDocumentString<
  UpdatePersonMutation,
  UpdatePersonMutationVariables
>;
export const ArchivePersonDocument = new TypedDocumentString(
  `
    mutation ArchivePerson($input: ArchivePersonInput!) {
  archivePerson(input: $input) {
    person {
      id
      status
      version
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}`,
  {
    hash: "sha256:528b806ff4d7a05d4118f5d05faa545ffac985f4164d03eba8b14d6c56797b2d",
  },
) as unknown as TypedDocumentString<
  ArchivePersonMutation,
  ArchivePersonMutationVariables
>;
export const MergePersonDocument = new TypedDocumentString(
  `
    mutation MergePerson($input: MergePersonInput!) {
  mergePerson(input: $input) {
    person {
      id
      displayName
      status
      version
    }
    issues {
      code
      message
      path
    }
  }
}
    `,
  {
    hash: "sha256:f4cdcd0c91d3a7660e6162a15b0898007ddeed921584d5e4506de2807bdb3e44",
  },
) as unknown as TypedDocumentString<
  MergePersonMutation,
  MergePersonMutationVariables
>;
export const UnmergePersonDocument = new TypedDocumentString(
  `
    mutation UnmergePerson($input: UnmergePersonInput!) {
  unmergePerson(input: $input) {
    person {
      id
      displayName
      status
      version
    }
    issues {
      code
      message
      path
    }
  }
}
    `,
  {
    hash: "sha256:30e0d401d8a1ccd5bb4312d0844fc8a7ae0aea136c40c2c1af34a56922a030da",
  },
) as unknown as TypedDocumentString<
  UnmergePersonMutation,
  UnmergePersonMutationVariables
>;
export const SelectPersonPresentationDocument = new TypedDocumentString(
  `
    mutation SelectPersonPresentation($input: SelectPersonPresentationInput!) {
  selectPersonPresentation(input: $input) {
    person {
      id
      displayName
      status
      version
      primaryNameId
      primaryPhotoFileId
      mergedIntoPersonId
    }
    issues {
      code
      message
      path
    }
  }
}
    `,
  {
    hash: "sha256:a4ea0cbca8ccfba0df75f39b894347fc05a32a9e657a78dca914988d7f977966",
  },
) as unknown as TypedDocumentString<
  SelectPersonPresentationMutation,
  SelectPersonPresentationMutationVariables
>;
export const IdentityCandidatesDocument = new TypedDocumentString(
  `
    query IdentityCandidates($limit: Int) {
  identityCandidates(limit: $limit) {
    id
    firstPersonId
    secondPersonId
    score
    matchSignals
    state
    reviewReason
    reviewedAt
    version
  }
}
    `,
  {
    hash: "sha256:0e1ff74eca3177672fc907ab0ca75766eb5d7984631b8d90cff3f21838bbff14",
  },
) as unknown as TypedDocumentString<
  IdentityCandidatesQuery,
  IdentityCandidatesQueryVariables
>;
export const ReviewIdentityCandidateDocument = new TypedDocumentString(
  `
    mutation ReviewIdentityCandidate($input: ReviewIdentityCandidateInput!) {
  reviewIdentityCandidate(input: $input) {
    id
    firstPersonId
    secondPersonId
    score
    state
    reviewReason
    reviewedAt
    version
  }
}
    `,
  {
    hash: "sha256:2ca0b872ae40e40d5bc5eade2cb28d9f3d44a197ba2206e18f060bc1ee2de7b2",
  },
) as unknown as TypedDocumentString<
  ReviewIdentityCandidateMutation,
  ReviewIdentityCandidateMutationVariables
>;
export const CreateFactDefinitionDocument = new TypedDocumentString(
  `
    mutation CreateFactDefinition($input: CreateFactDefinitionInput!) {
  createFactDefinition(input: $input) {
    factDefinition {
      id
      namespace
      fieldKey
      label
      allowedValueType
      cardinality
      version
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}`,
  {
    hash: "sha256:c539b2642c864d229cdb391f8f684ddbb3aa81e2c0b909dc52e4f05ebd07a38c",
  },
) as unknown as TypedDocumentString<
  CreateFactDefinitionMutation,
  CreateFactDefinitionMutationVariables
>;
export const CreateFactDocument = new TypedDocumentString(
  `
    mutation CreateFact($input: CreateFactInput!) {
  createFact(input: $input) {
    fact {
      ...FactSummary
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}
fragment FactSummary on Fact {
  id
  personId
  definitionId
  namespace
  fieldKey
  label
  valueType
  value {
    text
    decimal
    boolean
    dateStart
    dateEnd
    timestamp
    json
    referencedPersonId
    placeId
    fileId
    unit
  }
  state
  reviewState
  sensitivity
  confidence
  temporalSemantics
  temporalPrecision
  validEarliestAt
  validLatestAt
  assertedAt
  version
  createdAt
  updatedAt
}`,
  {
    hash: "sha256:f19fb5aa78003e41f741b6f2b72e2ad3ca9a5bc323c98263aa52f5a79fdc0ac7",
  },
) as unknown as TypedDocumentString<
  CreateFactMutation,
  CreateFactMutationVariables
>;
export const ReviseFactDocument = new TypedDocumentString(
  `
    mutation ReviseFact($input: ReviseFactInput!) {
  reviseFact(input: $input) {
    fact {
      ...FactSummary
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}
fragment FactSummary on Fact {
  id
  personId
  definitionId
  namespace
  fieldKey
  label
  valueType
  value {
    text
    decimal
    boolean
    dateStart
    dateEnd
    timestamp
    json
    referencedPersonId
    placeId
    fileId
    unit
  }
  state
  reviewState
  sensitivity
  confidence
  temporalSemantics
  temporalPrecision
  validEarliestAt
  validLatestAt
  assertedAt
  version
  createdAt
  updatedAt
}`,
  {
    hash: "sha256:772d8fe3c0fd6624624e85f52f79eee2e2bed129c7a36595de2288a9b626a3f6",
  },
) as unknown as TypedDocumentString<
  ReviseFactMutation,
  ReviseFactMutationVariables
>;
export const SelectPersonFieldDocument = new TypedDocumentString(
  `
    mutation SelectPersonField($input: SelectPersonFieldInput!) {
  selectPersonField(input: $input) {
    selection {
      id
      personId
      namespace
      fieldKey
      factId
      selectionReason
      version
      updatedAt
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}`,
  {
    hash: "sha256:56c28a4a6475eeaac4a01aac802de5d6399b3ed7727bc584de535ecbebdf71ea",
  },
) as unknown as TypedDocumentString<
  SelectPersonFieldMutation,
  SelectPersonFieldMutationVariables
>;
export const CreateRelationshipTypeDocument = new TypedDocumentString(
  `
    mutation CreateRelationshipType($input: CreateRelationshipTypeInput!) {
  createRelationshipType(input: $input) {
    relationshipType {
      id
      key
      namespace
      forwardLabel
      inverseLabel
      directed
      allowsSelf
      version
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}`,
  {
    hash: "sha256:887a6337372fbde32cb64c3d8baefb51e28bf4c62595bbb0fc2ca4e5a7cc0bba",
  },
) as unknown as TypedDocumentString<
  CreateRelationshipTypeMutation,
  CreateRelationshipTypeMutationVariables
>;
export const CreateRelationshipDocument = new TypedDocumentString(
  `
    mutation CreateRelationship($input: CreateRelationshipInput!) {
  createRelationship(input: $input) {
    relationship {
      id
      relationshipTypeId
      sourcePersonId
      targetPersonId
      state
      sensitivity
      confidence
      strength
      version
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}`,
  {
    hash: "sha256:be9825fd2b9e2713704636ed151ebe26e7f6c7d2944bc98ea7a62d5698f75569",
  },
) as unknown as TypedDocumentString<
  CreateRelationshipMutation,
  CreateRelationshipMutationVariables
>;
export const UpdateRelationshipDocument = new TypedDocumentString(
  `
    mutation UpdateRelationship($input: UpdateRelationshipInput!) {
  updateRelationship(input: $input) {
    relationship {
      id
      state
      sensitivity
      confidence
      strength
      version
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}`,
  {
    hash: "sha256:409986ab28a70c90323534b95d2cb84df403e8c4787416f89ee312b54cc76753",
  },
) as unknown as TypedDocumentString<
  UpdateRelationshipMutation,
  UpdateRelationshipMutationVariables
>;
export const ArchiveRelationshipDocument = new TypedDocumentString(
  `
    mutation ArchiveRelationship($input: ArchiveRelationshipInput!) {
  archiveRelationship(input: $input) {
    relationship {
      id
      version
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}`,
  {
    hash: "sha256:555f93d8f480f4483b9481d663000eb81ee7c86485d97936ec9a3323cd0b3860",
  },
) as unknown as TypedDocumentString<
  ArchiveRelationshipMutation,
  ArchiveRelationshipMutationVariables
>;
export const CreateSourceDocument = new TypedDocumentString(
  `
    mutation CreateSource($input: CreateSourceInput!) {
  createSource(input: $input) {
    source {
      id
      kind
      title
      canonicalUrl
      citation
      version
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}`,
  {
    hash: "sha256:7abe362e8ecdf2d1c722c7940db9d3c12b5ad48cddc4097303a3cbea60e1f42e",
  },
) as unknown as TypedDocumentString<
  CreateSourceMutation,
  CreateSourceMutationVariables
>;
export const CreateEvidenceItemDocument = new TypedDocumentString(
  `
    mutation CreateEvidenceItem($input: CreateEvidenceItemInput!) {
  createEvidenceItem(input: $input) {
    evidenceItem {
      id
      sourceId
      checksum
      reviewState
      sensitivity
      version
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}`,
  {
    hash: "sha256:3c91ae089c77577d6e51fe3a65a011127238c353485b5ad11cba4f1f709f174a",
  },
) as unknown as TypedDocumentString<
  CreateEvidenceItemMutation,
  CreateEvidenceItemMutationVariables
>;
export const CreateEvidenceExcerptDocument = new TypedDocumentString(
  `
    mutation CreateEvidenceExcerpt($input: CreateEvidenceExcerptInput!) {
  createEvidenceExcerpt(input: $input) {
    evidenceExcerpt {
      id
      evidenceItemId
      locator
      excerpt
      checksum
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}`,
  {
    hash: "sha256:da267896dc0e543db7589f724fa3c891897b3f9116341e238aa27adbec7c14fe",
  },
) as unknown as TypedDocumentString<
  CreateEvidenceExcerptMutation,
  CreateEvidenceExcerptMutationVariables
>;
export const LinkFactEvidenceDocument = new TypedDocumentString(
  `
    mutation LinkFactEvidence($input: LinkFactEvidenceInput!) {
  linkFactEvidence(input: $input) {
    factEvidence {
      id
      factId
      evidenceItemId
      excerpt
      locator
      supportStrength
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}`,
  {
    hash: "sha256:0b828880b661c2dee73ee067ba35677c7d5e355fe14fc3d01e372b166890ab0a",
  },
) as unknown as TypedDocumentString<
  LinkFactEvidenceMutation,
  LinkFactEvidenceMutationVariables
>;
export const LinkRelationshipEvidenceDocument = new TypedDocumentString(
  `
    mutation LinkRelationshipEvidence($input: LinkRelationshipEvidenceInput!) {
  linkRelationshipEvidence(input: $input) {
    relationshipEvidence {
      id
      relationshipId
      evidenceItemId
      locator
      supportStrength
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}`,
  {
    hash: "sha256:ef2ebd21c18e5929cad98d6d6750f07b7e42f567a95f2f4c1445d3c98673d5a6",
  },
) as unknown as TypedDocumentString<
  LinkRelationshipEvidenceMutation,
  LinkRelationshipEvidenceMutationVariables
>;
export const CreateNoteDocument = new TypedDocumentString(
  `
    mutation CreateNote($input: CreateNoteInput!) {
  createNote(input: $input) {
    note {
      id
      personId
      factId
      relationshipId
      evidenceItemId
      plainText
      sanitizedMarkdown
      sensitivity
      version
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}`,
  {
    hash: "sha256:4736d500495f78bc5a6d505c1c2009e9f11fa4db600d67fc608521c51e7e197a",
  },
) as unknown as TypedDocumentString<
  CreateNoteMutation,
  CreateNoteMutationVariables
>;
export const UpdateNoteDocument = new TypedDocumentString(
  `
    mutation UpdateNote($input: UpdateNoteInput!) {
  updateNote(input: $input) {
    note {
      id
      plainText
      sanitizedMarkdown
      sensitivity
      version
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}`,
  {
    hash: "sha256:e281e6ad7047d16524bc27880492c4b77aa6a35dfb007242024fc0b7ed77155f",
  },
) as unknown as TypedDocumentString<
  UpdateNoteMutation,
  UpdateNoteMutationVariables
>;
export const ArchiveNoteDocument = new TypedDocumentString(
  `
    mutation ArchiveNote($input: ArchiveNoteInput!) {
  archiveNote(input: $input) {
    note {
      id
      version
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}`,
  {
    hash: "sha256:0bbe2f0269121a0b1c0b41a65bd670ba2c88803e09177f6cce40ba90cf6a4322",
  },
) as unknown as TypedDocumentString<
  ArchiveNoteMutation,
  ArchiveNoteMutationVariables
>;
export const CreateTagDocument = new TypedDocumentString(
  `
    mutation CreateTag($input: CreateTagInput!) {
  createTag(input: $input) {
    tag {
      id
      name
      color
      version
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}`,
  {
    hash: "sha256:75799addcb9a01c2091d560ae932d5d6ae96381f48766284063452a3369a32d1",
  },
) as unknown as TypedDocumentString<
  CreateTagMutation,
  CreateTagMutationVariables
>;
export const TagPersonDocument = new TypedDocumentString(
  `
    mutation TagPerson($input: TagPersonInput!) {
  tagPerson(input: $input) {
    personTag {
      id
      personId
      tagId
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}`,
  {
    hash: "sha256:eeb0cbe6670bed1a7ab3d4c829d14ba7902a614aa7efa2afe76f421614ad077a",
  },
) as unknown as TypedDocumentString<
  TagPersonMutation,
  TagPersonMutationVariables
>;
export const UntagPersonDocument = new TypedDocumentString(
  `
    mutation UntagPerson($input: TagPersonInput!) {
  untagPerson(input: $input) {
    personTag {
      id
      personId
      tagId
    }
    issues {
      ...MutationIssue
    }
    code
    currentVersion
  }
}
    fragment MutationIssue on ValidationIssue {
  code
  message
  path
}`,
  {
    hash: "sha256:8e1d6092bd35e82349da826c0e89a2692a749fe5fddc8b554e753ca7aea70e02",
  },
) as unknown as TypedDocumentString<
  UntagPersonMutation,
  UntagPersonMutationVariables
>;
export const SearchWorkbenchSearchDocument = new TypedDocumentString(
  `
    query SearchWorkbenchSearch($input: SearchInput!) {
  search(input: $input) {
    ...SearchWorkbenchPage
  }
}
    fragment SearchWorkbenchHit on SearchHit {
  id
  kind
  title
  rank
  updatedAt
  snippet {
    matched
    text
  }
}
fragment SearchWorkbenchPage on SearchConnection {
  nodes {
    ...SearchWorkbenchHit
  }
  pageInfo {
    endCursor
    hasNextPage
  }
}`,
  {
    hash: "sha256:ffe2919bc295ebe436d1365a615e83810ea4e44e70e1ced83384b65a172f0735",
  },
) as unknown as TypedDocumentString<
  SearchWorkbenchSearchQuery,
  SearchWorkbenchSearchQueryVariables
>;
export const SearchWorkbenchSavedQueriesDocument = new TypedDocumentString(
  `
    query SearchWorkbenchSavedQueries($first: Int = 25, $after: String) {
  savedQueries(first: $first, after: $after) {
    nodes {
      ...SearchWorkbenchSavedQuery
    }
    pageInfo {
      endCursor
      hasNextPage
    }
  }
}
    fragment SearchWorkbenchSavedQuery on SavedQuery {
  id
  ownerPrincipalId
  name
  sharing
  queryAst
  version
  createdAt
  updatedAt
  archivedAt
}`,
  {
    hash: "sha256:c38f1148d6c9e9f7768c30c2289b6f71269c2e7e2934ae6791b21f9785575c98",
  },
) as unknown as TypedDocumentString<
  SearchWorkbenchSavedQueriesQuery,
  SearchWorkbenchSavedQueriesQueryVariables
>;
export const SearchWorkbenchSavedQueryByIdDocument = new TypedDocumentString(
  `
    query SearchWorkbenchSavedQueryById($id: UUID!) {
  savedQuery(id: $id) {
    ...SearchWorkbenchSavedQuery
  }
}
    fragment SearchWorkbenchSavedQuery on SavedQuery {
  id
  ownerPrincipalId
  name
  sharing
  queryAst
  version
  createdAt
  updatedAt
  archivedAt
}`,
  {
    hash: "sha256:8352219de1f02b0ba4de411752a8361e641cc07e1819ae3ff34b967c336f9c07",
  },
) as unknown as TypedDocumentString<
  SearchWorkbenchSavedQueryByIdQuery,
  SearchWorkbenchSavedQueryByIdQueryVariables
>;
export const SearchWorkbenchCreateSavedQueryDocument = new TypedDocumentString(
  `
    mutation SearchWorkbenchCreateSavedQuery($input: CreateSavedQueryInput!) {
  createSavedQuery(input: $input) {
    ...SearchWorkbenchSavedQuery
  }
}
    fragment SearchWorkbenchSavedQuery on SavedQuery {
  id
  ownerPrincipalId
  name
  sharing
  queryAst
  version
  createdAt
  updatedAt
  archivedAt
}`,
  {
    hash: "sha256:db4ebf33a1495cef882483bb175794a8d1cb177f49864240f84b0cb2a83b6a6b",
  },
) as unknown as TypedDocumentString<
  SearchWorkbenchCreateSavedQueryMutation,
  SearchWorkbenchCreateSavedQueryMutationVariables
>;
export const SearchWorkbenchUpdateSavedQueryDocument = new TypedDocumentString(
  `
    mutation SearchWorkbenchUpdateSavedQuery($input: UpdateSavedQueryInput!) {
  updateSavedQuery(input: $input) {
    ...SearchWorkbenchSavedQuery
  }
}
    fragment SearchWorkbenchSavedQuery on SavedQuery {
  id
  ownerPrincipalId
  name
  sharing
  queryAst
  version
  createdAt
  updatedAt
  archivedAt
}`,
  {
    hash: "sha256:85fc9ed4c467ee15aa066403c749f4bfd04081fe821bef9b1fe43ada92c499d1",
  },
) as unknown as TypedDocumentString<
  SearchWorkbenchUpdateSavedQueryMutation,
  SearchWorkbenchUpdateSavedQueryMutationVariables
>;
export const SearchWorkbenchArchiveSavedQueryDocument = new TypedDocumentString(
  `
    mutation SearchWorkbenchArchiveSavedQuery($id: UUID!, $expectedVersion: Int!) {
  archiveSavedQuery(id: $id, expectedVersion: $expectedVersion) {
    ...SearchWorkbenchSavedQuery
  }
}
    fragment SearchWorkbenchSavedQuery on SavedQuery {
  id
  ownerPrincipalId
  name
  sharing
  queryAst
  version
  createdAt
  updatedAt
  archivedAt
}`,
  {
    hash: "sha256:06b7760313a288be0ab5fed4bc61452a4aa6a72ff4499b24f82f495e2d66c804",
  },
) as unknown as TypedDocumentString<
  SearchWorkbenchArchiveSavedQueryMutation,
  SearchWorkbenchArchiveSavedQueryMutationVariables
>;
export const SearchWorkbenchRunSavedQueryDocument = new TypedDocumentString(
  `
    mutation SearchWorkbenchRunSavedQuery($id: UUID!) {
  runSavedQuery(id: $id) {
    ...SearchWorkbenchPage
  }
}
    fragment SearchWorkbenchHit on SearchHit {
  id
  kind
  title
  rank
  updatedAt
  snippet {
    matched
    text
  }
}
fragment SearchWorkbenchPage on SearchConnection {
  nodes {
    ...SearchWorkbenchHit
  }
  pageInfo {
    endCursor
    hasNextPage
  }
}`,
  {
    hash: "sha256:f040e590bc3558be7e34f9816d6eb1855ac13f576db5a11a704675936d87721d",
  },
) as unknown as TypedDocumentString<
  SearchWorkbenchRunSavedQueryMutation,
  SearchWorkbenchRunSavedQueryMutationVariables
>;
export const SettingsAuditEventsDocument = new TypedDocumentString(
  `
    query SettingsAuditEvents($first: Int = 25, $after: String, $filter: AuditEventFilterInput) {
  auditEvents(first: $first, after: $after, filter: $filter) {
    nodes {
      action
      resourceKind
      requestId
      outcome
      occurredAt
      actor {
        kind
        label
      }
    }
    pageInfo {
      endCursor
      hasNextPage
    }
  }
}
    `,
  {
    hash: "sha256:d64e9ed33a6f06010beeb43bf72a7891d3c0fb12204acd3b6ae22e51b16be23a",
  },
) as unknown as TypedDocumentString<
  SettingsAuditEventsQuery,
  SettingsAuditEventsQueryVariables
>;
export const SettingsPolicyPostureDocument = new TypedDocumentString(
  `
    query SettingsPolicyPosture {
  settingsPolicyPosture {
    workspace {
      version
      name
      locale
      timezone
      defaultRetentionDays
      aiEnabled
      storageEnabled
    }
    accessPolicies {
      id
      version
      name
      state
      sensitivityCeiling
      resourceKinds
    }
    resourceGrants {
      id
      policyId
      resourceId
      resourceKind
      memberId
      role
      state
      validFrom
      validUntil
      version
    }
    retentionPolicies {
      resourceKind
      retentionDays
      deletionBehavior
    }
  }
}
    `,
  {
    hash: "sha256:cbcd51bf1d849c2c2edfa552795baa06b53b0304f13082d9e8a676ccca9ff386",
  },
) as unknown as TypedDocumentString<
  SettingsPolicyPostureQuery,
  SettingsPolicyPostureQueryVariables
>;
export const SettingsOrganizationApiKeysDocument = new TypedDocumentString(
  `
    query SettingsOrganizationApiKeys($offset: Int) {
  settingsOrganizationApiKeys(offset: $offset) {
    nodes {
      actionId
      name
      fingerprint
      state
      scopes
      createdAt
      updatedAt
      expiresAt
      lastUsedAt
    }
    offset
    limit
    total
    hasPrevious
    hasMore
    allowedScopes
  }
}
    `,
  {
    hash: "sha256:ad75d07b102a9f44e871ca1829516c733157fdf01e1313a4d7cf46e0aca8ab9d",
  },
) as unknown as TypedDocumentString<
  SettingsOrganizationApiKeysQuery,
  SettingsOrganizationApiKeysQueryVariables
>;
export const CreateOrganizationApiKeyDocument = new TypedDocumentString(
  `
    mutation CreateOrganizationApiKey($input: CreateOrganizationApiKeyInput!) {
  createOrganizationApiKey(input: $input) {
    actionId
    code
    requestId
    secret
  }
}
    `,
  {
    hash: "sha256:51ed27cd4d704bca9a7f76334fc02292dbcd6fd65b21effc08f95f808473b11d",
  },
) as unknown as TypedDocumentString<
  CreateOrganizationApiKeyMutation,
  CreateOrganizationApiKeyMutationVariables
>;
export const RotateOrganizationApiKeyDocument = new TypedDocumentString(
  `
    mutation RotateOrganizationApiKey($input: RotateOrganizationApiKeyInput!) {
  rotateOrganizationApiKey(input: $input) {
    actionId
    code
    requestId
    secret
  }
}
    `,
  {
    hash: "sha256:10dfee84646531365fda45a33fab9e36701d75e00482d0ddf36e63d1eda90a36",
  },
) as unknown as TypedDocumentString<
  RotateOrganizationApiKeyMutation,
  RotateOrganizationApiKeyMutationVariables
>;
export const RevokeOrganizationApiKeyDocument = new TypedDocumentString(
  `
    mutation RevokeOrganizationApiKey($input: RevokeOrganizationApiKeyInput!) {
  revokeOrganizationApiKey(input: $input) {
    actionId
    code
    requestId
  }
}
    `,
  {
    hash: "sha256:5f4b7b22eded03a3f6ebcba79e6131159596aa221288503dc21300720ac851d0",
  },
) as unknown as TypedDocumentString<
  RevokeOrganizationApiKeyMutation,
  RevokeOrganizationApiKeyMutationVariables
>;
export const SettingsWorkspaceDirectoryDocument = new TypedDocumentString(
  `
    query SettingsWorkspaceDirectory($offset: Int) {
  settingsWorkspaceDirectory(offset: $offset) {
    actorRole
    invitations {
      actionId
      email
      role
      status
      createdAt
      expiresAt
    }
    members {
      nodes {
        actionId
        displayName
        email
        role
        joinedAt
        isSelf
      }
      offset
      limit
      total
      hasPrevious
      hasMore
    }
  }
}
    `,
  {
    hash: "sha256:9f1d8c4b1ad7a967f2ffefcefb92e2413b268ba83f091894c6120aebc2da076d",
  },
) as unknown as TypedDocumentString<
  SettingsWorkspaceDirectoryQuery,
  SettingsWorkspaceDirectoryQueryVariables
>;
export const IssueWorkspaceInvitationDocument = new TypedDocumentString(
  `
    mutation IssueWorkspaceInvitation($input: IssueWorkspaceInvitationInput!) {
  issueWorkspaceInvitation(input: $input) {
    actionId
    code
    requestId
  }
}
    `,
  {
    hash: "sha256:9bebf690242d631bca27a6f7a6800257e3558445f93780412ea91ff141d9a610",
  },
) as unknown as TypedDocumentString<
  IssueWorkspaceInvitationMutation,
  IssueWorkspaceInvitationMutationVariables
>;
export const ResendWorkspaceInvitationDocument = new TypedDocumentString(
  `
    mutation ResendWorkspaceInvitation($input: WorkspaceInvitationActionInput!) {
  resendWorkspaceInvitation(input: $input) {
    actionId
    code
    requestId
  }
}
    `,
  {
    hash: "sha256:0dbc406f982e5bf53325e9788eb6857860eef2ccd8d4ecc7043518f3a61dc69c",
  },
) as unknown as TypedDocumentString<
  ResendWorkspaceInvitationMutation,
  ResendWorkspaceInvitationMutationVariables
>;
export const CancelWorkspaceInvitationDocument = new TypedDocumentString(
  `
    mutation CancelWorkspaceInvitation($input: WorkspaceInvitationActionInput!) {
  cancelWorkspaceInvitation(input: $input) {
    actionId
    code
    requestId
  }
}
    `,
  {
    hash: "sha256:28ca750859a68fb4314b4681af181d7b70228fef74efa8f810e51251cbb4d129",
  },
) as unknown as TypedDocumentString<
  CancelWorkspaceInvitationMutation,
  CancelWorkspaceInvitationMutationVariables
>;
export const UpdateWorkspaceMemberRoleDocument = new TypedDocumentString(
  `
    mutation UpdateWorkspaceMemberRole($input: UpdateWorkspaceMemberRoleInput!) {
  updateWorkspaceMemberRole(input: $input) {
    actionId
    code
    requestId
  }
}
    `,
  {
    hash: "sha256:9086c3f3b017e7fd69cc579662141b7ed412e5ea16c7437b93d5c72c9ac863b1",
  },
) as unknown as TypedDocumentString<
  UpdateWorkspaceMemberRoleMutation,
  UpdateWorkspaceMemberRoleMutationVariables
>;
export const RemoveWorkspaceMemberDocument = new TypedDocumentString(
  `
    mutation RemoveWorkspaceMember($input: WorkspaceInvitationActionInput!) {
  removeWorkspaceMember(input: $input) {
    actionId
    code
    requestId
  }
}
    `,
  {
    hash: "sha256:00c53359642ac3d7da563eb499f7b11f32b2ed00ff723010fe8ea425c493317a",
  },
) as unknown as TypedDocumentString<
  RemoveWorkspaceMemberMutation,
  RemoveWorkspaceMemberMutationVariables
>;
export const UpdateWorkspaceDefaultsDocument = new TypedDocumentString(
  `
    mutation UpdateWorkspaceDefaults($input: UpdateWorkspaceDefaultsInput!) {
  updateWorkspaceDefaults(input: $input) {
    id
    version
    code
    requestId
  }
}
    `,
  {
    hash: "sha256:c6547025ce6d40bfa4b66aba1352d2167d509df6d43418fcffadf0f8c59a2d19",
  },
) as unknown as TypedDocumentString<
  UpdateWorkspaceDefaultsMutation,
  UpdateWorkspaceDefaultsMutationVariables
>;
export const CreateAccessPolicyDocument = new TypedDocumentString(
  `
    mutation CreateAccessPolicy($input: AccessPolicyInput!) {
  createAccessPolicy(input: $input) {
    id
    version
    code
    requestId
  }
}
    `,
  {
    hash: "sha256:a7da95a8514b509667510012164817943feee9fc3b3991f84e667516da1fdb8e",
  },
) as unknown as TypedDocumentString<
  CreateAccessPolicyMutation,
  CreateAccessPolicyMutationVariables
>;
export const CreateResourceGrantDocument = new TypedDocumentString(
  `
    mutation CreateResourceGrant($input: CreateResourceGrantInput!) {
  createResourceGrant(input: $input) {
    id
    version
    code
    requestId
  }
}
    `,
  {
    hash: "sha256:29bbe5bb274dd13ec222343385d6808b147b8edf2f4e1968765eeed2b29e4475",
  },
) as unknown as TypedDocumentString<
  CreateResourceGrantMutation,
  CreateResourceGrantMutationVariables
>;
export const ArchiveResourceGrantDocument = new TypedDocumentString(
  `
    mutation ArchiveResourceGrant($id: UUID!, $expectedVersion: Int!) {
  archiveResourceGrant(id: $id, expectedVersion: $expectedVersion) {
    id
    version
    code
    requestId
  }
}
    `,
  {
    hash: "sha256:dbaefd6c8a0b3f1ee65b841aca8a03d2c3f0d233731a4edb0179edafb7cb3c59",
  },
) as unknown as TypedDocumentString<
  ArchiveResourceGrantMutation,
  ArchiveResourceGrantMutationVariables
>;
export const ViewerDocument = new TypedDocumentString(
  `
    query Viewer {
  viewer {
    id
    actorType
    role
    permissions
    workspace {
      id
      organizationId
      name
    }
  }
  workspace {
    id
    organizationId
    name
  }
}
    `,
  {
    hash: "sha256:914d3bbffa388283841e86303dd4dd44ffbedf27a18db54e4cc73c99daf3dc4d",
  },
) as unknown as TypedDocumentString<ViewerQuery, ViewerQueryVariables>;
export const WorkspaceWebhooksDocument = new TypedDocumentString(
  `
    query WorkspaceWebhooks {
  webhooks {
    nodes {
      id
      url
      subscribedEvents
      state
      secretFingerprint
      version
      createdAt
      updatedAt
    }
  }
}
    `,
  {
    hash: "sha256:b3fa728323e514a4f5b1d59c9010b90b1c9698ef085d74d5d7708f431dfe2810",
  },
) as unknown as TypedDocumentString<
  WorkspaceWebhooksQuery,
  WorkspaceWebhooksQueryVariables
>;
export const CreateWorkspaceWebhookDocument = new TypedDocumentString(
  `
    mutation CreateWorkspaceWebhook($input: CreateWebhookInput!) {
  createWebhook(input: $input) {
    id
    code
    requestId
    secret
  }
}
    `,
  {
    hash: "sha256:6c786f5c2521027e813425f9c3fcc65d62b97b4b7bbb267f2e140c699cbd7757",
  },
) as unknown as TypedDocumentString<
  CreateWorkspaceWebhookMutation,
  CreateWorkspaceWebhookMutationVariables
>;
export const RotateWorkspaceWebhookSecretDocument = new TypedDocumentString(
  `
    mutation RotateWorkspaceWebhookSecret($input: WebhookIdInput!) {
  rotateWebhookSecret(input: $input) {
    id
    code
    requestId
    secret
  }
}
    `,
  {
    hash: "sha256:8330a47021846a6a42a3a3b4fba9c16efeb5ab09adcdb90a7def42a6cfff94e4",
  },
) as unknown as TypedDocumentString<
  RotateWorkspaceWebhookSecretMutation,
  RotateWorkspaceWebhookSecretMutationVariables
>;
export const DisableWorkspaceWebhookDocument = new TypedDocumentString(
  `
    mutation DisableWorkspaceWebhook($input: WebhookIdInput!) {
  disableWebhook(input: $input) {
    id
    code
    requestId
  }
}
    `,
  {
    hash: "sha256:87f1dd44c64da868a38ec1d9d6157215559a39ecbf76cf451418b20f0f81831a",
  },
) as unknown as TypedDocumentString<
  DisableWorkspaceWebhookMutation,
  DisableWorkspaceWebhookMutationVariables
>;
