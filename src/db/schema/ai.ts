import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { evidenceItems } from "./evidence";
import { workspacePrincipals } from "./principals";
import { workspaces } from "./workspaces";
import { people } from "./people";
import { cases } from "./cases";
import { personWebResearchRuns } from "./person-research";
import type {
  AiProposedValue,
  AiEvidenceReference,
} from "@/modules/ai/review-types";

const domainTimestamp = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

type WorkspaceThreadColumns = {
  workspaceId: AnyPgColumn;
  threadId: AnyPgColumn;
  id: AnyPgColumn;
};

function aiMessageForeignColumns(): WorkspaceThreadColumns {
  return aiMessages as unknown as WorkspaceThreadColumns;
}

export const aiReviewSuggestions = pgTable(
  "ai_review_suggestions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull(),
    caseId: uuid("case_id"),
    purpose: text("purpose").notNull(),
    fieldKey: text("field_key").notNull(),
    proposedValue: jsonb("proposed_value").$type<AiProposedValue>().notNull(),
    evidenceReferences: jsonb("evidence_references")
      .$type<AiEvidenceReference[]>()
      .notNull(),
    confidence: numeric("confidence", { mode: "number" }).notNull(),
    uncertainty: text("uncertainty").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptPolicyVersion: text("prompt_policy_version").notNull(),
    aiRunId: uuid("ai_run_id"),
    webRunId: uuid("web_run_id"),
    status: text("status").notNull().default("pending"),
    version: integer("version").notNull().default(1),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: domainTimestamp("reviewed_at"),
    decisionReason: text("decision_reason"),
    acceptedResourceId: uuid("accepted_resource_id"),
    acceptedResourceKind: text("accepted_resource_kind"),
    acceptedFromRunId: uuid("accepted_from_run_id"),
    acceptedEvidenceReferences: jsonb("accepted_evidence_references"),
    createdAt: domainTimestamp("created_at").notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").notNull().defaultNow(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    unique("ai_review_workspace_id_unique").on(t.workspaceId, t.id),
    index("ai_review_queue_idx").on(
      t.workspaceId,
      t.personId,
      t.status,
      t.createdAt,
    ),
    foreignKey({
      name: "ai_review_person_fk",
      columns: [t.workspaceId, t.personId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "ai_review_case_fk",
      columns: [t.workspaceId, t.caseId],
      foreignColumns: [cases.workspaceId, cases.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "ai_review_run_fk",
      columns: [t.workspaceId, t.aiRunId],
      foreignColumns: [aiRuns.workspaceId, aiRuns.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "ai_review_web_run_fk",
      columns: [t.workspaceId, t.webRunId],
      foreignColumns: [
        personWebResearchRuns.workspaceId,
        personWebResearchRuns.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "ai_review_creator_fk",
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "ai_review_updater_fk",
      columns: [t.workspaceId, t.updatedBy],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "ai_review_reviewer_fk",
      columns: [t.workspaceId, t.reviewedBy],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    check(
      "ai_review_run_check",
      sql`num_nonnulls(${t.aiRunId}, ${t.webRunId}) = 1`,
    ),
    check("ai_review_confidence_check", sql`${t.confidence} BETWEEN 0 AND 1`),
    check(
      "ai_review_evidence_check",
      sql`jsonb_typeof(${t.evidenceReferences}) = 'array' AND jsonb_array_length(${t.evidenceReferences}) BETWEEN 1 AND 5`,
    ),
    check(
      "ai_review_value_check",
      sql`${t.proposedValue}->>'version' = '1' AND ${t.proposedValue}->>'kind' IN ('profile', 'fact', 'relationship')`,
    ),
    check(
      "ai_review_status_check",
      sql`${t.status} IN ('pending', 'accepted', 'rejected', 'deferred') AND ${t.version} > 0`,
    ),
    check(
      "ai_review_decision_check",
      sql`(${t.status} = 'pending' AND ${t.reviewedBy} IS NULL AND ${t.reviewedAt} IS NULL) OR (${t.status} <> 'pending' AND ${t.reviewedBy} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL)`,
    ),
    check(
      "ai_review_acceptance_check",
      sql`(${t.status} = 'accepted' AND ${t.acceptedResourceId} IS NOT NULL AND ${t.acceptedResourceKind} IN ('person','fact','relationship') AND ${t.acceptedFromRunId} IS NOT NULL AND ${t.acceptedEvidenceReferences} IS NOT NULL) OR (${t.status} <> 'accepted' AND ${t.acceptedResourceId} IS NULL AND ${t.acceptedResourceKind} IS NULL AND ${t.acceptedFromRunId} IS NULL AND ${t.acceptedEvidenceReferences} IS NULL)`,
    ),
    check(
      "ai_review_rejection_check",
      sql`${t.status} <> 'rejected' OR length(trim(${t.decisionReason})) > 0`,
    ),
  ],
);

export const aiThreads = pgTable(
  "ai_threads",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id").notNull(),
    title: text("title").notNull(),
    sharing: text("sharing").default("private").notNull(),
    retentionDays: integer("retention_days"),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: uuid("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: uuid("deleted_by"),
  },
  (table) => [
    unique("ai_threads_workspace_id_unique").on(table.workspaceId, table.id),
    index("ai_threads_workspace_owner_idx").on(
      table.workspaceId,
      table.ownerId,
      table.updatedAt,
    ),
    foreignKey({
      name: "ai_threads_workspace_owner_fk",
      columns: [table.workspaceId, table.ownerId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "ai_threads_workspace_creator_fk",
      columns: [table.workspaceId, table.createdBy],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "ai_threads_workspace_updater_fk",
      columns: [table.workspaceId, table.updatedBy],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "ai_threads_workspace_deleter_fk",
      columns: [table.workspaceId, table.deletedBy],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    check(
      "ai_threads_retention_check",
      sql`${table.retentionDays} IS NULL OR ${table.retentionDays} >= 0`,
    ),
    check("ai_threads_version_check", sql`${table.version} > 0`),
  ],
);

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").notNull(),
    aiRunId: uuid("ai_run_id"),
    role: text("role").notNull(),
    encryptedContent: text("encrypted_content").notNull(),
    contentHash: text("content_hash").notNull(),
    citationCount: integer("citation_count").default(0).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (table) => [
    unique("ai_messages_workspace_id_unique").on(table.workspaceId, table.id),
    unique("ai_messages_workspace_thread_id_unique").on(
      table.workspaceId,
      table.threadId,
      table.id,
    ),
    index("ai_messages_workspace_thread_idx").on(
      table.workspaceId,
      table.threadId,
      table.createdAt,
    ),
    foreignKey({
      name: "ai_messages_workspace_thread_fk",
      columns: [table.workspaceId, table.threadId],
      foreignColumns: [aiThreads.workspaceId, aiThreads.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "ai_messages_workspace_run_fk",
      columns: [table.workspaceId, table.threadId, table.aiRunId],
      foreignColumns: [aiRuns.workspaceId, aiRuns.threadId, aiRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "ai_messages_workspace_actor_fk",
      columns: [table.workspaceId, table.createdBy],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "ai_messages_workspace_updater_fk",
      columns: [table.workspaceId, table.updatedBy],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    check(
      "ai_messages_assistant_run_check",
      sql`${table.role} <> 'assistant' OR ${table.aiRunId} IS NOT NULL`,
    ),
    check(
      "ai_messages_role_check",
      sql`${table.role} IN ('system', 'user', 'assistant', 'tool')`,
    ),
    check("ai_messages_citation_count_check", sql`${table.citationCount} >= 0`),
  ],
);

export const aiRuns = pgTable(
  "ai_runs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").notNull(),
    governancePurpose: text("governance_purpose"),
    governanceCaseReference: text("governance_case_reference"),
    reviewPersonIds: jsonb("review_person_ids")
      .$type<string[]>()
      .default([])
      .notNull(),
    messageId: uuid("message_id"),
    provider: text("provider").notNull(),
    baseUrlFingerprint: text("base_url_fingerprint").notNull(),
    model: text("model").notNull(),
    capabilityProfile: jsonb("capability_profile").default({}).notNull(),
    promptHash: text("prompt_hash").notNull(),
    configurationHash: text("configuration_hash").notNull(),
    state: text("state").default("pending").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costMicrounits: numeric("cost_microunits"),
    startedAt: domainTimestamp("started_at"),
    completedAt: domainTimestamp("completed_at"),
    errorCode: text("error_code"),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: uuid("created_by").notNull(),
  },
  (table) => [
    unique("ai_runs_workspace_id_unique").on(table.workspaceId, table.id),
    unique("ai_runs_workspace_thread_id_unique").on(
      table.workspaceId,
      table.threadId,
      table.id,
    ),
    index("ai_runs_workspace_thread_idx").on(
      table.workspaceId,
      table.threadId,
      table.createdAt,
    ),
    foreignKey({
      name: "ai_runs_workspace_thread_fk",
      columns: [table.workspaceId, table.threadId],
      foreignColumns: [aiThreads.workspaceId, aiThreads.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "ai_runs_workspace_input_message_fk",
      columns: [table.workspaceId, table.threadId, table.messageId],
      foreignColumns: [
        aiMessageForeignColumns().workspaceId,
        aiMessageForeignColumns().threadId,
        aiMessageForeignColumns().id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "ai_runs_workspace_actor_fk",
      columns: [table.workspaceId, table.createdBy],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    check(
      "ai_runs_usage_check",
      sql`(${table.inputTokens} IS NULL OR ${table.inputTokens} >= 0) AND (${table.outputTokens} IS NULL OR ${table.outputTokens} >= 0) AND (${table.costMicrounits} IS NULL OR ${table.costMicrounits} >= 0)`,
    ),
    check(
      "ai_runs_timing_check",
      sql`${table.completedAt} IS NULL OR ${table.startedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt}`,
    ),
  ],
);

export const aiEphemeralInputs = pgTable(
  "ai_ephemeral_inputs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").notNull(),
    aiRunId: uuid("ai_run_id").notNull(),
    encryptedContent: text("encrypted_content").notNull(),
    contentHash: text("content_hash").notNull(),
    expiresAt: domainTimestamp("expires_at").notNull(),
    claimedAt: domainTimestamp("claimed_at"),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("ai_ephemeral_inputs_workspace_run_unique").on(
      table.workspaceId,
      table.aiRunId,
    ),
    index("ai_ephemeral_inputs_expiry_idx").on(table.expiresAt),
    foreignKey({
      name: "ai_ephemeral_inputs_workspace_run_fk",
      columns: [table.workspaceId, table.threadId, table.aiRunId],
      foreignColumns: [aiRuns.workspaceId, aiRuns.threadId, aiRuns.id],
    }).onDelete("cascade"),
    check(
      "ai_ephemeral_inputs_lifecycle_check",
      sql`${table.expiresAt} > ${table.createdAt} AND (${table.claimedAt} IS NULL OR ${table.claimedAt} >= ${table.createdAt})`,
    ),
  ],
);

export const aiToolCalls = pgTable(
  "ai_tool_calls",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    aiRunId: uuid("ai_run_id").notNull(),
    approvedToolName: text("approved_tool_name").notNull(),
    redactedArguments: jsonb("redacted_arguments").default({}).notNull(),
    redactedResultSummary: jsonb("redacted_result_summary"),
    resourceReferences: jsonb("resource_references").default([]).notNull(),
    state: text("state").default("pending").notNull(),
    startedAt: domainTimestamp("started_at"),
    completedAt: domainTimestamp("completed_at"),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("ai_tool_calls_workspace_id_unique").on(table.workspaceId, table.id),
    index("ai_tool_calls_workspace_run_idx").on(
      table.workspaceId,
      table.aiRunId,
      table.createdAt,
    ),
    foreignKey({
      name: "ai_tool_calls_workspace_run_fk",
      columns: [table.workspaceId, table.aiRunId],
      foreignColumns: [aiRuns.workspaceId, aiRuns.id],
    }).onDelete("cascade"),
    check(
      "ai_tool_calls_name_check",
      sql`${table.approvedToolName} ~ '^[A-Za-z][A-Za-z0-9_.-]*$'`,
    ),
    check(
      "ai_tool_calls_timing_check",
      sql`${table.completedAt} IS NULL OR ${table.startedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt}`,
    ),
  ],
);

export const aiCitations = pgTable(
  "ai_citations",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").notNull(),
    aiRunId: uuid("ai_run_id").notNull(),
    messageId: uuid("message_id"),
    // Forward-migration snapshot only. A database trigger rejects new values
    // and makes every migrated value immutable.
    legacyMessageId: uuid("legacy_message_id"),
    resourceKind: text("resource_kind").notNull(),
    resourceId: uuid("resource_id").notNull(),
    evidenceItemId: uuid("evidence_item_id"),
    locator: text("locator"),
    claimText: text("claim_text").notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("ai_citations_workspace_id_unique").on(table.workspaceId, table.id),
    index("ai_citations_workspace_run_idx").on(
      table.workspaceId,
      table.aiRunId,
      table.messageId,
    ),
    foreignKey({
      name: "ai_citations_workspace_run_fk",
      columns: [table.workspaceId, table.threadId, table.aiRunId],
      foreignColumns: [aiRuns.workspaceId, aiRuns.threadId, aiRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "ai_citations_workspace_message_fk",
      columns: [table.workspaceId, table.threadId, table.messageId],
      foreignColumns: [
        aiMessages.workspaceId,
        aiMessages.threadId,
        aiMessages.id,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "ai_citations_workspace_evidence_fk",
      columns: [table.workspaceId, table.evidenceItemId],
      foreignColumns: [evidenceItems.workspaceId, evidenceItems.id],
    }).onDelete("restrict"),
    check(
      "ai_citations_message_identity_check",
      sql`num_nonnulls(${table.messageId}, ${table.legacyMessageId}) = 1`,
    ),
  ],
);
