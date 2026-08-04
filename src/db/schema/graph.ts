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

import { people } from "./people";
import { workspacePrincipals } from "./principals";
import { relationships } from "./relationships";
import { workspaces } from "./workspaces";

const domainTimestamp = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

export const graphViews = pgTable(
  "graph_views",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    filters: jsonb("filters").default({}).notNull(),
    layout: jsonb("layout").default({}).notNull(),
    appearance: jsonb("appearance").default({}).notNull(),
    sharing: text("sharing").default("private").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("graph_views_workspace_id_unique").on(table.workspaceId, table.id),
    unique("graph_views_workspace_owner_name_unique").on(
      table.workspaceId,
      table.ownerId,
      table.name,
    ),
    foreignKey({
      name: "graph_views_workspace_owner_fk",
      columns: [table.workspaceId, table.ownerId],
      foreignColumns: [
        workspacePrincipals.workspaceId,
        workspacePrincipals.userId,
      ],
    }).onDelete("restrict"),
    check("graph_views_version_check", sql`${table.version} > 0`),
  ],
);

export const graphViewNodes = pgTable(
  "graph_view_nodes",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    graphViewId: uuid("graph_view_id").notNull(),
    personId: uuid("person_id").notNull(),
    positionX: numeric("position_x"),
    positionY: numeric("position_y"),
    styleOverride: jsonb("style_override").default({}).notNull(),
    visibility: text("visibility").default("visible").notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    unique("graph_view_nodes_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    unique("graph_view_nodes_workspace_view_person_unique").on(
      table.workspaceId,
      table.graphViewId,
      table.personId,
    ),
    foreignKey({
      name: "graph_view_nodes_workspace_view_fk",
      columns: [table.workspaceId, table.graphViewId],
      foreignColumns: [graphViews.workspaceId, graphViews.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "graph_view_nodes_workspace_person_fk",
      columns: [table.workspaceId, table.personId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    check(
      "graph_view_nodes_position_check",
      sql`(${table.positionX} IS NULL AND ${table.positionY} IS NULL) OR (${table.positionX} IS NOT NULL AND ${table.positionY} IS NOT NULL)`,
    ),
  ],
);

export const graphSnapshots = pgTable(
  "graph_snapshots",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    graphViewId: uuid("graph_view_id"),
    manifestSchema: text("manifest_schema").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    manifestMaterial: jsonb("manifest_material").notNull(),
    queryInput: jsonb("query_input").default({}).notNull(),
    queryHash: text("query_hash").notNull(),
    authorizationHash: text("authorization_hash").notNull(),
    actorPrincipalId: uuid("actor_principal_id").notNull(),
    actorKind: text("actor_kind").notNull(),
    includedPersonVersions: jsonb("included_person_versions")
      .default({})
      .notNull(),
    includedRelationshipVersions: jsonb("included_relationship_versions")
      .default({})
      .notNull(),
    includedRelationshipTypeVersions: jsonb(
      "included_relationship_type_versions",
    )
      .default({})
      .notNull(),
    algorithm: text("algorithm").notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    algorithmConfigHash: text("algorithm_config_hash").notNull(),
    algorithmConfiguration: jsonb("algorithm_configuration")
      .default({})
      .notNull(),
    runtimeContract: jsonb("runtime_contract").notNull(),
    generatedAt: domainTimestamp("generated_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    unique("graph_snapshots_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    index("graph_snapshots_workspace_view_idx").on(
      table.workspaceId,
      table.graphViewId,
      table.generatedAt,
    ),
    index("graph_snapshots_workspace_manifest_idx").on(
      table.workspaceId,
      table.manifestHash,
      table.generatedAt,
    ),
    foreignKey({
      name: "graph_snapshots_workspace_view_fk",
      columns: [table.workspaceId, table.graphViewId],
      foreignColumns: [graphViews.workspaceId, graphViews.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "graph_snapshots_workspace_actor_principal_fk",
      columns: [table.workspaceId, table.actorPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    check(
      "graph_snapshots_manifest_check",
      sql`${table.manifestSchema} = 'humans.graph-snapshot-manifest.v1'
        AND ${table.manifestHash} ~ '^[0-9a-f]{64}$'
        AND ${table.queryHash} ~ '^[0-9a-f]{64}$'
        AND ${table.authorizationHash} ~ '^[0-9a-f]{64}$'
        AND ${table.algorithmConfigHash} ~ '^[0-9a-f]{64}$'
        AND ${table.actorKind} IN ('USER', 'API_KEY')
        AND ${table.algorithm} IN ('DEGREE', 'PAGERANK', 'LOUVAIN_COMMUNITY')
        AND octet_length(${table.algorithmVersion}) BETWEEN 1 AND 256
        AND jsonb_typeof(${table.queryInput}) = 'object'
        AND octet_length(${table.queryInput}::text) <= 32768
        AND jsonb_typeof(${table.includedPersonVersions}) = 'object'
        AND octet_length(${table.includedPersonVersions}::text) <= 2000000
        AND jsonb_typeof(${table.includedRelationshipVersions}) = 'object'
        AND octet_length(${table.includedRelationshipVersions}::text) <= 2000000
        AND jsonb_typeof(${table.includedRelationshipTypeVersions}) = 'object'
        AND octet_length(${table.includedRelationshipTypeVersions}::text) <= 2000000
        AND jsonb_typeof(${table.algorithmConfiguration}) = 'object'
        AND ${table.algorithmConfiguration} <> '{}'::jsonb
        AND octet_length(${table.algorithmConfiguration}::text) <= 32768
        AND jsonb_typeof(${table.runtimeContract}) = 'object'
        AND ${table.runtimeContract} <> '{}'::jsonb
        AND octet_length(${table.runtimeContract}::text) <= 32768`,
    ),
    check(
      "graph_snapshots_manifest_material_check",
      sql`jsonb_typeof(${table.manifestMaterial}) = 'object'
        AND ${table.manifestMaterial} <> '{}'::jsonb
        AND octet_length(${table.manifestMaterial}::text) <= 33554432`,
    ),
  ],
);

export const analysisRuns = pgTable(
  "analysis_runs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    algorithm: text("algorithm").notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    configurationHash: text("configuration_hash").notNull(),
    graphSnapshotId: uuid("graph_snapshot_id").notNull(),
    actorPrincipalId: uuid("actor_principal_id").notNull(),
    actorKind: text("actor_kind").notNull(),
    configuration: jsonb("configuration").default({}).notNull(),
    state: text("state").default("pending").notNull(),
    startedAt: domainTimestamp("started_at"),
    completedAt: domainTimestamp("completed_at"),
    errorSummary: jsonb("error_summary"),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    unique("analysis_runs_workspace_id_unique").on(table.workspaceId, table.id),
    index("analysis_runs_workspace_snapshot_idx").on(
      table.workspaceId,
      table.graphSnapshotId,
      table.createdAt,
    ),
    foreignKey({
      name: "analysis_runs_workspace_snapshot_fk",
      columns: [table.workspaceId, table.graphSnapshotId],
      foreignColumns: [graphSnapshots.workspaceId, graphSnapshots.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "analysis_runs_workspace_actor_principal_fk",
      columns: [table.workspaceId, table.actorPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    check(
      "analysis_runs_contract_check",
      sql`${table.configurationHash} ~ '^[0-9a-f]{64}$'
        AND ${table.actorKind} IN ('USER', 'API_KEY')
        AND ${table.algorithm} IN ('DEGREE', 'PAGERANK', 'LOUVAIN_COMMUNITY')
        AND octet_length(${table.algorithmVersion}) BETWEEN 1 AND 256
        AND jsonb_typeof(${table.configuration}) = 'object'
        AND ${table.configuration} <> '{}'::jsonb
        AND octet_length(${table.configuration}::text) <= 32768
        AND ${table.state} IN ('pending', 'running', 'completed', 'failed', 'cancelled')
        AND (${table.errorSummary} IS NULL OR (
          jsonb_typeof(${table.errorSummary}) = 'object'
          AND octet_length(${table.errorSummary}::text) <= 32768
        ))`,
    ),
    check(
      "analysis_runs_timing_check",
      sql`(
          ${table.state} IN ('pending', 'running')
          AND ${table.completedAt} IS NULL
        ) OR (
          ${table.state} IN ('completed', 'failed', 'cancelled')
          AND ${table.startedAt} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL
          AND ${table.completedAt} >= ${table.startedAt}
        )`,
    ),
  ],
);

export const analysisResults = pgTable(
  "analysis_results",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    analysisRunId: uuid("analysis_run_id").notNull(),
    resultKind: text("result_kind").notNull(),
    payloadSchema: text("payload_schema").notNull(),
    payloadHash: text("payload_hash").notNull(),
    exportLabel: text("export_label").notNull(),
    subjectPersonId: uuid("subject_person_id"),
    subjectRelationshipId: uuid("subject_relationship_id"),
    numericValue: numeric("numeric_value"),
    textValue: text("text_value"),
    jsonValue: jsonb("json_value"),
    rank: integer("rank"),
    explanation: text("explanation"),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("analysis_results_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    index("analysis_results_workspace_run_idx").on(
      table.workspaceId,
      table.analysisRunId,
      table.rank,
    ),
    foreignKey({
      name: "analysis_results_workspace_run_fk",
      columns: [table.workspaceId, table.analysisRunId],
      foreignColumns: [analysisRuns.workspaceId, analysisRuns.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "analysis_results_workspace_person_fk",
      columns: [table.workspaceId, table.subjectPersonId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "analysis_results_workspace_relationship_fk",
      columns: [table.workspaceId, table.subjectRelationshipId],
      foreignColumns: [relationships.workspaceId, relationships.id],
    }).onDelete("restrict"),
    check(
      "analysis_results_subject_check",
      sql`num_nonnulls(${table.subjectPersonId}, ${table.subjectRelationshipId}) <= 1`,
    ),
    check(
      "analysis_results_value_check",
      sql`num_nonnulls(${table.numericValue}, ${table.textValue}, ${table.jsonValue}) = 1`,
    ),
    check(
      "analysis_results_rank_check",
      sql`${table.rank} IS NULL OR ${table.rank} > 0`,
    ),
    check(
      "analysis_results_payload_check",
      sql`${table.payloadSchema} = 'humans.graph-analysis-result.v1'
        AND ${table.payloadHash} ~ '^[0-9a-f]{64}$'
        AND ${table.resultKind} IN ('degree', 'pagerank', 'community')
        AND octet_length(${table.exportLabel}) BETWEEN 1 AND 120
        AND (${table.textValue} IS NULL OR octet_length(${table.textValue}) <= 8192)
        AND (${table.jsonValue} IS NULL OR octet_length(${table.jsonValue}::text) <= 32768)
        AND (${table.explanation} IS NULL OR octet_length(${table.explanation}) <= 1024)`,
    ),
  ],
);

export const personMetrics = pgTable(
  "person_metrics",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    graphSnapshotId: uuid("graph_snapshot_id").notNull(),
    personId: uuid("person_id").notNull(),
    metricKey: text("metric_key").notNull(),
    metricValue: numeric("metric_value").notNull(),
    rank: integer("rank"),
    algorithmVersion: text("algorithm_version").notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("person_metrics_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    unique("person_metrics_workspace_metric_unique").on(
      table.workspaceId,
      table.graphSnapshotId,
      table.personId,
      table.metricKey,
      table.algorithmVersion,
    ),
    foreignKey({
      name: "person_metrics_workspace_snapshot_fk",
      columns: [table.workspaceId, table.graphSnapshotId],
      foreignColumns: [graphSnapshots.workspaceId, graphSnapshots.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "person_metrics_workspace_person_fk",
      columns: [table.workspaceId, table.personId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    check(
      "person_metrics_rank_check",
      sql`${table.rank} IS NULL OR ${table.rank} > 0`,
    ),
  ],
);
