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
} from "drizzle-orm/pg-core";

import { evidenceItems } from "./evidence";
import { workspacePrincipals } from "./principals";
import { workspaces } from "./workspaces";

const domainTimestamp = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

export const aiThreads = pgTable(
  "ai_threads",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    title: text("title").notNull(),
    sharing: text("sharing").default("private").notNull(),
    retentionDays: integer("retention_days"),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
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
      foreignColumns: [
        workspacePrincipals.workspaceId,
        workspacePrincipals.userId,
      ],
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
    role: text("role").notNull(),
    encryptedContent: text("encrypted_content").notNull(),
    contentHash: text("content_hash").notNull(),
    citationCount: integer("citation_count").default(0).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
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
      name: "ai_messages_workspace_actor_fk",
      columns: [table.workspaceId, table.createdBy],
      foreignColumns: [
        workspacePrincipals.workspaceId,
        workspacePrincipals.userId,
      ],
    }).onDelete("restrict"),
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
    createdBy: text("created_by").notNull(),
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
        aiMessages.workspaceId,
        aiMessages.threadId,
        aiMessages.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "ai_runs_workspace_actor_fk",
      columns: [table.workspaceId, table.createdBy],
      foreignColumns: [
        workspacePrincipals.workspaceId,
        workspacePrincipals.userId,
      ],
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
      sql`${table.approvedToolName} ~ '^[a-z][a-z0-9_.-]*$'`,
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
