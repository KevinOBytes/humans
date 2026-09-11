import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import {
  consentStatusEnum,
  deletionRequestStateEnum,
  lawfulBasisEnum,
  withdrawalEffectEnum,
  privacyRequestTypeEnum,
  privacyRequestStateEnum,
  privacyPropagationStateEnum,
} from "./enums";
import { evidenceItems } from "./evidence";
import { files } from "./files";
import { people } from "./people";
import { workspaces } from "./workspaces";
import { cases } from "./cases";

const domainTimestamp = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

export const consentRecords = pgTable(
  "consent_records",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull(),
    purpose: text("purpose").notNull(),
    status: consentStatusEnum("status").notNull(),
    source: text("source").notNull(),
    effectiveFrom: domainTimestamp("effective_from").notNull(),
    effectiveUntil: domainTimestamp("effective_until"),
    evidenceId: uuid("evidence_id"),
    noticeVersion: text("notice_version"),
    collectionMethod: text("collection_method"),
    lawfulBasis: lawfulBasisEnum("lawful_basis"),
    lawfulBasisMetadata: jsonb("lawful_basis_metadata"),
    withdrawalEffect: withdrawalEffectEnum("withdrawal_effect"),
    withdrawnAt: domainTimestamp("withdrawn_at"),
    withdrawnBy: text("withdrawn_by"),
    reviewedAt: domainTimestamp("reviewed_at"),
    reviewedBy: text("reviewed_by"),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("consent_records_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    index("consent_records_workspace_person_idx").on(
      table.workspaceId,
      table.personId,
    ),
    foreignKey({
      name: "consent_records_workspace_person_fk",
      columns: [table.workspaceId, table.personId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "consent_records_workspace_evidence_fk",
      columns: [table.workspaceId, table.evidenceId],
      foreignColumns: [evidenceItems.workspaceId, evidenceItems.id],
    }).onDelete("restrict"),
    check(
      "consent_records_effective_interval_check",
      sql`${table.effectiveUntil} IS NULL OR ${table.effectiveUntil} >= ${table.effectiveFrom}`,
    ),
    check("consent_records_version_check", sql`${table.version} > 0`),
  ],
);

export const deletionRequests = pgTable(
  "deletion_requests",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requesterId: text("requester_id").notNull(),
    scope: jsonb("scope").notNull(),
    state: deletionRequestStateEnum("state").default("requested").notNull(),
    reviewedAt: domainTimestamp("reviewed_at"),
    reviewedBy: text("reviewed_by"),
    reviewNotes: text("review_notes"),
    exportReferenceId: uuid("export_reference_id"),
    completedAt: domainTimestamp("completed_at"),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("deletion_requests_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    index("deletion_requests_workspace_state_idx").on(
      table.workspaceId,
      table.state,
    ),
    foreignKey({
      name: "deletion_requests_workspace_export_fk",
      columns: [table.workspaceId, table.exportReferenceId],
      foreignColumns: [files.workspaceId, files.id],
    }).onDelete("restrict"),
  ],
);

export const privacyRequests = pgTable(
  "privacy_requests",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requestType: privacyRequestTypeEnum("request_type").notNull(),
    state: privacyRequestStateEnum("state").default("requested").notNull(),
    requesterId: text("requester_id").notNull(),
    caseId: uuid("case_id"),
    scope: jsonb("scope")
      .$type<{ personIds: string[]; fileIds: string[] }>()
      .notNull(),
    purpose: text("purpose"),
    idempotencyHash: text("idempotency_hash").notNull(),
    requestHash: text("request_hash").notNull(),
    dueAt: domainTimestamp("due_at").notNull(),
    executeAfter: domainTimestamp("execute_after").notNull(),
    verifiedAt: domainTimestamp("verified_at"),
    verifiedBy: text("verified_by"),
    verificationEvidenceId: uuid("verification_evidence_id"),
    reviewedAt: domainTimestamp("reviewed_at"),
    reviewedBy: text("reviewed_by"),
    completionEvidenceId: uuid("completion_evidence_id"),
    auditReference: uuid("audit_reference"),
    legacyDeletionRequestId: uuid("legacy_deletion_request_id"),
    completedAt: domainTimestamp("completed_at"),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (t) => [
    unique("privacy_requests_workspace_id_unique").on(t.workspaceId, t.id),
    unique("privacy_requests_replay_unique").on(
      t.workspaceId,
      t.requesterId,
      t.idempotencyHash,
    ),
    unique("privacy_requests_legacy_unique").on(t.legacyDeletionRequestId),
    index("privacy_requests_workspace_state_due_idx").on(
      t.workspaceId,
      t.state,
      t.executeAfter,
    ),
    foreignKey({
      name: "privacy_requests_workspace_case_fk",
      columns: [t.workspaceId, t.caseId],
      foreignColumns: [cases.workspaceId, cases.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "privacy_requests_workspace_verification_fk",
      columns: [t.workspaceId, t.verificationEvidenceId],
      foreignColumns: [files.workspaceId, files.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "privacy_requests_workspace_completion_fk",
      columns: [t.workspaceId, t.completionEvidenceId],
      foreignColumns: [files.workspaceId, files.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "privacy_requests_workspace_legacy_fk",
      columns: [t.workspaceId, t.legacyDeletionRequestId],
      foreignColumns: [deletionRequests.workspaceId, deletionRequests.id],
    }).onDelete("restrict"),
    check("privacy_requests_version_check", sql`${t.version} > 0`),
    check("privacy_requests_deadline_check", sql`${t.dueAt} >= ${t.createdAt}`),
  ],
);

export const privacyProcessorPropagations = pgTable(
  "privacy_processor_propagations",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    privacyRequestId: uuid("privacy_request_id").notNull(),
    processor: text("processor").notNull(),
    state: privacyPropagationStateEnum("state").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    nextAttemptAt: domainTimestamp("next_attempt_at").defaultNow().notNull(),
    resultCode: text("result_code"),
    evidenceReference: text("evidence_reference"),
    auditReference: uuid("audit_reference"),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [
    unique("privacy_processor_propagations_workspace_id_unique").on(
      t.workspaceId,
      t.id,
    ),
    unique("privacy_processor_propagations_request_processor_unique").on(
      t.workspaceId,
      t.privacyRequestId,
      t.processor,
    ),
    foreignKey({
      name: "privacy_processor_propagations_workspace_request_fk",
      columns: [t.workspaceId, t.privacyRequestId],
      foreignColumns: [privacyRequests.workspaceId, privacyRequests.id],
    }).onDelete("cascade"),
    check(
      "privacy_processor_propagations_processor_check",
      sql`${t.processor} IN ('files', 'search', 'cache', 'email', 'ai_provider')`,
    ),
    check(
      "privacy_processor_propagations_attempts_check",
      sql`${t.attempts} >= 0 AND ${t.version} > 0`,
    ),
  ],
);
