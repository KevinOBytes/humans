import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { sensitivityEnum } from "./enums";
import { people } from "./people";
import { workspacePrincipals } from "./principals";
import { workspaces } from "./workspaces";

const domainTimestamp = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

export const searchDocuments = pgTable(
  "search_documents",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Keep the accepted Task 12A property names while migrating the physical
    // columns to the contribution-oriented Task 12 vocabulary.
    resourceKind: text("source_kind").notNull(),
    resourceId: uuid("source_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    chunkOrdinal: integer("chunk_ordinal").default(0).notNull(),
    resultKind: text("result_kind").notNull(),
    resultId: uuid("result_id").notNull(),
    subjectPersonId: uuid("subject_person_id"),
    sensitivity: sensitivityEnum("sensitivity").notNull(),
    documentSchemaVersion: smallint("document_schema_version")
      .default(1)
      .notNull(),
    redactedText: text("title_text").notNull(),
    bodyText: text("body_text").default("").notNull(),
    displayText: text("display_text").notNull(),
    searchVector: tsvector("search_vector")
      .generatedAlwaysAs(
        sql`setweight(to_tsvector('simple', coalesce("title_text", '')), 'A') || setweight(to_tsvector('simple', coalesce("body_text", '')), 'C')`,
      )
      .notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("search_documents_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    unique("search_documents_workspace_source_chunk_unique").on(
      table.workspaceId,
      table.resourceKind,
      table.resourceId,
      table.chunkOrdinal,
      table.documentSchemaVersion,
    ),
    index("search_documents_workspace_source_idx").on(
      table.workspaceId,
      table.resourceKind,
      table.resourceId,
      table.sourceVersion,
    ),
    index("search_documents_workspace_result_page_idx").on(
      table.workspaceId,
      table.resultKind,
      table.resultId,
      table.updatedAt,
    ),
    index("search_documents_workspace_subject_idx").on(
      table.workspaceId,
      table.subjectPersonId,
      table.resultKind,
    ),
    index("search_documents_search_vector_gin").using(
      "gin",
      table.searchVector,
    ),
    foreignKey({
      name: "search_documents_workspace_subject_person_fk",
      columns: [table.workspaceId, table.subjectPersonId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    check(
      "search_documents_result_kind_check",
      sql`${table.resultKind} IN ('PERSON', 'FACT', 'ADDRESS', 'RELATIONSHIP', 'EVIDENCE')`,
    ),
    check(
      "search_documents_source_kind_check",
      sql`${table.resourceKind} IN ('person', 'person_name', 'fact_definition', 'fact', 'relationship_type', 'relationship', 'source', 'person_address', 'evidence_item', 'evidence_excerpt', 'note')`,
    ),
    check(
      "search_documents_source_version_check",
      sql`${table.sourceVersion} > 0`,
    ),
    check(
      "search_documents_chunk_ordinal_check",
      sql`${table.chunkOrdinal} >= 0 AND ${table.chunkOrdinal} < 64`,
    ),
    check(
      "search_documents_schema_version_check",
      sql`${table.documentSchemaVersion} = 1`,
    ),
    check(
      "search_documents_text_bounds_check",
      sql`octet_length(${table.redactedText}) BETWEEN 1 AND 512 AND octet_length(${table.bodyText}) <= 8192 AND octet_length(${table.displayText}) BETWEEN 1 AND 8192`,
    ),
  ],
);

// Optional embedding records remain a future, non-required extension seam.
export const embeddings = pgTable(
  "embeddings",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    resourceKind: text("resource_kind").notNull(),
    resourceId: uuid("resource_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    vectorJson: jsonb("vector_json").notNull(),
    sourceHash: text("source_hash").notNull(),
    configuration: jsonb("configuration").default({}).notNull(),
    generatedAt: domainTimestamp("generated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("embeddings_workspace_id_unique").on(table.workspaceId, table.id),
    unique("embeddings_workspace_resource_model_unique").on(
      table.workspaceId,
      table.resourceKind,
      table.resourceId,
      table.provider,
      table.model,
      table.sourceHash,
    ),
    index("embeddings_workspace_resource_idx").on(
      table.workspaceId,
      table.resourceKind,
      table.resourceId,
    ),
    check(
      "embeddings_dimensions_check",
      sql`${table.dimensions} > 0 AND jsonb_typeof(${table.vectorJson}) = 'array' AND jsonb_array_length(${table.vectorJson}) = ${table.dimensions}`,
    ),
  ],
);

export const savedQueries = pgTable(
  "saved_queries",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerPrincipalId: uuid("owner_principal_id").notNull(),
    name: text("name").notNull(),
    sharing: text("sharing").default("PRIVATE").notNull(),
    queryAst: jsonb("query_ast").notNull(),
    astVersion: smallint("ast_version").default(1).notNull(),
    queryHash: text("query_hash").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: uuid("updated_by").notNull(),
    archivedAt: domainTimestamp("archived_at"),
    archivedBy: uuid("archived_by"),
  },
  (table) => [
    unique("saved_queries_workspace_id_unique").on(table.workspaceId, table.id),
    unique("saved_queries_workspace_owner_name_unique").on(
      table.workspaceId,
      table.ownerPrincipalId,
      table.name,
    ),
    index("saved_queries_workspace_list_idx").on(
      table.workspaceId,
      table.sharing,
      table.archivedAt,
      table.name,
      table.id,
    ),
    foreignKey({
      name: "saved_queries_workspace_owner_principal_fk",
      columns: [table.workspaceId, table.ownerPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "saved_queries_workspace_creator_principal_fk",
      columns: [table.workspaceId, table.createdBy],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "saved_queries_workspace_updater_principal_fk",
      columns: [table.workspaceId, table.updatedBy],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "saved_queries_workspace_archiver_principal_fk",
      columns: [table.workspaceId, table.archivedBy],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    check(
      "saved_queries_name_check",
      sql`octet_length(${table.name}) BETWEEN 1 AND 120`,
    ),
    check(
      "saved_queries_sharing_check",
      sql`${table.sharing} IN ('PRIVATE', 'WORKSPACE')`,
    ),
    check(
      "saved_queries_ast_check",
      sql`${table.astVersion} = 1 AND jsonb_typeof(${table.queryAst}) = 'object' AND octet_length(${table.queryAst}::text) <= 32768 AND ${table.queryHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check("saved_queries_version_check", sql`${table.version} > 0`),
    check(
      "saved_queries_archive_check",
      sql`(${table.archivedAt} IS NULL AND ${table.archivedBy} IS NULL) OR (${table.archivedAt} IS NOT NULL AND ${table.archivedBy} IS NOT NULL)`,
    ),
  ],
);

export const queryRuns = pgTable(
  "query_runs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    savedQueryId: uuid("saved_query_id"),
    actorPrincipalId: uuid("actor_principal_id").notNull(),
    actorKind: text("actor_kind").notNull(),
    queryHash: text("query_hash").notNull(),
    outcome: text("outcome").notNull(),
    startedAt: domainTimestamp("started_at").defaultNow().notNull(),
    completedAt: domainTimestamp("completed_at"),
    durationMs: integer("duration_ms"),
    resultCount: integer("result_count"),
  },
  (table) => [
    unique("query_runs_workspace_id_unique").on(table.workspaceId, table.id),
    index("query_runs_workspace_query_idx").on(
      table.workspaceId,
      table.savedQueryId,
      table.startedAt,
    ),
    index("query_runs_workspace_actor_idx").on(
      table.workspaceId,
      table.actorPrincipalId,
      table.startedAt,
    ),
    foreignKey({
      name: "query_runs_workspace_saved_query_fk",
      columns: [table.workspaceId, table.savedQueryId],
      foreignColumns: [savedQueries.workspaceId, savedQueries.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "query_runs_workspace_actor_principal_fk",
      columns: [table.workspaceId, table.actorPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    check(
      "query_runs_actor_kind_check",
      sql`${table.actorKind} IN ('USER', 'API_KEY')`,
    ),
    check(
      "query_runs_hash_outcome_check",
      sql`${table.queryHash} ~ '^[0-9a-f]{64}$' AND ${table.outcome} IN ('SUCCESS', 'ERROR')`,
    ),
    check(
      "query_runs_metrics_check",
      sql`(${table.durationMs} IS NULL OR ${table.durationMs} >= 0) AND (${table.resultCount} IS NULL OR ${table.resultCount} >= 0) AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt})`,
    ),
  ],
);
